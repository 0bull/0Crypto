import { recordAlert } from "../db/alerts";
import type { PaymentRow } from "../db/repo";
import type { Env } from "../env";
import type { RefundRow } from "./refund";

/**
 * Records the refund.approved alert (every one, no dedupe) and its webhook event for refund `r` of payment `p`. Called
 * when a refund is approved or re-approved, before anything is sent: it throws on a D1 error, so if the alert cannot
 * be recorded nothing leaves (fail closed). The amount is in the asset's atomic units.
 */
export async function recordRefundApproved(env: Env, r: RefundRow, p: PaymentRow, now: number): Promise<void> {
  const detail = `Refund approved: ${r.amount} ${p.asset} (atomic units) from payment ${p.id} to ${r.to_address}. If this was not you, sign out every session on Passkeys and cancel it on the refund page.`;
  await recordAlert(env.DB, "refund.approved", p.chain, detail, now, {
    dedupe: false,
    payload: { refund_id: r.id, payment_id: p.id, invoice_id: p.invoice_id, asset: p.asset, amount: r.amount, to_address: r.to_address },
  });
}
