import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CRONS, jobFor } from "../src/cron";
import type { Env } from "../src/env";
import worker from "../src/index";
import { createSubscription } from "../src/subs/store";
import { offline } from "./offline";

const e = env as unknown as Env;
const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  network.use(...offline());
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => network.disable());
beforeEach(async () => {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM subscription_periods"),
    e.DB.prepare("DELETE FROM subscriptions"),
    e.DB.prepare("DELETE FROM invoices WHERE metadata LIKE '%subscription_id%'"),
  ]);
});

describe("jobFor", () => {
  it("maps each cron expression to its job", () => {
    expect(jobFor("* * * * *")).toBe("minute");
    expect(jobFor("*/15 * * * *")).toBe("sweeps");
    expect(jobFor("5-59/15 * * * *")).toBe("routing");
    expect(jobFor("0 * * * *")).toBe("subscriptions");
    expect(jobFor("30 * * * *")).toBe("lightning");
    expect(Object.keys(CRONS)).toHaveLength(5);
  });
  it("returns null and warns for an unknown expression", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(jobFor("*/5 * * * *")).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain("0crypto: unknown cron");
  });
});

describe("scheduled dispatch", () => {
  const T = Date.UTC(2030, 0, 1, 0, 0);
  const run = async (cron: string) => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron, scheduledTime: T }), e, ctx);
    await waitOnExecutionContext(ctx);
  };
  const invoices = async () => (await e.DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE metadata LIKE '%subscription_id%'").first<{ n: number }>())!.n;
  const due = () => createSubscription(e.DB, { label: "Pro plan", price_minor: 1999n, currency: "USD", interval: "monthly", start_at: Date.now() - 1000, metadata: {} }, Date.now() - 1000);

  it("the hourly expression bills a due subscription", async () => {
    await due();
    await run("0 * * * *");
    expect(await invoices()).toBe(1);
  });
  it("the every-minute expression does not", async () => {
    await due();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await run("* * * * *");
    expect(await invoices()).toBe(0);
  });
  describe("price refresh", () => {
    let kraken = 0;
    beforeEach(async () => {
      kraken = 0;
      network.use(
        http.get("https://api.kraken.com/0/public/Ticker", () => {
          kraken++;
          return HttpResponse.json({ error: [], result: { XXBTZUSD: { c: ["100.0", "1"] } } });
        }),
      );
      await e.DB.prepare("DELETE FROM invoices WHERE id LIKE 'cronprice_%'").run();
    });
    const addInvoice = (status: string, expiresAt = Date.now() + 3_600_000) =>
      e.DB.prepare(
        "INSERT INTO invoices (id, price_minor, currency, status, created_at, expires_at) VALUES (?, '100', 'USD', ?, ?, ?)",
      ).bind(`cronprice_${status}`, status, Date.now(), expiresAt);
    it("makes no Kraken request when no invoice is open", async () => {
      await addInvoice("paid").run();
      await run("* * * * *");
      expect(kraken).toBe(0);
    });
    it("refreshes once when an invoice is open", async () => {
      await addInvoice("open").run();
      await run("* * * * *");
      expect(kraken).toBe(1);
    });
    it("makes no Kraken request for an abandoned partially_paid invoice past its expiry", async () => {
      await addInvoice("partially_paid", Date.now() - 60_000).run();
      await run("* * * * *");
      expect(kraken).toBe(0);
    });
    it("refreshes for a partially_paid invoice still before its expiry", async () => {
      await addInvoice("partially_paid").run();
      await run("* * * * *");
      expect(kraken).toBe(1);
    });
  });
  it("an unknown expression does nothing and does not throw", async () => {
    await due();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await run("*/5 * * * *");
    expect(await invoices()).toBe(0);
  });
});
