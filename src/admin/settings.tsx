import type { Context, Hono } from "hono";
import { chainConfigError } from "../chains/registry";
import { ASSETS } from "../core/assets";
import type { AssetInfo } from "../core/types";
import type { Env } from "../env";
import { effectiveEnv, firstReceiveAddress, normalizeSetting, publicUrlPinned, saveSettings, SettingsError, type SettingKey } from "../settings";
import { confirmProblem } from "./confirm";
import { adminPage, Csrf, type AdminEnv } from "./layout";
import { Field, Flash, KeyValue, Panel, PasskeyConfirm } from "./ui";

/*
 * The Settings page: shop (name, success-URL hosts; session and CSRF only), the public URL (read-only: it changes only
 * through recovery on the new origin, or by changing the Wrangler var when one pins it), and wallets and coins (xpubs, start indexes, explorer URLs and ENABLED_ASSETS),
 * which decide where money is watched and so need a "settings.wallets" passkey confirmation.
 *
 * Coins are one checkbox per asset, each with its own name `asset:<id>` (value "on"): a confirmation binds form fields
 * last-wins, so a shared name would bind only one ticked coin. Unticked and disabled boxes are not posted, exactly as
 * FormData leaves them out on the client, so the bound set is the ticked set. A coin whose box is locked (its chain
 * needs routed-mode secrets) but that is enabled already stays enabled: the save keeps it without binding it.
 */

type Ctx = Context<AdminEnv>;
export type Utxo = "btc" | "ltc" | "doge";

export const DOCS_URL = "https://github.com/0bull/0Crypto/blob/main/docs/deploy.md";
export const PUBLIC_URL_NOTE = "Moving to a new domain? Open the gateway on the new domain and use “Lost your passkey or moved?”";
/** While a Wrangler var pins PUBLIC_URL, recovery on another origin is refused (rp.ts): only the var can move it. */
export const PUBLIC_URL_PINNED_NOTE = "PUBLIC_URL is set by a Wrangler var, which wins over this page. To move to a new domain, change the var.";

const CHAINS: { chain: Utxo; name: string; xpub: SettingKey; start: SettingKey; explorer: SettingKey; explorerLabel: string; explorerHint: string }[] = [
  { chain: "btc", name: "Bitcoin", xpub: "BTC_XPUB", start: "BTC_XPUB_START_INDEX", explorer: "BTC_ESPLORA_URL", explorerLabel: "Esplora API URL", explorerHint: "Blank uses mempool.space." },
  { chain: "ltc", name: "Litecoin", xpub: "LTC_XPUB", start: "LTC_XPUB_START_INDEX", explorer: "LTC_ESPLORA_URL", explorerLabel: "Esplora API URL", explorerHint: "Blank uses litecoinspace.org." },
  { chain: "doge", name: "Dogecoin", xpub: "DOGE_XPUB", start: "DOGE_XPUB_START_INDEX", explorer: "DOGE_BLOCKBOOK_URL", explorerLabel: "Blockbook URL", explorerHint: "Required for Dogecoin." },
];
const WALLET_FIELDS: SettingKey[] = CHAINS.flatMap((c) => [c.xpub, c.start, c.explorer]);
export const UTXO_CHAINS = new Set<string>(CHAINS.map((c) => c.chain));

/** Every asset that can be offered for payment, in ASSETS order (detection-only TRX is never one). */
export const OFFERABLE: AssetInfo[] = Object.values(ASSETS).filter((a) => !a.detectionOnly);

export const assetField = (id: string): string => `asset:${id}`;

export const CHAIN_LABEL: Record<string, string> = {
  btc: "Bitcoin", ltc: "Litecoin", doge: "Dogecoin", eth: "Ethereum", base: "Base", arb: "Arbitrum", polygon: "Polygon", bsc: "BNB Chain", tron: "Tron", sol: "Solana", ln: "Lightning",
};

export const firstAddressText = (addr: string) => `First receive address: ${addr}. Check this matches the first address in your wallet.`;

/** A coin whose box is disabled: its chain is not usable and is not configured on this form (routed mode, see docs). */
export const lockedCoin = (env: Env, a: AssetInfo): boolean => chainConfigError(env, a.chain) !== null && !UTXO_CHAINS.has(a.chain);
export const KEPT_ON = "Kept on; configure under Advanced.";
const enabledSet = (env: Env): Set<string> => new Set(env.ENABLED_ASSETS.split(",").map((s) => s.trim()).filter(Boolean));

/** Chains with a payment row: their wallet can no longer change (settings.ts refuses it too). */
export async function usedChains(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT DISTINCT chain FROM payments WHERE chain IN ('btc','ltc','doge')").all<{ chain: string }>();
  return new Set(results.map((r) => r.chain));
}

/** First receive addresses of the chains that have an xpub in `env`; a chain whose xpub or index does not parse is left out. */
export function firstAddresses(env: Env): Partial<Record<Utxo, string>> {
  const out: Partial<Record<Utxo, string>> = {};
  for (const c of CHAINS) {
    const xpub = (env[c.xpub as keyof Env] as string | undefined)?.trim();
    if (!xpub) continue;
    try {
      out[c.chain] = firstReceiveAddress(c.chain, xpub, Number((env[c.start as keyof Env] as string | undefined)?.trim() || "0"));
    } catch {
      /* shown as is; the merchant fixes it on save */
    }
  }
  return out;
}

const str = (form: Record<string, unknown>, k: string): string | undefined => (typeof form[k] === "string" ? (form[k] as string) : undefined);

/**
 * Saves the wallets form (also the wizard's coins step): verifies the "settings.wallets" passkey confirmation over the
 * form's own fields first, then stores the wallet fields present in the form and ENABLED_ASSETS = the ticked
 * `asset:<id>` boxes plus the enabled coins whose box is locked (never posted), in ASSETS order. A ticked coin whose
 * chain is not usable with the new values is refused.
 */
export async function saveWallets(
  c: Ctx,
  form: Record<string, unknown>,
): Promise<{ ok: true; firstAddresses: Partial<Record<Utxo, string>> } | { ok: false; error: string; status: 400 | 403 }> {
  const problem = await confirmProblem(c, form, "settings.wallets");
  if (problem) return { ok: false, error: problem, status: 403 };
  const entries: Partial<Record<SettingKey, string>> = {};
  for (const k of WALLET_FIELDS) {
    const v = str(form, k);
    if (v !== undefined) entries[k] = v;
  }
  const ticked = OFFERABLE.filter((a) => str(form, assetField(a.id)) !== undefined);
  const enabled = enabledSet(c.env);
  entries.ENABLED_ASSETS = OFFERABLE.filter((a) => ticked.includes(a) || (enabled.has(a.id) && lockedCoin(c.env, a)))
    .map((a) => a.id)
    .join(",");
  // The env the save would produce, to check each ticked coin's chain with the new values.
  const next: Record<string, unknown> = { ...c.env };
  try {
    for (const [k, v] of Object.entries(entries)) next[k] = normalizeSetting(k as SettingKey, v);
  } catch (e) {
    if (e instanceof SettingsError) return { ok: false, error: e.message, status: 400 };
    throw e;
  }
  for (const a of ticked) {
    const why = chainConfigError(next as unknown as Env, a.chain);
    if (why) return { ok: false, error: `${a.id} needs more setup: ${why}`, status: 400 };
  }
  try {
    await saveSettings(c.env, entries);
  } catch (e) {
    if (e instanceof SettingsError) return { ok: false, error: e.message, status: 400 };
    throw e;
  }
  return { ok: true, firstAddresses: firstAddresses(next as unknown as Env) };
}

/** Shown under a wallet that has handed out addresses: saveSettings refuses any change to it. */
export const UsedWallet = () => (
  <p class="small muted">
    This wallet has handed out addresses, so it cannot be changed. To use another wallet, set up a new deployment (<a href={DOCS_URL}>see the docs</a>).
  </p>
);

type View = {
  env: Env;
  csrf: string;
  pinned: boolean;
  used: Set<string>;
  firstAddresses?: Partial<Record<Utxo, string>>;
  error?: { section: "shop" | "wallets"; message: string };
  notice?: string;
  /** Values to show instead of the stored ones (a refused form keeps what was typed). */
  typed?: Record<string, string>;
  /** The ticked coins of a refused form. */
  typedAssets?: Set<string>;
};

/** The chain a refused-wallets message is about (it names the coin), so that field can be marked invalid. */
const errorChain = (message: string): Utxo | undefined => CHAINS.find((ch) => message.includes(ch.name) || message.includes(ch.xpub))?.chain;

function SettingsPage(v: View) {
  const val = (k: SettingKey) => v.typed?.[k] ?? ((v.env[k as keyof Env] as string | undefined) ?? "");
  const stored = enabledSet(v.env);
  const enabled = v.typedAssets ?? stored;
  const shopError = v.error?.section === "shop" ? v.error.message : undefined;
  const hostsError = shopError?.startsWith("Success URL") ? shopError : undefined;
  const nameError = hostsError ? undefined : shopError;
  const walletError = v.error?.section === "wallets" ? v.error.message : undefined;
  const walletChain = walletError ? errorChain(walletError) : undefined;
  return (
    <>
      {v.notice ? <Flash kind="ok">{v.notice}</Flash> : null}
      {walletError && !walletChain ? <Flash kind="error">{walletError}</Flash> : null}

      <Panel title="Your shop">
        <form method="post" action="/admin/settings/shop" class="form">
          <Csrf token={v.csrf} />
          <Field label="Shop name" name="MERCHANT_NAME" value={val("MERCHANT_NAME")} maxlength={64} hint="Shown to customers on checkout." error={nameError} autocomplete="off" />
          <button type="submit" class="btn cta">
            Save shop
          </button>
        </form>
      </Panel>

      <Panel title="Public URL">
        <KeyValue rows={[["Address", <span class="mono">{v.env.PUBLIC_URL || "Not set yet"}</span>]]} />
        <p class="small muted">{v.pinned ? PUBLIC_URL_PINNED_NOTE : PUBLIC_URL_NOTE}</p>
      </Panel>

      <form method="post" action="/admin/settings/wallets" class="settings-wallets" data-passkey-confirm="settings.wallets">
        <Csrf token={v.csrf} />
        <Panel title="Coins">
          <p class="muted small">Tick the coins customers can pay with. A coin that needs more setup is greyed out.</p>
          <div class="coin-grid">
            {OFFERABLE.map((a) => {
              const why = chainConfigError(v.env, a.chain);
              // UTXO coins are configured on this form (xpub, explorer), so they stay tickable; the save checks them.
              const locked = lockedCoin(v.env, a);
              // A locked box is never posted: it shows what is stored, and the save keeps it.
              const on = locked ? stored.has(a.id) : enabled.has(a.id);
              return (
                <div class={locked ? "coin-opt is-locked" : "coin-opt"}>
                  <label class="check">
                    <input type="checkbox" name={assetField(a.id)} value="on" checked={on} disabled={locked} />
                    {a.symbol} on {CHAIN_LABEL[a.chain] ?? a.chain}
                  </label>
                  {locked ? (
                    <p class="small muted">
                      {on ? `${KEPT_ON} ` : null}
                      <a href={DOCS_URL}>Advanced: see docs</a>. {why}
                    </p>
                  ) : why ? (
                    <p class="small muted">Needs: {why}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Wallets">
          <p class="muted small">
            Paste each wallet's account extended public key (xpub, zpub, Ltub, dgub). The gateway only watches addresses; it never holds these coins'
            keys.
          </p>
          {CHAINS.map((ch) => {
            const used = v.used.has(ch.chain);
            const addr = v.firstAddresses?.[ch.chain];
            return (
              <fieldset class="wallet-set">
                <legend>{ch.name}</legend>
                <Field label="Account xpub" name={ch.xpub} value={val(ch.xpub)} mono readonly={used} autocomplete="off" error={walletChain === ch.chain ? walletError : undefined} />
                {used ? <UsedWallet /> : null}
                <Field label="Start index" name={ch.start} value={val(ch.start)} inputmode="numeric" readonly={used} hint="The first address index to use (default 0)." autocomplete="off" />
                <Field label={ch.explorerLabel} name={ch.explorer} value={val(ch.explorer)} hint={ch.explorerHint} autocomplete="off" />
                {addr ? <p class="well mono small">{firstAddressText(addr)}</p> : null}
              </fieldset>
            );
          })}
          <PasskeyConfirm />
          <button type="submit" class="btn cta">
            Save wallets and coins
          </button>
        </Panel>
      </form>

      <Panel title="Success URL hosts">
        <form method="post" action="/admin/settings/shop" class="form">
          <Csrf token={v.csrf} />
          <Field
            label="Success URL hosts"
            name="SUCCESS_URL_HOSTS"
            value={val("SUCCESS_URL_HOSTS")}
            placeholder="shop.example.com"
            hint="Hostnames an invoice's success URL may send the customer back to, separated by commas."
            error={hostsError}
            autocomplete="off"
          />
          <button type="submit" class="btn cta">
            Save hosts
          </button>
        </form>
      </Panel>
    </>
  );
}

async function render(c: Ctx, status: 200 | 400 | 403, o: Omit<View, "env" | "csrf" | "pinned" | "used"> & { env?: Env } = {}) {
  const env = o.env ?? c.env;
  const used = await usedChains(c.env.DB);
  return adminPage(
    c,
    { title: "Settings", active: "settings" },
    <SettingsPage {...o} env={env} csrf={c.get("csrf")} pinned={publicUrlPinned(c.env)} used={used} firstAddresses={o.firstAddresses ?? firstAddresses(env)} />,
    status,
  );
}

const typedOf = (form: Record<string, unknown>, keys: SettingKey[]) =>
  Object.fromEntries(keys.flatMap((k) => (typeof form[k] === "string" ? [[k, form[k] as string]] : [])));

export function registerSettings(app: Hono<AdminEnv>): void {
  app.get("/settings", (c) => render(c, 200, { notice: c.req.query("saved") === "shop" ? "Shop settings saved." : undefined }));

  app.post("/settings/shop", async (c) => {
    const form = await c.req.parseBody();
    const entries: Partial<Record<SettingKey, string>> = {};
    for (const k of ["MERCHANT_NAME", "SUCCESS_URL_HOSTS"] as const) {
      const v = str(form, k);
      if (v !== undefined) entries[k] = v;
    }
    try {
      await saveSettings(c.env, entries);
    } catch (e) {
      if (e instanceof SettingsError) return render(c, 400, { error: { section: "shop", message: e.message }, typed: typedOf(form, ["MERCHANT_NAME", "SUCCESS_URL_HOSTS"]) });
      throw e;
    }
    return c.redirect("/admin/settings?saved=shop", 303);
  });

  app.post("/settings/wallets", async (c) => {
    const form = await c.req.parseBody();
    const r = await saveWallets(c, form);
    if (!r.ok)
      return render(c, r.status, {
        error: { section: "wallets", message: r.error },
        typed: typedOf(form, WALLET_FIELDS),
        typedAssets: new Set(OFFERABLE.filter((a) => str(form, assetField(a.id)) !== undefined).map((a) => a.id)),
      });
    // This request's env predates the save; re-read it (the save dropped the cache).
    return render(c, 200, { env: await effectiveEnv(c.env), firstAddresses: r.firstAddresses, notice: "Wallets and coins saved." });
  });
}
