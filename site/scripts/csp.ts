import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const JS_TYPES = new Set(["", "module", "text/javascript", "application/javascript"]);

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?(?=\\s|$)`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : undefined;
}

export function collectInline(html: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? "";
    if (attr(attrs, "src") !== undefined) continue;
    if (!JS_TYPES.has((attr(attrs, "type") ?? "").trim().toLowerCase())) continue;
    scripts.push(m[2] ?? "");
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) styles.push(m[1] ?? "");
  return { scripts, styles };
}

export function sha256Source(text: string): string {
  return `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
}

export function buildCsp(hashes: { scripts: string[]; styles: string[] }): string {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...uniq(hashes.scripts)].join(" "),
    ["style-src 'self'", ...uniq(hashes.styles)].join(" "),
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function buildHeaders(csp: string): string {
  return `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=31536000

/_astro/*
  Cache-Control: public, max-age=31536000, immutable
`;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

export function writeHeaders(distDir: string): string {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const f of walk(distDir).filter((f) => f.endsWith(".html"))) {
    const found = collectInline(readFileSync(f, "utf8"));
    scripts.push(...found.scripts.map(sha256Source));
    styles.push(...found.styles.map(sha256Source));
  }
  const csp = buildCsp({ scripts, styles });
  writeFileSync(join(distDir, "_headers"), buildHeaders(csp));
  return csp;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const dist = process.argv[2];
  if (!dist) {
    console.error("usage: node scripts/csp.ts <distDir>");
    process.exit(1);
  }
  writeHeaders(dist);
  console.log(`csp: wrote ${join(dist, "_headers")}`);
}
