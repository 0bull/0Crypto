import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// public/admin.css is the one stylesheet of the admin (strict CSP: no inline styles). These checks keep its
// accessibility rules and the theme's text colours honest.

const css = readFileSync("public/admin.css", "utf8");
const theme = readFileSync("public/theme.css", "utf8");
const BG = "#0B0B0E";

/** WCAG 2 relative luminance of a #RRGGBB colour. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
/** WCAG 2 contrast ratio of two colours (1 to 21). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
type RGB = [number, number, number];
const hex = (c: RGB): string => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const rgb = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
/** `rgba(r,g,b,a)` painted over an opaque colour. */
function over(rgba: string, under: RGB): RGB {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(rgba.trim());
  if (!m) throw new Error(`not an rgba() colour: ${rgba}`);
  const a = Number(m[4]);
  return [1, 2, 3].map((i, k) => Number(m[i]) * a + under[k]! * (1 - a)) as RGB;
}
/** The last declaration of `prop` in a rule whose selector list names `selector` (theme.css, then admin.css). */
function decl(selector: string, prop: string): string | undefined {
  let found: string | undefined;
  for (const sheet of [theme, css]) {
    for (const m of sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!m[1]!.split(",").some((s) => s.trim() === selector)) continue;
      const d = new RegExp(`(?:^|;)\\s*${prop}:([^;]+)`).exec(m[2]!);
      if (d) found = d[1]!.trim();
    }
  }
  return found;
}
function token(name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})\\b`).exec(theme);
  if (!m) throw new Error(`${name} is not a #RRGGBB token in theme.css`);
  return m[1]!;
}

describe("public/admin.css", () => {
  it("has the accessibility and phone rules", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("max-width: 767.98px");
    expect(css).toContain("overflow-wrap:anywhere");
    expect(css).toContain("content:attr(data-label)");
  });

  it("loads nothing from elsewhere", () => {
    expect(css).not.toMatch(/url\(\s*["']?http/i);
    expect(css).not.toContain("@import");
  });

  it("the contrast helper matches known WCAG values", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });

  it.each(["--text", "--muted", "--grey", "--paid", "--confirming", "--accent-2"])("%s on the background meets WCAG AA (4.5:1)", (name) => {
    expect(contrast(token(name), BG)).toBeGreaterThanOrEqual(4.5);
  });

  // A pill sits on a panel: its own tint over --panel-top over the page background. Its text must pass AA there.
  it.each(["paid", "confirmed", "confirming", "detected", "partial", "partially_paid", "open", "expired", "awaiting"])("pill-%s text on a panel meets WCAG AA", (status) => {
    const panelTop = /--panel-top:\s*(rgba\([^)]*\))/.exec(css)![1]!;
    const panel = over(panelTop, rgb(BG));
    const tint = decl(`.pill-${status}`, "background") ?? decl(".pill", "background")!;
    const color = decl(`.pill-${status}`, "color") ?? decl(".pill", "color")!;
    const text = token(/^var\((--[\w-]+)\)$/.exec(color)![1]!);
    expect(contrast(text, hex(over(tint, panel)))).toBeGreaterThanOrEqual(4.5);
  });

  it("table cells never split words; only .mono values break anywhere, and short columns can stay on one line", () => {
    expect(css).toMatch(/(^|\n)td\{[^}]*overflow-wrap:break-word/);
    expect(css).not.toMatch(/(^|\n)td\{[^}]*overflow-wrap:anywhere/);
    expect(css).toMatch(/\.mono\{[^}]*overflow-wrap:anywhere/);
    expect(css).toContain("td.nowrap{white-space:nowrap}");
  });

  it("white button text on the button gradient's midpoint meets WCAG AA", () => {
    expect(contrast("#FFFFFF", "#DD2C21")).toBeGreaterThanOrEqual(4.5);
  });
});
