import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { blockbook } from "../../../src/chains/utxo/blockbook";
import { esplora, ExplorerParseError, ExplorerUnavailable, withFallback } from "../../../src/chains/utxo/esplora";
import { ExplorerHttpError } from "../../../src/chains/utxo/explorer";

const ESP = "https://esplora.test/api";
const ESP2 = "https://esplora2.test/api";
const BB = "https://bb.test";
const ADDR = "bc1qaddr";
const TXA = "aa".repeat(32);
const TXB = "bb".repeat(32);

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

const espList = (body: unknown, base = ESP) => network.use(http.get(`${base}/address/${ADDR}/utxo`, () => HttpResponse.json(body as never)));
const bbList = (body: unknown) => network.use(http.get(`${BB}/api/v2/utxo/${ADDR}`, () => HttpResponse.json(body as never)));

describe("esplora utxos", () => {
  it("GET /address/:a/utxo: values as bigint, confirmed with height, unconfirmed without", async () => {
    espList([
      { txid: TXA, vout: 1, value: 2_100_000_000_000_000, status: { confirmed: true, block_height: 800_000, block_hash: "00", block_time: 1 } },
      { txid: TXB, vout: 0, value: 546, status: { confirmed: false } },
    ]);
    expect(await esplora(ESP).utxos(ADDR)).toEqual([
      { txid: TXA, vout: 1, value: 2_100_000_000_000_000n, confirmed: true, height: 800_000 },
      { txid: TXB, vout: 0, value: 546n, confirmed: false, height: null },
    ]);
  });
  it("fails closed on anything malformed", async () => {
    const good = { txid: TXA, vout: 0, value: 1, status: { confirmed: true, block_height: 1 } };
    for (const bad of [
      {},
      "x",
      [{ ...good, value: 1.5 }],
      [{ ...good, value: -1 }],
      [{ ...good, value: "1" }],
      [{ ...good, value: 2 ** 60 }],
      [{ ...good, vout: -1 }],
      [{ ...good, txid: "zz" }],
      [{ ...good, status: { confirmed: true } }],
      [{ ...good, status: {} }],
      [{ txid: TXA, vout: 0, value: 1 }],
      [null],
    ]) {
      espList(bad);
      await expect(esplora(ESP).utxos(ADDR), JSON.stringify(bad)).rejects.toBeInstanceOf(ExplorerParseError);
    }
  });
  it("an HTTP error is an error, never an empty list; the fallback is used on 5xx", async () => {
    network.use(http.get(`${ESP}/address/${ADDR}/utxo`, () => new HttpResponse(null, { status: 404 })));
    await expect(esplora(ESP).utxos(ADDR)).rejects.toBeInstanceOf(ExplorerHttpError);
    network.use(http.get(`${ESP}/address/${ADDR}/utxo`, () => new HttpResponse(null, { status: 503 })));
    espList([{ txid: TXA, vout: 0, value: 5, status: { confirmed: false } }], ESP2);
    expect(await withFallback(esplora(ESP), esplora(ESP2)).utxos(ADDR)).toEqual([{ txid: TXA, vout: 0, value: 5n, confirmed: false, height: null }]);
    network.use(http.get(`${ESP2}/address/${ADDR}/utxo`, () => new HttpResponse(null, { status: 503 })));
    await expect(withFallback(esplora(ESP), esplora(ESP2)).utxos(ADDR)).rejects.toBeInstanceOf(ExplorerUnavailable);
  });
});

describe("utxos: duplicates and txid case", () => {
  it("lowercases txids and rejects a duplicate (txid, vout), on both explorers", async () => {
    const up = TXA.toUpperCase();
    espList([{ txid: up, vout: 0, value: 1, status: { confirmed: false } }]);
    expect((await esplora(ESP).utxos(ADDR))[0]!.txid).toBe(TXA);
    espList([
      { txid: TXA, vout: 0, value: 1, status: { confirmed: false } },
      { txid: up, vout: 0, value: 1, status: { confirmed: false } },
    ]);
    await expect(esplora(ESP).utxos(ADDR)).rejects.toBeInstanceOf(ExplorerParseError);
    bbList([{ txid: up, vout: 1, value: "1", confirmations: 0 }]);
    expect((await blockbook(BB).utxos(ADDR))[0]!.txid).toBe(TXA);
    bbList([
      { txid: TXA, vout: 1, value: "1", confirmations: 0 },
      { txid: TXA, vout: 1, value: "2", confirmations: 0 },
    ]);
    await expect(blockbook(BB).utxos(ADDR)).rejects.toBeInstanceOf(ExplorerParseError);
  });
});

describe("blockbook utxos", () => {
  it("GET /api/v2/utxo/:a: string values as bigint, confirmations decide confirmed", async () => {
    bbList([
      { txid: TXA, vout: 2, value: "123456789012345678", height: 5_000_000, confirmations: 12 },
      { txid: TXB, vout: 0, value: "1", confirmations: 0 },
    ]);
    expect(await blockbook(BB).utxos(ADDR)).toEqual([
      { txid: TXA, vout: 2, value: 123_456_789_012_345_678n, confirmed: true, height: 5_000_000 },
      { txid: TXB, vout: 0, value: 1n, confirmed: false, height: null },
    ]);
  });
  it("fails closed on anything malformed", async () => {
    const good = { txid: TXA, vout: 0, value: "1", height: 1, confirmations: 1 };
    for (const bad of [
      {},
      [{ ...good, value: 1 }],
      [{ ...good, value: "1.5" }],
      [{ ...good, value: "-1" }],
      [{ ...good, value: "" }],
      [{ ...good, confirmations: -1 }],
      [{ ...good, confirmations: undefined }],
      [{ ...good, height: undefined }],
      [{ ...good, height: 0 }],
      [{ ...good, vout: "0" }],
      [{ ...good, txid: 7 }],
    ]) {
      bbList(bad);
      await expect(blockbook(BB).utxos(ADDR), JSON.stringify(bad)).rejects.toBeInstanceOf(ExplorerParseError);
    }
  });
});

describe("txStatus (fails closed)", () => {
  it("esplora /tx/:txid/status: 404 is unknown; confirmed flag read; 5xx and malformed throw", async () => {
    network.use(http.get(`${ESP}/tx/${TXA}/status`, () => HttpResponse.json({ confirmed: true, block_height: 1 })));
    expect(await esplora(ESP).txStatus(TXA)).toEqual({ known: true, confirmed: true });
    network.use(http.get(`${ESP}/tx/${TXA}/status`, () => HttpResponse.json({ confirmed: false })));
    expect(await esplora(ESP).txStatus(TXA)).toEqual({ known: true, confirmed: false });
    network.use(http.get(`${ESP}/tx/${TXA}/status`, () => new HttpResponse("Transaction not found", { status: 404 })));
    expect(await esplora(ESP).txStatus(TXA)).toEqual({ known: false, confirmed: false });
    network.use(http.get(`${ESP}/tx/${TXA}/status`, () => HttpResponse.json({})));
    await expect(esplora(ESP).txStatus(TXA)).rejects.toBeInstanceOf(ExplorerParseError);
    network.use(http.get(`${ESP}/tx/${TXA}/status`, () => new HttpResponse(null, { status: 500 })));
    await expect(esplora(ESP).txStatus(TXA)).rejects.toBeInstanceOf(ExplorerHttpError);
  });
  it("blockbook /api/v2/tx/:txid: 'not found' is unknown; confirmations read; other errors and another txid throw", async () => {
    network.use(http.get(`${BB}/api/v2/tx/${TXA}`, () => HttpResponse.json({ txid: TXA, confirmations: 3 })));
    expect(await blockbook(BB).txStatus(TXA)).toEqual({ known: true, confirmed: true });
    network.use(http.get(`${BB}/api/v2/tx/${TXA}`, () => HttpResponse.json({ txid: TXA, confirmations: 0 })));
    expect(await blockbook(BB).txStatus(TXA)).toEqual({ known: true, confirmed: false });
    network.use(http.get(`${BB}/api/v2/tx/${TXA}`, () => HttpResponse.json({ error: `Transaction '${TXA}' not found` }, { status: 400 })));
    expect(await blockbook(BB).txStatus(TXA)).toEqual({ known: false, confirmed: false });
    network.use(http.get(`${BB}/api/v2/tx/${TXA}`, () => HttpResponse.json({ error: "rate limited" }, { status: 400 })));
    await expect(blockbook(BB).txStatus(TXA)).rejects.toBeInstanceOf(ExplorerHttpError);
    network.use(http.get(`${BB}/api/v2/tx/${TXA}`, () => HttpResponse.json({ txid: TXB, confirmations: 3 })));
    await expect(blockbook(BB).txStatus(TXA)).rejects.toBeInstanceOf(ExplorerParseError);
    network.use(http.get(`${BB}/api/v2/tx/${TXA}`, () => new HttpResponse(null, { status: 503 })));
    await expect(blockbook(BB).txStatus(TXA)).rejects.toBeInstanceOf(ExplorerHttpError);
  });
});
