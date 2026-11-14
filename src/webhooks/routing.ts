/*
 * Webhook bodies for events that are not about an invoice: routing.completed, routing.failed, routing.stuck (the
 * events row's invoice_id holds the route batch id), sweep.insufficient_gas and refund.approved (it holds the alert
 * id). Routing data is built from a whitelist of the stored payload: batch id, asset, total, chunk count, status,
 * Trocador trade ids and providers, txids (ours), payout tx ids. Nothing about a customer (no invoice, payment, order
 * or customer address) and no address at all: the only addresses a routing payload may carry are the gateway's own and
 * the frozen destination, and neither is sent (nor free-text reasons, which may name them: the dashboard shows those).
 * refund.approved is the exception, by design: it tells the merchant a refund left (or is about to leave) for this
 * customer, so it names the refund, its payment and invoice, the asset, the atomic amount and the customer's address.
 */

export const NON_INVOICE_EVENTS: ReadonlySet<string> = new Set(["routing.completed", "routing.failed", "routing.stuck", "sweep.insufficient_gas", "refund.approved"]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => s !== null) : []);
const STATUS: Record<string, string> = { "routing.completed": "completed", "routing.failed": "failed", "routing.stuck": "stuck" };

/** The `data` object of a non-invoice event; `chunkCount` from the batch row when the payload lacks it. */
export function nonInvoiceEventData(type: string, subjectId: string, payloadJson: string, chunkCount: number | null): Record<string, unknown> {
  let p: unknown;
  try {
    p = JSON.parse(payloadJson);
  } catch {
    p = {};
  }
  const pl = isObj(p) ? p : {};
  if (type === "sweep.insufficient_gas") return { object: "alert", id: subjectId, kind: type, chain: str(pl.chain) };
  if (type === "refund.approved")
    return {
      object: "refund",
      id: str(pl.refund_id),
      payment_id: str(pl.payment_id),
      invoice_id: str(pl.invoice_id),
      asset: str(pl.asset),
      amount: str(pl.amount),
      to_address: str(pl.to_address),
      alert_id: subjectId,
    };
  const legs = (Array.isArray(pl.legs) ? pl.legs : []).filter(isObj).map((l) => ({
    chunk: typeof l.chunk === "number" ? l.chunk : null,
    amount: str(l.amount),
    step: str(l.step),
    trade_id: str(l.tradeId),
    provider: str(l.provider),
    trade_status: str(l.status),
    txid: str(l.tx),
    payout_txid: str(l.hashout),
  }));
  const txids = [...new Set([...legs.flatMap((l) => (l.txid ? [l.txid] : [])), ...strs(pl.txs)])];
  return {
    object: "route_batch",
    id: subjectId,
    asset: str(pl.asset),
    total: str(pl.total),
    chunk_count: typeof pl.chunks === "number" ? pl.chunks : chunkCount,
    status: STATUS[type] ?? null,
    ...(typeof pl.chunk === "number" ? { stuck_chunk: pl.chunk } : {}),
    trade_ids: [...new Set(legs.flatMap((l) => (l.trade_id ? [l.trade_id] : [])))],
    txids,
    ...(pl.shields ? { shield_txids: strs(pl.shields) } : {}),
    legs,
  };
}
