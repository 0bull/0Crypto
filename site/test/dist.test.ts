import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectInline, sha256Source } from "../scripts/csp.ts";

const DIST = join(import.meta.dirname, "..", "dist");

export function readDist(path: string): string {
  if (!existsSync(DIST)) throw new Error("run npm run build first");
  return readFileSync(join(DIST, path), "utf8");
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe("dist scaffold", () => {
  it("docs index is dark and branded", () => {
    const html = readDist("docs/index.html");
    expect(html).toMatch(/<html[^>]*data-theme="dark"/);
    expect(html).toContain("0Crypto");
  });
  it("never mentions the old name", () => {
    readDist("index.html");
    for (const f of walk(DIST)) {
      expect(f).not.toMatch(/paygate/i);
      if (/\.(html|css|js|json|xml|txt|svg)$/.test(f)) expect(readFileSync(f, "utf8"), f).not.toMatch(/paygate/i);
    }
  });
  it("has a 404 page", () => {
    expect(readDist("404.html")).toContain("<html");
  });
  it("turns relative .mdx links into site routes", () => {
    const html = readDist("docs/advanced/privacy-routing/index.html");
    expect(html).toContain('href="/docs/advanced/routed-mode/"');
    expect(html).toContain('href="/docs/security/"');
    expect(html).not.toMatch(/href="[^"]*\.mdx/);
  });
  it("has a landing page", () => {
    expect(readDist("index.html")).toContain("<html");
  });
});

describe("dist headers", () => {
  const htmlFiles = () => walk(DIST).filter((f) => f.endsWith(".html"));
  it("has a _headers file with one CSP", () => {
    expect(readDist("_headers")).toMatch(/^\/\*\n {2}Content-Security-Policy: .+$/m);
  });
  it("CSP covers every inline script and style hash", () => {
    const csp = readDist("_headers").match(/Content-Security-Policy: (.+)/)![1]!;
    const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
    const scriptSrc = directive("script-src");
    const styleSrc = directive("style-src");
    let seen = 0;
    for (const f of htmlFiles()) {
      const { scripts, styles } = collectInline(readFileSync(f, "utf8"));
      for (const s of scripts) expect(scriptSrc, f).toContain(sha256Source(s));
      for (const s of styles) expect(styleSrc, f).toContain(sha256Source(s));
      seen += scripts.length + styles.length;
    }
    expect(seen).toBeGreaterThan(0);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});

describe("landing page", () => {
  const html = () => readDist("index.html");
  // The markup between an element's opening tag (found by id) and the first closing tag of its kind.
  const block = (id: string, tag: string) => {
    const page = html();
    const start = page.search(new RegExp(`<${tag}\\b[^>]*\\bid="${id}"`));
    expect(start, `#${id}`).toBeGreaterThanOrEqual(0);
    const end = page.indexOf(`</${tag}>`, start);
    expect(end, `</${tag}> after #${id}`).toBeGreaterThan(start);
    return page.slice(start, end);
  };

  it("has the hero copy", () => {
    expect(html()).toContain("Your money.");
    expect(html()).toContain("Nobody's business.");
  });
  it("links the deploy button exactly once in the hero", () => {
    const hero = block("top", "header");
    const href = 'href="https://deploy.workers.cloudflare.com/?url=https://github.com/0bull/0Crypto"';
    expect(hero.split(href).length - 1).toBe(1);
  });
  it("links the docs", () => {
    expect(html()).toContain('href="/docs/"');
  });
  it("lists every coin in the coin row", () => {
    const row = block("coin-row", "ul");
    for (const coin of ["BTC", "Lightning", "LTC", "DOGE", "ETH", "USDC", "USDT", "DAI", "SOL", "TRON"])
      expect(row, coin).toContain(`>${coin}<`);
  });
  it("has every section anchor", () => {
    for (const id of ["trail", "features", "coins", "setup", "privacy", "faq"]) expect(html()).toContain(`id="${id}"`);
  });
  it("is honest about privacy", () => {
    const privacy = block("privacy", "section");
    expect(privacy).toContain("hot wallet");
    expect(privacy).toContain("reduces");
  });
  it("says the trail needs privacy routing", () => {
    const caption = html().match(/<figcaption\b[\s\S]*?<\/figcaption>/)?.[0] ?? "";
    expect(caption).toContain("With privacy routing on");
  });
  it("makes no third-party requests", () => {
    for (const f of walk(DIST).filter((f) => f.endsWith(".html"))) {
      const page = readFileSync(f, "utf8");
      expect(page, f).not.toContain('<script src="http');
      expect(page, f).not.toContain("https://fonts.");
    }
  });
});
