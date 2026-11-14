import type { HDKey } from "@scure/bip32";
import type { Env } from "../env";
import { isValidMnemonic, normalizeMnemonic } from "../core/mnemonic";
import type { ChainAdapter, ChainId } from "../core/types";
import { evmAdapter } from "./evm/adapter";
import { lightningAdapter } from "./lightning/adapter";
import { nwcUriProblem } from "./lightning/nwc";
import { EVM_CHAINS, isEvmChain, rpcUrls } from "./evm/config";
import { solanaAdapter } from "./solana/adapter";
import { solRpcUrls } from "./solana/rpc";
import { tronAdapter } from "./tron/adapter";
import { utxoAdapter } from "./utxo/adapter";
import { blockbook } from "./utxo/blockbook";
import { accountFromSeed, accountFromXpub } from "./utxo/derive";
import { esplora, withFallback, type UtxoExplorer } from "./utxo/esplora";
import type { UtxoChain } from "./utxo/networks";

/** The env keys chain configuration reads. Empty strings count as unset. */
export type ChainEnv = Partial<
  Pick<
    Env,
    | "MASTER_SEED"
    | "ALLOW_SEED_CUSTODY"
    | "BTC_XPUB"
    | "LTC_XPUB"
    | "DOGE_XPUB"
    | "BTC_XPUB_START_INDEX"
    | "LTC_XPUB_START_INDEX"
    | "DOGE_XPUB_START_INDEX"
    | "DOGE_BLOCKBOOK_URL"
    | "EVM_RPC_ETH"
    | "EVM_RPC_BASE"
    | "EVM_RPC_ARB"
    | "EVM_RPC_POLYGON"
    | "EVM_RPC_BSC"
    | "TRONGRID_API_KEY"
    | "TRON_API_URL"
    | "SOLANA_RPC_URL"
    | "NWC_URI"
  >
>;

const SEED_INVALID = "MASTER_SEED is not a valid BIP39 mnemonic";
const SEED_UNSET = "MASTER_SEED is not set";
/** Why MASTER_SEED cannot be used to derive keys, or null. Blank (a deploy that left the secret empty) is "not set". */
const seedProblem = (env: ChainEnv): string | null => (!env.MASTER_SEED ? SEED_UNSET : isValidMnemonic(env.MASTER_SEED) ? null : SEED_INVALID);
const isUtxo = (chain: ChainId): chain is UtxoChain => chain === "btc" || chain === "ltc" || chain === "doge";
const upper = (chain: UtxoChain) => chain.toUpperCase() as "BTC" | "LTC" | "DOGE";
const xpubOf = (env: ChainEnv, chain: UtxoChain): string | undefined => env[`${upper(chain)}_XPUB`] || undefined;

/** Tron is routed-only: the deposit keys and hot wallet derive from MASTER_SEED, and TronGrid needs an API key. */
function tronConfigError(env: ChainEnv): string | null {
  if (env.ALLOW_SEED_CUSTODY !== "true") return `ALLOW_SEED_CUSTODY="true" is required for Tron (deposit keys are derived from MASTER_SEED)`;
  if (!env.TRONGRID_API_KEY) return "set TRONGRID_API_KEY (a TronGrid API key)";
  const seed = seedProblem(env);
  if (seed) return seed;
  if (env.TRON_API_URL) {
    let https = false;
    try {
      https = new URL(env.TRON_API_URL).protocol === "https:";
    } catch {
      // not a URL
    }
    if (!https) return "TRON_API_URL must be an https URL";
  }
  return null;
}

/** Solana is routed-only: deposit keys and the hot wallet derive from MASTER_SEED; SOLANA_RPC_URL holds https URLs (secret). */
function solConfigError(env: ChainEnv): string | null {
  if (env.ALLOW_SEED_CUSTODY !== "true") return `ALLOW_SEED_CUSTODY="true" is required for Solana (deposit keys are derived from MASTER_SEED)`;
  const urls = solRpcUrls(env);
  if (urls.length === 0) return "set SOLANA_RPC_URL (a Solana JSON-RPC URL, comma-separate fallbacks)";
  // The value is a secret: the message never quotes it.
  if (!urls.every((u) => URL.canParse(u) && new URL(u).protocol === "https:")) return "SOLANA_RPC_URL must contain only https URLs";
  // Credentials in the URL would leak through fetch errors; put the key in the path or query instead.
  if (urls.some((u) => new URL(u).username !== "" || new URL(u).password !== "")) return "SOLANA_RPC_URL must not contain a username or password";
  return seedProblem(env);
}

/**
 * Why a chain cannot be used with this configuration, or null if it can. Watch mode (`<CHAIN>_XPUB`) is the
 * default; deriving from MASTER_SEED (routed mode, the Worker holds keys) needs ALLOW_SEED_CUSTODY="true".
 */
export function chainConfigError(env: ChainEnv, chain: ChainId): string | null {
  if (isEvmChain(chain)) {
    // The hot wallet always derives from MASTER_SEED, so EVM needs the custody opt-in even with an RPC URL.
    if (env.ALLOW_SEED_CUSTODY !== "true")
      return `ALLOW_SEED_CUSTODY="true" is required for EVM chains (the hot wallet is derived from MASTER_SEED)`;
    if (rpcUrls(env, chain).length === 0) return `set ${EVM_CHAINS[chain].rpcVar} (a JSON-RPC URL, comma-separate fallbacks)`;
    return seedProblem(env);
  }
  if (chain === "tron") return tronConfigError(env);
  if (chain === "sol") return solConfigError(env);
  // Lightning: a parseable NWC_URI (wss relays, 64-hex secret and wallet pubkey). Whether the wallet allows
  // make_invoice and lookup_invoice is checked with get_info (lightningCapabilities), not here: this stays pure.
  if (chain === "ln") return nwcUriProblem(env.NWC_URI);
  if (!isUtxo(chain)) return `no adapter for chain: ${chain}`;
  if (!xpubOf(env, chain) && env.ALLOW_SEED_CUSTODY !== "true")
    return `set ${upper(chain)}_XPUB (watch mode) or ALLOW_SEED_CUSTODY="true" (routed mode, keys held by the Worker)`;
  if (chain === "doge" && !env.DOGE_BLOCKBOOK_URL) return "DOGE_BLOCKBOOK_URL is required to enable dogecoin";
  if (!xpubOf(env, chain)) return seedProblem(env);
  return null;
}

/** The derivation-counter key for a chain: every EVM chain shares one counter, so an index maps to one address everywhere. */
export function counterKey(chain: ChainId): ChainId | "evm" {
  return isEvmChain(chain) ? "evm" : chain;
}

/** First derivation index for a chain: `<CHAIN>_XPUB_START_INDEX`, default 0. Throws on a malformed value. */
export function startIndex(env: ChainEnv, chain: ChainId): number {
  if (!isUtxo(chain)) return 0;
  const name = `${upper(chain)}_XPUB_START_INDEX` as const;
  const raw = env[name]?.trim();
  if (!raw) return 0;
  // BIP32 non-hardened indexes stop at 2^31 - 1.
  if (!/^\d{1,10}$/.test(raw) || Number(raw) > 0x7fffffff) throw new Error(`${name} must be an integer from 0 to 2147483647`);
  return Number(raw);
}

const accountCache = new Map<string, HDKey>();

/** Watch mode when `<CHAIN>_XPUB` is set, otherwise routed mode from MASTER_SEED (opt-in). Cached per isolate. */
function account(env: Env, chain: UtxoChain): HDKey {
  const xpub = xpubOf(env, chain);
  const key = xpub ? `${chain}:xpub:${xpub}` : `${chain}:seed:${normalizeMnemonic(env.MASTER_SEED ?? "")}`;
  let a = accountCache.get(key);
  if (!a) {
    a = xpub ? accountFromXpub(xpub, chain) : accountFromSeed(env.MASTER_SEED ?? "", chain);
    accountCache.set(key, a);
  }
  return a;
}

/** The chain's explorer (with the default fallback): reads, raw txs and broadcasts. */
export function utxoExplorer(env: Env, chain: UtxoChain): UtxoExplorer {
  return explorerFor(env, chain);
}

function explorerFor(env: Env, chain: UtxoChain): UtxoExplorer {
  switch (chain) {
    case "btc":
      return withFallback(
        esplora(env.BTC_ESPLORA_URL || "https://mempool.space/api"),
        env.BTC_ESPLORA_URL ? undefined : esplora("https://blockstream.info/api"),
      );
    case "ltc":
      return withFallback(esplora(env.LTC_ESPLORA_URL || "https://litecoinspace.org/api"));
    case "doge":
      return withFallback(blockbook(env.DOGE_BLOCKBOOK_URL!, env.DOGE_API_KEY || undefined));
  }
}

export function getAdapter(env: Env, chain: ChainId): ChainAdapter {
  const problem = chainConfigError(env, chain);
  if (problem) throw new Error(`${chain} is not configured: ${problem}`);
  if (isEvmChain(chain)) return evmAdapter(env, chain);
  if (chain === "tron") return tronAdapter(env);
  if (chain === "sol") return solanaAdapter(env);
  if (chain === "ln") return lightningAdapter(env);
  const c = chain as UtxoChain;
  return utxoAdapter(c, explorerFor(env, c), account(env, c));
}
