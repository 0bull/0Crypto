import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";

// Worker startup parses every module reachable by a static import from src/index.ts. viem is large, so the
// EVM adapter loads it with dynamic import() inside its methods; a static import anywhere in the graph would
// put it on every cold start (and every /healthz). The same holds for Solana Kit (@solana/*) and @solana-program/*,
// which the Solana adapter and sweeper load only through dynamic import(), for nostr-tools (src/signing/nostr.ts), and
// for @simplewebauthn/* (src/admin/webauthn.ts).
const HEAVY = (spec: string) =>
  spec === "viem" ||
  spec.startsWith("viem/") ||
  spec.startsWith("@solana/") ||
  spec.startsWith("@solana-program/") ||
  spec === "tronweb" ||
  spec.startsWith("tronweb/") ||
  spec === "ed25519-hd-key" ||
  spec === "nostr-tools" ||
  spec.startsWith("nostr-tools/") ||
  spec.startsWith("@simplewebauthn/");
const STATIC = /(?:^|\n)\s*(?:import|export)\s+(?!type[\s{*])(?:[^;"']*?\sfrom\s+)?["']([^"']+)["']/g;

function resolveRel(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    try {
      readFileSync(c);
      return c;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

it("no module reachable from src/index.ts statically imports viem, @solana/* or @solana-program/*", () => {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(STATIC)) {
      const spec = m[1]!;
      if (HEAVY(spec)) offenders.push(`${file} -> ${spec}`);
      else if (spec.startsWith(".") && !spec.endsWith(".json") && !spec.endsWith(".css")) {
        const next = resolveRel(file, spec);
        if (!next) throw new Error(`unresolved relative import ${spec} in ${file}`);
        visit(next);
      }
    }
  };
  visit(resolve(__dirname, "../../src/index.ts"));
  expect(seen.size).toBeGreaterThan(20); // the walk really covered the app
  expect([...seen].some((f) => f.endsWith("chains/evm/adapter.ts"))).toBe(true); // ...including the EVM adapter
  expect([...seen].some((f) => f.endsWith("sweep/solana.ts"))).toBe(true); // ...and the Solana sweeper
  expect(offenders).toEqual([]);
});

// The Railgun engine is a Node-only oracle (tools/railgun-golden): src/routing/railgun/ ports what it needs. No file
// under src/ may import it, statically or dynamically.
it("nothing under src/ imports @railgun-community/*", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && /["']@railgun-community\//.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  walk(resolve(__dirname, "../../src"));
  expect(offenders).toEqual([]);
});
