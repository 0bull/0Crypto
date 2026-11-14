import { http, HttpResponse } from "msw";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, multicall3Abi, numberToHex } from "viem";

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

/** Balances at one block tag: native wei by address, token balances by `token:owner` (lowercase). */
export interface Snapshot {
  native?: Record<string, bigint>;
  tokens?: Record<string, bigint>;
  /** Token contracts (lowercase) whose balanceOf call fails inside the multicall. */
  failing?: string[];
}
export interface RpcState {
  latest: Snapshot;
  finalized: Snapshot;
  head: bigint;
  finalizedNumber: bigint;
  /** eth_call at any block other than the head answers with a JSON-RPC error. */
  finalizedCallError?: boolean;
  /** Code returned by eth_getCode (default: non-empty, i.e. the factory is deployed). */
  code?: string;
  /** Unix seconds of the latest / finalized blocks (defaults 1000 / 1). */
  latestTime?: number;
  finalizedTime?: number;
  /** eth_getBlockByNumber("finalized") answers with a null block number. */
  finalizedNumberNull?: boolean;
  /** eth_chainId answer; default: the chain named in the URL (base when none), so a correct node is the default. */
  chainId?: number;
  /** Every eth_* call fails with a JSON-RPC error. */
  down?: boolean;
}

export const tokenKey = (token: string, owner: string) => `${token.toLowerCase()}:${owner.toLowerCase()}`;

/** What a mocked RPC saw, for assertions. */
export interface RpcLog {
  methods: string[];
  /** Per multicall: the block it was pinned to (the raw `eth_call` block parameter) and its targets. */
  multicalls: { block: string; targets: string[] }[];
  /** Per HTTP request, the methods it carried (a batch carries several). Recorded only when present. */
  requests?: string[][];
}

/** What `evmRpc` returns: an msw handler (pass it to `network.use`) that also counts what reached it. */
export type EvmRpcHandler = ReturnType<typeof http.post> & {
  /** JSON-RPC calls answered (each element of a batched array counts once). */
  calls: () => number;
  /** HTTP requests answered (a batched array is one request). */
  requests: () => number;
};

/**
 * msw handler for one JSON-RPC URL: Multicall3 aggregate3 by block tag, finalized block, block number. Nothing else.
 * Answers a single call or a JSON-RPC batch (an array of calls, answered with an array in the same order).
 */
export function evmRpc(url: string, state: () => RpcState, log: RpcLog = { methods: [], multicalls: [] }): EvmRpcHandler {
  const u32 = (v: bigint) => encodeAbiParameters([{ type: "uint256" }], [v]);
  let calls = 0;
  let requests = 0;
  type Call = { id: number; method: string; params: unknown[] };

  function answer({ id, method, params }: Call): object {
    calls++;
    log.methods.push(method);
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    const s = state();
    if (s.down) return err(-32000, "node down");
    switch (method) {
      case "eth_chainId": {
        const named = Object.entries({ polygon: 137, arb: 42161, bsc: 56, eth: 1, base: 8453 }).find(([n]) => url.includes(n));
        return ok(numberToHex(s.chainId ?? named?.[1] ?? 8453));
      }
      case "eth_getCode":
        return ok(s.code ?? "0x6080");
      case "eth_getBalance":
        return ok(numberToHex(s.latest.native?.[(params[0] as string).toLowerCase()] ?? 0n));
      case "eth_blockNumber":
        return ok(numberToHex(s.head));
      case "eth_getBlockByNumber": {
        const tag = params[0] as string;
        if (tag !== "finalized" && tag !== "latest") return err(-32602, "unexpected block");
        const isFin = tag === "finalized";
        const n = isFin ? (s.finalizedNumberNull ? null : numberToHex(s.finalizedNumber)) : numberToHex(s.head);
        const ts = numberToHex(BigInt(isFin ? (s.finalizedTime ?? 1) : (s.latestTime ?? 1000)));
        return ok({ number: n, hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: ts, transactions: [] });
      }
      case "eth_call": {
        const block = params[1] as string;
        const atHead = block === "latest"; // the latest read uses the "latest" tag, any pinned block number is the finalized read
        const call = params[0] as { to: string; data: `0x${string}` };
        if (call.to.toLowerCase() !== MULTICALL3) throw new Error(`eth_call to ${call.to}, expected Multicall3`);
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: call.data });
        const targets = args![0] as readonly { target: string; callData: `0x${string}` }[];
        if (!atHead && s.finalizedCallError) return err(-32000, "missing trie node");
        const snap = atHead ? s.latest : s.finalized;
        log.multicalls.push({ block, targets: targets.map((c) => c.target.toLowerCase()) });
        const result = targets.map((c) => {
          const target = c.target.toLowerCase();
          const [owner] = decodeAbiParameters([{ type: "address" }], `0x${c.callData.slice(10)}`);
          if (target === MULTICALL3) return { success: true, returnData: u32(snap.native?.[owner.toLowerCase()] ?? 0n) };
          if (snap.failing?.includes(target)) return { success: false, returnData: "0x" as const };
          return { success: true, returnData: u32(snap.tokens?.[tokenKey(target, owner)] ?? 0n) };
        });
        return ok(encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result }));
      }
      default:
        return err(-32601, `unmocked ${method}`);
    }
  }

  const handler = http.post(url, async ({ request }) => {
    const body = (await request.json()) as Call | Call[];
    requests++;
    log.requests?.push(Array.isArray(body) ? body.map((c) => c.method) : [body.method]);
    return HttpResponse.json(Array.isArray(body) ? body.map(answer) : answer(body));
  });
  return Object.assign(handler, { calls: () => calls, requests: () => requests });
}

export const emptyState = (): RpcState => ({ latest: {}, finalized: {}, head: 1000n, finalizedNumber: 900n });
