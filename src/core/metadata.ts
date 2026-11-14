/**
 * Invoice metadata keys the gateway itself sets: `pos` (a POS charge, read by the POS recent list), `link_id` (a payment
 * link) and `subscription_id` (a subscription period, read by its webhook). Merchant metadata from the invoice and
 * subscription APIs may not use them, so nothing outside those built-in sources can make an invoice look like one of theirs.
 */
export const RESERVED_METADATA_KEYS = ["pos", "link_id", "subscription_id"] as const;

/** A 400 message when `metadata` uses a reserved key, else null. */
export function reservedMetadataError(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const k = RESERVED_METADATA_KEYS.find((r) => Object.hasOwn(metadata, r));
  return k ? `metadata key "${k}" is reserved for the gateway (reserved: ${RESERVED_METADATA_KEYS.join(", ")})` : null;
}
