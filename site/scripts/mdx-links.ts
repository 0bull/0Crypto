// Rewrites relative .mdx links in the built docs pages to site routes (src/mdx-links.ts). Run after astro build.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CONTENT, routeOf } from "../src/mdx-links.ts";

const dist = process.argv[2] ?? "dist";
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name === "index.html" ? [join(dir, e.name)] : []));

let pages = 0;
let links = 0;
for (const html of walk(join(dist, "docs"))) {
  const route = relative(dist, join(html, "..")).replaceAll("\\", "/"); // e.g. docs/advanced/privacy-routing
  const source = [join(CONTENT, `${route}.mdx`), join(CONTENT, route, "index.mdx")].find((f) => existsSync(f));
  if (!source) continue;
  const before = readFileSync(html, "utf8");
  const after = before.replace(/href="(\.{1,2}\/[^"]*?\.mdx(?:#[^"]*)?)"/g, (all, href: string) => {
    const r = routeOf(source, href);
    if (r === null) return all;
    links++;
    return `href="${r}"`;
  });
  if (after !== before) {
    writeFileSync(html, after);
    pages++;
  }
}
console.log(`mdx-links: ${links} links in ${pages} pages`);
