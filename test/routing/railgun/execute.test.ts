import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, erc20Abi, keccak256, numberToHex, parseTransaction, type Address, type Hex } from "viem";
import { RAILGUN_SHIELD_ABI } from "../../../src/chains/evm/abi";
import { clearChainIdMemo, EVM_CHAINS, GAS_RESERVE, RAILGUN_PROXY, WRAPPED_NATIVE, type EvmChain } from "../../../src/chains/evm/config";
import { ASSETS, getAsset } from "../../../src/core/assets";
import { MAX_REPLACEMENTS, STUCK_AFTER_MS } from "../../../src/db/sweeps";
import type { Env } from "../../../src/env";
import { decode0zk } from "../../../src/routing/railgun/address";
import { RailgunConfigError, RailgunNotVerified, ShieldProgressMismatch, shieldOnEvm, type ShieldOptions, type ShieldProgress, type ShieldResult } from "../../../src/routing/railgun/execute";
import { railgunShieldKey } from "../../../src/signing/evm";
import { hotAccount } from "../../../src/signing/evmkeys";
import golden from "../../fixtures/railgun/golden.json";
import { offline } from "../../offline";
import { putPrice, dropPrice } from "../../prices/seed";

const e = env as unknown as Env;
const HOT = hotAccount(e).address.toLowerCase() as Address;
const RECEIVER = golden.addresses[0]!.address; // valid on every chain
const GWEI = 10n ** 9n;
const T = 1_900_000_000_000;
const URLS: Record<EvmChain, string> = { eth: "https://rpc.test/eth", base: "https://rpc.test/base", arb: "https://rpc.test/arb", polygon: "https://rpc.test/polygon", bsc: "https://rpc.test/bsc" };
const USDC_ARB = getAsset("arb:usdc").contract!.toLowerCase();
const USDT_ETH = getAsset("eth:usdt").contract!.toLowerCase();
const saved = {
  ...Object.fromEntries(Object.values(EVM_CHAINS).map((c) => [c.rpcVar, e[c.rpcVar]])),
  RAILGUN_GOLDEN_OK: e.RAILGUN_GOLDEN_OK,
  RAILGUN_GOLDEN_OK_CHAINS: e.RAILGUN_GOLDEN_OK_CHAINS,
  RAILGUN_0ZK_ADDRESS: e.RAILGUN_0ZK_ADDRESS,
};

// ---- A JSON-RPC node with just enough state for wrap / approve / shield ----

interface Node {
  chainId: number;
  native: Record<string, bigint>;
  /** `${token}:${owner}` */
  tokens: Record<string, bigint>;
  /** `${token}:${owner}:${spender}` */
  allowance: Record<string, bigint>;
  baseFee: bigint | null;
  priority: bigint;
  gasPrice: bigint;
  /** eth_getTransactionCount("pending") */
  nonce: number;
  /** eth_getTransactionCount("latest"); default nonce */
  latestNonce?: number;
  estimate: (to: string, data: Hex) => bigint | "revert";
  receipts: Record<string, { status: "success" | "reverted"; block: bigint }>;
  known: string[];
  head: bigint;
  finalized: bigint;
  sent: Hex[];
  methods: string[];
  /** Block parameter of every eth_call. */
  callBlocks: string[];
  sendError?: string;
  /** eth_getTransactionByHash knows every hash. */
  knowAll?: boolean;
}
const node = (chain: EvmChain): Node => ({
  chainId: EVM_CHAINS[chain].chainId,
  native: { [HOT]: 10n ** 18n },
  tokens: {},
  allowance: {},
  baseFee: 10n * GWEI,
  priority: GWEI,
  gasPrice: 5n * GWEI,
  nonce: 7,
  estimate: () => 100_000n,
  receipts: {},
  known: [],
  head: 1000n,
  finalized: 1000n,
  sent: [],
  methods: [],
  callBlocks: [],
});

function rpc(url: string, s: () => Node) {
  return http.post(url, async ({ request }) => {
    const { id, method, params } = (await request.json()) as { id: number; method: string; params: unknown[] };
    const n = s();
    n.methods.push(method);
    const ok = (result: unknown) => HttpResponse.json({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string) => HttpResponse.json({ jsonrpc: "2.0", id, error: { code, message } });
    const u256 = (v: bigint) => encodeAbiParameters([{ type: "uint256" }], [v]);
    switch (method) {
      case "eth_chainId":
        return ok(numberToHex(n.chainId));
      case "eth_getBalance":
        return ok(numberToHex(n.native[(params[0] as string).toLowerCase()] ?? 0n));
      case "eth_call": {
        const call = params[0] as { to: string; data: Hex };
        n.callBlocks.push(params[1] as string);
        const token = call.to.toLowerCase();
        const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: call.data });
        if (functionName === "balanceOf") return ok(u256(n.tokens[`${token}:${(args[0] as string).toLowerCase()}`] ?? 0n));
        if (functionName === "allowance") return ok(u256(n.allowance[`${token}:${(args[0] as string).toLowerCase()}:${(args[1] as string).toLowerCase()}`] ?? 0n));
        return err(-32601, `unmocked call ${functionName}`);
      }
      case "eth_estimateGas": {
        const call = params[0] as { to: string; data: Hex };
        const g = n.estimate(call.to.toLowerCase(), call.data);
        return g === "revert" ? err(3, "execution reverted") : ok(numberToHex(g));
      }
      case "eth_getTransactionCount":
        return ok(numberToHex(params[1] === "latest" ? (n.latestNonce ?? n.nonce) : n.nonce));
      case "eth_gasPrice":
        return ok(numberToHex(n.gasPrice));
      case "eth_maxPriorityFeePerGas":
        return ok(numberToHex(n.priority));
      case "eth_blockNumber":
        return ok(numberToHex(n.head));
      case "eth_getBlockByNumber": {
        const fin = params[0] === "finalized";
        return ok({
          number: numberToHex(fin ? n.finalized : n.head), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: numberToHex(1000n), transactions: [],
          ...(n.baseFee === null ? {} : { baseFeePerGas: numberToHex(n.baseFee) }),
        });
      }
      case "eth_sendRawTransaction": {
        if (n.sendError) return err(-32000, n.sendError);
        const raw = params[0] as Hex;
        n.sent.push(raw);
        n.known.push(keccak256(raw).toLowerCase());
        return ok(keccak256(raw));
      }
      case "eth_getTransactionByHash":
        return ok(n.knowAll || n.known.includes((params[0] as string).toLowerCase()) ? { hash: params[0] } : null);
      case "eth_getTransactionReceipt": {
        const hash = (params[0] as string).toLowerCase();
        const r = n.receipts[hash];
        if (!r) return ok(null);
        return ok({
          blockHash: `0x${"33".repeat(32)}`, blockNumber: numberToHex(r.block), contractAddress: null, cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1",
          from: HOT, gasUsed: "0x5208", logs: [], logsBloom: `0x${"00".repeat(256)}`, status: r.status === "success" ? "0x1" : "0x0",
          to: `0x${"55".repeat(20)}`, transactionHash: hash, transactionIndex: "0x0", type: "0x2",
        });
      }
      default:
        return err(-32601, `unmocked ${method}`);
    }
  });
}

/** Mines `raw` on `n`: applies what WETH.deposit, ERC-20 approve and Railgun shield do to the hot wallet. */
function mine(n: Node, raw: Hex, status: "success" | "reverted" = "success") {
  const t = parseTransaction(raw);
  const to = t.to!.toLowerCase();
  n.receipts[keccak256(raw).toLowerCase()] = { status, block: n.head };
  n.nonce = Math.max(n.nonce, t.nonce! + 1);
  n.latestNonce = n.nonce;
  if (status !== "success") return;
  const add = (k: string, v: bigint) => (n.tokens[k] = (n.tokens[k] ?? 0n) + v);
  if (t.data === "0xd0e30db0") {
    add(`${to}:${HOT}`, t.value!);
    n.native[HOT] = n.native[HOT]! - t.value!;
    return;
  }
  const sel = t.data!.slice(0, 10);
  if (sel === "0x095ea7b3") {
    const { args } = decodeFunctionData({ abi: erc20Abi, data: t.data! });
    n.allowance[`${to}:${HOT}:${(args[0] as string).toLowerCase()}`] = args[1] as bigint;
    return;
  }
  const { args } = decodeFunctionData({ abi: RAILGUN_SHIELD_ABI, data: t.data! });
  for (const r of args[0]) {
    const tok = r.preimage.token.tokenAddress.toLowerCase();
    add(`${tok}:${HOT}`, -r.preimage.value);
    n.allowance[`${tok}:${HOT}:${to}`] = (n.allowance[`${tok}:${HOT}:${to}`] ?? 0n) - r.preimage.value;
  }
}

type Sent = { to: string; chainId: number; nonce: number; value: bigint; fn: "deposit" | "approve" | "shield"; args: readonly unknown[]; raw: Hex };
function decode(raw: Hex): Sent {
  const t = parseTransaction(raw);
  const base = { to: t.to!.toLowerCase(), chainId: t.chainId!, nonce: t.nonce!, value: t.value ?? 0n, raw };
  if (t.data === "0xd0e30db0") return { ...base, fn: "deposit", args: [] };
  if (t.data!.startsWith("0x095ea7b3")) {
    const { args } = decodeFunctionData({ abi: erc20Abi, data: t.data! });
    return { ...base, fn: "approve", args };
  }
  const { functionName, args } = decodeFunctionData({ abi: RAILGUN_SHIELD_ABI, data: t.data! });
  expect(functionName).toBe("shield");
  return { ...base, fn: "shield", args };
}

const network = setupNetwork();
let nodes: Record<EvmChain, Node>;

beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});
beforeEach(async () => {
  nodes = Object.fromEntries((Object.keys(URLS) as EvmChain[]).map((c) => [c, node(c)])) as typeof nodes;
  for (const c of Object.keys(URLS) as EvmChain[]) {
    Object.assign(e, { [EVM_CHAINS[c].rpcVar]: URLS[c] });
    network.use(rpc(URLS[c], () => nodes[c]));
  }
  network.use(...offline());
  Object.assign(e, { RAILGUN_GOLDEN_OK: "1", RAILGUN_GOLDEN_OK_CHAINS: Object.keys(URLS).join(","), RAILGUN_0ZK_ADDRESS: RECEIVER });
  clearChainIdMemo();
  await e.DB.prepare("DELETE FROM alerts").run();
  for (const s of ["ETH", "USDT", "USDC"]) await putPrice(e, "USD", s, s === "ETH" ? 2000n * 10n ** 8n : 10n ** 8n);
});
afterEach(() => network.resetHandlers());
afterAll(() => {
  Object.assign(e, saved);
  network.disable();
});

/** Runs the shield to the end the way the router would: one call per run, each sent tx mined before the next run. */
async function drive(chain: EvmChain, asset: string, amount: bigint, o: Partial<Omit<ShieldOptions, "progress">> = {}, max = 8) {
  const results: ShieldResult[] = [];
  let progress: ShieldProgress | undefined;
  for (let i = 0; i < max; i++) {
    const r = await shieldOnEvm(e, chain, asset, amount, { ...P, ...o, progress, now: T + i * 900_000 });
    results.push(r);
    progress = r.progress;
    if (r.status !== "sent") break;
    mine(nodes[chain], nodes[chain].sent.at(-1)!);
  }
  return { results, sent: nodes[chain].sent.map(decode), last: results.at(-1)! };
}

/** The router's persist, accepting every write. */
const P = { persist: async () => true };
const alerts = async () => (await e.DB.prepare("SELECT kind, chain FROM alerts").all<{ kind: string; chain: string }>()).results;

describe("shieldOnEvm", () => {
  it("USDC on Arbitrum: approve(proxy, amount) then shield([request]) to 0xFA70…, value = amount, for the chain id", async () => {
    const amount = 250_000_000n;
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = amount;
    const { sent, last, results } = await drive("arb", "arb:usdc", amount);
    expect(results.map((r) => r.status)).toEqual(["sent", "sent", "shielded"]);
    expect(sent.map((s) => s.fn)).toEqual(["approve", "shield"]);
    expect(sent.every((s) => s.chainId === 42161 && s.value === 0n)).toBe(true);
    expect(sent.map((s) => s.nonce)).toEqual([7, 8]);
    const [approve, shield] = sent as [Sent, Sent];
    expect(approve.to).toBe(USDC_ARB);
    expect((approve.args[0] as string).toLowerCase()).toBe("0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9");
    expect(approve.args[1]).toBe(amount);
    expect(shield.to).toBe("0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9");
    const reqs = shield.args[0] as readonly { preimage: { npk: Hex; token: { tokenType: number; tokenAddress: string; tokenSubID: bigint }; value: bigint }; ciphertext: { encryptedBundle: readonly Hex[]; shieldKey: Hex } }[];
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.preimage.value).toBe(amount);
    const tok = reqs[0]!.preimage.token;
    expect([tok.tokenType, tok.tokenAddress.toLowerCase(), tok.tokenSubID]).toEqual([0, USDC_ARB, 0n]);
    // The note is for the receiver: the CTR part of the bundle decrypts, with our shield key, to its viewing key.
    const key = await crypto.subtle.importKey("raw", new Uint8Array(await railgunShieldKey(e)), "AES-CTR", false, ["decrypt"]);
    const b = (h: Hex) => Uint8Array.from(h.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));
    const iv = b(reqs[0]!.ciphertext.encryptedBundle[1]!).slice(16);
    const vpk = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter: iv, length: 128 }, key, b(reqs[0]!.ciphertext.encryptedBundle[2]!)));
    expect(Array.from(vpk)).toEqual(Array.from(decode0zk(RECEIVER).viewingPublicKey));
    expect(last).toMatchObject({ status: "shielded", tx: keccak256(shield.raw) });
    expect(last.txs).toEqual(sent.map((s) => keccak256(s.raw)));
    // Done is done: another call sends nothing and asks nothing.
    const methods = nodes.arb.methods.length;
    expect((await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: last.progress })).status).toBe("shielded");
    expect(nodes.arb.methods.length).toBe(methods);
  });

  it("ETH on Base: WETH.deposit{value: amount}, approve, then shield the wrapper to 0x0047…", async () => {
    const amount = 5n * 10n ** 17n;
    const { sent, last } = await drive("base", "base:eth", amount);
    expect(last.status).toBe("shielded");
    expect(sent.map((s) => s.fn)).toEqual(["deposit", "approve", "shield"]);
    expect(sent.every((s) => s.chainId === 8453)).toBe(true);
    const [deposit, approve, shield] = sent as [Sent, Sent, Sent];
    expect(deposit.to).toBe(WRAPPED_NATIVE.base.toLowerCase());
    expect(deposit.value).toBe(amount);
    expect(approve.to).toBe(WRAPPED_NATIVE.base.toLowerCase());
    expect([(approve.args[0] as string).toLowerCase(), approve.args[1]]).toEqual([RAILGUN_PROXY.base.toLowerCase(), amount]);
    expect(shield.to).toBe("0x0047d1f97674614189e80566575fb615788acf25");
    const reqs = shield.args[0] as readonly { preimage: { token: { tokenAddress: string }; value: bigint } }[];
    expect(reqs.map((r) => [r.preimage.token.tokenAddress.toLowerCase(), r.preimage.value])).toEqual([[WRAPPED_NATIVE.base.toLowerCase(), amount]]);
  });

  it("wraps only the shortfall when the hot wallet already holds some of the wrapper", async () => {
    const amount = 5n * 10n ** 17n;
    nodes.base.tokens[`${WRAPPED_NATIVE.base.toLowerCase()}:${HOT}`] = 2n * 10n ** 17n;
    const { sent } = await drive("base", "base:eth", amount);
    expect(sent.map((s) => [s.fn, s.value])).toEqual([["deposit", 3n * 10n ** 17n], ["approve", 0n], ["shield", 0n]]);
  });

  it("USDT on Ethereum with a lower nonzero allowance: approve(0), approve(amount), shield", async () => {
    const amount = 10_000n * 10n ** 6n;
    nodes.eth.tokens[`${USDT_ETH}:${HOT}`] = amount;
    nodes.eth.allowance[`${USDT_ETH}:${HOT}:${RAILGUN_PROXY.eth.toLowerCase()}`] = 3n;
    const { sent, last } = await drive("eth", "eth:usdt", amount);
    expect(last.status).toBe("shielded");
    expect(sent.map((s) => [s.fn, s.fn === "approve" ? s.args[1] : null])).toEqual([["approve", 0n], ["approve", amount], ["shield", null]]);
    expect(sent.every((s) => s.chainId === 1 && s.to === (s.fn === "shield" ? RAILGUN_PROXY.eth.toLowerCase() : USDT_ETH))).toBe(true);
  });

  it("an allowance that already covers the amount: no approve, just the shield", async () => {
    const amount = 1_000_000n;
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = amount;
    nodes.arb.allowance[`${USDC_ARB}:${HOT}:${RAILGUN_PROXY.arb.toLowerCase()}`] = amount;
    const { sent, last } = await drive("arb", "arb:usdc", amount);
    expect(last.status).toBe("shielded");
    expect(sent.map((s) => s.fn)).toEqual(["shield"]);
  });

  it("waits for the previous tx's receipt, and for the shield's finality, before moving on", async () => {
    const amount = 1_000_000n;
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = amount;
    const first = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, now: T });
    expect(first.status).toBe("sent");
    const again = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: first.progress, now: T + 60_000 });
    expect(again.status).toBe("waiting");
    expect(nodes.arb.sent).toHaveLength(1);
    mine(nodes.arb, nodes.arb.sent[0]!);
    const shield = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: again.progress, now: T + 120_000 });
    expect(shield.status).toBe("sent");
    nodes.arb.head = 1010n; // mined at 1010, finalized still 1000
    mine(nodes.arb, nodes.arb.sent[1]!);
    const notFinal = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: shield.progress, now: T + 180_000 });
    expect(notFinal.status).toBe("waiting");
    nodes.arb.finalized = 1010n;
    expect((await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: notFinal.progress, now: T + 240_000 })).status).toBe("shielded");
  });

  it("records the progress (with the tx hash) before broadcasting, and never broadcasts what was not recorded", async () => {
    const amount = 1_000_000n;
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = amount;
    const seen: { sentBefore: number; hash: string }[] = [];
    const r = await shieldOnEvm(e, "arb", "arb:usdc", amount, {
      ...P,
      now: T,
      persist: async (p) => {
        seen.push({ sentBefore: nodes.arb.sent.length, hash: p.inflight!.txs[0]! });
        return true;
      },
    });
    expect(r.status).toBe("sent");
    expect(seen).toEqual([{ sentBefore: 0, hash: keccak256(nodes.arb.sent[0]!) }]);
    const refused = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, now: T, persist: async () => false });
    expect(refused.status).toBe("skipped");
    expect(refused.progress.inflight).toBeUndefined();
    expect(refused.progress.txs ?? []).toEqual([]);
    expect(nodes.arb.sent).toHaveLength(1);
    // A persist that throws: the error propagates and nothing is broadcast.
    await expect(shieldOnEvm(e, "arb", "arb:usdc", amount, { now: T, persist: async () => Promise.reject(new Error("d1 down")) })).rejects.toThrow("d1 down");
    expect(nodes.arb.sent).toHaveLength(1);
  });

  it("a reverted step fails the shield", async () => {
    const amount = 1_000_000n;
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = amount;
    const r = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, now: T });
    mine(nodes.arb, nodes.arb.sent[0]!, "reverted");
    const f = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: r.progress, now: T + 60_000 });
    expect(f).toMatchObject({ status: "failed", reason: expect.stringMatching(/approve.*reverted/) });
  });

  it("an unmined tx is replaced after an hour at the same nonce with fees x1.3, a bounded number of times", async () => {
    const amount = 1_000_000n;
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = amount;
    let r = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, now: T });
    let at = T;
    for (let i = 0; i < MAX_REPLACEMENTS; i++) {
      at += STUCK_AFTER_MS + 1;
      r = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: r.progress, now: at });
      expect(r.status).toBe("sent");
    }
    const txs = nodes.arb.sent.map((raw) => parseTransaction(raw));
    expect(txs.map((t) => t.nonce)).toEqual([7, 7, 7, 7]);
    for (let i = 1; i < txs.length; i++) {
      expect(txs[i]!.maxFeePerGas).toBe((txs[i - 1]!.maxFeePerGas! * 13n) / 10n);
      expect(txs[i]!.maxPriorityFeePerGas).toBe((txs[i - 1]!.maxPriorityFeePerGas! * 13n) / 10n);
      expect(txs[i]!.gas).toBe(txs[0]!.gas);
    }
    expect(r.progress.inflight?.txs).toHaveLength(MAX_REPLACEMENTS + 1);
    const capped = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: r.progress, now: at + STUCK_AFTER_MS + 1 });
    expect(capped.status).toBe("waiting");
    expect(nodes.arb.sent).toHaveLength(MAX_REPLACEMENTS + 1);
    expect(await alerts()).toEqual([{ kind: "routing.stuck", chain: "arb" }]);
    // Any of the replacements mining moves the shield on.
    mine(nodes.arb, nodes.arb.sent[1]!);
    expect((await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: capped.progress, now: at + 2 * STUCK_AFTER_MS })).status).toBe("sent");
  });

  it("a shield replacement re-builds the note (fresh random) at the same nonce", async () => {
    const amount = 1_000_000n;
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = amount;
    nodes.arb.allowance[`${USDC_ARB}:${HOT}:${RAILGUN_PROXY.arb.toLowerCase()}`] = amount;
    const r = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, now: T });
    const r2 = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: r.progress, now: T + STUCK_AFTER_MS + 1 });
    expect(r2.status).toBe("sent");
    const [a, b] = nodes.arb.sent.map(decode) as [Sent, Sent];
    expect([a.fn, b.fn, a.nonce, b.nonce]).toEqual(["shield", "shield", 7, 7]);
    const npk = (s: Sent) => (s.args[0] as readonly { preimage: { npk: Hex } }[])[0]!.preimage.npk;
    expect(npk(a)).not.toBe(npk(b));
  });

  it("a dropped tx (its nonce used by another tx, unknown to the node) fails the shield", async () => {
    const amount = 1_000_000n;
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = amount;
    const r = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, now: T });
    nodes.arb.latestNonce = 9;
    nodes.arb.known = []; // evicted: the node no longer has it
    const f = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: r.progress, now: T + STUCK_AFTER_MS + 1 });
    expect(f).toMatchObject({ status: "failed", reason: expect.stringMatching(/dropped/) });
    expect(await alerts()).toEqual([{ kind: "routing.failing", chain: "arb" }]);
  });

  it("a reverted shield fails it", async () => {
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 1_000_000n;
    nodes.arb.allowance[`${USDC_ARB}:${HOT}:${RAILGUN_PROXY.arb.toLowerCase()}`] = 1_000_000n;
    const r = await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, now: T });
    expect(r.step).toBe("shield");
    mine(nodes.arb, nodes.arb.sent[0]!, "reverted");
    expect(await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, progress: r.progress, now: T + 60_000 })).toMatchObject({ status: "failed", reason: expect.stringMatching(/shield.*reverted/) });
  });

  it("after a receipt, the next step reads balances and allowance at the receipt's block", async () => {
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 1_000_000n;
    const r = await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, now: T });
    expect(nodes.arb.callBlocks).toEqual(["latest", "latest"]);
    nodes.arb.head = 1005n;
    mine(nodes.arb, nodes.arb.sent[0]!);
    nodes.arb.head = 1009n;
    await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, progress: r.progress, now: T + 60_000 });
    expect(nodes.arb.callBlocks.slice(2)).toEqual([numberToHex(1005n), numberToHex(1005n)]);
  });

  it("a replacement the hot wallet can no longer afford is skipped, and the original stays in flight", async () => {
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 1_000_000n;
    const r = await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, now: T });
    nodes.arb.native[HOT] = 10n ** 12n;
    const s = await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, progress: r.progress, now: T + STUCK_AFTER_MS + 1 });
    expect(s).toMatchObject({ status: "skipped", reason: expect.stringMatching(/gas/) });
    expect(s.progress.inflight?.txs).toEqual(r.progress.inflight?.txs);
    expect(nodes.arb.sent).toHaveLength(1);
  });

  it("progress is bound to its chain, asset and amount", async () => {
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 1_000_000n;
    const r = await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, now: T });
    expect(r.progress.bind).toEqual({ chain: "arb", asset: "arb:usdc", amount: "1000000", receiver0zk: RECEIVER });
    for (const [chain, asset, amount] of [["arb", "arb:usdc", 1_000_001n], ["arb", "arb:usdt", 1_000_000n], ["base", "base:usdc", 1_000_000n]] as const)
      await expect(shieldOnEvm(e, chain, asset, amount, { ...P, progress: r.progress, now: T })).rejects.toBeInstanceOf(ShieldProgressMismatch);
    expect(nodes.arb.sent).toHaveLength(1);
  });

  const vpk = async (raw: Hex) => {
    const req = (decode(raw).args[0] as readonly { ciphertext: { encryptedBundle: readonly Hex[] } }[])[0]!;
    const key = await crypto.subtle.importKey("raw", new Uint8Array(await railgunShieldKey(e)), "AES-CTR", false, ["decrypt"]);
    const b = (h: Hex) => Uint8Array.from(h.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));
    return Array.from(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter: b(req.ciphertext.encryptedBundle[1]!).slice(16), length: 128 }, key, b(req.ciphertext.encryptedBundle[2]!))));
  };
  const NEW = golden.addresses[3]!.address;

  it("a bind.receiver0zk other than RAILGUN_0ZK_ADDRESS (forged or stale) with nothing in flight sends nothing and alerts", async () => {
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 1_000_000n;
    nodes.arb.allowance[`${USDC_ARB}:${HOT}:${RAILGUN_PROXY.arb.toLowerCase()}`] = 1_000_000n;
    const forged: ShieldProgress = { costWei: "0", bind: { chain: "arb", asset: "arb:usdc", amount: "1000000", receiver0zk: NEW } };
    const r = await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, progress: forged, now: T });
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/RAILGUN_0ZK_ADDRESS changed mid-shield; resolve or abandon/) });
    expect(nodes.arb.sent).toHaveLength(0);
    expect(await alerts()).toEqual([{ kind: "routing.stuck", chain: "arb" }]);
  });

  it("after RAILGUN_0ZK_ADDRESS changes mid-shield, only already-signed txs are settled: no next step, no replacement", async () => {
    const amount = 1_000_000n;
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = amount;
    const r = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, now: T });
    expect(r.step).toBe("approve");
    e.RAILGUN_0ZK_ADDRESS = NEW;
    // Unmined past the hour: no replacement, no re-broadcast.
    nodes.arb.known = [];
    const w = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: r.progress, now: T + STUCK_AFTER_MS + 1 });
    expect(w).toMatchObject({ status: "waiting", reason: expect.stringMatching(/changed mid-shield/) });
    expect(nodes.arb.sent).toHaveLength(1);
    expect(await alerts()).toEqual([{ kind: "routing.stuck", chain: "arb" }]);
    // Mined: settled, but the shield is not sent.
    mine(nodes.arb, nodes.arb.sent[0]!);
    const m = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: w.progress, now: T + STUCK_AFTER_MS + 2 });
    expect(m.status).toBe("waiting");
    expect(m.progress.inflight).toBeUndefined();
    expect((await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: m.progress, now: T + STUCK_AFTER_MS + 3 })).status).toBe("skipped");
    expect(nodes.arb.sent).toHaveLength(1);
    // A new shield (no progress) goes to the new address.
    const fresh = await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, now: T });
    expect([fresh.step, fresh.progress.bind?.receiver0zk]).toEqual(["shield", NEW]);
    expect(await vpk(nodes.arb.sent.at(-1)!)).toEqual(Array.from(decode0zk(NEW).viewingPublicKey));
  });

  it("a shield already signed when the address changed is still settled to its end", async () => {
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 1_000_000n;
    nodes.arb.allowance[`${USDC_ARB}:${HOT}:${RAILGUN_PROXY.arb.toLowerCase()}`] = 1_000_000n;
    const r = await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, now: T });
    expect(await vpk(nodes.arb.sent[0]!)).toEqual(Array.from(decode0zk(RECEIVER).viewingPublicKey));
    e.RAILGUN_0ZK_ADDRESS = NEW;
    mine(nodes.arb, nodes.arb.sent[0]!);
    expect((await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, progress: r.progress, now: T + 60_000 })).status).toBe("shielded");
  });

  it("refuses a detection-only asset", async () => {
    ASSETS["arb:detonly"] = { id: "arb:detonly", chain: "arb", symbol: "DET", decimals: 6, contract: USDC_ARB, priceSymbol: "USDC", confirmations: 0, detectionOnly: true };
    try {
      await expect(shieldOnEvm(e, "arb", "arb:detonly", 1n, P)).rejects.toBeInstanceOf(RailgunConfigError);
    } finally {
      delete ASSETS["arb:detonly"];
    }
  });

  it("done progress is shielded even after RAILGUN_GOLDEN_OK is turned off (nothing is sent or asked)", async () => {
    const amount = 1_000_000n;
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = amount;
    const { last } = await drive("arb", "arb:usdc", amount);
    e.RAILGUN_GOLDEN_OK = "";
    const calls = nodes.arb.methods.length;
    expect((await shieldOnEvm(e, "arb", "arb:usdc", amount, { ...P, progress: last.progress })).status).toBe("shielded");
    expect(nodes.arb.methods.length).toBe(calls);
    await expect(shieldOnEvm(e, "arb", "arb:usdc", amount, P)).rejects.toBeInstanceOf(RailgunNotVerified);
  });
});

describe("shieldOnEvm: broadcast failures", () => {
  const start = async () => {
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 1_000_000n;
    return shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, now: T });
  };
  for (const msg of ["already known", "nonce too low"])
    it(`"${msg}" for a tx the node knows is a send`, async () => {
      nodes.arb.sendError = msg;
      nodes.arb.knowAll = true;
      const r = await start();
      expect(r.status).toBe("sent");
      expect(r.progress.inflight?.txs).toHaveLength(1);
    });
  it("a transient failure keeps the tx in flight (waiting); the next run re-broadcasts the same bytes, no fee bump", async () => {
    nodes.arb.sendError = "upstream unavailable";
    const r = await start();
    expect(r).toMatchObject({ status: "waiting", reason: expect.stringMatching(/broadcast failed/) });
    expect(r.progress.inflight?.raw).toMatch(/^0x02/);
    expect(nodes.arb.sent).toHaveLength(0);
    nodes.arb.sendError = undefined;
    const again = await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, progress: r.progress, now: T + 15 * 60_000 });
    expect(again.status).toBe("waiting");
    expect(nodes.arb.sent).toEqual([r.progress.inflight!.raw]);
    expect(again.progress.inflight?.txs).toEqual(r.progress.inflight?.txs);
    // Bytes that do not hash to the latest tx are never broadcast.
    nodes.arb.known = [];
    const tampered: ShieldProgress = { ...again.progress, inflight: { ...again.progress.inflight!, raw: nodes.arb.sent[0]!.replace(/..$/, "00") as Hex } };
    await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, progress: tampered, now: T + 20 * 60_000 });
    expect(nodes.arb.sent).toHaveLength(1);
    // A tx the node already knows is not re-sent.
    nodes.arb.knowAll = true;
    await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, progress: again.progress, now: T + 30 * 60_000 });
    expect(nodes.arb.sent).toHaveLength(1);
  });
  it("insufficient funds at broadcast raises sweep.insufficient_gas", async () => {
    nodes.arb.sendError = "insufficient funds for gas * price + value";
    expect((await start()).status).toBe("waiting");
    expect(await alerts()).toEqual([{ kind: "sweep.insufficient_gas", chain: "arb" }]);
  });
});

describe("shieldOnEvm: fee caps", () => {
  it("skips with sweep.insufficient_gas when the hot wallet cannot pay the gas (or the wrap)", async () => {
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 1_000_000n;
    nodes.arb.native[HOT] = 10n ** 12n;
    const r = await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, now: T });
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/gas/) });
    nodes.base.native[HOT] = 10n ** 17n; // less than the 0.5 ETH to wrap
    expect((await shieldOnEvm(e, "base", "base:eth", 5n * 10n ** 17n, { ...P, now: T })).status).toBe("skipped");
    expect(nodes.arb.sent.length + nodes.base.sent.length).toBe(0);
    expect(await alerts()).toEqual(expect.arrayContaining([{ kind: "sweep.insufficient_gas", chain: "arb" }, { kind: "sweep.insufficient_gas", chain: "base" }]));
  });

  it("the reserve is the gas budget: amount = balance - GAS_RESERVE[chain] shields to the end at normal fees", async () => {
    expect(GAS_RESERVE).toEqual({ eth: 2n * 10n ** 16n, base: 2n * 10n ** 15n, arb: 2n * 10n ** 15n, polygon: 5n * 10n ** 18n, bsc: 10n ** 16n });
    nodes.base.baseFee = 5_000_000n; // 0.005 gwei, a normal Base fee
    nodes.base.priority = 1_000_000n;
    const { sent, last } = await drive("base", "base:eth", 10n ** 18n - GAS_RESERVE.base);
    expect(last.status).toBe("shielded");
    expect(sent.map((s) => s.fn)).toEqual(["deposit", "approve", "shield"]);
  });

  it("a wrap that would leave less than the worst-case gas still to come is a visible skip naming the shortfall", async () => {
    const amount = 10n ** 18n - GAS_RESERVE.base;
    nodes.base.baseFee = 5n * GWEI; // 11 gwei max fee: the wrap fits in 0.002 ETH, approve + shield (600k gas) do not
    const r = await shieldOnEvm(e, "base", "base:eth", amount, { ...P, now: T });
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/short by \d+ wei/) });
    expect(nodes.base.sent).toHaveLength(0);
    expect(await alerts()).toEqual([{ kind: "sweep.insufficient_gas", chain: "base" }]);
  });

  it("a partial wrapper allowance adds the approve(0) to the gas still to come", async () => {
    const amount = 10n ** 18n - GAS_RESERVE.base;
    nodes.base.baseFee = GWEI; // 2.5 gwei max fee: 600k gas to come fits, 700k does not
    nodes.base.priority = GWEI / 2n;
    nodes.base.allowance[`${WRAPPED_NATIVE.base.toLowerCase()}:${HOT}:${RAILGUN_PROXY.base.toLowerCase()}`] = 1n;
    expect((await shieldOnEvm(e, "base", "base:eth", amount, { ...P, now: T })).status).toBe("skipped");
    nodes.base.allowance = {};
    expect((await shieldOnEvm(e, "base", "base:eth", amount, { ...P, now: T })).status).toBe("sent");
  });

  it("on Ethereum, skips with sweep.too_expensive when the gas so far plus this tx is over 5% of the shielded value", async () => {
    const amount = 1000n * 10n ** 6n; // $1000: the cap is $50
    nodes.eth.tokens[`${USDT_ETH}:${HOT}`] = amount;
    nodes.eth.baseFee = 1000n * GWEI; // 120k gas x ~2001 gwei x $2000 = ~$480
    const r = await shieldOnEvm(e, "eth", "eth:usdt", amount, { ...P, now: T });
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/5%/) });
    expect(nodes.eth.sent).toHaveLength(0);
    expect(await alerts()).toEqual([{ kind: "sweep.too_expensive", chain: "eth" }]);
    // Under the cap per tx, but the gas already spent counts too.
    nodes.eth.baseFee = 10n * GWEI; // ~$5 per tx
    const spent: ShieldProgress = { costWei: (24n * 10n ** 15n).toString() }; // $48 already spent on this shield
    expect((await shieldOnEvm(e, "eth", "eth:usdt", amount, { ...P, progress: spent, now: T })).status).toBe("skipped");
    expect((await shieldOnEvm(e, "eth", "eth:usdt", amount, { ...P, now: T })).status).toBe("sent");
  });

  it("on Ethereum, skips when a price is unknown (the cost cannot be judged)", async () => {
    nodes.eth.tokens[`${USDT_ETH}:${HOT}`] = 10n ** 10n;
    await dropPrice(e, "USD", "ETH");
    expect((await shieldOnEvm(e, "eth", "eth:usdt", 10n ** 10n, { ...P, now: T })).status).toBe("skipped");
    expect(nodes.eth.sent).toHaveLength(0);
  });

  it("uses EIP-1559 fees of 2 x base fee + tip, and a legacy gas price on BSC", async () => {
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 1n;
    await shieldOnEvm(e, "arb", "arb:usdc", 1n, { ...P, now: T });
    const t = parseTransaction(nodes.arb.sent[0]!);
    expect([t.type, t.maxFeePerGas, t.maxPriorityFeePerGas, t.gas]).toEqual(["eip1559", 21n * GWEI, GWEI, 120_000n]);
    const usdc = getAsset("bsc:usdc").contract!.toLowerCase();
    nodes.bsc.tokens[`${usdc}:${HOT}`] = 1n;
    await shieldOnEvm(e, "bsc", "bsc:usdc", 1n, { ...P, now: T });
    const l = parseTransaction(nodes.bsc.sent[0]!);
    expect([l.type, l.gasPrice, l.chainId]).toEqual(["legacy", 5n * GWEI, 56]);
  });

  it("never sends when the token balance is short or the estimate reverts", async () => {
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 999_999n;
    expect((await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, now: T })).status).toBe("skipped");
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 1_000_000n;
    nodes.arb.estimate = () => "revert";
    expect((await shieldOnEvm(e, "arb", "arb:usdc", 1_000_000n, { ...P, now: T })).status).toBe("failed");
    expect(nodes.arb.sent).toHaveLength(0);
  });
});

describe("shieldOnEvm: gates (before any network call)", () => {
  const noCalls = () => expect(Object.values(nodes).flatMap((n) => n.methods)).toEqual([]);
  it("throws RailgunNotVerified unless RAILGUN_GOLDEN_OK is exactly \"1\"", async () => {
    for (const v of [undefined, "", "0", "true", " 1"]) {
      e.RAILGUN_GOLDEN_OK = v;
      await expect(shieldOnEvm(e, "arb", "arb:usdc", 1n, P)).rejects.toBeInstanceOf(RailgunNotVerified);
    }
    noCalls();
  });
  it("throws RailgunNotVerified for a chain not listed in RAILGUN_GOLDEN_OK_CHAINS (the master switch on or not)", async () => {
    for (const v of [undefined, "", "base", "eth, base", "arbitrum"]) {
      e.RAILGUN_GOLDEN_OK_CHAINS = v;
      await expect(shieldOnEvm(e, "arb", "arb:usdc", 1n, P)).rejects.toThrow(/RAILGUN_GOLDEN_OK_CHAINS/);
    }
    noCalls();
    e.RAILGUN_GOLDEN_OK_CHAINS = " base , ARB ";
    e.RAILGUN_GOLDEN_OK = "";
    await expect(shieldOnEvm(e, "arb", "arb:usdc", 1n, P)).rejects.toBeInstanceOf(RailgunNotVerified);
    noCalls();
  });
  it("throws a config error for a missing, malformed or other-chain RAILGUN_0ZK_ADDRESS", async () => {
    for (const v of [undefined, "", "0zk1nope", golden.addresses[2]!.address /* Ethereum only */]) {
      e.RAILGUN_0ZK_ADDRESS = v;
      await expect(shieldOnEvm(e, "arb", "arb:usdc", 1n, P)).rejects.toBeInstanceOf(RailgunConfigError);
    }
    noCalls();
    e.RAILGUN_0ZK_ADDRESS = golden.addresses[1]!.address; // Arbitrum only: fine on Arbitrum
    nodes.arb.tokens[`${USDC_ARB}:${HOT}`] = 1n;
    expect((await shieldOnEvm(e, "arb", "arb:usdc", 1n, { ...P, now: T })).status).toBe("sent");
  });
  it("throws for an asset that is not this chain's, a non-EVM chain, and an amount outside (0, 2^120)", async () => {
    await expect(shieldOnEvm(e, "arb", "base:usdc", 1n, P)).rejects.toBeInstanceOf(RailgunConfigError);
    await expect(shieldOnEvm(e, "tron" as EvmChain, "tron:usdt", 1n, P)).rejects.toBeInstanceOf(RailgunConfigError);
    await expect(shieldOnEvm(e, "arb", "arb:usdc", 0n, P)).rejects.toThrow(RangeError);
    await expect(shieldOnEvm(e, "arb", "arb:usdc", 1n << 120n, P)).rejects.toThrow(RangeError);
    noCalls();
  });
  it("signs for the chain's id only, through a node that reports it", async () => {
    nodes.arb.chainId = 1;
    await expect(shieldOnEvm(e, "arb", "arb:usdc", 1n, { ...P, now: T })).rejects.toThrow(/chain id/);
    expect(nodes.arb.sent).toHaveLength(0);
  });
});
