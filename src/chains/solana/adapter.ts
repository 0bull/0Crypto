import { base58 } from "@scure/base";
import { formatDecimal } from "../../core/money";
import { getAsset } from "../../core/assets";
import type { AssetId, AssetInfo, ChainAdapter, DepositTarget, Observation } from "../../core/types";
import type { Env } from "../../env";
import { solDepositAddress } from "../../signing/addresses";
import { TOKEN_PROGRAM } from "./pda";
import { solRpc } from "./rpc";

export type Commitment = "confirmed" | "finalized";
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** A random 32-byte Solana Pay `reference` (base58), generated once per payment. */
export function newSolReference(): string {
  return base58.encode(crypto.getRandomValues(new Uint8Array(32)));
}

export interface TokenAccounts {
  /** Initialized accounts of the mint owned by `owner`: the only ones the owner can move (credited and swept). `pubkey` is
   * as the node gave it ("" if absent), not validated. */
  live: { pubkey: string; amount: bigint }[];
  /** Sum held in frozen accounts of the mint owned by `owner`: never credited, never sweepable. */
  frozen: bigint;
}

/**
 * The owner's token accounts of `mint` (legacy SPL Token program). Every account is re-checked here; the RPC's filters
 * are not trusted. Used by the adapter (what is credited) and the sweeper (what is moved), so the two always agree.
 */
export async function tokenAccounts(rpc: ReturnType<typeof solRpc>, owner: string, mint: string, commitment: Commitment): Promise<TokenAccounts> {
  const r = await rpc.call("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment }]);
  const list = isObj(r) ? r.value : undefined;
  if (!Array.isArray(list)) throw new Error("solana: getTokenAccountsByOwner returned no account list");
  const out: TokenAccounts = { live: [], frozen: 0n };
  for (const item of list as unknown[]) {
    const account = isObj(item) && isObj(item.account) ? item.account : undefined;
    const data = account && isObj(account.data) ? account.data : undefined;
    const parsed = data && isObj(data.parsed) ? data.parsed : undefined;
    const info = parsed && isObj(parsed.info) ? parsed.info : undefined;
    // Ignored, not trusted: wrong program, mint or token-account owner (or data the node could not parse).
    if (!account || account.owner !== TOKEN_PROGRAM || !info || info.mint !== mint || info.owner !== owner) continue;
    if (parsed!.type !== "account" || (info.state !== "initialized" && info.state !== "frozen")) continue;
    const amount = isObj(info.tokenAmount) ? info.tokenAmount.amount : undefined;
    const valid = typeof amount === "string" && /^\d+$/.test(amount);
    // Only live accounts count: a frozen USDC account cannot be moved by its owner, so the sweeper could never collect
    // it; crediting it would credit funds that cannot be swept. Its amount is only reported (to alerts).
    if (info.state === "frozen") {
      if (valid) out.frozen += BigInt(amount);
      continue;
    }
    if (!valid) throw new Error("solana: malformed token amount");
    // The address is not needed to credit; the sweeper refuses one that is not a 32-byte base58 address.
    const pubkey = isObj(item) && typeof item.pubkey === "string" ? item.pubkey : "";
    out.live.push({ pubkey, amount: BigInt(amount) });
  }
  return out;
}

/** An account's lamports (0 for an account that does not exist). */
export async function solBalance(rpc: ReturnType<typeof solRpc>, addr: string, commitment: Commitment): Promise<bigint> {
  const r = await rpc.call("getBalance", [addr, { commitment }]);
  const v = isObj(r) ? r.value : undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("solana: getBalance returned a malformed balance");
  return BigInt(v);
}

/**
 * Solana adapter. Observation is balance-based: SOL via getBalance, USDC as the sum of the deposit's token accounts of
 * the mint. `received` is read at `confirmed`, `final` at `finalized` (only when `confirmed` holds some; received is
 * never below final). So a transfer with or without the Solana Pay reference counts the same, and no signature list is
 * needed (txids is empty).
 */
export function solanaAdapter(env: Env, timeoutMs?: number): ChainAdapter {
  const rpc = solRpc(env, timeoutMs);

  const lamports = (addr: string, commitment: Commitment) => solBalance(rpc, addr, commitment);

  /** Sum of the owner's live token accounts of `mint`. */
  async function tokenSum(owner: string, mint: string, commitment: Commitment): Promise<bigint> {
    return (await tokenAccounts(rpc, owner, mint, commitment)).live.reduce((n, a) => n + a.amount, 0n);
  }

  return {
    chain: "sol",

    async deriveAddress(index: number): Promise<string> {
      return solDepositAddress(env.MASTER_SEED ?? "", index);
    },

    async observe(t: DepositTarget, asset: AssetInfo): Promise<Observation> {
      const usdc = getAsset("sol:usdc");
      const read = (a: AssetInfo, c: Commitment) => (a.id === usdc.id ? tokenSum(t.address, usdc.contract!, c) : lamports(t.address, c));
      // The other asset at the address, display-only, read in parallel. A failure must not block crediting: omit `unexpected`.
      const other = asset.id === usdc.id ? getAsset("sol:sol") : usdc;
      const [confirmed, stray] = await Promise.all([
        read(asset, "confirmed"),
        read(other, "confirmed").catch((e: unknown) => {
          console.warn(`solana: ${other.id} read failed for ${t.address}: ${e instanceof Error ? e.message : String(e)}`);
          return 0n;
        }),
      ]);
      // Nothing of the payment's asset at confirmed (an empty or swept address): the finalized read is skipped. A
      // confirmed or swept payment keeps its credit regardless: step's monotone guard ignores a lower observation.
      const finalized = confirmed === 0n ? 0n : await read(asset, "finalized");
      const out: Observation = { received: confirmed > finalized ? confirmed : finalized, final: finalized, txids: [] };
      if (stray > 0n) out.unexpected = { [other.id as AssetId]: stray };
      return out;
    },

    paymentUri(t: DepositTarget, asset: AssetInfo, amount: bigint): string {
      const q = [`amount=${encodeURIComponent(formatDecimal(amount, asset.decimals))}`];
      if (asset.contract) q.push(`spl-token=${encodeURIComponent(asset.contract)}`);
      if (t.reference) q.push(`reference=${encodeURIComponent(t.reference)}`);
      if (URL.canParse(env.PUBLIC_URL)) q.push(`label=${encodeURIComponent(new URL(env.PUBLIC_URL).host)}`);
      return `solana:${t.address}?${q.join("&")}`;
    },
  };
}
