import { accountFromXpub, deriveUtxoAddress } from "./chains/utxo/derive";
import type { UtxoChain } from "./chains/utxo/networks";
import { parseSuccessHosts } from "./api/success-url";
import { getAsset } from "./core/assets";
import type { Env } from "./env";
import { instanceKey, type InstanceKeyName } from "./keys";

/**
 * Configuration edited from the admin and stored in D1 `settings`, so a non-developer never has to touch Wrangler vars.
 * Every entry point runs `effectiveEnv` first; downstream code keeps reading `env.PUBLIC_URL`, `env.SESSION_SECRET`, ...
 */
export const SETTING_KEYS = [
  "MERCHANT_NAME",
  "ENABLED_ASSETS",
  "PUBLIC_URL",
  "WEBHOOK_URL",
  "BTC_XPUB",
  "LTC_XPUB",
  "DOGE_XPUB",
  "BTC_XPUB_START_INDEX",
  "LTC_XPUB_START_INDEX",
  "DOGE_XPUB_START_INDEX",
  "BTC_ESPLORA_URL",
  "LTC_ESPLORA_URL",
  "DOGE_BLOCKBOOK_URL",
  "SUCCESS_URL_HOSTS",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Settings that decide where money goes or how it is seen: the routes ask for a "settings.wallets" passkey confirmation. */
export const WALLET_KEYS: readonly SettingKey[] = [
  "BTC_XPUB",
  "LTC_XPUB",
  "DOGE_XPUB",
  "BTC_XPUB_START_INDEX",
  "LTC_XPUB_START_INDEX",
  "DOGE_XPUB_START_INDEX",
  "BTC_ESPLORA_URL",
  "LTC_ESPLORA_URL",
  "DOGE_BLOCKBOOK_URL",
  "ENABLED_ASSETS",
];

/** A setting that failed validation. `message` is shown to the merchant as is. */
export class SettingsError extends Error {
  constructor(
    readonly key: SettingKey,
    message: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

const isSettingKey = (k: string): k is SettingKey => (SETTING_KEYS as readonly string[]).includes(k);

// ---------- the isolate cache ----------

const CACHE_MS = 30_000;

interface Loaded {
  /** Date.now() when the read started. */
  at: number;
  settings: Map<SettingKey, string>;
  keys: Partial<Record<InstanceKeyName, string>>;
}

let cache: Loaded | null = null;
/** Bumped by clearSettingsCache, so a read that started before a save cannot put the old rows back. */
let generation = 0;

/** Drops this isolate's cached settings and instance keys: the next effectiveEnv reads D1. */
export function clearSettingsCache(): void {
  cache = null;
  generation++;
}

/**
 * The D1 rows, cached per isolate for CACHE_MS. A load in which PUBLIC_URL resolves empty (no Wrangler var and no D1
 * value: a fresh gateway before its first claim) is not cached, so a claim made through another isolate is seen at once.
 */
async function load(db: D1Database, publicUrlVar: boolean): Promise<Loaded> {
  const now = Date.now();
  if (cache && now - cache.at <= CACHE_MS) return cache;
  const gen = generation;
  // One round trip for both tables.
  const [s, k] = await db.batch<{ key: string; value: string }>([
    db.prepare("SELECT key, value FROM settings"),
    db.prepare("SELECT name AS key, value FROM instance_keys"),
  ]);
  const settings = new Map<SettingKey, string>();
  for (const r of s?.results ?? []) if (isSettingKey(r.key)) settings.set(r.key, r.value);
  const keys: Loaded["keys"] = {};
  for (const r of k?.results ?? []) if (r.key === "session" || r.key === "webhook") keys[r.key] = r.value;
  const loaded: Loaded = { at: now, settings, keys };
  if (gen === generation && (publicUrlVar || !!settings.get("PUBLIC_URL"))) cache = loaded;
  return loaded;
}

async function keyOf(l: Loaded, db: D1Database, name: InstanceKeyName): Promise<string> {
  return (l.keys[name] ??= await instanceKey(db, name));
}

/** Envs made by effectiveEnv, and those among them whose PUBLIC_URL is a non-empty Wrangler var (it wins over D1). */
const effective = new WeakSet<Env>();
const pinnedByVar = new WeakSet<Env>();
/** Envs made by effectiveEnv whose WEBHOOK_SECRET is a Worker secret (not the rotatable instance key). */
const webhookByWorker = new WeakSet<Env>();

/**
 * The env every handler sees. For each SETTING_KEYS key: the D1 row when there is one (even an empty value), else the
 * Wrangler var. The one exception is PUBLIC_URL, where a non-empty var wins over D1. A blank SESSION_SECRET or
 * WEBHOOK_SECRET is filled from the instance keys (created on first use). D1 is read at most every 30 s per isolate.
 * Returns a new object; `env` is not changed. Idempotent: given an env it made, it re-reads D1 and keeps where
 * PUBLIC_URL came from (a D1 value there is not mistaken for a var).
 */
export async function effectiveEnv(env: Env): Promise<Env> {
  const pinned = effective.has(env) ? pinnedByVar.has(env) : !!env.PUBLIC_URL;
  const l = await load(env.DB, pinned);
  const o: Partial<Record<SettingKey | "SESSION_SECRET" | "WEBHOOK_SECRET", string>> = {};
  for (const [key, value] of l.settings) {
    if (key === "PUBLIC_URL" && pinned) continue;
    o[key] = value;
  }
  if (!env.SESSION_SECRET) o.SESSION_SECRET = await keyOf(l, env.DB, "session");
  if (!env.WEBHOOK_SECRET) o.WEBHOOK_SECRET = "whsec_" + (await keyOf(l, env.DB, "webhook"));
  // Required strings default to empty, so `.split` and `new URL` callers see a string (an empty PUBLIC_URL is refused where it matters).
  const eff: Env = { ...env, PUBLIC_URL: env.PUBLIC_URL ?? "", ENABLED_ASSETS: env.ENABLED_ASSETS ?? "", ...o };
  effective.add(eff);
  if (pinned) pinnedByVar.add(eff);
  if (webhookSecretFromWorker(env)) webhookByWorker.add(eff);
  return eff;
}

/**
 * Whether WEBHOOK_SECRET is a Worker secret (then it cannot be rotated from the dashboard), for an env made by
 * effectiveEnv. Any other env counts as a Worker secret whenever its WEBHOOK_SECRET is non-empty.
 */
export function webhookSecretFromWorker(env: Env): boolean {
  return webhookByWorker.has(env) || (!!env.WEBHOOK_SECRET && !effective.has(env));
}

/**
 * Whether PUBLIC_URL comes from a non-empty Wrangler var, for an env made by effectiveEnv. Any other env (built by
 * hand, e.g. in a test) counts as pinned whenever its PUBLIC_URL is non-empty: the safe answer, since then a D1 write
 * might not take effect.
 */
export function publicUrlPinned(env: Env): boolean {
  return pinnedByVar.has(env) || (!!env.PUBLIC_URL && !effective.has(env));
}

/**
 * The origin of PUBLIC_URL, or null while it is empty or unparseable (a fresh deploy before the first claim). Origin
 * checks treat null as "every request is cross-origin", so form posts answer 403 instead of throwing.
 */
export function publicOrigin(env: Pick<Env, "PUBLIC_URL">): string | null {
  return env.PUBLIC_URL && URL.canParse(env.PUBLIC_URL) ? new URL(env.PUBLIC_URL).origin : null;
}

// ---------- validation ----------

const UTXO: readonly UtxoChain[] = ["btc", "ltc", "doge"];
const CHAIN_NAME: Record<UtxoChain, string> = { btc: "Bitcoin", ltc: "Litecoin", doge: "Dogecoin" };
const XPUB_KEY = { btc: "BTC_XPUB", ltc: "LTC_XPUB", doge: "DOGE_XPUB" } as const;
const START_KEY = { btc: "BTC_XPUB_START_INDEX", ltc: "LTC_XPUB_START_INDEX", doge: "DOGE_XPUB_START_INDEX" } as const;
const MAX_INDEX = 0x7fffffff;


/** https, or http on a loopback host (local development). Returns the URL object. */
function webUrl(key: SettingKey, raw: string, what: string): URL {
  const u = URL.canParse(raw) ? new URL(raw) : null;
  const loopback = u !== null && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (!u || !(u.protocol === "https:" || (u.protocol === "http:" && loopback)))
    throw new SettingsError(key, `${what} must be an https:// URL (http:// only for localhost).`);
  return u;
}

/** The value to store for `key`, trimmed and normalised. Throws SettingsError. An empty value clears the setting. */
export function normalizeSetting(key: SettingKey, raw: string): string {
  return normalize(key, raw);
}
function normalize(key: SettingKey, raw: string): string {
  const v = raw.trim();
  switch (key) {
    case "MERCHANT_NAME":
      if (v.length > 64) throw new SettingsError(key, "The shop name can be at most 64 characters.");
      return v;
    case "ENABLED_ASSETS": {
      const ids = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      for (const id of ids) {
        try {
          getAsset(id);
        } catch {
          throw new SettingsError(key, `Unknown asset: ${id.slice(0, 40)}`);
        }
      }
      return ids.join(",");
    }
    case "SUCCESS_URL_HOSTS": {
      try {
        return parseSuccessHosts(v).join(",");
      } catch {
        throw new SettingsError(key, "Success URL hosts must be hostnames separated by commas, like shop.example.com.");
      }
    }
    case "PUBLIC_URL":
      // An origin: routes are absolute paths (/admin, /i/...), so a path or trailing slash would only break links.
      return v === "" ? "" : webUrl(key, v, "The public URL").origin;
    case "WEBHOOK_URL":
      if (v !== "") webUrl(key, v, "The webhook URL");
      return v;
    case "BTC_ESPLORA_URL":
    case "LTC_ESPLORA_URL":
    case "DOGE_BLOCKBOOK_URL":
      if (v !== "") webUrl(key, v, "The explorer URL");
      return v;
    case "BTC_XPUB":
    case "LTC_XPUB":
    case "DOGE_XPUB": {
      const chain = key.slice(0, key.indexOf("_")).toLowerCase() as UtxoChain;
      if (v === "") return v;
      try {
        accountFromXpub(v, chain);
      } catch {
        throw new SettingsError(key, `That is not a ${CHAIN_NAME[chain]} account extended public key (xpub/zpub). Copy it from your wallet's account details.`);
      }
      return v;
    }
    case "BTC_XPUB_START_INDEX":
    case "LTC_XPUB_START_INDEX":
    case "DOGE_XPUB_START_INDEX":
      if (v !== "" && (!/^\d{1,10}$/.test(v) || Number(v) > MAX_INDEX)) throw new SettingsError(key, "The start index must be a whole number from 0 to 2147483647.");
      return v;
  }
}

/** Two start-index values mean the same index (empty is the default, 0). */
const sameIndex = (a: string | undefined, b: string | undefined) => Number((a ?? "").trim() || "0") === Number((b ?? "").trim() || "0");

/** The upsert of one setting, for callers that write it inside their own batch (then call clearSettingsCache). */
export function settingUpsert(db: D1Database, key: SettingKey, value: string, now: number): D1PreparedStatement {
  return db
    .prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(key, value, now);
}

/**
 * Validates and stores `entries` in one batch, then drops the isolate cache. Nothing is written when any entry is
 * invalid. A UTXO chain that has handed out addresses keeps its wallet: changing its xpub or start index is refused.
 */
export async function saveSettings(env: Env, entries: Partial<Record<SettingKey, string>>): Promise<void> {
  const rows: [SettingKey, string][] = [];
  for (const [k, raw] of Object.entries(entries)) {
    if (raw === undefined) continue;
    if (!isSettingKey(k)) throw new Error(`unknown setting: ${k}`);
    rows.push([k, normalize(k, raw)]);
  }
  if (rows.length === 0) return;
  const next = new Map(rows);

  const wallet = UTXO.filter((c) => next.has(XPUB_KEY[c]) || next.has(START_KEY[c]));
  if (wallet.length > 0) {
    clearSettingsCache(); // compare with what D1 holds now, not a 30 s old copy
    const cur = await effectiveEnv(env);
    for (const chain of wallet) {
      const xk = XPUB_KEY[chain];
      const sk = START_KEY[chain];
      const changed =
        (next.has(xk) && next.get(xk) !== (cur[xk] ?? "").trim()) || (next.has(sk) && !sameIndex(next.get(sk), cur[sk]));
      if (!changed) continue;
      const used = await env.DB.prepare("SELECT 1 AS x FROM payments WHERE chain=? LIMIT 1").bind(chain).first();
      if (used)
        throw new SettingsError(
          next.has(xk) && next.get(xk) !== (cur[xk] ?? "").trim() ? xk : sk,
          `${CHAIN_NAME[chain]} has already handed out addresses from this wallet, so its wallet cannot be changed. To use another wallet, set up a new deployment (see the docs).`,
        );
    }
  }

  const now = Date.now();
  await env.DB.batch(rows.map(([k, v]) => settingUpsert(env.DB, k, v, now)));
  clearSettingsCache();
}

/** The first receive address (account/0/startIndex) of an account xpub: shown so the merchant can check it in their wallet. */
export function firstReceiveAddress(chain: "btc" | "ltc" | "doge", xpub: string, startIndex: number): string {
  return deriveUtxoAddress(accountFromXpub(xpub, chain), chain, startIndex);
}
