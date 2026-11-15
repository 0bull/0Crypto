import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Docs pages link to each other with relative file paths (`./wallet.mdx`, `../security.mdx#backups`), so the same
 * links work when the pages are read on GitHub. scripts/mdx-links.ts turns each one into the page's route on the
 * built site (`/docs/wallet/`, `/docs/security/#backups`). Only relative links ending in .mdx are touched.
 */
export const CONTENT = resolve(dirname(fileURLToPath(import.meta.url)), "content/docs");
const MDX_LINK = /^(\.{1,2}\/[^#?"]*\.mdx)(#[^?"]*)?$/;

/** The site route for a relative .mdx link written in `fromFile` (an absolute path under CONTENT), or null. */
export function routeOf(fromFile: string, href: string): string | null {
  const m = MDX_LINK.exec(href);
  if (!m) return null;
  const path = relative(CONTENT, resolve(dirname(fromFile), m[1]!)).replaceAll("\\", "/").replace(/\.mdx$/, "").replace(/(^|\/)index$/, "");
  if (path.startsWith("..")) return null;
  return `/${path}${path ? "/" : ""}${m[2] ?? ""}`;
}
