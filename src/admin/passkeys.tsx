import { hexToBytes } from "@noble/hashes/utils.js";
import type { Context, Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { bumpPosVersion } from "../pos/store";
import { clientIpKey } from "../core/ip";
import { confirmProblem } from "./confirm";
import { bindingHash, ChallengeLimit, challengeCheck, newChallenge } from "./challenges";
import { startSession } from "./auth";
import { adminPage, Csrf, type AdminEnv } from "./layout";
import { DataTable, EmptyState, Field, Flash, Panel, PasskeyConfirm } from "./ui";
import { currentRpId, publicRp } from "./rp";
import { SESSION_COOKIE, bumpSessionGen, cookieAttrs, cookieName } from "./session";
import { registrationOptions, verifyRegistration } from "./webauthn";

/*
 * The Passkeys page: list, add a backup passkey, rename, remove, sign out everywhere.
 *
 * Adding is a WebAuthn registration (challenge kind "add", bound to the session and the chosen name) that is first
 * confirmed with an existing passkey ("passkey.add", params { name }). Removing is confirmed too ("passkey.remove",
 * bound to the removal's own path) and the DELETE itself refuses to leave zero passkeys for the current RP ID. A
 * removal and sign out everywhere both bump session_gen and the POS version, so every admin session and every POS
 * session (admin-opened or cashier PIN) ends; a removal then signs the acting browser straight back in.
 *
 * Every passkey records the RP ID (host) it was created for. Only those for PUBLIC_URL's host can sign in, so only they
 * count for the remove-last guard and appear in excludeCredentials; a passkey left from an old domain (after a move)
 * is shown with where it works and can always be removed.
 */

type Ctx = Context<AdminEnv>;
type Row = { id: string; name: string; created_at: number; last_used_at: number | null; rp_id: string | null };

export const LAST_PASSKEY = "You cannot remove your only passkey.";
const REG_FAILED = "The passkey could not be created or the request expired. Try again.";
const ALREADY_LISTED = "That passkey is already registered.";
const BUSY = "Too many pending passkey requests. Try again in a few minutes.";
const TOO_FAST = "Too many passkey requests from this address. Wait a minute and try again.";
const MAX_NAME = 64;
const MAX_JSON = 64 * 1024;

const utc = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "Never");
const formStr = (form: Record<string, unknown>, k: string): string => (typeof form[k] === "string" ? (form[k] as string) : "");
const cleanName = (raw: string): string => raw.trim().slice(0, MAX_NAME);

function transportsOf(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  } catch {
    return undefined;
  }
}

function PasskeysPage(props: { rows: Row[]; rpId: string | null; csrf: string; error?: string; notice?: string }) {
  const here = props.rows.filter((r) => r.rp_id !== null && r.rp_id === props.rpId).length;
  const isLast = (r: Row) => r.rp_id === props.rpId && here < 2;
  return (
    <>
      <p class="muted small">
        Passkeys sign you in and confirm money and security actions. Keep a backup on another device, so losing one never locks you out.
      </p>
      {props.error ? <Flash kind="error">{props.error}</Flash> : null}
      {props.notice ? <Flash kind="ok">{props.notice}</Flash> : null}
      <Panel title="Your passkeys">
        <DataTable
          label="Passkeys"
          rows={props.rows}
          empty={<EmptyState title="No passkeys">Add one below.</EmptyState>}
          columns={[
            {
              head: "Name",
              cell: (r) => (
                <>
                  <form method="post" action={`/admin/passkeys/${encodeURIComponent(r.id)}/rename`} class="row-form">
                    <Csrf token={props.csrf} />
                    <input class="input field-sm" name="name" maxlength={MAX_NAME} required value={r.name} aria-label={`Name of ${r.name}`} />
                    <button type="submit" class="btn2 btn-sm">
                      Rename
                    </button>
                  </form>
                  <p class="small muted">works on {r.rp_id ?? "an unknown host"}</p>
                </>
              ),
            },
            { head: "Created", cell: (r) => <span class="muted">{utc(r.created_at)}</span> },
            { head: "Last used", cell: (r) => <span class="muted">{utc(r.last_used_at)}</span> },
            {
              head: "Remove",
              cell: (r) => (
                <form method="post" action={`/admin/passkeys/${encodeURIComponent(r.id)}/remove`} class="form" data-passkey-confirm="passkey.remove">
                  <Csrf token={props.csrf} />
                  <PasskeyConfirm />
                  <button type="submit" class="btn2 btn-sm" disabled={isLast(r)}>
                    Remove
                  </button>
                  {isLast(r) ? <p class="small muted">You can't remove your only passkey</p> : null}
                </form>
              ),
            },
          ]}
        />
      </Panel>
      <Panel title="Add a backup passkey" id="add-passkey">
        <form method="post" action="/admin/passkeys" class="form" data-passkey-confirm="passkey.add" data-passkey-register="/admin/passkeys/options">
          <Csrf token={props.csrf} />
          <Field label="Name" name="name" maxlength={MAX_NAME} required value={`Passkey ${here + 1}`} />
          <input type="hidden" name="credential" value="" />
          <PasskeyConfirm />
          <button type="submit" class="btn cta">
            Add passkey
          </button>
        </form>
      </Panel>
      <Panel title="Sign out everywhere">
        <p class="muted small">Ends every admin session on every device and every POS session, including cashier PIN sessions.</p>
        <form method="post" action="/admin/logout-all" class="form">
          <Csrf token={props.csrf} />
          <button type="submit" class="btn2">
            Sign out everywhere
          </button>
        </form>
      </Panel>
    </>
  );
}

export function registerPasskeys(app: Hono<AdminEnv>): void {
  const list = async (db: D1Database): Promise<Row[]> =>
    (await db.prepare("SELECT id,name,created_at,last_used_at,rp_id FROM passkeys ORDER BY created_at, id").all<Row>()).results;

  const render = async (c: Ctx, status: 200 | 400 | 403 | 404 | 409 | 429 = 200, o: { error?: string } = {}) =>
    adminPage(
      c,
      {
        title: "Passkeys",
        active: "passkeys",
        actions: (
          <a href="#add-passkey" class="btn">
            + Add a passkey
          </a>
        ),
      },
      <PasskeysPage rows={await list(c.env.DB)} rpId={currentRpId(c.env)} csrf={c.get("csrf")} error={o.error} />,
      status,
    );

  /** A new passkey is bound to PUBLIC_URL (the relying party sign-in uses), and only added from that very origin. */
  const rpOf = (c: Ctx) => publicRp(c.env, c.req.url, "/admin/passkeys");

  app.get("/passkeys", (c) => render(c));

  app.post("/passkeys/options", async (c) => {
    if (!(await c.env.API_RATE.limit({ key: "webauthn:" + clientIpKey(c) })).success) return c.json({ error: TOO_FAST }, 429);
    const check = rpOf(c);
    if (!check.ok) return c.json({ error: check.error }, 400);
    const rp = check.rp;
    const session = c.get("session")!;
    const name = cleanName(formStr(await c.req.parseBody(), "name"));
    if (name === "") return c.json({ error: "Enter a name for the passkey." }, 400);
    let challenge: string;
    try {
      challenge = await newChallenge(c.env.DB, "add", await bindingHash(session, name), Date.now());
    } catch (e) {
      if (e instanceof ChallengeLimit) return c.json({ error: BUSY }, 429);
      throw e;
    }
    const userId = hexToBytes((await c.env.DB.prepare("SELECT user_id FROM admin_state WHERE id=1").first<{ user_id: string }>())!.user_id);
    const { results } = await c.env.DB.prepare("SELECT id,transports FROM passkeys WHERE rp_id=? ORDER BY created_at, id")
      .bind(rp.rpId)
      .all<{ id: string; transports: string | null }>();
    const exclude = results.map((r) => {
      const t = transportsOf(r.transports);
      return t === undefined ? { id: r.id } : { id: r.id, transports: t };
    });
    return c.json({ options: await registrationOptions({ rpId: rp.rpId, userId, challenge, exclude }) });
  });

  app.post("/passkeys", async (c) => {
    // Checked before the confirmation, so a request from the wrong origin spends nothing.
    const check = rpOf(c);
    if (!check.ok) return render(c, 400, { error: check.error });
    const rp = check.rp;
    const form = await c.req.parseBody();
    const problem = await confirmProblem(c, form, "passkey.add");
    if (problem) return render(c, 403, { error: problem });
    const name = cleanName(formStr(form, "name"));
    const raw = formStr(form, "credential");
    let response: unknown = null;
    if (name !== "" && raw !== "" && raw.length <= MAX_JSON) {
      try {
        response = JSON.parse(raw);
      } catch {
        response = null;
      }
    }
    const now = Date.now();
    const reg = await verifyRegistration({
      response,
      check: challengeCheck(c.env.DB, "add", await bindingHash(c.get("session")!, name), now),
      origin: rp.origin,
      rpId: rp.rpId,
    });
    if (!reg) return render(c, 400, { error: REG_FAILED });
    try {
      await c.env.DB.prepare("INSERT INTO passkeys(id,public_key,counter,transports,name,created_at,rp_id) VALUES(?,?,?,?,?,?,?)")
        .bind(reg.id, reg.publicKey, reg.counter, JSON.stringify(reg.transports), name, now, rp.rpId)
        .run();
    } catch (e) {
      if (e instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(e.message)) return render(c, 400, { error: ALREADY_LISTED });
      throw e;
    }
    return c.redirect("/admin/passkeys", 303);
  });

  app.post("/passkeys/:id/rename", async (c) => {
    const name = cleanName(formStr(await c.req.parseBody(), "name"));
    if (name === "") return render(c, 400, { error: "Enter a name for the passkey." });
    await c.env.DB.prepare("UPDATE passkeys SET name=? WHERE id=?").bind(name, c.req.param("id")).run();
    return c.redirect("/admin/passkeys", 303);
  });

  app.post("/passkeys/:id/remove", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const rpId = currentRpId(c.env);
    const target = await c.env.DB.prepare("SELECT rp_id, (SELECT count(*) FROM passkeys WHERE rp_id=?2) AS here FROM passkeys WHERE id=?1")
      .bind(id, rpId)
      .first<{ rp_id: string | null; here: number }>();
    if (!target) return render(c, 404, { error: "That passkey no longer exists." });
    if (target.rp_id === rpId && target.here < 2) return render(c, 409, { error: LAST_PASSKEY });
    const problem = await confirmProblem(c, form, "passkey.remove");
    if (problem) return render(c, 403, { error: problem });
    // Atomic: the delete itself refuses to leave zero passkeys for this RP ID (two racing removals cannot both pass the
    // check above). A passkey for another RP ID cannot sign in here, so it can always go.
    const r = await c.env.DB.prepare("DELETE FROM passkeys WHERE id=?1 AND (rp_id IS NOT ?2 OR (SELECT count(*) FROM passkeys WHERE rp_id=?2) > 1)")
      .bind(id, rpId)
      .run();
    if ((r.meta.changes ?? 0) !== 1) return render(c, 409, { error: LAST_PASSKEY });
    await bumpSessionGen(c.env.DB);
    await bumpPosVersion(c.env.DB);
    await startSession(c);
    return c.redirect("/admin/passkeys", 303);
  });

  app.post("/logout-all", async (c) => {
    await bumpSessionGen(c.env.DB);
    await bumpPosVersion(c.env.DB);
    deleteCookie(c, cookieName(SESSION_COOKIE, c.req.url), { ...cookieAttrs(c.req.url), httpOnly: true });
    return c.redirect("/admin/login", 303);
  });
}

