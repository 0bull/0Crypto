import type { Address, Hex, PublicClient } from "viem";
import { RAILGUN_SHIELD_ABI } from "../../chains/evm/abi";
import { EVM_CHAINS, finalTarget, isEvmChain, RAILGUN_PROXY, rpcUrls, WRAPPED_NATIVE, type EvmChain } from "../../chains/evm/config";
import { BUMP_DEN, BUMP_NUM, evmFeeQuote, MAX_COST_PERCENT, type EvmFee } from "../../chains/evm/fees";
import { getAsset } from "../../core/assets";
import { fiatMinorFromAtomic } from "../../core/money";
import type { AssetInfo } from "../../core/types";
import { recordAlert } from "../../db/alerts";
import { MAX_REPLACEMENTS, STUCK_AFTER_MS } from "../../db/sweeps";
import type { Env } from "../../env";
import { getPriceE8 } from "../../prices/cache";
import { evmHotAddress } from "../../signing/addresses";
import { railgunShieldKey, signEvmTx } from "../../signing/evm";
import { errText, isRevert } from "../../sweep/evm";
import { allowedDestination, allowedShield, type Allowed } from "../guard";
import { railgunGate } from "../config";
import { validateRailgunDestination } from "./address";

// viem is imported inside the functions that need it, never at module scope (test/node/startup-imports.test.ts).

/*
 * The Railgun shield executor: moves `amount` of an EVM asset from the hot wallet into RAILGUN_0ZK_ADDRESS.
 *   native coin  WRAPPED_NATIVE.deposit{value}  (only the shortfall: wrapper already held counts), then as an ERC-20
 *   ERC-20       approve(proxy, 0) first when a smaller nonzero allowance is left (USDT on Ethereum requires it), then
 *                approve(proxy, amount) (exactly the amount, never unlimited; skipped when the allowance covers it),
 *                then RailgunSmartWallet.shield([one request]) of exactly `amount`.
 * Railgun takes its 0.25% shield fee on-chain from the shielded value: the receiver gets 99.75% of `amount`.
 *
 * It is a multi-run state machine, one tx per call (like the Tron sweeper): a call settles the tx in flight, if any,
 * and otherwise sends the next step. Waiting for receipts inside one call does not fit a cron run's 20 s budget
 * (three txs on Ethereum are ~40 s at best), and pipelining (n, n+1, n+2 signed at once) cannot estimate the shield
 * before its approve is mined. The router (Task 7) stores the returned progress on the batch row: `persist` is called
 * with the new progress, the tx hash in it, after signing and BEFORE the broadcast (nothing is broadcast unless it
 * returns true), so a crash can never lose a tx and two runs can never send two (its compare-and-set is the lock).
 * Each call re-reads the chain: balances and allowance, pinned to the block of the receipt it just settled.
 *
 * Progress is bound at the first send to { chain, asset, amount, receiver0zk }: a later call for another chain, asset
 * or amount throws ShieldProgressMismatch. A shield only ever goes to env.RAILGUN_0ZK_ADDRESS (allowedShield and
 * signEvmTx take no receiver; the signer compares the note's receiver with env alone). bind.receiver0zk is only a
 * comparison value: when it differs from RAILGUN_0ZK_ADDRESS (the var changed mid-shield, or the progress is forged),
 * nothing new is signed for that progress (no next step, no replacement, no re-broadcast): already-signed hashes are
 * still settled (a mined shield still becomes "shielded"), and routing.stuck is raised. Operator: "RAILGUN_0ZK_ADDRESS
 * changed mid-shield; resolve or abandon" means set the var back to finish the shield, or abandon the batch (the hot
 * wallet keeps whatever was not shielded; any wrapped coin stays as the wrapper). New shields use the new address.
 *
 * Progress is trusted state: Task 7 must keep it only in the D1 batch row, written by the router through `persist`,
 * and never accept a progress (above all a `done` one) it did not write. Done progress short-circuits before every
 * gate (nothing is sent or read), so it stays "shielded" even after RAILGUN_GOLDEN_OK is turned off.
 *
 * Gas reserve contract: GAS_RESERVE[chain] is the gas budget of a routing batch. The caller passes
 * `amount` = hot balance - GAS_RESERVE[chain] for a native coin, fixed once per batch. Before a wrap the executor
 * requires the native coin left after it (balance - wrap value - the wrap's gas) to cover the worst-case gas still to
 * come: approve (twice, with the approve(0), when a partial allowance is left) and the shield, at the current max fee.
 * Otherwise it skips with sweep.insufficient_gas naming the shortfall. On Ethereum at high base fees 0.02 ETH may not
 * cover that: the result is a visible skip (retried next run), never a stranded wrap.
 *
 * Steps advance on a successful receipt; the shield is "shielded" once its receipt is final (finalized, Polygon 64
 * deep). An unmined tx is replaced after STUCK_AFTER_MS at the same nonce with fees x1.3, at most MAX_REPLACEMENTS
 * times (a shield replacement gets a new note: fresh random and IVs; it keeps the original's gas limit, estimate +
 * 20%, which is safe because the calldata has the same shape and length). Each tx's signed bytes are kept in the
 * progress: a run that finds the tx unknown to the node while its nonce is still free re-broadcasts them unchanged
 * first (only if they hash to the latest tx hash), so a transient RPC failure never costs a fee bump. After the last bump a still-unmined tx raises
 * routing.stuck; a tx whose nonce another tx used, unknown to the node, is dropped (failed, routing.failing).
 * Fee caps are the EVM sweep's: fees from evmFeeQuote (2 x base fee + tip; a gas price on BSC), the gas (plus any wrap value) must fit the hot balance (sweep.insufficient_gas), and on Ethereum the gas of
 * every tx sent for this shield must stay under MAX_COST_PERCENT of the shielded value (sweep.too_expensive; no price
 * means no send). Every tx is signed for the chain's id through signEvmTx with a proof per destination: the wrapper
 * (weth), the proxy as approve spender (railgun), and a shield proof binding the note (allowedShield). evmClient only
 * uses RPC URLs that report the chain's id.
 */

const UINT120_MAX = (1n << 120n) - 1n;
const DEPOSIT = "0xd0e30db0";

export class RailgunNotVerified extends Error {
  override name = "RailgunNotVerified";
  constructor(why?: string) {
    super(`Railgun shielding is off until the operator sets RAILGUN_GOLDEN_OK="1" and lists the chain in RAILGUN_GOLDEN_OK_CHAINS after its live shield spike${why ? ` (${why})` : ""}`);
  }
}
export class RailgunConfigError extends Error {
  override name = "RailgunConfigError";
}
/** The progress passed belongs to another shield (chain, asset or amount). */
export class ShieldProgressMismatch extends Error {
  override name = "ShieldProgressMismatch";
}

/** Worst-case gas of an ERC-20 approve and of a one-request Railgun shield, for the reserve check before a wrap. */
const APPROVE_GAS_MAX = 100_000n;
const SHIELD_GAS_MAX = 500_000n;

export type ShieldStep = "deposit" | "approve0" | "approve" | "shield";
/** A tx as (re-)built: strings for bigints, so progress is plain JSON. */
interface Req extends EvmFee {
  to: Address;
  data: Hex;
  value: string;
  gas: string;
  /** When its latest tx was broadcast (unix ms). */
  at: number;
}
export interface ShieldInflight {
  step: ShieldStep;
  nonce: number;
  /** Every hash signed at this nonce (the original, then each replacement). */
  txs: Hex[];
  /** The signed bytes of the latest of them: re-broadcast unchanged when the node has lost it. */
  raw: Hex;
  req: Req;
}
/** What a shield's progress is bound to, from its first send. */
export interface ShieldBinding {
  chain: EvmChain;
  asset: string;
  amount: string;
  receiver0zk: string;
}
/** What the router stores between calls (plain JSON). */
export interface ShieldProgress {
  bind?: ShieldBinding;
  /** Worst-case gas (wei) of every tx sent for this shield, for the mainnet cost cap. */
  costWei: string;
  inflight?: ShieldInflight;
  /** Every tx hash signed for this shield. */
  txs?: Hex[];
  /** The final shield tx, once its receipt is final. */
  done?: Hex;
}
export interface ShieldOptions {
  progress?: ShieldProgress;
  /**
   * Required. Persists the new progress (its tx hash in inflight.txs) before the broadcast, e.g. a compare-and-set on
   * the batch row; false: nothing is broadcast. A throw propagates (nothing is broadcast either).
   */
  persist: (next: ShieldProgress) => Promise<boolean>;
  now?: number;
}
export interface ShieldResult {
  /**
   * sent: a tx was broadcast. waiting: a tx is in flight (or its broadcast failed and it is retried at its nonce).
   * shielded: final. skipped: nothing sent now (gas, cost, balance, price, persist), try again later. failed: a step
   * reverted, was dropped or cannot be estimated; nothing more is sent for this progress.
   */
  status: "sent" | "waiting" | "shielded" | "skipped" | "failed";
  step?: ShieldStep;
  tx?: Hex;
  reason?: string;
  /** Every tx hash signed for this shield so far. */
  txs: Hex[];
  progress: ShieldProgress;
}

interface Ctx {
  env: Env;
  chain: EvmChain;
  asset: AssetInfo;
  amount: bigint;
  client: PublicClient;
  hot: Address;
  /** The ERC-20 shielded: the asset's contract, or the wrapper for the native coin. */
  token: Address;
  proxy: Address;
  /** env.RAILGUN_0ZK_ADDRESS (validated): where every shield note goes. */
  receiver: string;
  now: number;
}

/** The gates, before any network call: golden flag and chain list, chain, asset, amount, receiver address, RPC configured. */
function preflight(env: Env, chain: EvmChain, asset: string, amount: bigint): AssetInfo {
  if (env.RAILGUN_GOLDEN_OK !== "1") throw new RailgunNotVerified();
  if (!isEvmChain(chain)) throw new RailgunConfigError(`${String(chain)} is not an EVM chain`);
  const gate = railgunGate(env, chain);
  if (gate) throw new RailgunNotVerified(gate);
  let info: AssetInfo | null;
  try {
    info = getAsset(asset);
  } catch {
    info = null;
  }
  if (!info || info.chain !== chain || info.detectionOnly) throw new RailgunConfigError(`${asset} is not an asset of ${chain}`);
  if (typeof amount !== "bigint" || amount <= 0n || amount > UINT120_MAX) throw new RangeError("the shield amount must be in (0, 2^120)");
  try {
    validateRailgunDestination(env.RAILGUN_0ZK_ADDRESS ?? "", { type: 0, id: EVM_CHAINS[chain].chainId });
  } catch (e) {
    throw new RailgunConfigError(`RAILGUN_0ZK_ADDRESS is not a Railgun address for ${chain}: ${e instanceof Error ? e.message : "invalid"}`);
  }
  if (rpcUrls(env, chain).length === 0) throw new RailgunConfigError(`${EVM_CHAINS[chain].rpcVar} is not set`);
  return info;
}

/**
 * Advances the shield of `amount` of `asset` on `chain` by one step (see above). Throws RailgunNotVerified or
 * RailgunConfigError (before any network call), and RPC errors (fail closed: nothing is read as zero or success).
 */
export async function shieldOnEvm(env: Env, chain: EvmChain, asset: string, amount: bigint, o: ShieldOptions): Promise<ShieldResult> {
  const progress: ShieldProgress = o.progress ?? { costWei: "0" };
  const b = progress.bind;
  if (b && (b.chain !== chain || b.asset !== asset || typeof amount !== "bigint" || b.amount !== amount.toString()))
    throw new ShieldProgressMismatch(`this progress is for ${b.amount} of ${b.asset} on ${b.chain}, not ${String(amount)} of ${asset} on ${chain}`);
  if (progress.done) return { status: "shielded", tx: progress.done, txs: progress.txs ?? [], progress };
  const info = preflight(env, chain, asset, amount);
  const { evmClient } = await import("../../chains/evm/chains");
  const [client, hot] = await Promise.all([evmClient(env, chain), evmHotAddress(env)]);
  const c: Ctx = { env, chain, asset: info, amount, client, hot, token: (info.contract ?? WRAPPED_NATIVE[chain]) as Address, proxy: RAILGUN_PROXY[chain], receiver: env.RAILGUN_0ZK_ADDRESS!, now: o.now ?? Date.now() };
  // The receiver changed since the first send (or the progress is forged): sign nothing new, settle what is signed.
  const frozen = b !== undefined && b.receiver0zk !== c.receiver;
  if (frozen && !progress.inflight) return result("skipped", progress, { reason: await receiverChanged(c) });
  if (!progress.inflight) return nextStep(c, progress, o);
  const s = await settle(c, progress, o, frozen);
  return "result" in s ? s.result : nextStep(c, s.progress, o, s.block);
}

const RECEIVER_CHANGED = "RAILGUN_0ZK_ADDRESS changed mid-shield; resolve or abandon";
async function receiverChanged(c: Ctx): Promise<string> {
  await recordAlert(c.env.DB, "routing.stuck", c.chain, `a Railgun shield of ${c.asset.id} on ${c.chain}: ${RECEIVER_CHANGED}`, c.now);
  return RECEIVER_CHANGED;
}

const result = (status: ShieldResult["status"], progress: ShieldProgress, extra: Partial<ShieldResult> = {}): ShieldResult => ({ status, ...extra, txs: progress.txs ?? [], progress });

type Receipt = Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
async function receiptOf(client: PublicClient, hash: Hex): Promise<Receipt | null> {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (e) {
    if ((e as Error).name === "TransactionReceiptNotFoundError") return null;
    throw e;
  }
}
async function nodeKnows(client: PublicClient, hash: Hex): Promise<boolean> {
  const r = await (client as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method: "eth_getTransactionByHash", params: [hash] });
  return r !== null && r !== undefined;
}

/** The tx in flight: mined (go on, or done/failed), unmined (wait, replace, or dropped). */
async function settle(c: Ctx, progress: ShieldProgress, o: ShieldOptions, frozen: boolean): Promise<{ result: ShieldResult } | { progress: ShieldProgress; block: bigint }> {
  const f = progress.inflight!;
  // The nonce is read before the receipts: a tx mined in between then shows up as a receipt, never as "dropped".
  const latestNonce = await c.client.getTransactionCount({ address: c.hot, blockTag: "latest" });
  for (const hash of f.txs) {
    const r = await receiptOf(c.client, hash);
    if (!r) continue;
    if (r.status !== "success") return { result: result("failed", { ...progress, inflight: undefined }, { step: f.step, tx: hash, reason: `${f.step} tx ${hash} reverted` }) };
    if (f.step !== "shield") {
      const settled = { ...progress, inflight: undefined };
      if (frozen) return { result: result("waiting", settled, { step: f.step, tx: hash, reason: await receiverChanged(c) }) };
      return { progress: settled, block: r.blockNumber };
    }
    const [fin, head] = await Promise.all([c.client.getBlock({ blockTag: "finalized" }), c.client.getBlockNumber()]);
    const target = fin.number === null ? null : finalTarget(head, fin.number, EVM_CHAINS[c.chain].minDepth);
    if (target === null || r.blockNumber > target) return { result: result("waiting", progress, { step: f.step, tx: hash, reason: "the shield is mined; waiting for finality" }) };
    const done = { ...progress, inflight: undefined, done: hash };
    return { result: result("shielded", done, { step: "shield", tx: hash }) };
  }
  // Within its first hour, nonce still free and the node has lost the latest tx (its broadcast failed, or it was
  // evicted): send the same bytes again, so a transient RPC failure never costs a fee bump. Past the hour the usual
  // replacement takes over (an underpriced tx that keeps being evicted still gets bumped).
  if (frozen) return { result: result("waiting", progress, { step: f.step, reason: await receiverChanged(c) }) };
  const fresh = c.now - f.req.at <= STUCK_AFTER_MS;
  const { keccak256 } = await import("viem");
  const latest = f.txs.at(-1)!;
  if (fresh && latestNonce <= f.nonce && keccak256(f.raw).toLowerCase() === latest.toLowerCase() && !(await nodeKnows(c.client, latest))) {
    try {
      await c.client.sendRawTransaction({ serializedTransaction: f.raw });
    } catch (e) {
      console.warn(`0crypto: railgun ${f.step} on ${c.chain} not re-broadcast: ${e instanceof Error ? e.name : "Error"}`);
    }
  }
  if (fresh) return { result: result("waiting", progress, { step: f.step, reason: `the ${f.step} tx is not mined yet` }) };
  if (latestNonce > f.nonce) {
    // Dropped only if the node knows none of our txs any more; a known one may still be mined.
    for (const h of f.txs) if (await nodeKnows(c.client, h)) return { result: result("waiting", progress, { step: f.step, reason: `the ${f.step} tx is known but not mined yet` }) };
    const reason = `the ${f.step} tx was dropped: its nonce ${f.nonce} was used by another transaction`;
    await recordAlert(c.env.DB, "routing.failing", c.chain, `a Railgun shield ${reason} (${c.asset.id})`, c.now);
    return { result: result("failed", { ...progress, inflight: undefined }, { step: f.step, reason }) };
  }
  if (f.txs.length - 1 >= MAX_REPLACEMENTS) {
    const reason = `the ${f.step} tx is still unmined after ${MAX_REPLACEMENTS} fee bumps (${f.txs.at(-1)})`;
    await recordAlert(c.env.DB, "routing.stuck", c.chain, `a Railgun shield step on ${c.chain}: ${reason}`, c.now);
    return { result: result("waiting", progress, { step: f.step, reason }) };
  }

  // Unmined for an hour and the nonce is still free: replace it at the same nonce with fees x1.3. The gas limit is the
  // original's (a new shield note has the same calldata length and shape, so its estimate + 20% still holds).
  const bump = (v?: string) => (v === undefined ? undefined : ((BigInt(v) * BUMP_NUM) / BUMP_DEN).toString());
  const next: Req = { ...f.req, maxFeePerGas: bump(f.req.maxFeePerGas), maxPriorityFeePerGas: bump(f.req.maxPriorityFeePerGas), gasPrice: bump(f.req.gasPrice), at: c.now };
  let proofs: Allowed[];
  if (f.step === "shield") {
    const s = await shieldCall(c);
    next.data = s.data;
    proofs = s.proofs;
  } else proofs = [await allowedDestination(c.env, c.chain, f.step === "deposit" ? WRAPPED_NATIVE[c.chain] : c.proxy)];
  const cost = (r: Req) => BigInt(r.gas) * BigInt(r.maxFeePerGas ?? r.gasPrice!);
  const why = await affordable(c, cost(next), BigInt(next.value), BigInt(progress.costWei) - cost(f.req) + cost(next), f.step === "deposit" ? await gasToCome(c, next) : 0n);
  if (why) return { result: result("skipped", progress, { step: f.step, reason: why }) };
  return { result: await broadcast(c, progress, f.step, f.nonce, next, proofs, cost(next) - cost(f.req), f.txs, o) };
}

/** shield([request]) calldata for a new note, and the proof that binds it. */
async function shieldCall(c: Ctx): Promise<{ data: Hex; proofs: Allowed[] }> {
  const { encodeFunctionData } = await import("viem");
  const { proof, request } = await allowedShield(c.env, c.chain, c.asset.id, c.amount, await railgunShieldKey(c.env));
  return { data: encodeFunctionData({ abi: RAILGUN_SHIELD_ABI, functionName: "shield", args: [[request]] }), proofs: [proof] };
}

/** Plans and sends the next step from chain state (read at `block` when a receipt was just settled). */
async function nextStep(c: Ctx, progress: ShieldProgress, o: ShieldOptions, block?: bigint): Promise<ShieldResult> {
  const { encodeFunctionData, erc20Abi } = await import("viem");
  const at = block === undefined ? {} : { blockNumber: block };
  const balance = await c.client.readContract({ address: c.token, abi: erc20Abi, functionName: "balanceOf", args: [c.hot], ...at });
  let step: ShieldStep;
  let to: Address = c.token;
  let data: Hex;
  let value = 0n;
  let proofs: Allowed[];
  if (!c.asset.contract && balance < c.amount) {
    step = "deposit";
    to = WRAPPED_NATIVE[c.chain];
    data = DEPOSIT;
    value = c.amount - balance;
    proofs = [await allowedDestination(c.env, c.chain, to)];
  } else if (balance < c.amount) {
    return result("skipped", progress, { reason: `the hot wallet holds ${balance} of ${c.asset.id} on ${c.chain}, the shield needs ${c.amount}` });
  } else {
    const allowance = await c.client.readContract({ address: c.token, abi: erc20Abi, functionName: "allowance", args: [c.hot, c.proxy], ...at });
    if (allowance >= c.amount) {
      step = "shield";
      to = c.proxy;
      ({ data, proofs } = await shieldCall(c));
    } else {
      // A smaller nonzero allowance is reset to 0 first: USDT-style tokens refuse to change a nonzero allowance.
      step = allowance > 0n ? "approve0" : "approve";
      data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.proxy, step === "approve0" ? 0n : c.amount] });
      proofs = [await allowedDestination(c.env, c.chain, c.proxy)];
    }
  }
  let gas: bigint;
  try {
    gas = await c.client.estimateGas({ account: c.hot, to, data, value });
  } catch (e) {
    if (isRevert(e)) return result("failed", progress, { step, reason: `the ${step} tx estimate reverted` });
    throw e;
  }
  const q = await evmFeeQuote(c.client, c.chain, (gas * 12n) / 10n);
  const req: Req = { to, data, value: value.toString(), gas: q.gasLimit.toString(), ...q.fee, at: c.now };
  const why = await affordable(c, q.cost, value, BigInt(progress.costWei) + q.cost, step === "deposit" ? await gasToCome(c, req, at) : 0n);
  if (why) return result("skipped", progress, { step, reason: why });
  const nonce = await c.client.getTransactionCount({ address: c.hot, blockTag: "pending" });
  return broadcast(c, progress, step, nonce, req, proofs, q.cost, [], o);
}

/**
 * What a wrap must leave behind: the worst-case gas of the steps after it at `req`'s max fee: the shield, plus an
 * approve unless the wrapper allowance already covers the amount, plus the approve(0) when a partial one is left.
 */
async function gasToCome(c: Ctx, req: Req, at: { blockNumber?: bigint } = {}): Promise<bigint> {
  const { erc20Abi } = await import("viem");
  const allowance = await c.client.readContract({ address: c.token, abi: erc20Abi, functionName: "allowance", args: [c.hot, c.proxy], ...at });
  const approves = allowance >= c.amount ? 0n : allowance > 0n ? 2n : 1n;
  return (approves * APPROVE_GAS_MAX + SHIELD_GAS_MAX) * BigInt(req.maxFeePerGas ?? req.gasPrice!);
}

/**
 * Why the tx cannot be paid for now (hot balance, keeping `keep` back after it; on Ethereum the 5% cap over `spent`),
 * or null. Alerts (deduped).
 */
async function affordable(c: Ctx, cost: bigint, value: bigint, spent: bigint, keep: bigint): Promise<string | null> {
  const balance = await c.client.getBalance({ address: c.hot });
  if (keep > 0n && cost + value <= balance && balance - cost - value < keep) {
    const left = balance - cost - value;
    const detail = `wrapping ${value} on ${c.chain} would leave hot wallet ${c.hot} with ${left} wei, short by ${keep - left} wei of the worst-case gas still to come (${keep} wei for the approve and shield)`;
    await recordAlert(c.env.DB, "sweep.insufficient_gas", c.chain, detail, c.now);
    return `insufficient gas in the hot wallet: ${detail}`;
  }
  if (cost + value > balance) {
    const detail = `hot wallet ${c.hot} holds ${balance} wei on ${c.chain}, a Railgun shield step needs about ${cost + value}`;
    await recordAlert(c.env.DB, "sweep.insufficient_gas", c.chain, detail, c.now);
    return `insufficient gas in the hot wallet: ${detail}`;
  }
  if (c.chain !== "eth") return null;
  let gasE8: bigint;
  let valueE8: bigint;
  try {
    [gasE8, valueE8] = await Promise.all([getPriceE8(c.env, "ETH", "USD"), getPriceE8(c.env, c.asset.priceSymbol, "USD")]);
  } catch {
    const detail = `no ETH or ${c.asset.priceSymbol} USD price, so the mainnet shield gas cannot be judged: not shielding`;
    await recordAlert(c.env.DB, "sweep.too_expensive", "eth", detail, c.now);
    return detail;
  }
  const costMinor = fiatMinorFromAtomic(spent, 18, gasE8);
  const valueMinor = fiatMinorFromAtomic(c.amount, c.asset.decimals, valueE8);
  if (costMinor * 100n > valueMinor * MAX_COST_PERCENT) {
    const detail = `a mainnet Railgun shield would cost about ${costMinor} USD cents in gas for ${valueMinor} shielded, over ${MAX_COST_PERCENT}%`;
    await recordAlert(c.env.DB, "sweep.too_expensive", "eth", detail, c.now);
    return detail;
  }
  return null;
}

/** Signs `req` at `nonce`, persists the progress with its hash, then broadcasts it. */
async function broadcast(c: Ctx, progress: ShieldProgress, step: ShieldStep, nonce: number, req: Req, proofs: Allowed[], addedCost: bigint, prior: Hex[], o: ShieldOptions): Promise<ShieldResult> {
  const { keccak256 } = await import("viem");
  const base = { chainId: EVM_CHAINS[c.chain].chainId, nonce, to: req.to, data: req.data, value: BigInt(req.value), gas: BigInt(req.gas) };
  const raw = await signEvmTx(
    c.env,
    req.type === "legacy"
      ? { ...base, type: "legacy", gasPrice: BigInt(req.gasPrice!) }
      : { ...base, type: "eip1559", maxFeePerGas: BigInt(req.maxFeePerGas!), maxPriorityFeePerGas: BigInt(req.maxPriorityFeePerGas!) },
    proofs,
  );
  const tx = keccak256(raw);
  const next: ShieldProgress = {
    ...progress,
    bind: progress.bind ?? { chain: c.chain, asset: c.asset.id, amount: c.amount.toString(), receiver0zk: c.receiver },
    costWei: (BigInt(progress.costWei) + addedCost).toString(),
    inflight: { step, nonce, txs: [...prior, tx], raw, req },
    txs: [...(progress.txs ?? []), tx],
  };
  if (!(await o.persist(next))) return result("skipped", progress, { step, reason: "the shield progress could not be recorded; nothing was broadcast" });
  try {
    await c.client.sendRawTransaction({ serializedTransaction: raw });
  } catch (e) {
    const text = errText(e);
    // The node already has our tx (re-broadcast race, or a retry through a fallback node): that is a send.
    if (/already known|known transaction|nonce too low/i.test(text) && (await nodeKnows(c.client, tx).catch(() => false))) return result("sent", next, { step, tx });
    const name = e instanceof Error ? e.name : "Error";
    console.warn(`0crypto: railgun ${step} on ${c.chain} not broadcast: ${name}`);
    if (/insufficient funds/i.test(text)) await recordAlert(c.env.DB, "sweep.insufficient_gas", c.chain, `the node refused a Railgun shield step on ${c.chain}: insufficient funds in ${c.hot}`, c.now);
    // Kept at its nonce: the next run finds its receipt, or replaces it after an hour (one tx per nonce can mine).
    return result("waiting", next, { step, tx, reason: `broadcast failed: ${name}; it is retried at nonce ${nonce}` });
  }
  return result("sent", next, { step, tx });
}
