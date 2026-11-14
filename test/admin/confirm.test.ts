import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signedIn, type AdminTestSession } from "../admin-session";
import { actionParams, BAD_ASSERTION, CONFIRM_ACTIONS, NEEDS_JS } from "../../src/admin/confirm";
import { solDepositKey, solHotKey } from "../../src/signing/keys";
import { insertInvoice, insertPayment, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { getPosConfig, disablePin } from "../../src/pos/store";
import type { RefundRow } from "../../src/routing/refund";
import { offline } from "../offline";

// Review Focus 4: a passkey confirmation approved for one action, amount, path or session never passes for another,
// and passes at most once.

const e = env as unknown as Env;
const BASE = "https://pay.test";
const SOL = "https://sol.test/rpc";
const BH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const OTHER = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const CUSTOMER = solDepositKey(OTHER, 0).address;
const HOT = solHotKey(e.MASTER_SEED!).address;
let S: AdminTestSession;
let S2: AdminTestSession;
const sends: string[] = [];
const saved = { SOLANA_RPC_URL: e.SOLANA_RPC_URL };

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  S = await signedIn(e);
  S2 = await signedIn(e);
  Object.assign(e, { SOLANA_RPC_URL: SOL });
  await insertInvoice(e.DB, {
    id: "inv_cf", created_at: Date.now(), expires_at: Date.now() + 3_600_000, price_minor: 1n, currency: "USD", order_id: null, metadata: null, success_url: null, allowed_assets: null,
    status: "paid", late: false, overpaid: false, paid_minor: 1n,
  });
});
afterAll(() => {
  Object.assign(e, saved);
  network.disable();
});
afterEach(() => {
  network.resetHandlers();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  for (const t of ["refunds", "payments", "routing_actions", "router_lock", "route_batches", "own_addresses", "derivation_counters", "webauthn_challenges"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
  sends.length = 0;
  network.use(solRpc(), ...offline());
});

function solRpc() {
  return http.post(SOL, async ({ request }) => {
    const { method, params } = (await request.json()) as { method: string; params: unknown[] };
    const ok = (result: unknown) => HttpResponse.json({ jsonrpc: "2.0", id: 1, result });
    const ctx = { context: { slot: 1 } };
    switch (method) {
      case "getGenesisHash":
        return ok("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
      case "getAccountInfo":
        return ok({ ...ctx, value: null });
      case "getLatestBlockhash":
        return ok({ ...ctx, value: { blockhash: BH, lastValidBlockHeight: 1000 } });
      case "getBalance":
        return ok({ ...ctx, value: params[0] === HOT ? 5_000_000_000 : 0 });
      case "getTokenAccountsByOwner":
        return ok({ ...ctx, value: [] });
      case "sendTransaction":
        sends.push(params[0] as string);
        return ok("sig");
      default:
        return HttpResponse.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } });
    }
  });
}

let seq = 0;
async function payment(o: Partial<PaymentRow> = {}): Promise<PaymentRow> {
  const final = 2_000_000_000n; // 2 SOL
  const p: PaymentRow = {
    id: `pay_cf${seq++}`, invoice_id: "inv_cf", asset: "sol:sol", chain: "sol", address: `addr_cf_${seq}`, derivation_index: 200 + seq, reference: null, expected: final * 2n, price_e8: 1n,
    rate_locked_until: 0, received: final, final, txids: [], status: "confirmed", created_at: Date.now(), detected_at: Date.now(), confirmed_at: Date.now(), credited_minor: 1n, credit_price_e8: 1n,
    unexpected: null, ...o,
  };
  await insertPayment(e.DB, p);
  return p;
}

const post = (path: string, form: Record<string, string>, s = S) =>
  exports.default.fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: s.cookie },
    body: new URLSearchParams({ csrf: s.csrf, ...form }),
  });
const challenge = (body: Record<string, string>, s = S) =>
  exports.default.fetch(`${BASE}/admin/webauthn/challenge`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: s.cookie },
    body: new URLSearchParams({ csrf: s.csrf, ...body }),
  });
const refunds = async () => (await e.DB.prepare("SELECT * FROM refunds").all<RefundRow>()).results;
const fields = { address: CUSTOMER, amount: "1.00" };
const refundPath = (p: PaymentRow) => `/admin/payments/${p.id}/refund`;

/** 403 with BAD_ASSERTION, and nothing was refunded. */
async function rejected(r: Response) {
  expect(r.status).toBe(403);
  expect(await r.text()).toContain(BAD_ASSERTION);
  expect(await refunds()).toEqual([]);
  expect(sends).toEqual([]);
}

describe("passkey confirmation of a refund", () => {
  it("the refund form is a data-passkey-confirm form without a code field, and the shell loads /admin-passkey.js", async () => {
    const p = await payment();
    const html = await (await exports.default.fetch(BASE + refundPath(p), { headers: S.headers })).text();
    expect(html).toContain('data-passkey-confirm="refund"');
    expect(html).toContain('name="assertion"');
    expect(html).not.toContain('name="code"');
    expect(html).toContain("Confirm with your passkey.");
    expect(html).toMatch(new RegExp(`<noscript><p\\b[^>]*>${NEEDS_JS}</p></noscript>`));
    expect(html).toMatch(/<script src="\/admin-passkey.js" defer(="")?><\/script><\/body>/);
  });

  it("a valid assertion for exactly this refund: 303, sent once; the passkey's counter and last_used_at are stored", async () => {
    const p = await payment();
    const before = S.authenticator.counter;
    const assertion = await S.confirm("refund", refundPath(p), fields);
    const r = await post(refundPath(p), { ...fields, assertion });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`${refundPath(p)}?sent=sent`);
    expect(await refunds()).toHaveLength(1);
    expect(sends).toHaveLength(1);
    const row = await e.DB.prepare("SELECT counter,last_used_at FROM passkeys WHERE id=?").bind(S.authenticator.credentialId).first<{ counter: number; last_used_at: number }>();
    expect(row!.counter).toBe(before + 1);
    expect(row!.last_used_at).toBeGreaterThan(0);
  });

  it("the same assertion replayed: 403 BAD_ASSERTION (also with the hourly slot cleared)", async () => {
    const p = await payment();
    const assertion = await S.confirm("refund", refundPath(p), fields);
    expect((await post(refundPath(p), { ...fields, assertion })).status).toBe(303);
    await e.DB.prepare("DELETE FROM refunds").run();
    sends.length = 0;
    await rejected(await post(refundPath(p), { ...fields, assertion }));
  });

  it("two concurrent submissions of one assertion: at most one passes", async () => {
    const p = await payment();
    const assertion = await S.confirm("refund", refundPath(p), fields);
    const rs = await Promise.all([post(refundPath(p), { ...fields, assertion }), post(refundPath(p), { ...fields, assertion })]);
    expect(rs.filter((r) => r.status === 303)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 403)).toHaveLength(1);
  });

  it("an assertion for amount 1.00 posted with 100.00 (or another address, or an extra field): 403", async () => {
    const p = await payment();
    const assertion = await S.confirm("refund", refundPath(p), fields);
    await rejected(await post(refundPath(p), { ...fields, amount: "100.00", assertion }));
    await rejected(await post(refundPath(p), { ...fields, amount: "1.0", assertion }));
    await rejected(await post(refundPath(p), { ...fields, address: solDepositKey(OTHER, 1).address, assertion }));
    await rejected(await post(refundPath(p), { ...fields, extra: "x", assertion }));
    // A missing amount is refused by validation, before the confirmation (400, nothing refunded).
    const missing = await post(refundPath(p), { address: CUSTOMER, assertion });
    expect(missing.status).toBe(400);
    expect(await refunds()).toEqual([]);
    // A client-sent _path does not override the request's own path.
    const q = await payment();
    await rejected(await post(refundPath(q), { ...fields, _path: refundPath(p), assertion }));
  });

  it("a typo in the address or amount is refused (400) before the passkey confirmation is spent", async () => {
    const p = await payment();
    const live = async () => (await e.DB.prepare("SELECT count(*) AS n FROM webauthn_challenges WHERE kind='action'").first<{ n: number }>())!.n;
    for (const typo of [{ address: CUSTOMER.slice(0, -1) + "0", amount: "1.00" }, { address: CUSTOMER, amount: "1,00" }, { address: CUSTOMER, amount: "0" }]) {
      const assertion = await S.confirm("refund", refundPath(p), typo);
      const n = await live();
      const r = await post(refundPath(p), { ...typo, assertion });
      expect(r.status, JSON.stringify(typo)).toBe(400);
      expect(await live(), JSON.stringify(typo)).toBe(n); // the challenge is still there: nothing was spent
      expect(await refunds()).toEqual([]);
    }
  });

  it("the one-refund-per-hour gate answers 429 before the passkey confirmation is spent", async () => {
    const p = await payment();
    // A refund minted inside the hour (the refunds table is the gate; no KV).
    const q = await payment();
    await e.DB.prepare("INSERT INTO refunds(id,payment_id,to_address,amount,approved_at,created_at,consumed_at) VALUES('rf_minted',?,?,'1',?,?,?)").bind(q.id, CUSTOMER, Date.now(), Date.now(), Date.now() - 60_000).run();
    const assertion = await S.confirm("refund", refundPath(p), fields);
    const r = await post(refundPath(p), { ...fields, assertion });
    expect(r.status).toBe(429);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM webauthn_challenges WHERE kind='action'").first<{ n: number }>())!.n).toBe(1);
    expect((await refunds()).map((r) => r.id)).toEqual(["rf_minted"]);
  });

  it("an assertion made for /admin/refunds/<rid>/cancel used on /admin/payments/<id>/refund: 403", async () => {
    const p = await payment();
    const assertion = await S.confirm("refund", "/admin/refunds/rf_1/cancel", fields);
    await rejected(await post(refundPath(p), { ...fields, assertion }));
  });

  it("an assertion for another payment's refund path: 403", async () => {
    const p = await payment();
    const q = await payment();
    const assertion = await S.confirm("refund", refundPath(q), fields);
    await rejected(await post(refundPath(p), { ...fields, assertion }));
  });

  it("an assertion made for action pos.pin used for a refund: 403", async () => {
    const p = await payment();
    const assertion = await S.confirm("pos.pin", refundPath(p), fields);
    await rejected(await post(refundPath(p), { ...fields, assertion }));
  });

  it("an assertion issued to another session's cookie: 403 (both ways)", async () => {
    expect(S2.cookie).not.toBe(S.cookie);
    const p = await payment();
    await rejected(await post(refundPath(p), { ...fields, assertion: await S2.confirm("refund", refundPath(p), fields) }));
    await rejected(await post(refundPath(p), { ...fields, assertion: await S.confirm("refund", refundPath(p), fields) }, S2));
  });

  it("an assertion older than 300000 ms: 403", async () => {
    const p = await payment();
    const assertion = await S.confirm("refund", refundPath(p), fields);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
    await rejected(await post(refundPath(p), { ...fields, assertion }));
  });

  it("a tampered or foreign assertion: 403", async () => {
    const p = await payment();
    const assertion = JSON.parse(await S.confirm("refund", refundPath(p), fields)) as { id: string; rawId: string; response: { signature: string } };
    const sig = assertion.response.signature;
    const flipped = { ...assertion, response: { ...assertion.response, signature: sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA") } };
    await rejected(await post(refundPath(p), { ...fields, assertion: JSON.stringify(flipped) }));
    await rejected(await post(refundPath(p), { ...fields, assertion: JSON.stringify({ ...assertion, id: "AAAA", rawId: "AAAA" }) }));
    await rejected(await post(refundPath(p), { ...fields, assertion: "not json" }));
  });

  it("no assertion: 403 with NEEDS_JS and the form values kept", async () => {
    const p = await payment();
    for (const form of [fields, { ...fields, assertion: "" }]) {
      const r = await post(refundPath(p), form);
      expect(r.status).toBe(403);
      const html = await r.text();
      expect(html).toContain(NEEDS_JS);
      expect(html).toContain(`value="${CUSTOMER}"`);
    }
    expect(await refunds()).toEqual([]);
  });

  it("re-approve and cancel are bound to their own paths and actions", async () => {
    const p = await payment();
    await e.DB.prepare("INSERT INTO refunds(id,payment_id,to_address,amount,created_at,approved_at) VALUES('rf_cf',?,?,'1000000000',?,?)").bind(p.id, CUSTOMER, Date.now(), Date.now()).run();
    expect((await post("/admin/refunds/rf_cf/cancel", {})).status).toBe(403);
    // A refund-create assertion, or a re-approve one, does not cancel.
    expect((await post("/admin/refunds/rf_cf/cancel", { assertion: await S.confirm("refund", refundPath(p), {}) })).status).toBe(403);
    expect((await post("/admin/refunds/rf_cf/cancel", { assertion: await S.confirm("refund.reapprove", "/admin/refunds/rf_cf/cancel", {}) })).status).toBe(403);
    expect((await post("/admin/refunds/rf_cf/reapprove", { assertion: await S.confirm("refund", "/admin/refunds/rf_cf/reapprove", {}) })).status).toBe(403);
    expect((await e.DB.prepare("SELECT cancelled_at FROM refunds WHERE id='rf_cf'").first<{ cancelled_at: number | null }>())!.cancelled_at).toBeNull();
    const r = await post("/admin/refunds/rf_cf/cancel", { assertion: await S.confirm("refund", "/admin/refunds/rf_cf/cancel", {}) });
    expect(r.status).toBe(303);
    expect((await e.DB.prepare("SELECT cancelled_at FROM refunds WHERE id='rf_cf'").first<{ cancelled_at: number | null }>())!.cancelled_at).not.toBeNull();
  });
});

describe("POST /admin/webauthn/challenge", () => {
  const params = (n: number) => JSON.stringify(Object.fromEntries([...Array.from({ length: n - 1 }, (_, i) => [`k${i}`, "v"]), ["_path", "/admin/pos/pin"]]));
  it("issues request options for the admin's passkeys (user verification required, 300 s)", async () => {
    const r = await challenge({ action: "pos.pin", params: params(3) });
    expect(r.status).toBe(200);
    const { options } = (await r.json()) as { options: { challenge: string; rpId: string; userVerification: string; timeout: number; allowCredentials: { id: string }[] } };
    expect(options.rpId).toBe("pay.test");
    expect(options.userVerification).toBe("required");
    expect(options.timeout).toBe(300_000);
    expect(options.allowCredentials.map((c) => c.id)).toEqual(expect.arrayContaining([S.authenticator.credentialId, S2.authenticator.credentialId]));
    expect(await e.DB.prepare("SELECT kind FROM webauthn_challenges WHERE id=?").bind(options.challenge).first()).toEqual({ kind: "action" });
  });
  it("an unknown action, bad params or too many params: 400 { error }", async () => {
    expect(CONFIRM_ACTIONS.has("refund")).toBe(true);
    const bodies: Record<string, string>[] = [
      { action: "nope", params: params(1) },
      { action: "", params: params(1) },
      { params: params(1) },
      { action: "pos.pin", params: params(51) },
      { action: "pos.pin", params: JSON.stringify({ _path: "/admin/pos/pin", pin: "x".repeat(2049) }) },
      { action: "pos.pin", params: JSON.stringify({ _path: "/admin/pos/pin", pin: 12345678 }) },
      { action: "pos.pin", params: JSON.stringify(["/admin/pos/pin"]) },
      { action: "pos.pin", params: "null" },
      { action: "pos.pin", params: "{" },
      { action: "pos.pin", params: JSON.stringify({ pin: "1" }) }, // no _path
      { action: "pos.pin" },
    ];
    for (const body of bodies) {
      const r = await challenge(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBeTruthy();
    }
    expect((await challenge({ action: "pos.pin", params: params(50) })).status).toBe(200);
    expect((await challenge({ action: "pos.pin", params: JSON.stringify({ _path: "/admin/pos/pin", pin: "x".repeat(2048) }) })).status).toBe(200);
  });
  it("on an origin other than PUBLIC_URL: 403 “Open <PUBLIC_URL>/admin” and no challenge", async () => {
    const other = await signedIn(e, "https://other.test");
    const before = (await e.DB.prepare("SELECT count(*) AS n FROM webauthn_challenges WHERE kind='action'").first<{ n: number }>())!.n;
    await expect(other.confirm("pos.pin", "/admin/pos/pin", { pin: "12345678" })).rejects.toThrow(/403 .*Open https:\/\/pay\.test\/admin/);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM webauthn_challenges WHERE kind='action'").first<{ n: number }>())!.n).toBe(before);
  });
  it("needs a session and the CSRF token", async () => {
    const noSession = await exports.default.fetch(`${BASE}/admin/webauthn/challenge`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "pos.pin", params: params(1) }),
    });
    expect([302, 403]).toContain(noSession.status);
    const noCsrf = await exports.default.fetch(`${BASE}/admin/webauthn/challenge`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: S.cookie }, body: new URLSearchParams({ action: "pos.pin", params: params(1) }),
    });
    expect(noCsrf.status).toBe(403);
  });
  it("too many live action challenges: 429 with the exact copy", async () => {
    await e.DB.batch(Array.from({ length: 500 }, (_, i) => e.DB.prepare("INSERT INTO webauthn_challenges(id,kind,payload_hash,expires_at) VALUES(?,?,?,?)").bind(`a${i}`, "action", "", Date.now() + 300_000)));
    const r = await challenge({ action: "pos.pin", params: params(1) });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "Too many pending passkey requests. Try again in a few minutes." });
  });
});

describe("actionParams", () => {
  it("keeps string fields except csrf, assertion and credential", () => {
    expect(actionParams({ csrf: "c", assertion: "a", credential: "x", amount: "1", file: new File([], "f"), list: ["a", "b"] })).toEqual({ amount: "1" });
  });
});

describe("other confirmed actions need an assertion (403 without, 303 with)", () => {
  it("POS PIN set and disable", async () => {
    await disablePin(e.DB);
    const pin = { pin: "24681012", pin2: "24681012" };
    expect((await post("/admin/pos/pin", pin)).status).toBe(403);
    expect((await post("/admin/pos/pin", { ...pin, assertion: await S.confirm("pos.pin", "/admin/pos/pin", { ...pin, pin: "11111111" }) })).status).toBe(403);
    expect((await getPosConfig(e.DB)).pin_hash).toBeNull();
    expect((await post("/admin/pos/pin", { ...pin, assertion: await S.confirm("pos.pin", "/admin/pos/pin", pin) })).status).toBe(303);
    expect((await getPosConfig(e.DB)).pin_hash).not.toBeNull();
    expect((await post("/admin/pos/disable", {})).status).toBe(403);
    expect((await post("/admin/pos/disable", { assertion: await S.confirm("pos.pin", "/admin/pos/disable", {}) })).status).toBe(403);
    expect((await post("/admin/pos/disable", { assertion: await S.confirm("pos.disable", "/admin/pos/disable", {}) })).status).toBe(303);
    expect((await getPosConfig(e.DB)).pin_hash).toBeNull();
  });

  it("sweep retry", async () => {
    const p = await payment({ status: "confirmed" });
    await e.DB.prepare("UPDATE payments SET sweep_error='needs admin' WHERE id=?").bind(p.id).run();
    const path = `/admin/payments/${p.id}/retry-sweep`;
    const r = await post(path, {});
    expect(r.status).toBe(403);
    expect(await r.text()).toContain(NEEDS_JS);
    expect((await post(path, { assertion: await S.confirm("sweep.fail", path, {}) })).status).toBe(403);
    expect((await e.DB.prepare("SELECT sweep_error FROM payments WHERE id=?").bind(p.id).first<{ sweep_error: string | null }>())!.sweep_error).toBe("needs admin");
    expect((await post(path, { assertion: await S.confirm("sweep.retry", path, {}) })).status).toBe(303);
    expect((await e.DB.prepare("SELECT sweep_error FROM payments WHERE id=?").bind(p.id).first<{ sweep_error: string | null }>())!.sweep_error).toBeNull();
  });

  it("sweep fail", async () => {
    const H = (i: number) => `0x${String(i).padStart(64, "0")}`;
    await e.DB.prepare("DELETE FROM sweeps").run();
    await e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,txs,nonce,req) VALUES('swp_cf','arb',?,?,'pending','[]',?,1,?)")
      .bind(H(1), Date.now() - 5 * 3_600_000, JSON.stringify([H(1), H(2), H(3), H(4)]), JSON.stringify({ data: "0x", gas: "1", type: "legacy", gasPrice: "1", at: Date.now() - 2 * 3_600_000 }))
      .run();
    const path = "/admin/sweeps/swp_cf/fail";
    expect((await post(path, {})).status).toBe(403);
    expect((await post(path, { assertion: await S.confirm("sweep.retry", path, {}) })).status).toBe(403);
    expect((await post(path, { assertion: await S.confirm("sweep.fail", path, {}) })).status).toBe(303);
    expect(await e.DB.prepare("SELECT status FROM sweeps WHERE id='swp_cf'").first()).toEqual({ status: "failed" });
  });

  it("routing resolve", async () => {
    await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,status,created_at,updated_at,legs) VALUES('rb_cf','btc:btc','1','[\"1\"]','x','failed',0,0,'[]')").run();
    const path = "/admin/privacy/rb_cf/resolve";
    const r = await post(path, {});
    expect(r.status).toBe(403);
    expect(await r.text()).toContain(NEEDS_JS);
    expect((await post(path, { assertion: await S.confirm("routing", "/admin/privacy/rb_cf/resume", {}) })).status).toBe(403);
    expect((await post(path, { assertion: await S.confirm("routing", path, {}) })).status).toBe(303);
    expect((await e.DB.prepare("SELECT status FROM route_batches WHERE id='rb_cf'").first<{ status: string }>())!.status).toBe("resolved");
  });
});
