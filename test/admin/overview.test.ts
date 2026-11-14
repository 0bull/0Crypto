// The Overview (Plan 8 Task 2): the Received panel and its daily chart, the four figures, "N things need you" and the
// "Finish setting up" checklist. Assertions are on text, links and ARIA, not on class names.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordAlert } from "../../src/db/alerts";
import { insertPayment, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { clearSettingsCache, saveSettings } from "../../src/settings";
import { adminGet, adminSession, confirmFields, seedInvoice, signedIn } from "./helpers";

const e = env as unknown as Env;
const DAY = 86_400_000;
// BIP84 test vector (account 0 of the "abandon ... about" mnemonic): a usable Bitcoin wallet.
const ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await adminSession();
});
beforeEach(async () => {
  await e.DB.batch(["payments", "invoices", "alerts", "sweeps", "settings"].map((t) => e.DB.prepare(`DELETE FROM ${t}`)));
  // Back to the one passkey of the shared session (a claim leaves exactly one).
  await e.DB.prepare("DELETE FROM passkeys WHERE id<>?").bind((await adminSession()).authenticator.credentialId).run();
  clearSettingsCache();
  // No usable wallet unless a test adds one.
  await saveSettings(e, { ENABLED_ASSETS: "" });
});
afterAll(async () => {
  await e.DB.prepare("DELETE FROM settings").run();
  clearSettingsCache();
});

const overview = async (q = "") => {
  const r = await adminGet(`/admin${q}`);
  expect(r.status).toBe(200);
  return r.text();
};
/** The page's visible text, tags dropped and whitespace collapsed. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** The daily chart: the svg named "Received per day…". */
const chart = (html: string) => {
  const m = /<svg\b[^>]*aria-label="Received per day[^"]*"[^>]*>[\s\S]*?<\/svg>/.exec(html);
  expect(m, "daily chart").not.toBeNull();
  return m![0];
};
const rects = (svg: string) => svg.match(/<rect\b[^>]*>/g) ?? [];

let paySeq = 0;
const confirmedPayment = (invoice_id: string, asset: string, credited: bigint) => {
  const n = paySeq++;
  const p: PaymentRow = {
    id: `pay_ov${n}`, invoice_id, asset, chain: asset.split(":")[0] as PaymentRow["chain"], address: `addr_ov${n}`, derivation_index: n, reference: null, expected: 1n,
    price_e8: 10n ** 8n, rate_locked_until: 0, received: 1n, final: 1n, txids: [], status: "confirmed", created_at: Date.now(), detected_at: null,
    confirmed_at: Date.now(), credited_minor: credited, credit_price_e8: 10n ** 8n, unexpected: null,
  };
  return insertPayment(e.DB, p);
};

describe("the Received panel", () => {
  it("shows the primary currency big, the others below, and a change line naming the currency", async () => {
    const now = Date.now();
    const usd = await seedInvoice({ status: "paid", paid_minor: 12_345n, price_minor: 12_345n });
    await confirmedPayment(usd.id, "btc:btc", 12_345n);
    await seedInvoice({ status: "partially_paid", paid_minor: 1_000n });
    await seedInvoice({ status: "paid", currency: "EUR", paid_minor: 500n, price_minor: 500n });
    await seedInvoice({ status: "paid", paid_minor: 5_000n, created_at: now - 45 * DAY }); // the previous 30 days
    const t = text(await overview());
    expect(t).toContain("Received, last 30 days");
    expect(t).toContain("$133.45");
    expect(t).toContain("Also €5.00");
    expect(t).toContain("+166.9% vs previous 30 days (USD)");
    // Three invoices created in the period, two of them paid.
    expect(t).toMatch(/Paid rate 66%/);
    expect(t).toMatch(/Top coin BTC/);
    expect(t).toMatch(/Paid invoices 2/);
  });

  it("names no currency and shows no other-currency line with one currency; omits the change when the previous period is 0", async () => {
    await seedInvoice({ status: "paid", paid_minor: 2_500n });
    const t = text(await overview("?p=7d"));
    expect(t).toContain("Received, last 7 days");
    expect(t).toContain("$25.00");
    expect(t).not.toContain("Also ");
    expect(t).not.toContain("vs previous");
  });

  it("an empty 90-day period draws 90 bars, all 2 high, with no NaN, and the figures read as dashes", async () => {
    const html = await overview("?p=90d");
    expect(html.match(/<rect\b/g)).toHaveLength(90);
    const bars = rects(chart(html));
    expect(bars).toHaveLength(90);
    for (const b of bars) expect(b).toContain('height="2"');
    expect(html).not.toContain("NaN");
    const t = text(html);
    expect(t).toContain("$0.00");
    expect(t).toMatch(/Paid rate —/);
    expect(t).toMatch(/Top coin —/);
  });

  it("a single huge day among zeros: one full bar, every other bar 2 high, each titled with its day and amount", async () => {
    const day = Date.now() - 10 * DAY;
    await seedInvoice({ status: "paid", paid_minor: 10n ** 15n, price_minor: 10n ** 15n, created_at: day });
    const html = await overview("?p=90d");
    expect(html).not.toContain("NaN");
    const bars = rects(chart(html));
    expect(bars).toHaveLength(90);
    expect(bars.filter((b) => b.includes('height="2"'))).toHaveLength(89);
    expect(bars.filter((b) => b.includes('height="116"'))).toHaveLength(1);
    const md = new Date(day).toISOString().slice(5, 10);
    expect(chart(html)).toContain(`<title>${md}: $10,000,000,000,000.00</title>`);
    // The chart stretches to its container: a viewBox and no fixed pixel width.
    expect(chart(html)).toMatch(/viewBox="0 0 900 \d+"/);
    expect(chart(html)).not.toMatch(/<svg[^>]*\swidth=/);
  });
});

describe("the figures", () => {
  it("Waiting counts open and partially paid invoices that have not expired, with the partial count as its hint", async () => {
    await seedInvoice({ status: "open" });
    await seedInvoice({ status: "partially_paid", paid_minor: 100n });
    await seedInvoice({ status: "open", expires_at: Date.now() - 1000 });
    const t = text(await overview());
    expect(t).toMatch(/Waiting 2 1 partially paid/);
  });
});

describe("things that need you", () => {
  it("one unresolved alert: '1 thing needs you' with its Resolve form", async () => {
    await recordAlert(e.DB, "sweep.failing", "sol", "sweep failed twice");
    const html = await overview();
    const id = (await e.DB.prepare("SELECT id FROM alerts").first<{ id: string }>())!.id;
    expect(text(html)).toContain("1 thing needs you");
    expect(html).toMatch(new RegExp(`<form[^>]*method="post"[^>]*action="/admin/alerts/${id}/resolve"`));
    expect(text(html)).toContain("Sweeps keep failing");
    expect(text(html)).toContain("sweep failed twice");
  });

  it("a webhook.dead alert is titled 'Webhooks not delivered', not its raw kind", async () => {
    await recordAlert(e.DB, "webhook.dead", null, "2 webhook event(s) failed every delivery attempt");
    const t = text(await overview());
    expect(t).toContain("Webhooks not delivered");
    expect(t).not.toContain("webhook.dead");
  });

  it("an alert and a stuck sweep make '2 things need you'; nothing to do hides the panel", async () => {
    expect(text(await overview())).not.toMatch(/needs? you/);
    await recordAlert(e.DB, "sweep.failing", "sol", "sweep failed twice");
    const req = JSON.stringify({ data: "0x", gas: "1", type: "legacy", gasPrice: "1", at: Date.now() - 2 * 3_600_000 });
    await e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,txs,nonce,req) VALUES('swp_ov','arb','0x01',?,'pending','[]','[\"0x01\"]',1,?)")
      .bind(Date.now() - 5 * 3_600_000, req)
      .run();
    const html = await overview();
    expect(text(html)).toContain("2 things need you");
    expect(html).toContain('action="/admin/sweeps/swp_ov/fail"');
    expect(html).toContain('data-passkey-confirm="sweep.fail"');
    // The sweep id is in the path (bound as _path); the form binds no other field.
    expect(confirmFields(html, "/admin/sweeps/swp_ov/fail")).toEqual([]);
  });
});

describe("recent invoices", () => {
  it("lists the latest 5 and links View all to /admin/invoices", async () => {
    for (let i = 0; i < 7; i++) await seedInvoice({ order_id: `ORD-R${i}`, created_at: Date.now() - (7 - i) * 1000 });
    const html = await overview();
    const t = text(html);
    for (let i = 2; i < 7; i++) expect(t).toContain(`ORD-R${i}`);
    expect(t).not.toContain("ORD-R0");
    expect(t).not.toContain("ORD-R1");
    expect(html).toMatch(/<a[^>]*href="\/admin\/invoices"[^>]*>View all/);
    expect(html).toMatch(/<table[^>]*aria-label="Recent invoices"/);
  });
});

describe("Finish setting up", () => {
  it("1 of 5 on a fresh claim, 4 of 5 after a paid invoice, a webhook and a backup passkey, gone once all 5 are done", async () => {
    let html = await overview();
    expect(text(html)).toContain("Finish setting up");
    expect(text(html)).toContain("1 of 5 done");
    // The open items are links to where they get done.
    expect(html).toMatch(/<a[^>]*href="[^"]+"[^>]*>Add a webhook<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/admin\/passkeys"[^>]*>Add a backup passkey<\/a>/);

    await seedInvoice({ status: "paid", paid_minor: 100n });
    await saveSettings(e, { WEBHOOK_URL: "https://merchant.test/hook" });
    await signedIn(e); // a second passkey
    html = await overview();
    expect(text(html)).toContain("4 of 5 done");
    expect(text(html)).toContain("First invoice paid");
    expect(text(html)).toContain("Webhook added");
    expect(text(html)).toContain("Backup passkey added");

    await saveSettings(e, { ENABLED_ASSETS: "btc:btc", BTC_XPUB: ZPUB });
    html = await overview();
    expect(text(html)).not.toContain("Finish setting up");
    expect(text(html)).not.toContain("of 5 done");
  });
});
