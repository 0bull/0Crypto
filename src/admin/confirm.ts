import type { Context, Hono } from "hono";
import type { Env } from "../env";
import type { AdminEnv } from "./layout";
import { bindingHash, ChallengeLimit, challengeCheck, newChallenge } from "./challenges";
import { publicRp } from "./rp";
import { authenticationOptions, credentialIdOf, verifyAuthentication, type StoredPasskey } from "./webauthn";

/*
 * Passkey confirmation for money and security actions. A form marked `data-passkey-confirm="<action>"` (handled by
 * public/admin-passkey.js) first posts its action and parameters to POST /admin/webauthn/challenge, which issues a
 * single-use "action" challenge whose payload hash binds (session cookie value, action, canonical parameters). The
 * browser signs that challenge with a passkey and submits the form with the assertion. The route re-derives the
 * parameters from the POST it actually received (actionParams, plus `_path` = the request's own path) and
 * verifyActionAssertion spends the challenge only if every part of the binding matches. So an assertion approved for
 * one amount, address, path, action or session never passes for another, and it passes at most once.
 *
 * The parameters are all string form fields except csrf, assertion and credential (duplicates: the last one wins, as
 * in Hono's parseBody and in the client), plus `_path`. A form that uses confirmation must carry everything it binds
 * in plain inputs: no data in a submit button's name/value, no duplicate names, no file inputs, no `name[]` fields.
 */

export type ConfirmAction =
  | "refund"
  | "refund.reapprove"
  | "routing"
  | "pos.pin"
  | "pos.disable"
  | "sweep.retry"
  | "sweep.fail"
  | "key.create"
  | "key.revoke"
  | "webhook.rotate"
  | "settings.wallets"
  | "passkey.add"
  | "passkey.remove";

export const CONFIRM_ACTIONS: ReadonlySet<ConfirmAction> = new Set<ConfirmAction>([
  "refund",
  "refund.reapprove",
  "routing",
  "pos.pin",
  "pos.disable",
  "sweep.retry",
  "sweep.fail",
  "key.create",
  "key.revoke",
  "webhook.rotate",
  "settings.wallets",
  "passkey.add",
  "passkey.remove",
]);

export const NEEDS_JS = "This action needs JavaScript for passkey confirmation.";
export const BAD_ASSERTION = "Passkey confirmation failed or expired. Try again.";


const NOT_BOUND = new Set(["csrf", "assertion", "credential"]);
const MAX_PARAMS = 50;
const MAX_VALUE = 2048;
/** An assertion is a few hundred bytes; anything far larger is not parsed. */
const MAX_ASSERTION = 64 * 1024;

/** The string fields of a parsed form, minus csrf, assertion and credential (what the client binds as params). */
export function actionParams(form: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(form).filter((e): e is [string, string] => typeof e[1] === "string" && !NOT_BOUND.has(e[0])));
}

/** The canonical text of the parameters with `_path` set (sorted keys), the last part of the binding. */
function canonical(params: Record<string, string>, path: string): string {
  return JSON.stringify(Object.entries({ ...params, _path: path }).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const binding = (session: string, action: ConfirmAction, params: Record<string, string>, path: string): Promise<string> =>
  bindingHash(session, action, canonical(params, path));

/**
 * True iff `assertionJson` is a passkey assertion over a live "action" challenge issued to this session for exactly
 * this action and these params, with `_path` the path of this request (any `_path` in params is overwritten). The
 * challenge is spent by the check, so a second submission fails. On success the passkey's counter and last_used_at
 * are stored. Any failure (empty or malformed assertion, unknown passkey, no session, PUBLIC_URL unset, a request on
 * another origin than PUBLIC_URL) is false.
 */
export async function verifyActionAssertion(
  env: Env,
  c: Context,
  assertionJson: string,
  action: ConfirmAction,
  params: Record<string, string>,
): Promise<boolean> {
  try {
    if (!assertionJson || assertionJson.length > MAX_ASSERTION || !CONFIRM_ACTIONS.has(action)) return false;
    const session: unknown = c.get("session");
    if (typeof session !== "string" || session === "") return false;
    const check = publicRp(env, c.req.url, "/admin");
    if (!check.ok) return false;
    const { rpId, origin } = check.rp;
    const response: unknown = JSON.parse(assertionJson);
    const id = credentialIdOf(response);
    if (id === null) return false;
    const row = await env.DB.prepare("SELECT id,public_key,counter,transports FROM passkeys WHERE id=?").bind(id).first<StoredPasskey>();
    if (!row) return false;
    const passkey: StoredPasskey = { ...row, public_key: Array.isArray(row.public_key) ? Uint8Array.from(row.public_key as number[]) : row.public_key };
    // The request's own path, exactly as the client's `new URL(form.action).pathname` spells it (not percent-decoded).
    const now = Date.now();
    const hash = await binding(session, action, params, new URL(c.req.url).pathname);
    const out = await verifyAuthentication({ response, check: challengeCheck(env.DB, "action", hash, now), origin, rpId, passkey });
    if (!out) return false;
    await env.DB.prepare("UPDATE passkeys SET counter=max(counter,?1), last_used_at=?2 WHERE id=?3").bind(out.newCounter, now, id).run();
    return true;
  } catch {
    return false;
  }
}

/**
 * The confirmation check for a route: null when the form carries a valid assertion for `action` and its own fields,
 * else the message to re-render with (NEEDS_JS when there is no assertion at all, BAD_ASSERTION otherwise; both 403).
 */
export async function confirmProblem(c: Context<AdminEnv>, form: Record<string, unknown>, action: ConfirmAction): Promise<string | null> {
  const assertion = typeof form.assertion === "string" ? form.assertion : "";
  if (assertion === "") return NEEDS_JS;
  return (await verifyActionAssertion(c.env, c, assertion, action, actionParams(form))) ? null : BAD_ASSERTION;
}

/** params: a JSON object of at most 50 string values of at most 2048 chars each, with a string `_path`. */
function parseParams(raw: unknown): Record<string, string> | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > MAX_PARAMS) return null;
  if (!entries.every(([, x]) => typeof x === "string" && x.length <= MAX_VALUE)) return null;
  const params = Object.fromEntries(entries) as Record<string, string>;
  return typeof params._path === "string" && params._path.startsWith("/") ? params : null;
}

/** POST /admin/webauthn/challenge (session and CSRF are enforced by the admin middleware). */
export function registerConfirm(app: Hono<AdminEnv>): void {
  app.post("/webauthn/challenge", async (c) => {
    const session = c.get("session");
    if (session === null) return c.json({ error: "Sign in first." }, 401);
    const form = await c.req.parseBody();
    const action = typeof form.action === "string" ? form.action : "";
    if (!CONFIRM_ACTIONS.has(action as ConfirmAction)) return c.json({ error: "Unknown action." }, 400);
    const params = parseParams(form.params);
    if (params === null) return c.json({ error: "The action's parameters are not valid." }, 400);
    // Only on PUBLIC_URL's own origin: an assertion made anywhere else could never verify.
    const check = publicRp(c.env, c.req.url, "/admin");
    if (!check.ok) return c.json({ error: check.error }, 403);
    const { rpId } = check.rp;
    const hash = await binding(session, action as ConfirmAction, params, params._path!);
    let challenge: string;
    try {
      challenge = await newChallenge(c.env.DB, "action", hash, Date.now());
    } catch (e) {
      if (e instanceof ChallengeLimit) return c.json({ error: "Too many pending passkey requests. Try again in a few minutes." }, 429);
      throw e;
    }
    // Only the passkeys that can sign for this RP ID (not those of an old domain).
    const { results } = await c.env.DB.prepare("SELECT id,transports FROM passkeys WHERE rp_id=? ORDER BY created_at, id")
      .bind(rpId)
      .all<{ id: string; transports: string | null }>();
    const allow = results.map((r) => {
      const t = transportsOf(r.transports);
      return t === undefined ? { id: r.id } : { id: r.id, transports: t };
    });
    return c.json({ options: await authenticationOptions({ rpId, challenge, allow }) });
  });
}

function transportsOf(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  } catch {
    return undefined;
  }
}
