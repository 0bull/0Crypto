import { getAsset } from "../core/assets";
import { formatDecimal, formatFiat } from "../core/money";
import type { InvoiceRow, PaymentRow } from "../db/repo";

/** Stored times are unix ms. */
const iso = (ms: number): string => new Date(ms).toISOString();

/** Public API shape of an invoice. Never exposes derivation_index, price_e8 or credit_price_e8. */
export function serializeInvoice(inv: InvoiceRow, payments: PaymentRow[], publicUrl: string) {
  return {
    id: inv.id,
    status: inv.status,
    price_amount: formatFiat(inv.price_minor),
    price_currency: inv.currency,
    paid_amount: formatFiat(inv.paid_minor),
    order_id: inv.order_id,
    metadata: inv.metadata,
    late: inv.late,
    overpaid: inv.overpaid,
    created_at: iso(inv.created_at),
    expires_at: iso(inv.expires_at),
    checkout_url: `${publicUrl}/i/${inv.id}`,
    payments: payments.map((p) => {
      const { decimals } = getAsset(p.asset);
      return {
        id: p.id,
        asset: p.asset,
        address: p.address,
        amount: formatDecimal(p.expected, decimals),
        received: formatDecimal(p.received, decimals),
        confirmed: formatDecimal(p.final, decimals),
        status: p.status,
        txids: p.txids,
        rate_locked_until: iso(p.rate_locked_until),
      };
    }),
  };
}
