import type { Context, Hono } from "hono";
import { enabledAssets } from "../config";
import { getAsset } from "../core/assets";
import { formatDecimal } from "../core/money";
import type { Env } from "../env";
import { parseChunks, parseLegs, type BatchRow, type SwapLeg } from "../routing/legs";
import { markResolved, releasable, releaseLeg, resumeBatch, stuckReason, wornChunk, type ActionResult } from "../routing/operator";
import { parseProgress, routeProblem } from "../routing/router";
import { confirmProblem } from "./confirm";
import { adminPage, Csrf, PasskeyConfirm, type AdminEnv } from "./layout";
import { DataTable, EmptyState, Flash, Panel, StatusPill, statusLabel } from "./ui";

/*
 * /admin/privacy (privacy routing): route batches with their legs (trade ids, support, status, txids, stuck flag, frozen destination
 * masked, due time) and the operator actions of src/routing/operator.ts. Each action is a POST (CSRF, checked by the
 * admin middleware) that needs a passkey confirmation bound to its path (src/admin/confirm.ts, action "routing"),
 * because each one changes money state.
 */

type Ctx = Context<AdminEnv>;
type Row = BatchRow & { progress: string; stuck_at: number | null; resolved_at: number | null };
type ActionRow = { id: string; created_at: number; action: string; batch_id: string | null; leg: number | null; refund_id: string | null; detail: string };

/** First and last 6 characters of a destination, for display. */
export const maskDestination = (d: string): string => (d.length <= 14 ? d : `${d.slice(0, 6)}…${d.slice(-6)}`);
const utc = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const amountOf = (asset: string, v: string) => {
  try {
    const a = getAsset(asset);
    return `${formatDecimal(BigInt(v), a.decimals)} ${a.symbol}`;
  } catch {
    return v;
  }
};
const safeLink = (s: string | undefined) => (s && /^https:\/\/[^\s"'<>]+$/.test(s) ? s : null);

function ActionForm(props: { action: string; label: string; csrf: string; note: string }) {
  return (
    <form method="post" action={props.action} class="form" data-passkey-confirm="routing">
      <Csrf token={props.csrf} />
      <p class="small muted">{props.note}</p>
      <PasskeyConfirm />
      <button type="submit" class="btn2 btn-sm">
        {props.label}
      </button>
    </form>
  );
}

/** The pill status for a batch: finished is green, failed red, running or stuck amber, anything else grey. */
const batchPill = (status: string, stuck: boolean): string => (stuck ? "confirming" : status === "completed" || status === "resolved" ? "paid" : status === "failed" ? "partial" : status === "executing" ? "confirming" : "expired");

function legCells(b: Row, csrf: string, now: number) {
  return [
    { head: "Chunk", nowrap: true, cell: ({ leg }: { leg: SwapLeg; idx: number }) => leg.chunk },
    { head: "Amount", mono: true, nowrap: true, cell: ({ leg }: { leg: SwapLeg; idx: number }) => amountOf(b.asset, leg.amount) },
    {
      head: "Step",
      nowrap: true,
      cell: ({ leg }: { leg: SwapLeg; idx: number }) => (
        <>
          <div>{leg.step}</div>
          {leg.stuckAt ? <div class="error small">stuck</div> : null}
          {leg.resumed ? <div class="muted small">resumed</div> : null}
        </>
      ),
    },
    {
      head: "Trade",
      mono: true,
      cell: ({ leg }: { leg: SwapLeg; idx: number }) => {
        const support = safeLink(leg.support);
        return (
          <>
            <div>{leg.tradeId ?? "—"}</div>
            {leg.provider ? <div class="muted">{leg.provider}</div> : null}
            {leg.providerTradeId ? <div class="muted">provider id {leg.providerTradeId}</div> : null}
            {support ? (
              <a href={support} rel="noreferrer noopener" target="_blank">
                Support
              </a>
            ) : leg.support ? (
              <div class="muted">{leg.support}</div>
            ) : null}
          </>
        );
      },
    },
    { head: "Status", nowrap: true, cell: ({ leg }: { leg: SwapLeg; idx: number }) => leg.status ?? "—" },
    {
      head: "Tx",
      mono: true,
      cell: ({ leg }: { leg: SwapLeg; idx: number }) => (
        <>
          {leg.tx ? <div>{leg.tx}</div> : leg.releasedTx ? <div class="muted">released {leg.releasedTx}</div> : <div>—</div>}
          {leg.hashout ? <div class="muted">payout {leg.hashout}</div> : null}
          {leg.reason ? <div class="muted">{leg.reason}</div> : null}
        </>
      ),
    },
    {
      head: "Action",
      cell: ({ leg, idx }: { leg: SwapLeg; idx: number }) =>
        releasable(b.asset, leg, now) ? (
          <ActionForm
            action={`/admin/privacy/${b.id}/legs/${idx}/release`}
            label="Release stuck UTXO leg"
            csrf={csrf}
            note="Only when the trade has expired, the explorer does not know the tx and every input is still unspent: the inputs are routed again."
          />
        ) : null,
    },
  ];
}

function BatchCard(props: { b: Row; now: number; csrf: string }) {
  const { b, now } = props;
  let legs: SwapLeg[] = [];
  let chunks: bigint[] = [];
  let shieldTxs: string[] = [];
  let corrupt = false;
  try {
    legs = parseLegs(b.legs);
    chunks = parseChunks(b.chunks);
    shieldTxs = parseProgress(b.progress).flatMap((p) => p?.txs ?? []);
  } catch {
    corrupt = true;
  }
  const stuck = corrupt ? null : stuckReason(b, now);
  const worn = corrupt ? undefined : wornChunk(legs);
  return (
    <Panel id={b.id} title={b.id} tone={stuck ? "warn" : undefined} aside={<StatusPill status={batchPill(b.status, !!stuck)} label={statusLabel(b.status)} />}>
      <p class="small muted">
        {b.asset}
        {stuck ? <span class="error"> · stuck: {stuck}</span> : null} · total {amountOf(b.asset, b.total)} in {chunks.length || "—"} chunk(s) · due {utc(b.due_at)} · destination{" "}
        <span class="mono">{maskDestination(b.destination)}</span> · created {utc(b.created_at)}
        {b.resolved_at ? ` · resolved ${utc(b.resolved_at)}` : ""}
      </p>
      {b.error ? <p class="small muted">Error: {b.error}</p> : null}
      {corrupt ? <Flash kind="error">This batch's stored state does not parse.</Flash> : null}
      {shieldTxs.length ? (
        <div class="small">
          <p class="muted">Shield txs</p>
          {shieldTxs.map((t) => (
            <div class="mono">{t}</div>
          ))}
        </div>
      ) : null}
      <DataTable label={`Legs of batch ${b.id}`} rows={legs.map((leg, idx) => ({ leg, idx }))} columns={legCells(b, props.csrf, now)} empty={null} />
      {b.status === "failed" || stuck ? (
        <ActionForm action={`/admin/privacy/${b.id}/resolve`} label="Mark resolved" csrf={props.csrf} note="Marks the batch resolved. Nothing is done on chain: check the chain and the provider first." />
      ) : null}
      {b.status === "executing" && worn !== undefined ? (
        <ActionForm
          action={`/admin/privacy/${b.id}/resume`}
          label="Resume batch"
          csrf={props.csrf}
          note={`Chunk ${worn} stopped after repeated abandons. Resuming clears that count; unsent legs are planned again.`}
        />
      ) : null}
    </Panel>
  );
}

function RoutingPage(props: { env: Env; batches: Row[]; actions: ActionRow[]; now: number; csrf: string; notice?: string; error?: string }) {
  const assets = enabledAssets(props.env).map((a) => ({ id: a.id, problem: routeProblem(props.env, a) }));
  return (
    <>
      <p class="muted">Moves received funds through private hops before they reach you.</p>
      {props.notice ? <Flash kind="ok">{props.notice}</Flash> : null}
      {props.error ? <Flash kind="error">{props.error}</Flash> : null}
      <Panel title="Assets">
        <DataTable
          label="Assets"
          rows={assets}
          empty={<EmptyState title="No assets enabled" />}
          columns={[
            { head: "Asset", mono: true, nowrap: true, cell: (r) => r.id },
            {
              head: "State",
              cell: (r) =>
                r.problem ? (
                  <>
                    <StatusPill status="expired" label="Not routed" />
                    <div class="muted small">{r.problem}</div>
                  </>
                ) : (
                  <StatusPill status="paid" label="Routed" />
                ),
            },
          ]}
        />
      </Panel>
      {props.batches.length === 0 ? (
        <Panel label="Route batches">
          <EmptyState title="No route batches yet" />
        </Panel>
      ) : (
        props.batches.map((b) => <BatchCard b={b} now={props.now} csrf={props.csrf} />)
      )}
      <Panel title="Operator actions">
        <DataTable
          label="Operator actions"
          rows={props.actions}
          empty={<EmptyState title="No operator actions yet" />}
          columns={[
            { head: "When", cell: (a) => utc(a.created_at) },
            { head: "Action", nowrap: true, cell: (a) => a.action },
            { head: "Subject", mono: true, cell: (a) => a.batch_id ?? a.refund_id ?? "—" },
            { head: "Detail", cell: (a) => <span class="small">{a.detail}</span> },
          ]}
        />
      </Panel>
    </>
  );
}

const DONE: Record<string, string> = { resolve: "The batch was marked resolved.", release: "The leg was released; its inputs are routed again.", resume: "The batch was resumed." };

async function render(c: Ctx, status: 200 | 403 | 404 | 409 = 200, error?: string) {
  const now = Date.now();
  const [{ results: batches }, { results: actions }] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM route_batches ORDER BY created_at DESC, id LIMIT 50").all<Row>(),
    c.env.DB.prepare("SELECT * FROM routing_actions ORDER BY created_at DESC, id LIMIT 50").all<ActionRow>(),
  ]);
  const done = c.req.query("done");
  return adminPage(
    c,
    { title: "Privacy routing", active: "privacy" },
    <RoutingPage env={c.env} batches={batches} actions={actions} now={now} csrf={c.get("csrf")} notice={done && Object.hasOwn(DONE, done) ? DONE[done] : undefined} error={error} />,
    status,
  );
}

async function act(c: Ctx, name: string, f: (now: number) => Promise<ActionResult>) {
  const problem = await confirmProblem(c, await c.req.parseBody(), "routing");
  if (problem) return render(c, 403, problem);
  const r = await f(Date.now());
  if (!r.ok) return render(c, r.code, r.reason);
  return c.redirect(`/admin/privacy?done=${name}`, 303);
}

/**
 * Registers /admin/privacy and its actions on the admin app (after its session and CSRF middleware). The old
 * /admin/routing page answers 301 with its query kept; its POST paths are gone (passkey confirmations bind the path).
 */
export function registerRouting(app: Hono<AdminEnv>): void {
  app.get("/routing", (c) => {
    const q = new URL(c.req.url).search;
    return c.redirect(`/admin/privacy${q}`, 301);
  });
  app.get("/privacy", (c) => render(c));
  app.post("/privacy/:id/resolve", (c) => act(c, "resolve", (now) => markResolved(c.env, c.req.param("id"), now)));
  app.post("/privacy/:id/resume", (c) => act(c, "resume", (now) => resumeBatch(c.env, c.req.param("id"), now)));
  app.post("/privacy/:id/legs/:idx/release", (c) => {
    const idx = Number(c.req.param("idx"));
    return act(c, "release", (now) => (/^\d{1,4}$/.test(c.req.param("idx")) ? releaseLeg(c.env, c.req.param("id"), idx, now) : Promise.resolve({ ok: false, code: 404, reason: "no such leg" })));
  });
}
