import { setupNetwork } from "@msw/cloudflare";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { estimateEnergy, rentEnergy, TronSaveError } from "../../../src/chains/tron/tronsave";
import type { Env } from "../../../src/env";

const TS = "https://api.tronsave.io";
const env = { TRONSAVE_API_KEY: "k" } as Env;
const RECV = "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH";
const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

let buys = 0;
const estimate = (data: unknown, status = 200) => http.post(`${TS}/v2/estimate-buy-resource`, () => (typeof data === "string" ? new HttpResponse(data, { status }) : HttpResponse.json(data as object, { status })));
const good = estimate({ error: false, message: "Success", data: { unitPrice: 60, durationSec: 3600, estimateTrx: 60 * 66_300, availableResource: 1e7 } });
const buy = (reply: () => Response | Promise<Response>) =>
  http.post(`${TS}/v2/buy-resource`, async () => {
    buys++;
    return reply();
  });
const caught = async (p: Promise<unknown>): Promise<TronSaveError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TronSaveError);
    return e as TronSaveError;
  }
  throw new Error("expected a TronSaveError");
};

describe("rentEnergy: buy fails closed", () => {
  it("returns the order id on a clean answer, buying at the estimated unit price", async () => {
    let body: Record<string, unknown> = {};
    network.use(good, http.post(`${TS}/v2/buy-resource`, async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      expect(request.headers.get("apikey")).toBe("k");
      return HttpResponse.json({ error: false, message: "Success", data: { orderId: "ord_1" } });
    }));
    expect(await rentEnergy(env, RECV, 66_300, 90)).toBe("ord_1");
    expect(body).toMatchObject({ receiver: RECV, resourceType: "ENERGY", resourceAmount: 66_300, durationSec: 3600, unitPrice: 60 });
  });

  const ambiguous: Array<[string, () => Response | Promise<Response>]> = [
    ["an unknown envelope", () => HttpResponse.json({ ok: 1 })],
    ["error: null", () => HttpResponse.json({ error: null, data: { orderId: "x" } })],
    ["error: false without data", () => HttpResponse.json({ error: false })],
    ["a missing orderId", () => HttpResponse.json({ error: false, data: {} })],
    ["an empty orderId", () => HttpResponse.json({ error: false, data: { orderId: "" } })],
    ["a non-JSON body", () => new HttpResponse("<html>", { status: 200 })],
    ["HTTP 500", () => new HttpResponse("x", { status: 500 })],
    ["HTTP 502", () => new HttpResponse("x", { status: 502 })],
    ["HTTP 404", () => new HttpResponse("x", { status: 404 })],
    ["HTTP 409", () => new HttpResponse("x", { status: 409 })],
    ["a network error", () => HttpResponse.error()],
  ];
  for (const [name, reply] of ambiguous)
    it(`${name} is ambiguous (definite=false): an order may exist`, async () => {
      buys = 0;
      network.use(good, buy(reply));
      const e = await caught(rentEnergy(env, RECV, 66_300, 90));
      expect(e.definite).toBe(false);
      expect(buys).toBe(1);
    });

  it("a timeout is ambiguous", async () => {
    buys = 0;
    network.use(good, buy(async () => {
      await delay(500);
      return HttpResponse.json({ error: false, data: { orderId: "late" } });
    }));
    const e = await caught(rentEnergy(env, RECV, 66_300, 90, 50));
    expect(e.definite).toBe(false);
    expect(buys).toBe(1);
  });

  for (const status of [400, 401, 403, 429])
    it(`HTTP ${status} is a definite refusal`, async () => {
      network.use(good, buy(() => new HttpResponse("no", { status })));
      expect((await caught(rentEnergy(env, RECV, 66_300, 90))).definite).toBe(true);
    });

  it("error: true is a definite refusal", async () => {
    network.use(good, buy(() => HttpResponse.json({ error: true, message: "not enough balance" })));
    const e = await caught(rentEnergy(env, RECV, 66_300, 90));
    expect(e.definite).toBe(true);
    expect(e.tooExpensive).toBe(false);
  });

  it("over the per-unit cap: definite, tooExpensive, and nothing is bought", async () => {
    buys = 0;
    network.use(estimate({ error: false, data: { unitPrice: 91, durationSec: 3600, estimateTrx: 91 * 66_300 } }), buy(() => HttpResponse.json({})));
    const e = await caught(rentEnergy(env, RECV, 66_300, 90));
    expect(e).toMatchObject({ definite: true, tooExpensive: true });
    expect(buys).toBe(0);
  });

  it("a total over cap x amount is too expensive even at an in-cap unit price", async () => {
    buys = 0;
    network.use(estimate({ error: false, data: { unitPrice: 60, durationSec: 3600, estimateTrx: 90 * 66_300 + 1 } }), buy(() => HttpResponse.json({})));
    expect((await caught(rentEnergy(env, RECV, 66_300, 90))).tooExpensive).toBe(true);
    expect(buys).toBe(0);
  });
});

describe("estimateEnergy: parse errors are definite (no order) and never buy", () => {
  const bad: Array<[string, unknown, number?]> = [
    ["error: true", { error: true, message: "x" }],
    ["error missing", { data: { unitPrice: 60, estimateTrx: 60 * 1000 } }],
    ["no data", { error: false }],
    ["estimateTrx missing", { error: false, data: { unitPrice: 60 } }],
    ["estimateTrx negative", { error: false, data: { unitPrice: 60, estimateTrx: -1 } }],
    ["estimateTrx fractional", { error: false, data: { unitPrice: 60, estimateTrx: 60_000.5 } }],
    ["estimateTrx as a string", { error: false, data: { unitPrice: 60, estimateTrx: "60000" } }],
    ["unitPrice missing", { error: false, data: { estimateTrx: 60_000 } }],
    ["unitPrice zero", { error: false, data: { unitPrice: 0, estimateTrx: 60_000 } }],
    // estimateTrx in TRX instead of sun, say: far below unitPrice x amount.
    ["estimate below unitPrice x amount (unit mix-up)", { error: false, data: { unitPrice: 60, estimateTrx: 60 } }],
    ["not enough on offer", { error: false, data: { unitPrice: 60, estimateTrx: 60_000, availableResource: 999 } }],
    ["non-JSON", "<html>"],
    ["HTTP 500", "x", 500],
  ];
  for (const [name, data, status] of bad)
    it(name, async () => {
      buys = 0;
      network.use(estimate(data, status), buy(() => HttpResponse.json({ error: false, data: { orderId: "x" } })));
      const e = await caught(estimateEnergy(env, RECV, 1000));
      expect(e.definite).toBe(true);
      await caught(rentEnergy(env, RECV, 1000, 90));
      expect(buys).toBe(0);
    });

  it("accepts a sane estimate", async () => {
    network.use(estimate({ error: false, data: { unitPrice: 60, estimateTrx: 60_000 } }));
    expect(await estimateEnergy(env, RECV, 1000)).toEqual({ costSun: 60_000n, unitPrice: 60 });
  });
});
