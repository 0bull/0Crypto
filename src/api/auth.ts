import { base64urlnopad } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createMiddleware } from "hono/factory";
import { clientIpKey } from "../core/ip";
import type { Env } from "../env";
import { apiError } from "./errors";

export const API_KEY_PREFIX = "0c_live_";

export async function sha256Hex(s: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

/** Creates a key and returns the plaintext, which is shown once; only its SHA-256 hex is stored. */
export async function createApiKey(db: D1Database, label: string): Promise<string> {
  const key = API_KEY_PREFIX + base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare("INSERT INTO api_keys(hash,label,created_at) VALUES(?,?,?)")
    .bind(await sha256Hex(key), label, Date.now())
    .run();
  return key;
}

/**
 * Bearer auth: looks the key up by hash (never compares secrets), rejects unknown or revoked keys, then rate-limits per key.
 * Only failed lookups spend the per-IP `auth:` budget, so a busy merchant server is never throttled by it.
 */
export const requireApiKey = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const m = new RegExp(`^Bearer (${API_KEY_PREFIX}[A-Za-z0-9_-]{20,128})$`).exec(c.req.header("Authorization") ?? "");
  if (!m) return apiError(c, "unauthorized", "missing or malformed API key");
  const hash = await sha256Hex(m[1]!);
  const row = await c.env.DB.prepare("SELECT hash FROM api_keys WHERE hash=? AND revoked_at IS NULL").bind(hash).first();
  if (!row) {
    // Throttle guessing per IP. The IP is only a rate-limit key; never stored or logged.
    const ip = clientIpKey(c); // an IPv6 /64 is one client
    if (!(await c.env.API_RATE.limit({ key: "auth:" + ip })).success) return apiError(c, "rate_limited", "too many requests");
    return apiError(c, "unauthorized", "invalid API key");
  }
  const { success } = await c.env.API_RATE.limit({ key: "key:" + hash.slice(0, 16) });
  if (!success) return apiError(c, "rate_limited", "too many requests");
  await next();
});
