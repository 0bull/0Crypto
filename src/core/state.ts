import type { EventRow, InvoiceRow, InvoiceStatus, PaymentRow, PaymentStatus, Transition } from "../db/repo";
import { getAsset } from "./assets";
import { fiatMinorFromAtomic } from "./money";
import type { Observation } from "./types";

const DAY_MS = 86_400_000;
const TOLERANCE_BP = 50n;

type Unexpected = PaymentRow["unexpected"];
const sameUnexpected = (a: Unexpected, b: Unexpected): boolean => {
  const x = Object.entries(a ?? {});
  return x.length === Object.keys(b ?? {}).length && x.every(([k, v]) => (b ?? {})[k] === v);
};

const nonEmpty = (u: NonNullable<Unexpected>): Unexpected => (Object.keys(u).length > 0 ? u : null);
const maxPerAsset = (a: Unexpected, b: NonNullable<Unexpected>): NonNullable<Unexpected> => {
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) if (!(k in out) || v > out[k]!) out[k] = v;
  return out;
};

/** `x` is at least 99.5% of `expected`, in integer basis points. */
const meets = (x: bigint, expected: bigint): boolean => x * 10_000n >= expected * (10_000n - TOLERANCE_BP);

const sorted = (a: string[]): string[] => [...a].sort();
const sameList = (a: string[], b: string[]): boolean => {
  const x = sorted(a);
  const y = sorted(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** What a payment's credit is built from (PaymentRow, migration 0028). */
interface CreditState {
  locked: bigint;
  laterAtomic: bigint;
  laterMinor: bigint;
  byExpiry: bigint;
}

/**
 * The stored credit state, or for a row written before migration 0028 the same values derived from how it was credited
 * then: a payment credited at its locked price had all of its funds under the lock; one credited at another price had
 * none. Funds seen before expiry follow detected_at.
 */
function creditState(p: PaymentRow, expiresAt: number): CreditState {
  const seen = p.received > p.final ? p.received : p.final;
  const lockedLegacy =
    p.credit_price_e8 === null
      ? p.detected_at !== null && p.detected_at <= p.rate_locked_until
        ? seen
        : 0n
      : p.credit_price_e8 === p.price_e8
        ? seen
        : 0n;
  const laterLegacy = p.credit_price_e8 !== null && p.credit_price_e8 !== p.price_e8;
  return {
    locked: p.locked_received ?? lockedLegacy,
    laterAtomic: p.later_atomic ?? (laterLegacy ? p.final : 0n),
    laterMinor: p.later_minor ?? (laterLegacy ? p.credited_minor : 0n),
    byExpiry: p.expiry_received ?? (p.detected_at !== null && p.detected_at <= expiresAt ? seen : 0n),
  };
}

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

export interface StepInput {
  invoice: InvoiceRow;
  payment: PaymentRow;
  others: PaymentRow[];
  obs: Observation;
  now: number;
  currentPriceE8: () => Promise<bigint>;
}

/**
 * Pure payment + invoice state machine. Returns null when neither row changes and no event is due.
 * The rate lock covers only the funds seen while it ran: they are credited at the locked price, and any final amount
 * beyond them is credited at the price current when it is first credited. Funds that vanish (RBF, double spend) take
 * their lock with them. The late flag is set when the payment completing the invoice includes funds first seen after
 * expiry. The only I/O is `currentPriceE8`, called at most once per step, when final funds outside the lock first appear.
 */
export async function step(input: StepInput): Promise<Transition | null> {
  const { invoice, payment, others, now } = input;
  const decimals = getAsset(payment.asset).decimals;

  // A confirmed payment, or one under a sweep lock or already swept (whatever its status: a swept partial payment reads 0 at its emptied address), never loses amounts: a lower observation (lagging explorer, empty list, shallow reorg) is
  // ignored, so credit and paid_minor only grow. Other states follow the observation (a real double-spend or RBF).
  const obs: Observation =
    payment.status === "confirmed" || payment.swept_at != null || payment.sweep_tx != null
      ? {
          received: input.obs.received > payment.received ? input.obs.received : payment.received,
          final: input.obs.final > payment.final ? input.obs.final : payment.final,
          txids: [...new Set([...payment.txids, ...input.obs.txids])],
        }
      : input.obs;

  // Unexpected deposits (other assets at an EVM address) are never credited. They follow the observation when it
  // reports them, except once the payment is confirmed, locked or swept: then each asset keeps its highest reading, so
  // the record of what arrived survives the sweep that empties the address.
  const keep = payment.status === "confirmed" || payment.swept_at != null || payment.sweep_tx != null;
  const unexpected: Unexpected =
    input.obs.unexpected === undefined
      ? payment.unexpected
      : nonEmpty(keep ? maxPerAsset(payment.unexpected, input.obs.unexpected) : input.obs.unexpected);

  // First sighting: set once, the first time any funds are seen. Lightning reports when the invoice settled, so that
  // (clamped to [payment created, now]) is the sighting, not the poll that read it; every other chain uses the poll time.
  const seenAt =
    payment.chain === "ln" && input.obs.settledAt !== undefined ? Math.min(Math.max(input.obs.settledAt, payment.created_at), now) : now;
  const detectedAt = payment.detected_at ?? (obs.received > 0n ? seenAt : null);

  // Credit. While the lock runs it covers whatever is seen; after it, it can only shrink (funds that vanished). The same
  // for funds seen before expiry, which decide the late flag.
  const prev = creditState(payment, invoice.expires_at);
  const locked = seenAt <= payment.rate_locked_until ? obs.received : minBig(prev.locked, obs.received);
  const byExpiry = seenAt <= invoice.expires_at ? obs.received : minBig(prev.byExpiry, obs.received);
  const lockedFinal = minBig(obs.final, locked);
  const laterAtomic = obs.final - lockedFinal;
  let laterMinor = prev.laterMinor;
  let laterPrice: bigint | null = null;
  if (laterAtomic > prev.laterAtomic) {
    laterPrice = await input.currentPriceE8();
    laterMinor += fiatMinorFromAtomic(laterAtomic - prev.laterAtomic, decimals, laterPrice);
  } else if (laterAtomic < prev.laterAtomic) {
    laterMinor = prev.laterAtomic === 0n ? 0n : (prev.laterMinor * laterAtomic) / prev.laterAtomic;
  }
  const credited = fiatMinorFromAtomic(lockedFinal, decimals, payment.price_e8) + laterMinor;
  // The price of the first credit (shown for funds still confirming); fixed once set.
  const creditPrice = payment.credit_price_e8 ?? (obs.final > 0n ? (lockedFinal > 0n ? payment.price_e8 : laterPrice) : null);

  // Payment status.
  let status: PaymentStatus;
  if (payment.status === "confirmed" || meets(obs.final, payment.expected)) status = "confirmed";
  else if (meets(obs.received, payment.expected)) status = "confirming";
  else if (obs.final > 0n && now > payment.rate_locked_until) status = "partial";
  else if (obs.received > 0n) status = "detected";
  else if (now > invoice.expires_at + DAY_MS) status = "expired";
  else status = "awaiting";

  const newPayment: PaymentRow = {
    ...payment,
    received: obs.received,
    final: obs.final,
    txids: sameList(obs.txids, payment.txids) ? payment.txids : sorted(obs.txids),
    status,
    detected_at: detectedAt,
    confirmed_at: payment.confirmed_at ?? (status === "confirmed" ? now : null),
    credited_minor: credited,
    credit_price_e8: creditPrice,
    unexpected,
    locked_received: locked,
    later_atomic: laterAtomic,
    later_minor: laterMinor,
    expiry_received: byExpiry,
  };

  // Invoice.
  const paidMinor = credited + others.reduce((sum, p) => sum + p.credited_minor, 0n);
  const anyReceived = obs.received > 0n || others.some((p) => p.received > 0n);
  const wasPaid = invoice.status === "paid";
  let invStatus: InvoiceStatus;
  if (wasPaid || paidMinor * 10_000n >= invoice.price_minor * (10_000n - TOLERANCE_BP)) invStatus = "paid";
  else if (paidMinor > 0n) invStatus = "partially_paid";
  else if (now > invoice.expires_at && !anyReceived) invStatus = "expired";
  else invStatus = "open";

  const newInvoice: InvoiceRow = {
    ...invoice,
    status: invStatus,
    paid_minor: paidMinor,
    // Late: the payment completing the invoice includes funds first seen after expiry.
    late: invoice.late || (!wasPaid && invStatus === "paid" && obs.final > byExpiry),
    overpaid: paidMinor * 100n > invoice.price_minor * 101n,
  };

  // Events: payment events first, then invoice events.
  const events: EventRow[] = [];
  const emit = (type: string, id: string, status: string, paymentId?: string) => {
    events.push({
      id,
      created_at: now,
      type,
      invoice_id: invoice.id,
      payload: JSON.stringify({
        invoice_id: invoice.id,
        ...(paymentId ? { payment_id: paymentId } : {}),
        status,
        paid_minor: paidMinor.toString(),
      }),
    });
  };
  if (payment.received === 0n && obs.received > 0n) {
    emit("payment.detected", `payment.detected:${payment.id}:1`, status, payment.id);
  }
  if (payment.status !== "confirmed" && status === "confirmed") {
    emit("payment.confirmed", `payment.confirmed:${payment.id}:1`, status, payment.id);
  }
  if (invStatus === "partially_paid" && paidMinor !== invoice.paid_minor) {
    emit("invoice.partially_paid", `invoice.partially_paid:${invoice.id}:${paidMinor}`, invStatus);
  }
  if (!wasPaid && invStatus === "paid") {
    emit("invoice.paid", `invoice.paid:${invoice.id}:1`, invStatus);
    if (newInvoice.late) emit("invoice.late_payment", `invoice.late_payment:${invoice.id}:1`, invStatus);
  }
  if (invoice.status !== "expired" && invStatus === "expired") {
    emit("invoice.expired", `invoice.expired:${invoice.id}:1`, invStatus);
  }

  const paymentChanged =
    newPayment.received !== payment.received ||
    newPayment.final !== payment.final ||
    !sameList(newPayment.txids, payment.txids) ||
    newPayment.status !== payment.status ||
    newPayment.detected_at !== payment.detected_at ||
    newPayment.confirmed_at !== payment.confirmed_at ||
    newPayment.credited_minor !== payment.credited_minor ||
    newPayment.credit_price_e8 !== payment.credit_price_e8 ||
    locked !== prev.locked ||
    laterAtomic !== prev.laterAtomic ||
    laterMinor !== prev.laterMinor ||
    byExpiry !== prev.byExpiry ||
    !sameUnexpected(newPayment.unexpected, payment.unexpected);
  const invoiceChanged =
    newInvoice.status !== invoice.status ||
    newInvoice.paid_minor !== invoice.paid_minor ||
    newInvoice.late !== invoice.late ||
    newInvoice.overpaid !== invoice.overpaid;

  if (!paymentChanged && !invoiceChanged && events.length === 0) return null;
  return { payment: newPayment, invoice: newInvoice, events };
}
