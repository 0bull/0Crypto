import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Address, Hex, PublicClient } from "viem";
import { FACTORY_ABI } from "../chains/evm/abi";
import { BUMP_DEN, BUMP_NUM, evmFeeQuote, MAX_COST_PERCENT, type Quote } from "../chains/evm/fees";
import { EVM_CHAINS, finalTarget, isEvmChain, type EvmChain } from "../chains/evm/config";
import { chainAssets, getAsset } from "../core/assets";
import { fiatMinorFromAtomic } from "../core/money";
import type { AssetInfo, ChainId } from "../core/types";
import { recordAlert } from "../db/alerts";
import { checkFailing, clearSweepLock, MAX_REPLACEMENTS, STUCK_AFTER_MS } from "../db/sweeps";
import { getPayment, getPaymentsByIds, listSweepCandidates, SWEEP_AFTER_EXPIRY_MS, type PaymentRow, type PaymentStatus } from "../db/repo";
import type { Env } from "../env";
import { getPriceE8 } from "../prices/cache";
import type { Currency } from "../prices/kraken";
import { allowedDestination, type Allowed } from "../routing/guard";
import { evmHotAddress } from "../signing/addresses";
import { HOT_WALLET_BUSY, withHotNonce } from "../db/noncelease";
import { signEvmTx } from "../signing/evm";
import type { SweepResult } from "./cron";

// viem is imported inside the functions that need it, never at module scope (see chains/evm/adapter.ts).

const BATCH = 50;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Fees, fee bumps and the mainnet cost cap are shared with the Railgun shield executor (chains/evm/fees.ts).
export { BUMP_DEN, BUMP_NUM, evmFeeQuote, MAX_COST_PERCENT, type EvmFee, type Quote } from "../chains/evm/fees";
/** A payment whose own flush cannot be estimated is left alone this long before the next try. */
const RETRY_AFTER_MS = DAY;
/** Ethereum mainnet only sweeps a batch worth at least $500 (credited_minor, in cents) ... */
const MAINNET_MIN_MINOR = 50_000n;
/** ... or whose oldest payment was confirmed more than 7 days ago. */
const MAINNET_MAX_AGE_MS = 7 * DAY;
export const FACTORY_NOT_DEPLOYED = "forwarder factory not deployed";

/** CREATE2 salt of a payment's forwarder: keccak256(abi.encode(uint256(index))). */
export function saltFor(index: number): Hex {
  const word = new Uint8Array(32);
  new DataView(word.buffer).setBigUint64(24, BigInt(index));
  return `0x${bytesToHex(keccak_256(word))}`;
}

export interface EvmSweepPlan {
  salts: Hex[];
  tokens: Address[];
  /** The payments the batch covers, oldest confirmation first. */
  payments: PaymentRow[];
}

/** Past the watcher's give-up (expiry + 7 days, plus an hour): nobody observes the address any more. */
const pastGiveUp = (p: PaymentRow, now: number) => p.invoice_expires_at != null && p.invoice_expires_at + SWEEP_AFTER_EXPIRY_MS < now;

/** Whether a payment is due for a sweep (same rule as listSweepCandidates). */
function isDue(p: PaymentRow, now: number): boolean {
  if (p.swept_at || (p.sweep_retry_at != null && p.sweep_retry_at > now)) return false;
  if (p.status === "confirmed") return true;
  if (p.status === "partial") return pastGiveUp(p, now);
  if (p.status === "expired") return p.unexpected != null && pastGiveUp(p, now);
  return false;
}

/**
 * Pure: the next batch for a chain. Up to 50 unswept payments of the chain, oldest first: confirmed ones; partial ones,
 * and expired ones holding unexpected deposits, once their invoice expired more than 7 days + 1 hour ago (the watcher
 * has given up, so emptying the address cannot change a credit). Payments waiting for their retry time are left out.
 * `tokens` are each payment's own ERC-20 contract (always, even if its asset was disabled since: the sweep marks the
 * payment swept, so its funds must go) plus every registry ERC-20 of the chain named in its `unexpected` map, enabled
 * or not. Native is never listed: the contract always flushes it. Null when nothing is due.
 */
export function planEvmSweep(payments: PaymentRow[], chain: EvmChain, now: number = Date.now()): EvmSweepPlan | null {
  const due = payments
    .filter((p) => p.chain === chain && isDue(p, now))
    .sort((a, b) => (a.confirmed_at ?? a.created_at) - (b.confirmed_at ?? b.created_at))
    .slice(0, BATCH);
  if (due.length === 0) return null;
  const tokens = new Set<Address>();
  for (const p of due) for (const t of fullTokens(p, chain)) tokens.add(t);
  return { salts: due.map((p) => saltFor(p.derivation_index)), tokens: [...tokens], payments: due };
}

/** A payment's own ERC-20 (none for a native asset), even if its asset was disabled since. */
const ownTokens = (p: PaymentRow): Address[] => {
  const own = getAssetOrNull(p.asset)?.contract;
  return own ? [own as Address] : [];
};

/** Everything a normal sweep flushes for one payment: its own ERC-20 plus every registry ERC-20 named in `unexpected`. */
function fullTokens(p: PaymentRow, chain: EvmChain): Address[] {
  const registry = new Map(chainAssets(chain).filter((a) => a.contract).map((a) => [a.id, a.contract as Address]));
  const tokens = new Set<Address>(ownTokens(p));
  for (const id of Object.keys(p.unexpected ?? {})) {
    const c = registry.get(id);
    if (c) tokens.add(c);
  }
  return [...tokens];
}

/** An EVM address as typed by an admin: 0x and 40 hex digits. */
export const isTokenAddress = (v: string): v is Address => /^0x[0-9a-fA-F]{40}$/.test(v);

function getAssetOrNull(id: string): AssetInfo | null {
  try {
    return getAsset(id);
  } catch {
    return null;
  }
}

/**
 * Why a deposit recovery for `payment` on `chain` must be refused, or null. The derivation index of a non-EVM payment
 * comes from another counter, so it names someone else's forwarder; on the payment's own chain a live payment's
 * address must not be emptied under it. Any other EVM chain is always fine.
 */
export function recoveryBlock(payment: { chain: ChainId; status: PaymentStatus }, chain: EvmChain): { code: 400 | 409; message: string } | null {
  if (!isEvmChain(payment.chain)) return { code: 400, message: "Only EVM payments can be recovered: other chains use their own derivation counters." };
  if (payment.chain === chain && !["partial", "expired", "confirmed"].includes(payment.status))
    return { code: 409, message: `This payment is still ${payment.status}: recovering on its own chain could take funds meant for the invoice. Wait until it is confirmed, partial or expired.` };
  return null;
}

type Kind = "sweep" | "recover";
/** Which tokens a recovery flushes: every registry token (+ optional extra), only the payment's own, or one given address. */
export type RecoverTokens = "all" | "own" | "custom";
interface Chain {
  client: PublicClient;
  /** The hot wallet (address only: its key never leaves src/signing). */
  account: { address: Address };
  env: { MASTER_SEED?: string };
  chain: EvmChain;
  factory: Address;
  /** Guard proofs for the hot wallet and the factory: the only destinations a sweep or recovery tx pays. */
  proofs: Allowed[];
}

async function open(env: Env, chain: EvmChain): Promise<Chain> {
  const [{ evmClient }, hot, { factoryAddress }] = await Promise.all([import("../chains/evm/chains"), evmHotAddress(env), import("../chains/evm/predict")]);
  const account = { address: hot };
  const factory = factoryAddress(account.address);
  const proofs = await Promise.all([allowedDestination(env, chain, account.address), allowedDestination(env, chain, factory)]);
  return { client: await evmClient(env, chain), account, env, chain, factory, proofs };
}

type Causal = { name?: string; shortMessage?: string; message?: string; details?: string; cause?: unknown };
/** The error and its causes as one lowercase-insensitive string, for matching node messages. */
export function errText(e: unknown): string {
  const out: string[] = [];
  for (let cur = e as Causal | undefined, i = 0; cur && i < 8; cur = cur.cause as Causal | undefined, i++)
    out.push(cur.name ?? "", cur.shortMessage ?? "", cur.details ?? "", cur.message ?? "");
  return out.join(" | ");
}

/** A node refusing the call because the contract call reverts (as opposed to an RPC or network failure). */
export function isRevert(e: unknown): boolean {
  for (let cur = e as Causal | undefined, i = 0; cur && i < 8; cur = cur.cause as Causal | undefined, i++) {
    if (cur.name === "ExecutionRevertedError") return true;
    if (/revert/i.test(cur.shortMessage ?? "")) return true;
  }
  return false;
}

async function estimate(c: Chain, salts: Hex[], tokens: Address[]): Promise<bigint | "revert"> {
  const { encodeFunctionData } = await import("viem");
  try {
    return await c.client.estimateGas({
      account: c.account.address,
      to: c.factory,
      data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "deployAndFlush", args: [salts, tokens] }),
    });
  } catch (e) {
    if (isRevert(e)) return "revert";
    throw e;
  }
}

/** The (lowercase) token addresses a deployAndFlush calldata flushes. */
async function sentTokens(data: Hex, sweepId = "?"): Promise<Set<string> | null> {
  const { decodeFunctionData } = await import("viem");
  try {
    const { args } = decodeFunctionData({ abi: FACTORY_ABI, data });
    return new Set((args[1] as Address[]).map((t) => t.toLowerCase()));
  } catch {
    console.warn(`0crypto: sweep ${sweepId}: cannot decode the sent tokens`);
    return null;
  }
}

/**
 * Of these payments, the ids a confirmed admin recovery (sweeps row "rec_...") has fully emptied: on the payment's OWN
 * chain, with sent tokens covering everything a normal sweep of the payment would flush.
 */
export async function recoveredPaymentIds(db: D1Database, payments: PaymentRow[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (payments.length === 0) return out;
  const byId = new Map(payments.map((p) => [p.id, p]));
  const { results } = await db
    .prepare(
      `SELECT s.id AS sid, s.req AS req, p.id AS pid FROM sweeps s, json_each(s.payment_ids) j JOIN payments p ON p.id=j.value AND p.chain=s.chain
       WHERE s.status='confirmed' AND s.id LIKE 'rec\\_%' ESCAPE '\\' AND p.id IN (${payments.map(() => "?").join(",")})`,
    )
    .bind(...payments.map((p) => p.id))
    .all<{ sid: string; req: string | null; pid: string }>();
  for (const r of results) {
    const p = byId.get(r.pid);
    if (!p || out.has(p.id) || !r.req || !isEvmChain(p.chain)) continue;
    const sent = await sentTokens((JSON.parse(r.req) as Req).data, r.sid);
    if (sent && fullTokens(p, p.chain).every((t) => sent.has(t.toLowerCase()))) out.add(p.id);
  }
  return out;
}

/** What a tx needs to be (re-)signed. Strings in JSON (bigint). */
interface Req {
  data: Hex;
  gas: string;
  type: "eip1559" | "legacy";
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
  /** When the latest tx of the sweep was broadcast (unix ms). */
  at: number;
}
const quote = (c: Chain, gasLimit: bigint): Promise<Quote> => evmFeeQuote(c.client, c.chain, gasLimit);

async function signReq(c: Chain, nonce: number, req: Req): Promise<Hex> {
  const base = { chainId: EVM_CHAINS[c.chain].chainId, nonce, to: c.factory, data: req.data, gas: BigInt(req.gas) };
  return signEvmTx(
    c.env,
    req.type === "legacy"
      ? { ...base, type: "legacy", gasPrice: BigInt(req.gasPrice!) }
      : { ...base, type: "eip1559", maxFeePerGas: BigInt(req.maxFeePerGas!), maxPriorityFeePerGas: BigInt(req.maxPriorityFeePerGas!) },
    c.proofs,
  );
}

const newId = (kind: Kind) => `${kind === "sweep" ? "swp" : "rec"}_${crypto.randomUUID().replaceAll("-", "")}`;
const pendingCount = async (db: D1Database, chain: EvmChain) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM sweeps WHERE chain=? AND status='pending'").bind(chain).first<{ n: number }>())?.n ?? 0;

type Receipt = Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
async function receiptOf(c: Chain, hash: Hex): Promise<Receipt | null> {
  try {
    return await c.client.getTransactionReceipt({ hash });
  } catch (e) {
    if ((e as Error).name === "TransactionReceiptNotFoundError") return null;
    throw e;
  }
}

/**
 * Settles the chain's pending sweeps. A receipt (for any tx hash of the sweep): reverted -> failed (payments stay
 * unswept); successful and at or below the final target (finalized, and for Polygon 64 deep) -> confirmed, and a
 * normal sweep marks its payments swept. No receipt for an hour: if the hot wallet's nonce moved on (used by
 * something else) the sweep is dropped with a sweep.failing alert, otherwise the tx is replaced at the same nonce
 * with fees x1.3. Returns how many sweeps are still pending.
 */
async function reconcile(env: Env, c: Chain, now: number): Promise<number> {
  const rows = (
    await env.DB.prepare("SELECT id,tx,txs,nonce,req,created_at,payment_ids FROM sweeps WHERE chain=? AND status='pending'")
      .bind(c.chain)
      .all<{ id: string; tx: string | null; txs: string | null; nonce: number | null; req: string | null; created_at: number; payment_ids: string }>()
  ).results;
  if (rows.length === 0) return 0;
  const [fin, head] = await Promise.all([c.client.getBlock({ blockTag: "finalized" }), c.client.getBlockNumber()]);
  const target = fin.number === null ? null : finalTarget(head, fin.number, EVM_CHAINS[c.chain].minDepth);
  let left = 0;
  for (const row of rows) {
    const ids = JSON.parse(row.payment_ids) as string[];
    const hashes = row.txs ? (JSON.parse(row.txs) as Hex[]) : row.tx ? [row.tx as Hex] : [];
    // `released`: no tx of the sweep ever mined, so the payments' lock is let go.
    const fail = async (error: string, released: boolean) => {
      await env.DB.prepare("UPDATE sweeps SET status='failed', error=? WHERE id=? AND status='pending'").bind(error, row.id).run();
      if (released) await clearSweepLock(env.DB, ids, hashes);
      await checkFailing(env, c.chain, now);
    };
    // The nonce is read before the receipts: a tx mined in between then shows up as a receipt, never as "consumed elsewhere".
    const latestNonce = row.nonce === null ? null : await c.client.getTransactionCount({ address: c.account.address, blockTag: "latest" });
    let hit: { hash: Hex; receipt: Receipt } | null = null;
    for (const hash of hashes) {
      const receipt = await receiptOf(c, hash);
      if (receipt) {
        hit = { hash, receipt };
        break;
      }
    }
    if (hit) {
      if (hit.receipt.status !== "success") await fail("reverted", false);
      else if (target !== null && hit.receipt.blockNumber <= target) {
        const stmts = [env.DB.prepare("UPDATE sweeps SET status='confirmed', tx=? WHERE id=? AND status='pending'").bind(hit.hash, row.id)];
        // A recovery never marks its payment swept: the funds may be unrelated to its invoice.
        if (row.id.startsWith("swp_")) {
          // An own-token fallback flushed fewer tokens than the payment's full list: the rest stays at the address.
          const sent = row.req ? await sentTokens((JSON.parse(row.req) as Req).data, row.id) : null;
          const byId = new Map((sent ? await getPaymentsByIds(env.DB, ids) : []).map((p) => [p.id, p]));
          for (const id of ids) {
            const p = byId.get(id);
            const left = p && sent && fullTokens(p, c.chain).some((t) => !sent.has(t.toLowerCase())) ? 1 : 0;
            stmts.push(
              env.DB.prepare("UPDATE payments SET swept_at=?, swept_base=received, sweep_tx=?, sweep_error=NULL, sweep_retry_at=NULL, unexpected_left=? WHERE id=? AND swept_at IS NULL").bind(now, hit!.hash, left, id),
            );
          }
        }
        await env.DB.batch(stmts);
      } else left++;
      continue;
    }
    const req = row.req ? (JSON.parse(row.req) as Req) : null;
    if (now - (req?.at ?? row.created_at) <= STUCK_AFTER_MS) {
      left++;
      continue;
    }
    if (!req || row.nonce === null) {
      await fail("no nonce or request data (cannot be replaced)", true);
      continue;
    }
    if (latestNonce !== null && latestNonce > row.nonce) {
      // Dropped only if the node knows none of our txs any more; a known one may still be mined.
      let known = false;
      for (const h of hashes) known = known || (await nodeKnows(c, h));
      if (known) {
        left++;
        continue;
      }
      await fail("dropped", true);
      await recordAlert(env.DB, "sweep.failing", c.chain, `a sweep tx on ${c.chain} was dropped: its nonce ${row.nonce} was used by another transaction`, now);
      continue;
    }
    left++;
    // Unmined for an hour and the nonce is still free: replace it at the same nonce with fees x1.3, a bounded number of times.
    if (hashes.length - 1 >= MAX_REPLACEMENTS) {
      await recordAlert(env.DB, "sweep.failing", c.chain, `a sweep tx on ${c.chain} is still unmined after ${MAX_REPLACEMENTS} fee bumps (${hashes[hashes.length - 1]}); mark it failed on the dashboard once you have looked at it`, now);
      continue;
    }
    const bump = (v?: string) => (v === undefined ? undefined : ((BigInt(v) * BUMP_NUM) / BUMP_DEN).toString());
    const next: Req = { ...req, maxFeePerGas: bump(req.maxFeePerGas), maxPriorityFeePerGas: bump(req.maxPriorityFeePerGas), gasPrice: bump(req.gasPrice), at: now };
    // The replacement must still be affordable, and on mainnet still worth it, at current prices.
    const gasLimit = BigInt(req.gas);
    const bumpedCost = gasLimit * BigInt(next.maxFeePerGas ?? next.gasPrice!);
    const balance = await c.client.getBalance({ address: c.account.address });
    if (bumpedCost > balance) {
      await recordAlert(env.DB, "sweep.insufficient_gas", c.chain, `the hot wallet cannot pay for a replacement sweep tx on ${c.chain}: ${balance} wei, needs about ${bumpedCost}`, now);
      continue;
    }
    if (c.chain === "eth" && row.id.startsWith("swp_")) {
      const payments = (await Promise.all(ids.map((id) => getPayment(env.DB, id)))).filter((p): p is PaymentRow => p !== null);
      const fresh = await quote(c, gasLimit);
      if (payments.length > 0 && (await tooExpensive(env, payments, fresh.cost > bumpedCost ? fresh.cost : bumpedCost, now))) continue;
    }
    const { keccak256 } = await import("viem");
    const raw = await signReq(c, row.nonce, next);
    const hash = keccak256(raw);
    // Broadcast only if the row was still pending when the new hash was recorded (an admin may have failed it meanwhile).
    const upd = await env.DB.prepare("UPDATE sweeps SET tx=?, txs=?, req=? WHERE id=? AND status='pending'").bind(hash, JSON.stringify([...hashes, hash]), JSON.stringify(next), row.id).run();
    if ((upd.meta.changes ?? 0) !== 1) {
      left--;
      continue;
    }
    try {
      await c.client.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      const name = e instanceof Error ? e.name : "Error";
      console.warn(`0crypto: sweep ${c.chain} replacement not broadcast: ${name}`);
      await recordAlert(env.DB, "sweep.failing", c.chain, `a replacement sweep tx on ${c.chain} could not be broadcast (${name}); the original is still pending`, now);
    }
  }
  return left;
}

/** Gives the payments a short error and a retry time, and raises one sweep.payment_failed alert for them. */
async function failPayments(env: Env, chain: EvmChain, payments: PaymentRow[], now: number, error: string): Promise<void> {
  await env.DB.batch(
    payments.map((p) => env.DB.prepare("UPDATE payments SET sweep_error=?, sweep_retry_at=? WHERE id=?").bind(error, now + RETRY_AFTER_MS, p.id)),
  );
  await recordAlert(env.DB, "sweep.payment_failed", chain, `${error}: ${payments.map((p) => p.id).join(", ")}`, now);
}

/** Does the node know this tx (pending or mined)? */
async function nodeKnows(c: Chain, hash: Hex): Promise<boolean> {
  const r = await (c.client as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method: "eth_getTransactionByHash", params: [hash] });
  return r !== null && r !== undefined;
}

/**
 * Gas check, then sign, record the pending row, and broadcast, holding the chain's hot nonce lease from the nonce read
 * to the broadcast (src/db/noncelease.ts): while a shield or refund holds it, the sweep is skipped this run.
 */
async function send(env: Env, c: Chain, kind: Kind, ids: string[], salts: Hex[], tokens: Address[], q: Quote, now: number, lock: boolean): Promise<SweepResult> {
  const busy = (): SweepResult => ({ status: "skipped", reason: HOT_WALLET_BUSY, paymentIds: [] });
  return withHotNonce(env.DB, c.chain, `sweep_${crypto.randomUUID()}`, now, busy, () => sendLocked(env, c, kind, ids, salts, tokens, q, now, lock));
}

async function sendLocked(env: Env, c: Chain, kind: Kind, ids: string[], salts: Hex[], tokens: Address[], q: Quote, now: number, lock: boolean): Promise<SweepResult> {
  const { encodeFunctionData, keccak256 } = await import("viem");
  const balance = await c.client.getBalance({ address: c.account.address });
  if (q.cost > balance) {
    await recordAlert(env.DB, "sweep.insufficient_gas", c.chain, `hot wallet ${c.account.address} holds ${balance} wei on ${c.chain}, a sweep needs about ${q.cost}`, now);
    return { status: "skipped", reason: "insufficient gas in the hot wallet", paymentIds: [] };
  }
  const nonce = await c.client.getTransactionCount({ address: c.account.address, blockTag: "pending" });
  const req: Req = { data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "deployAndFlush", args: [salts, tokens] }), gas: q.gasLimit.toString(), ...q.fee, at: now };
  const raw = await signReq(c, nonce, req);
  const tx = keccak256(raw);

  // Record the pending row before anything else is awaited, so a crash after the broadcast cannot lose the tx, and
  // only if no other run holds the chain: the guard makes the check and the insert one statement (the unique index
  // on pending sweeps is the backstop).
  const id = newId(kind);
  const busy: SweepResult = { status: "skipped", reason: "a sweep is pending", paymentIds: [] };
  try {
    // The sweep lock (payments.sweep_tx) is written in the same batch as the pending row, and only if that row was
    // inserted: once the sweep is final the address reads 0, and a locked payment keeps its credit until reconcile.
    const stmts = [
      env.DB.prepare(
        `INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,nonce,txs,req)
         SELECT ?1,?2,?3,?4,'pending',?5,?6,?7,?8 WHERE NOT EXISTS (SELECT 1 FROM sweeps WHERE chain=?2 AND status='pending')`,
      ).bind(id, c.chain, tx, now, JSON.stringify(ids), nonce, JSON.stringify([tx]), JSON.stringify(req)),
      ...(lock ? ids : []).map((pid) =>
        env.DB.prepare("UPDATE payments SET sweep_tx=? WHERE id=? AND EXISTS (SELECT 1 FROM sweeps WHERE id=? AND status='pending')").bind(tx, pid, id),
      ),
    ];
    const [ins] = await env.DB.batch(stmts);
    if ((ins!.meta.changes ?? 0) === 0) return busy;
  } catch (e) {
    if (/unique/i.test(errText(e))) return busy;
    throw e;
  }
  try {
    await c.client.sendRawTransaction({ serializedTransaction: raw });
  } catch (e) {
    const text = errText(e);
    // The node already has our tx (re-broadcast race, or a retry through a fallback node): that is a send.
    if (/already known|known transaction|nonce too low/i.test(text) && (await nodeKnows(c, tx).catch(() => false))) return { status: "sent", tx, paymentIds: ids };
    const name = e instanceof Error ? e.name : "Error";
    await env.DB.prepare("UPDATE sweeps SET status='failed', error=? WHERE id=?").bind(`broadcast failed: ${name}`.slice(0, 120), id).run();
    if (lock) await clearSweepLock(env.DB, ids, [tx]);
    console.warn(`0crypto: sweep ${c.chain} broadcast failed: ${name}`);
    if (/insufficient funds/i.test(text))
      await recordAlert(env.DB, "sweep.insufficient_gas", c.chain, `the node refused the sweep tx on ${c.chain}: insufficient funds in ${c.account.address}`, now);
    await checkFailing(env, c.chain, now);
    return { status: "failed", reason: `broadcast failed: ${name}`, paymentIds: ids };
  }
  return { status: "sent", tx, paymentIds: ids };
}

/** Mainnet economics: skip (with an alert) when the gas would cost more than 5% of the batch, or the ETH price is unknown. */
async function tooExpensive(env: Env, payments: PaymentRow[], cost: bigint, now: number): Promise<string | null> {
  const oldest = payments[0]!;
  const row = await env.DB.prepare("SELECT currency FROM invoices WHERE id=?").bind(oldest.invoice_id).first<{ currency: Currency }>();
  const currency: Currency = row?.currency === "EUR" ? "EUR" : "USD";
  const value = payments.reduce((s, p) => s + p.credited_minor, 0n);
  let priceE8: bigint;
  try {
    priceE8 = await getPriceE8(env, "ETH", currency);
  } catch {
    const detail = `no ETH/${currency} price available, so the mainnet sweep cost cannot be judged: not sweeping`;
    await recordAlert(env.DB, "sweep.too_expensive", "eth", detail, now);
    return detail;
  }
  const costMinor = fiatMinorFromAtomic(cost, 18, priceE8);
  if (costMinor * 100n > value * MAX_COST_PERCENT) {
    const detail = `a mainnet sweep would cost about ${costMinor} (${currency} minor units) for ${value} of deposits, over ${MAX_COST_PERCENT}%`;
    await recordAlert(env.DB, "sweep.too_expensive", "eth", detail, now);
    return detail;
  }
  return null;
}

/**
 * One sweep run for a chain: settle pending sweeps, then send the next batch through ForwarderFactory.deployAndFlush
 * from the hot wallet (one tx in flight per chain). Throws on RPC failures; the caller isolates them per chain.
 */
export async function runEvmSweep(env: Env, chain: EvmChain, now: number): Promise<SweepResult> {
  const { evmHealth } = await import("../chains/evm/health");
  if (!(await evmHealth(env, chain)).factoryDeployed) return { status: "skipped", reason: FACTORY_NOT_DEPLOYED, paymentIds: [] };
  const c = await open(env, chain);
  if ((await reconcile(env, c, now)) > 0) return { status: "skipped", reason: "a sweep is pending", paymentIds: [] };

  let plan = planEvmSweep(await listSweepCandidates(env.DB, chain, now, BATCH), chain, now);
  if (!plan) return { status: "idle", paymentIds: [] };

  // Gas is not worth spending on a small, fresh batch on mainnet.
  if (chain === "eth") {
    const value = plan.payments.reduce((s, p) => s + p.credited_minor, 0n);
    const oldest = Math.min(...plan.payments.map((p) => p.confirmed_at ?? p.created_at));
    if (value < MAINNET_MIN_MINOR && now - oldest <= MAINNET_MAX_AGE_MS)
      return { status: "idle", reason: "below the mainnet threshold", paymentIds: [] };
  }

  let gas = await estimate(c, plan.salts, plan.tokens);
  if (gas === "revert") {
    // Estimate each payment's full list on its own first. If any passes, sweep those and probe nothing (the blocked
    // ones are re-checked next run). If none passes, probe own-token lists one payment at a time (a blacklisted
    // forwarder or paused token among the unexpected deposits blocks the full list) and stop at the first success.
    const good: PaymentRow[] = [];
    const blocked: PaymentRow[] = [];
    for (const p of plan.payments) {
      const one = planEvmSweep([p], chain, now)!;
      ((plan.payments.length > 1 ? await estimate(c, one.salts, one.tokens) : "revert") === "revert" ? blocked : good).push(p);
    }
    if (good.length > 0) {
      // Starvation guard: a blocked payment waiting over 24h gets its own-token probe even though healthy ones keep
      // arriving. Success: it is swept alone this run. Revert: it is parked (alert) and the healthy batch goes ahead.
      const age = (p: PaymentRow) => p.confirmed_at ?? p.created_at;
      const stuck = blocked.reduce<PaymentRow | null>((o, p) => (o === null || age(p) < age(o) ? p : o), null);
      let alone: { plan: EvmSweepPlan; gas: bigint } | null = null;
      if (stuck && now - age(stuck) > DAY) {
        const own = ownTokens(stuck);
        const same = own.length === planEvmSweep([stuck], chain, now)!.tokens.length;
        const g = same ? "revert" : await estimate(c, [saltFor(stuck.derivation_index)], own);
        if (g === "revert") await failPayments(env, chain, [stuck], now, "flush estimate reverted");
        else alone = { plan: { salts: [saltFor(stuck.derivation_index)], tokens: own, payments: [stuck] }, gas: g };
      }
      if (alone) {
        plan = alone.plan;
        gas = alone.gas;
      } else {
        plan = planEvmSweep(good, chain, now)!;
        gas = await estimate(c, plan.salts, plan.tokens);
        if (gas === "revert") return { status: "failed", reason: "flush estimate reverted", paymentIds: good.map((p) => p.id) };
      }
    } else {
      const bad: PaymentRow[] = [];
      let found: { plan: EvmSweepPlan; gas: bigint } | null = null;
      for (const p of blocked) {
        const own = ownTokens(p);
        // Same list as the full one: nothing to gain from a second estimate.
        const same = own.length === planEvmSweep([p], chain, now)!.tokens.length;
        const g = same ? "revert" : await estimate(c, [saltFor(p.derivation_index)], own);
        if (g === "revert") {
          bad.push(p);
          continue;
        }
        // One fallback payment per tx (only one sweep is pending per chain; the next goes in a later run).
        found = { plan: { salts: [saltFor(p.derivation_index)], tokens: own, payments: [p] }, gas: g };
        break;
      }
      if (bad.length > 0) await failPayments(env, chain, bad, now, "flush estimate reverted");
      if (!found) return { status: "failed", reason: "flush estimate reverted", paymentIds: bad.map((p) => p.id) };
      plan = found.plan;
      gas = found.gas;
    }
  }
  const q = await quote(c, (gas * 12n) / 10n);
  if (chain === "eth") {
    const why = await tooExpensive(env, plan.payments, q.cost, now);
    if (why) return { status: "skipped", reason: why, paymentIds: [] };
  }
  return send(env, c, "sweep", plan.payments.map((p) => p.id), plan.salts, plan.tokens, q, now, true);
}

/**
 * Admin recovery for a deposit sent to this payment's address on another chain: flushes the payment's forwarder on
 * `chain` (deploying it if needed) with every registry token of that chain, enabled or not, plus an optional `token`
 * outside the registry (bridged USDC.e, say). Any token is safe to name: the forwarder only ever pays the sink.
 * `mode` "own" flushes only the payment's own asset on `chain` (nothing but native if it has no contract there) and
 * "custom" only `token`: use them when one token's revert blocks the full flush.
 * Records a sweep row but never marks the payment swept. See recoveryBlock for what is refused.
 */
export async function recoverDeposit(env: Env, payment: PaymentRow, chain: EvmChain, now: number, token?: Address, mode: RecoverTokens = "all"): Promise<SweepResult> {
  const blocked = recoveryBlock(payment, chain);
  if (blocked) return { status: "failed", reason: blocked.message, paymentIds: [payment.id] };
  if (mode === "custom" && token === undefined) return { status: "failed", reason: "a single-token recovery needs the token address", paymentIds: [payment.id] };
  if (token !== undefined && /^0x0{40}$/i.test(token)) return { status: "failed", reason: "the zero address is not a token", paymentIds: [payment.id] };
  if (token !== undefined && mode !== "own" && !isTokenAddress(token)) return { status: "failed", reason: "the token must be 0x followed by 40 hex digits", paymentIds: [payment.id] };
  const { evmHealth } = await import("../chains/evm/health");
  if (!(await evmHealth(env, chain)).factoryDeployed) return { status: "skipped", reason: FACTORY_NOT_DEPLOYED, paymentIds: [] };
  const c = await open(env, chain);
  if ((await reconcile(env, c, now)) > 0 || (await pendingCount(env.DB, chain)) > 0) return { status: "skipped", reason: "a sweep is pending", paymentIds: [] };
  const salts = [saltFor(payment.derivation_index)];
  let tokens: Address[];
  if (mode === "own") {
    // The payment's own asset on the recovery chain (same symbol): a wrong-chain deposit is usually that very token.
    const own = getAssetOrNull(`${chain}:${payment.asset.split(":")[1]}`)?.contract;
    tokens = own ? [own as Address] : [];
  } else if (mode === "custom") tokens = [token!];
  else {
    tokens = chainAssets(chain).filter((a) => a.contract).map((a) => a.contract as Address);
    if (token && !tokens.some((t) => t.toLowerCase() === token.toLowerCase())) tokens.push(token);
  }
  const gas = await estimate(c, salts, tokens);
  if (gas === "revert") return { status: "failed", reason: "flush estimate reverted", paymentIds: [payment.id] };
  return send(env, c, "recover", [payment.id], salts, tokens, await quote(c, (gas * 12n) / 10n), now, payment.chain === chain);
}
