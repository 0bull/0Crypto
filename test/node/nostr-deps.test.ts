import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";

/*
 * nostr-tools pins its own @noble/curves, @noble/hashes and @scure/base. package.json `overrides` point them at the
 * root copies: a second secp256k1 per isolate made the Workers test pool
 * crash, and one copy of the curve code is what the signing perimeter assumes. This fails if a nested copy comes back
 * (an override dropped, or a nostr-tools upgrade npm cannot satisfy with the root versions).
 */
const ROOT = resolve(__dirname, "../..");
/** Each shared package with one module nostr-tools imports from it. */
const SHARED: [string, string][] = [
  ["@noble/curves", "@noble/curves/secp256k1.js"],
  ["@noble/hashes", "@noble/hashes/utils.js"],
  ["@scure/base", "@scure/base"],
];

it("nostr-tools resolves the root @noble/curves, @noble/hashes and @scure/base (no nested copies)", () => {
  const fromNostr = createRequire(resolve(ROOT, "node_modules/nostr-tools/package.json"));
  const fromRoot = createRequire(resolve(ROOT, "package.json"));
  for (const [pkg, mod] of SHARED) {
    expect(existsSync(resolve(ROOT, "node_modules/nostr-tools/node_modules", pkg)), pkg).toBe(false);
    expect(fromNostr.resolve(mod), mod).toBe(fromRoot.resolve(mod));
  }
});

it("the overrides are declared and nostr-tools is pinned exactly", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    overrides: Record<string, Record<string, string>>;
  };
  expect(pkg.dependencies["nostr-tools"]).toMatch(/^\d+\.\d+\.\d+$/);
  for (const [p] of SHARED) expect(pkg.overrides["nostr-tools"]?.[p]).toBe("$" + p);
});
