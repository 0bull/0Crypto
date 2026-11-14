import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPriceE8, PriceUnavailable, refreshPrices } from "../../src/prices/cache";
import { fetchCoinGecko } from "../../src/prices/coingecko";
import { fetchKraken } from "../../src/prices/kraken";
import { putPrice } from "./seed";

const network = setupNetwork();
const KRAKEN = "https://api.kraken.com/0/public/Ticker";
const GECKO = "https://api.coingecko.com/api/v3/simple/price";
const tick = (c: string) => ({ c: [c, "1.0"] });
let warn: ReturnType<typeof vi.spyOn>;
const e = env as unknown as import("../../src/env").Env; // ENABLED_ASSETS = btc:btc,ltc:ltc
const krakenDown = () => http.get(KRAKEN, () => new HttpResponse(null, { status: 500 }));

beforeAll(() => network.enable());
afterEach(() => {
  network.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => network.disable());
beforeEach(async () => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { keys } = await e.KV.list();
  await Promise.all(keys.map((k) => e.KV.delete(k.name)));
});

describe("kraken", () => {
  it("reads the last trade, mapping real result keys", async () => {
    network.use(
      http.get(KRAKEN, () =>
        HttpResponse.json({
          error: [],
          result: {
            XXBTZUSD: tick("97000.12345"),
            XXBTZEUR: tick("64582.2"),
            XETHZUSD: tick("2014.09"),
            XLTCZUSD: tick("49.83"),
            XDGUSD: tick("0.065731100"),
            XXDGZEUR: tick("0.0595174"),
            USDTZUSD: tick("0.99881"),
            POLUSD: tick("0.087430000"),
          },
        }),
      ),
    );
    const got = await fetchKraken(["BTC", "ETH", "LTC", "DOGE", "USDT", "POL"]);
    expect(Object.fromEntries(got)).toEqual({
      "USD:BTC": 9_700_012_345_000n,
      "EUR:BTC": 6_458_220_000_000n,
      "USD:ETH": 201_409_000_000n,
      "USD:LTC": 4_983_000_000n,
      "USD:DOGE": 6_573_110n,
      "EUR:DOGE": 5_951_740n,
      "USD:USDT": 99_881_000n,
      "USD:POL": 8_743_000n,
    });
  });

  it("truncates prices with more than 8 decimals", async () => {
    network.use(http.get(KRAKEN, () => HttpResponse.json({ error: [], result: { POLUSD: tick("0.123456789") } })));
    expect((await fetchKraken(["POL"])).get("USD:POL")).toBe(12_345_678n);
  });

  it("asks only for the requested symbols, and nothing when none are known", async () => {
    const pairs: string[] = [];
    network.use(
      http.get(KRAKEN, ({ request }) => {
        pairs.push(new URL(request.url).searchParams.get("pair")!);
        return HttpResponse.json({ error: [], result: {} });
      }),
    );
    await fetchKraken(["DOGE"]);
    await fetchKraken(["NOPE"]);
    expect(pairs).toEqual(["XDGUSD,XDGEUR"]);
  });

  it("times out a hanging request", async () => {
    network.use(http.get(KRAKEN, async () => (await delay(2_000), HttpResponse.json({}))));
    expect((await fetchKraken(["BTC"], 20)).size).toBe(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("kraken ticker request failed");
  });
});

describe("coingecko", () => {
  it("times out a hanging request", async () => {
    network.use(http.get(GECKO, async () => (await delay(2_000), HttpResponse.json({}))));
    expect((await fetchCoinGecko("k", new Set(["USD:BTC"]), 20)).size).toBe(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("coingecko request failed");
  });
});

describe("price cache", () => {
  it("fetches and stores only the price symbols of enabled assets", async () => {
    const pairs: string[] = [];
    network.use(
      http.get(KRAKEN, ({ request }) => {
        pairs.push(new URL(request.url).searchParams.get("pair")!);
        return HttpResponse.json({ error: [], result: { XXBTZUSD: tick("100.0"), XLTCZUSD: tick("50.0"), XETHZUSD: tick("2000.0") } });
      }),
    );
    await refreshPrices(e);
    expect(pairs).toEqual(["XBTUSD,XBTEUR,LTCUSD,LTCEUR"]);
    expect((await e.KV.list()).keys.map((k) => k.name)).toEqual(["prices"]);
    const rec = JSON.parse((await e.KV.get("prices"))!) as Record<string, { e8: string; at: number }>;
    expect(Object.keys(rec).sort()).toEqual(["EUR:BTC", "EUR:LTC", "USD:BTC", "USD:LTC"].filter((k) => k in rec));
    expect(rec["USD:BTC"]!.e8).toBe("10000000000");
  });

  it("writes the record once for a whole refresh", async () => {
    network.use(http.get(KRAKEN, () => HttpResponse.json({ error: [], result: { XXBTZUSD: tick("100.0"), XXBTZEUR: tick("90.0"), XLTCZUSD: tick("50.0") } })));
    const put = vi.spyOn(e.KV, "put");
    await refreshPrices(e);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe("prices");
  });

  it("an inline refresh of one symbol keeps the other entries' own timestamps", async () => {
    const old = Date.now() - 200_000;
    await putPrice(e, "USD", "BTC", 100n, old);
    network.use(http.get(KRAKEN, () => HttpResponse.json({ error: [], result: { XLTCZUSD: tick("49.5") } })));
    expect(await getPriceE8(e, "LTC", "USD")).toBe(4_950_000_000n);
    const rec = JSON.parse((await e.KV.get("prices"))!) as Record<string, { e8: string; at: number }>;
    expect(rec["USD:BTC"]).toEqual({ e8: "100", at: old });
    expect(rec["USD:LTC"]!.at).toBeGreaterThan(old);
  });

  it("a BTC entry older than 5 minutes is a miss even when LTC is fresh", async () => {
    network.use(krakenDown());
    await putPrice(e, "USD", "BTC", 100n, Date.now() - 300_001);
    await putPrice(e, "USD", "LTC", 50n);
    expect(await getPriceE8(e, "LTC", "USD")).toBe(50n);
    await expect(getPriceE8(e, "BTC", "USD")).rejects.toBeInstanceOf(PriceUnavailable);
  });

  it("an invoice-time read after an idle period fetches a fresh price inline", async () => {
    await putPrice(e, "USD", "BTC", 1n, Date.now() - 3_600_000); // nothing refreshed it for an hour
    network.use(http.get(KRAKEN, () => HttpResponse.json({ error: [], result: { XXBTZUSD: tick("100.0") } })));
    expect(await getPriceE8(e, "BTC", "USD")).toBe(10_000_000_000n);
  });

  it("refreshes that symbol once inline on a cache miss", async () => {
    const pairs: string[] = [];
    network.use(
      http.get(KRAKEN, ({ request }) => {
        pairs.push(new URL(request.url).searchParams.get("pair")!);
        return HttpResponse.json({ error: [], result: { XLTCZUSD: tick("49.5") } });
      }),
    );
    expect(await getPriceE8(e, "LTC", "USD")).toBe(4_950_000_000n);
    expect(pairs).toEqual(["LTCUSD,LTCEUR"]);
    expect(await getPriceE8(e, "LTC", "USD")).toBe(4_950_000_000n); // now cached
    expect(pairs).toHaveLength(1);
    await expect(getPriceE8(e, "LTC", "EUR")).rejects.toBeInstanceOf(PriceUnavailable); // still missing after one try
    expect(pairs).toHaveLength(2);
  });

  it("falls back to CoinGecko when Kraken fails and a key is set", async () => {
    let header: string | null = null;
    network.use(
      http.get(KRAKEN, () => new HttpResponse(null, { status: 500 })),
      http.get(GECKO, ({ request }) => {
        header = request.headers.get("x-cg-demo-api-key");
        return HttpResponse.json({ bitcoin: { usd: 97000.5 } });
      }),
    );
    await refreshPrices({ ...e, COINGECKO_KEY: "demo" } as typeof e);
    expect(header).toBe("demo");
    expect(await getPriceE8(e, "BTC", "USD")).toBe(9_700_050_000_000n);
    await expect(getPriceE8(e, "BTC", "EUR")).rejects.toBeInstanceOf(PriceUnavailable);
  });

  it("logs a warning when Kraken returns 500", async () => {
    network.use(http.get(KRAKEN, () => new HttpResponse(null, { status: 500 })));
    await refreshPrices(e);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("kraken ticker failed: HTTP 500"));
  });

  it("does not call CoinGecko without a key", async () => {
    let called = false;
    network.use(
      http.get(KRAKEN, () => new HttpResponse(null, { status: 500 })),
      http.get(GECKO, () => {
        called = true;
        return HttpResponse.json({});
      }),
    );
    await refreshPrices(e);
    expect(called).toBe(false);
    await expect(getPriceE8(e, "BTC", "USD")).rejects.toBeInstanceOf(PriceUnavailable);
  });

  it("only asks CoinGecko for symbols Kraken missed", async () => {
    network.use(
      http.get(KRAKEN, () => HttpResponse.json({ error: [], result: { XXBTZUSD: tick("100.0") } })),
      http.get(GECKO, () => HttpResponse.json({ bitcoin: { usd: 1 }, litecoin: { usd: 50.25 } })),
    );
    await refreshPrices({ ...e, COINGECKO_KEY: "k" } as typeof e);
    expect(await getPriceE8(e, "BTC", "USD")).toBe(10_000_000_000n);
    expect(await getPriceE8(e, "LTC", "USD")).toBe(5_025_000_000n);
  });

  it("throws PriceUnavailable for entries older than 300000 ms when a refresh does not help", async () => {
    network.use(krakenDown());
    await putPrice(e, "USD", "BTC", 100n, Date.now() - 300_001);
    const err = await getPriceE8(e, "BTC", "USD").catch((x) => x);
    expect(err).toBeInstanceOf(PriceUnavailable);
    expect(err).toMatchObject({ symbol: "BTC", currency: "USD" });
    await putPrice(e, "USD", "BTC", 100n, Date.now() - 1000);
    expect(await getPriceE8(e, "BTC", "USD")).toBe(100n);
  });

  it("throws PriceUnavailable when nothing is cached and Kraken is down", async () => {
    network.use(krakenDown());
    await expect(getPriceE8(e, "SOL", "EUR")).rejects.toBeInstanceOf(PriceUnavailable);
  });

  it("rejects exponent notation and keeps the previous cache entry", async () => {
    const at = Date.now() - 1000;
    await putPrice(e, "USD", "LTC", 123n, at);
    network.use(http.get(KRAKEN, () => HttpResponse.json({ error: [], result: { XLTCZUSD: tick("1e5"), XXBTZUSD: tick("10") } })));
    await refreshPrices(e);
    const rec = JSON.parse((await e.KV.get("prices"))!) as Record<string, { e8: string; at: number }>;
    expect(rec["USD:LTC"]).toEqual({ e8: "123", at });
    expect(await getPriceE8(e, "BTC", "USD")).toBe(1_000_000_000n);
  });
});
