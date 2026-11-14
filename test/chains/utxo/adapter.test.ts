import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter, startIndex } from "../../../src/chains/registry";
import { utxoAdapter } from "../../../src/chains/utxo/adapter";
import { blockbook } from "../../../src/chains/utxo/blockbook";
import { accountFromSeed, deriveUtxoAddress } from "../../../src/chains/utxo/derive";
import { esplora, ExplorerNetworkError, ExplorerUnavailable, withFallback } from "../../../src/chains/utxo/esplora";
import { ExplorerHttpError, explorerFetch } from "../../../src/chains/utxo/explorer";
import type { Env } from "../../../src/env";
import type { AssetInfo, DepositTarget } from "../../../src/core/types";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PRIMARY = "https://primary.test/api";
const SECOND = "https://second.test/api";
const BB = "https://bb.test";
const NOW = 1_800_000_000_000;
const ADDR = "bc1qaddr";
const OTHER = "bc1qother";

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => {
  network.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => network.disable());
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

const asset = (chain: "btc" | "ltc" | "doge", confirmations: number): AssetInfo => ({
  id: `${chain}:${chain}`,
  chain,
  symbol: chain.toUpperCase(),
  decimals: chain === "doge" ? 8 : 8,
  priceSymbol: chain.toUpperCase(),
  confirmations,
});
const target = (address = ADDR, createdAt = NOW): DepositTarget => ({
  paymentId: "p1",
  chain: "btc",
  address,
  asset: "btc:btc",
  derivationIndex: 0,
  createdAt,
});
const account = accountFromSeed(MNEMONIC, "btc");
const secs = (ms: number) => Math.floor(ms / 1000);

function esploraTxs() {
  return [
    {
      txid: "aa",
      vout: [
        { value: 30_000, scriptpubkey_address: ADDR },
        { value: 99_999, scriptpubkey_address: OTHER },
      ],
      status: { confirmed: true, block_height: 899_999, block_time: secs(NOW + 60_000) },
    },
    { txid: "bb", vout: [{ value: 20_000, scriptpubkey_address: ADDR }], status: { confirmed: false } },
  ];
}
function mockEsplora(base: string, txs: unknown = esploraTxs()) {
  return [
    http.get(`${base}/blocks/tip/height`, () => HttpResponse.text("900000")),
    http.get(`${base}/address/${ADDR}/txs`, () => HttpResponse.json(txs as object)),
  ];
}

describe("utxo adapter observe", () => {
  it("BTC: sums received, final only past 2 confirmations", async () => {
    network.use(...mockEsplora(PRIMARY));
    const a = utxoAdapter("btc", esplora(PRIMARY), account);
    expect(await a.observe(target(), asset("btc", 2))).toEqual({ received: 50_000n, final: 30_000n, txids: ["aa", "bb"] });
  });

  describe("explorer requests per observe", () => {
    const counted = (txs: unknown) => {
      const hits: string[] = [];
      network.use(
        http.get(`${PRIMARY}/blocks/tip/height`, () => (hits.push("tip"), HttpResponse.text("900000"))),
        http.get(`${PRIMARY}/address/${ADDR}/txs`, () => (hits.push("txs"), HttpResponse.json(txs as object))),
      );
      return hits;
    };
    const a = () => utxoAdapter("btc", esplora(PRIMARY), account);
    it("an empty address: one request (the tx list), no tip read", async () => {
      const hits = counted([]);
      expect(await a().observe(target(), asset("btc", 2))).toEqual({ received: 0n, final: 0n, txids: [] });
      expect(hits).toEqual(["txs"]);
    });
    it("only unconfirmed txs: one request, nothing final", async () => {
      const hits = counted([esploraTxs()[1]]);
      expect(await a().observe(target(), asset("btc", 2))).toEqual({ received: 20_000n, final: 0n, txids: ["bb"] });
      expect(hits).toEqual(["txs"]);
    });
    it("a confirmed tx: the tip is read after the tx list, final as before", async () => {
      const hits = counted([esploraTxs()[0]]);
      expect(await a().observe(target(), asset("btc", 2))).toEqual({ received: 30_000n, final: 30_000n, txids: ["aa"] });
      expect(hits).toEqual(["txs", "tip"]);
    });
  });

  it("LTC: 6 confirmations needed, so nothing final", async () => {
    network.use(...mockEsplora(PRIMARY));
    const a = utxoAdapter("ltc", esplora(PRIMARY), account);
    expect((await a.observe(target(), asset("ltc", 6))).final).toBe(0n);
  });

  it("ignores confirmed txs older than createdAt - 2h but keeps mempool txs", async () => {
    const old = esploraTxs();
    old[0]!.status.block_time = secs(NOW - 7_200_000 - 1000);
    network.use(...mockEsplora(PRIMARY, old));
    const a = utxoAdapter("btc", esplora(PRIMARY), account);
    expect(await a.observe(target(), asset("btc", 2))).toEqual({ received: 20_000n, final: 0n, txids: ["bb"] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("aa"));
    expect(warn.mock.calls.flat().join(" ")).not.toContain(ADDR);
  });

  it("falls back on 503", async () => {
    network.use(
      http.get(`${PRIMARY}/blocks/tip/height`, () => new HttpResponse(null, { status: 503 })),
      http.get(`${PRIMARY}/address/${ADDR}/txs`, () => new HttpResponse(null, { status: 503 })),
      ...mockEsplora(SECOND),
    );
    const a = utxoAdapter("btc", withFallback(esplora(PRIMARY), esplora(SECOND)), account);
    expect((await a.observe(target(), asset("btc", 2))).received).toBe(50_000n);
  });

  it("falls back on 429 and network error", async () => {
    network.use(
      http.get(`${PRIMARY}/blocks/tip/height`, () => new HttpResponse(null, { status: 429 })),
      ...mockEsplora(SECOND),
    );
    expect(await withFallback(esplora(PRIMARY), esplora(SECOND)).tipHeight()).toBe(900_000);
    network.use(http.get(`${PRIMARY}/blocks/tip/height`, () => HttpResponse.error()));
    expect(await withFallback(esplora(PRIMARY), esplora(SECOND)).tipHeight()).toBe(900_000);
  });

  it("does not fall back on 404", async () => {
    network.use(
      http.get(`${PRIMARY}/blocks/tip/height`, () => new HttpResponse(null, { status: 404 })),
      ...mockEsplora(SECOND),
    );
    await expect(withFallback(esplora(PRIMARY), esplora(SECOND)).tipHeight()).rejects.toThrow("404");
  });

  it("rejects with ExplorerUnavailable when both fail", async () => {
    network.use(
      http.get(`${PRIMARY}/blocks/tip/height`, () => new HttpResponse(null, { status: 503 })),
      http.get(`${SECOND}/blocks/tip/height`, () => HttpResponse.error()),
      http.get(`${PRIMARY}/address/${ADDR}/txs`, () => new HttpResponse(null, { status: 503 })),
      http.get(`${SECOND}/address/${ADDR}/txs`, () => HttpResponse.error()),
    );
    const a = utxoAdapter("btc", withFallback(esplora(PRIMARY), esplora(SECOND)), account);
    await expect(a.observe(target(), asset("btc", 2))).rejects.toBeInstanceOf(ExplorerUnavailable);
  });

  it("does not count outputs to other addresses", async () => {
    network.use(...mockEsplora(PRIMARY));
    const txs = await esplora(PRIMARY).addressTxs(ADDR);
    expect(txs[0]!.valueToAddr).toBe(30_000n);
  });

  it("warns when pagination may be needed", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      txid: `t${i}`,
      vout: [],
      status: { confirmed: true, block_height: 1, block_time: 1 },
    }));
    network.use(...mockEsplora(PRIMARY, many));
    await esplora(PRIMARY).addressTxs(ADDR);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pagination"));
  });

  it("broadcasts raw hex as text/plain", async () => {
    let ct: string | null = null;
    let body = "";
    network.use(
      http.post(`${PRIMARY}/tx`, async ({ request }) => {
        ct = request.headers.get("content-type");
        body = await request.text();
        return HttpResponse.text("deadbeef");
      }),
    );
    expect(await esplora(PRIMARY).broadcast("0100ff")).toBe("deadbeef");
    expect(ct).toContain("text/plain");
    expect(body).toBe("0100ff");
  });
});

describe("hardening", () => {
  it("malformed 200 body does not fall back or become ExplorerUnavailable", async () => {
    let secondCalled = false;
    network.use(
      http.get(`${PRIMARY}/blocks/tip/height`, () => HttpResponse.text("not-a-number")),
      http.get(`${SECOND}/blocks/tip/height`, () => {
        secondCalled = true;
        return HttpResponse.text("900000");
      }),
    );
    const p = withFallback(esplora(PRIMARY), esplora(SECOND)).tipHeight();
    await expect(p).rejects.toThrow("bad tip height");
    await expect(p).rejects.not.toBeInstanceOf(ExplorerUnavailable);
    expect(secondCalled).toBe(false);
  });

  it("confirmation boundaries: conf-1 not final, exactly conf final", async () => {
    const tx = (txid: string, h: number) => ({
      txid,
      vout: [{ value: 10, scriptpubkey_address: ADDR }],
      status: { confirmed: true, block_height: h, block_time: secs(NOW) },
    });
    network.use(...mockEsplora(PRIMARY, [tx("at-tip", 900_000), tx("two", 899_999)]));
    const a = utxoAdapter("btc", esplora(PRIMARY), account);
    expect(await a.observe(target(), asset("btc", 2))).toEqual({ received: 20n, final: 10n, txids: ["at-tip", "two"] });
  });

  it("fails closed on confirmed esplora tx without height or time", async () => {
    for (const status of [{ confirmed: true, block_time: 1 }, { confirmed: true, block_height: 5 }]) {
      network.use(...mockEsplora(PRIMARY, [{ txid: "x", vout: [], status }]));
      const p = withFallback(esplora(PRIMARY), esplora(SECOND)).addressTxs(ADDR);
      await expect(p).rejects.toThrow("confirmed tx without");
      await expect(p).rejects.not.toBeInstanceOf(ExplorerUnavailable);
    }
  });

  it("matches uppercase bech32 from explorer, but base58 stays case-sensitive", async () => {
    network.use(
      ...mockEsplora(PRIMARY, [
        { txid: "u", vout: [{ value: 7, scriptpubkey_address: ADDR.toUpperCase() }], status: { confirmed: false } },
      ]),
    );
    expect((await esplora(PRIMARY).addressTxs(ADDR))[0]!.valueToAddr).toBe(7n);
    const B58 = "DAbCdEfG";
    network.use(
      http.get(`${PRIMARY}/address/${B58}/txs`, () =>
        HttpResponse.json([{ txid: "c", vout: [{ value: 7, scriptpubkey_address: B58.toLowerCase() }], status: { confirmed: false } }]),
      ),
    );
    expect((await esplora(PRIMARY).addressTxs(B58))[0]!.valueToAddr).toBe(0n);
  });

  it("timeout is a retriable network error", async () => {
    network.use(
      http.get(`${PRIMARY}/blocks/tip/height`, async () => {
        await new Promise((r) => setTimeout(r, 300));
        return HttpResponse.text("1");
      }),
      http.get(`${SECOND}/blocks/tip/height`, () => HttpResponse.text("900000")),
    );
    await expect(esplora(PRIMARY, undefined, 20).tipHeight()).rejects.toBeInstanceOf(ExplorerNetworkError);
    expect(await withFallback(esplora(PRIMARY, undefined, 20), esplora(SECOND)).tipHeight()).toBe(900_000);
  });
});

describe("explorerFetch", () => {
  it("cancels the body of a non-2xx response", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body, { status: 503 }));
    await expect(explorerFetch(`${PRIMARY}/x`)).rejects.toBeInstanceOf(ExplorerHttpError);
    expect(cancelled).toBe(true);
  });
});

describe("blockbook", () => {
  it("blockHeight 0 is unconfirmed; confirmed without blockTime fails closed; warns on totalPages", async () => {
    const page = (transactions: unknown[], totalPages = 1) =>
      http.get(`${BB}/api/v2/address/${ADDR}`, () => HttpResponse.json({ totalPages, transactions }));
    network.use(page([{ txid: "z", blockHeight: 0, vout: [{ value: "5", addresses: [ADDR] }] }], 2));
    const txs = await blockbook(BB).addressTxs(ADDR);
    expect(txs[0]).toMatchObject({ height: null, time: null, valueToAddr: 5n });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pagination"));
    expect(warn.mock.calls.flat().join(" ")).not.toContain(ADDR);
    network.use(page([{ txid: "y", blockHeight: 10, vout: [] }]));
    await expect(blockbook(BB).addressTxs(ADDR)).rejects.toThrow("without blockTime");
  });

  const bbMocks = (key?: (k: string | null) => void) => [
    http.get(`${BB}/api/v2`, ({ request }) => {
      key?.(request.headers.get("api-key"));
      return HttpResponse.json({ blockbook: { bestHeight: 900_000 } });
    }),
    http.get(`${BB}/api/v2/address/${ADDR}`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("details")).toBe("txs");
      return HttpResponse.json({
        transactions: [
          {
            txid: "aa",
            blockHeight: 899_999,
            blockTime: secs(NOW + 60_000),
            vout: [
              { value: "30000", addresses: [ADDR] },
              { value: "99999", addresses: [OTHER] },
            ],
          },
          { txid: "bb", blockHeight: -1, vout: [{ value: "20000", addresses: [ADDR] }] },
        ],
      });
    }),
  ];

  it("parses string satoshi values to the same Observation", async () => {
    let seen: string | null = null;
    network.use(...bbMocks((k) => (seen = k)));
    const a = utxoAdapter("btc", blockbook(BB, "k1"), account);
    expect(await a.observe(target(), asset("btc", 2))).toEqual({ received: 50_000n, final: 30_000n, txids: ["aa", "bb"] });
    expect(seen).toBe("k1");
  });

  it("broadcasts via sendtx", async () => {
    network.use(http.post(`${BB}/api/v2/sendtx/`, () => HttpResponse.json({ result: "cafe" })));
    expect(await blockbook(BB).broadcast("00")).toBe("cafe");
  });
});

describe("paymentUri and registry", () => {
  it("builds scheme URIs", () => {
    const t = target("addr1");
    const e = esplora(PRIMARY);
    expect(utxoAdapter("btc", e, account).paymentUri(t, asset("btc", 2), 150_000_000n)).toBe("bitcoin:addr1?amount=1.5");
    expect(utxoAdapter("ltc", e, account).paymentUri(t, asset("ltc", 6), 1n)).toBe("litecoin:addr1?amount=0.00000001");
    expect(utxoAdapter("doge", e, account).paymentUri(t, asset("doge", 20), 100_000_000n)).toBe("dogecoin:addr1?amount=1");
  });

  const env = { MASTER_SEED: MNEMONIC, ALLOW_SEED_CUSTODY: "true" } as Env;

  it("derives from seed only with ALLOW_SEED_CUSTODY=\"true\"; an empty xpub counts as unset", () => {
    for (const e of [{ MASTER_SEED: MNEMONIC }, { MASTER_SEED: MNEMONIC, BTC_XPUB: "" }, { MASTER_SEED: MNEMONIC, ALLOW_SEED_CUSTODY: "yes" }])
      expect(() => getAdapter(e as Env, "btc")).toThrow(/BTC_XPUB.*ALLOW_SEED_CUSTODY/);
    expect(getAdapter({ ...env, BTC_XPUB: "" }, "btc").chain).toBe("btc");
  });

  it("treats an empty explorer URL as unset", async () => {
    const hits: string[] = [];
    network.use(
      ...["https://mempool.space/api", "https://blockstream.info/api"].flatMap((base) => [
        http.get(`${base}/blocks/tip/height`, () => HttpResponse.text("900000")),
        http.get(`${base}/address/:a/txs`, () => (hits.push(base), HttpResponse.json([]))),
      ]),
    );
    const a = getAdapter({ ...env, BTC_ESPLORA_URL: "" }, "btc");
    expect(await a.observe(target(), asset("btc", 2))).toEqual({ received: 0n, final: 0n, txids: [] });
    expect(hits).toEqual(["https://mempool.space/api"]);
  });

  it("derives from seed in routed mode and from xpub in watch mode", async () => {
    const routed = await getAdapter(env, "btc").deriveAddress(0);
    expect(routed).toBe(deriveUtxoAddress(account, "btc", 0));
    const xpub = account.publicExtendedKey;
    const watch = getAdapter({ MASTER_SEED: "unused", BTC_XPUB: xpub } as Env, "btc");
    expect(await watch.deriveAddress(0)).toBe(routed);
  });

  it("reads <CHAIN>_XPUB_START_INDEX, default 0, rejecting malformed values", () => {
    expect(startIndex({}, "btc")).toBe(0);
    expect(startIndex({ BTC_XPUB_START_INDEX: "" }, "btc")).toBe(0);
    expect(startIndex({ BTC_XPUB_START_INDEX: "42" }, "btc")).toBe(42);
    expect(startIndex({ BTC_XPUB_START_INDEX: "42" }, "ltc")).toBe(0);
    expect(startIndex({ DOGE_XPUB_START_INDEX: "2147483647" }, "doge")).toBe(2147483647);
    for (const v of ["-1", "1.5", "abc", "2147483648", "1e3"])
      expect(() => startIndex({ LTC_XPUB_START_INDEX: v }, "ltc"), v).toThrow("LTC_XPUB_START_INDEX");
  });

  it("requires DOGE_BLOCKBOOK_URL", () => {
    expect(() => getAdapter(env, "doge")).toThrow("DOGE_BLOCKBOOK_URL");
    expect(getAdapter({ ...env, DOGE_BLOCKBOOK_URL: BB }, "doge").chain).toBe("doge");
  });
});
