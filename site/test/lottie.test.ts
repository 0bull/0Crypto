import { describe, expect, it } from "vitest";
import { CANVAS, cutBox, geometry, linkEnds, TIMELINE, type Box, type Layout } from "../scripts/trail/geometry.ts";
import { buildTrail, hex } from "../scripts/trail/lottie.ts";
import { buildGeometryCss, buildStaticSvg } from "../scripts/trail/svg.ts";

const LAYOUTS: Layout[] = ["landscape", "portrait"];

type Json = unknown;

function walk(node: Json, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    visit(obj);
    for (const v of Object.values(obj)) walk(v, visit);
  }
}

function colourArrays(anim: Json): number[][] {
  const out: number[][] = [];
  walk(anim, (o) => {
    if ((o.ty === "fl" || o.ty === "st") && o.c && typeof o.c === "object") {
      const c = o.c as { a: number; k: unknown };
      if (c.a === 0) out.push(c.k as number[]);
      else for (const key of c.k as { s: number[] }[]) out.push(key.s);
    }
  });
  return out;
}

describe("geometry", () => {
  it("lays landscape out in one row and portrait in one column", () => {
    const land = geometry("landscape");
    const ys = new Set(Object.values(land.nodes).map((n) => n.y + n.h / 2));
    expect(ys.size).toBe(1);
    const port = geometry("portrait");
    const xs = new Set(Object.values(port.nodes).map((n) => n.x + n.w / 2));
    expect(xs.size).toBe(1);
  });

  it("links customer→fresh→hop→you and snaps inside the last link", () => {
    for (const l of LAYOUTS) {
      const g = geometry(l);
      expect(g.links).toEqual([
        ["customer", "fresh"],
        ["fresh", "hop"],
        ["hop", "you"],
      ]);
      expect(g.snapAt).toBeGreaterThan(0);
      expect(g.snapAt).toBeLessThan(1);
      for (const n of Object.values(g.nodes)) {
        expect(n.x).toBeGreaterThanOrEqual(0);
        expect(n.y).toBeGreaterThanOrEqual(0);
        expect(n.x + n.w).toBeLessThanOrEqual(CANVAS[l].w);
        expect(n.y + n.h).toBeLessThanOrEqual(CANVAS[l].h);
      }
    }
  });

  it("puts the cut label box over the snapped gap, off the line, clear of every box", () => {
    const overlaps = (p: Box, q: Box) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
    for (const l of LAYOUTS) {
      const g = geometry(l);
      const cut = cutBox(l);
      const [a, b] = linkEnds(l, g.nodes.hop, g.nodes.you);
      for (const n of Object.values(g.nodes)) expect(overlaps(cut, n)).toBe(false);
      expect(cut.x).toBeGreaterThanOrEqual(0);
      expect(cut.y).toBeGreaterThanOrEqual(0);
      expect(cut.x + cut.w).toBeLessThanOrEqual(CANVAS[l].w);
      expect(cut.y + cut.h).toBeLessThanOrEqual(CANVAS[l].h);
      if (l === "landscape") {
        expect(cut.x).toBeCloseTo(a[0] + (b[0] - a[0]) * g.snapAt);
        expect(cut.x + cut.w).toBeCloseTo(b[0]);
        expect(cut.y).toBeGreaterThan(a[1]); // below the line
      } else {
        expect(cut.y).toBeCloseTo(a[1] + (b[1] - a[1]) * g.snapAt);
        expect(cut.y + cut.h).toBeCloseTo(b[1]);
        expect(cut.x).toBeGreaterThan(a[0]); // beside the line
      }
    }
  });

  it("has the fixed timeline", () => {
    expect(TIMELINE.coinAtFresh).toBe(108);
    expect(TIMELINE.coinAtHop).toBe(173);
    expect(TIMELINE.snap).toEqual([198, 230]);
    expect(TIMELINE.end).toBe(360);
  });
});

describe.each(LAYOUTS)("buildTrail(%s)", (layout) => {
  const anim = buildTrail(layout);
  const json = JSON.stringify(anim);

  it("has the fixed timing and canvas", () => {
    expect(typeof anim.v).toBe("string");
    expect(anim.fr).toBe(60);
    expect(anim.ip).toBe(0);
    expect(anim.op).toBe(360);
    expect((anim.op - anim.ip) / anim.fr).toBe(6);
    expect(anim.w).toBe(CANVAS[layout].w);
    expect(anim.h).toBe(CANVAS[layout].h);
    expect(anim.ddd).toBe(0);
    expect(anim.assets).toEqual([]);
  });

  it("has only well-formed shape layers", () => {
    expect(anim.layers.length).toBeGreaterThan(0);
    for (const layer of anim.layers) {
      expect(layer.ty).toBe(4);
      expect(layer.ip).toBeLessThanOrEqual(layer.op);
      expect(typeof layer.ks).toBe("object");
      expect(layer.shapes.length).toBeGreaterThan(0);
    }
  });

  it("keeps every keyframe inside the composition", () => {
    let count = 0;
    walk(anim, (o) => {
      if (o.a === 1 && Array.isArray(o.k)) {
        for (const key of o.k as { t: number }[]) {
          count++;
          expect(key.t).toBeGreaterThanOrEqual(0);
          expect(key.t).toBeLessThanOrEqual(360);
        }
      }
    });
    expect(count).toBeGreaterThan(0);
  });

  it("uses 0..1 RGBA colours, including gold, purple and green", () => {
    const colours = colourArrays(anim);
    expect(colours.length).toBeGreaterThan(0);
    for (const c of colours) {
      expect(c).toHaveLength(4);
      for (const v of c) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    for (const c of ["#FFD86B", "#B48CFF", "#7FE0A8"]) expect(json).toContain(JSON.stringify(hex(c)));
  });

  it("has a trim path and a dashed stroke", () => {
    let trim = false;
    let dashed = false;
    walk(anim, (o) => {
      if (o.ty === "tm") trim = true;
      if (o.ty === "st" && Array.isArray(o.d) && o.d.length > 0) dashed = true;
    });
    expect(trim).toBe(true);
    expect(dashed).toBe(true);
  });

  it("has no text layers", () => {
    walk(anim, (o) => {
      expect(o.ty).not.toBe(5);
    });
  });

  it("is deterministic and small", () => {
    expect(JSON.stringify(buildTrail(layout))).toBe(json);
    expect(Buffer.byteLength(json)).toBeLessThan(60_000);
  });
});

describe("hex", () => {
  it("maps #RRGGBB to 0..1 RGBA", () => {
    expect(hex("#FFFFFF")).toEqual([1, 1, 1, 1]);
    expect(hex("#000000")).toEqual([0, 0, 0, 1]);
  });
});

describe("buildStaticSvg", () => {
  it("draws the landscape final frame without inline style or text", () => {
    const svg = buildStaticSvg("landscape");
    expect(svg).toContain('viewBox="0 0 1200 300"');
    expect(svg).toContain("#7FE0A8");
    expect(svg).toContain("stroke-dasharray");
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).not.toContain("style=");
    expect(svg).not.toContain("<text");
  });

  it("draws the portrait final frame on its own canvas", () => {
    const svg = buildStaticSvg("portrait");
    expect(svg).toContain('viewBox="0 0 360 760"');
    expect(svg).toContain("stroke-dasharray");
    expect(svg).not.toContain("style=");
    expect(svg).not.toContain("<text");
  });

  it("is deterministic", () => {
    expect(buildStaticSvg("landscape")).toBe(buildStaticSvg("landscape"));
  });
});

describe("buildGeometryCss", () => {
  const css = buildGeometryCss();
  it("positions every node label in both layouts", () => {
    expect(css).toContain(".trail--portrait .trail__label--you");
    for (const l of LAYOUTS)
      for (const n of ["customer", "fresh", "hop", "you"]) expect(css).toContain(`.trail--${l} .trail__label--${n}`);
  });
  it("positions the snapped-gap label in both layouts", () => {
    expect(css).toContain(".trail--landscape .trail__cut");
    expect(css).toContain(".trail--portrait .trail__cut");
  });
  it("sets the aspect ratio of each canvas", () => {
    expect(css).toMatch(/\.trail--landscape\s*\{\s*aspect-ratio:\s*1200\s*\/\s*300/);
    expect(css).toMatch(/\.trail--portrait\s*\{\s*aspect-ratio:\s*360\s*\/\s*760/);
  });
});
