import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chainConfigError, counterKey, getAdapter, startIndex } from "../../../src/chains/registry";
import { tronAdapter } from "../../../src/chains/tron/adapter";
import { tronBase58ToHex } from "../../../src/chains/tron/address";
import { tronDepositKey, tronHotKey } from "../../../src/signing/keys";
import { tronGrid } from "../../../src/chains/tron/trongrid";
import { enabledAssets } from "../../../src/config";
import { getAsset } from "../../../src/core/assets";
import type { DepositTarget } from "../../../src/core/types";
import type { Env } from "../../../src/env";
import { refreshPrices } from "../../../src/prices/cache";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const API = "https://api.trongrid.io";
const KEY = "test-trongrid-key";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_HEX = tronBase58ToHex(USDT);
const ADDR = tronDepositKey(SEED, 0).address;
const OTHER = tronDepositKey(SEED, 1).address;
const HOUR = 3_600_000;
const ASSET = getAsset("tron:usdt");
const HOT = tronHotKey(SEED).address;
const H = (a: string) => tronBase58ToHex(a);
/** A /v1/accounts/{addr}/transactions row (visible=false: hex addresses). */
const trxRow = (txID: string, amount: number, from: string, o: { to?: string; ret?: string; type?: string } = {}): Row => ({
  txID,
  ret: [{ contractRet: o.ret ?? "SUCCESS", fee: 0 }],
  block_timestamp: 10 * HOUR + 2000,
  raw_data: {
    contract: [{ type: o.type ?? "TransferContract", parameter: { value: { amount, owner_address: H(from), to_address: H(o.to ?? ADDR) }, type_url: "type.googleapis.com/protocol.TransferContract" } }],
  },
});

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

const mkEnv = (o: Partial<Env> = {}): Env =>
  ({ MASTER_SEED: SEED, ALLOW_SEED_CUSTODY: "true", ENABLED_ASSETS: "tron:usdt", TRONGRID_API_KEY: KEY, ...o }) as Env;
const target = (o: Partial<DepositTarget> = {}): DepositTarget => ({
  paymentId: "p1",
  chain: "tron",
  asset: "tron:usdt",
  address: ADDR,
  derivationIndex: 0,
  createdAt: 10 * HOUR,
  ...o,
});

type Row = Record<string, unknown>;
const row = (txid: string, value: string, o: Row = {}): Row => ({
  transaction_id: txid,
  token_info: { symbol: "USDT", address: USDT, decimals: 6, name: "Tether USD" },
  block_timestamp: 10 * HOUR + 1000,
  from: OTHER,
  to: ADDR,
  type: "Transfer",
  value,
  ...o,
});
const TRANSFER = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const body = (a: string) => tronBase58ToHex(a).slice(2);
const pad = (h: string, n = 64) => h.padStart(n, "0");
/** A Transfer(from, to, value) log as the solidity node prints it: no 0x, 20-byte address. */
const log = (value: bigint, o: { to?: string; contract?: string; from?: string } = {}) => ({
  address: o.contract ?? USDT_HEX.slice(2),
  topics: [TRANSFER, pad(body(o.from ?? OTHER)), pad(body(o.to ?? ADDR))],
  data: pad(value.toString(16)),
});
const solid = (result: string, logs: unknown[] = [], contract = USDT_HEX) => ({ id: "x", blockNumber: 1, receipt: { result }, contract_address: contract, log: logs });
/** A solid successful tx that paid `value` to ADDR. */
const paid = (value: bigint, to = ADDR) => solid("SUCCESS", [log(value, { to })]);

interface Sim {
  /** trc20 pages in order; a page with `next` carries meta.fingerprint. */
  pages: Array<{ rows: Row[]; next?: string }>;
  /** txid -> solidity response body ({} when absent) */
  solid: Record<string, unknown>;
  /** GET /v1/accounts/{addr} body */
  account: Record<string, unknown>;
  /** GET /v1/accounts/{addr}/transactions pages (incoming TRX); a page with `next` carries meta.fingerprint. */
  trxPages: Array<{ rows: Row[]; next?: string }>;
  /** Observed requests. */
  log: { trc20: URL[]; solid: string[]; account: number; trxQueries: URL[]; headers: Array<string | null> };
}
const sim = (o: Partial<Sim> = {}): Sim => ({ pages: [{ rows: [] }], solid: {}, account: { data: [], success: true }, trxPages: [{ rows: [] }], ...o, log: { trc20: [], solid: [], account: 0, trxQueries: [], headers: [] } });

function serve(s: Sim, base = API) {
  network.use(
    http.get(`${base}/v1/accounts/:addr/transactions/trc20`, ({ request }) => {
      const url = new URL(request.url);
      s.log.trc20.push(url);
      s.log.headers.push(request.headers.get("TRON-PRO-API-KEY"));
      const fp = url.searchParams.get("fingerprint");
      const idx = fp === null ? 0 : Number(fp.replace("fp", ""));
      const page = s.pages[Math.min(idx, s.pages.length - 1)]!;
      return HttpResponse.json({ data: page.rows, success: true, meta: { at: 1, page_size: page.rows.length, ...(page.next ? { fingerprint: page.next } : {}) } });
    }),
    http.post(`${base}/walletsolidity/gettransactioninfobyid`, async ({ request }) => {
      const { value } = (await request.json()) as { value: string };
      s.log.solid.push(value);
      s.log.headers.push(request.headers.get("TRON-PRO-API-KEY"));
      return HttpResponse.json((s.solid[value] ?? {}) as Record<string, unknown>);
    }),
    http.get(`${base}/v1/accounts/:addr/transactions`, ({ request }) => {
      const url = new URL(request.url);
      s.log.account++;
      s.log.trxQueries.push(url);
      s.log.headers.push(request.headers.get("TRON-PRO-API-KEY"));
      const fp = url.searchParams.get("fingerprint");
      const page = s.trxPages[Math.min(fp === null ? 0 : Number(fp.replace("tfp", "")), s.trxPages.length - 1)]!;
      return HttpResponse.json({ data: page.rows, success: true, meta: { at: 1, page_size: page.rows.length, ...(page.next ? { fingerprint: page.next } : {}) } });
    }),
    http.get(`${base}/v1/accounts/:addr`, ({ request }) => {
      s.log.headers.push(request.headers.get("TRON-PRO-API-KEY"));
      return HttpResponse.json(s.account);
    }),
  );
}
const observe = (s: Sim, o: { env?: Env; t?: DepositTarget; cache?: Map<string, bigint> } = {}) => {
  serve(s);
  return tronAdapter(o.env ?? mkEnv(), o.cache ?? new Map<string, bigint>()).observe(o.t ?? target(), ASSET);
};

describe("tron observe", () => {
  it("received sums every incoming transfer; final only the solid successful ones", async () => {
    const s = sim({ pages: [{ rows: [row("a", "30000000"), row("b", "20000000")] }], solid: { a: paid(30_000_000n) } });
    expect(await observe(s)).toStrictEqual({ received: 50_000_000n, final: 30_000_000n, txids: ["a", "b"] });
  });

  it("a solid REVERT is not final", async () => {
    const s = sim({ pages: [{ rows: [row("a", "30000000"), row("b", "20000000")] }], solid: { a: paid(30_000_000n), b: solid("REVERT", [log(20_000_000n)]) } });
    expect(await observe(s)).toMatchObject({ received: 50_000_000n, final: 30_000_000n });
  });

  it("sends the TRON-PRO-API-KEY header on every request kind", async () => {
    const s = sim({ pages: [{ rows: [row("a", "1000000")] }], solid: { a: paid(1_000_000n) } });
    await observe(s);
    expect(s.log.trc20.length).toBe(1);
    expect(s.log.solid).toEqual(["a"]);
    expect(s.log.account).toBe(1);
    expect(s.log.headers).toEqual([KEY, KEY, KEY]);
  });

  it("follows meta.fingerprint and sums both pages", async () => {
    const s = sim({
      pages: [{ rows: [row("a", "30000000")], next: "fp1" }, { rows: [row("b", "20000000")] }],
      solid: { a: paid(30_000_000n), b: paid(20_000_000n) },
    });
    expect(await observe(s)).toMatchObject({ received: 50_000_000n, final: 50_000_000n, txids: ["a", "b"] });
    expect(s.log.trc20.map((u) => u.searchParams.get("fingerprint"))).toEqual([null, "fp1"]);
  });

  it("queries only_to, the contract, min_timestamp = createdAt - 1h and limit 200", async () => {
    const s = sim();
    await observe(s);
    const q = s.log.trc20[0]!.searchParams;
    expect(s.log.trc20[0]!.pathname).toBe(`/v1/accounts/${ADDR}/transactions/trc20`);
    expect(q.get("only_to")).toBe("true");
    expect(q.get("contract_address")).toBe(USDT);
    expect(q.get("min_timestamp")).toBe(String(9 * HOUR));
    expect(q.get("limit")).toBe("200");
  });

  it("clamps min_timestamp at 0", async () => {
    const s = sim();
    await observe(s, { t: target({ createdAt: 1000 }) });
    expect(s.log.trc20[0]!.searchParams.get("min_timestamp")).toBe("0");
  });

  it("ignores a wrong-contract row, a wrong-to row and a non-Transfer row", async () => {
    const s = sim({
      pages: [
        {
          rows: [
            row("good", "5000000"),
            row("fake", "999000000", { token_info: { symbol: "USDT", address: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj", decimals: 6 } }),
            row("misdirected", "999000000", { to: OTHER }),
            row("approval", "999000000", { type: "Approval" }),
          ],
        },
      ],
      solid: { good: paid(5_000_000n) },
    });
    expect(await observe(s)).toStrictEqual({ received: 5_000_000n, final: 5_000_000n, txids: ["good"] });
    expect(s.log.solid).toEqual(["good"]);
  });

  it("keeps a duplicated /v1 row in received but credits the tx once, from its solid logs", async () => {
    const s = sim({ pages: [{ rows: [row("a", "7000000")], next: "fp1" }, { rows: [row("a", "7000000")] }], solid: { a: paid(14_000_000n) } });
    expect(await observe(s)).toStrictEqual({ received: 14_000_000n, final: 14_000_000n, txids: ["a"] });
    expect(s.log.solid).toEqual(["a"]);
  });

  it("final comes from the solid logs, not the /v1 value; received is raised to final when the index lags", async () => {
    const s = sim({ pages: [{ rows: [row("a", "1000000")] }], solid: { a: paid(9_000_000n) } });
    expect(await observe(s)).toStrictEqual({ received: 9_000_000n, final: 9_000_000n, txids: ["a"] });
  });

  it("a multi-transfer tx (two logs to addr) counts both", async () => {
    const s = sim({ pages: [{ rows: [row("a", "3000000"), row("a", "4000000")] }], solid: { a: solid("SUCCESS", [log(3_000_000n), log(4_000_000n)]) } });
    expect(await observe(s)).toMatchObject({ received: 7_000_000n, final: 7_000_000n, txids: ["a"] });
  });

  it("ignores a log from another contract and a log to another address inside a SUCCESS tx", async () => {
    const other = "ab".repeat(20);
    const s = sim({
      pages: [{ rows: [row("a", "2000000")] }],
      solid: { a: solid("SUCCESS", [log(2_000_000n), log(900_000_000n, { contract: other }), log(800_000_000n, { to: OTHER })]) },
    });
    expect(await observe(s)).toMatchObject({ received: 2_000_000n, final: 2_000_000n });
  });

  it("counts a USDT log to addr when the tx called a wrapper contract", async () => {
    const s = sim({ pages: [{ rows: [row("a", "1000000")] }], solid: { a: solid("SUCCESS", [log(1_000_000n)], "41" + "ab".repeat(20)) } });
    expect(await observe(s)).toMatchObject({ final: 1_000_000n });
  });

  it("accepts a log address with the 41 prefix, in upper case", async () => {
    const l = log(1_000_000n, { contract: USDT_HEX.toUpperCase() });
    const s = sim({ pages: [{ rows: [row("a", "1000000")] }], solid: { a: solid("SUCCESS", [l]) } });
    expect(await observe(s)).toMatchObject({ final: 1_000_000n });
  });

  it("ignores dust (< 0.01 USDT): not received, not looked up", async () => {
    const s = sim({ pages: [{ rows: [row("dust", "9999"), row("real", "10000")] }], solid: { real: paid(10_000n), dust: paid(9_999n) } });
    expect(await observe(s)).toStrictEqual({ received: 10_000n, final: 10_000n, txids: ["real"] });
    expect(s.log.solid).toEqual(["real"]);
  });

  it("looks up at most 40 uncached txids per observe, largest /v1 value first, at most 6 at a time", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`t${i}`, String(1_000_000 + i * 1000)));
    const solidMap = Object.fromEntries(rows.map((r) => [r.transaction_id as string, paid(BigInt(r.value as string))]));
    const s = sim({ pages: [{ rows }], solid: solidMap });
    serve(s);
    let inFlight = 0;
    let peak = 0;
    network.use(
      http.post(`${API}/walletsolidity/gettransactioninfobyid`, async ({ request }) => {
        const { value } = (await request.json()) as { value: string };
        s.log.solid.push(value);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return HttpResponse.json(solidMap[value] as Record<string, unknown>);
      }),
    );
    const cache = new Map<string, bigint>();
    const out = await tronAdapter(mkEnv(), cache).observe(target(), ASSET);
    expect(s.log.solid.length).toBe(40);
    expect(new Set(s.log.solid)).toEqual(new Set(rows.slice(10).map((r) => r.transaction_id))); // the 10 smallest wait
    expect(peak).toBe(6);
    expect(out.txids.length).toBe(50);
    expect(out.final).toBe(rows.slice(10).reduce((a, r) => a + BigInt(r.value as string), 0n)); // unlooked-up txids count 0
    // the next poll picks up the rest
    s.log.solid.length = 0;
    await tronAdapter(mkEnv(), cache).observe(target(), ASSET);
    expect(new Set(s.log.solid)).toEqual(new Set(rows.slice(0, 10).map((r) => r.transaction_id)));
  });

  it("tolerates foreign logs with missing fields and still credits the USDT Transfer", async () => {
    const nft = { address: "ab".repeat(20), topics: [TRANSFER, pad(body(OTHER)), pad(body(ADDR)), pad("1")] }; // no data field
    const oneTopic = { address: "cd".repeat(20), topics: ["aa".repeat(32)], data: "" };
    const noTopicsNoData = { address: "ef".repeat(20), topics: [] };
    const topicsOmitted = { address: "12".repeat(20), data: "" }; // LOG0: protobuf-JSON drops the empty topics array
    const s = sim({ pages: [{ rows: [row("a", "2000000")] }], solid: { a: solid("SUCCESS", [nft, oneTopic, noTopicsNoData, topicsOmitted, log(2_000_000n)]) } });
    expect(await observe(s)).toMatchObject({ received: 2_000_000n, final: 2_000_000n });
  });

  it("a 42-char log address that does not start with 41 is not USDT (not counted, no throw)", async () => {
    const l = { ...log(1_000_000n), address: "42" + USDT_HEX.slice(4) };
    const s = sim({ pages: [{ rows: [row("a", "1000000")] }], solid: { a: solid("SUCCESS", [l]) } });
    expect(await observe(s)).toMatchObject({ final: 0n });
  });

  it("one lookup error fails the observe and stops the other workers", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`t${i}`, String(1_000_000 + i)));
    const s = sim({ pages: [{ rows }] });
    serve(s);
    let calls = 0;
    network.use(
      http.post(`${API}/walletsolidity/gettransactioninfobyid`, async () => {
        const n = ++calls;
        await new Promise((r) => setTimeout(r, 5));
        return n === 3 ? new HttpResponse("down", { status: 503 }) : HttpResponse.json({});
      }),
    );
    await expect(tronAdapter(mkEnv(), new Map<string, bigint>()).observe(target(), ASSET)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBeLessThan(15);
  });

  it("cache hits do not count against the lookup cap", async () => {
    const rows = Array.from({ length: 55 }, (_, i) => row(`t${i}`, String(1_000_000 + i * 1000)));
    const s = sim({ pages: [{ rows }], solid: Object.fromEntries(rows.map((r) => [r.transaction_id as string, paid(BigInt(r.value as string))])) });
    const cache = new Map<string, bigint>();
    for (const r of rows.slice(10)) cache.set(`${API}|${r.transaction_id}|${ADDR}`, BigInt(r.value as string));
    const out = await observe(s, { cache });
    expect(s.log.solid.length).toBe(10);
    expect(out.final).toBe(rows.reduce((a, r) => a + BigInt(r.value as string), 0n));
  });

  it("a TRX balance failure omits unexpected but the observation still succeeds", async () => {
    const s = sim({ pages: [{ rows: [row("a", "1000000")] }], solid: { a: paid(1_000_000n) } });
    serve(s);
    network.use(http.get(`${API}/v1/accounts/:addr/transactions`, () => new HttpResponse("down", { status: 503 })));
    const out = await tronAdapter(mkEnv(), new Map<string, bigint>()).observe(target(), ASSET);
    expect(out).toStrictEqual({ received: 1_000_000n, final: 1_000_000n, txids: ["a"] });
    expect("unexpected" in out).toBe(false);
  });

  it("a SUCCESS tx with no USDT log to addr is not final", async () => {
    const s = sim({ pages: [{ rows: [row("a", "1000000")] }], solid: { a: solid("SUCCESS", [log(1_000_000n, { contract: "ab".repeat(20) })]) } });
    expect(await observe(s)).toMatchObject({ received: 1_000_000n, final: 0n });
  });

  it("a solid tx with no logs (plain TRX transfer) is not final", async () => {
    const s = sim({ pages: [{ rows: [row("a", "1000000")] }], solid: { a: { id: "a", receipt: { result: "SUCCESS" } } } });
    expect(await observe(s)).toMatchObject({ final: 0n });
  });

  it("unexpected['tron:trx'] sums incoming successful TRX transfers from anyone but the hot wallet (its top-up is excluded)", async () => {
    const none = await observe(sim());
    expect("unexpected" in none).toBe(false);
    const rows = [
      trxRow("c1", 2_500_000, OTHER), // a customer's TRX
      trxRow("h1", 500_000, HOT), // the sweeper's own top-up
      trxRow("c2", 1_000_000, OTHER, { to: OTHER }), // not to this address (the filter is not trusted)
      trxRow("c3", 99_999, OTHER), // dust
      trxRow("c4", 100_000, OTHER), // at the floor
      trxRow("c5", 3_000_000, OTHER, { ret: "REVERT" }),
      trxRow("c6", 7_000_000, OTHER, { type: "TransferAssetContract" }),
      { internal_tx_id: "i1", data: { call_value: { _: 5 } }, to_address: H(ADDR) },
    ];
    const s = sim({ trxPages: [{ rows: rows.slice(0, 4), next: "tfp1" }, { rows: rows.slice(4) }] });
    const out = await observe(s);
    expect(out.unexpected).toStrictEqual({ "tron:trx": 2_600_000n });
    expect(s.log.trxQueries[0]!.searchParams.get("only_to")).toBe("true");
    expect(s.log.trxQueries[0]!.searchParams.get("min_timestamp")).toBe(String(10 * HOUR - HOUR));
    const only = await observe(sim({ trxPages: [{ rows: [trxRow("h1", 500_000, HOT)] }] }));
    expect("unexpected" in only).toBe(false);
  });

  it("a malformed TRX row, or too many pages, omits unexpected (fail closed) without failing the observation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of [
      { txID: "x", raw_data: { contract: [{ type: "TransferContract", parameter: { value: { amount: "lots", owner_address: H(OTHER), to_address: H(ADDR) } } }] }, ret: [{ contractRet: "SUCCESS" }] },
      { txID: "x", ret: [{ contractRet: "SUCCESS" }] },
      "nope",
    ]) {
      const out = await observe(sim({ trxPages: [{ rows: [bad as Row] }] }));
      expect("unexpected" in out).toBe(false);
    }
    const s = sim({ trxPages: [{ rows: [trxRow("c1", 2_500_000, OTHER)], next: "tfp0" }] });
    const loop = await observe(s);
    expect("unexpected" in loop).toBe(false);
    expect(s.log.trxQueries).toHaveLength(3); // display-only data: at most 3 pages
    const three = sim({ trxPages: [{ rows: [trxRow("c1", 2_500_000, OTHER)], next: "tfp1" }, { rows: [], next: "tfp2" }, { rows: [trxRow("c2", 500_000, OTHER)] }] });
    expect((await observe(three)).unexpected).toStrictEqual({ "tron:trx": 3_000_000n });
    warn.mockRestore();
  });

  it("uses TRON_API_URL when set", async () => {
    const s = sim();
    serve(s, "https://tron.example/api");
    await tronAdapter(mkEnv({ TRON_API_URL: "https://tron.example/api/" }), new Map<string, bigint>()).observe(target(), ASSET);
    expect(s.log.trc20.length).toBe(1);
  });
});

describe("tron observe caching", () => {
  it("a solid txid is not re-queried; a not-yet-solid one is", async () => {
    const s = sim({ pages: [{ rows: [row("a", "1000000"), row("b", "2000000")] }], solid: { a: paid(1_000_000n) } });
    const cache = new Map<string, bigint>();
    await observe(s, { cache });
    expect(s.log.solid.sort()).toEqual(["a", "b"]);
    expect([...cache]).toEqual([[`${API}|a|${ADDR}`, 1_000_000n]]); // null is never cached
    s.log.solid.length = 0;
    const again = await observe(s, { cache });
    expect(s.log.solid).toEqual(["b"]);
    expect(again.final).toBe(1_000_000n);
  });

  it("caches a solid REVERT as false (permanent) and does not re-query it", async () => {
    const s = sim({ pages: [{ rows: [row("r", "1000000")] }], solid: { r: solid("REVERT", [log(1_000_000n)]) } });
    const cache = new Map<string, bigint>();
    await observe(s, { cache });
    expect(cache.get(`${API}|r|${ADDR}`)).toBe(0n);
    s.log.solid.length = 0;
    expect((await observe(s, { cache })).final).toBe(0n);
    expect(s.log.solid).toEqual([]);
  });

  it("a txid solidifying later becomes final on the next observe", async () => {
    const s = sim({ pages: [{ rows: [row("late", "4000000")] }] });
    const cache = new Map<string, bigint>();
    expect((await observe(s, { cache })).final).toBe(0n);
    s.solid.late = paid(4_000_000n);
    expect((await observe(s, { cache })).final).toBe(4_000_000n);
  });

  it("getAdapter's default cache is shared per isolate and bounded", async () => {
    const s = sim({ pages: [{ rows: [row("shared-1", "1000000")] }], solid: { "shared-1": paid(1_000_000n) } });
    serve(s);
    const env = mkEnv();
    await getAdapter(env, "tron").observe(target(), ASSET);
    await getAdapter(env, "tron").observe(target(), ASSET);
    expect(s.log.solid).toEqual(["shared-1"]);
  });

  it("evicts the oldest entry beyond 1000 on a caller-supplied cache", async () => {
    const cache = new Map<string, bigint>();
    for (let i = 0; i < 1000; i++) cache.set(`old${i}`, 1n);
    const s = sim({ pages: [{ rows: [row("new", "10000")] }], solid: { new: paid(10_000n) } });
    await observe(s, { cache });
    expect(cache.size).toBe(1000);
    expect(cache.has("old0")).toBe(false);
    expect(cache.get(`${API}|new|${ADDR}`)).toBe(10_000n);
  });
});

describe("tron observe fails closed", () => {
  const status = (url: string, method: "get" | "post", code = 500) => network.use(http[method](url, () => new HttpResponse("nope", { status: code })));

  it("non-2xx on the trc20 query throws", async () => {
    network.use(http.get(`${API}/v1/accounts/:addr`, () => HttpResponse.json({ data: [] })));
    // The TRX history (unexpected TRX) is asked in parallel: answered, so the offline guard stays silent.
    network.use(http.get(`${API}/v1/accounts/:addr/transactions`, () => HttpResponse.json({ success: true, data: [] })));
    status(`${API}/v1/accounts/:addr/transactions/trc20`, "get", 429);
    await expect(tronAdapter(mkEnv(), new Map<string, bigint>()).observe(target(), ASSET)).rejects.toThrow();
  });

  it("non-2xx on the solidity node throws", async () => {
    const s = sim({ pages: [{ rows: [row("a", "1000000")] }] });
    serve(s);
    status(`${API}/walletsolidity/gettransactioninfobyid`, "post");
    await expect(tronAdapter(mkEnv(), new Map<string, bigint>()).observe(target(), ASSET)).rejects.toThrow();
  });

  it("non-2xx on the balance query throws from trxBalance", async () => {
    status(`${API}/v1/accounts/:addr`, "get", 503);
    await expect(tronGrid(mkEnv()).trxBalance(ADDR)).rejects.toThrow();
  });

  it("malformed JSON throws", async () => {
    network.use(http.get(`${API}/v1/accounts/:addr/transactions/trc20`, () => new HttpResponse("<html>", { status: 200 })));
    await expect(tronGrid(mkEnv()).trc20Incoming(ADDR, USDT, 0)).rejects.toThrow();
  });

  it("a response without a data array throws", async () => {
    network.use(http.get(`${API}/v1/accounts/:addr/transactions/trc20`, () => HttpResponse.json({ success: false })));
    await expect(tronGrid(mkEnv()).trc20Incoming(ADDR, USDT, 0)).rejects.toThrow();
  });

  it.each(["-5", "1.5", "0x10", "", "1e6", " 7"])("rejects non-digit value %j", async (value) => {
    serve(sim({ pages: [{ rows: [row("a", value)] }] }));
    await expect(tronGrid(mkEnv()).trc20Incoming(ADDR, USDT, 0)).rejects.toThrow();
  });

  it("parses values beyond 2^53 exactly", async () => {
    serve(sim({ pages: [{ rows: [row("a", "123456789012345678901234567890")] }] }));
    expect((await tronGrid(mkEnv()).trc20Incoming(ADDR, USDT, 0))[0]!.value).toBe(123456789012345678901234567890n);
  });

  it("throws when more than 10 pages are needed, instead of truncating", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ rows: [row(`t${i}`, "1")], next: `fp${i + 1}` }));
    const s = sim({ pages });
    serve(s);
    await expect(tronGrid(mkEnv()).trc20Incoming(ADDR, USDT, 0)).rejects.toThrow(/page/i);
    expect(s.log.trc20.length).toBe(10);
  });

  it("exactly 10 pages is fine", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ rows: [row(`t${i}`, "1")], ...(i < 9 ? { next: `fp${i + 1}` } : {}) }));
    serve(sim({ pages }));
    expect(await tronGrid(mkEnv()).trc20Incoming(ADDR, USDT, 0)).toHaveLength(10);
  });

  it("a timeout aborts the request", async () => {
    network.use(http.get(`${API}/v1/accounts/:addr`, async () => new Promise<Response>(() => {})));
    const started = Date.now();
    await expect(tronGrid(mkEnv(), 50).trxBalance(ADDR)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("tronGrid.solidTxInfo / trxBalance", () => {
  it("{} is null; SUCCESS sums USDT logs to addr; REVERT is 0", async () => {
    serve(sim({ solid: { ok: paid(5_000_000n), bad: solid("REVERT", [log(5_000_000n)]) } }));
    const g = tronGrid(mkEnv());
    expect(await g.solidTxInfo("pending", ADDR)).toBeNull();
    expect(await g.solidTxInfo("ok", ADDR)).toEqual({ value: 5_000_000n });
    expect(await g.solidTxInfo("bad", ADDR)).toEqual({ value: 0n });
  });

  const malformed: Array<[string, unknown]> = [
    ["log not an array", "x"],
    ["log entry not an object", [1]],
    ["topics not an array", [{ ...log(1n), topics: "x" }]],
    ["topic not hex", [{ ...log(1n), topics: [TRANSFER, "zz", "zz"] }]],
    ["data not hex", [{ ...log(1n), data: "0xnothex" }]],
    ["Transfer with 2 topics", [{ ...log(1n), topics: [TRANSFER, pad(body(OTHER))] }]],
    ["USDT Transfer with no data field", [(({ data: _d, ...l }) => l)(log(1n))]],
    ["USDT Transfer with non-zero padding in the recipient topic", [{ ...log(1n), topics: [TRANSFER, pad(body(OTHER)), "ff" + pad(body(ADDR)).slice(2)] }]],
    ["Transfer data not 32 bytes", [{ ...log(1n), data: "01" }]],
  ];
  it.each(malformed)("throws on a malformed log: %s", async (_n, logs) => {
    serve(sim({ solid: { a: { id: "a", receipt: { result: "SUCCESS" }, log: logs } } }));
    await expect(tronGrid(mkEnv()).solidTxInfo("a", ADDR)).rejects.toThrow();
  });

  it("trxBalance: inactive account is 0, active returns sun", async () => {
    const g = tronGrid(mkEnv());
    serve(sim({ account: { data: [], success: true } }));
    expect(await g.trxBalance(ADDR)).toBe(0n);
    serve(sim({ account: { data: [{ address: "41ab", balance: 12_345_678 }], success: true } }));
    expect(await g.trxBalance(ADDR)).toBe(12_345_678n);
  });

  it("trxBalance rejects garbage", async () => {
    serve(sim({ account: { data: [{ balance: -1 }] } }));
    await expect(tronGrid(mkEnv()).trxBalance(ADDR)).rejects.toThrow();
    serve(sim({ account: { success: true } }));
    await expect(tronGrid(mkEnv()).trxBalance(ADDR)).rejects.toThrow();
  });
});

describe("tron adapter basics", () => {
  it("deriveAddress(i) is the deposit key address", async () => {
    const a = getAdapter(mkEnv(), "tron");
    expect(a.chain).toBe("tron");
    expect(await a.deriveAddress(0)).toBe(ADDR);
    expect(await a.deriveAddress(7)).toBe(tronDepositKey(SEED, 7).address);
  });

  it("paymentUri", () => {
    const a = getAdapter(mkEnv(), "tron");
    expect(a.paymentUri(target(), ASSET, 50_000_000n)).toBe(`tron:${ADDR}?token=${USDT}&amount=50`);
    expect(a.paymentUri(target(), ASSET, 1_234_500n)).toBe(`tron:${ADDR}?token=${USDT}&amount=1.2345`);
  });

  it("counterKey and startIndex", () => {
    expect(counterKey("tron")).toBe("tron");
    expect(startIndex(mkEnv(), "tron")).toBe(0);
  });
});

describe("tron config", () => {
  const full = { ALLOW_SEED_CUSTODY: "true", TRONGRID_API_KEY: "k", MASTER_SEED: SEED };
  it("is usable with custody, key and a valid seed", () => {
    expect(chainConfigError(full, "tron")).toBeNull();
    expect(chainConfigError({ ...full, TRON_API_URL: "https://tron.example" }, "tron")).toBeNull();
    expect(chainConfigError({ ...full, TRON_API_URL: "" }, "tron")).toBeNull();
  });
  it("names what is missing", () => {
    expect(chainConfigError({ ...full, ALLOW_SEED_CUSTODY: undefined }, "tron")).toMatch(/ALLOW_SEED_CUSTODY/);
    expect(chainConfigError({ ...full, ALLOW_SEED_CUSTODY: "yes" }, "tron")).toMatch(/ALLOW_SEED_CUSTODY/);
    expect(chainConfigError({ ...full, TRONGRID_API_KEY: undefined }, "tron")).toMatch(/TRONGRID_API_KEY/);
    expect(chainConfigError({ ...full, TRONGRID_API_KEY: "" }, "tron")).toMatch(/TRONGRID_API_KEY/);
    expect(chainConfigError({ ...full, MASTER_SEED: "not a mnemonic" }, "tron")).toMatch(/MASTER_SEED/);
    expect(chainConfigError({ ...full, MASTER_SEED: undefined }, "tron")).toMatch(/MASTER_SEED/);
    expect(chainConfigError({ ...full, TRON_API_URL: "http://tron.example" }, "tron")).toMatch(/TRON_API_URL/);
    expect(chainConfigError({ ...full, TRON_API_URL: "not a url" }, "tron")).toMatch(/TRON_API_URL/);
  });
  it("getAdapter refuses an unconfigured tron", () => {
    expect(() => getAdapter(mkEnv({ TRONGRID_API_KEY: "" }), "tron")).toThrow(/TRONGRID_API_KEY/);
  });
  it("tron:usdt is enabled with full config and left out (warned) without", () => {
    expect(enabledAssets({ ENABLED_ASSETS: "tron:usdt", ...full }).map((a) => a.id)).toEqual(["tron:usdt"]);
    expect(enabledAssets({ ENABLED_ASSETS: "tron:usdt", ...full, TRONGRID_API_KEY: "" })).toEqual([]);
  });
});

describe("tron:trx (detection only)", () => {
  it("registry entry", () => {
    expect(getAsset("tron:trx")).toMatchObject({ chain: "tron", symbol: "TRX", decimals: 6, priceSymbol: "TRX", confirmations: 0, detectionOnly: true });
    expect(getAsset("tron:trx").contract).toBeUndefined();
  });
  it("is never enabled, even when listed with full config", () => {
    const cfg = { ALLOW_SEED_CUSTODY: "true", TRONGRID_API_KEY: "k", MASTER_SEED: SEED };
    expect(enabledAssets({ ENABLED_ASSETS: "tron:trx", ...cfg })).toEqual([]);
    expect(enabledAssets({ ENABLED_ASSETS: "tron:usdt,tron:trx", ...cfg }).map((a) => a.id)).toEqual(["tron:usdt"]);
  });
  it("no TRX price is fetched when only tron:trx is listed", async () => {
    // The offline guard would fail the test on any Kraken/CoinGecko call; an empty wanted set fetches nothing.
    const env = mkEnv({ ENABLED_ASSETS: "tron:trx" });
    expect((await refreshPrices(env)).size).toBe(0);
  });
  it("other registry assets are not detection-only", () => {
    expect(getAsset("tron:usdt").detectionOnly).toBeUndefined();
    expect(getAsset("btc:btc").detectionOnly).toBeUndefined();
  });
});
