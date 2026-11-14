import type { Child } from "hono/jsx";
import { EVM_CHAINS, isEvmChain, type EvmChain } from "../chains/evm/config";
import { getAsset } from "../core/assets";
import { formatDecimal, formatFiat } from "../core/money";
import type { AlertRow } from "../db/alerts";
import type { StuckSweep } from "../db/sweeps";
import type { InvoiceRow, InvoiceStatus, PaymentRow } from "../db/repo";
import type { ChecklistItem } from "./checklist";
import { PERIODS, STATUSES, type Dashboard, type DeliveryView, type EventView, type Period, type RecentRow } from "./stats";
import { Csrf } from "./layout";
import { CHAIN_LABEL } from "./settings";
import { BarChart, DataTable, EmptyState, Field, Flash, KeyValue, Panel, PasskeyConfirm, SegLinks, Stat, StatusPill, statusLabel, type Column } from "./ui";

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€" };

/** "1,234.50" with a currency symbol; bigint end to end. */
export function fmtMoney(minor: bigint, currency: string): string {
  const [whole, cents] = formatFiat(minor < 0n ? 0n : minor).split(".") as [string, string];
  return `${SYMBOL[currency] ?? ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}${SYMBOL[currency] ? "" : " " + currency}`;
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";

/** Tenths of a percent as "+12.4%". */
const fmtChange = (t: bigint): string => `${t < 0n ? "-" : "+"}${(t < 0n ? -t : t) / 10n}.${(t < 0n ? -t : t) % 10n}%`;

const symbolOf = (asset: string): string => {
  try {
    return getAsset(asset).symbol;
  } catch {
    return asset;
  }
};
/** "BTC", "USDC · Base", "BTC · Lightning": the symbol, plus the chain when the coin is not that chain's own. */
const coinLabel = (asset: string): string => {
  const [chain = ""] = asset.split(":");
  const sym = symbolOf(asset);
  return sym.toLowerCase() === chain || sym === asset ? sym : `${sym} · ${CHAIN_LABEL[chain] ?? chain}`;
};
const decimalsOf = (asset: string): number => {
  try {
    return getAsset(asset).decimals;
  } catch {
    return 8;
  }
};

/** An unpaid invoice past its deadline reads as expired even before the watcher flips the row. */
export const displayStatus = (inv: { status: InvoiceStatus; expires_at: number }, now: number): string =>
  inv.status === "open" && now > inv.expires_at ? "expired" : inv.status;


const PERIOD_LABEL: Record<Period, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days" };
const monthDay = (ms: number) => new Date(ms).toISOString().slice(5, 10);

/** A big amount: the whole part in Archivo, the cents muted. Screen readers get the amount as one string. */
function BigMoney(props: { minor: bigint; currency: string }) {
  const s = fmtMoney(props.minor, props.currency);
  const dot = s.indexOf(".");
  return (
    <p class="num num-xl">
      <span class="sr">{s}</span>
      <span aria-hidden="true">
        {s.slice(0, dot + 1)}
        <span class="cents">{s.slice(dot + 1)}</span>
      </span>
    </p>
  );
}

/**
 * Received in the period: the primary currency (the one with the most received) big, any other currency as a line
 * below it, the change against the previous period, and the primary currency per day as bars (by invoice creation day).
 */
function ReceivedPanel(props: { d: Dashboard }) {
  const { d } = props;
  const days = PERIOD_LABEL[d.period];
  const primary = d.received.find((r) => r.currency === d.currency)?.minor ?? 0n;
  const others = d.received.filter((r) => r.currency !== d.currency).sort((a, b) => a.currency.localeCompare(b.currency));
  const change = d.changeTenths;
  const first = d.daily[0]!.start;
  const last = d.daily[d.daily.length - 1]!.start;
  return (
    <Panel label={`Received, last ${days}`}>
      <div>
        <p class="stat-label">Received, last {days}</p>
        <BigMoney minor={primary} currency={d.currency} />
        {others.map((o) => (
          <p class="stat-hint">Also {fmtMoney(o.minor, o.currency)}</p>
        ))}
        {change === null ? null : (
          <p class={`stat-hint trend-${change >= 0n ? "up" : "down"}`}>
            {`${fmtChange(change)} vs previous ${days}${d.received.length > 1 ? ` (${d.currency})` : ""}`}
          </p>
        )}
      </div>
      <div>
        <BarChart
          label={`Received per day, last ${days} (${d.currency}, by invoice creation day)`}
          bars={d.daily.map((x) => ({ key: String(x.start), value: x.minor, title: `${monthDay(x.start)}: ${fmtMoney(x.minor, d.currency)}` }))}
        />
        <div class="axis muted tiny" aria-hidden="true">
          <span>{monthDay(first)}</span>
          <span>{monthDay(last)}</span>
        </div>
      </div>
    </Panel>
  );
}

/** Paid invoices, Waiting, Paid rate (paid / created in the period) and Top coin. */
function StatsPanel(props: { d: Dashboard }) {
  const { d } = props;
  const paid = d.paid.reduce((s, p) => s + p.count, 0);
  const avg = d.paid.map((p) => `Avg ${fmtMoney(p.sum / BigInt(p.count), p.currency)}`).join(" · ");
  return (
    <Panel label="Figures">
      <div class="stats">
        <Stat label="Paid invoices" value={String(paid)} hint={paid > 0 ? avg : undefined} />
        <Stat label="Waiting" value={String(d.awaiting)} hint={`${d.partial} partially paid`} />
        <Stat label="Paid rate" value={d.created > 0 ? `${Math.floor((paid * 100) / d.created)}%` : "—"} />
        <Stat label="Top coin" value={d.coins[0] ? symbolOf(d.coins[0].asset) : "—"} />
      </div>
    </Panel>
  );
}

/** Confirmed payments per coin in the primary currency, as shares. */
function CoinsPanel(props: { d: Dashboard }) {
  const total = props.d.coins.reduce((s, c) => s + c.minor, 0n);
  return (
    <Panel title="By coin" aside={<span class="muted tiny">{props.d.currency}, confirmed</span>}>
      {total === 0n ? (
        <p class="muted small">No confirmed payments in this period.</p>
      ) : (
        <ul class="coins">
          {props.d.coins.map((c) => {
            const tenths = (c.minor * 1000n) / total;
            const pct = `${tenths / 10n}.${tenths % 10n}%`;
            return (
              <li class="coin">
                <div class="coin-row">
                  <span>{coinLabel(c.asset)}</span>
                  <span class="muted">{pct}</span>
                </div>
                <svg class="coin-bar" viewBox="0 0 1000 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                  <rect class="coin-track" width={1000} height={6} rx={3} />
                  <rect class="coin-fill" width={Math.max(6, Number(tenths))} height={6} rx={3} />
                </svg>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

const ALERT_TITLE: Record<string, string> = {
  "sweep.insufficient_gas": "Hot wallet is out of gas",
  "sweep.payment_failed": "A deposit could not be swept",
  "sweep.failing": "Sweeps keep failing",
  "sweep.too_expensive": "Sweep skipped: gas too expensive",
  "sweep.stuck": "Deposits are stuck (chain not sweepable)",
  "sweep.tx_mismatch": "A node built a wrong transaction (refused, not signed)",
  "sweep.needs_admin": "A deposit needs an admin (automatic sweep retries stopped)",
  "routing.stuck": "A routing transaction is stuck (fee bumps exhausted)",
  "routing.failing": "A routing transaction was dropped",
  "webhook.dead": "Webhooks not delivered",
  "refund.approved": "A refund was approved",
};

/**
 * "N things need you": unresolved operator alerts (each with Resolve) and sweeps whose latest broadcast is over an hour
 * old or whose fee bumps ran out (each with Mark sweep failed, a passkey confirmation). Hidden when there are none.
 */
function NeedsYou(props: { alerts: AlertRow[]; sweeps: StuckSweep[]; csrf: string }) {
  const n = props.alerts.length + props.sweeps.length;
  if (n === 0) return null;
  return (
    <Panel tone="warn" title={n === 1 ? "1 thing needs you" : `${n} things need you`} aside={<span class="pill pill-confirming">Action</span>}>
      <ul class="needs">
        {props.alerts.map((a) => (
          <li class="need">
            <div class="need-text">
              <p class="need-title">
                {ALERT_TITLE[a.kind] ?? a.kind}
                {a.chain ? <span class="muted"> · {a.chain}</span> : null}
              </p>
              <p class="small">{a.detail}</p>
              <p class="muted tiny">{utc(a.created_at)}</p>
            </div>
            <form method="post" action={`/admin/alerts/${a.id}/resolve`}>
              <Csrf token={props.csrf} />
              <button type="submit" class="btn2 btn-sm">
                Resolve
              </button>
            </form>
          </li>
        ))}
        {props.sweeps.map((w) => (
          <li class="need">
            <div class="need-text">
              <p class="need-title">
                Sweep stuck pending<span class="muted"> · {w.chain}</span>
              </p>
              <p class="muted tiny">Last broadcast {utc(w.lastBroadcast)}</p>
              {w.txs.map((t) => (
                <p class="small mono">{t}</p>
              ))}
              <p class="small muted">Only mark failed if none of these transactions is pending or mined on a block explorer.</p>
            </div>
            <form method="post" action={`/admin/sweeps/${w.id}/fail`} class="form" data-passkey-confirm="sweep.fail">
              <Csrf token={props.csrf} />
              <PasskeyConfirm />
              <button type="submit" class="btn2 btn-sm">
                Mark sweep failed
              </button>
            </form>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * Deposits of assets other than the payment's own (never credited). Swept with the payment. If flushing one of those
 * tokens reverted (blacklisted address, paused token) the sweep moved only the payment's own token and the row says
 * "left at address": recover the rest one token at a time. "recovered" = a confirmed recovery on the payment's own
 * chain that flushed every token. Tron sweeps never move TRX: a Tron row with unexpected_left says so instead (the
 * Recover deposit form is EVM-only).
 */
function UnexpectedDeposits(props: { payments: PaymentRow[]; recovered?: Set<string> }) {
  if (props.payments.length === 0) return null;
  return (
    <Panel title="Unexpected deposits">
      <p class="small muted">Assets sent to a payment address that the payment did not ask for. They are never credited to the invoice; sweeps move them to the hot wallet with the payment. If a token blocks the flush (blacklisted address, paused token), the sweep moves only the payment's own funds and the row shows "left at address": on EVM chains, use Recover deposit on the invoice with a single token. Tron sweeps move USDT only, so TRX sent to a Tron deposit stays there.</p>
      <ul class="needs">
        {props.payments.map((p) => (
          <li data-alert-row class="need">
            <div class="need-text">
              <p>
                <a class="mono" href={`/admin/invoices/${p.invoice_id}`}>{p.invoice_id}</a>
                <span class="muted"> · {p.chain}</span>
              </p>
              <p class="small mono">
                {Object.entries(p.unexpected ?? {})
                  .map(([id, amount]) => `${formatDecimal(amount, decimalsOf(id))} ${symbolOf(id)}`)
                  .join(", ")}
              </p>
              <p class="muted small">
                {props.recovered?.has(p.id)
                  ? "recovered"
                  : p.unexpected_left && p.chain === "tron"
                    ? "TRX remains at the deposit (TRX recovery not supported yet)"
                    : p.unexpected_left
                      ? "left at address — recover with a single token"
                      : p.swept_at
                        ? `swept ${utc(p.swept_at)}`
                        : "not swept yet"}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** "Finish setting up": done items checked, open ones linking to where they get done. Hidden once all are done. */
function SetupPanel(props: { items: ChecklistItem[] }) {
  if (props.items.every((i) => i.done)) return null;
  const n = props.items.filter((i) => i.done).length;
  return (
    <Panel title="Finish setting up">
      <p class="muted tiny setup-count">
        {n} of {props.items.length} done
      </p>
      <ol class="checklist">
        {props.items.map((i) => (
          <li data-step={i.id} data-done={i.done ? "true" : "false"}>
            {i.done ? (
              <>
                <span class="ck ck-ok" aria-hidden="true">
                  ✓
                </span>
                <span>{i.label}</span>
              </>
            ) : (
              <>
                <span class="ck ck-todo" aria-hidden="true"></span>
                <a href={i.href}>{i.label}</a>
              </>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** The invoice table's columns (Overview's recent invoices and the invoices list). */
const invoiceColumns = (now: number): Column<RecentRow>[] => [
  { head: "Invoice", mono: true, cell: (r) => <a href={`/admin/invoices/${r.id}`}>{r.id}</a> },
  { head: "Order", cell: (r) => r.order_id ?? "—" },
  { head: "Amount", mono: true, nowrap: true, cell: (r) => fmtMoney(r.price_minor, r.currency) },
  { head: "Paid with", cell: (r) => (r.paid_with.length ? r.paid_with.map(coinLabel).join(", ") : "—") },
  { head: "Status", nowrap: true, cell: (r) => <StatusPill status={displayStatus(r, now)} /> },
  { head: "Created", nowrap: true, cell: (r) => <span title={utc(r.created_at)}>{ago(r.created_at, now)}</span> },
];

/** The primary action of the Overview and the invoices list ("+ Invoice" on phones, where the header is narrow). */
export function NewInvoiceButton() {
  return (
    <a href="/admin/invoices/new" class="btn" aria-label="New invoice">
      <span aria-hidden="true">+</span>
      <span class="side-only">New invoice</span>
      <span class="tab-only">Invoice</span>
    </a>
  );
}

/** The Overview header's actions: the period switch (links) and the primary action. */
export function DashboardActions(props: { period: Period }) {
  return (
    <>
      <SegLinks label="Period" items={PERIODS.map((p) => ({ href: `/admin?p=${p}`, label: PERIOD_LABEL[p], on: p === props.period }))} />
      <NewInvoiceButton />
    </>
  );
}

export function DashboardPage(props: {
  d: Dashboard;
  alerts?: AlertRow[];
  stuckSweeps?: StuckSweep[];
  unexpected?: PaymentRow[];
  recovered?: Set<string>;
  checklist?: ChecklistItem[];
  csrf?: string;
}) {
  const { d } = props;
  return (
    <>
      <div class="grid-main">
        <ReceivedPanel d={d} />
        <div class="stack">
          <StatsPanel d={d} />
          <NeedsYou alerts={props.alerts ?? []} sweeps={props.stuckSweeps ?? []} csrf={props.csrf ?? ""} />
        </div>
      </div>
      <UnexpectedDeposits payments={props.unexpected ?? []} recovered={props.recovered} />
      <div class="grid-main">
        <Panel title="Recent invoices" aside={<a href="/admin/invoices" class="small">View all</a>}>
          <DataTable
            label="Recent invoices"
            columns={invoiceColumns(d.now)}
            rows={d.recent}
            empty={
              <EmptyState title="No invoices yet" action={<a href="/admin/invoices/new" class="btn2 btn-sm">New invoice</a>}>
                Invoices you create here, by the API, a payment link or the point of sale show up here.
              </EmptyState>
            }
          />
        </Panel>
        <div class="stack">
          <SetupPanel items={props.checklist ?? []} />
          <CoinsPanel d={d} />
        </div>
      </div>
    </>
  );
}

/** /admin/invoices: the 50 latest invoices, filtered by status with a plain GET form. */
export function InvoicesPage(props: { rows: RecentRow[]; status?: InvoiceStatus; now: number }) {
  return (
    <Panel label="Invoices">
      <form method="get" action="/admin/invoices" class="filter" role="search" aria-label="Filter invoices">
        <label for="invoice-status" class="small muted">
          Status
        </label>
        <select id="invoice-status" name="status" class="input field-sm">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option value={s} selected={s === props.status}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <button type="submit" class="btn2 btn-sm">
          Filter
        </button>
      </form>
      <DataTable
        label="Invoices"
        columns={invoiceColumns(props.now)}
        rows={props.rows}
        empty={
          props.status ? (
            <EmptyState title={`No ${statusLabel(props.status).toLowerCase()} invoices`} action={<a href="/admin/invoices" class="btn2 btn-sm">Show all invoices</a>} />
          ) : (
            <EmptyState title="No invoices yet" action={<a href="/admin/invoices/new" class="btn2 btn-sm">New invoice</a>}>
              Invoices you create here, by the API, a payment link or the point of sale show up here.
            </EmptyState>
          )
        }
      />
      {props.rows.length === 50 ? <p class="muted tiny">Showing the latest 50.</p> : null}
    </Panel>
  );
}

/** The detail page's header actions: the customer-facing checkout and the way back. */
export function InvoiceDetailActions(props: { id: string }) {
  return (
    <>
      <a href="/admin/invoices" class="btn2">
        Back to invoices
      </a>
      <a href={`/i/${props.id}`} class="btn">
        Open checkout
      </a>
    </>
  );
}

function RecoveryNotice(props: { notice: { status: "sent" | "skipped" | "failed"; chain: string } }) {
  const { status, chain } = props.notice;
  if (status === "sent") return <Flash kind="ok">{`Recovery transaction sent on ${chain}. It shows as confirmed in the sweeps once finalized.`}</Flash>;
  return (
    <Flash kind="error">
      {status === "skipped"
        ? `Recovery not sent on ${chain}: another sweep is pending, the factory is not deployed, or the hot wallet lacks gas (see the alerts on the overview).`
        : `Recovery failed on ${chain}: the transaction could not be estimated or broadcast.`}
    </Flash>
  );
}

/** Everything a payment's last cell offers: txids, unexpected deposits, refund, sweep retry and wrong-chain recovery. */
function PaymentActions(props: { p: PaymentRow; csrf: string; recoverChains?: EvmChain[] }) {
  const { p } = props;
  return (
    <>
      {p.txids.length ? p.txids.map((t) => <div class="mono">{t}</div>) : "—"}
      {p.unexpected
        ? Object.entries(p.unexpected).map(([id, amount]) => (
            <div class="muted">
              Unexpected: {formatDecimal(amount, decimalsOf(id))} {symbolOf(id)}
            </div>
          ))
        : null}
      {p.swept_at ? <div class="muted">Swept {utc(p.swept_at)}</div> : null}
      {p.status === "confirmed" ? (
        <div>
          <a class="small" href={`/admin/payments/${p.id}/refund`}>
            Refund…
          </a>
        </div>
      ) : null}
      {p.sweep_error ? <div class="muted">Sweep error: {p.sweep_error}</div> : null}
      {(p.chain === "tron" || p.chain === "sol") && p.sweep_error && !p.swept_at ? (
        <form method="post" action={`/admin/payments/${p.id}/retry-sweep`} class="form" data-passkey-confirm="sweep.retry">
          <Csrf token={props.csrf} />
          <PasskeyConfirm />
          <button type="submit" class="btn2 btn-sm">
            Retry sweep
          </button>
        </form>
      ) : null}
      {isEvmChain(p.chain) && props.recoverChains && props.recoverChains.length > 0 ? (
        <details>
          <summary class="small muted">Recover deposit</summary>
          <form method="post" action={`/admin/payments/${p.id}/recover`} class="form">
            <Csrf token={props.csrf} />
            <p class="small muted">
              Funds sent to this address on another chain: sweep them to the hot wallet on the chain you pick. The payment is not marked swept.
            </p>
            <Field label="Chain" name="chain" id={`recover-${p.id}-chain`}>
              <select class="input" name="chain" required>
                <option value="" selected disabled>
                  Choose a chain
                </option>
                {props.recoverChains.map((ch) => (
                  <option value={ch}>
                    {ch} ({EVM_CHAINS[ch].nativeSymbol})
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Tokens"
              name="tokens"
              id={`recover-${p.id}-tokens`}
              hint={'"All listed tokens" flushes every token the chain lists. If one of them is blocked (a blacklisted address, a paused token) the whole flush reverts: pick one of the "Only" options to move a single token.'}
            >
              <select class="input" name="tokens">
                <option value="all" selected>
                  All listed tokens (plus the extra token)
                </option>
                <option value="own">Only this payment's own token</option>
                <option value="custom">Only the token address below</option>
              </select>
            </Field>
            <Field
              label="Token address (optional)"
              name="token"
              id={`recover-${p.id}-token`}
              mono
              placeholder="0x…"
              pattern="0x[0-9a-fA-F]{40}"
              autocomplete="off"
              hint={'Required for "Only the token address below". Add a token contract outside the chain\'s list (bridged USDC.e, say) here.'}
            />
            <button type="submit" class="btn2 btn-sm">
              Recover
            </button>
          </form>
        </details>
      ) : null}
    </>
  );
}

export function InvoiceDetailPage(props: {
  inv: InvoiceRow;
  payments: PaymentRow[];
  events: EventView[];
  deliveries: DeliveryView[];
  csrf: string;
  now: number;
  /** Configured EVM chains, for the wrong-chain recovery form. */
  recoverChains?: EvmChain[];
  /** Outcome of the last recovery attempt (from the redirect). */
  notice?: { status: "sent" | "skipped" | "failed"; chain: string };
}) {
  const { inv, now } = props;
  const dl = (id: string) => props.deliveries.filter((x) => x.event_id === id);
  const flags = [inv.late ? "late payment" : "", inv.overpaid ? "overpaid" : ""].filter(Boolean).join(", ");
  return (
    <>
      <Panel label="Invoice">
        <div class="detail-head">
          <p class="mono detail-id">{inv.id}</p>
          <StatusPill status={displayStatus(inv, now)} />
        </div>
        <KeyValue
          rows={[
            ["Amount", fmtMoney(inv.price_minor, inv.currency)],
            ["Paid", fmtMoney(inv.paid_minor, inv.currency)],
            ["Order", inv.order_id ?? "—"],
            ["Created", utc(inv.created_at)],
            ["Expires", utc(inv.expires_at)],
            ["Flags", flags || "—"],
            ["Metadata", inv.metadata ? <span class="mono">{JSON.stringify(inv.metadata)}</span> : "—"],
          ]}
        />
      </Panel>

      {props.notice ? <RecoveryNotice notice={props.notice} /> : null}

      <Panel title="Payments">
        <DataTable
          label="Payments"
          columns={[
            { head: "Asset", nowrap: true, cell: (p: PaymentRow) => symbolOf(p.asset) },
            { head: "Address", cell: (p) => p.address, mono: true },
            { head: "Expected", cell: (p) => formatDecimal(p.expected, decimalsOf(p.asset)), mono: true, nowrap: true },
            { head: "Received", cell: (p) => formatDecimal(p.received, decimalsOf(p.asset)), mono: true, nowrap: true },
            { head: "Final", cell: (p) => formatDecimal(p.final, decimalsOf(p.asset)), mono: true, nowrap: true },
            { head: "Status", nowrap: true, cell: (p) => <StatusPill status={p.status} /> },
            { head: "Transactions", cell: (p) => <PaymentActions p={p} csrf={props.csrf} recoverChains={props.recoverChains} /> },
          ]}
          rows={props.payments}
          empty={<EmptyState title="No payments started" />}
        />
      </Panel>

      <Panel title="Events and deliveries">
        <DataTable
          label="Events and deliveries"
          columns={[
            { head: "Event", nowrap: true, cell: (ev: EventView) => ev.type },
            { head: "Time", cell: (ev) => <span class="muted">{utc(ev.created_at)}</span> },
            {
              head: "Deliveries",
              cell: (ev) =>
                dl(ev.id).length === 0 ? (
                  <span class="muted">none</span>
                ) : (
                  dl(ev.id).map((x) => (
                    <div class="small">
                      #{x.attempt} · {x.status ?? "no response"} · {utc(x.at)}
                      {x.error ? <span class="muted"> · {x.error}</span> : null}
                    </div>
                  ))
                ),
            },
            {
              head: "Resend",
              cell: (ev) => (
                <form method="post" action={`/admin/events/${encodeURIComponent(ev.id)}/resend`}>
                  <Csrf token={props.csrf} />
                  <button type="submit" class="btn2 btn-sm">
                    Resend
                  </button>
                </form>
              ),
            },
          ]}
          rows={props.events}
          empty={<EmptyState title="No events" />}
        />
      </Panel>
    </>
  );
}

/** The form field a createInvoice message names, with the words the page uses for it. */
const ERROR_FIELDS: [prefix: string, field: string, label: string][] = [
  ["price_amount", "amount", "Amount"],
  ["price_currency", "currency", "Currency"],
  ["order_id", "order_id", "Order id"],
  ["expires_in_sec", "expiry_minutes", "Expiry"],
];
/** Rewords a createInvoice error for the form and finds the field it is about (if any). */
export function invoiceFormError(message: string): { text: string; field?: string } {
  if (message.startsWith("expires_in_sec")) return { text: "Expiry must be a whole number of minutes from 5 to 1440. Fix it and try again.", field: "expiry_minutes" };
  for (const [prefix, field, label] of ERROR_FIELDS) {
    if (message.startsWith(prefix)) return { text: `${label}${message.slice(prefix.length)}. Fix it and try again.`, field };
  }
  return { text: message };
}

export function NewInvoicePage(props: { csrf: string; error?: string; errorField?: string; values?: Record<string, string> }) {
  const v = props.values ?? {};
  const err = (field: string) => (props.errorField === field ? props.error : undefined);
  return (
    <>
      {props.error ? <Flash kind="error">{props.error}</Flash> : null}
      <Panel label="New invoice">
        <form method="post" action="/admin/invoices/new" class="form">
          <Csrf token={props.csrf} />
          <Field label="Amount" name="amount" mono inputmode="decimal" placeholder="50.00" required value={v.amount ?? ""} error={err("amount")} />
          <Field label="Currency" name="currency" error={err("currency")}>
            <select class="input" name="currency">
              {["USD", "EUR"].map((c) => (
                <option value={c} selected={c === (v.currency ?? "USD")}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Order id (optional)" name="order_id" maxlength={128} value={v.order_id ?? ""} error={err("order_id")} />
          <Field label="Expires after (minutes, 5 to 1440)" name="expiry_minutes" inputmode="numeric" value={v.expiry_minutes ?? "60"} error={err("expiry_minutes")} />
          <button type="submit" class="btn">
            Create invoice
          </button>
        </form>
      </Panel>
    </>
  );
}

export interface ChainStatus {
  chain: string;
  factoryDeployed: boolean;
  hotAddress: string;
  hotBalance: bigint;
  symbol: string;
  /** Seconds the finalized block trails the head; -1 when the RPC could not be read. */
  finalizedLagSec: number;
  /** Set (ms) when the latest refresh failed and the values are from this earlier successful read. */
  staleSince?: number | null;
  /** Why the latest refresh failed: no RPC URL on the chain's id, or the RPC could not be read. */
  error?: "chain_id_mismatch" | "rpc_unavailable" | null;
}

/** The factory cell: a known state, or why it is unknown. */
const factoryCell = (c: ChainStatus): string =>
  c.error === "chain_id_mismatch"
    ? "chain id mismatch"
    : c.finalizedLagSec < 0
      ? "unknown (RPC unavailable)"
      : c.factoryDeployed
        ? "Deployed"
        : "Not deployed";

const fmtLag = (s: number): string => (s < 0 ? "unknown" : s < 120 ? `${s} s` : `${Math.round(s / 60)} min`);

/** A Tron or Solana hot wallet, shown so operators can fund it (configured chains only; no balance read). */
export interface RoutedHotWallet {
  chain: "tron" | "sol";
  address: string;
}
const ROUTED_HOT: Record<RoutedHotWallet["chain"], { name: string; path: string; fund: string }> = {
  tron: {
    name: "Tron",
    path: "m/44'/195'/1'/0/0",
    fund: "TRX. Each deposit top-up reserves 2 TRX (about 1.6 TRX is spent: 0.5 TRX sent, plus activating the deposit). Energy is rented from TronSave: keep a prepaid TronSave balance and set TRONSAVE_API_KEY.",
  },
  sol: {
    name: "Solana",
    path: "m/44'/501'/2147483646'/0'",
    fund: "SOL: every sweep fee, a 1,000,000 lamport reserve, and 2,039,280 lamports once for its USDC account on the first USDC sweep. To withdraw, use a wallet that accepts a custom derivation path.",
  },
};

function RoutedHotWallets(props: { wallets: RoutedHotWallet[] }) {
  return (
    <Panel title="Tron and Solana hot wallets">
      <p class="muted small">Sweeps move deposits here. Both addresses derive from MASTER_SEED; fund them before the first sweep.</p>
      <DataTable
        label="Tron and Solana hot wallets"
        rows={props.wallets}
        empty={<EmptyState title="No Tron or Solana wallet">Neither Tron nor Solana is configured (set ALLOW_SEED_CUSTODY and TRONGRID_API_KEY or SOLANA_RPC_URL).</EmptyState>}
        columns={[
          { head: "Chain", nowrap: true, cell: (w) => ROUTED_HOT[w.chain].name },
          { head: "Hot wallet", cell: (w) => w.address, mono: true },
          { head: "Derivation path", cell: (w) => ROUTED_HOT[w.chain].path, mono: true },
          { head: "Fund with", cell: (w) => <span class="small">{ROUTED_HOT[w.chain].fund}</span> },
        ]}
      />
    </Panel>
  );
}

/** A watch-only wallet: the account xpub and start index saved in Settings, or null when none is connected. */
export interface WatchWallet {
  name: string;
  xpub: string | null;
  startIndex: string;
}

/** The first 10 and last 8 characters of a long key; the full key stays in the title. */
const shortKey = (k: string): string => (k.length > 22 ? `${k.slice(0, 10)}…${k.slice(-8)}` : k);

function WatchOnlyWallets(props: { wallets: WatchWallet[] }) {
  return (
    <Panel title="Watch-only wallets">
      <p class="muted small">The gateway only watches these wallets' addresses; it never holds their keys.</p>
      <KeyValue
        rows={props.wallets.map((w): [string, Child] => [
          w.name,
          w.xpub ? (
            <>
              <span class="mono" title={w.xpub}>
                {shortKey(w.xpub)}
              </span>
              <span class="muted small"> · Start index {w.startIndex || "0"}</span>
            </>
          ) : (
            <>
              <span class="muted">Not connected</span> · <a href="/admin/settings">Connect in Settings</a>
            </>
          ),
        ])}
      />
    </Panel>
  );
}

const factoryStatus = (c: ChainStatus): string => (c.error === "chain_id_mismatch" || c.finalizedLagSec < 0 ? "partial" : c.factoryDeployed ? "paid" : "awaiting");

export function WalletsPage(props: { chains: ChainStatus[]; hotWallets?: RoutedHotWallet[]; watch?: WatchWallet[]; disabled?: { chain: string; reason: string }[] }) {
  return (
    <>
      <p class="muted">Where payments land and the hot wallets that sweep them.</p>
      {(props.disabled ?? []).map((d) => (
        <Flash kind="error">
          {d.chain} is turned off: {d.reason}. Set it and redeploy.
        </Flash>
      ))}
      <WatchOnlyWallets wallets={props.watch ?? []} />
      <Panel title="EVM chains">
        <p class="muted small">
          A chain's assets are offered to customers only once its forwarder factory is deployed. Deploy it with <span class="mono">npm run deploy:factory</span> and keep the hot wallet funded with native gas.
        </p>
        <DataTable
          label="EVM chains"
          rows={props.chains}
          empty={<EmptyState title="No EVM chain">No EVM chain is configured (set ALLOW_SEED_CUSTODY and an EVM_RPC_ variable).</EmptyState>}
          columns={[
            { head: "Chain", nowrap: true, cell: (c) => c.chain },
            { head: "Factory", nowrap: true, cell: (c) => <StatusPill status={factoryStatus(c)} label={factoryCell(c)} /> },
            { head: "Hot wallet", cell: (c) => c.hotAddress, mono: true },
            {
              head: "Balance",
              mono: true,
              cell: (c) => (
                <>
                  {c.finalizedLagSec < 0 ? "unknown" : `${formatDecimal(c.hotBalance, 18)} ${c.symbol}`}
                  {c.staleSince ? <span class="muted small"> stale since {utc(c.staleSince)}</span> : null}
                </>
              ),
            },
            { head: "Finality lag", nowrap: true, cell: (c) => <span class="muted">{fmtLag(c.finalizedLagSec)}</span> },
          ]}
        />
      </Panel>
      <RoutedHotWallets wallets={props.hotWallets ?? []} />
    </>
  );
}
