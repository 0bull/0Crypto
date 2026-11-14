import { EVM_CHAINS, GAS_RESERVE, isEvmChain, type EvmChain } from "../chains/evm/config";
import { solBalance, tokenAccounts } from "../chains/solana/adapter";
import { findAta } from "../chains/solana/pda";
import { routeFee, routePlan } from "../chains/solana/routetx";
import { solRpc } from "../chains/solana/rpc";
import { USDC_MINT } from "../chains/solana/sweeptx";
import { tronGrid } from "../chains/tron/trongrid";
import type { UtxoChain } from "../chains/utxo/networks";
import type { SpendInput } from "../chains/utxo/spend";
import { chainConfigError } from "../chains/registry";
import { enabledAssets } from "../config";
import { ASSETS, getAsset } from "../core/assets";
import { fiatMinorFromAtomic } from "../core/money";
import type { AssetInfo } from "../core/types";
import { recordAlert } from "../db/alerts";
import { acquireHotNonce, releaseHotNonce } from "../db/noncelease";
import type { Env } from "../env";
import { getPriceE8 } from "../prices/cache";
import { enqueueNonInvoiceEvents } from "../webhooks/outbox";
import { evmHotAddress, solHotAddress, tronHotAddress } from "../signing/addresses";
import { EXECUTE_PER_ASSET, POLL_PER_ASSET, railgunGate, ROUTE_GAS_RESERVE, ROUTER_DEADLINE_MS, ROUTER_LOCK_TTL_MS } from "./config";
import { MAX_ABANDONS, parseChunks, parseLegs, routingEventStmt, wornChunk, type BatchRow, type SwapLeg } from "./legs";
import { defaultRng, planBatch, routeCfg, RouteConfigError, type RouteCfg } from "./planner";
import { validateRailgunDestination } from "./railgun/address";
import { shieldOnEvm, type ShieldProgress } from "./railgun/execute";
import { executeSwapChunk, pollSwapLegs, routableInputs, xmrDestination } from "./swap";
import { TROCADOR_TICKERS, trocador } from "./trocador";

/*
 * The router (cron, minute % 15 === 5; sweeps run at minute % 15 === 0). One run at a time, globally: a D1 lease
 * (router_lock, ROUTER_LOCK_TTL_MS) is taken with one INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at < now and
 * read back; a run that does not hold it does nothing. Global, not per asset: two batches of one UTXO asset must never
 * plan the same inputs (a conflicting spend could replace the other by RBF). No step starts once ROUTER_DEADLINE_MS of
 * wall time have passed (a step already begun finishes), nor once the run finds it no longer holds the lease (re-read
 * before every step, its expiry judged at the current time); the lease is released only by its holder. Refunds and
 * operator actions take the same lease. Every outbound call has a timeout: explorerFetch (Trocador, UTXO explorers,
 * TronGrid, TronSave, Solana RPC), viem's http transport (10 s, EVM) and the price fetchers (AbortSignal.timeout). The
 * run's routing events are enqueued to the webhook queue at its end (enqueueNonInvoiceEvents).
 *
 * Scope (routingScope): every registry asset that is not detection-only, has a route (Railgun or a Trocador ticker),
 * a configured chain and no xpub, whatever ENABLED_ASSETS says: a hot wallet keeps assets that are no longer offered
 * and registry tokens swept as unexpected deposits, and in-flight batches always finish. The assets are taken one
 * after the other, starting one further each run (round robin, router_lock.asset_offset), and each asset's turn does
 * all its steps before the next asset's: one slow asset (an explorer that hangs, a slow RPC) can run out the deadline
 * for that run, never for every run. There is no per-asset time budget: an asset's turn runs until it is done or the
 * run's ROUTER_DEADLINE_MS passes (checked before each step), and the next run starts with the next asset. An asset
 * with a routeProblem (a gate off, a bad destination, no API key) is only read for the hot cap (hot wallets only,
 * never UTXO deposits: routableInputs runs only for routed assets), and only when its destination var is set.
 * Per routed asset:
 *   1. plan: available = what the hot wallet (EVM, Tron, Solana) or the routable deposit UTXOs hold, minus the gas
 *      reserve (EVM native GAS_RESERVE, Solana SOL ROUTE_GAS_RESERVE plus fees), minus what executing batches of the
 *      asset have committed and not yet paid out (committedAmount). UTXO: routableInputs is read ONCE per asset per run
 *      (a rotating cursor over the payment sources, src/routing/sources.ts) and reused by the plan and every chunk.
 *      planBatch with the cached USD price (none: wait), the minimum (0 for Railgun, Trocador's for swaps) and the
 *      asset's recent payment amounts (the +-2% rule). `schedule` creates the asset's one scheduled batch (due_at;
 *      destination frozen now: RAILGUN_0ZK_ADDRESS or XMR_ADDRESS). `execute` moves it (or a new row, above the hot
 *      cap) to `executing`, freezing chunks and total: the amount is fixed once per batch, never recomputed.
 *   2. execute the asset's executing batches, at most EXECUTE_PER_ASSET per run, least recently visited first
 *      (executed_at): EVM chunks one after the other through shieldOnEvm (its progress lives only in the batch row's
 *      `progress` column, written by compare-and-set; the router never takes progress from anywhere else), the others
 *      through executeSwapChunk per chunk. An exception is logged by error name only, per chunk: the batch's later
 *      chunks and the other batches go on.
 *   3. poll: pollSwapLegs for the asset's swap batches with a leg in flight (executing, or failed with a signed leg
 *      that may still land; filtered in SQL), at most POLL_PER_ASSET per run, least recently polled first (polled_at).
 *      Finished and dead batches never fill either window.
 * A batch is `completed` when every chunk finished (routing.completed), `failed` on a terminal failure
 * (routing.failed); routing.stuck is raised once per stuck leg (swap.ts) or EVM batch (stuck_at).
 * The hot cap (checkHotCap): routing.over_cap, deduped per asset, when what an asset holds is worth HOT_CAP_USD or
 * more (per asset per chain) and routing cannot execute it (gate off, configuration error, no price, below the
 * Trocador minimum, a worn or stuck batch holding it). A malformed ROUTE_* / HOT_CAP_USD var (RouteConfigError) raises
 * routing.config_error (deduped) and plans nothing new; in-flight batches still move.
 *
 * routed_at: set only for UTXO payments (swap.ts, from the inputs a leg spent; sources.ts when it retires a source,
 * with route_note). EVM, Tron and Solana route pooled hot wallet balances, so no payment maps to a batch; their
 * payments' routed_at stays NULL (the dashboard shows batches).
 */

export interface RouterOptions {
  /** Planner randomness (default: CSPRNG). */
  rng?: () => number;
  /** Wall clock for the run deadline (default Date.now). */
  clock?: () => number;
  /** The lease holder id (default: a fresh one per run). */
  holder?: string;
}
export interface RouterReport {
  /** False: another run held the lease; nothing was done. */
  ran: boolean;
  planned: Record<string, string>;
  executed: string[];
  polled: string[];
  errors: string[];
  /** True if the deadline stopped the run before every step was started. */
  deadline: boolean;
  /** True if the run found it no longer held the lease (it had expired and was taken over): it stopped there. */
  lost: boolean;
}

/** Takes the global router lease if it is free or expired (lease ROUTER_LOCK_TTL_MS); true if `holder` now holds it. */
export async function acquireRouterLock(db: D1Database, holder: string, now: number): Promise<boolean> {
  await db
    .prepare(
      "INSERT INTO router_lock(id,holder,expires_at) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET holder=?1, expires_at=?2 WHERE COALESCE(router_lock.expires_at,0) < ?3",
    )
    .bind(holder, now + ROUTER_LOCK_TTL_MS, now)
    .run();
  const row = await db.prepare("SELECT holder FROM router_lock WHERE id=1").first<{ holder: string | null }>();
  return row?.holder === holder;
}

/**
 * True while `holder` holds an unexpired lease (re-checked before every step that could spend). Expiry is judged at
 * the later of `now` and the current Date.now(): a run (or refund) that started at `now` and has since outlived its
 * lease notices it, even though `now` itself never moves.
 */
export async function holdsRouterLock(db: D1Database, holder: string, now: number): Promise<boolean> {
  const row = await db.prepare("SELECT holder, expires_at FROM router_lock WHERE id=1").first<{ holder: string | null; expires_at: number | null }>();
  return row !== null && row.holder === holder && (row.expires_at ?? 0) > Math.max(now, Date.now());
}

/** The run's starting offset into the routed assets (round robin), advanced by one for the next run. */
async function nextOffset(db: D1Database, holder: string): Promise<number> {
  const row = await db.prepare("SELECT asset_offset FROM router_lock WHERE id=1 AND holder=?").bind(holder).first<{ asset_offset: number }>();
  await db.prepare("UPDATE router_lock SET asset_offset=asset_offset+1 WHERE id=1 AND holder=?").bind(holder).run();
  return row?.asset_offset ?? 0;
}

/** Releases the lease, only if `holder` still holds it. */
export async function releaseRouterLock(db: D1Database, holder: string): Promise<void> {
  await db.prepare("UPDATE router_lock SET holder=NULL, expires_at=0 WHERE id=1 AND holder=?").bind(holder).run();
}

const isUtxo = (chain: string): chain is UtxoChain => chain === "btc" || chain === "ltc" || chain === "doge";
const errName = (e: unknown) => (e instanceof Error ? e.name : "Error");

/** Why `asset` is not routed with this configuration (nothing is planned, executed or polled for it), or null. */
export function routeProblem(env: Env, asset: AssetInfo): string | null {
  if (asset.detectionOnly) return "detection-only";
  const unconfigured = chainConfigError(env, asset.chain);
  if (unconfigured) return `${asset.chain} is not configured: ${unconfigured}`;
  if (isEvmChain(asset.chain)) {
    const gate = railgunGate(env, asset.chain);
    if (gate) return gate;
    try {
      validateRailgunDestination(env.RAILGUN_0ZK_ADDRESS ?? "", { type: 0, id: EVM_CHAINS[asset.chain].chainId });
    } catch {
      return `RAILGUN_0ZK_ADDRESS is not a valid Railgun address for ${asset.chain}`;
    }
    return null;
  }
  if (!Object.hasOwn(TROCADOR_TICKERS, asset.id)) return "not routed";
  if (isUtxo(asset.chain) && env[`${asset.chain.toUpperCase() as "BTC" | "LTC" | "DOGE"}_XPUB`]) return "watch mode (xpub): never routed";
  try {
    xmrDestination(env);
  } catch {
    return "XMR_ADDRESS is not a valid Monero address";
  }
  if (!env.TROCADOR_API_KEY) return "TROCADOR_API_KEY is not set";
  if (env.TROCADOR_LIVE_OK !== "1") return 'TROCADOR_LIVE_OK is not "1" (docs/trocador-spike.md)';
  return null;
}

/**
 * Every registry asset the router looks at, whatever ENABLED_ASSETS says (a hot wallet can hold assets that are no
 * longer offered, or registry tokens swept as unexpected deposits; an asset's in-flight batches must still finish):
 * not detection-only, a route exists for it (EVM: Railgun; others: a Trocador ticker), its chain is configured, and
 * not in watch mode. Assets that are not enabled and hold nothing cost one balance read per run and are not reported.
 */
export function routingScope(env: Env): AssetInfo[] {
  return Object.values(ASSETS).filter(
    (a) =>
      !a.detectionOnly &&
      (isEvmChain(a.chain) || Object.hasOwn(TROCADOR_TICKERS, a.id)) &&
      chainConfigError(env, a.chain) === null &&
      !(isUtxo(a.chain) && env[`${a.chain.toUpperCase() as "BTC" | "LTC" | "DOGE"}_XPUB`]),
  );
}

/** The assets the router plans, executes and polls: the routing scope minus those with a routeProblem. */
export const routedAssets = (env: Env): AssetInfo[] => routingScope(env).filter((a) => routeProblem(env, a) === null);

/** The operator set a destination for the asset's route: routing is meant to run, so the hot cap applies. */
const routingSetUp = (env: Env, a: AssetInfo) => (isEvmChain(a.chain) ? !!env.RAILGUN_0ZK_ADDRESS : !!env.XMR_ADDRESS);

/** The frozen destination of a new batch of `asset`. */
function destinationFor(env: Env, asset: AssetInfo): string {
  return isEvmChain(asset.chain) ? env.RAILGUN_0ZK_ADDRESS! : xmrDestination(env);
}

// ---- available -------------------------------------------------------------------------------------------------------

/** Lamports kept back for the fees of up to three SOL route legs, on top of ROUTE_GAS_RESERVE.sol. */
function solFeeMargin(hot: string): bigint {
  return 3n * routeFee(routePlan(hot, hot, "sol:sol", 1n, { blockhash: "", lastValidBlockHeight: 0n }));
}

/**
 * What the hot wallet (or the routable deposit UTXOs) holds for routing `asset`, reserve taken off (may be negative).
 * UTXO: the sum of `inputs` (the run's routableInputs) when given, else of a fresh routableInputs read.
 */
export async function hotAvailable(env: Env, asset: AssetInfo, now: number, inputs?: SpendInput[][]): Promise<bigint> {
  const chain = asset.chain;
  if (isEvmChain(chain)) {
    const [{ evmClient }, { erc20Abi }, hot] = await Promise.all([import("../chains/evm/chains"), import("viem"), evmHotAddress(env)]);
    const client = await evmClient(env, chain);
    if (!asset.contract) return (await client.getBalance({ address: hot })) - GAS_RESERVE[chain];
    return client.readContract({ address: asset.contract as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [hot] });
  }
  if (chain === "tron") {
    const hot = tronHotAddress(env.MASTER_SEED ?? "");
    return tronGrid(env).trc20Balance(asset.contract!, hot, hot);
  }
  if (chain === "sol") {
    const rpc = solRpc(env);
    const hot = solHotAddress(env.MASTER_SEED ?? "");
    if (asset.id === "sol:sol") return (await solBalance(rpc, hot, "confirmed")) - ROUTE_GAS_RESERVE.sol - solFeeMargin(hot);
    const ata = findAta(hot, USDC_MINT)[0];
    return (await tokenAccounts(rpc, hot, USDC_MINT, "confirmed")).live.find((t) => t.pubkey === ata)?.amount ?? 0n;
  }
  if (isUtxo(chain)) return (inputs ?? (await routableInputs(env, chain, { now }))).flat().reduce((s, i) => s + i.value, 0n);
  throw new Error(`no routing balance for ${asset.id}`);
}

/** EVM batches: one ShieldProgress per chunk (or null); anything else in the column throws (never read as fresh). */
export function parseProgress(json: string): (ShieldProgress | null)[] {
  const v: unknown = JSON.parse(json);
  if (!Array.isArray(v) || v.some((x) => x !== null && (typeof x !== "object" || Array.isArray(x)))) throw new Error("route batch progress is not an array");
  return v as (ShieldProgress | null)[];
}

/** The live (last non-abandoned) leg of each chunk. */
function liveLegs(legs: SwapLeg[]): Map<number, SwapLeg> {
  const m = new Map<number, SwapLeg>();
  for (const l of legs) if (l.step !== "abandoned") m.set(l.chunk, l);
  return m;
}
const paidOut = (l: SwapLeg) => l.step === "sent" || l.step === "finished" || (l.step === "failed" && !!l.tx);

/**
 * What batches of `asset` have committed and the balance read by hotAvailable still holds: chunks of executing
 * batches not yet paid out (EVM: no final shield; hot-pooled swaps: no leg sent; UTXO: no live leg, whose inputs
 * routableInputs already leaves out), plus Tron/Solana legs of failed batches whose signed tx may still land.
 * Over-counting only delays routing; under-counting could plan the same funds twice.
 */
export async function committedAmount(db: D1Database, asset: AssetInfo): Promise<bigint> {
  const { results } = await db.prepare("SELECT * FROM route_batches WHERE asset=? AND status IN ('executing','failed')").bind(asset.id).all<BatchRow & { progress: string }>();
  let sum = 0n;
  for (const b of results) {
    const legs = parseLegs(b.legs);
    if (b.status === "failed") {
      if (!isEvmChain(asset.chain) && !isUtxo(asset.chain)) for (const l of legs) if (l.step === "sending" && l.tx) sum += BigInt(l.amount);
      continue;
    }
    const chunks = parseChunks(b.chunks);
    if (isEvmChain(asset.chain)) {
      const progress = parseProgress(b.progress);
      chunks.forEach((c, i) => {
        if (!progress[i]?.done) sum += c;
      });
      continue;
    }
    const live = liveLegs(legs);
    chunks.forEach((c, i) => {
      const l = live.get(i);
      if (isUtxo(asset.chain) ? l === undefined : l === undefined || !paidOut(l)) sum += c;
    });
  }
  return sum;
}

/** The asset's recent payment amounts (atomic), for planBatch's +-2% rule. */
async function recentPaymentAmounts(db: D1Database, asset: string): Promise<bigint[]> {
  const { results } = await db
    .prepare("SELECT final FROM payments WHERE asset=? AND status='confirmed' ORDER BY COALESCE(confirmed_at, created_at) DESC LIMIT 200")
    .bind(asset)
    .all<{ final: string }>();
  return results.map((r) => BigInt(r.final)).filter((v) => v > 0n);
}

// ---- plan ------------------------------------------------------------------------------------------------------------

const newBatchId = () => `rb_${crypto.randomUUID().replaceAll("-", "")}`;

export interface PlanOutcome {
  decision: string;
  /** What hotAvailable read (the hot wallet or the routable deposit outputs, reserve off). */
  held: bigint;
  /** held minus what executing batches committed (not below 0). */
  available: bigint;
  priceE8?: bigint;
  minimum?: bigint;
}

/** Plans `asset` (see the module comment) and persists the decision; returns it. */
export async function planAsset(env: Env, asset: AssetInfo, now: number, rng: () => number, inputs?: SpendInput[][]): Promise<string> {
  return (await planDetail(env, asset, now, rng, inputs)).decision;
}

/**
 * planAsset with what it read. The balance is read first: nothing held, no price or minimum is asked for. UTXO:
 * `inputs` are the run's routableInputs (read once per asset per run).
 */
export async function planDetail(env: Env, asset: AssetInfo, now: number, rng: () => number, inputs?: SpendInput[][]): Promise<PlanOutcome> {
  const db = env.DB;
  const cfg = routeCfg(env);
  const held = await hotAvailable(env, asset, now, inputs);
  let available = held - (await committedAmount(db, asset));
  if (available < 0n) available = 0n;
  if (held <= 0n) return { decision: "wait", held, available };
  let priceE8: bigint;
  try {
    priceE8 = await getPriceE8(env, asset.priceSymbol, "USD");
  } catch {
    return { decision: "wait: no price", held, available };
  }
  if (available === 0n) return { decision: "wait", held, available, priceE8 };
  const out = { held, available, priceE8 };
  const minimum = isEvmChain(asset.chain) ? 0n : await trocador(env).minimum(TROCADOR_TICKERS[asset.id]!, asset.decimals);
  const sched = await db.prepare("SELECT * FROM route_batches WHERE asset=? AND status='scheduled'").bind(asset.id).first<BatchRow>();
  const plan = planBatch({
    asset,
    available,
    paymentAmounts: await recentPaymentAmounts(db, asset.id),
    priceE8,
    ...(sched?.due_at != null ? { existingDueAt: sched.due_at } : {}),
    now,
    cfg,
    minimum,
    rng,
  });
  if (plan.action === "wait") return { ...out, minimum, decision: "wait" };
  if (plan.action === "schedule") {
    // Only reached without a scheduled batch (planBatch schedules only when there is no due time yet).
    await db
      .prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,due_at,status,created_at,updated_at) VALUES(?,?,?,'[]',?,?,'scheduled',?,?)")
      .bind(newBatchId(), asset.id, available.toString(), destinationFor(env, asset), plan.dueAt, now, now)
      .run();
    return { ...out, minimum, decision: "schedule" };
  }
  const chunks = JSON.stringify(plan.chunks.map(String));
  if (sched) {
    // The scheduled batch's destination was frozen at its creation; chunks and total are frozen now.
    const r = await db
      .prepare("UPDATE route_batches SET status='executing', chunks=?, total=?, updated_at=? WHERE id=? AND status='scheduled'")
      .bind(chunks, available.toString(), now, sched.id)
      .run();
    return { ...out, minimum, decision: (r.meta.changes ?? 0) === 1 ? "execute" : "wait: the batch changed" };
  }
  await db
    .prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,due_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'executing',?,?)")
    .bind(newBatchId(), asset.id, available.toString(), chunks, destinationFor(env, asset), now, now, now)
    .run();
  return { ...out, minimum, decision: "execute" };
}

// ---- execute: EVM ----------------------------------------------------------------------------------------------------

/** shieldOnEvm reasons that mean a person has to look (MAX_REPLACEMENTS fee bumps used up, receiver changed). */
const SHIELD_STUCK = /still unmined after \d+ fee bumps|RAILGUN_0ZK_ADDRESS changed mid-shield/;

type EvmBatch = BatchRow & { progress: string };

const evmSummary = (b: EvmBatch, progress: (ShieldProgress | null)[], status: string) => ({
  batch: b.id,
  asset: b.asset,
  total: b.total,
  chunks: parseChunks(b.chunks).length,
  status,
  txs: progress.flatMap((p) => p?.txs ?? []),
  shields: progress.flatMap((p) => (p?.done ? [p.done] : [])),
});

/** Sets stuck_at once and raises routing.stuck (alert and event, once per batch). */
async function markEvmStuck(env: Env, b: EvmBatch, progress: (ShieldProgress | null)[], detail: string, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE route_batches SET stuck_at=? WHERE id=? AND stuck_at IS NULL").bind(now, b.id),
    routingEventStmt(env.DB, "routing.stuck", b.id, { ...evmSummary(b, progress, "executing"), reason: detail }, now, { sql: "id=? AND stuck_at IS NOT NULL", binds: [b.id] }),
  ]);
  await recordAlert(env.DB, "routing.stuck", b.asset.split(":")[0] ?? null, `route batch ${b.id}: ${detail}`, now);
}

/** Settles the batch as completed or failed (compare-and-set on its progress), with its event. */
async function settleEvm(env: Env, b: EvmBatch, progressJson: string, to: "completed" | "failed", now: number, error?: string): Promise<void> {
  const progress = parseProgress(progressJson);
  await env.DB.batch([
    env.DB.prepare("UPDATE route_batches SET status=?, error=?, updated_at=? WHERE id=? AND status='executing' AND progress=?").bind(to, error ?? null, now, b.id, progressJson),
    routingEventStmt(env.DB, to === "completed" ? "routing.completed" : "routing.failed", b.id, { ...evmSummary(b, progress, to), ...(error ? { error } : {}) }, now, {
      sql: "id=? AND status=? AND progress=?",
      binds: [b.id, to, progressJson],
    }),
  ]);
}

/** Shields the batch's chunks in order, one shieldOnEvm step per call; a final chunk moves on to the next in the same run. */
async function executeEvmBatch(env: Env, b: EvmBatch, now: number, stop: () => Promise<boolean>): Promise<void> {
  const chain = getAsset(b.asset).chain as EvmChain;
  const chunks = parseChunks(b.chunks);
  let json = b.progress;
  // Compare-and-set of the progress column: the only writer of shield progress.
  const cas = async (next: string): Promise<boolean> => {
    const r = await env.DB.prepare("UPDATE route_batches SET progress=?, updated_at=? WHERE id=? AND status='executing' AND progress=?").bind(next, now, b.id, json).run();
    if ((r.meta.changes ?? 0) !== 1) return false;
    json = next;
    return true;
  };
  const withChunk = (i: number, p: ShieldProgress) => {
    const all = parseProgress(json);
    while (all.length < chunks.length) all.push(null);
    all[i] = p;
    return JSON.stringify(all);
  };
  for (let i = 0; i < chunks.length; i++) {
    const mine = parseProgress(json)[i] ?? undefined;
    if (mine?.done) continue;
    if (await stop()) return;
    // shieldOnEvm only ever shields to the current RAILGUN_0ZK_ADDRESS: a chunk not started yet never starts unless
    // that is still the batch's frozen destination (a started one is frozen by shieldOnEvm itself).
    if (!mine?.bind && env.RAILGUN_0ZK_ADDRESS !== b.destination) {
      await markEvmStuck(env, b, parseProgress(json), "RAILGUN_0ZK_ADDRESS changed since the batch was created; nothing more is shielded for it. Mark it resolved (a new batch uses the new address)", now);
      return;
    }
    // One hot-wallet sender per chain (src/db/noncelease.ts): while an EVM sweep or a refund holds the chain's nonce
    // lease, the shield step waits for the next run.
    const holder = `shield_${crypto.randomUUID()}`;
    if (!(await acquireHotNonce(env.DB, chain, holder, now))) return;
    let r: Awaited<ReturnType<typeof shieldOnEvm>>;
    try {
      r = await shieldOnEvm(env, chain, b.asset, chunks[i]!, { ...(mine ? { progress: mine } : {}), now, persist: (next) => cas(withChunk(i, next)) });
    } finally {
      await releaseHotNonce(env.DB, chain, holder);
    }
    const after = withChunk(i, r.progress);
    if (after !== json && !(await cas(after))) return;
    if (r.status === "failed") return settleEvm(env, b, json, "failed", now, `chunk ${i}: ${r.reason ?? "failed"}`.slice(0, 500));
    if (r.status === "shielded") continue;
    if (r.reason && SHIELD_STUCK.test(r.reason)) await markEvmStuck(env, b, parseProgress(json), r.reason, now);
    return;
  }
  await settleEvm(env, b, json, "completed", now);
}

// ---- the hot cap -----------------------------------------------------------------------------------------------------

/** An executing batch of the asset that routing cannot move on its own: worn (MAX_ABANDONS) or stuck. */
async function stoppedBatch(db: D1Database, asset: string): Promise<string | null> {
  const { results } = await db.prepare("SELECT id, legs, stuck_at FROM route_batches WHERE asset=? AND status='executing' ORDER BY created_at LIMIT 100").bind(asset).all<{ id: string; legs: string; stuck_at: number | null }>();
  for (const b of results) {
    const legs = parseLegs(b.legs);
    if (b.stuck_at !== null || wornChunk(legs) !== undefined || legs.some((l) => l.stuckAt !== undefined)) return b.id;
  }
  return null;
}

const usd = (minor: bigint) => `$${minor / 100n}`;

/**
 * routing.over_cap (deduped per asset: the alert's chain column carries the asset id): what the hot wallet or the
 * routable deposits hold of the asset is worth HOT_CAP_USD or more (or its value is unknown: no price) and routing
 * cannot execute it: a gate is off or the configuration is wrong (capUnrouted), no price, below the Trocador minimum,
 * or a worn or stuck batch holds it. The cap is per asset per chain (base:usdc and arb:usdc each have their own).
 */
async function checkHotCap(env: Env, a: AssetInfo, now: number, cfg: RouteCfg, o: PlanOutcome & { problem?: string }): Promise<void> {
  if (o.held <= 0n || o.decision === "execute") return;
  const cap = `HOT_CAP_USD (${usd(cfg.hotCapUsdMinor)})`;
  let detail: string;
  if (o.priceE8 === undefined) detail = `there is no USD price for it, so what it holds cannot be checked against ${cap}${o.problem ? `; and it is not routed: ${o.problem}` : ""}`;
  else {
    const held = fiatMinorFromAtomic(o.held, a.decimals, o.priceE8);
    if (held < cfg.hotCapUsdMinor) return;
    const free = fiatMinorFromAtomic(o.available, a.decimals, o.priceE8);
    let why: string;
    let stopped: string | null;
    if (o.problem) why = `it is not routed: ${o.problem}`;
    else if (free >= cfg.hotCapUsdMinor && o.minimum !== undefined && o.available < o.minimum) why = `${o.available} is below the Trocador minimum of ${o.minimum}`;
    else if ((stopped = await stoppedBatch(env.DB, a.id))) why = `route batch ${stopped} holding it is worn (abandoned ${MAX_ABANDONS} times) or stuck: resolve or resume it on the Routing page`;
    else if (free >= cfg.hotCapUsdMinor) why = `routing did not execute it (${o.decision})`;
    else return; // the rest is committed to batches that are moving
    detail = `it holds about ${usd(held)}, at or over ${cap}, and routing cannot move it: ${why}`;
  }
  await recordAlert(env.DB, "routing.over_cap", a.id, `${a.id}: ${detail}. The cap applies per asset per chain.`, now);
}

/**
 * The hot cap for an asset in scope that is not routed now (a gate off, a config error): its hot balance is read
 * only. UTXO assets are skipped: their "balance" is the payment sources, and routableInputs (explorer reads, cursor
 * stamps, retirements) never runs for an asset that is not routed.
 */
async function capUnrouted(env: Env, a: AssetInfo, now: number, cfg: RouteCfg, problem: string): Promise<void> {
  if (isUtxo(a.chain)) return;
  const held = await hotAvailable(env, a, now);
  if (held <= 0n) return;
  let priceE8: bigint | undefined;
  try {
    priceE8 = await getPriceE8(env, a.priceSymbol, "USD");
  } catch {
    priceE8 = undefined;
  }
  await checkHotCap(env, a, now, cfg, { decision: "not routed", held, available: held, ...(priceE8 !== undefined ? { priceE8 } : {}), problem });
}

// ---- run -------------------------------------------------------------------------------------------------------------

const hasLegInFlight = (legs: SwapLeg[]) => legs.some((l) => l.tradeId && (l.step === "sent" || (l.step === "sending" && l.tx)));
/** SQL twin of hasLegInFlight over route_batches.legs (the poll window's filter). */
const LEG_IN_FLIGHT_SQL = `EXISTS (SELECT 1 FROM json_each(route_batches.legs) j WHERE json_extract(j.value,'$.tradeId') IS NOT NULL
  AND (json_extract(j.value,'$.step')='sent' OR (json_extract(j.value,'$.step')='sending' AND json_extract(j.value,'$.tx') IS NOT NULL)))`;

/** The asset's executing batches to visit this run: the EXECUTE_PER_ASSET least recently visited. */
async function executeWindow(db: D1Database, asset: string): Promise<EvmBatch[]> {
  return (
    await db
      .prepare("SELECT * FROM route_batches WHERE asset=? AND status='executing' ORDER BY COALESCE(executed_at, 0), created_at, id LIMIT ?")
      .bind(asset, EXECUTE_PER_ASSET)
      .all<EvmBatch>()
  ).results;
}

/** The asset's batches with a leg in flight (executing, or failed with a signed leg that may land): least recently polled first. */
async function pollWindow(db: D1Database, asset: string): Promise<{ id: string; legs: string }[]> {
  return (
    await db
      .prepare(`SELECT id, legs FROM route_batches WHERE asset=? AND status IN ('executing','failed') AND ${LEG_IN_FLIGHT_SQL} ORDER BY COALESCE(polled_at, 0), updated_at DESC, id LIMIT ?`)
      .bind(asset, POLL_PER_ASSET)
      .all<{ id: string; legs: string }>()
  ).results;
}

/** One router run (see the module comment). Never throws for one asset's or batch's error. */
export async function runRouter(env: Env, now: number, o: RouterOptions = {}): Promise<RouterReport> {
  const clock = o.clock ?? Date.now;
  const startedAt = clock();
  const report: RouterReport = { ran: false, planned: {}, executed: [], polled: [], errors: [], deadline: false, lost: false };
  const holder = o.holder ?? `run_${crypto.randomUUID()}`;
  // Before every step: the wall-time deadline, and the lease (re-read: a run that outlived it must not act).
  const stop = async () => {
    if (report.deadline || report.lost) return true;
    if (clock() - startedAt >= ROUTER_DEADLINE_MS) report.deadline = true;
    else if (!(await holdsRouterLock(env.DB, holder, now))) report.lost = true;
    return report.deadline || report.lost;
  };
  if (!(await acquireRouterLock(env.DB, holder, now))) return report;
  report.ran = true;
  const fail = (what: string, e: unknown) => {
    const name = errName(e);
    report.errors.push(`${what}: ${name}`);
    console.warn(`0crypto: router ${what} failed: ${name}`);
  };
  try {
    let cfg: RouteCfg | null = null;
    try {
      cfg = routeCfg(env);
    } catch (e) {
      if (!(e instanceof RouteConfigError)) throw e;
      // Names the var, never its value. In-flight batches still move; nothing new is planned.
      await recordAlert(env.DB, "routing.config_error", null, `routing plans no new batch until this is fixed: ${e.message}`, now);
    }
    const scope = routingScope(env);
    const enabled = new Set(enabledAssets(env).map((a) => a.id));
    // Round robin: each run starts one asset further, so an asset whose steps are slow never starves the others.
    const offset = scope.length === 0 ? 0 : (await nextOffset(env.DB, holder)) % scope.length;
    for (const a of [...scope.slice(offset), ...scope.slice(0, offset)]) {
      if (await stop()) break;
      const problem = routeProblem(env, a);
      if (problem === null) await routeAsset(env, a, now, o.rng ?? defaultRng, cfg, enabled.has(a.id), report, stop, fail);
      else if (cfg && routingSetUp(env, a))
        try {
          await capUnrouted(env, a, now, cfg, problem);
        } catch (e) {
          fail(`cap ${a.id}`, e);
        }
    }
  } finally {
    await releaseRouterLock(env.DB, holder);
  }
  // The run's routing.* events (and alert events) are committed: hand them to the webhook queue now.
  await enqueueNonInvoiceEvents(env, now).catch((e) => console.warn(`0crypto: enqueueing routing events failed: ${errName(e)}`));
  return report;
}

/**
 * One asset's turn: plan, then execute its executing batches, then poll its batches with a leg in flight, checking
 * the deadline and the lease before each step. UTXO: routableInputs is read once here and reused by the plan and
 * by every chunk executed.
 */
async function routeAsset(
  env: Env,
  a: AssetInfo,
  now: number,
  rng: () => number,
  cfg: RouteCfg | null,
  enabled: boolean,
  report: RouterReport,
  stop: () => Promise<boolean>,
  fail: (what: string, e: unknown) => void,
): Promise<void> {
  let inputs: SpendInput[][] | undefined;
  try {
    if (isUtxo(a.chain)) inputs = await routableInputs(env, a.chain, { now });
    if (cfg) {
      const out = await planDetail(env, a, now, rng, inputs);
      if (enabled || out.held > 0n) report.planned[a.id] = out.decision;
      await checkHotCap(env, a, now, cfg, out);
    }
  } catch (e) {
    fail(`plan ${a.id}`, e);
    // Unread (explorer down): the executor finds nothing to spend this run rather than reading the explorer again.
    if (isUtxo(a.chain)) inputs ??= [];
  }
  for (const b of await executeWindow(env.DB, a.id)) {
    if (await stop()) return;
    await env.DB.prepare("UPDATE route_batches SET executed_at=? WHERE id=?").bind(now, b.id).run();
    try {
      if (isEvmChain(a.chain)) await executeEvmBatch(env, b, now, stop);
      else
        for (let i = 0; i < parseChunks(b.chunks).length; i++) {
          if (await stop()) break;
          // Per chunk: one chunk's exception never skips the batch's later chunks.
          try {
            await executeSwapChunk(env, { id: b.id }, i, { now, ...(inputs ? { inputs } : {}) });
          } catch (e) {
            fail(`batch ${b.id}`, e);
          }
        }
      report.executed.push(b.id);
    } catch (e) {
      fail(`batch ${b.id}`, e);
    }
  }
  if (isEvmChain(a.chain)) return;
  for (const b of await pollWindow(env.DB, a.id)) {
    if (await stop()) return;
    await env.DB.prepare("UPDATE route_batches SET polled_at=? WHERE id=?").bind(now, b.id).run();
    try {
      if (!hasLegInFlight(parseLegs(b.legs))) continue;
      await pollSwapLegs(env, { id: b.id }, { now });
      report.polled.push(b.id);
    } catch (e) {
      fail(`poll ${b.id}`, e);
    }
  }
}
