import type { Context, Hono } from "hono";
import { getAsset } from "../core/assets";
import { formatDecimal } from "../core/money";
import { getPayment, type PaymentRow } from "../db/repo";
import type { Env } from "../env";
import {
  cancelRefund,
  checkRefundInput,
  createRefund,
  listRefunds,
  NOT_REAPPROVABLE,
  reapproveRefund,
  REFUND_WARNING,
  refundable,
  refundBlockOf,
  RefundRefused,
  refundState,
  sendRefund,
  refundWindowTaken,
  withRefundLease,
  type RefundRow,
} from "../routing/refund";
import { enqueueNonInvoiceEvents } from "../webhooks/outbox";
import { confirmProblem } from "./confirm";
import { adminPage, Csrf, PasskeyConfirm, type AdminEnv } from "./layout";
import { DataTable, EmptyState, Field, Flash, Panel } from "./ui";

/*
 * /admin/payments/:id/refund: the guarded refund form (src/routing/refund.ts does the work). POST needs CSRF (admin
 * middleware), a passkey confirmation bound to the address, amount and path (src/admin/confirm.ts; 403 otherwise) and the hourly slot: at most one minted refund per REFUND_WINDOW_MS
 * (the refunds table alone: a read-only pre-check before the confirmation, then the INSERT / UPDATE itself; 429 otherwise; a refund refused before its mint does not count).
 * Every approval and re-approval records a refund.approved alert and webhook event before anything is sent (no alert,
 * no send); the event is enqueued right after the send. Creating and sending, re-approving and cancelling each
 * run under the router lease (409 while routing runs). A refund that was not sent can be re-approved or cancelled
 * (passkey confirmation, bound to its own path and action); a UTXO refund whose recorded tx provably never landed can be cancelled too.
 */

type Ctx = Context<AdminEnv>;
const formStr = (form: Record<string, unknown>, k: string): string => (typeof form[k] === "string" ? (form[k] as string) : "");
const utc = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");

const UTXO = new Set(["btc", "ltc", "doge"]);
const STATE_TEXT: Record<ReturnType<typeof refundState>, string> = {
  sent: "sent",
  broadcast_failed: "tx recorded, broadcast failed: check the explorer",
  consumed_unsent: "consumed, unsent: re-approve",
  approved_unsent: "approved, not sent",
  cancelled: "cancelled",
};

function RefundPage(props: { p: PaymentRow; refunds: RefundRow[]; max: bigint | null; block: string | null; csrf: string; notice?: string; error?: string; values?: { address: string; amount: string } }) {
  const { p } = props;
  const a = getAsset(p.asset);
  const fmt = (v: string | bigint) => `${formatDecimal(BigInt(v), a.decimals)} ${a.symbol}`;
  return (
    <>
      <p class="small muted">
        Payment <span class="mono">{p.id}</span> ({p.asset}) of invoice <a href={`/admin/invoices/${p.invoice_id}`}>{p.invoice_id}</a>: credited {fmt(p.final)}, refundable {props.max === null ? "unknown (the explorer could not be read)" : fmt(props.max)}.
      </p>
      <Panel tone="warn" label="Warning">
        <p role="note">
          <strong>{REFUND_WARNING}</strong>
        </p>
      </Panel>
      {props.notice ? <Flash kind="ok">{props.notice}</Flash> : null}
      {props.error ? <Flash kind="error">{props.error}</Flash> : null}
      {props.block ? (
        <Panel label="Refund unavailable">
          <p class="muted">{props.block}</p>
        </Panel>
      ) : (
        <Panel title="Refund this payment">
          <form method="post" action={`/admin/payments/${p.id}/refund`} class="form" data-passkey-confirm="refund">
            <Csrf token={props.csrf} />
            <Field label={`Customer's ${p.chain} address`} name="address" mono required autocomplete="off" value={props.values?.address ?? ""} />
            <Field label={`Amount (${a.symbol})`} name="amount" mono required inputmode="decimal" autocomplete="off" value={props.values?.amount ?? ""} />
            <p class="small muted">At most one refund per hour. The refund is sent at once.</p>
            <PasskeyConfirm />
            <button type="submit" class="btn cta">
              Approve and send refund
            </button>
          </form>
        </Panel>
      )}
      <Panel title="Refunds of this payment">
        <DataTable
          label="Refunds of this payment"
          rows={props.refunds}
          empty={<EmptyState title="No refunds yet" />}
          columns={[
            { head: "Created", cell: (r) => utc(r.created_at) },
            { head: "Address", mono: true, cell: (r) => r.to_address },
            { head: "Amount", mono: true, nowrap: true, cell: (r) => fmt(r.amount) },
            {
              head: "State",
              cell: (r) => (
                <>
                  <div>{STATE_TEXT[refundState(r)]}</div>
                  {r.error ? <div class="muted small">{r.error}</div> : null}
                </>
              ),
            },
            { head: "Tx", mono: true, cell: (r) => r.tx ?? "—" },
            {
              head: "Action",
              cell: (r) => {
                const st = refundState(r);
                return (
                  <>
                    {st === "consumed_unsent" || st === "approved_unsent" || (st === "broadcast_failed" && UTXO.has(p.chain)) ? (
                      <form method="post" action={`/admin/refunds/${r.id}/cancel`} class="form" data-passkey-confirm="refund">
                        <Csrf token={props.csrf} />
                        <p class="small muted">
                          {st === "broadcast_failed" ? "Cancel only if the tx never landed: checked against the explorer (unknown tx, inputs unspent)." : "Nothing was broadcast. Cancelling frees the amount."}
                        </p>
                        <PasskeyConfirm />
                        <button type="submit" class="btn2 btn-sm">
                          Cancel refund
                        </button>
                      </form>
                    ) : null}
                    {st === "consumed_unsent" || st === "approved_unsent" ? (
                      <form method="post" action={`/admin/refunds/${r.id}/reapprove`} class="form" data-passkey-confirm="refund.reapprove">
                        <Csrf token={props.csrf} />
                        <p class="small muted">Nothing was broadcast for this refund. Re-approving sends it again.</p>
                        <PasskeyConfirm />
                        <button type="submit" class="btn2 btn-sm">
                          Re-approve and send
                        </button>
                      </form>
                    ) : null}
                  </>
                );
              },
            },
          ]}
        />
      </Panel>
    </>
  );
}

const NOTICE: Record<string, string> = {
  sent: "The refund was sent.",
  broadcast_failed: "The refund tx was recorded but the node did not take it: check the explorer before doing anything else.",
  unsent: "The refund was approved but not sent (see its state below).",
  cancelled: "The refund was cancelled.",
};

async function render(c: Ctx, p: PaymentRow, status: 200 | 400 | 403 | 404 | 409 | 429 = 200, error?: string, values?: { address: string; amount: string }) {
  // UTXO: the bound is what the deposit holds (an explorer read); unknown if the explorer cannot be read now.
  const [refunds, max, block] = await Promise.all([listRefunds(c.env.DB, p.id), refundable(c.env, p).catch(() => null), refundBlockOf(c.env, p, Date.now())]);
  const sent = c.req.query("sent");
  return adminPage(
    c,
    { title: "Refund payment", active: "privacy" },
    <RefundPage
        p={p}
        refunds={refunds}
        max={max}
        block={block}
        csrf={c.get("csrf")}
        notice={sent && Object.hasOwn(NOTICE, sent) ? NOTICE[sent] : undefined}
        error={error}
      values={values}
    />,
    status,
  );
}

const notFound = (c: Ctx) => adminPage(c, { title: "Not found", active: "privacy" }, <p class="muted">There is no such payment or refund.</p>, 404);

const ONE_PER_HOUR_TEXT = "Only one refund per hour: try again later.";

/** Enqueues the refund.approved event the action recorded; a failure leaves it for the cron's requeue (never fails the request). */
const flushEvents = (env: Env, now: number) =>
  enqueueNonInvoiceEvents(env, now).catch((e) => console.warn(`0crypto: enqueueing refund events failed: ${e instanceof Error ? e.name : "Error"}`));

/** Registers the refund pages on the admin app (after its session and CSRF middleware). */
export function registerRefunds(app: Hono<AdminEnv>): void {
  app.get("/payments/:id/refund", async (c) => {
    const p = await getPayment(c.env.DB, c.req.param("id"));
    return p ? render(c, p) : notFound(c);
  });

  app.post("/payments/:id/refund", async (c) => {
    const p = await getPayment(c.env.DB, c.req.param("id"));
    if (!p) return notFound(c);
    const form = await c.req.parseBody();
    const values = { address: formStr(form, "address"), amount: formStr(form, "amount") };
    // The hourly gate (read only: createRefund's INSERT re-checks it atomically) and the format checks come first (no
    // side effects), so a typo or a second refund within the hour does not spend a passkey confirmation.
    if (await refundWindowTaken(c.env, Date.now())) return render(c, p, 429, ONE_PER_HOUR_TEXT, values);
    try {
      await checkRefundInput(c.env, p, values.address, values.amount);
    } catch (e) {
      if (e instanceof RefundRefused) return render(c, p, e.code, e.message, values);
      throw e;
    }
    const problem = await confirmProblem(c, form, "refund");
    if (problem) return render(c, p, 403, problem, values);
    const now = Date.now();
    let status: string;
    try {
      status = await withRefundLease(c.env, now, async (holder) => {
        const id = (await createRefund(c.env, p.id, values.address, values.amount, now)).id;
        return (await sendRefund(c.env, id, now, holder)).status;
      }, p.chain);
    } catch (e) {
      // A refusal after the approval (a lost lease at the mint, say) still has its alert's event to deliver.
      if (e instanceof RefundRefused) return (await flushEvents(c.env, now), render(c, p, e.code, e.message, values));
      throw e;
    }
    await flushEvents(c.env, now);
    return c.redirect(`/admin/payments/${p.id}/refund?sent=${status}`, 303);
  });

  app.post("/refunds/:id/reapprove", async (c) => {
    const row = await c.env.DB.prepare("SELECT payment_id, tx, cancelled_at FROM refunds WHERE id=?")
      .bind(c.req.param("id"))
      .first<{ payment_id: string; tx: string | null; cancelled_at: number | null }>();
    const p = row ? await getPayment(c.env.DB, row.payment_id) : null;
    if (!row || !p) return notFound(c);
    const form = await c.req.parseBody();
    // Read-only pre-checks (reapproveRefund re-checks both): a sent or cancelled refund (409, checked first), then the
    // hourly gate (429). A re-approval refused either way does not spend a passkey confirmation.
    if (row.tx || row.cancelled_at) return render(c, p, 409, NOT_REAPPROVABLE);
    if (await refundWindowTaken(c.env, Date.now(), c.req.param("id"))) return render(c, p, 429, ONE_PER_HOUR_TEXT);
    const problem = await confirmProblem(c, form, "refund.reapprove");
    if (problem) return render(c, p, 403, problem);
    const now = Date.now();
    let status: string;
    try {
      status = await withRefundLease(c.env, now, async (holder) => {
        if (!(await reapproveRefund(c.env, c.req.param("id"), now))) throw new RefundRefused(NOT_REAPPROVABLE, 409);
        return (await sendRefund(c.env, c.req.param("id"), now, holder)).status;
      }, p.chain);
    } catch (e) {
      if (e instanceof RefundRefused) return (await flushEvents(c.env, now), render(c, p, e.code, e.message));
      throw e;
    }
    await flushEvents(c.env, now);
    return c.redirect(`/admin/payments/${p.id}/refund?sent=${status}`, 303);
  });

  app.post("/refunds/:id/cancel", async (c) => {
    const row = await c.env.DB.prepare("SELECT payment_id FROM refunds WHERE id=?").bind(c.req.param("id")).first<{ payment_id: string }>();
    const p = row ? await getPayment(c.env.DB, row.payment_id) : null;
    if (!row || !p) return notFound(c);
    const problem = await confirmProblem(c, await c.req.parseBody(), "refund");
    if (problem) return render(c, p, 403, problem);
    try {
      const r = await withRefundLease(c.env, Date.now(), () => cancelRefund(c.env, c.req.param("id"), Date.now()));
      if (!r.ok) return render(c, p, r.code, r.reason);
    } catch (e) {
      if (e instanceof RefundRefused) return render(c, p, e.code, e.message);
      throw e;
    }
    return c.redirect(`/admin/payments/${p.id}/refund?sent=cancelled`, 303);
  });
}
