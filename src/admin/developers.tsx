import type { Context, Hono } from "hono";
import { createApiKey } from "../api/auth";
import { rotateWebhookKey } from "../keys";
import { clearSettingsCache, saveSettings, SettingsError, webhookSecretFromWorker } from "../settings";
import { sendTestEvent } from "../webhooks/consumer";
import { confirmProblem } from "./confirm";
import { adminPage, Csrf, type AdminEnv } from "./layout";
import { DataTable, EmptyState, Field, Flash, Panel, PasskeyConfirm, WebhookTestResult } from "./ui";
import { utc } from "./views";
import { renderWelcomeDone } from "./welcome";

/*
 * The Developers page: API keys (create "key.create", revoke "key.revoke"), the webhook URL with a test event, and the
 * webhook secret. The secret is never in a page by default: reveal is a passkey-confirmed POST, with the same action
 * as rotate ("webhook.rotate"), because reading the secret lets a session forge "paid" webhooks; the bound `_path`
 * keeps a reveal assertion from rotating and the other way round. The secret is never logged.
 *
 * The first-run wizard's done step posts its reveal, webhook URL and test event forms here with from=welcome; those
 * answers render the wizard instead of this page. A reveal renders it directly (a redirect would lose the secret, and
 * the secret never goes in a URL).
 */

type Ctx = Context<AdminEnv>;
type KeyRow = { id: string; label: string | null; created_at: number; revoked_at: number | null };

export const WORKER_SECRET_NOTE = "Set as a Worker secret. Change it with npx wrangler secret put WEBHOOK_SECRET.";
const ROTATE_NOTE =
  "Rotating takes effect for new deliveries at once. Other Worker instances may use the old secret for up to 30 s; deliveries your server rejects in that window are retried.";

// The first 16 hex chars of the hash identify a key in forms; the hash never leaves the database.
const listKeys = async (db: D1Database) =>
  (await db.prepare("SELECT substr(hash,1,16) AS id,label,created_at,revoked_at FROM api_keys ORDER BY created_at DESC, hash").all<KeyRow>()).results;

const formStr = (form: Record<string, unknown>, k: string): string => (typeof form[k] === "string" ? (form[k] as string) : "");
const fromWelcome = (form: Record<string, unknown>): boolean => formStr(form, "from") === "welcome";

type View = {
  keys: KeyRow[];
  csrf: string;
  webhookUrl: string;
  workerSecret: boolean;
  newKey?: string;
  secret?: string;
  error?: { section: "keys" | "webhook" | "secret"; message: string };
  notice?: string;
  testResult?: { status: number; error: string | null };
  typedUrl?: string;
};

function DevelopersPage(v: View) {
  const err = (section: "keys" | "webhook" | "secret") => (v.error?.section === section ? <Flash kind="error">{v.error.message}</Flash> : null);
  return (
    <>
      {v.notice ? <Flash kind="ok">{v.notice}</Flash> : null}

      {v.newKey ? (
        <Panel tone="warn" title="Your new API key">
          <div role="status" class="stack">
            <p class="muted small">Copy it now. It won't be shown again.</p>
            <div class="well keybox mono" id="new-api-key">
              {v.newKey}
            </div>
            <button type="button" class="btn2 btn-sm" data-copy={v.newKey} data-select="#new-api-key">
              Copy
            </button>
          </div>
        </Panel>
      ) : null}

      <Panel title="API keys">
        <DataTable
          label="API keys"
          rows={v.keys}
          empty={<EmptyState title="No API keys yet" action={<a href="#new-key" class="btn2 btn-sm"><span aria-hidden="true">+</span> New API key</a>}>Create one to call the API from your server.</EmptyState>}
          columns={[
            { head: "Label", cell: (k) => k.label ?? "—" },
            { head: "Key id", mono: true, nowrap: true, cell: (k) => k.id },
            { head: "Created", cell: (k) => <span class="muted">{utc(k.created_at)}</span> },
            { head: "Status", cell: (k) => <span class="muted">{k.revoked_at ? `Revoked ${utc(k.revoked_at)}` : "Active"}</span> },
            {
              head: "Revoke",
              cell: (k) =>
                k.revoked_at ? (
                  <span class="muted">—</span>
                ) : (
                  <form method="post" action="/admin/developers/keys/revoke" class="form" data-passkey-confirm="key.revoke">
                    <Csrf token={v.csrf} />
                    <input type="hidden" name="id" value={k.id} />
                    <PasskeyConfirm />
                    <button type="submit" class="btn2 btn-sm">
                      Revoke
                    </button>
                  </form>
                ),
            },
          ]}
        />
      </Panel>

      <Panel title="New API key" id="new-key">
        {err("keys")}
        <form method="post" action="/admin/developers/keys" class="form" data-passkey-confirm="key.create">
          <Csrf token={v.csrf} />
          <Field label="Label" name="label" maxlength={64} required placeholder="shop-prod" hint="Shown in the list so you can tell keys apart." />
          <PasskeyConfirm />
          <button type="submit" class="btn cta">
            Create key
          </button>
        </form>
      </Panel>

      <Panel title="Webhooks">
        <p class="muted small">Where invoice and payment events are POSTed. Leave blank to send none.</p>
        {err("webhook")}
        <form method="post" action="/admin/developers/webhook" class="form">
          <Csrf token={v.csrf} />
          <Field label="Webhook URL" name="url" type="url" mono value={v.typedUrl ?? v.webhookUrl} placeholder="https://shop.example.com/webhooks/0crypto" autocomplete="off" />
          <button type="submit" class="btn cta">
            Save webhook URL
          </button>
        </form>
        <form method="post" action="/admin/developers/webhook/test" class="form">
          <Csrf token={v.csrf} />
          <button type="submit" class="btn2" disabled={v.webhookUrl === ""}>
            Send test event
          </button>
        </form>
        {v.testResult ? <WebhookTestResult {...v.testResult} /> : null}
      </Panel>

      <Panel title="Webhook secret">
        <p class="muted small">Your server checks each delivery with this secret (the 0crypto-signature header).</p>
        {err("secret")}
        {v.secret ? (
          <div class="form">
            <div class="well mono keybox" id="webhook-secret">
              {v.secret}
            </div>
            <button type="button" class="btn2 btn-sm" data-copy={v.secret} data-select="#webhook-secret">
              Copy
            </button>
          </div>
        ) : (
          <p class="muted small">
            <span class="mono" aria-hidden="true">
              ••••••••••••••••
            </span>{" "}
            Hidden until you reveal it.
          </p>
        )}
        <div class="actions">
          {v.secret ? null : (
            <form method="post" action="/admin/developers/webhook/reveal" class="form" data-passkey-confirm="webhook.rotate">
              <Csrf token={v.csrf} />
              <PasskeyConfirm />
              <button type="submit" class="btn2">
                Reveal secret
              </button>
            </form>
          )}
          <form method="post" action="/admin/developers/webhook/rotate" class="form" data-passkey-confirm="webhook.rotate">
            <Csrf token={v.csrf} />
            {v.workerSecret ? <p class="small muted">{WORKER_SECRET_NOTE}</p> : <PasskeyConfirm />}
            <button type="submit" class="btn2" disabled={v.workerSecret}>
              Rotate secret
            </button>
          </form>
        </div>
        <p class="small muted">{ROTATE_NOTE}</p>
      </Panel>
    </>
  );
}

type Status = 200 | 400 | 403 | 409;

async function render(c: Ctx, status: Status, o: Omit<View, "keys" | "csrf" | "webhookUrl" | "workerSecret"> & { webhookUrl?: string } = {}) {
  const view: View = {
    ...o,
    keys: await listKeys(c.env.DB),
    csrf: c.get("csrf"),
    webhookUrl: o.webhookUrl ?? c.env.WEBHOOK_URL ?? "",
    workerSecret: webhookSecretFromWorker(c.env),
  };
  return adminPage(
    c,
    {
      title: "Developers",
      active: "developers",
      scripts: ["/admin.js"],
      actions: (
        <a href="#new-key" class="btn">
          <span aria-hidden="true">+</span> New API key
        </a>
      ),
    },
    <DevelopersPage {...view} />,
    status,
  );
}

export function registerDevelopers(app: Hono<AdminEnv>): void {
  app.get("/keys", (c) => c.redirect("/admin/developers", 301));

  app.get("/developers", (c) => render(c, 200));

  app.post("/developers/keys", async (c) => {
    const form = await c.req.parseBody();
    const label = formStr(form, "label").trim().slice(0, 64);
    if (!label) return render(c, 400, { error: { section: "keys", message: "Enter a label for the key." } });
    const problem = await confirmProblem(c, form, "key.create");
    if (problem) return render(c, 403, { error: { section: "keys", message: problem } });
    return render(c, 200, { newKey: await createApiKey(c.env.DB, label) });
  });

  app.post("/developers/keys/revoke", async (c) => {
    const form = await c.req.parseBody();
    const problem = await confirmProblem(c, form, "key.revoke");
    if (problem) return render(c, 403, { error: { section: "keys", message: problem } });
    const id = formStr(form, "id");
    if (/^[0-9a-f]{16}$/.test(id)) {
      const { results } = await c.env.DB.prepare("SELECT hash FROM api_keys WHERE substr(hash,1,16)=? AND revoked_at IS NULL").bind(id).all<{ hash: string }>();
      // Revoke only when the id is unambiguous.
      if (results.length === 1) await c.env.DB.prepare("UPDATE api_keys SET revoked_at=? WHERE hash=?").bind(Date.now(), results[0]!.hash).run();
    }
    return c.redirect("/admin/developers", 303);
  });

  app.post("/developers/webhook", async (c) => {
    const form = await c.req.parseBody();
    const url = formStr(form, "url");
    const welcome = fromWelcome(form);
    try {
      await saveSettings(c.env, { WEBHOOK_URL: url });
    } catch (e) {
      if (e instanceof SettingsError) {
        const error = { section: "webhook" as const, message: e.message };
        return welcome ? renderWelcomeDone(c, 400, { error, typedUrl: url }) : render(c, 400, { error, typedUrl: url });
      }
      throw e;
    }
    return c.redirect(welcome ? "/admin/welcome?step=done" : "/admin/developers", 303);
  });

  app.post("/developers/webhook/test", async (c) => {
    const welcome = fromWelcome(await c.req.parseBody());
    const url = c.env.WEBHOOK_URL ?? "";
    if (url === "") {
      const error = { section: "webhook" as const, message: "Save a webhook URL first." };
      return welcome ? renderWelcomeDone(c, 400, { error }) : render(c, 400, { error });
    }
    const testResult = await sendTestEvent(c.env, url, Date.now());
    return welcome ? renderWelcomeDone(c, 200, { testResult }) : render(c, 200, { testResult });
  });

  // `from` is a bound field like any other: an assertion made for the wizard's reveal form passes only with from=welcome.
  app.post("/developers/webhook/reveal", async (c) => {
    const form = await c.req.parseBody();
    const welcome = fromWelcome(form);
    const problem = await confirmProblem(c, form, "webhook.rotate");
    if (problem) {
      const error = { section: "secret" as const, message: problem };
      return welcome ? renderWelcomeDone(c, 403, { error }) : render(c, 403, { error });
    }
    return welcome ? renderWelcomeDone(c, 200, { secret: c.env.WEBHOOK_SECRET }) : render(c, 200, { secret: c.env.WEBHOOK_SECRET });
  });

  app.post("/developers/webhook/rotate", async (c) => {
    if (webhookSecretFromWorker(c.env)) return render(c, 409, { error: { section: "secret", message: WORKER_SECRET_NOTE } });
    const problem = await confirmProblem(c, await c.req.parseBody(), "webhook.rotate");
    if (problem) return render(c, 403, { error: { section: "secret", message: problem } });
    const secret = "whsec_" + (await rotateWebhookKey(c.env.DB));
    clearSettingsCache(); // this isolate uses the new key from the next request on
    return render(c, 200, { secret, notice: "Webhook secret rotated. Update your server with the new secret." });
  });
}
