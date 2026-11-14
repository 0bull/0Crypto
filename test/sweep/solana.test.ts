import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signedIn, type AdminTestSession } from "../admin-session";
import { solDepositKey, solHotKey } from "../../src/signing/keys";
import { findAta } from "../../src/chains/solana/pda";
import { clearGenesisMemo, SOL_MAINNET_GENESIS } from "../../src/chains/solana/rpc";
import { CU_PRICE_MICROLAMPORTS, MAX_TX_BYTES } from "../../src/chains/solana/sweeptx";
import { recordAlert } from "../../src/db/alerts";
import { getPayment, insertInvoice, insertPayment, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { runSweeps } from "../../src/sweep/cron";
import { MAX_SOL_FAILURES, MAX_TOKEN_ACCOUNTS_PER_DEPOSIT, NEEDS_ADMIN, runSolanaSweep, SOL_SUBREQUEST_BUDGET } from "../../src/sweep/solana";
import { offline } from "../offline";

const e = env as unknown as Env;
const RPC = "https://sol.test/rpc";
const RPC2 = "https://sol2.test/rpc";
const BASE = "https://pay.test";
/** The signed-in admin session (set in beforeAll) and its CSRF token. */
let S: AdminTestSession;
let CSRF = "";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const CB = "ComputeBudget111111111111111111111111111111";
const HOT = solHotKey(e.MASTER_SEED!).address;
const HOT_ATA = findAta(HOT, USDC)[0];
const ATA_RENT = 2_039_280n;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = 1_900_000_000_000;
const SOL_AMT = 1_000_000_000n;
const USDC_AMT = 25_000_000n;
const saved = { ENABLED_ASSETS: e.ENABLED_ASSETS, SOLANA_RPC_URL: e.SOLANA_RPC_URL };

type Tok = { pubkey: string; amount: bigint; state?: string; tokenOwner?: string };
type Ix = { program: string; accounts: string[]; data: number[] };
interface Sent {
  sig: string;
  signers: string[];
  ixs: Ix[];
  size: number;
  /** The sweeps row and the locked payments as D1 had them when sendTransaction arrived. */
  rowAtSend: { status: string; step: string } | null;
  lockedAtSend: string[];
  /** Every signature verified (checked after the test, not in the handler). */
  sigsValid: boolean;
  /** Refused by failIf or sendReply (never lands). */
  refused: boolean;
  landed?: boolean;
}
interface Barrier {
  method: string;
  n: number;
  arrived: number;
  met: boolean;
  release: () => void;
  wait: Promise<void>;
}
interface Sim {
  lamports: Record<string, bigint>;
  tokens: Record<string, Tok[]>;
  hotUsdc: bigint;
  /** Finalized block height, and the lastValidBlockHeight getLatestBlockhash hands out (height + 150). */
  height: number;
  bh: number;
  statuses: Record<string, { confirmationStatus: string; err: unknown } | undefined>;
  sent: Sent[];
  calls: { url: string; method: string; params: unknown[] }[];
  sendReply?: (id: number) => Response;
  /** Per-tx refusal (e.g. a deposit that always fails preflight). */
  failIf?: (s: Sent, id: number) => Response | undefined;
  /** getSignatureStatuses answers a JSON-RPC error when asked about any of these. */
  statusError?: Set<string>;
  /** URL that always answers 503. */
  down?: string;
  /** Called for every RPC request (e.g. to move a fake wall clock). */
  onCall?: (method: string) => void;
  barrier?: Barrier;
}
let sim: Sim;
let seq = 100;

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  S = await signedIn(e);
  CSRF = S.csrf;
  Object.assign(e, { ENABLED_ASSETS: "sol:sol,sol:usdc", SOLANA_RPC_URL: RPC });
  await insertInvoice(e.DB, {
    id: "inv_sol", created_at: T0 - 2 * HOUR, expires_at: T0 + HOUR, price_minor: 2500n, currency: "USD", order_id: null,
    metadata: null, success_url: null, allowed_assets: null, status: "paid", late: false, overpaid: false, paid_minor: 2500n,
  });
});
afterAll(() => {
  Object.assign(e, saved);
  network.disable();
});
afterEach(() => network.resetHandlers());
/** What every RPC call must look like: captured by the handler, asserted here (an expect in a handler is swallowed). */
const SHAPES: Record<string, (p: unknown[]) => unknown> = {
  getGenesisHash: (p) => expect(p).toEqual([]),
  getBalance: (p) => expect(p[1]).toEqual({ commitment: "confirmed" }),
  getTokenAccountsByOwner: (p) => expect(p.slice(1)).toEqual([{ mint: USDC }, { encoding: "jsonParsed", commitment: "confirmed" }]),
  getLatestBlockhash: (p) => expect(p).toEqual([{ commitment: "confirmed" }]),
  getBlockHeight: (p) => expect(p).toEqual([{ commitment: "finalized" }]),
  getSignatureStatuses: (p) => expect(p[1]).toEqual({ searchTransactionHistory: true }),
  sendTransaction: (p) => expect(p[1]).toEqual({ encoding: "base64", preflightCommitment: "confirmed" }),
};
afterEach(() => {
  for (const c of sim.calls) {
    expect(SHAPES[c.method], `unexpected RPC method ${c.method}`).toBeDefined();
    SHAPES[c.method]!(c.params);
  }
  for (const s of sim.sent) expect(s.sigsValid, `signatures of ${s.sig}`).toBe(true);
});
beforeEach(async () => {
  for (const t of ["payments", "sweeps", "alerts"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
  clearGenesisMemo();
  Object.assign(e, { SOLANA_RPC_URL: RPC });
  sim = { lamports: { [HOT]: 1_000_000_000n, [HOT_ATA]: ATA_RENT }, tokens: {}, hotUsdc: 0n, height: 5000, bh: 0, statuses: {}, sent: [], calls: [] };
  network.use(handler(RPC), handler(RPC2), ...offline());
});

function barrier(method: string, n = 2): Barrier {
  let release = () => {};
  const wait = new Promise<void>((r) => (release = r));
  const b: Barrier = { method, n, arrived: 0, met: false, release, wait };
  sim.barrier = b;
  return b;
}
async function gate(method: string) {
  const b = sim.barrier;
  if (!b || b.method !== method || b.arrived >= b.n) return;
  b.arrived++;
  if (b.arrived === b.n) {
    b.met = true;
    b.release();
  } else await Promise.race([b.wait, new Promise((r) => setTimeout(r, 2000))]);
}

const kit = () => import("@solana/kit");
async function decodeWire(wire: string) {
  const k = await kit();
  const bytes = Uint8Array.from(atob(wire), (c) => c.charCodeAt(0));
  const tx = k.getTransactionDecoder().decode(bytes) as unknown as { messageBytes: Uint8Array; signatures: Record<string, Uint8Array> };
  const m = k.getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
    header: { numSignerAccounts: number };
    staticAccounts: string[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
  };
  const ixs = m.instructions.map((ix) => ({ program: m.staticAccounts[ix.programAddressIndex]!, accounts: (ix.accountIndices ?? []).map((i) => m.staticAccounts[i]!), data: Array.from(ix.data ?? []) }));
  return { tx, m, ixs, size: bytes.length };
}

function acct(owner: string, t: Tok) {
  return {
    pubkey: t.pubkey,
    account: {
      lamports: Number(ATA_RENT), owner: TOKEN, executable: false,
      data: { program: "spl-token", space: 165, parsed: { type: "account", info: { state: t.state ?? "initialized", mint: USDC, owner: t.tokenOwner ?? owner, tokenAmount: { amount: t.amount.toString(), decimals: 6 } } } },
    },
  };
}

function handler(url: string) {
  return http.post(url, async ({ request }) => {
    const b = (await request.json()) as { id: number; method: string; params: unknown[] };
    sim.calls.push({ url, method: b.method, params: b.params });
    sim.onCall?.(b.method);
    if (sim.down === url) return new HttpResponse("down", { status: 503 });
    await gate(b.method);
    const reply = (result: unknown) => HttpResponse.json({ jsonrpc: "2.0", id: b.id, result });
    const ctx = { context: { slot: 1 } };
    const p = b.params;
    switch (b.method) {
      case "getGenesisHash":
        return reply(SOL_MAINNET_GENESIS);
      case "getBalance":
        return reply({ ...ctx, value: Number(sim.lamports[p[0] as string] ?? 0n) });
      case "getTokenAccountsByOwner": {
        const owner = p[0] as string;
        return reply({ ...ctx, value: (sim.tokens[owner] ?? []).map((t) => acct(owner, t)) });
      }
      case "getLatestBlockhash": {
        const blockhash = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? ++sim.bh : 7)));
        return reply({ ...ctx, value: { blockhash, lastValidBlockHeight: sim.height + 150 } });
      }
      case "getBlockHeight":
        return reply(sim.height);
      case "getSignatureStatuses":
        if ((p[0] as string[]).some((x) => sim.statusError?.has(x))) return HttpResponse.json({ jsonrpc: "2.0", id: b.id, error: { code: -32603, message: "internal" } });
        return reply({ ...ctx, value: (p[0] as string[]).map((s) => (sim.statuses[s] ? { slot: 1, confirmations: null, status: {}, ...sim.statuses[s] } : null)) });
      case "sendTransaction": {
        const { tx, m, ixs, size } = await decodeWire(p[0] as string);
        const sigsValid = Object.entries(tx.signatures).every(([addr, sig]) => ed25519.verify(sig, tx.messageBytes, base58.decode(addr)));
        const sig = base58.encode(tx.signatures[m.staticAccounts[0]!]!);
        const row = await e.DB.prepare("SELECT status, step FROM sweeps WHERE tx=?").bind(sig).first<{ status: string; step: string }>();
        const locked = (await e.DB.prepare("SELECT id FROM payments WHERE sweep_tx=? ORDER BY id").bind(sig).all<{ id: string }>()).results.map((r) => r.id);
        const sent: Sent = { sig, signers: m.staticAccounts.slice(0, m.header.numSignerAccounts), ixs, size, rowAtSend: row ?? null, lockedAtSend: locked, sigsValid, refused: false };
        sim.sent.push(sent);
        const refusal = sim.failIf?.(sent, b.id) ?? sim.sendReply?.(b.id);
        if (refusal) {
          sent.refused = true;
          return refusal;
        }
        return reply(sig);
      }
    }
    return HttpResponse.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "method not found" } });
  });
}

const u64At = (d: number[], o: number) => new DataView(Uint8Array.from(d).buffer).getBigUint64(o, true);
/** The tx lands and is finalized: balances move as the instructions say (or only the fee, if it fails). */
function land(s: Sent, err: unknown = null) {
  s.landed = true;
  sim.lamports[HOT] = (sim.lamports[HOT] ?? 0n) - 5000n * BigInt(s.signers.length);
  sim.statuses[s.sig] = { confirmationStatus: "finalized", err };
  if (err) return;
  for (const ix of s.ixs) {
    if (ix.program === SYSTEM && ix.data[0] === 2) {
      const amt = u64At(ix.data, 4);
      sim.lamports[ix.accounts[0]!] = (sim.lamports[ix.accounts[0]!] ?? 0n) - amt;
      sim.lamports[ix.accounts[1]!] = (sim.lamports[ix.accounts[1]!] ?? 0n) + amt;
    } else if (ix.program === ATA_PROGRAM && !sim.lamports[HOT_ATA]) {
      sim.lamports[HOT_ATA] = ATA_RENT;
      sim.lamports[HOT] -= ATA_RENT;
    } else if (ix.program === TOKEN && ix.data[0] === 12) {
      const t = sim.tokens[ix.accounts[3]!]!.find((x) => x.pubkey === ix.accounts[0])!;
      t.amount -= u64At(ix.data, 1);
      sim.hotUsdc += u64At(ix.data, 1);
    } else if (ix.program === TOKEN && ix.data[0] === 9) {
      sim.tokens[ix.accounts[2]!] = sim.tokens[ix.accounts[2]!]!.filter((x) => x.pubkey !== ix.accounts[0]);
      sim.lamports[ix.accounts[1]!] = (sim.lamports[ix.accounts[1]!] ?? 0n) + ATA_RENT;
    }
  }
}

async function mk(o: Partial<PaymentRow> & { lamports?: bigint; usdc?: Tok[] } = {}): Promise<PaymentRow> {
  const i = seq++;
  const { lamports, usdc, ...rest } = o;
  const asset = rest.asset ?? "sol:sol";
  const address = solDepositKey(e.MASTER_SEED!, i).address;
  const amt = asset === "sol:sol" ? SOL_AMT : USDC_AMT;
  const p: PaymentRow = {
    id: `pay_sol${i}`, invoice_id: "inv_sol", asset, chain: "sol", address, derivation_index: i, reference: null, expected: amt, price_e8: 10n ** 8n,
    rate_locked_until: 0, received: amt, final: amt, txids: [], status: "confirmed", created_at: T0 - 2 * HOUR, detected_at: T0 - 2 * HOUR,
    confirmed_at: T0 - HOUR + i, credited_minor: 2500n, credit_price_e8: 10n ** 8n, unexpected: null, swept_at: null, sweep_tx: null, sweep_error: null,
    sweep_retry_at: null, ...rest,
  };
  await insertPayment(e.DB, p);
  sim.lamports[address] = lamports ?? (asset === "sol:sol" ? SOL_AMT : 0n);
  sim.tokens[address] = usdc ?? (asset === "sol:usdc" ? [{ pubkey: findAta(address, USDC)[0], amount: USDC_AMT }] : []);
  return p;
}
const run = (t = T0) => runSolanaSweep(e, t);
const sweeps = async () => (await e.DB.prepare("SELECT * FROM sweeps ORDER BY created_at, rowid").all<Record<string, string | number | null>>()).results;
const pendingRows = async () => (await sweeps()).filter((r) => r.status === "pending");
const alerts = async () => (await e.DB.prepare("SELECT * FROM alerts ORDER BY created_at").all<Record<string, string | number | null>>()).results;
const kinds = async () => (await alerts()).map((a) => a.kind);
const count = (m: string) => sim.calls.filter((c) => c.method === m).length;
const failures = async (id: string) => (await e.DB.prepare("SELECT sweep_paid_attempts AS n FROM payments WHERE id=?").bind(id).first<{ n: number }>())!.n;
const rpcError = (message = "Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1") => (id: number) =>
  HttpResponse.json({ jsonrpc: "2.0", id, error: { code: -32002, message } });

describe("runSolanaSweep: SOL and USDC deposits", () => {
  it("a SOL deposit: hot pays the fee, the whole balance goes to hot, the lock is written before the send; finalized -> swept", async () => {
    const p = await mk();
    const r = await run();
    expect(r.status).toBe("sent");
    expect(sim.sent).toHaveLength(1);
    const s = sim.sent[0]!;
    expect(r.tx).toBe(s.sig);
    expect(s.signers.sort()).toEqual([HOT, p.address].sort());
    expect(s.ixs.map((i) => i.program)).toEqual([CB, CB, SYSTEM]);
    expect(s.ixs[2]).toMatchObject({ accounts: [p.address, HOT] });
    expect(u64At(s.ixs[2]!.data, 4)).toBe(SOL_AMT);
    // Lock and pending row were in D1 before sendTransaction arrived.
    expect(s.rowAtSend).toEqual({ status: "pending", step: "signed" });
    expect(s.lockedAtSend).toEqual([p.id]);
    const [row] = await sweeps();
    expect(row).toMatchObject({ chain: "sol", status: "pending", step: "sent", tx: s.sig, payment_ids: JSON.stringify([p.id]) });
    const meta = JSON.parse(row!.meta as string);
    expect(meta.lastValidBlockHeight).toBe(String(5150));
    expect(JSON.stringify(meta)).not.toMatch(/priv/i);

    // Not finalized yet: nothing changes.
    sim.statuses[s.sig] = { confirmationStatus: "confirmed", err: null };
    expect((await run(T0 + 15 * MIN)).status).toBe("skipped");
    expect((await getPayment(e.DB, p.id))!.swept_at).toBeNull();
    land(s);
    await run(T0 + 30 * MIN);
    const after = (await getPayment(e.DB, p.id))!;
    expect(after.swept_at).toBe(T0 + 30 * MIN);
    expect(after.sweep_tx).toBe(s.sig);
    expect((await sweeps())[0]!.status).toBe("confirmed");
    expect(sim.lamports[p.address]).toBe(0n);
    expect(sim.sent).toHaveLength(1);
    expect(await alerts()).toEqual([]);
  });

  it("a USDC deposit: ATA idempotent (payer hot), transferChecked of the exact balance, closeAccount to hot", async () => {
    const p = await mk({ asset: "sol:usdc" });
    await run();
    const s = sim.sent[0]!;
    const ata = findAta(p.address, USDC)[0];
    expect(s.ixs.map((i) => i.program)).toEqual([CB, CB, ATA_PROGRAM, TOKEN, TOKEN]);
    expect(s.ixs[2]!.accounts).toEqual([HOT, HOT_ATA, HOT, USDC, SYSTEM, TOKEN]);
    expect(s.ixs[3]!.accounts).toEqual([ata, USDC, HOT_ATA, p.address]);
    expect([u64At(s.ixs[3]!.data, 1), s.ixs[3]!.data[9]]).toEqual([USDC_AMT, 6]);
    expect(s.ixs[4]).toEqual({ program: TOKEN, accounts: [ata, HOT, p.address], data: [9] });
    land(s);
    await run(T0 + 15 * MIN);
    expect((await getPayment(e.DB, p.id))!.swept_at).toBe(T0 + 15 * MIN);
    expect(sim.hotUsdc).toBe(USDC_AMT);
  });

  it("SOL and USDC on the same deposit both go in one tx (the unexpected asset is swept too)", async () => {
    const p = await mk({ asset: "sol:usdc", lamports: 3_000_000n });
    await run();
    const s = sim.sent[0]!;
    expect(s.ixs.map((i) => [i.program, i.data[0]])).toEqual([[CB, 2], [CB, 3], [ATA_PROGRAM, 1], [TOKEN, 12], [TOKEN, 9], [SYSTEM, 2]]);
    expect(u64At(s.ixs[5]!.data, 4)).toBe(3_000_000n);
    land(s);
    expect([sim.lamports[p.address], sim.tokens[p.address]]).toEqual([0n, []]);
  });

  it("every USDC account the deposit owns is transferred and closed, not only the ATA", async () => {
    const other = solDepositKey(e.MASTER_SEED!, 7000).address; // a non-ATA token account owned by the deposit
    const p = await mk({ asset: "sol:usdc", usdc: [{ pubkey: "PLACEHOLDER", amount: 10n }, { pubkey: other, amount: 20_000_000n }] });
    sim.tokens[p.address]![0]!.pubkey = findAta(p.address, USDC)[0];
    await run();
    const s = sim.sent[0]!;
    const token = s.ixs.filter((i) => i.program === TOKEN);
    expect(token.map((i) => [i.data[0], i.accounts[0]])).toEqual([[12, other], [9, other], [12, findAta(p.address, USDC)[0]], [9, findAta(p.address, USDC)[0]]]);
    land(s);
    expect(sim.hotUsdc).toBe(20_000_010n);
  });

  it("a frozen USDC account is skipped (never transferred or closed) and the payment is marked unexpected_left", async () => {
    const frozen = solDepositKey(e.MASTER_SEED!, 7001).address;
    const p = await mk({ asset: "sol:usdc" });
    sim.tokens[p.address]!.push({ pubkey: frozen, amount: 99n, state: "frozen" });
    await run();
    const s = sim.sent[0]!;
    expect(s.ixs.flatMap((i) => i.accounts)).not.toContain(frozen);
    land(s);
    await run(T0 + 15 * MIN);
    const after = (await getPayment(e.DB, p.id))!;
    expect(after.swept_at).toBe(T0 + 15 * MIN);
    expect(after.unexpected_left).toBe(1);
  });

  it(`more than ${MAX_TOKEN_ACCOUNTS_PER_DEPOSIT} USDC accounts: the largest ${MAX_TOKEN_ACCOUNTS_PER_DEPOSIT} go, the payment is marked unexpected_left`, async () => {
    const usdc = Array.from({ length: 15 }, (_, i) => ({ pubkey: solDepositKey(e.MASTER_SEED!, 7100 + i).address, amount: BigInt(100 + i) }));
    const p = await mk({ asset: "sol:usdc", usdc });
    await run();
    const s = sim.sent[0]!;
    expect(s.size).toBeLessThanOrEqual(MAX_TX_BYTES);
    const moved = s.ixs.filter((i) => i.program === TOKEN && i.data[0] === 12).map((i) => u64At(i.data, 1));
    expect(moved).toEqual(Array.from({ length: MAX_TOKEN_ACCOUNTS_PER_DEPOSIT }, (_, i) => BigInt(114 - i)));
    land(s);
    await run(T0 + 15 * MIN);
    expect((await getPayment(e.DB, p.id))!.unexpected_left).toBe(1);
  });

  it("a deposit holding only a frozen account: nothing is signed; payment_failed names the frozen account", async () => {
    const p = await mk({ asset: "sol:usdc", usdc: [{ pubkey: solDepositKey(e.MASTER_SEED!, 7002).address, amount: 5n, state: "frozen" }] });
    await run();
    expect(sim.sent).toEqual([]);
    const a = (await alerts()).find((x) => x.kind === "sweep.payment_failed");
    expect(String(a?.detail)).toMatch(/frozen/);
    expect((await getPayment(e.DB, p.id))!.sweep_retry_at).toBeGreaterThan(T0);
  });
});

describe("runSolanaSweep: batching", () => {
  it("10 small SOL deposits give 2 txs: 8 (the cap), then 2 once the first is final", async () => {
    const ps: PaymentRow[] = [];
    for (let i = 0; i < 10; i++) ps.push(await mk({ lamports: 2_000_000n + BigInt(i) }));
    await run();
    expect(sim.sent).toHaveLength(1);
    const first = sim.sent[0]!;
    expect(first.signers).toHaveLength(9);
    expect(first.size).toBeLessThanOrEqual(MAX_TX_BYTES);
    expect(first.lockedAtSend).toEqual(ps.slice(0, 8).map((p) => p.id).sort());
    land(first);
    await run(T0 + 15 * MIN);
    expect(sim.sent).toHaveLength(2);
    expect(sim.sent[1]!.signers.sort()).toEqual([HOT, ps[8]!.address, ps[9]!.address].sort());
    land(sim.sent[1]!);
    await run(T0 + 30 * MIN);
    for (const p of ps) expect((await getPayment(e.DB, p.id))!.swept_at).not.toBeNull();
  });

  it("a USDC-heavy batch splits by size, not by the cap", async () => {
    const ps: PaymentRow[] = [];
    for (let i = 0; i < 8; i++) {
      const p = await mk({ asset: "sol:usdc", lamports: 1_000_000n });
      sim.tokens[p.address]!.push({ pubkey: solDepositKey(e.MASTER_SEED!, 8000 + i).address, amount: 3n });
      ps.push(p);
    }
    await run();
    const s = sim.sent[0]!;
    const deposits = s.signers.length - 1;
    expect(deposits).toBeGreaterThan(1);
    expect(deposits).toBeLessThan(8);
    expect(s.size).toBeLessThanOrEqual(MAX_TX_BYTES);
    // Oldest first: the first tx holds exactly the first `deposits` deposits, the second starts with the next one.
    expect([...s.signers].sort()).toEqual([HOT, ...ps.slice(0, deposits).map((p) => p.address)].sort());
    land(s);
    await run(T0 + 15 * MIN);
    const s2 = sim.sent[1]!;
    const second = s2.signers.filter((x) => x !== HOT);
    expect([...second].sort()).toEqual(ps.slice(deposits, deposits + second.length).map((p) => p.address).sort());
    expect(second).toContain(ps[deposits]!.address);
    for (const p of ps.slice(0, deposits)) expect((await getPayment(e.DB, p.id))!.swept_at).toBe(T0 + 15 * MIN);
  });

  it("the run stays within the subrequest budget even when the first RPC URL is down; unread deposits wait for the next run", async () => {
    Object.assign(e, { SOLANA_RPC_URL: `${RPC},${RPC2}` });
    sim.down = RPC;
    // Empty deposits: each costs its reads and goes nowhere, so only the budget stops the run.
    const ps: PaymentRow[] = [];
    for (let i = 0; i < 30; i++) ps.push(await mk({ lamports: 0n }));
    await run();
    expect(sim.calls.length).toBeLessThanOrEqual(SOL_SUBREQUEST_BUDGET);
    const read = (await Promise.all(ps.map((p) => getPayment(e.DB, p.id)))).filter((p) => p!.sweep_retry_at !== null).length;
    expect(read).toBeGreaterThan(5);
    expect(read).toBeLessThan(30);
  });
});

describe("runSolanaSweep: send and reconcile", () => {
  it("a JSON-RPC error from sendTransaction: the sweep fails, swept_at stays null, the lock is released, alert, backoff", async () => {
    const p = await mk();
    sim.sendReply = rpcError();
    const r = await run();
    expect(r.status).toBe("failed");
    const [row] = await sweeps();
    expect(row).toMatchObject({ status: "failed" });
    expect(String(row!.error)).toMatch(/refused/);
    const after = (await getPayment(e.DB, p.id))!;
    expect(after.swept_at).toBeNull();
    expect(after.sweep_tx).toBeNull();
    expect(after.sweep_retry_at).toBe(T0 + HOUR);
    expect(await failures(p.id)).toBe(1);
    expect(await kinds()).toContain("sweep.failing");
    // Backed off: the next run (before the retry time) leaves it alone.
    await run(T0 + 15 * MIN);
    expect(sim.sent).toHaveLength(1);
  });

  it("an ambiguous send (HTTP 503) stays pending; reconcile settles it once finalized", async () => {
    const p = await mk();
    sim.sendReply = () => new HttpResponse("bad gateway", { status: 503 });
    const r = await run();
    expect(r.status).toBe("sent");
    let [row] = await pendingRows();
    expect(row).toMatchObject({ step: "signed" });
    expect((await getPayment(e.DB, p.id))!.sweep_tx).toBe(sim.sent[0]!.sig);
    sim.sendReply = undefined;
    land(sim.sent[0]!);
    await run(T0 + 15 * MIN);
    [row] = await sweeps();
    expect(row!.status).toBe("confirmed");
    expect((await getPayment(e.DB, p.id))!.swept_at).toBe(T0 + 15 * MIN);
    expect(count("sendTransaction")).toBe(1);
  });

  it("status null while the finalized height is at or below lastValidBlockHeight: keeps waiting", async () => {
    await mk();
    await run();
    sim.height += 150;
    expect((await run(T0 + 15 * MIN)).status).toBe("skipped");
    expect(await pendingRows()).toHaveLength(1);
  });

  it("blockhash expiry (status null and finalized height past lastValidBlockHeight) is dropped: released and retried at once", async () => {
    const p = await mk();
    await run();
    const old = sim.sent[0]!.sig;
    sim.height += 151;
    const r = await run(T0 + 15 * MIN);
    const rows = await sweeps();
    expect(rows[0]).toMatchObject({ status: "failed", error: "dropped", tx: old });
    expect(await kinds()).toContain("sweep.failing");
    // Retried in the same run with a fresh tx; a drop costs nothing, so it is not a counted failure.
    expect(r.status).toBe("sent");
    expect(sim.sent).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: "pending" });
    expect((await getPayment(e.DB, p.id))!.sweep_tx).toBe(sim.sent[1]!.sig);
    expect(await failures(p.id)).toBe(0);
  });

  it("err non-null at finalized: failed, released, alert, backoff, counted", async () => {
    const p = await mk();
    await run();
    land(sim.sent[0]!, { InstructionError: [2, { Custom: 1 }] });
    await run(T0 + 15 * MIN);
    expect((await sweeps())[0]).toMatchObject({ status: "failed" });
    const after = (await getPayment(e.DB, p.id))!;
    expect([after.swept_at, after.sweep_tx]).toEqual([null, null]);
    expect(after.sweep_retry_at).toBe(T0 + 15 * MIN + HOUR);
    expect(await failures(p.id)).toBe(1);
    expect(await kinds()).toContain("sweep.payment_failed");
  });

  it(`after ${MAX_SOL_FAILURES} consecutive failures the payment needs an admin; Retry sweep resets it`, async () => {
    const p = await mk();
    sim.sendReply = rpcError();
    let t = T0;
    for (let i = 0; i < MAX_SOL_FAILURES; i++) {
      await run(t);
      t = (await getPayment(e.DB, p.id))!.sweep_retry_at! + 1;
    }
    expect(sim.sent).toHaveLength(MAX_SOL_FAILURES);
    const after = (await getPayment(e.DB, p.id))!;
    expect(after.sweep_error).toMatch(NEEDS_ADMIN);
    expect(after.sweep_retry_at).toBeGreaterThan(T0 + 365 * DAY);
    const na = (await alerts()).filter((a) => a.kind === "sweep.needs_admin");
    expect(na.some((a) => String(a.detail).includes(p.id) && /Retry sweep/.test(String(a.detail)))).toBe(true);
    await run(T0 + 30 * DAY);
    expect(sim.sent).toHaveLength(MAX_SOL_FAILURES);

    const cookie = S.cookie;
    const html = await (await exports.default.fetch(`${BASE}/admin/invoices/inv_sol`, { headers: { cookie, "cf-connecting-ip": "10.9.0.1" } })).text();
    expect(html).toContain(`/admin/payments/${p.id}/retry-sweep`);
    const path = `/admin/payments/${p.id}/retry-sweep`;
    expect(html).toContain('data-passkey-confirm="sweep.retry"');
    const ok = await exports.default.fetch(`${BASE}${path}`, {
      method: "POST", redirect: "manual", body: new URLSearchParams({ csrf: CSRF, assertion: await S.confirm("sweep.retry", path, {}) }),
      headers: { cookie, "cf-connecting-ip": "10.9.0.2", "content-type": "application/x-www-form-urlencoded" },
    });
    expect(ok.status).toBe(303);
    const reset = (await getPayment(e.DB, p.id))!;
    expect([reset.sweep_error, reset.sweep_retry_at, await failures(p.id)]).toEqual([null, null, 0]);
    sim.sendReply = undefined;
    expect((await run(T0 + 31 * DAY)).status).toBe("sent");
  });

  it("two concurrent runs that really overlap produce a single pending row and one send", async () => {
    await mk();
    await mk({ asset: "sol:usdc" });
    const b = barrier("getLatestBlockhash");
    await Promise.all([run(), run()]);
    expect(b.met).toBe(true);
    expect(await pendingRows()).toHaveLength(1);
    expect(sim.sent).toHaveLength(1);
    expect((await e.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE sweep_tx IS NOT NULL").first<{ n: number }>())!.n).toBe(2);
  });
});

describe("runSolanaSweep: safety checks", () => {
  it("hot SOL too low for fees + the missing hot ATA's rent + margin: sweep.insufficient_gas, nothing signed", async () => {
    await mk({ asset: "sol:usdc" });
    delete sim.lamports[HOT_ATA];
    sim.lamports[HOT] = 2_000_000n; // fees and the reserve, but not the ATA rent
    const r = await run();
    expect(r.status).toBe("skipped");
    expect(sim.sent).toEqual([]);
    expect(await kinds()).toEqual(["sweep.insufficient_gas"]);
    expect(await sweeps()).toEqual([]);
    // Once hot's ATA exists the same balance is enough.
    sim.lamports[HOT_ATA] = ATA_RENT;
    expect((await run(T0 + 15 * MIN)).status).toBe("sent");
  });

  it("an RPC that lists hot's ATA as the deposit's token account: sweep.tx_mismatch, nothing signed or sent", async () => {
    const p = await mk({ asset: "sol:usdc", usdc: [{ pubkey: HOT_ATA, amount: 5n }] });
    const r = await run();
    expect(r.status).toBe("failed");
    expect(count("sendTransaction")).toBe(0);
    expect(await kinds()).toContain("sweep.tx_mismatch");
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "tx_mismatch" });
    const after = (await getPayment(e.DB, p.id))!;
    expect(after.sweep_tx).toBeNull();
    expect(after.sweep_retry_at).toBeGreaterThan(T0);
    expect(await failures(p.id)).toBe(1);
  });

  it("an empty deposit whose earlier sweep tx landed (the row was marked failed) is marked swept without a send", async () => {
    const p = await mk({ lamports: 0n });
    const earlier = base58.encode(new Uint8Array(64).fill(9));
    await e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,error,step,meta,req) VALUES('swp_old','sol',?,?,'failed',?,'marked failed by an admin','sent','{}',?)")
      .bind(earlier, T0 - HOUR, JSON.stringify([p.id]), JSON.stringify({ at: T0 - HOUR }))
      .run();
    sim.statuses[earlier] = { confirmationStatus: "finalized", err: null };
    const r = await run();
    expect(r.status).toBe("idle");
    expect(sim.sent).toEqual([]);
    const after = (await getPayment(e.DB, p.id))!;
    expect([after.swept_at, after.sweep_tx]).toEqual([T0, earlier]);
  });

  it("an empty deposit with no landed sweep: backoff and payment_failed", async () => {
    const p = await mk({ lamports: 0n });
    await run();
    expect(sim.sent).toEqual([]);
    expect((await getPayment(e.DB, p.id))!.sweep_retry_at).toBeGreaterThan(T0);
    expect(await kinds()).toEqual(["sweep.payment_failed"]);
  });

  it("a payment whose derived key does not match its address is not swept", async () => {
    const p = await mk();
    await e.DB.prepare("UPDATE payments SET derivation_index=? WHERE id=?").bind(p.derivation_index + 5000, p.id).run();
    await run();
    expect(sim.sent).toEqual([]);
    expect(await kinds()).toEqual(["sweep.payment_failed"]);
  });

  it("no log, error, sweep row or alert carries key material", async () => {
    const p = await mk();
    sim.sendReply = rpcError();
    await run();
    const dump = JSON.stringify({ s: await sweeps(), a: await alerts(), p: await getPayment(e.DB, p.id) }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const key of [solHotKey(e.MASTER_SEED!), solDepositKey(e.MASTER_SEED!, p.derivation_index)]) {
      expect(dump).not.toContain(base58.encode(key.priv));
      expect(dump).not.toContain(Array.from(key.priv).join(","));
    }
  });
});

describe("runSweeps: Solana registration", () => {
  it("runs the Solana sweeper only when the sol chain is configured", async () => {
    await mk();
    expect((await runSweeps(e, T0)).sol?.status).toBe("sent");
    Object.assign(e, { SOLANA_RPC_URL: "" });
    expect((await runSweeps(e, T0 + 15 * MIN)).sol).toBeUndefined();
  });

  it("Retry sweep is refused for a payment that is not Tron or Solana", async () => {
    const evm = await mk({ chain: "base", asset: "base:usdc" });
    await e.DB.prepare("UPDATE payments SET sweep_error='flush estimate reverted' WHERE id=?").bind(evm.id).run();
    const cookie = S.cookie;
    const path = `/admin/payments/${evm.id}/retry-sweep`;
    const r = await exports.default.fetch(`${BASE}${path}`, {
      method: "POST", redirect: "manual", body: new URLSearchParams({ csrf: CSRF, assertion: await S.confirm("sweep.retry", path, {}) }),
      headers: { cookie, "cf-connecting-ip": "10.9.1.1", "content-type": "application/x-www-form-urlencoded" },
    });
    expect(r.status).toBe(409);
    expect(await r.text()).toMatch(/only a Tron or Solana payment whose sweep stopped/i);
  });
});

/** Runs the sweeper every `step`, landing every tx that was not refused, until `until` or `n` runs. */
async function drive(n: number, step: number, t = T0) {
  for (let i = 0; i < n; i++, t += step) {
    await run(t);
    for (const s of sim.sent) if (!s.refused && !s.landed) land(s);
  }
  return t;
}
const preflightFail = (bad: Set<string>) => (s: Sent, id: number) => {
  const i = s.ixs.findIndex((ix) => bad.has(ix.accounts[0]!) || bad.has(ix.accounts.at(-1)!));
  return i < 0 ? undefined : rpcError(`Transaction simulation failed: Error processing Instruction ${i}: custom program error: 0x1`)(id);
};
const solo = async (id: string) => (await e.DB.prepare("SELECT sweep_solo AS s FROM payments WHERE id=?").bind(id).first<{ s: number }>())!.s;

describe("runSolanaSweep: batch failures blame nobody", () => {
  it("a batch of 4 where one deposit always fails: the 3 innocent payments are swept, only the offender needs an admin", async () => {
    const ps: PaymentRow[] = [];
    for (let i = 0; i < 4; i++) ps.push(await mk({ lamports: 2_000_000n + BigInt(i) }));
    const offender = ps[2]!;
    sim.failIf = preflightFail(new Set([offender.address]));
    // Run 1: the batch is refused. Nobody is counted; everyone goes solo; the alert names the offending deposit.
    await run();
    expect(sim.sent[0]!.signers).toHaveLength(5);
    for (const p of ps) expect([await failures(p.id), await solo(p.id), (await getPayment(e.DB, p.id))!.sweep_retry_at]).toEqual([0, 1, null]);
    expect((await alerts()).some((a) => a.kind === "sweep.failing" && String(a.detail).includes(offender.address))).toBe(true);
    await drive(15, 7 * HOUR, T0 + 15 * MIN);
    // From then on one deposit per tx.
    expect(sim.sent.slice(1).every((s) => s.signers.length === 2)).toBe(true);
    for (const p of ps.filter((x) => x !== offender)) {
      const after = (await getPayment(e.DB, p.id))!;
      expect(after.swept_at, p.id).not.toBeNull();
      expect(await failures(p.id)).toBe(0);
    }
    const bad = (await getPayment(e.DB, offender.id))!;
    expect(bad.swept_at).toBeNull();
    expect(bad.sweep_error).toMatch(NEEDS_ADMIN);
    expect(await failures(offender.id)).toBe(MAX_SOL_FAILURES);
    const na = (await alerts()).filter((a) => a.kind === "sweep.needs_admin");
    expect(na.map((a) => String(a.detail).includes(offender.id))).toEqual([true]);
  });

  it("an on-chain error in a batch maps its InstructionError index to the deposit and counts nobody", async () => {
    const ps = [await mk(), await mk()];
    await run();
    const s = sim.sent[0]!;
    const i = s.ixs.findIndex((ix) => ix.accounts[0] === ps[1]!.address);
    land(s, { InstructionError: [i, { Custom: 1 }] });
    await run(T0 + 15 * MIN);
    for (const p of ps) expect([await failures(p.id), await solo(p.id)]).toEqual([0, 1]);
    const a = (await alerts()).find((x) => x.kind === "sweep.payment_failed");
    expect(String(a?.detail)).toContain(ps[1]!.address);
    expect(String(a?.detail)).not.toContain(`deposit ${ps[0]!.address}`);
  });

  it("a JSON-RPC refusal other than -32002 (node behind, rate limit) is never counted: uncounted retry and sweep.failing", async () => {
    const p = await mk();
    for (const code of [-32005, -32429]) {
      sim.sendReply = (id) => HttpResponse.json({ jsonrpc: "2.0", id, error: { code, message: "slow down" } });
      await run(T0 + (code === -32005 ? 0 : 15 * MIN));
    }
    expect(sim.sent).toHaveLength(2);
    const after = (await getPayment(e.DB, p.id))!;
    expect([await failures(p.id), await solo(p.id), after.sweep_retry_at, after.sweep_tx]).toEqual([0, 0, null, null]);
    expect((await kinds()).filter((k) => k === "sweep.failing")).toEqual(["sweep.failing"]); // deduped
    sim.sendReply = undefined;
    expect((await run(T0 + 30 * MIN)).status).toBe("sent");
  });
});

describe("runSolanaSweep: drops and the priority fee", () => {
  it("after 3 consecutive drops of the same payments the CU price doubles (up to the cap)", async () => {
    await mk();
    const price = (s: Sent) => u64At(s.ixs[1]!.data, 1);
    for (let i = 0; i < 4; i++) {
      if (i > 0) sim.height += 151;
      await run(T0 + i * 15 * MIN);
    }
    expect(sim.sent).toHaveLength(4);
    expect(sim.sent.slice(0, 3).map(price)).toEqual([CU_PRICE_MICROLAMPORTS, CU_PRICE_MICROLAMPORTS, CU_PRICE_MICROLAMPORTS]);
    expect(price(sim.sent[3]!)).toBe(2n * CU_PRICE_MICROLAMPORTS);
  });
});

describe("runSolanaSweep: isolation and I5 details", () => {
  it("an RPC error while checking one empty deposit's earlier sweep skips that deposit only", async () => {
    const a = await mk({ lamports: 0n });
    const b = await mk();
    const earlier = base58.encode(new Uint8Array(64).fill(3));
    await e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,error,step,meta,req) VALUES('swp_old2','sol',?,?,'failed',?,'x','sent','{}',?)")
      .bind(earlier, T0 - HOUR, JSON.stringify([a.id]), JSON.stringify({ at: T0 - HOUR }))
      .run();
    sim.statusError = new Set([earlier]);
    expect((await run()).status).toBe("sent");
    expect(sim.sent[0]!.signers.sort()).toEqual([HOT, b.address].sort());
    const after = (await getPayment(e.DB, a.id))!;
    expect([after.swept_at, after.sweep_retry_at]).toEqual([null, null]); // untouched: looked at again next run
  });

  it("I5 carries unexpected_left over from the earlier sweep's meta", async () => {
    const p = await mk({ lamports: 0n });
    const earlier = base58.encode(new Uint8Array(64).fill(4));
    const meta = { deposits: [{ address: p.address, payments: [p.id], lamports: "0", tokens: [], left: true }] };
    await e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,error,step,meta,req) VALUES('swp_old3','sol',?,?,'failed',?,'x','sent',?,?)")
      .bind(earlier, T0 - HOUR, JSON.stringify([p.id]), JSON.stringify(meta), JSON.stringify({ at: T0 - HOUR }))
      .run();
    sim.statuses[earlier] = { confirmationStatus: "finalized", err: null };
    await run();
    const after = (await getPayment(e.DB, p.id))!;
    expect([after.swept_at, after.unexpected_left]).toEqual([T0, 1]);
  });
});

describe("alerts: every occurrence of sweep.needs_admin and sweep.tx_mismatch is recorded", () => {
  it("recordAlert dedupes by default; dedupe: false records each one", async () => {
    expect(await recordAlert(e.DB, "sweep.failing", "sol", "a", T0)).toBe(true);
    expect(await recordAlert(e.DB, "sweep.failing", "sol", "b", T0 + 1)).toBe(false);
    expect(await recordAlert(e.DB, "sweep.needs_admin", "sol", "c", T0, { dedupe: false })).toBe(true);
    expect(await recordAlert(e.DB, "sweep.needs_admin", "sol", "d", T0 + 1, { dedupe: false })).toBe(true);
    expect((await kinds()).filter((k) => k === "sweep.needs_admin")).toHaveLength(2);
  });

  it("two payments reaching needs_admin within the dedupe window both get their alert", async () => {
    const p = await mk();
    sim.sendReply = rpcError();
    let t = T0;
    for (let i = 0; i < MAX_SOL_FAILURES; i++) {
      if (i === MAX_SOL_FAILURES - 1) await recordAlert(e.DB, "sweep.needs_admin", "sol", "pay_other needs an admin", t - 1, { dedupe: false });
      await run(t);
      t = (await getPayment(e.DB, p.id))!.sweep_retry_at! + 1;
    }
    const na = (await alerts()).filter((a) => a.kind === "sweep.needs_admin");
    expect(na).toHaveLength(2);
    expect(na.some((a) => String(a.detail).includes(p.id))).toBe(true);
  });
});

describe("runSolanaSweep: final-wave fixes", () => {
  it("6 RPC URLs still sweep: fallback URLs cost requests only when used, so the budget counts at most 2 per call", async () => {
    const urls = Array.from({ length: 6 }, (_, i) => (i === 0 ? RPC : i === 1 ? RPC2 : `https://sol${i + 1}.test/rpc`));
    network.use(...urls.slice(2).map((u) => handler(u)));
    Object.assign(e, { SOLANA_RPC_URL: urls.join(",") });
    const p = await mk();
    expect((await run()).status).toBe("sent");
    expect(sim.sent).toHaveLength(1);
    expect(sim.calls.length).toBeLessThanOrEqual(SOL_SUBREQUEST_BUDGET);
    land(sim.sent[0]!);
    await run(T0 + 15 * MIN);
    expect((await getPayment(e.DB, p.id))!.swept_at).toBe(T0 + 15 * MIN);
  });

  it("a -32002 preflight refusal for 'Blockhash not found' is an uncounted retry, not a counted failure", async () => {
    const p = await mk();
    sim.sendReply = rpcError("Transaction simulation failed: Blockhash not found");
    expect((await run()).status).toBe("failed");
    const after = (await getPayment(e.DB, p.id))!;
    expect([await failures(p.id), await solo(p.id), after.sweep_retry_at, after.sweep_tx]).toEqual([0, 0, null, null]);
    expect(await kinds()).toEqual(["sweep.failing"]);
    sim.sendReply = undefined;
    expect((await run(T0 + 15 * MIN)).status).toBe("sent");
  });

  it("a -32002 that is not about the blockhash is still counted", async () => {
    const p = await mk();
    sim.sendReply = rpcError();
    await run();
    expect(await failures(p.id)).toBe(1);
  });
});

describe("runSolanaSweep: per-run deadline (wall time)", () => {
  it("sends nothing once 20 s of wall time have passed since the run began, even with deposits already read", async () => {
    const p = await mk();
    let wall = T0;
    sim.onCall = (m) => {
      if (m === "getTokenAccountsByOwner") wall += 20_000; // the deposit read took 20 s
    };
    const r = await runSolanaSweep(e, T0, { clock: () => wall });
    expect(sim.sent).toEqual([]);
    expect(count("getLatestBlockhash")).toBe(0);
    expect(await sweeps()).toEqual([]);
    expect((await getPayment(e.DB, p.id))!.sweep_tx).toBeNull();
    expect(r.reason).toMatch(/deadline/);
    sim.onCall = undefined;
    expect((await run(T0 + 15 * MIN)).status).toBe("sent");
  });

  it("reads no further deposit past the deadline", async () => {
    await mk();
    await mk();
    let wall = T0;
    sim.onCall = (m) => {
      if (m === "getTokenAccountsByOwner") wall += 20_000;
    };
    await runSolanaSweep(e, T0, { clock: () => wall });
    expect(count("getTokenAccountsByOwner")).toBe(1);
  });

  it("settles no pending sweep past the deadline", async () => {
    await mk();
    await run();
    const before = sim.calls.length;
    let first = true;
    const r = await runSolanaSweep(e, T0 + 15 * MIN, { clock: () => (first ? ((first = false), T0) : T0 + 20_000) });
    expect(sim.calls.length).toBe(before);
    expect(r.reason).toMatch(/deadline/);
  });
});
