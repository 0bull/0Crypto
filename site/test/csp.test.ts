import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCsp, buildHeaders, collectInline, sha256Source } from "../scripts/csp.ts";

describe("sha256Source", () => {
  it("wraps the base64 sha256 in quotes", () => {
    const b64 = createHash("sha256").update("alert(1)").digest("base64");
    expect(sha256Source("alert(1)")).toBe(`'sha256-${b64}'`);
  });
});

describe("collectInline", () => {
  it("returns inline scripts and styles only", () => {
    expect(collectInline('<script>a()</script><script src="/x.js"></script><style>b{}</style>')).toEqual({
      scripts: ["a()"],
      styles: ["b{}"],
    });
  });
  it("skips json and other non-js script types, keeps modules", () => {
    const html =
      '<script type="application/ld+json">{"a":1}</script><script type="module">import "/x"</script><script type="text/javascript">c()</script><script type="speculationrules">{}</script>';
    expect(collectInline(html).scripts).toEqual(['import "/x"', "c()"]);
  });
  it("handles attributes and multi-line bodies", () => {
    const html = '<style media="all">\n a{}\n</style><script async>\nx()\n</script>';
    expect(collectInline(html)).toEqual({ scripts: ["\nx()\n"], styles: ["\n a{}\n"] });
  });
});

describe("buildCsp", () => {
  const csp = buildCsp({ scripts: ["'sha256-b'", "'sha256-a'"], styles: ["'sha256-s'"] });
  it("has the fixed directives", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
  });
  it("script-src has no unsafe-inline or unsafe-eval", () => {
    const script = csp.split("; ").find((d) => d.startsWith("script-src "))!;
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).toBe("script-src 'self' 'wasm-unsafe-eval' 'sha256-a' 'sha256-b'");
  });
  it("is deterministic and de-duplicated", () => {
    expect(buildCsp({ scripts: ["'sha256-a'", "'sha256-b'", "'sha256-a'"], styles: ["'sha256-s'"] })).toBe(csp);
  });
});

describe("buildHeaders", () => {
  const out = buildHeaders("default-src 'self'");
  it("has the catch-all block first", () => {
    expect(out.startsWith("/*\n  Content-Security-Policy: default-src 'self'\n")).toBe(true);
    for (const h of [
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: strict-origin-when-cross-origin",
      "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
      "Strict-Transport-Security: max-age=31536000",
    ])
      expect(out).toContain(`  ${h}\n`);
  });
  it("caches /_astro/*", () => {
    expect(out).toContain("/_astro/*\n  Cache-Control: public, max-age=31536000, immutable");
  });
});
