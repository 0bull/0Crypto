import { http, HttpResponse } from "msw";
import { decodeFunctionData, keccak256, numberToHex, parseAbi, type Address, type Hex } from "viem";

export const FACTORY_ABI = parseAbi(["function deployAndFlush(bytes32[] salts, address[] tokens)"]);
export const GWEI = 10n ** 9n;

export interface Receipt {
  status: "success" | "reverted";
  block: bigint;
}
export interface SweepRpcState {
  /** Gas estimate for a deployAndFlush call; "revert" fails eth_estimateGas with an execution revert, "error" with an unrelated node error. */
  estimate: (salts: Hex[], tokens: Address[]) => bigint | "revert" | "error";
  baseFee: bigint;
  priority: bigint;
  gasPrice: bigint;
  nonce: number;
  /** eth_getTransactionCount at "latest" (default: nonce). */
  latestNonce?: number;
  /** Receipts by tx hash (lowercase); a hash that is absent has no receipt yet. */
  receipts: Record<string, Receipt>;
  /** Raw transactions received by eth_sendRawTransaction. */
  sent: Hex[];
  /** Params seen by eth_estimateGas. */
  estimated: { from?: string; to?: string; salts: Hex[]; tokens: Address[] }[];
  nonceTags: unknown[];
  /** eth_sendRawTransaction fails: true = "nonce too low" (tx unknown), "known" = "already known" (the node has the tx), "funds" = insufficient funds. */
  sendError?: boolean | "known" | "funds";
  /** Hashes eth_getTransactionByHash knows. */
  knownTxs: string[];
  /** Block number of eth_blockNumber is the evm-rpc head; unused here. */
}
export const sweepState = (): SweepRpcState => ({
  estimate: () => 100_000n,
  baseFee: 10n * GWEI,
  priority: GWEI,
  gasPrice: 5n * GWEI,
  nonce: 7,
  receipts: {},
  sent: [],
  estimated: [],
  nonceTags: [],
  knownTxs: [],
});

/**
 * Sweep-specific JSON-RPC methods for one URL. Everything else (chain id, code, balances, blocks, multicall) falls
 * through to the next handler (test/evm-rpc.ts), so register this one first.
 */
export function sweepRpc(url: string, state: () => SweepRpcState) {
  return http.post(url, async ({ request }) => {
    const { id, method, params } = (await request.clone().json()) as { id: number; method: string; params: unknown[] };
    const s = state();
    const ok = (result: unknown) => HttpResponse.json({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string) => HttpResponse.json({ jsonrpc: "2.0", id, error: { code, message } });
    switch (method) {
      case "eth_estimateGas": {
        const call = params[0] as { from?: string; to?: string; data: Hex };
        const { args } = decodeFunctionData({ abi: FACTORY_ABI, data: call.data });
        const [salts, tokens] = args as [Hex[], Address[]];
        s.estimated.push({ from: call.from, to: call.to, salts, tokens });
        const g = s.estimate(salts, tokens);
        if (g === "error") return err(-32000, "upstream unavailable");
        return g === "revert" ? err(3, "execution reverted") : ok(numberToHex(g));
      }
      case "eth_getTransactionCount":
        s.nonceTags.push(params[1]);
        return ok(numberToHex(params[1] === "latest" ? (s.latestNonce ?? s.nonce) : s.nonce));
      case "eth_gasPrice":
        return ok(numberToHex(s.gasPrice));
      case "eth_maxPriorityFeePerGas":
        return ok(numberToHex(s.priority));
      case "eth_getBlockByNumber": {
        if (params[0] !== "latest") return undefined;
        return ok({
          number: numberToHex(1000n), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: numberToHex(1000n),
          transactions: [], baseFeePerGas: numberToHex(s.baseFee),
        });
      }
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        if (s.sendError === "funds") return err(-32000, "insufficient funds for gas * price + value");
        if (s.sendError === "known") {
          s.sent.push(raw);
          s.knownTxs.push(keccak256(raw).toLowerCase());
          return err(-32000, "already known");
        }
        if (s.sendError) return err(-32000, "nonce too low");
        s.sent.push(raw);
        return ok(keccak256(raw));
      }
      case "eth_getTransactionByHash":
        return ok(s.knownTxs.includes((params[0] as string).toLowerCase()) ? { hash: params[0] } : null);
      case "eth_getTransactionReceipt": {
        const hash = (params[0] as string).toLowerCase();
        const r = s.receipts[hash];
        if (!r) return ok(null);
        return ok({
          blockHash: `0x${"33".repeat(32)}`, blockNumber: numberToHex(r.block), contractAddress: null, cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1",
          from: `0x${"44".repeat(20)}`, gasUsed: "0x5208", logs: [], logsBloom: `0x${"00".repeat(256)}`, status: r.status === "success" ? "0x1" : "0x0",
          to: `0x${"55".repeat(20)}`, transactionHash: hash, transactionIndex: "0x0", type: "0x2",
        });
      }
      default:
        return undefined;
    }
  });
}
