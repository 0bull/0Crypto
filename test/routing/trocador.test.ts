import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import {
  NoAcceptableQuote,
  TROCADOR_TICKERS,
  TradeQuoteMismatch,
  TrocadorError,
  TrocadorNotVerified,
  TrocadorPairUnverified,
  UnknownTradeStatus,
  trocador,
} from "../../src/routing/trocador";
import { accountFromSeed, deriveUtxoAddress } from "../../src/chains/utxo/derive";
import { ASSETS } from "../../src/core/assets";
import coinBtc from "../fixtures/trocador/coin-btc.json";
import coinUsdt from "../fixtures/trocador/coin-usdt.json";
import coinXmr from "../fixtures/trocador/coin-xmr.json";
import newRate from "../fixtures/trocador/new_rate.json";
import newTrade from "../fixtures/trocador/new_trade.json";
import tradeFinished from "../fixtures/trocador/trade-finished.json";

const network = setupNetwork();
const BASE = "https://api.trocador.app";
const KEY = "sk-test-SECRET-key-123";
const XMR = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
const BTC = TROCADOR_TICKERS["btc:btc"];
const kvStore = (env as unknown as Env).KV;
const cfg = (over: Partial<Env> = {}) => ({ KV: kvStore, TROCADOR_API_KEY: KEY, TROCADOR_MIN_KYC: "A", TROCADOR_LIVE_OK: "1", ...over }) as Env;

const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const addrOf = (c: "btc" | "ltc" | "doge", i: number) => deriveUtxoAddress(accountFromSeed(MN, c), c, i);
const BTC_DEP = addrOf("btc", 0);
const BTC_REFUND = addrOf("btc", 1);
const LTC_ADDR = addrOf("ltc", 0);
const DOGE_ADDR = addrOf("doge", 0);
const TRON_ADDR = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const SOL_ADDR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let seen: Request[] = [];
const coinHandler = (btc: unknown = coinBtc, xmr: unknown = coinXmr, usdt: unknown = coinUsdt) =>
  http.get(`${BASE}/coin`, ({ request }) => {
    seen.push(request as unknown as Request);
    const t = new URL(request.url).searchParams.get("ticker");
    const body = t === "btc" ? btc : t === "xmr" ? xmr : t === "usdt" ? usdt : [];
    return HttpResponse.json(body as object);
  });
const rate = (over: object = {}) => http.get(`${BASE}/new_rate`, ({ request }) => (seen.push(request as unknown as Request), HttpResponse.json({ ...newRate, ...over })));

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
beforeEach(async () => {
  seen = [];
  const { keys } = await kvStore.list({ prefix: "trocador:" });
  await Promise.all(keys.map((k) => kvStore.delete(k.name)));
});

describe("TROCADOR_TICKERS", () => {
  it("covers exactly the six routed assets, each a registered asset", () => {
    expect(Object.keys(TROCADOR_TICKERS).sort()).toEqual(["btc:btc", "doge:doge", "ltc:ltc", "sol:sol", "sol:usdc", "tron:usdt"]);
    for (const id of Object.keys(TROCADOR_TICKERS)) expect(ASSETS[id]).toBeDefined();
  });
});

describe("quote", () => {
  it("sends API-Key header (never in the URL) and min_kycrating, and picks the best acceptable quote", async () => {
    network.use(coinHandler(), rate());
    const q = await trocador(cfg()).quote(BTC, 100_000n, 8);
    expect(q).toMatchObject({ rateId: "RATE123abc", provider: "ProviderA", kycRating: "A", amountTo: "0.2511", amountToAtomic: 251_100_000_000n });
    const r = seen.find((s) => new URL(s.url).pathname === "/new_rate")!;
    const u = new URL(r.url);
    expect(r.headers.get("API-Key")).toBe(KEY);
    expect(u.searchParams.get("min_kycrating")).toBe("A");
    expect(u.searchParams.get("amount_from")).toBe("0.001");
    expect(u.searchParams.get("ticker_from")).toBe("btc");
    expect(u.searchParams.get("network_to")).toBe("Mainnet");
    for (const s of seen) expect(s.url).not.toContain(KEY);
  });

  it.each([
    ["A", "ProviderA", "A"],
    ["B", "ProviderB", "B"],
    ["C", "ProviderC", "C"],
    ["D", "ProviderD", "D"],
  ])("TROCADOR_MIN_KYC=%s picks %s (best amount among providers no worse than the minimum; unrated skipped)", async (min, provider, rating) => {
    network.use(coinHandler(), rate());
    const q = await trocador(cfg({ TROCADOR_MIN_KYC: min })).quote(BTC, 100_000n, 8);
    expect(q.provider).toBe(provider);
    expect(q.kycRating).toBe(rating);
  });

  it("defaults to A when TROCADOR_MIN_KYC is unset and rejects values outside A-D", async () => {
    network.use(coinHandler(), rate());
    expect((await trocador(cfg({ TROCADOR_MIN_KYC: undefined })).quote(BTC, 100_000n, 8)).provider).toBe("ProviderA");
    for (const bad of ["E", "a1", "AA", " "]) await expect(trocador(cfg({ TROCADOR_MIN_KYC: bad })).quote(BTC, 100_000n, 8)).rejects.toThrow(TrocadorError);
  });

  it("never picks a worse provider: throws NoAcceptableQuote, and skips a missing rating", async () => {
    network.use(coinHandler(), rate({ provider: "ProviderD", amount_to: 0.28, quotes: [{ provider: "ProviderD", kycrating: "D", amount_to: "0.28" }, { provider: "X", amount_to: "0.4" }] }));
    await expect(trocador(cfg()).quote(BTC, 100_000n, 8)).rejects.toThrow(NoAcceptableQuote);
    await expect(trocador(cfg({ TROCADOR_MIN_KYC: "C" })).quote(BTC, 100_000n, 8)).rejects.toThrow(NoAcceptableQuote);
  });

  it("accepts the top-level provider, taking its rating from the matching quote entry", async () => {
    network.use(coinHandler(), rate({ quotes: [{ provider: "ProviderA", kyc_rating: "B", amount_to: "0.2511" }] }));
    const q = await trocador(cfg({ TROCADOR_MIN_KYC: "B" })).quote(BTC, 100_000n, 8);
    expect(q).toMatchObject({ provider: "ProviderA", kycRating: "B" });
  });

  it("skips non-fixed quotes and accepts boolean true/false as well as 'True'/'False'; rejects other boolean spellings at the top level", async () => {
    network.use(coinHandler(), rate({ fixed: true, quotes: [{ provider: "ProviderA", kycrating: "A", amount_to: "0.2511", fixed: true }, { provider: "F", kycrating: "A", amount_to: "0.9", fixed: false }] }));
    expect((await trocador(cfg()).quote(BTC, 100_000n, 8)).provider).toBe("ProviderA");
    network.use(rate({ fixed: "yes" }));
    await expect(trocador(cfg()).quote(BTC, 100_000n, 8)).rejects.toThrow(TrocadorError);
  });

  it("fails closed: non-2xx, malformed JSON, missing fields, error field; and the API key never appears in errors", async () => {
    const run = () => trocador(cfg()).quote(BTC, 100_000n, 8);
    for (const handler of [
      http.get(`${BASE}/new_rate`, () => new HttpResponse(`boom ${KEY}`, { status: 500 })),
      http.get(`${BASE}/new_rate`, () => new HttpResponse(`not json ${KEY}`, { status: 200 })),
      http.get(`${BASE}/new_rate`, () => HttpResponse.json({ provider: "ProviderA" })),
      http.get(`${BASE}/new_rate`, () => HttpResponse.json({ ...newRate, trade_id: "" })),
      http.get(`${BASE}/new_rate`, () => HttpResponse.json({ error: `bad ${KEY}` })),
    ]) {
      network.use(coinHandler(), handler);
      const err = await run().then(
        () => null,
        (e) => e as Error,
      );
      expect(err, "should throw").toBeInstanceOf(Error);
      expect(String(err!.message)).not.toContain(KEY);
      expect(String(err!.stack)).not.toContain(KEY);
    }
  });

  it("rejects amounts with excess precision from the API (skips that quote) rather than rounding", async () => {
    network.use(coinHandler(), rate({ amount_to: "0.1234567890123", quotes: [{ provider: "ProviderA", kycrating: "A", amount_to: "0.1234567890123" }] }));
    await expect(trocador(cfg()).quote(BTC, 100_000n, 8)).rejects.toThrow(NoAcceptableQuote);
  });

  it("treats a missing fixed value on a quote entry as not-fixed and skips it", async () => {
    network.use(
      coinHandler(),
      rate({ provider: "Top", fixed: undefined, quotes: [{ provider: "NoFixed", kycrating: "A", amount_to: "0.9" }, { provider: "Fx", kycrating: "A", amount_to: "0.3", fixed: "True" }] }),
    );
    expect((await trocador(cfg()).quote(BTC, 100_000n, 8)).provider).toBe("Fx");
  });

  it("throws NoAcceptableQuote when no quote carries any rating field", async () => {
    network.use(coinHandler(), rate({ quotes: [{ provider: "ProviderA", amount_to: "0.2511", fixed: "True" }, { provider: "B", amount_to: "0.3", fixed: "True" }] }));
    await expect(trocador(cfg()).quote(BTC, 100_000n, 8)).rejects.toBeInstanceOf(NoAcceptableQuote);
  });

  it("does not read an ambiguous `amount` key", async () => {
    network.use(coinHandler(), rate({ amount_to: undefined, quotes: [{ provider: "ProviderA", kycrating: "A", amount: "0.5", fixed: "True" }] }));
    await expect(trocador(cfg()).quote(BTC, 100_000n, 8)).rejects.toBeInstanceOf(NoAcceptableQuote);
  });

  it("does not follow redirects (the API key must not leave api.trocador.app)", async () => {
    let evilHit = false;
    network.use(
      coinHandler(),
      http.get(`${BASE}/new_rate`, () => new HttpResponse(null, { status: 302, headers: { location: "https://evil.example/steal" } })),
      http.get("https://evil.example/steal", () => ((evilHit = true), HttpResponse.json(newRate))),
    );
    await expect(trocador(cfg()).quote(BTC, 100_000n, 8)).rejects.toThrow(/HTTP 302/);
    expect(evilHit).toBe(false);
  });

  it("requires an API key", async () => {
    await expect(trocador(cfg({ TROCADOR_API_KEY: "" })).quote(BTC, 100_000n, 8)).rejects.toThrow(/TROCADOR_API_KEY/);
  });
});

describe("pair resolution via /coin", () => {
  it("requires exactly one entry with the expected network", async () => {
    const usdt = TROCADOR_TICKERS["tron:usdt"];
    network.use(coinHandler(), rate());
    await expect(trocador(cfg()).quote(usdt, 10_000_000n, 6)).resolves.toBeDefined(); // fixture lists the expected network once
    const none = coinUsdt.filter((c) => c.network !== usdt.network);
    network.use(coinHandler(coinBtc, coinXmr, none));
    await expect(trocador(cfg({ KV: fakeKv() })).quote(usdt, 10_000_000n, 6)).rejects.toThrow(TrocadorPairUnverified);
    const dup = [...coinUsdt, ...coinUsdt.filter((c) => c.network === usdt.network)];
    network.use(coinHandler(coinBtc, coinXmr, dup));
    await expect(trocador(cfg({ KV: fakeKv() })).quote(usdt, 10_000_000n, 6)).rejects.toThrow(TrocadorPairUnverified);
  });

  it("refuses memo coins for the from-coin and for XMR", async () => {
    network.use(coinHandler([{ ...coinBtc[0], memo: "True" }], coinXmr), rate());
    await expect(trocador(cfg({ KV: fakeKv() })).quote(BTC, 100_000n, 8)).rejects.toThrow(TrocadorPairUnverified);
    network.use(coinHandler(coinBtc, [{ ...coinXmr[0], memo: true }]));
    await expect(trocador(cfg({ KV: fakeKv() })).quote(BTC, 100_000n, 8)).rejects.toThrow(TrocadorPairUnverified);
  });

  it("refuses an XMR network other than Mainnet", async () => {
    network.use(coinHandler(coinBtc, [{ ...coinXmr[0], network: "Other" }]), rate());
    await expect(trocador(cfg({ KV: fakeKv() })).quote(BTC, 100_000n, 8)).rejects.toThrow(TrocadorPairUnverified);
  });
});

describe("minimum", () => {
  it("reads /coin, caches the decimal string in KV for 24h, and serves from cache without the network", async () => {
    network.use(coinHandler());
    const t = trocador(cfg());
    expect(await t.minimum(BTC, 8)).toBe(50_000n);
    const cached = await kvStore.get("trocador:coin:btc:Mainnet");
    expect(cached).toBeTruthy();
    expect(JSON.parse(cached!).minimum).toBe("0.0005");
    network.use(http.get(`${BASE}/coin`, () => new HttpResponse(null, { status: 500 })));
    expect(await t.minimum(BTC, 8)).toBe(50_000n);
  });

  it("a KV miss followed by a fetch failure throws (never zero)", async () => {
    network.use(http.get(`${BASE}/coin`, () => new HttpResponse(null, { status: 503 })));
    await expect(trocador(cfg()).minimum(BTC, 8)).rejects.toThrow();
    network.use(http.get(`${BASE}/coin`, () => new HttpResponse("{", { status: 200 })));
    await expect(trocador(cfg()).minimum(BTC, 8)).rejects.toThrow();
  });

  it("a corrupt cache entry is a miss", async () => {
    await kvStore.put("trocador:coin:btc:Mainnet", "garbage");
    network.use(coinHandler());
    expect(await trocador(cfg()).minimum(BTC, 8)).toBe(50_000n);
  });

  it("rejects a minimum with more decimals than the asset has", async () => {
    network.use(coinHandler([{ ...coinBtc[0], minimum: "0.000500001" }], coinXmr));
    await expect(trocador(cfg({ KV: fakeKv() })).minimum(BTC, 8)).rejects.toThrow();
  });
});

describe("trade", () => {
  const args = (over: object = {}) => ({ rateId: "RATE123abc", provider: "ProviderA", from: BTC, amountFrom: 100_000n, decimals: 8, xmrAddress: XMR, refundAddress: BTC_REFUND, quotedAmountTo: 251_100_000_000n, ...over });
  const tradeHandler = (over: object = {}) => http.get(`${BASE}/new_trade`, ({ request }) => (seen.push(request as unknown as Request), HttpResponse.json({ ...newTrade, ...over })));

  it("refuses without TROCADOR_LIVE_OK=1 before any network call", async () => {
    for (const v of [undefined, "", "0", "true", "1 "]) {
      seen = [];
      await expect(trocador(cfg({ TROCADOR_LIVE_OK: v })).trade(args())).rejects.toThrow(TrocadorNotVerified);
      expect(seen).toHaveLength(0);
    }
  });

  it("creates a fixed-rate trade and maps address_provider to depositAddress", async () => {
    network.use(coinHandler(), tradeHandler());
    const t = await trocador(cfg()).trade(args());
    expect(t).toMatchObject({ tradeId: "TRADE789xyz", providerTradeId: "PROV-555", depositAddress: newTrade.address_provider, amountTo: "0.2511", provider: "ProviderA" });
    expect(t).not.toHaveProperty("depositMemo");
    const r = seen.find((s) => new URL(s.url).pathname === "/new_trade")!;
    const p = new URL(r.url).searchParams;
    expect(r.headers.get("API-Key")).toBe(KEY);
    expect(r.url).not.toContain(KEY);
    expect(p.get("id")).toBe("RATE123abc");
    expect(p.get("provider")).toBe("ProviderA");
    expect(p.get("fixed")).toBe("True");
    expect(p.get("payment")).toBe("False");
    expect(p.get("address")).toBe(XMR);
    expect(p.get("address_memo")).toBe("0");
    expect(p.get("amount_from")).toBe("0.001");
    expect(p.get("min_kycrating")).toBe("A");
    expect(p.get("refund")).toBe(BTC_REFUND);
    expect(p.get("refund_memo")).toBe("0");
    expect([...p.keys()].sort()).toEqual(["address", "address_memo", "amount_from", "fixed", "id", "min_kycrating", "network_from", "network_to", "payment", "provider", "refund", "refund_memo", "ticker_from", "ticker_to"]);
  });

  it("throws when the response asks for a deposit memo", async () => {
    network.use(coinHandler(), tradeHandler({ address_provider_memo: "12345" }));
    await expect(trocador(cfg()).trade(args())).rejects.toThrow(/memo/);
  });

  it("returns expiresAt and support when the response has them", async () => {
    network.use(coinHandler(), tradeHandler({ quotes: { support: "https://s.example/x", expiresAt: "2026-11-13T10:30:00Z" } }));
    expect(await trocador(cfg()).trade(args())).toMatchObject({ support: "https://s.example/x", expiresAt: "2026-11-13T10:30:00Z" });
  });

  it("throws on an invalid XMR address without any network call", async () => {
    for (const bad of ["", "44AFF", XMR.slice(0, 94) + "B", "bc1qxyz"]) {
      seen = [];
      await expect(trocador(cfg()).trade(args({ xmrAddress: bad }))).rejects.toThrow();
      expect(seen).toHaveLength(0);
    }
  });

  const REJECTS: Array<[string, object, RegExp | (new (...a: never[]) => Error)]> = [
    ["no trade_id", { trade_id: undefined }, /trade_id/],
    ["no deposit address", { address_provider: "" }, /address_provider/],
    ["unknown status", { status: "teleporting" }, UnknownTradeStatus],
    ["status not new/waiting", { status: "finished" }, /creation status/],
    ["address_user absent", { address_user: undefined }, /address_user/],
    ["address_user None", { address_user: "None" }, /pays out/],
    ["address_user differs", { address_user: "4" + XMR.slice(1, 94) + "Z" }, /pays out/],
    ["amount_from absent", { amount_from: undefined }, /amount_from/],
    ["amount_from differs", { amount_from: 0.002 }, /amount differs/],
    ["not fixed", { fixed: "False" }, /non-fixed/],
    ["fixed missing", { fixed: undefined }, /fixed/],
    ["provider differs", { provider: "Other" }, TradeQuoteMismatch],
    ["amount_to re-quoted", { amount_to: 0.25 }, TradeQuoteMismatch],
    ["ticker_from echo", { ticker_from: "ltc" }, /echo/],
    ["network_from echo", { network_from: "Lightning" }, /echo/],
    ["ticker_to echo", { ticker_to: "btc" }, /echo/],
    ["network_to echo", { network_to: "Stagenet" }, /echo/],
    ["echo missing", { ticker_to: undefined }, /ticker_to/],
    ["litecoin deposit address for BTC", { address_provider: LTC_ADDR }, /invalid btc address/],
    ["refund echo differs", { refund_address: LTC_ADDR }, /refund/],
    ["refund echo missing", { refund_address: undefined }, /refund/],
    ["refund echo None", { refund_address: "None" }, /refund/],
    ["memo", { address_provider_memo: "5" }, /memo/],
  ];
  it.each(REJECTS)("fails closed: %s", async (_name, over, expected) => {
    network.use(coinHandler(), tradeHandler(over));
    const err = await trocador(cfg()).trade(args()).then(() => null, (e) => e as Error);
    expect(err).toBeInstanceOf(typeof expected === "function" ? expected : TrocadorError);
    if (typeof expected !== "function") expect(err!.message).toMatch(expected);
    expect(err!.message).not.toContain(KEY);
  });

  it("fails closed on non-2xx and malformed bodies without leaking the key", async () => {
    for (const [h, msg] of [
      [http.get(`${BASE}/new_trade`, () => new HttpResponse(`x ${KEY}`, { status: 500 })), /HTTP 500/],
      [http.get(`${BASE}/new_trade`, () => new HttpResponse("nope", { status: 200 })), /not JSON/],
    ] as const) {
      network.use(coinHandler(), h);
      const err = await trocador(cfg()).trade(args()).then(() => null, (e) => e as Error);
      expect(err!.message).toMatch(msg);
      expect(err!.message).not.toContain(KEY);
    }
  });

  it("accepts the waiting creation status", async () => {
    network.use(coinHandler(), tradeHandler({ status: "waiting" }));
    expect((await trocador(cfg()).trade(args())).status).toBe("waiting");
  });

  it("requires a refund address valid for the source chain, before any network call", async () => {
    for (const bad of [undefined, "", LTC_ADDR, "bc1qxyz", XMR]) {
      seen = [];
      await expect(trocador(cfg()).trade(args({ refundAddress: bad }))).rejects.toThrow();
      expect(seen).toHaveLength(0);
    }
  });

  it("validates the deposit address per source chain (valid accepted, other chains' addresses rejected)", async () => {
    const cases: Array<[string, string, string, string, string[]]> = [
      ["btc:btc", BTC_DEP, BTC_REFUND, "0.001", [LTC_ADDR, DOGE_ADDR, TRON_ADDR, SOL_ADDR, "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"]],
      ["ltc:ltc", LTC_ADDR, addrOf("ltc", 1), "0.001", [BTC_DEP, DOGE_ADDR, TRON_ADDR, SOL_ADDR]],
      ["doge:doge", DOGE_ADDR, addrOf("doge", 1), "0.001", [BTC_DEP, LTC_ADDR, TRON_ADDR, SOL_ADDR]],
      ["tron:usdt", TRON_ADDR, "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", "0.001", [BTC_DEP, SOL_ADDR, TRON_ADDR.slice(0, -1) + "k"]],
      ["sol:sol", SOL_ADDR, "11111111111111111111111111111111", "0.001", [BTC_DEP, TRON_ADDR, "abc", "1".repeat(31), "1".repeat(33)]],
      ["sol:usdc", SOL_ADDR, "11111111111111111111111111111111", "0.001", [BTC_DEP, TRON_ADDR]],
    ];
    for (const [asset, good, refund, _amt, wrongs] of cases) {
      const coin = TROCADOR_TICKERS[asset]!;
      const dec = ASSETS[asset]!.decimals;
      const a = args({ from: coin, decimals: dec, amountFrom: 10n ** BigInt(dec - 3), refundAddress: refund });
      const echo = { ticker_from: coin.ticker, network_from: coin.network, amount_from: "0.001", address_provider: good, refund_address: refund };
      network.use(coinFor2(), tradeHandler(echo));
      expect((await trocador(cfg({ KV: fakeKv() })).trade(a)).depositAddress, asset).toBe(good);
      for (const w of wrongs) {
        network.use(tradeHandler({ ...echo, address_provider: w }));
        await expect(trocador(cfg({ KV: fakeKv() })).trade(a), `${asset} ${w}`).rejects.toThrow(/invalid/);
      }
    }
  });
});

// One /coin handler that serves every coin the cases above touch.
const ALL_COINS = [
  ...coinBtc,
  ...coinXmr,
  ...coinUsdt,
  { name: "Litecoin", ticker: "ltc", network: "Mainnet", memo: "False", minimum: 0.01, maximum: 100 },
  { name: "Dogecoin", ticker: "doge", network: "Mainnet", memo: "False", minimum: 10, maximum: 100000 },
  { name: "Solana", ticker: "sol", network: "Mainnet", memo: "False", minimum: 0.1, maximum: 1000 },
  { name: "USDC", ticker: "usdc", network: "Solana", memo: "False", minimum: 1, maximum: 100000 },
];
function coinFor2() {
  return http.get(`${BASE}/coin`, ({ request }) => HttpResponse.json(ALL_COINS.filter((c) => c.ticker === new URL(request.url).searchParams.get("ticker"))));
}

describe("cache isolation", () => {
  it("keys the coin cache by ticker and network: one asset's entry never serves another's", async () => {
    network.use(coinHandler());
    const t = trocador(cfg());
    expect(await t.minimum(BTC, 8)).toBe(50_000n);
    expect(await t.minimum(TROCADOR_TICKERS["tron:usdt"], 6)).toBe(10_500_000n);
    expect(await t.minimum({ ticker: "usdt", network: "ERC20" }, 6)).toBe(10_000_000n);
    expect(await kvStore.get("trocador:coin:usdt:TRC20")).toContain("10.5");
    expect(await kvStore.get("trocador:coin:usdt:ERC20")).toContain('"10"');
  });
});

describe("status", () => {
  const statusHandler = (body: object) => http.get(`${BASE}/trade`, ({ request }) => (seen.push(request as unknown as Request), HttpResponse.json(body)));

  it("maps the documented enum exactly", async () => {
    const expected: Record<string, string> = {
      new: "new", waiting: "waiting", confirming: "confirming", sending: "sending", "paid partially": "paid_partially",
      finished: "finished", failed: "failed", expired: "expired", halted: "halted", refunded: "refunded",
    };
    for (const [raw, mapped] of Object.entries(expected)) {
      network.use(statusHandler({ ...tradeFinished, status: raw }));
      expect((await trocador(cfg()).status("TRADE789xyz")).status).toBe(mapped);
    }
    expect(seen[0]!.headers.get("API-Key")).toBe(KEY);
    expect(new URL(seen[0]!.url).searchParams.get("id")).toBe("TRADE789xyz");
  });

  it("returns hashout only when finished", async () => {
    network.use(statusHandler(tradeFinished));
    expect(await trocador(cfg()).status("TRADE789xyz")).toMatchObject({ status: "finished", hashout: tradeFinished.details.hashout, support: "https://support.provider-a.example/t/PROV-555" });
    network.use(statusHandler({ ...tradeFinished, status: "sending" }));
    expect((await trocador(cfg()).status("TRADE789xyz")).hashout).toBeUndefined();
  });

  it("an unknown status string throws UnknownTradeStatus, never success", async () => {
    for (const s of ["done", "complete", "", "finished!"]) {
      network.use(statusHandler({ ...tradeFinished, status: s }));
      await expect(trocador(cfg()).status("TRADE789xyz")).rejects.toThrow(UnknownTradeStatus);
    }
    network.use(statusHandler({ ...tradeFinished, status: undefined }));
    await expect(trocador(cfg()).status("TRADE789xyz")).rejects.toThrow(TrocadorError);
  });

  it("fails closed on non-2xx, malformed body, and a different trade id", async () => {
    network.use(http.get(`${BASE}/trade`, () => new HttpResponse(null, { status: 404 })));
    await expect(trocador(cfg()).status("TRADE789xyz")).rejects.toThrow();
    network.use(http.get(`${BASE}/trade`, () => new HttpResponse("x", { status: 200 })));
    await expect(trocador(cfg()).status("TRADE789xyz")).rejects.toThrow();
    network.use(statusHandler({ ...tradeFinished, trade_id: "OTHER" }));
    await expect(trocador(cfg()).status("TRADE789xyz")).rejects.toThrow(TrocadorError);
  });

  it("requires the trade_id echo", async () => {
    network.use(statusHandler({ ...tradeFinished, trade_id: undefined }));
    await expect(trocador(cfg()).status("TRADE789xyz")).rejects.toThrow(/trade_id/);
  });

  it("is usable without TROCADOR_LIVE_OK", async () => {
    network.use(statusHandler(tradeFinished));
    await expect(trocador(cfg({ TROCADOR_LIVE_OK: "" })).status("TRADE789xyz")).resolves.toBeDefined();
  });
});

/** A throwaway KV so tests that must not hit the shared cache do not poison each other. */
function fakeKv(): KVNamespace {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) } as unknown as KVNamespace;
}
