import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NAV_GROUPS } from "../../src/admin/layout";
import type { Env } from "../../src/env";
import { saveSettings } from "../../src/settings";
import { adminGet, adminSession, seedInvoice } from "./helpers";

/*
 * Guards every signed-in admin page against the Plan 8 shell contract: the strict CSP (no style attributes, no inline
 * scripts), one <h1>, one main nav with the current page marked, and the four sidebar groups plus Sign out.
 */

const e = env as unknown as Env;
let invoiceId = "";

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await adminSession();
  invoiceId = (await seedInvoice({ order_id: "ORD-GUARD" })).id;
});
afterAll(async () => {
  await saveSettings(e, { MERCHANT_NAME: "" });
});

const ACTIVE_HREF: Record<string, string> = {
  overview: "/admin",
  invoices: "/admin/invoices",
  links: "/admin/links",
  pos: "/admin/pos",
  subs: "/admin/subscriptions",
  wallets: "/admin/wallets",
  privacy: "/admin/privacy",
  developers: "/admin/developers",
  passkeys: "/admin/passkeys",
  settings: "/admin/settings",
  more: "/admin/more",
};

const PAGES = (): [string, string][] => [
  ["/admin", "overview"],
  ["/admin/invoices", "invoices"],
  ["/admin/invoices/new", "invoices"],
  [`/admin/invoices/${invoiceId}`, "invoices"],
  ["/admin/links", "links"],
  ["/admin/pos", "pos"],
  ["/admin/subscriptions", "subs"],
  ["/admin/wallets", "wallets"],
  ["/admin/privacy", "privacy"],
  ["/admin/developers", "developers"],
  ["/admin/passkeys", "passkeys"],
  ["/admin/settings", "settings"],
  ["/admin/more", "more"],
];

/** The one `<nav aria-label="Main">` element's markup. */
function mainNav(html: string): string {
  const navs = html.match(/<nav\b[^>]*aria-label="Main"[^>]*>[\s\S]*?<\/nav>/g) ?? [];
  expect(navs).toHaveLength(1);
  return navs[0]!;
}
/** The tags in `markup` that carry aria-current="page". */
const currentTags = (markup: string) => markup.match(/<[a-z]+\b[^>]*\saria-current="page"[^>]*>/g) ?? [];

describe("every admin page follows the shell contract", () => {
  it.each(PAGES().map((_, i) => i))("page %i", async (i) => {
    const [path, active] = PAGES()[i]!;
    const r = await adminGet(path);
    expect(r.status, path).toBe(200);
    expect(r.headers.get("content-security-policy"), path).toContain("default-src 'self'");
    const html = await r.text();
    expect(html, path).not.toMatch(/\sstyle\s*=/i);
    expect(html, path).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html.match(/<h1[\s>]/g)?.length, path).toBe(1);

    const nav = mainNav(html);
    const current = currentTags(nav);
    expect(current, path).toHaveLength(1);
    expect(current[0], path).toContain(`href="${ACTIVE_HREF[active]}"`);
    // Nothing outside the nav claims to be the current page either.
    expect(currentTags(html), path).toHaveLength(1);

    for (const t of ["Get paid", "Your money", "Developers", "Account", "Sign out"]) expect(html, `${path}: ${t}`).toContain(t);
  });

  it("the nav has no button but the Sign out submit (it works without JavaScript)", async () => {
    for (const [path] of PAGES()) {
      const nav = mainNav(await (await adminGet(path)).text());
      const buttons = nav.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
      expect(buttons, path).toHaveLength(1);
      expect(buttons[0], path).toMatch(/type="submit"[\s\S]*Sign out/);
      expect(nav, path).toMatch(/<form\b[^>]*method="post"[^>]*action="\/admin\/logout"/);
    }
  });

  it("every NAV_GROUPS href returns 200 when signed in", async () => {
    for (const href of NAV_GROUPS.flatMap((g) => g.items.map((it) => it.href))) expect((await adminGet(href)).status, href).toBe(200);
  });

  it("the More page links every nav item and has a Sign out form", async () => {
    const html = await (await adminGet("/admin/more")).text();
    const main = html.slice(html.indexOf("<main"));
    for (const href of Object.values(ACTIVE_HREF).filter((h) => h !== "/admin/more")) expect(main, href).toContain(`href="${href}"`);
    for (const t of ["Overview", "Invoices", "Payment links", "Point of sale", "Subscriptions", "Wallets", "Privacy routing", "API keys &amp; webhooks", "Passkeys", "Settings"])
      expect(main, t).toContain(t);
    expect(main).toMatch(/<form\b[^>]*action="\/admin\/logout"/);
  });
});

describe("renamed routes", () => {
  it("/admin/chains answers 301 to /admin/wallets", async () => {
    const r = await adminGet("/admin/chains");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/admin/wallets");
  });

  it("/admin/routing answers 301 to /admin/privacy and keeps the query", async () => {
    const r = await adminGet("/admin/routing?done=resolve");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/admin/privacy?done=resolve");
    const bare = await adminGet("/admin/routing");
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe("/admin/privacy");
  });

  it("the old paths still need a session", async () => {
    expect((await adminGet("/admin/wallets", {})).status).toBe(302);
    expect((await adminGet("/admin/privacy", {})).status).toBe(302);
    expect((await adminGet("/admin/more", {})).status).toBe(302);
  });
});

describe("the page header", () => {
  it("shows the shop name escaped", async () => {
    await saveSettings(e, { MERCHANT_NAME: "<b>Atlas & Co</b>" });
    const html = await (await adminGet("/admin")).text();
    expect(html).toContain("&lt;b&gt;Atlas &amp; Co&lt;/b&gt;");
    expect(html).not.toContain("<b>Atlas");
  });
});
