import type { Context } from "hono";

export type ApiErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "not_found"
  | "invoice_closed"
  | "payment_in_progress"
  | "asset_not_allowed"
  | "price_unavailable"
  | "lightning_unavailable"
  | "rate_limited"
  | "internal_error";

const STATUS = {
  unauthorized: 401,
  invalid_request: 400,
  not_found: 404,
  invoice_closed: 409,
  payment_in_progress: 409,
  asset_not_allowed: 400,
  price_unavailable: 503,
  lightning_unavailable: 503,
  rate_limited: 429,
  internal_error: 500,
} as const;

/** Uniform error body: { error: "<snake_code>", message }. */
export function apiError(c: Context, code: ApiErrorCode, message: string): Response {
  return c.json({ error: code, message }, STATUS[code]);
}
