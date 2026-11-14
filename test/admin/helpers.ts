import { env, exports } from "cloudflare:workers";
import { insertInvoice, type InvoiceRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { signedIn, type AdminTestSession } from "../admin-session";

/*
 * Shared helpers for admin page tests (Workers pool). Plan 7's session signer lives in test/admin-session.ts; it is
 * re-exported here so admin tests have one import. The caller applies the D1 migrations first (in its beforeAll).
 */

export { preAuth, signedIn, type AdminTestSession } from "../admin-session";

export const BASE = "https://pay.test";
const e = env as unknown as Env;

let shared: Promise<AdminTestSession> | undefined;
/**
 * One signed-in admin per test file (a passkey row plus a session cookie under the current `session_gen`). Its
 * `headers` are the cookie header and `csrf` the form token bound to it. Call it after the migrations ran.
 */
export const adminSession = (): Promise<AdminTestSession> => (shared ??= signedIn(e));

let ipSeq = 0;
const freshIp = () => `10.9.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

/** GET an admin path as the shared session (or with exactly `headers`, e.g. `{}` for signed out). No redirects followed. */
export async function adminGet(path: string, headers?: Record<string, string>): Promise<Response> {
  const h = headers ?? (await adminSession()).headers;
  return exports.default.fetch(BASE + path, { headers: { "cf-connecting-ip": freshIp(), ...h }, redirect: "manual" });
}

/**
 * POST a urlencoded form to an admin path. Without `headers` it goes as the shared session and carries its CSRF token
 * (unless the form has its own `csrf`). No redirects followed.
 */
export async function adminPost(path: string, form: Record<string, string>, headers?: Record<string, string>): Promise<Response> {
  const s = headers ? undefined : await adminSession();
  const body = new URLSearchParams(s ? { csrf: s.csrf, ...form } : form);
  return exports.default.fetch(BASE + path, {
    method: "POST",
    headers: { "cf-connecting-ip": freshIp(), "content-type": "application/x-www-form-urlencoded", ...(headers ?? s!.headers) },
    body,
    redirect: "manual",
  });
}

let seq = 0;
/** Inserts an open $50.00 invoice (override any field) and returns it. */
export async function seedInvoice(over: Partial<InvoiceRow> = {}): Promise<InvoiceRow> {
  const now = Date.now();
  const inv: InvoiceRow = {
    id: `inv_ui${now}${seq++}`, created_at: now, expires_at: now + 3_600_000, price_minor: 5000n, currency: "USD", order_id: null, metadata: null,
    success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n, ...over,
  };
  await insertInvoice(e.DB, inv);
  return inv;
}

const NOT_BOUND = new Set(["csrf", "assertion", "credential"]);
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/**
 * The field set a `data-passkey-confirm` form binds, from rendered HTML: the sorted names of its named inputs,
 * selects and textareas, minus csrf, assertion and credential (what public/admin-passkey.js posts as params, beside
 * `_path`). A named submit button shows up as `button:<name>` (it would bind data the server never sees in params).
 * Throws when no confirm form posts to `action`, so a renamed path fails loudly. Restyling must leave this unchanged.
 */
export function confirmFields(html: string, action: string): string[] {
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
  const form = forms.find((f) => {
    const open = /^<form\b[^>]*>/.exec(f)![0];
    return attr(open, "action") === action && /\sdata-passkey-confirm="/.test(open);
  });
  if (!form) throw new Error(`no data-passkey-confirm form posts to ${action}`);
  const names: string[] = [];
  for (const m of form.matchAll(/<(input|select|textarea|button)\b[^>]*>/g)) {
    const name = attr(m[0], "name");
    if (name === undefined) continue;
    if (m[1] === "button") names.push(`button:${name}`);
    else if (!NOT_BOUND.has(name)) names.push(name);
  }
  return names.sort();
}
