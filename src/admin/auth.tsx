import { hexToBytes } from "@noble/hashes/utils.js";
import type { Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { clientIpKey } from "../core/ip";
import { clearSettingsCache, publicOrigin } from "../settings";
import { page } from "../web/layout";
import { bindingHash, ChallengeLimit, challengeCheck, newChallenge, type ChallengeKind } from "./challenges";
import { AuthShell, Csrf } from "./layout";
import { Field, Flash, Panel } from "./ui";
import { publicRp, requestRp, type RelyingParty, type RpRefusal } from "./rp";
import type { AdminEnv } from "./layout";
import { SESSION_COOKIE, SESSION_MAX_AGE, SETUP_COOKIE, cookieAttrs, cookieName, secureCookie, sessionGen, signSession } from "./session";
import { BAD_CODE, BAD_RECOVERY, checkCode, ensureCode, newRecoveryValue, printCode, USED_FOREVER, type CodePurpose } from "./setup-codes";
import { authenticationOptions, credentialIdOf, registrationOptions, verifyAuthentication, verifyRegistration, type StoredPasskey } from "./webauthn";

/*
 * Claim, sign-in and recovery with passkeys.
 *
 * Where each ceremony may run is decided by rp.ts: sessions and passkeys only exist for the PUBLIC_URL origin.
 *
 * Claim (/admin/setup, only while no passkey exists): the owner types the 6-word code the Worker printed to its logs
 * (reading the logs proves they own the Cloudflare account) and creates a passkey bound to the origin the request came
 * in on (only PUBLIC_URL's while a Wrangler var pins it). One D1 batch stores the passkey only while none exists and the code is still live, then (guarded on that very row)
 * spends the setup codes, stores the origin as PUBLIC_URL and stamps admin_state.created_at. D1 runs a batch as one
 * transaction, so of two racing claims exactly one inserts; the other changes nothing and gets 409. ADMIN_SETUP_CODE
 * (hash "env") deletes no code, so it is one-shot only through "no passkey exists yet".
 *
 * Sign-in (/admin/login): a discoverable-credential WebAuthn get on PUBLIC_URL's rpId and origin, nothing else. On any
 * other origin the page names the right one and offers recovery, and never starts a ceremony that is bound to fail.
 *
 * Recovery (/admin/recover): the claim flow with purpose "recover". Nothing is printed: the owner proves control of the
 * Worker by setting the ADMIN_RECOVERY_CODE secret (only someone allowed to change the Worker can) and typing the same
 * value (checkCode never accepts ADMIN_SETUP_CODE or a logged code for it). It adds a passkey on the request's origin,
 * stores the value as used (each value works once), moves PUBLIC_URL there when the owner ticked the move box, and in the
 * same batch bumps session_gen and the POS version (every admin session and every POS session ends) and records an
 * admin.recovered alert. While a Wrangler var pins PUBLIC_URL, recovery runs on that origin only.
 *
 * Challenges are single use, issued per ceremony kind and bound to the browser (the session cookie, or before sign-in
 * the random 0c_setup cookie) and, for claim and recovery, to the code's hash. The options endpoints are rate limited
 * per client, and these pre-auth kinds are never refused at the per-kind cap (the oldest live ones are evicted instead,
 * challenges.ts), so a flood cannot lock the owner out.
 */

type Ctx = Context<AdminEnv>;

export const CLAIMED = "This gateway was just claimed by another browser.";
export const LOGIN_REFUSED = "That passkey was not accepted. Try again or use “Lost your passkey or moved?”";
const TOO_SOON = "A code was printed less than 2 minutes ago. Check your logs.";
const PRINTED = "A new code was printed to your Worker logs.";
const REG_FAILED = "The passkey could not be created or the request expired. Try again.";
const ALREADY_LISTED = "That passkey is already registered. Sign in with it instead.";
const TOO_FAST = "Too many passkey requests from this address. Wait a minute and try again.";
const BUSY = "Too many pending passkey requests. Try again in a few minutes.";
const RECOVERED = "A new passkey was added with the ADMIN_RECOVERY_CODE secret. Every device was signed out. Delete that secret now.";
/** An attestation or assertion is a few kilobytes at most; anything far larger is not parsed. */
const MAX_CEREMONY_JSON = 64 * 1024;

const formStr = (form: Record<string, unknown>, k: string): string => (typeof form[k] === "string" ? (form[k] as string) : "");

/** The pre-Plan-7 cookies lived at Path=/admin; there they would shadow the new Path=/ ones on http loopback. */
const LEGACY_COOKIES = ["0c_session", "0c_csrf", "0c_setup"];
const dropLegacyCookies = (c: Ctx) => {
  for (const name of LEGACY_COOKIES) deleteCookie(c, name, { path: "/admin", secure: secureCookie(c.req.url), sameSite: "Strict" });
};

/** Signs the admin in on this browser: a session cookie under the current session_gen, valid for SESSION_MAX_AGE. */
export async function startSession(c: Ctx): Promise<void> {
  const url = c.req.url;
  const value = await signSession(c.env.SESSION_SECRET, await sessionGen(c.env.DB), Date.now() + SESSION_MAX_AGE * 1000);
  dropLegacyCookies(c);
  setCookie(c, cookieName(SESSION_COOKIE, url), value, { ...cookieAttrs(url), httpOnly: true, maxAge: SESSION_MAX_AGE });
}

/**
 * What this browser's challenges are bound to: the session cookie, else the pre-auth 0c_setup cookie. Only read on
 * POSTs, after the admin middleware has checked the CSRF token against that same cookie (so it is present and valid).
 * Cookie values never contain "|", the bindingHash separator.
 */
const binderOf = (c: Ctx): string => c.get("session") ?? getCookie(c, cookieName(SETUP_COOKIE, c.req.url)) ?? "";

/** One client's budget for passkey options (60 a minute), so one source alone cannot churn the per-kind window of live challenges. */
const optionsLimited = async (c: Ctx): Promise<boolean> => !(await c.env.API_RATE.limit({ key: "webauthn:" + clientIpKey(c) })).success;

/** A recovery from this origin moves the gateway (PUBLIC_URL is unset, or names another origin). */
const moving = (c: Ctx, origin: string): boolean => publicOrigin(c.env) !== origin;

function parseJson(raw: string): unknown {
  if (raw === "" || raw.length > MAX_CEREMONY_JSON) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function issue(c: Ctx, kind: ChallengeKind, payloadHash: string): Promise<string | Response> {
  try {
    return await newChallenge(c.env.DB, kind, payloadHash, Date.now());
  } catch (e) {
    if (e instanceof ChallengeLimit) return c.json({ error: BUSY }, 429);
    throw e;
  }
}

const claimed = async (db: D1Database): Promise<boolean> => (await db.prepare("SELECT 1 AS x FROM passkeys LIMIT 1").first()) !== null;

const userHandle = async (db: D1Database): Promise<Uint8Array> =>
  hexToBytes((await db.prepare("SELECT user_id FROM admin_state WHERE id=1").first<{ user_id: string }>())!.user_id);

function transportsOf(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  } catch {
    return undefined;
  }
}

// ---------- pages ----------

const Problem = (props: { text?: string }) => (props.text ? <Flash kind="error">{props.text}</Flash> : null);

/** Where the setup code is. */
function WhereIsTheCode(props: { line: string }) {
  return (
    <section class="well find-code" aria-labelledby="find-code-h">
      <h2 id="find-code-h">Where to find the code</h2>
      <ol class="small">
        <li>
          Open the Cloudflare dashboard → Workers &amp; Pages → your Worker (0crypto unless you renamed it) → Observability, or run{" "}
          <code class="mono">npx wrangler tail</code>.
        </li>
        <li>
          Look for the line that starts with <span class="mono">{props.line}</span>.
        </li>
        <li>Type its six words below. A code is valid for 60 minutes and works once.</li>
      </ol>
    </section>
  );
}

function CodeForm(props: { purpose: CodePurpose; csrf: string; error?: string; children?: Child }) {
  const base = props.purpose === "setup" ? "/admin/setup" : "/admin/recover";
  return (
    <form method="post" action={base} class="form" data-passkey-register={`${base}/options`}>
      <Csrf token={props.csrf} />
      <Problem text={props.error} />
      <Field label={props.purpose === "setup" ? "Setup code (6 words)" : "Recovery code (the ADMIN_RECOVERY_CODE value)"} name="code">
        <textarea class="input mono" name="code" rows={2} autocomplete="off" autocapitalize="none" spellcheck={false} required></textarea>
      </Field>
      {props.children}
      <input type="hidden" name="credential" value="" />
      <p class="flash flash-error" role="alert" data-passkey-error hidden></p>
      <button type="submit" class="btn cta">
        Create passkey
      </button>
      <noscript>
        <p class="flash flash-error">{props.purpose === "setup" ? "Setup" : "Recovery"} needs JavaScript: passkeys are created by the browser.</p>
      </noscript>
    </form>
  );
}

function PrintForm(props: { csrf: string; notice?: string }) {
  return (
    <form method="post" action="/admin/setup/code" class="form">
      <Csrf token={props.csrf} />
      {props.notice ? <Flash kind="ok">{props.notice}</Flash> : null}
      <button type="submit" class="btn2">
        Print a new code
      </button>
    </form>
  );
}

function SetupPage(props: { csrf: string; error?: string; notice?: string; refusal?: string }) {
  return (
    <AuthShell title="Set up">
      <h1 class="auth-title">Claim your gateway</h1>
      {props.refusal ? (
        <Problem text={props.refusal} />
      ) : (
        <>
          <p class="muted small">
            This gateway has no owner yet. Type the code it printed to its Worker logs, then create a passkey. That passkey signs you in from now on.
          </p>
          <WhereIsTheCode line="0crypto setup code:" />
          <CodeForm purpose="setup" csrf={props.csrf} error={props.error} />
          <PrintForm csrf={props.csrf} notice={props.notice} />
        </>
      )}
    </AuthShell>
  );
}

/** The answer to the claim that lost the race: setup is over, so it offers sign-in instead of the code form. */
function ClaimedPage() {
  return (
    <AuthShell title="Already claimed">
      <h1 class="auth-title">Already claimed</h1>
      <Flash kind="error">{CLAIMED}</Flash>
      <p class="auth-links small">
        <a href="/admin/login">Sign in</a>
      </p>
    </AuthShell>
  );
}

type RecoverView = { csrf: string; error?: string; notice?: string; moveTo: string | null; refusal?: string };

/** How to prove you own the Worker: set a secret only an editor can set, then type it. */
function SetRecoverySecret(props: { suggestion: string }) {
  return (
    <section class="well find-code" aria-labelledby="find-code-h">
      <h2 id="find-code-h">Prove you own this gateway</h2>
      <ol class="small">
        <li>
          Copy this recovery code: <code class="mono">{props.suggestion}</code> (or use your own, at least 32 characters).
        </li>
        <li>
          In the Cloudflare dashboard open Workers &amp; Pages → your Worker (0crypto unless you renamed it) → Settings → Variables and Secrets. Add a{" "}
          <b>Secret</b> named <span class="mono">ADMIN_RECOVERY_CODE</span> with the code as its value, and deploy. Or run{" "}
          <code class="mono">npx wrangler secret put ADMIN_RECOVERY_CODE</code>.
        </li>
        <li>Paste the same code below and create a passkey. Each code works once; delete the secret afterwards.</li>
      </ol>
    </section>
  );
}

function RecoverPage(props: RecoverView) {
  return (
    <AuthShell title="Recover access">
      <h1 class="auth-title">Lost your passkey or moved?</h1>
      <p class="muted small">
        Adds a new passkey for this address. Every device is signed out; your other passkeys stay listed, and you can remove them afterwards.
      </p>
      {props.refusal ? (
        <Problem text={props.refusal} />
      ) : (
        <>
          <SetRecoverySecret suggestion={newRecoveryValue()} />
          <CodeForm purpose="recover" csrf={props.csrf} error={props.error}>
            {props.moveTo !== null ? (
              <Panel tone="warn" label="Moving your gateway">
                <label class="check small">
                  <input type="checkbox" name="move" value="1" required /> This will move your gateway to {props.moveTo}
                </label>
              </Panel>
            ) : null}
          </CodeForm>
        </>
      )}
      <p class="auth-links small">
        <a href="/admin/login">Back to sign in</a>
      </p>
    </AuthShell>
  );
}

const RecoverLink = () => (
  <p class="auth-links small">
    <a href="/admin/recover">Lost your passkey or moved to a new domain?</a>
  </p>
);

function LoginPage(props: { csrf: string; error?: string; elsewhere?: { refusal: RpRefusal; publicUrl: string | null } }) {
  if (props.elsewhere) {
    const { refusal, publicUrl: url } = props.elsewhere;
    return (
      <AuthShell title="Sign in">
        <h1 class="auth-title">Sign in</h1>
        <Problem text={props.error} />
        {refusal.reason === "ip" || url === null ? (
          refusal.reason === "ip" ? (
            <Flash kind="error">{refusal.error}</Flash>
          ) : (
            <p class="muted">This gateway has no public address yet, so passkeys cannot sign in. Use recovery to set it to this address.</p>
          )
        ) : (
          <>
            <p class="muted">Passkeys for this gateway work on its public address only.</p>
            <p>
              <a class="btn cta" href={`${url}/admin/login`}>
                Sign in at {url}
              </a>
            </p>
          </>
        )}
        <RecoverLink />
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Sign in">
      <h1 class="auth-title">Sign in</h1>
      <form method="post" action="/admin/login" class="form" data-passkey-login="/admin/login/options">
        <Csrf token={props.csrf} />
        <Problem text={props.error} />
        <Field label="Passkey" name="username" autocomplete="username webauthn" placeholder="Pick a saved passkey" />
        <input type="hidden" name="assertion" value="" />
        <p class="flash flash-error" role="alert" data-passkey-error hidden></p>
        <button type="submit" class="btn cta">
          Sign in with passkey
        </button>
        <noscript>
          <p class="flash flash-error">Sign-in needs JavaScript: passkeys are used through the browser.</p>
        </noscript>
      </form>
      <RecoverLink />
    </AuthShell>
  );
}

// ---------- the batches ----------

/** True while the passkey row this request inserted is there (statement guards after the insert in the same batch). */
const INSERTED = "EXISTS (SELECT 1 FROM passkeys WHERE id=?1 AND public_key=?2 AND created_at=?3)";

type NewPasskey = { id: string; publicKey: Uint8Array; counter: number; transports: string[] };

/**
 * The claim, as one batch: the passkey is stored only while none exists and the code is live (or it is the
 * ADMIN_SETUP_CODE match); everything after is guarded on that row. True iff this request claimed the gateway.
 */
async function claimBatch(db: D1Database, reg: NewPasskey, codeHash: string, rp: RelyingParty, now: number): Promise<boolean> {
  const origin = rp.origin;
  const [ins] = await db.batch([
    db
      .prepare(
        `INSERT INTO passkeys(id,public_key,counter,transports,name,created_at,rp_id)
         SELECT ?1,?2,?3,?4,'Passkey 1',?5,?7
         WHERE NOT EXISTS (SELECT 1 FROM passkeys)
           AND (?6 = 'env' OR EXISTS (SELECT 1 FROM setup_codes WHERE hash=?6 AND purpose='setup' AND expires_at>?5))`,
      )
      .bind(reg.id, reg.publicKey, reg.counter, JSON.stringify(reg.transports), now, codeHash, rp.rpId),
    // The code, and every other setup code: nothing can claim twice.
    db.prepare(`DELETE FROM setup_codes WHERE purpose='setup' AND ${INSERTED}`).bind(reg.id, reg.publicKey, now),
    db
      .prepare(
        `INSERT INTO settings(key,value,updated_at) SELECT 'PUBLIC_URL',?4,?3 WHERE ${INSERTED}
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .bind(reg.id, reg.publicKey, now, origin),
    db.prepare(`UPDATE admin_state SET created_at=?3 WHERE id=1 AND created_at=0 AND ${INSERTED}`).bind(reg.id, reg.publicKey, now),
  ]);
  return (ins!.meta.changes ?? 0) === 1;
}

/**
 * The recovery, as one batch: the passkey is stored only while the recovery value is unused; then (guarded on that row)
 * the value is stored as used, PUBLIC_URL moves when asked, session_gen and the POS version are bumped (as sign out
 * everywhere does) and the admin.recovered alert is recorded. A credential id that is already listed fails the insert
 * and the whole batch. True iff this request recovered.
 */
async function recoverBatch(db: D1Database, reg: NewPasskey, codeHash: string, rpId: string, moveTo: string | null, now: number): Promise<boolean> {
  const name = `Recovered ${new Date(now).toISOString().slice(0, 10)}`;
  const stmts = [
    db
      .prepare(
        `INSERT INTO passkeys(id,public_key,counter,transports,name,created_at,rp_id)
         SELECT ?1,?2,?3,?4,?5,?6,?8
         WHERE NOT EXISTS (SELECT 1 FROM setup_codes WHERE hash=?7 AND purpose='recover')`,
      )
      .bind(reg.id, reg.publicKey, reg.counter, JSON.stringify(reg.transports), name, now, codeHash, rpId),
    // Each value works once.
    db
      .prepare(`INSERT INTO setup_codes(hash,purpose,created_at,expires_at) SELECT ?4,'recover',?3,?5 WHERE ${INSERTED}`)
      .bind(reg.id, reg.publicKey, now, codeHash, USED_FOREVER),
  ];
  if (moveTo !== null)
    stmts.push(
      db
        .prepare(
          `INSERT INTO settings(key,value,updated_at) SELECT 'PUBLIC_URL',?4,?3 WHERE ${INSERTED}
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        )
        .bind(reg.id, reg.publicKey, now, moveTo),
    );
  stmts.push(
    db.prepare(`UPDATE admin_state SET session_gen=session_gen+1 WHERE id=1 AND ${INSERTED}`).bind(reg.id, reg.publicKey, now),
    // bumpPosVersion, guarded: admin-opened and PIN POS cookies end too.
    db.prepare(`UPDATE pos_config SET version=version+1, updated_at=?3 WHERE id=1 AND ${INSERTED}`).bind(reg.id, reg.publicKey, now),
    // recordAlert(..., { dedupe: false }), guarded: every recovery is recorded, since each replaced every device's sign-in.
    db
      .prepare(`INSERT INTO alerts(id,created_at,kind,chain,detail,resolved_at) SELECT ?4,?3,'admin.recovered',NULL,?5,NULL WHERE ${INSERTED}`)
      .bind(reg.id, reg.publicKey, now, `alt_${crypto.randomUUID().replaceAll("-", "")}`, RECOVERED),
  );
  const [ins] = await db.batch(stmts);
  return (ins!.meta.changes ?? 0) === 1;
}

// ---------- routes ----------

/** Setup, sign-in, recovery and sign-out. The admin middleware (routes.tsx) gates the paths and checks CSRF first. */
export function registerAuth(app: Hono<AdminEnv>): void {
  // ----- claim -----

  const setupPage = (c: Ctx, status: 200 | 400 | 409 | 429 = 200, o: { error?: string; notice?: string; refusal?: string } = {}) =>
    page(c, <SetupPage csrf={c.get("csrf")} error={o.error} notice={o.notice} refusal={o.refusal} />, status);
  const setupRp = (c: Ctx) => requestRp(c.env, c.req.url, "/admin/setup");

  app.get("/setup", async (c) => {
    const rp = setupRp(c);
    if (!rp.ok) return setupPage(c, 400, { refusal: rp.error });
    await ensureCode(c.env.DB, "setup", Date.now());
    return setupPage(c);
  });

  app.post("/setup/code", async (c) => {
    if ((await printCode(c.env.DB, "setup", Date.now())) === "too_soon") return setupPage(c, 429, { error: TOO_SOON });
    return setupPage(c, 200, { notice: PRINTED });
  });

  app.post("/setup/options", async (c) => {
    if (await optionsLimited(c)) return c.json({ error: TOO_FAST }, 429);
    const check = setupRp(c);
    if (!check.ok) return c.json({ error: check.error }, 400);
    const rp = check.rp;
    const form = await c.req.parseBody();
    const code = await checkCode(c.env, clientIpKey(c), "setup", formStr(form, "code"), Date.now());
    if (!code.ok) return c.json({ error: code.error }, code.status);
    const challenge = await issue(c, "setup", await bindingHash(binderOf(c), code.hash));
    if (challenge instanceof Response) return challenge;
    return c.json({ options: await registrationOptions({ rpId: rp.rpId, userId: await userHandle(c.env.DB), challenge, exclude: [] }) });
  });

  app.post("/setup", async (c) => {
    const check = setupRp(c);
    if (!check.ok) return setupPage(c, 400, { refusal: check.error });
    const rp = check.rp;
    const form = await c.req.parseBody();
    const now = Date.now();
    // A request that lost the race may only notice at the code check (the winner spent every setup code).
    const lost = async (fallback: () => Response) => ((await claimed(c.env.DB)) ? page(c, <ClaimedPage />, 409) : fallback());
    const code = await checkCode(c.env, clientIpKey(c), "setup", formStr(form, "code"), now);
    if (!code.ok) {
      const { status, error } = code;
      return lost(() => setupPage(c, status, { error }));
    }
    const reg = await verifyRegistration({
      response: parseJson(formStr(form, "credential")),
      check: challengeCheck(c.env.DB, "setup", await bindingHash(binderOf(c), code.hash), now),
      origin: rp.origin,
      rpId: rp.rpId,
    });
    if (!reg) return lost(() => setupPage(c, 400, { error: REG_FAILED }));
    if (!(await claimBatch(c.env.DB, reg, code.hash, rp, now))) return lost(() => setupPage(c, 400, { error: BAD_CODE }));
    clearSettingsCache();
    await startSession(c);
    return c.redirect("/admin/welcome", 303);
  });

  // ----- sign-in -----

  const loginRp = (c: Ctx) => publicRp(c.env, c.req.url, "/admin/login");
  const loginPage = (c: Ctx, status: 200 | 400 | 401 = 200, error?: string) => {
    const rp = loginRp(c);
    return page(c, <LoginPage csrf={c.get("csrf")} error={error} elsewhere={rp.ok ? undefined : { refusal: rp, publicUrl: publicOrigin(c.env) }} />, status);
  };

  app.get("/login", (c) => (c.get("session") !== null ? c.redirect("/admin", 302) : loginPage(c)));

  app.post("/login/options", async (c) => {
    if (await optionsLimited(c)) return c.json({ error: TOO_FAST }, 429);
    const check = loginRp(c);
    if (!check.ok) return c.json({ error: check.error }, 400);
    const challenge = await issue(c, "login", await bindingHash(binderOf(c)));
    if (challenge instanceof Response) return challenge;
    return c.json({ options: await authenticationOptions({ rpId: check.rp.rpId, challenge, allow: [] }) });
  });

  app.post("/login", async (c) => {
    const check = loginRp(c);
    if (!check.ok) return loginPage(c, 400);
    const rp = check.rp;
    const refused = () => loginPage(c, 401, LOGIN_REFUSED);
    const response = parseJson(formStr(await c.req.parseBody(), "assertion"));
    const id = credentialIdOf(response);
    if (id === null) return refused();
    const row = await c.env.DB.prepare("SELECT id,public_key,counter,transports FROM passkeys WHERE id=?").bind(id).first<StoredPasskey>();
    if (!row) return refused();
    const passkey: StoredPasskey = { ...row, public_key: Array.isArray(row.public_key) ? Uint8Array.from(row.public_key as number[]) : row.public_key };
    const now = Date.now();
    const out = await verifyAuthentication({
      response,
      check: challengeCheck(c.env.DB, "login", await bindingHash(binderOf(c)), now),
      origin: rp.origin,
      rpId: rp.rpId,
      passkey,
    });
    if (!out) return refused();
    await c.env.DB.prepare("UPDATE passkeys SET counter=max(counter,?1), last_used_at=?2 WHERE id=?3").bind(out.newCounter, now, id).run();
    await startSession(c);
    return c.redirect("/admin", 303);
  });

  // ----- recovery -----

  const recoverRp = (c: Ctx) => requestRp(c.env, c.req.url, "/admin/recover");
  const recoverPage = (c: Ctx, status: 200 | 400 | 429 = 200, o: { error?: string; notice?: string } = {}) => {
    const rp = recoverRp(c);
    const view = rp.ok ? { moveTo: moving(c, rp.rp.origin) ? rp.rp.origin : null } : { moveTo: null, refusal: rp.error };
    return page(c, <RecoverPage csrf={c.get("csrf")} {...view} error={o.error} notice={o.notice} />, rp.ok ? status : 400);
  };
  /** Moving needs the box ticked. */
  const moveRefusal = (c: Ctx, origin: string, form: Record<string, unknown>): string | null =>
    moving(c, origin) && formStr(form, "move") !== "1" ? `Tick “This will move your gateway to ${origin}” to continue.` : null;

  app.get("/recover", (c) => recoverPage(c));

  app.post("/recover/options", async (c) => {
    if (await optionsLimited(c)) return c.json({ error: TOO_FAST }, 429);
    const check = recoverRp(c);
    if (!check.ok) return c.json({ error: check.error }, 400);
    const rp = check.rp;
    const form = await c.req.parseBody();
    const refusal = moveRefusal(c, rp.origin, form);
    if (refusal) return c.json({ error: refusal }, 400);
    const code = await checkCode(c.env, clientIpKey(c), "recover", formStr(form, "code"), Date.now());
    if (!code.ok) return c.json({ error: code.error }, code.status);
    const challenge = await issue(c, "recover", await bindingHash(binderOf(c), code.hash));
    if (challenge instanceof Response) return challenge;
    const { results } = await c.env.DB.prepare("SELECT id,transports FROM passkeys WHERE rp_id=? ORDER BY created_at, id")
      .bind(rp.rpId)
      .all<{ id: string; transports: string | null }>();
    const exclude = results.map((r) => {
      const t = transportsOf(r.transports);
      return t === undefined ? { id: r.id } : { id: r.id, transports: t };
    });
    return c.json({ options: await registrationOptions({ rpId: rp.rpId, userId: await userHandle(c.env.DB), challenge, exclude }) });
  });

  app.post("/recover", async (c) => {
    const check = recoverRp(c);
    if (!check.ok) return recoverPage(c, 400);
    const rp = check.rp;
    const form = await c.req.parseBody();
    const refusal = moveRefusal(c, rp.origin, form);
    if (refusal) return recoverPage(c, 400, { error: refusal });
    const now = Date.now();
    const code = await checkCode(c.env, clientIpKey(c), "recover", formStr(form, "code"), now);
    if (!code.ok) return recoverPage(c, code.status, { error: code.error });
    const reg = await verifyRegistration({
      response: parseJson(formStr(form, "credential")),
      check: challengeCheck(c.env.DB, "recover", await bindingHash(binderOf(c), code.hash), now),
      origin: rp.origin,
      rpId: rp.rpId,
    });
    if (!reg) return recoverPage(c, 400, { error: REG_FAILED });
    const moveTo = moving(c, rp.origin) ? rp.origin : null;
    let ok: boolean;
    try {
      ok = await recoverBatch(c.env.DB, reg, code.hash, rp.rpId, moveTo, now);
    } catch (e) {
      // The only constraint the insert can hit: that credential id is already a listed passkey. Nothing was written.
      if (e instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(e.message)) return recoverPage(c, 400, { error: ALREADY_LISTED });
      throw e;
    }
    if (!ok) return recoverPage(c, 400, { error: BAD_RECOVERY });
    clearSettingsCache();
    await startSession(c);
    return c.redirect("/admin/passkeys", 303);
  });

  // ----- sign-out -----

  // Signs out this browser only; "sign out everywhere" bumps session_gen instead.
  app.post("/logout", (c) => {
    deleteCookie(c, cookieName(SESSION_COOKIE, c.req.url), { ...cookieAttrs(c.req.url), httpOnly: true });
    dropLegacyCookies(c);
    return c.redirect("/admin/login", 303);
  });
}
