import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, keccak256, parseTransaction, type Hex } from "viem";
import { getAsset } from "../../src/core/assets";
import { preAuth, signedIn, type AdminTestSession } from "../admin-session";
import { NEEDS_JS } from "../../src/admin/confirm";
import { clearHealthMemo } from "../../src/chains/evm/health";
import { hotAccount } from "../../src/signing/evmkeys";
import { evmDepositSalt } from "../../src/signing/addresses";
import { factoryAddress, predictForwarder } from "../../src/chains/evm/predict";
import { recordAlert } from "../../src/db/alerts";
import { getPayment, insertInvoice, insertPayment, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { emptyState, evmRpc, type RpcState } from "../evm-rpc";
import { offline } from "../offline";
import { FACTORY_ABI, sweepRpc, sweepState, type SweepRpcState } from "./rpc";

const e = env as unknown as Env;
const BASE = "https://pay.test";
/** The signed-in admin session (set in beforeAll) and its CSRF token. */
let S: AdminTestSession;
let P: Awaited<ReturnType<typeof preAuth>>;
let CSRF = "";
const saved = { ENABLED_ASSETS: e.ENABLED_ASSETS, EVM_RPC_BASE: e.EVM_RPC_BASE, EVM_RPC_ARB: e.EVM_RPC_ARB };
const hot = hotAccount(e).address;

const network = setupNetwork();
let rpc: { base: RpcState; arb: RpcState };
let sw: { base: SweepRpcState; arb: SweepRpcState };
let ipSeq = 0;

const headers = async () => ({
  "cf-connecting-ip": `10.9.0.${ipSeq++ & 255}`,
  ...S.headers,
});
const get = async (path: string) => exports.default.fetch(BASE + path, { headers: await headers(), redirect: "manual" });
const post = async (path: string, form: Record<string, string>, withSession = true) =>
  exports.default.fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(withSession ? await headers() : { "cf-connecting-ip": "10.9.1.1", ...P.headers }) },
    // Signed out, a form token must be the pre-auth one (bound to the 0c_setup cookie) to get past CSRF to the session gate.
    body: new URLSearchParams(withSession || form.csrf === undefined ? form : { ...form, csrf: P.csrf }),
    redirect: "manual",
  });
/** Marks a stuck sweep failed with a passkey confirmation ("sweep.fail") bound to its path. */
const failSweep = async (id: string) => {
  const path = `/admin/sweeps/${id}/fail`;
  return post(path, { csrf: CSRF, assertion: await S.confirm("sweep.fail", path, {}) });
};

beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  S = await signedIn(e);
  P = await preAuth(e);
  CSRF = S.csrf;
  Object.assign(e, { ENABLED_ASSETS: "base:usdc,base:eth,arb:usdc,arb:usdt", EVM_RPC_BASE: "https://rpc.test/base", EVM_RPC_ARB: "https://rpc.test/arb" });
  await insertInvoice(e.DB, {
    id: "inv_swadm", created_at: Date.now(), expires_at: Date.now() + 3_600_000, price_minor: 5000n, currency: "USD", order_id: null,
    metadata: null, success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n,
  });
});
beforeEach(async () => {
  rpc = { base: emptyState(), arb: emptyState() };
  sw = { base: sweepState(), arb: sweepState() };
  rpc.base.latest = rpc.arb.latest = { native: { [hot.toLowerCase()]: 10n ** 18n } };
  network.use(
    sweepRpc("https://rpc.test/base", () => sw.base), evmRpc("https://rpc.test/base", () => rpc.base),
    sweepRpc("https://rpc.test/arb", () => sw.arb), evmRpc("https://rpc.test/arb", () => rpc.arb), ...offline(),
  );
  for (const c of ["base", "arb"]) await e.KV.delete(`evm:health:${c}`);
  clearHealthMemo();
  for (const t of ["payments", "sweeps", "alerts"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => network.resetHandlers());
afterAll(() => {
  Object.assign(e, saved);
  network.disable();
});

/** The unexpected-deposit rows (each an `<li data-alert-row>`), each cut at its closing tag. */
const alertRows = (html: string) => html.split("<li data-alert-row").slice(1).map((r) => r.slice(0, r.indexOf("</li>")));

let seq = 0;
async function mk(o: Partial<PaymentRow> = {}): Promise<PaymentRow> {
  const n = seq++;
  const index = o.derivation_index ?? 100 + n;
  const p: PaymentRow = {
    // The real forwarder of the index: the sweep only flushes addresses its seed made.
    id: `pay_swadm${n}`, invoice_id: "inv_swadm", asset: "base:usdc", chain: "base", address: predictForwarder(factoryAddress(hot), evmDepositSalt(e.MASTER_SEED!, index)), derivation_index: index,
    reference: null, expected: 1_000_000n, price_e8: 10n ** 8n, rate_locked_until: 0, received: 1_000_000n, final: 1_000_000n, txids: [], status: "confirmed",
    created_at: Date.now(), detected_at: null, confirmed_at: Date.now(), credited_minor: 100n, credit_price_e8: 10n ** 8n, unexpected: null, ...o,
  };
  await insertPayment(e.DB, p);
  return p;
}

describe("alerts on the dashboard", () => {
  it("shows unresolved alerts at the top; Resolve (CSRF-protected) clears them", async () => {
    await recordAlert(e.DB, "sweep.insufficient_gas", "base", "hot wallet is dry");
    const html = await (await get("/admin")).text();
    expect(html).toContain("Hot wallet is out of gas");
    expect(html).toContain("hot wallet is dry");
    // In the Overview's first row ("1 thing needs you", beside the Received panel), above the recent invoices.
    expect(html).toContain("1 thing needs you");
    expect(html.indexOf("hot wallet is dry")).toBeGreaterThan(html.indexOf("Overview</h1>"));
    expect(html.indexOf("hot wallet is dry")).toBeLessThan(html.indexOf("Recent invoices"));
    const id = (await e.DB.prepare("SELECT id FROM alerts").first<{ id: string }>())!.id;
    expect(html).toContain(`action="/admin/alerts/${id}/resolve"`);

    expect((await post(`/admin/alerts/${id}/resolve`, {}, true)).status).toBe(403); // no csrf field
    expect((await e.DB.prepare("SELECT resolved_at FROM alerts").first<{ resolved_at: number | null }>())!.resolved_at).toBeNull();
    const r = await post(`/admin/alerts/${id}/resolve`, { csrf: CSRF });
    expect(r.status).toBe(303);
    expect((await e.DB.prepare("SELECT resolved_at FROM alerts").first<{ resolved_at: number | null }>())!.resolved_at).not.toBeNull();
    expect(await (await get("/admin")).text()).not.toContain("hot wallet is dry");
  });

  it("needs a session", async () => {
    const r = await post("/admin/alerts/alt_x/resolve", { csrf: CSRF }, false);
    expect(r.status).toBe(302);
  });
});

describe("unexpected deposits on the dashboard", () => {
  it("lists payments holding unexpected deposits: invoice link, amounts and chain", async () => {
    await mk({ unexpected: { "base:dai": 25n * 10n ** 17n, "base:eth": 10n ** 16n } });
    await mk({ chain: "arb", asset: "arb:usdc", status: "expired", unexpected: { "arb:usdt": 1_500_000n } });
    await mk(); // nothing unexpected: not listed
    const html = await (await get("/admin")).text();
    expect(html).toContain("Unexpected deposits");
    expect(html).toContain('href="/admin/invoices/inv_swadm"');
    expect(html).toContain("2.5 DAI");
    expect(html).toContain("0.01 ETH");
    expect(html).toContain("1.5 USDT");
    expect(html).toMatch(/Unexpected deposits[\s\S]*arb[\s\S]*base|Unexpected deposits[\s\S]*base[\s\S]*arb/);
  });

  it("labels a row left behind by an own-token fallback, a recovered row, a swept row and an unswept row", async () => {
    const left = await mk({ unexpected: { "base:dai": 10n ** 18n } });
    await e.DB.prepare("UPDATE payments SET swept_at=?, unexpected_left=1 WHERE id=?").bind(Date.now(), left.id).run();
    const rec = await mk({ unexpected: { "base:dai": 2n * 10n ** 18n } });
    const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "deployAndFlush", args: [[], ["usdc", "dai"].map((x) => getAsset(`base:${x}`).contract as Hex)] });
    await e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,req) VALUES('rec_x','base','0x01',?,'confirmed',?,?)").bind(Date.now(), JSON.stringify([rec.id]), JSON.stringify({ data })).run();
    await mk({ unexpected: { "base:dai": 3n * 10n ** 18n }, swept_at: Date.now() });
    await mk({ unexpected: { "base:dai": 4n * 10n ** 18n } });
    const html = await (await get("/admin")).text();
    const rows = alertRows(html);
    const label = (amount: string) => rows.find((r) => r.includes(`>${amount} DAI`))!;
    expect(label("1")).toContain("left at address — recover with a single token");
    expect(label("1")).not.toMatch(/swept /);
    expect(label("2")).toContain("recovered");
    expect(label("3")).toMatch(/swept /);
    expect(label("4")).toContain("not swept yet");
  });

  it("a Tron row with TRX left at the deposit says TRX recovery is not supported, never the EVM Recover deposit hint", async () => {
    const swept = await mk({ chain: "tron", asset: "tron:usdt", address: "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8", unexpected: { "tron:trx": 3_000_000n }, swept_at: Date.now() });
    await e.DB.prepare("UPDATE payments SET unexpected_left=1 WHERE id=?").bind(swept.id).run();
    const html = await (await get("/admin")).text();
    const row = alertRows(html).find((r) => r.includes("3 TRX"))!;
    expect(row).toContain("TRX remains at the deposit (TRX recovery not supported yet)");
    expect(row).not.toContain("recover with a single token");
    expect(row).not.toMatch(/swept /);
  });

  describe("recovered label needs a same-chain confirmed rec_ sweep that flushed every token", () => {
    const rec = async (chain: string, p: PaymentRow, tokens: string[]) => {
      const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "deployAndFlush", args: [[keccak256("0x01") as Hex], tokens as Hex[]] });
      await e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,req) VALUES(?,?,?,?,'confirmed',?,?)")
        .bind(`rec_${chain}${Math.random()}`, chain, "0x01", Date.now(), JSON.stringify([p.id]), JSON.stringify({ data, gas: "1", type: "legacy", gasPrice: "1", at: 0 }))
        .run();
    };
    const mkLeft = async () => {
      const p = await mk({ unexpected: { "base:dai": 10n ** 18n } });
      await e.DB.prepare("UPDATE payments SET swept_at=?, unexpected_left=1 WHERE id=?").bind(Date.now(), p.id).run();
      return p;
    };
    const all = ["usdc", "dai"].map((s) => getAsset(`base:${s}`).contract as string);

    it("a rec_ sweep on another chain does not count", async () => {
      const p = await mkLeft();
      await rec("arb", p, all);
      expect(await (await get("/admin")).text()).toContain("left at address — recover");
    });
    it("an own-mode rec_ that skipped the unexpected tokens does not count", async () => {
      const p = await mkLeft();
      await rec("base", p, [all[0]!]);
      const html = await (await get("/admin")).text();
      expect(html).toContain("left at address — recover");
      expect(html).not.toContain("recovered");
    });
    it("an all-mode same-chain rec_ counts, and overrides left-at-address", async () => {
      const p = await mkLeft();
      await rec("base", p, all);
      const html = await (await get("/admin")).text();
      expect(html).toContain(">recovered<");
      expect(html).not.toContain("left at address — recover");
    });
  });

  it("a pending or failed recovery does not count as recovered", async () => {
    const p = await mk({ unexpected: { "base:dai": 10n ** 18n } });
    await e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids) VALUES('rec_f','base','0x01',?,'failed',?)").bind(Date.now(), JSON.stringify([p.id])).run();
    const html = await (await get("/admin")).text();
    expect(html).toContain("not swept yet");
    expect(html).not.toContain("recovered");
  });

  it("is absent when there are none", async () => {
    await mk();
    expect(await (await get("/admin")).text()).not.toContain("Unexpected deposits");
  });
});

describe("recover deposit", () => {
  it("shows a form on the invoice page for EVM payments", async () => {
    const p = await mk();
    const html = await (await get("/admin/invoices/inv_swadm")).text();
    expect(html).toContain(`action="/admin/payments/${p.id}/recover"`);
    expect(html).toContain('<option value="arb"');
  });

  it("the recover form posts chain, tokens and token, each control labelled and the token's hint linked", async () => {
    const p = await mk();
    const html = await (await get("/admin/invoices/inv_swadm")).text();
    const form = new RegExp(`<form[^>]*action="/admin/payments/${p.id}/recover"[^>]*>[\\s\\S]*?</form>`).exec(html)![0];
    const names = [...form.matchAll(/<(?:input|select)\b[^>]*\sname="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(["chain", "csrf", "token", "tokens"]);
    for (const [label, name] of [["Chain", "chain"], ["Tokens", "tokens"], ["Token address (optional)", "token"]] as const) {
      const id = new RegExp(`<label for="([^"]+)">${label.replace(/[()]/g, "\\$&")}</label>`).exec(form)?.[1];
      expect(id, label).toBeDefined();
      expect(form).toMatch(new RegExp(`<(?:input|select)\\b[^>]*\\sname="${name}"[^>]*\\sid="${id}"|<(?:input|select)\\b[^>]*\\sid="${id}"[^>]*\\sname="${name}"`));
    }
    const token = /<input\b[^>]*\sname="token"[^>]*>/.exec(form)![0];
    const hint = /aria-describedby="([^"]+)"/.exec(token)![1];
    expect(form).toContain(`id="${hint}"`);
    expect(token).toContain('pattern="0x[0-9a-fA-F]{40}"');
  });

  it("a wrong-chain recovery sends to the chosen chain with that payment's salt, and does not mark the payment swept", async () => {
    const p = await mk({ derivation_index: 77 });
    const r = await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/invoices/inv_swadm?recovery=sent&chain=arb");
    expect(sw.base.sent).toHaveLength(0);
    expect(sw.arb.sent).toHaveLength(1);
    const tx = parseTransaction(sw.arb.sent[0]!);
    expect(tx.chainId).toBe(42161);
    const { args } = decodeFunctionData({ abi: FACTORY_ABI, data: tx.data! });
    expect(args![0]).toEqual([evmDepositSalt(e.MASTER_SEED!, 77)]);
    expect((args![1] as string[]).length).toBe(3); // every registry token of arb: usdc, usdt and dai (not enabled)
    const row = await e.DB.prepare("SELECT id,chain,status,payment_ids FROM sweeps").first<Record<string, string>>();
    expect(row).toMatchObject({ chain: "arb", status: "pending" });
    expect(JSON.parse(row!.payment_ids)).toEqual([p.id]);
    expect((await getPayment(e.DB, p.id))!.swept_at).toBeNull();
    const page = await (await get("/admin/invoices/inv_swadm?recovery=sent&chain=arb")).text();
    expect(page).toContain("Recovery transaction sent on arb");
  });

  it("takes an optional extra token address and rejects a malformed one (400) without sending", async () => {
    const p = await mk();
    const USDCE = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";
    expect(await (await get("/admin/invoices/inv_swadm")).text()).toContain('name="token"');
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", token: "0x1234" })).status).toBe(400);
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", token: "not an address" })).status).toBe(400);
    expect(sw.arb.sent).toHaveLength(0);
    const r = await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", token: ` ${USDCE} ` });
    expect(r.headers.get("location")).toContain("recovery=sent");
    const { args } = decodeFunctionData({ abi: FACTORY_ABI, data: parseTransaction(sw.arb.sent[0]!).data! });
    expect((args![1] as string[]).map((x) => x.toLowerCase())).toContain(USDCE.toLowerCase());
    expect((args![1] as string[]).length).toBe(4);
  });

  it("recovery token modes: own flushes only the equivalent own token, custom only the given one, all is the default", async () => {
    const p = await mk({ asset: "base:usdc" });
    const USDC_ARB_ADDR = getAsset("arb:usdc").contract!.toLowerCase();
    const CUSTOM = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";
    expect(await (await get("/admin/invoices/inv_swadm")).text()).toContain('name="tokens"');
    const tokensOf = (i: number) => (decodeFunctionData({ abi: FACTORY_ABI, data: parseTransaction(sw.arb.sent[i]!).data! }).args![1] as string[]).map((x) => x.toLowerCase());
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", tokens: "own" })).headers.get("location")).toContain("recovery=sent");
    expect(tokensOf(0)).toEqual([USDC_ARB_ADDR]);
    await e.DB.prepare("UPDATE sweeps SET status='failed'").run();
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", tokens: "custom", token: CUSTOM })).headers.get("location")).toContain("recovery=sent");
    expect(tokensOf(1)).toEqual([CUSTOM.toLowerCase()]);
    await e.DB.prepare("UPDATE sweeps SET status='failed'").run();
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", tokens: "all" })).headers.get("location")).toContain("recovery=sent");
    expect(tokensOf(2)).toHaveLength(3);
    expect((await getPayment(e.DB, p.id))!.swept_at).toBeNull();
  });

  it("own mode for a native payment flushes no token at all", async () => {
    const p = await mk({ asset: "base:eth" });
    await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", tokens: "own" });
    expect(decodeFunctionData({ abi: FACTORY_ABI, data: parseTransaction(sw.arb.sent[0]!).data! }).args![1]).toEqual([]);
  });

  it("custom mode without a (valid) token is a 400 and sends nothing; an unknown mode is a 400", async () => {
    const p = await mk();
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", tokens: "custom" })).status).toBe(400);
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", tokens: "custom", token: "0x12" })).status).toBe(400);
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", tokens: "bogus" })).status).toBe(400);
    const ZERO = "0x0000000000000000000000000000000000000000";
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", tokens: "custom", token: ZERO })).status).toBe(400);
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", tokens: "all", token: ZERO })).status).toBe(400);
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb", tokens: "own", token: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8" })).status).toBe(400);
    expect(sw.arb.sent).toHaveLength(0);
  });

  it("never pre-selects the payment's own chain", async () => {
    await mk();
    const html = await (await get("/admin/invoices/inv_swadm")).text();
    expect(html).not.toMatch(/<option value="base"[^>]*selected/);
    expect(html).toContain("required");
  });

  it("refuses non-EVM payments (400) and live payments on their own chain (409); allows partial/expired/confirmed there and any status on other chains", async () => {
    const btc = await mk({ chain: "btc", asset: "btc:btc" });
    expect((await post(`/admin/payments/${btc.id}/recover`, { csrf: CSRF, chain: "base" })).status).toBe(400);
    for (const status of ["awaiting", "detected", "confirming"] as const) {
      const p = await mk({ status });
      expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "base" })).status, status).toBe(409);
      expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb" })).status, status).toBe(303);
      await e.DB.prepare("UPDATE sweeps SET status='failed'").run();
    }
    expect(sw.base.sent).toHaveLength(0);
    for (const status of ["partial", "expired", "confirmed"] as const) {
      const p = await mk({ status });
      expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "base" })).status, status).toBe(303);
      await e.DB.prepare("UPDATE sweeps SET status='failed'").run();
    }
    expect(sw.base.sent).toHaveLength(3);
  });

  it("rejects a chain that is not configured, an unknown payment, and a missing CSRF token", async () => {
    const p = await mk();
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "polygon" })).status).toBe(400);
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "btc" })).status).toBe(400);
    expect((await post(`/admin/payments/nope/recover`, { csrf: CSRF, chain: "arb" })).status).toBe(404);
    expect((await post(`/admin/payments/${p.id}/recover`, { chain: "arb" })).status).toBe(403);
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb" }, false)).status).toBe(302);
    expect(sw.arb.sent).toHaveLength(0);
  });

  it("reports a skipped recovery when the hot wallet lacks gas", async () => {
    const p = await mk();
    rpc.arb.latest = { native: {} };
    const r = await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb" });
    expect(r.headers.get("location")).toBe("/admin/invoices/inv_swadm?recovery=skipped&chain=arb");
    expect(sw.arb.sent).toHaveLength(0);
  });
});

describe("mark sweep failed", () => {
  const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const REQ = (at: number) => JSON.stringify({ data: "0x", gas: "1", type: "legacy", gasPrice: "1", at });
  /** A pending arb sweep: created long ago, last broadcast at `at`, with `hashes` tx hashes (the first is the original). */
  const pend = (id: string, o: { created?: number; at: number; hashes?: number; ids?: string[] }) =>
    e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,txs,nonce,req) VALUES(?,?,?,?,'pending',?,?,1,?)")
      .bind(id, "arb", H(1), o.created ?? Date.now() - 5 * 3_600_000, JSON.stringify(o.ids ?? []), JSON.stringify(Array.from({ length: o.hashes ?? 1 }, (_, i) => H(i + 1))), REQ(o.at))
      .run();
  const H1 = 3_600_000;

  it("lists a sweep whose last broadcast was over an hour ago, with every tx hash, a warning and a CSRF-protected button", async () => {
    await pend("swp_old", { at: Date.now() - 2 * H1, hashes: 2 });
    const html = await (await get("/admin")).text();
    expect(html).toContain('action="/admin/sweeps/swp_old/fail"');
    expect(html).toContain(H(1));
    expect(html).toContain(H(2));
    expect(html).toContain("Only mark failed if none of these transactions is pending or mined on a block explorer.");
    expect((await post("/admin/sweeps/swp_old/fail", {})).status).toBe(403); // no CSRF
    const noConfirm = await post("/admin/sweeps/swp_old/fail", { csrf: CSRF });
    expect(noConfirm.status).toBe(403); // no passkey confirmation
    expect(await noConfirm.text()).toContain(NEEDS_JS);
    expect(html).toContain('data-passkey-confirm="sweep.fail"');
  });

  it("is gated on the last broadcast, not on creation: an old row with a recent replacement is not listed and not failable", async () => {
    await pend("swp_bumped", { at: Date.now() - 60_000, hashes: 2 });
    expect(await (await get("/admin")).text()).not.toContain("/admin/sweeps/swp_bumped/fail");
    expect((await failSweep("swp_bumped")).status).toBe(409);
  });

  it("a row at the replacement cap is failable even right after its last broadcast", async () => {
    await pend("swp_capped", { at: Date.now() - 60_000, hashes: 4 });
    expect(await (await get("/admin")).text()).toContain("/admin/sweeps/swp_capped/fail");
  });

  it("marks it failed and unblocks the chain, but leaves the payments' lock alone", async () => {
    const p = await mk({ status: "partial" });
    await pend("swp_stuck", { at: Date.now() - 60_000, hashes: 4, ids: [p.id] });
    await e.DB.prepare("UPDATE payments SET sweep_tx=? WHERE id=?").bind(H(1), p.id).run();
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb" })).headers.get("location")).toContain("recovery=skipped");
    const r = await failSweep("swp_stuck");
    expect(r.status).toBe(303);
    expect(await e.DB.prepare("SELECT status FROM sweeps WHERE id='swp_stuck'").first()).toMatchObject({ status: "failed" });
    expect((await getPayment(e.DB, p.id))!.sweep_tx).toBe(H(1)); // the tx may still mine
    expect((await post(`/admin/payments/${p.id}/recover`, { csrf: CSRF, chain: "arb" })).headers.get("location")).toContain("recovery=sent");
  });

  it("refuses a young, unknown or already settled sweep, and needs a session", async () => {
    await pend("swp_young2", { at: Date.now() - 60_000 });
    expect((await failSweep("swp_young2")).status).toBe(409);
    expect((await post("/admin/sweeps/nope/fail", { csrf: CSRF })).status).toBe(404);
    await e.DB.prepare("UPDATE sweeps SET status='confirmed'").run();
    expect((await failSweep("swp_young2")).status).toBe(409);
    expect((await post("/admin/sweeps/swp_young2/fail", { csrf: CSRF }, false)).status).toBe(302);
  });
});
