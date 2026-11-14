import { setupNetwork } from "@msw/cloudflare";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearGenesisMemo, RpcRejected, SOL_MAINNET_GENESIS, solRpc, type RpcMeter } from "../../../src/chains/solana/rpc";

const U1 = "https://send1.test/rpc";
const U2 = "https://send2.test/rpc";
const network = setupNetwork();
beforeAll(() => network.enable());
beforeEach(() => clearGenesisMemo());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

type Mode = "ok" | "refuse" | "slow" | "genesis-down";
const seen: { url: string; method: string }[] = [];
beforeEach(() => void (seen.length = 0));
function node(url: string, mode: Mode) {
  return http.post(url, async ({ request }) => {
    const b = (await request.json()) as { id: number; method: string };
    seen.push({ url, method: b.method });
    if (b.method === "getGenesisHash") {
      if (mode === "genesis-down") return new HttpResponse("down", { status: 503 });
      return HttpResponse.json({ jsonrpc: "2.0", id: b.id, result: SOL_MAINNET_GENESIS });
    }
    if (mode === "slow") await delay(1000);
    if (mode === "refuse") return HttpResponse.json({ jsonrpc: "2.0", id: b.id, error: { code: -32002, message: "Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1" } });
    return HttpResponse.json({ jsonrpc: "2.0", id: b.id, result: "SIG" });
  });
}
const send = (meter?: RpcMeter) => solRpc({ SOLANA_RPC_URL: `${U1},${U2}` }, 200, meter).send("sendTransaction", ["AAAA", { encoding: "base64" }]);
const posts = (url: string) => seen.filter((s) => s.url === url && s.method === "sendTransaction").length;

describe("solRpc.send: definite refusal vs unknown outcome", () => {
  it("an earlier URL times out, a later one returns a JSON-RPC error: ambiguous (plain Error, not RpcRejected)", async () => {
    network.use(node(U1, "slow"), node(U2, "refuse"));
    const e = await send().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(RpcRejected);
    expect([posts(U1), posts(U2)]).toEqual([1, 1]);
  });
  it("a genesis failure does not count as received: the later JSON-RPC error is definite", async () => {
    network.use(node(U1, "genesis-down"), node(U2, "refuse"));
    const e = await send().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcRejected);
    expect((e as RpcRejected).code).toBe(-32002);
    expect((e as RpcRejected).detail).toMatch(/Instruction 3/);
    expect(posts(U1)).toBe(0);
  });
  it("every URL refuses: definite, and the first refusal is not re-sent elsewhere", async () => {
    network.use(node(U1, "refuse"), node(U2, "refuse"));
    await expect(send()).rejects.toBeInstanceOf(RpcRejected);
    expect([posts(U1), posts(U2)]).toEqual([1, 0]);
  });
  it("success returns the result; the meter counts every HTTP request (genesis included)", async () => {
    network.use(node(U1, "ok"), node(U2, "ok"));
    const meter = { used: 0 };
    expect(await send(meter)).toBe("SIG");
    expect(meter.used).toBe(2);
  });
});
