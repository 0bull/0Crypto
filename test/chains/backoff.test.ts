import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isRateLimited } from "../../src/chains/backoff";
import { clearGenesisMemo, SOL_MAINNET_GENESIS, solRpc } from "../../src/chains/solana/rpc";
import { esplora } from "../../src/chains/utxo/esplora";
import { ExplorerHttpError, ExplorerUnavailable, withFallback } from "../../src/chains/utxo/explorer";

describe("isRateLimited", () => {
  it("is true for a 429, directly or as any cause", () => {
    expect(isRateLimited(new ExplorerHttpError(429, ""))).toBe(true);
    expect(isRateLimited(new ExplorerUnavailable("x", { cause: new ExplorerHttpError(429, "") }))).toBe(true);
    expect(isRateLimited(new Error("a", { cause: new Error("b", { cause: { status: 429 } }) }))).toBe(true);
  });
  it("is false for other statuses, plain errors and non-objects", () => {
    expect(isRateLimited(new ExplorerUnavailable("x", { cause: new ExplorerHttpError(500, "") }))).toBe(false);
    expect(isRateLimited(new Error("boom"))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
    expect(isRateLimited("429")).toBe(false);
  });
  it("stops on a cyclic cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    a.cause = a;
    expect(isRateLimited(a)).toBe(false);
  });
});

const network = setupNetwork();
beforeAll(() => network.enable());
beforeEach(() => clearGenesisMemo());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

describe("429 survives the URL-free wrappers", () => {
  const S1 = "https://secret-key-1.test/rpc";
  const S2 = "https://secret-key-2.test/rpc";
  const sol = (url: string, status: number) =>
    http.post(url, async ({ request }) => {
      const b = (await request.json()) as { id: number; method: string };
      if (b.method === "getGenesisHash") return HttpResponse.json({ jsonrpc: "2.0", id: b.id, result: SOL_MAINNET_GENESIS });
      return new HttpResponse(null, { status });
    });
  const fail = (urls: string, ...handlers: ReturnType<typeof sol>[]) => {
    network.use(...handlers);
    return solRpc({ SOLANA_RPC_URL: urls }, 200).call("getSlot", []).catch((e: unknown) => e);
  };

  it("Solana: any URL answering 429 is rate-limited, and nothing names a URL", async () => {
    const e = await fail(`${S1},${S2}`, sol(S1, 429), sol(S2, 500));
    expect(isRateLimited(e)).toBe(true);
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e)) + String((e as Error).cause ? JSON.stringify((e as Error).cause) : "")).not.toContain("secret-key");
  });
  it("Solana: non-429 failures are not rate-limited", async () => {
    expect(isRateLimited(await fail(`${S1},${S2}`, sol(S1, 500), sol(S2, 503)))).toBe(false);
  });

  const P = "https://p.test/api";
  const Q = "https://q.test/api";
  const btc = (base: string, status: number) => http.get(`${base}/blocks/tip/height`, () => new HttpResponse(null, { status }));
  it("withFallback: primary 429 + secondary 500 is rate-limited; 500 + 500 is not", async () => {
    network.use(btc(P, 429), btc(Q, 500));
    expect(isRateLimited(await withFallback(esplora(P), esplora(Q)).tipHeight().catch((e: unknown) => e))).toBe(true);
    network.use(btc(P, 500), btc(Q, 500));
    expect(isRateLimited(await withFallback(esplora(P), esplora(Q)).tipHeight().catch((e: unknown) => e))).toBe(false);
  });
});
