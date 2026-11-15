import type { Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { createInvoice } from "../api/invoices";
import type { Env } from "../env";
import { effectiveEnv, saveSettings, SettingsError } from "../settings";
import { page } from "../web/layout";
import { AuthShell, Csrf, PasskeyConfirm } from "./layout";
import type { AdminEnv } from "./layout";
import { Field, Flash, WebhookTestResult } from "./ui";
import {
  assetField,
  CHAIN_LABEL,
  DOCS_URL,
  OwnWalletNote,
  KEPT_ON,
  lockedCoin,
  firstAddresses,
  firstAddressText,
  OFFERABLE,
  saveWallets,
  usedChains,
  UsedWallet,
  type Utxo,
} from "./settings";

/*
 * The first-run wizard (claim redirects to /admin/welcome). The Overview's setup checklist (checklist.ts) links its
 * open items to these steps.
 *
 *   shop  → POST /admin/welcome/shop saves MERCHANT_NAME (session and CSRF only, like Settings → Shop).
 *   coins → POST /admin/welcome/coins is the Settings wallets save (saveWallets, a "settings.wallets" passkey
 *           confirmation bound to this path), with only the xpub fields, the Dogecoin Blockbook URL and the coins.
 *   done  → the webhook secret (reveal posts to the Developers handler with from=welcome, which renders this step with
 *           the secret: a redirect would lose it, and it never goes in a URL), the webhook URL and test event (also
 *           Developers handlers, from=welcome), and a $1 test invoice that opens checkout in a new tab.
 *
 * Every step can be skipped; everything it sets can be changed later in Settings and Developers.
 */

type Ctx = Context<AdminEnv>;
type Step = "shop" | "coins" | "done";
const STEPS: { id: Step; label: string }[] = [
  { id: "shop", label: "Your shop" },
  { id: "coins", label: "Coins" },
  { id: "done", label: "Done" },
];
const stepHref = (s: Step) => `/admin/welcome?step=${s}`;

// ---------- the wizard ----------

function Wizard(props: { step: Step; children?: Child }) {
  const n = STEPS.findIndex((s) => s.id === props.step) + 1;
  return (
    <AuthShell title="Welcome" step={{ n, of: STEPS.length, label: STEPS[n - 1]!.label, labels: STEPS.map((s) => s.label) }} scripts={["/admin.js"]}>
      {props.children}
    </AuthShell>
  );
}

const ErrorLine = (props: { message?: string }) => (props.message ? <Flash kind="error">{props.message}</Flash> : null);

const Skip = (props: { to: Step | "admin" }) => (
  <p class="auth-links small">
    <a href={props.to === "admin" ? "/admin" : stepHref(props.to)}>Skip for now</a>
  </p>
);

function ShopStep(props: { env: Env; csrf: string; origin: string; error?: string; typed?: string }) {
  return (
    <Wizard step="shop">
      <h1 class="auth-title">Your shop</h1>
      <form method="post" action="/admin/welcome/shop" class="form">
        <Csrf token={props.csrf} />
        <ErrorLine message={props.error} />
        <Field label="Shop name" name="MERCHANT_NAME" value={props.typed ?? props.env.MERCHANT_NAME ?? ""} maxlength={64} hint="Shown to customers on checkout." />
        <div class="field">
          <p class="stat-label">Public URL</p>
          <p class="well mono pad">{props.env.PUBLIC_URL || props.origin}</p>
          <p class="hint">Checkout links use this address.</p>
        </div>
        <button type="submit" class="btn cta">
          Save and continue
        </button>
      </form>
      <Skip to="coins" />
    </Wizard>
  );
}

/** The wallets the wizard asks for: the xpub of each UTXO chain, and Dogecoin's Blockbook URL (it needs one). */
const WALLETS: { chain: Utxo; name: string; xpub: "BTC_XPUB" | "LTC_XPUB" | "DOGE_XPUB"; hint: string }[] = [
  { chain: "btc", name: "Bitcoin", xpub: "BTC_XPUB", hint: "Your wallet's account xpub or zpub." },
  { chain: "ltc", name: "Litecoin", xpub: "LTC_XPUB", hint: "Your wallet's account Ltub or zpub." },
  { chain: "doge", name: "Dogecoin", xpub: "DOGE_XPUB", hint: "Your wallet's account dgub. Dogecoin also needs a Blockbook URL." },
];

type CoinsView = {
  env: Env;
  csrf: string;
  used: Set<string>;
  firstAddresses: Partial<Record<Utxo, string>>;
  saved?: boolean;
  error?: string;
  typed?: Record<string, string>;
  typedAssets?: Set<string>;
};

/** The xpub (and for Dogecoin the Blockbook URL) of a UTXO coin, and the first address it derives. */
function WalletFields(props: { w: (typeof WALLETS)[number]; v: CoinsView; val: (k: string) => string }) {
  const { w, v, val } = props;
  const addr = v.firstAddresses[w.chain];
  const used = v.used.has(w.chain);
  return (
    <div class="wallet-set">
      <Field label={`${w.name} account xpub`} name={w.xpub} value={val(w.xpub)} mono readonly={used} hint={w.hint} autocomplete="off" />
      {used ? <UsedWallet /> : null}
      {w.chain === "doge" ? <Field label="Blockbook URL" name="DOGE_BLOCKBOOK_URL" value={val("DOGE_BLOCKBOOK_URL")} hint="Required for Dogecoin." autocomplete="off" /> : null}
      {addr ? <p class="well mono small pad">{firstAddressText(addr)}</p> : null}
    </div>
  );
}

function CoinsStep(v: CoinsView) {
  const val = (k: string) => v.typed?.[k] ?? ((v.env[k as keyof Env] as string | undefined) ?? "");
  const stored = new Set(v.env.ENABLED_ASSETS.split(",").map((s) => s.trim()).filter(Boolean));
  const enabled = v.typedAssets ?? stored;
  const shown = new Set<Utxo>();
  return (
    <Wizard step="coins">
      <h1 class="auth-title">Coins</h1>
      <p class="muted small">
        Paste each wallet's account extended public key (xpub, zpub, Ltub, dgub) and tick the coins to accept. The gateway only watches addresses; it
        never holds these coins' keys.
      </p>
      <OwnWalletNote />
      {v.saved ? <Flash kind="ok">Wallets and coins saved.</Flash> : null}
      <form method="post" action="/admin/welcome/coins" class="form" data-passkey-confirm="settings.wallets">
        <Csrf token={v.csrf} />
        <ErrorLine message={v.error} />
        <div class="coin-list">
          {OFFERABLE.map((a) => {
            // As on Settings: UTXO coins are configured on this form, so they stay tickable; the rest need routed mode.
            // A locked box is never posted: it shows what is stored, and the save keeps it.
            const locked = lockedCoin(v.env, a);
            const on = locked ? stored.has(a.id) : enabled.has(a.id);
            // The wallet fields of a UTXO coin sit in its row (the first coin of its chain carries them).
            const w = WALLETS.find((x) => x.chain === a.chain && !shown.has(x.chain));
            if (w) shown.add(w.chain);
            return (
              <div class={locked ? "coin-opt is-locked" : "coin-opt"}>
                <label class="check">
                  <input type="checkbox" name={assetField(a.id)} value="on" checked={on} disabled={locked} />
                  {a.symbol} on {CHAIN_LABEL[a.chain] ?? a.chain}
                </label>
                {locked ? (
                  <p class="small muted">
                    {on ? `${KEPT_ON} ` : null}
                    <a href={DOCS_URL}>Advanced: see docs</a>
                  </p>
                ) : null}
                {w ? <WalletFields w={w} v={v} val={val} /> : null}
              </div>
            );
          })}
          {WALLETS.filter((w) => !shown.has(w.chain)).map((w) => (
            <div class="coin-opt">
              <p class="check">{w.name}</p>
              <WalletFields w={w} v={v} val={val} />
            </div>
          ))}
        </div>
        <PasskeyConfirm />
        <button type="submit" class="btn cta">
          Save wallets and coins
        </button>
      </form>
      {v.saved ? (
        <a class="btn2" href={stepHref("done")}>
          Continue
        </a>
      ) : (
        <Skip to="done" />
      )}
    </Wizard>
  );
}

export type DoneView = {
  /** The revealed webhook secret (only in the response to a confirmed reveal; never in a URL). */
  secret?: string;
  error?: { section: "secret" | "webhook" | "invoice"; message: string };
  testResult?: { status: number; error: string | null };
  typedUrl?: string;
};

function DoneStep(v: DoneView & { csrf: string; webhookUrl: string }) {
  const err = (section: "secret" | "webhook" | "invoice") => <ErrorLine message={v.error?.section === section ? v.error.message : undefined} />;
  return (
    <Wizard step="done">
      <h1 class="auth-title">You're ready</h1>

      <section class="auth-sec" aria-labelledby="done-secret">
        <h2 id="done-secret">Webhook secret</h2>
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
          <form method="post" action="/admin/developers/webhook/reveal" class="form" data-passkey-confirm="webhook.rotate">
            <Csrf token={v.csrf} />
            <input type="hidden" name="from" value="welcome" />
            <PasskeyConfirm />
            <button type="submit" class="btn2">
              Reveal secret
            </button>
          </form>
        )}
      </section>

      <section class="auth-sec" aria-labelledby="done-webhook">
        <h2 id="done-webhook">Webhook URL</h2>
        <p class="muted small">Optional: where invoice and payment events are POSTed.</p>
        {err("webhook")}
        <form method="post" action="/admin/developers/webhook" class="form">
          <Csrf token={v.csrf} />
          <input type="hidden" name="from" value="welcome" />
          <Field label="URL" name="url" type="url" value={v.typedUrl ?? v.webhookUrl} placeholder="https://shop.example.com/webhooks/0crypto" autocomplete="off" />
          <button type="submit" class="btn2">
            Save webhook URL
          </button>
        </form>
        <form method="post" action="/admin/developers/webhook/test" class="form">
          <Csrf token={v.csrf} />
          <input type="hidden" name="from" value="welcome" />
          <button type="submit" class="btn2" disabled={v.webhookUrl === ""}>
            Send test event
          </button>
        </form>
        {v.testResult ? <WebhookTestResult {...v.testResult} /> : null}
      </section>

      <section class="auth-sec" aria-labelledby="done-try">
        <h2 id="done-try">Try a payment</h2>
        {err("invoice")}
        <form method="post" action="/admin/welcome/test-invoice" target="_blank" class="form">
          <Csrf token={v.csrf} />
          <button type="submit" class="btn cta">
            Create a $1 test invoice
          </button>
        </form>
        <p class="hint">Opens the checkout page in a new tab.</p>
      </section>

      <p class="auth-links small">
        <a href="/admin">Go to the dashboard</a>
      </p>
    </Wizard>
  );
}

/** The done step; also the response of the Developers reveal, webhook URL and test handlers when posted with from=welcome. */
export function renderWelcomeDone(c: Ctx, status: 200 | 400 | 403, v: DoneView = {}): Response {
  return page(c, <DoneStep {...v} csrf={c.get("csrf")} webhookUrl={c.env.WEBHOOK_URL ?? ""} />, status);
}

async function renderCoins(c: Ctx, status: 200 | 400 | 403, o: Omit<CoinsView, "env" | "csrf" | "used" | "firstAddresses"> & { env?: Env; firstAddresses?: CoinsView["firstAddresses"] } = {}) {
  const env = o.env ?? c.env;
  return page(
    c,
    <CoinsStep {...o} env={env} csrf={c.get("csrf")} used={await usedChains(c.env.DB)} firstAddresses={o.firstAddresses ?? firstAddresses(env)} />,
    status,
  );
}

const renderShop = (c: Ctx, status: 200 | 400, o: { error?: string; typed?: string } = {}) =>
  page(c, <ShopStep env={c.env} csrf={c.get("csrf")} origin={new URL(c.req.url).origin} {...o} />, status);

const str = (form: Record<string, unknown>, k: string): string | undefined => (typeof form[k] === "string" ? (form[k] as string) : undefined);

export function registerWelcome(app: Hono<AdminEnv>): void {
  app.get("/welcome", (c) => {
    // The step by name, or by its number in "Step n of 3".
    const q = c.req.query("step");
    const step = q === "2" ? "coins" : q === "3" ? "done" : q;
    if (step === "coins") return renderCoins(c, 200);
    if (step === "done") return renderWelcomeDone(c, 200);
    return renderShop(c, 200);
  });

  app.post("/welcome/shop", async (c) => {
    const name = str(await c.req.parseBody(), "MERCHANT_NAME") ?? "";
    try {
      await saveSettings(c.env, { MERCHANT_NAME: name });
    } catch (e) {
      if (e instanceof SettingsError) return renderShop(c, 400, { error: e.message, typed: name });
      throw e;
    }
    return c.redirect(stepHref("coins"), 303);
  });

  app.post("/welcome/coins", async (c) => {
    const form = await c.req.parseBody();
    const r = await saveWallets(c, form);
    if (!r.ok)
      return renderCoins(c, r.status, {
        error: r.error,
        typed: Object.fromEntries(Object.entries(form).filter((e): e is [string, string] => typeof e[1] === "string" && /^(BTC|LTC|DOGE)_/.test(e[0]))),
        typedAssets: new Set(OFFERABLE.filter((a) => str(form, assetField(a.id)) !== undefined).map((a) => a.id)),
      });
    // This request's env predates the save; re-read it (the save dropped the cache).
    return renderCoins(c, 200, { env: await effectiveEnv(c.env), firstAddresses: r.firstAddresses, saved: true });
  });

  // Opens in a new tab (the form's target): a $1 invoice through the same path as the API and the New invoice page.
  app.post("/welcome/test-invoice", async (c) => {
    const r = await createInvoice(c.env, { price_amount: "1.00", price_currency: "USD", order_id: "test" });
    if ("error" in r) return renderWelcomeDone(c, 400, { error: { section: "invoice", message: r.error } });
    return c.redirect(`/i/${r.invoice.id}`, 303);
  });
}
