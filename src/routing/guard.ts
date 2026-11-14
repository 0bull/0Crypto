import { base58 } from "@scure/base";
import { EVM_CHAINS, RAILGUN_PROXY, WRAPPED_NATIVE, isEvmChain } from "../chains/evm/config";
import { tronBase58ToHex, tronHexToBase58 } from "../chains/tron/address";
import { accountFromSeed, deriveUtxoAddress } from "../chains/utxo/derive";
import type { UtxoChain } from "../chains/utxo/networks";
import { chainAssets, getAsset } from "../core/assets";
import type { ChainId } from "../core/types";
import type { Env } from "../env";
import { evmHotAddress, solHotAddress, tronDepositAddress, tronHotAddress } from "../signing/addresses";
import type { ShieldNote, ShieldRequest } from "./railgun/note";

/*
 * The spending guard. Every signature the gateway makes goes through a signer module in src/signing/ (nothing else
 * under src/ may call a signing primitive: test/node/signing-primitives.test.ts). A signer derives the destinations
 * of the exact bytes it is about to sign and refuses, before signing, unless each one is covered by an Allowed proof
 * on the same chain for the same address. Proofs are minted here and only here (allowedDestination), for:
 *   hot      this chain's hot wallet (EVM, Tron, Solana)
 *   factory  EVM: the ForwarderFactory of the hot wallet (its forwarders only ever pay the hot wallet)
 *   weth     EVM: the chain's official wrapped-native contract
 *   railgun  EVM: the chain's RailgunSmartWallet proxy. As minted by allowedDestination it covers an approve spender
 *            only; a shield needs one minted by allowedShield, which binds { asset, amount } and the shield note
 *            (receiver RAILGUN_0ZK_ADDRESS, random, IVs): requireShield rebuilds the request from it and the calldata
 *            must carry exactly that one request
 *   energy   Tron: our own deposit at ctx.depositIndex, when a Tron payment row has that index and address. The Tron
 *            signer lets it cover only the sweep top-up: a TransferContract of exactly TOPUP_SUN from the hot wallet
 *   swap     the depositAddress of a leg of route batch ctx.batchId while the batch is `executing`, on the chain of
 *            the batch's asset, and only while that leg is claimed for sending (step `sending`, written by the swap
 *            executor's compare-and-set before it mints) and has no tx yet; binds { asset, amount } from the leg
 *   change   UTXO: our own deposit-chain address at ctx.changeIndex, for a routing spend's change: the address must
 *            re-derive from MASTER_SEED at that index (routed mode: never with an xpub), the chain's derivation counter
 *            must already have allocated it, it must be recorded in own_addresses as a change address (written in
 *            the same transaction as its allocation, src/routing/own.ts), and no payment may use that index
 *   refund   the to_address of approved, unsent, not cancelled refund ctx.refundId, consumed atomically (once only); binds
 *            { asset, amount }: the payment's asset and the refund's amount
 * A bound proof (swap, refund) covers a tx only if the tx pays that address exactly that amount of that asset, once,
 * and nothing else (requirePays), and only ONE tx: on Tron and Solana it is spent by its first use; on EVM it is
 * bound to its first (chainId, from, nonce), so a fee-bump replacement at that nonce may be signed and nothing else.
 * Anything else throws DestinationNotAllowed. A proof is a frozen object registered in a module-private WeakSet:
 * one built or copied anywhere else is not a proof (isAllowed).
 */

export type DestinationKind = "hot" | "railgun" | "swap" | "refund" | "factory" | "weth" | "energy" | "change";
export type Destination = { kind: DestinationKind; chain: ChainId; address: string; ref?: string; asset?: string; amount?: bigint; shield?: ShieldNote };
declare const BRAND: unique symbol;
/** A minted proof. The brand keeps object literals from type-checking; the WeakSet is what is enforced. */
export type Allowed = Readonly<Destination> & { readonly [BRAND]: true };
export interface GuardCtx {
  batchId?: string;
  refundId?: string;
  /** Tron only: the derivation index of the deposit a TRX top-up pays. */
  depositIndex?: number;
  /** UTXO only: the freshly allocated derivation index a routing spend's change output pays. */
  changeIndex?: number;
}
export type GuardEnv = Pick<Env, "MASTER_SEED"> & Partial<Pick<Env, "DB" | "RAILGUN_0ZK_ADDRESS" | "BTC_XPUB" | "LTC_XPUB" | "DOGE_XPUB">>;

export class DestinationNotAllowed extends Error {
  override name = "DestinationNotAllowed";
  constructor(
    readonly chain: string,
    reason: string,
  ) {
    super(`destination not allowed on ${chain}: ${reason}`);
  }
}

const minted = new WeakSet<object>();
/** Bound (swap, refund) proofs that already covered a Tron or Solana tx: single-use. */
const spent = new WeakSet<object>();
/** Bound proofs that covered an EVM tx, by the (chainId, from, nonce) they were first used at: fee bumps re-sign it. */
const evmSlot = new WeakMap<object, string>();

/** True only for a proof minted by allowedDestination (not a copy, not a look-alike). */
export const isAllowed = (p: unknown): p is Allowed => typeof p === "object" && p !== null && minted.has(p);

function mint(d: Destination): Allowed {
  const p = Object.freeze({ ...d }) as Allowed;
  minted.add(p);
  return p;
}

const UTXO = new Set<ChainId>(["btc", "ltc", "doge"]);

/**
 * The address as proofs record it, or DestinationNotAllowed. EVM: 0x + 40 hex, lowercase (checksum-insensitive).
 * Tron: base58check of a 0x41 address, canonical form only. Solana: base58 of 32 bytes, canonical form only. UTXO:
 * as-is (non-empty, no whitespace), bech32 lowercased. Lightning and anything else: never.
 */
export function normalizeDestination(chain: ChainId, address: string): string {
  const no = (why: string): never => {
    throw new DestinationNotAllowed(chain, why);
  };
  if (typeof address !== "string") return no("not an address");
  if (isEvmChain(chain)) return /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : no("not a 20-byte hex address");
  if (chain === "tron") {
    try {
      if (tronHexToBase58(tronBase58ToHex(address)) === address) return address;
    } catch {
      // falls through
    }
    return no("not a Tron base58check address");
  }
  if (chain === "sol") {
    try {
      const b = base58.decode(address);
      if (b.length === 32 && base58.encode(b) === address) return address;
    } catch {
      // falls through
    }
    return no("not a 32-byte base58 address");
  }
  if (UTXO.has(chain)) return address.length > 0 && !/\s/.test(address) ? (/^(bc|ltc)1/i.test(address) ? address.toLowerCase() : address) : no("not an address");
  return no("no destination is ever allowed on this chain");
}

/** The proofs in `proofs` that are minted and for `chain`. */
export const proofsFor = (proofs: readonly unknown[], chain: ChainId): Allowed[] => proofs.filter((p): p is Allowed => isAllowed(p) && p.chain === chain);

/**
 * The proof covering `address` on `chain` with one of `kinds`, or DestinationNotAllowed, ignoring any amount binding:
 * for destinations that receive no value of their own (a contract called, an approve spender, a Solana ATA owner).
 * Value-moving destinations go through requirePays.
 */
export function requireProof(proofs: readonly unknown[], chain: ChainId, address: string, kinds: readonly DestinationKind[], what = "destination"): Allowed {
  const a = normalizeDestination(chain, address);
  const hit = proofsFor(proofs, chain).find((p) => p.address === a && kinds.includes(p.kind));
  if (!hit) throw new DestinationNotAllowed(chain, `${what} ${address} is not covered by an allowed proof (${kinds.join("/")})`);
  return hit;
}

/** This chain's fixed destinations: hot wallet (and on EVM the factory, wrapper and Railgun proxy). */
async function fixed(env: GuardEnv, chain: ChainId): Promise<Destination[]> {
  if (isEvmChain(chain)) {
    const [hot, { factoryAddress }] = await Promise.all([evmHotAddress(env), import("../chains/evm/predict")]);
    return [
      { kind: "hot", chain, address: hot.toLowerCase() },
      { kind: "factory", chain, address: factoryAddress(hot).toLowerCase() },
      { kind: "weth", chain, address: WRAPPED_NATIVE[chain].toLowerCase() },
      { kind: "railgun", chain, address: RAILGUN_PROXY[chain].toLowerCase() },
    ];
  }
  if (chain === "tron") return [{ kind: "hot", chain, address: tronHotAddress(env.MASTER_SEED ?? "") }];
  if (chain === "sol") return [{ kind: "hot", chain, address: solHotAddress(env.MASTER_SEED ?? "") }];
  return [];
}

type Leg = { depositAddress?: unknown; depositMemo?: unknown; amount?: unknown; tx?: unknown; step?: unknown };
const DECIMAL = /^(0|[1-9]\d*)$/;

/**
 * The leg of an executing batch that pays `to` and is claimed for sending (step `sending`, no tx): exactly one, or
 * none (ambiguity fails closed). Legs in any other step (quoted, traded, abandoned, sent, ...) are never paid.
 */
async function batchLeg(env: GuardEnv, chain: ChainId, to: string, batchId: string): Promise<Destination | null> {
  if (!env.DB) return null;
  const row = await env.DB.prepare("SELECT asset, legs, status FROM route_batches WHERE id=?").bind(batchId).first<{ asset: string; legs: string; status: string }>();
  if (!row || row.status !== "executing") return null;
  let assetChain: ChainId;
  let legs: unknown;
  try {
    assetChain = getAsset(row.asset).chain;
    legs = JSON.parse(row.legs);
  } catch {
    return null;
  }
  if (assetChain !== chain || !Array.isArray(legs)) return null;
  const hits: Destination[] = [];
  for (const leg of legs as Leg[]) {
    if (typeof leg !== "object" || leg === null || typeof leg.depositAddress !== "string") continue;
    let a: string;
    try {
      a = normalizeDestination(chain, leg.depositAddress);
    } catch {
      continue;
    }
    if (a !== to || leg.step !== "sending") continue;
    // Already sent, a memo-tagged deposit (a plain transfer cannot carry it) or no exact amount: never allowed.
    if (leg.tx !== undefined && leg.tx !== null && leg.tx !== "") return null;
    if (leg.depositMemo !== undefined && leg.depositMemo !== null && leg.depositMemo !== "") return null;
    if (typeof leg.amount !== "string" || !DECIMAL.test(leg.amount)) return null;
    hits.push({ kind: "swap", chain, address: a, ref: batchId, asset: row.asset, amount: BigInt(leg.amount) });
  }
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * The refund's address, consumed: one UPDATE checks id, address, chain, approved, unsent and unconsumed and sets
 * consumed_at, so two concurrent uses cannot both succeed.
 */
async function refund(env: GuardEnv, chain: ChainId, to: string, refundId: string): Promise<Destination | null> {
  if (!env.DB) return null;
  const addr = isEvmChain(chain) ? "lower(to_address)" : "to_address";
  const r = await env.DB.prepare(
    `UPDATE refunds SET consumed_at=?1 WHERE id=?2 AND ${addr}=?3 AND approved_at IS NOT NULL AND tx IS NULL AND consumed_at IS NULL AND cancelled_at IS NULL
       AND EXISTS (SELECT 1 FROM payments p WHERE p.id=refunds.payment_id AND p.chain=?4)
     RETURNING amount, payment_id`,
  )
    .bind(Date.now(), refundId, to, chain)
    .first<{ amount: string; payment_id: string }>();
  if (!r) return null;
  const p = await env.DB.prepare("SELECT asset FROM payments WHERE id=?").bind(r.payment_id).first<{ asset: string }>();
  if (!p || typeof r.amount !== "string" || !DECIMAL.test(r.amount)) throw new DestinationNotAllowed(chain, `refund ${refundId} has no exact amount or asset`);
  return { kind: "refund", chain, address: to, ref: refundId, asset: p.asset, amount: BigInt(r.amount) };
}

/** A Tron deposit top-up target: re-derived from the index and recorded as a Tron payment with that index. */
async function topupTarget(env: GuardEnv, to: string, index: number): Promise<boolean> {
  if (!env.DB || !Number.isInteger(index) || index < 0 || index >= 0x80000000) return false;
  if (tronDepositAddress(env.MASTER_SEED ?? "", index) !== to) return false;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM payments WHERE chain='tron' AND derivation_index=? AND address=? LIMIT 1").bind(index, to).first<{ ok: number }>();
  return row !== null;
}

/**
 * A routing spend's change target: our own deposit-chain address at `index` (re-derived from MASTER_SEED; never in
 * watch mode), already allocated by the chain's derivation counter and used by no payment.
 * Why this is enough: the change output pays our own key, so the worst a caller can do with this proof is send change
 * to an index of ours that something else also uses. Payments are excluded here. The other allocations of the
 * counter are the swap executor's own: sendUtxo allocates a fresh index for each change output right before it
 * mints (never reusing one), and refund addresses get their own allocation; a reused own index would only weaken
 * privacy, never lose funds. The allocation's purpose is recorded: own_addresses.purpose must be 'change'.
 */
async function changeTarget(env: GuardEnv, chain: UtxoChain, to: string, index: number): Promise<boolean> {
  if (!env.DB || !Number.isInteger(index) || index < 0 || index >= 0x80000000) return false;
  if (env[`${chain.toUpperCase() as "BTC" | "LTC" | "DOGE"}_XPUB`]) return false;
  if (normalizeDestination(chain, deriveUtxoAddress(accountFromSeed(env.MASTER_SEED ?? "", chain), chain, index)) !== to) return false;
  const counter = await env.DB.prepare("SELECT next FROM derivation_counters WHERE chain=?").bind(chain).first<{ next: number }>();
  if (!counter || index >= counter.next) return false;
  const used = await env.DB.prepare("SELECT 1 AS ok FROM payments WHERE chain=? AND derivation_index=? LIMIT 1").bind(chain, index).first<{ ok: number }>();
  if (used !== null) return false;
  const own = await env.DB.prepare("SELECT 1 AS ok FROM own_addresses WHERE chain=? AND address=? AND derivation_index=? AND purpose='change'").bind(chain, to, index).first<{ ok: number }>();
  return own !== null;
}

/** The registry asset of `chain` paid by a transfer of `contract` (null: the native coin), or null if unknown. */
export function assetOf(chain: ChainId, contract: string | null): string | null {
  const want = contract === null ? null : isEvmChain(chain) ? contract.toLowerCase() : contract;
  const hit = chainAssets(chain).find((a) => (want === null ? !a.contract : (isEvmChain(chain) ? a.contract?.toLowerCase() : a.contract) === want));
  return hit?.id ?? null;
}

/** One payment a signer derived from the bytes it is about to sign. */
export interface Pay {
  address: string;
  kinds: readonly DestinationKind[];
  what: string;
  /** Registry asset id paid (null: not a transfer of value, e.g. an approve, or an unknown token). */
  asset: string | null;
  amount: bigint | null;
  /** Tron only: the tx is the sweep top-up (TransferContract of exactly TOPUP_SUN from the hot wallet). */
  topup?: boolean;
}

/**
 * Every pay must be covered by a minted proof on `chain` for its address with one of its kinds, and that proof's
 * binding must hold: energy only for the top-up; swap and refund only when that address is paid exactly once in the
 * tx, with the proof's asset and amount. Throws DestinationNotAllowed otherwise.
 */
export function requirePays(proofs: readonly unknown[], chain: ChainId, pays: readonly Pay[], evm?: { slot: string }): void {
  const valid = proofsFor(proofs, chain);
  const norm = pays.map((p) => normalizeDestination(chain, p.address));
  const bound: Allowed[] = [];
  const usable = (p: Allowed) => (evm ? (evmSlot.get(p) ?? evm.slot) === evm.slot : !spent.has(p));
  pays.forEach((pay, i) => {
    const a = norm[i]!;
    const times = norm.filter((x) => x === a).length;
    const candidates = valid.filter((p) => p.address === a && pay.kinds.includes(p.kind));
    if (candidates.length === 0) throw new DestinationNotAllowed(chain, `${pay.what} ${pay.address} is not covered by an allowed proof (${pay.kinds.join("/")})`);
    const exact = (p: Allowed) => {
      if (p.kind === "energy") return pay.topup === true;
      if (p.kind === "swap" || p.kind === "refund") return times === 1 && pay.asset !== null && pay.asset === p.asset && pay.amount !== null && pay.amount === p.amount;
      return true;
    };
    const fits = candidates.filter(exact);
    if (fits.length === 0) throw new DestinationNotAllowed(chain, `${pay.what} ${pay.address}: the tx does not pay exactly what its proof allows`);
    const unbound = fits.find((p) => p.kind !== "swap" && p.kind !== "refund");
    if (unbound) return;
    const fresh = fits.find(usable);
    if (!fresh) throw new DestinationNotAllowed(chain, `${pay.what} ${pay.address}: its proof was already used for another transaction`);
    bound.push(fresh);
  });
  // Only once every pay is covered: a refused tx uses nothing up.
  for (const p of bound) {
    if (evm) evmSlot.set(p, evm.slot);
    else spent.add(p);
  }
}

/**
 * A proof that `to` may be paid on `chain`, or DestinationNotAllowed (see the module comment for what is allowed).
 * Fixed destinations are checked first, so a refund is consumed only when its address is not one of them.
 */
export async function allowedDestination(env: GuardEnv, chain: ChainId, to: string, ctx: GuardCtx = {}): Promise<Allowed> {
  const a = normalizeDestination(chain, to);
  const f = (await fixed(env, chain)).find((d) => d.address === a);
  if (f) return mint(f);
  if (chain === "tron" && ctx.depositIndex !== undefined && (await topupTarget(env, a, ctx.depositIndex)))
    return mint({ kind: "energy", chain, address: a, ref: String(ctx.depositIndex) });
  if (UTXO.has(chain) && ctx.changeIndex !== undefined && (await changeTarget(env, chain as UtxoChain, a, ctx.changeIndex)))
    return mint({ kind: "change", chain, address: a, ref: String(ctx.changeIndex) });
  if (ctx.batchId !== undefined) {
    const d = await batchLeg(env, chain, a, ctx.batchId);
    if (d) return mint(d);
  }
  if (ctx.refundId !== undefined) {
    const d = await refund(env, chain, a, ctx.refundId);
    if (d) return mint(d);
  }
  throw new DestinationNotAllowed(chain, `${to} is not a hot wallet, routing target, change address or approved refund`);
}

const UINT120_MAX = (1n << 120n) - 1n;

/**
 * A railgun proof for one shield of `amount` of `asset` (an ERC-20 of `chain`, or its native coin, shielded as the
 * pinned wrapper) to RAILGUN_0ZK_ADDRESS, and the ShieldRequest it allows. The note (fresh random and IVs, see
 * routing/railgun/note.ts newShieldNote) is bound into the proof: the EVM signer rebuilds the request from it with its
 * own shield key and signs only a shield of exactly that request (requireShield). The address must decode, have a
 * valid viewing key and, if it names a chain, name this one.
 * The receiver is always env.RAILGUN_0ZK_ADDRESS: no caller can name another one.
 */
export async function allowedShield(env: GuardEnv, chain: ChainId, asset: string, amount: bigint, shieldPrivateKey: Uint8Array): Promise<{ proof: Allowed; request: ShieldRequest }> {
  const no = (why: string): never => {
    throw new DestinationNotAllowed(chain, why);
  };
  if (!isEvmChain(chain)) return no("only EVM chains shield to Railgun");
  let token: string | undefined;
  try {
    const a = getAsset(asset);
    token = a.chain === chain && !a.detectionOnly ? (a.contract ?? WRAPPED_NATIVE[chain]) : undefined;
  } catch {
    token = undefined;
  }
  if (!token) return no(`asset ${asset} is not an asset of ${chain}`);
  if (typeof amount !== "bigint" || amount <= 0n || amount > UINT120_MAX) return no("the shield amount must be in (0, 2^120)");
  const [{ validateRailgunDestination }, { newShieldNote }] = await Promise.all([import("./railgun/address"), import("./railgun/note")]);
  const receiver = env.RAILGUN_0ZK_ADDRESS ?? "";
  try {
    validateRailgunDestination(receiver, { type: 0, id: EVM_CHAINS[chain].chainId });
  } catch (e) {
    return no(`RAILGUN_0ZK_ADDRESS is not a Railgun address for ${chain}: ${e instanceof Error ? e.message : "invalid"}`);
  }
  const { note, request } = await newShieldNote(receiver, token as `0x${string}`, amount, shieldPrivateKey);
  const proof = mint({ kind: "railgun", chain, address: RAILGUN_PROXY[chain].toLowerCase(), asset, amount, shield: note });
  return { proof, request };
}

/**
 * A shield(ShieldRequest[]) to `to` is allowed only if it carries exactly one request, and a minted shield proof for
 * `to` on `chain` (allowedShield) binds it: the bound receiver is `receiver` (the signer's env.RAILGUN_0ZK_ADDRESS, as
 * it is now), the request's npk is poseidon(mpk of it, bound random), its
 * token is the bound ERC-20 (type 0, sub id 0), its value the bound amount, and the whole request equals the one the
 * bound note rebuilds under `shieldPrivateKey` (ciphertext included). The proof is single-use like a swap or refund
 * proof: bound to the first (chainId, from, nonce) it covers. Throws DestinationNotAllowed otherwise.
 */
export async function requireShield(
  proofs: readonly unknown[],
  chain: ChainId,
  to: string,
  requests: readonly ShieldRequest[],
  shieldPrivateKey: Uint8Array,
  evm: { slot: string },
  receiver: string | undefined,
): Promise<void> {
  const no = (why: string): never => {
    throw new DestinationNotAllowed(chain, why);
  };
  if (requests.length !== 1) return no(`a shield must carry exactly one ShieldRequest, not ${requests.length}`);
  const r = requests[0]!;
  const a = normalizeDestination(chain, to);
  const candidates = proofsFor(proofs, chain).filter((p) => p.kind === "railgun" && p.address === a && p.shield !== undefined);
  if (candidates.length === 0) return no(`shield target ${to} is not covered by a shield proof (allowedShield)`);
  const { notePublicKey, sameShieldRequest, shieldRequestFor } = await import("./railgun/note");
  let why = "";
  for (const p of candidates) {
    const n = p.shield!;
    const t = r.preimage.token;
    if (!receiver || n.receiver0zk !== receiver) why ||= "its receiver is not RAILGUN_0ZK_ADDRESS";
    else if (r.preimage.npk.toLowerCase() !== notePublicKey(n.receiver0zk, n.random)) why ||= "its npk is not poseidon(mpk of RAILGUN_0ZK_ADDRESS, the bound random)";
    else if (t.tokenType !== 0 || t.tokenSubID !== 0n || t.tokenAddress.toLowerCase() !== n.token) why ||= "its token is not the bound ERC-20";
    else if (r.preimage.value !== p.amount || n.value !== p.amount) why ||= "its value is not the bound amount";
    else if (!sameShieldRequest(r, await shieldRequestFor(n, shieldPrivateKey))) why ||= "the request does not match the bound note";
    else if ((evmSlot.get(p) ?? evm.slot) !== evm.slot) why ||= "its proof was already used for another transaction";
    else {
      evmSlot.set(p, evm.slot);
      return;
    }
  }
  no(`shield to ${to}: ${why}`);
}
