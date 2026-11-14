import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, it } from "vitest";

/*
 * Lightning is receive-only: the gateway asks the merchant's NWC wallet only for get_info, make_invoice and
 * lookup_invoice. No NIP-47 spending method may be spelled anywhere under src/ (code, strings or comments), so none
 * can be sent by accident or by a later edit without this test changing too.
 */
const SRC = resolve(__dirname, "../../src");
const SPEND = ["pay_invoice", "pay_keysend", "multi_pay", "multi_pay_invoice", "multi_pay_keysend"];

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.(tsx?|js|json|sql)$/.test(d.name) ? [p] : [];
  });

it("no NIP-47 pay method name appears in src/", () => {
  const all = files(SRC);
  expect(all.some((f) => f.endsWith("chains/lightning/nwc.ts"))).toBe(true); // the walk reaches the NWC client
  const hits = all.flatMap((f) => {
    const code = readFileSync(f, "utf8").toLowerCase();
    return SPEND.filter((m) => code.includes(m)).map((m) => `${relative(SRC, f)}: ${m}`);
  });
  expect(hits).toEqual([]);
});

it("the NWC client and its signing module only name the receive methods", () => {
  for (const f of ["chains/lightning/nwc.ts", "chains/lightning/adapter.ts", "signing/nostr.ts"]) {
    const code = readFileSync(join(SRC, f), "utf8");
    const methods = [...code.matchAll(/"((?:get|make|lookup|list|pay|multi|sign)_[a-z_]+)"/g)].map((m) => m[1]);
    expect(methods.filter((m) => !["get_info", "make_invoice", "lookup_invoice"].includes(m!)), f).toEqual([]);
  }
  // The runtime allowlist at the signing boundary is exactly the three receive methods.
  const nostr = readFileSync(join(SRC, "signing/nostr.ts"), "utf8");
  expect(nostr).toMatch(/RECEIVE_METHODS[^=]*= new Set<NwcMethod>\(\["get_info", "make_invoice", "lookup_invoice"\]\)/);
});
