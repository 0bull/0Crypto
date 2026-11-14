// Builds the trail as a Lottie (bodymovin 5.x) composition: shape layers only, no text,
// no expressions (the lottie-web light SVG player has no expressions engine).

import {
  ALPHA,
  CANVAS,
  centre,
  COLORS,
  geometry,
  linkEnds,
  NODE_IDS,
  STYLE,
  TIMELINE,
  type Box,
  type Layout,
  type NodeId,
  type Point,
} from "./geometry.ts";

export type Rgba = [number, number, number, number];
export type Shape = { ty: string; nm?: string; [key: string]: unknown };
export type Static<T> = { a: 0; k: T };
export type Keyframe = { t: number; s: number[]; i?: { x: number[]; y: number[] }; o?: { x: number[]; y: number[] } };
export type Animated = { a: 1; k: Keyframe[] };
export type Prop<T> = Static<T> | Animated;

export interface LottieTransform {
  a: Prop<number[]>;
  p: Prop<number[]>;
  s: Prop<number[]>;
  r: Prop<number>;
  o: Prop<number>;
}

export interface LottieLayer {
  ddd: 0;
  ind: number;
  ty: 4;
  nm: string;
  sr: 1;
  ks: LottieTransform;
  ao: 0;
  shapes: Shape[];
  ip: number;
  op: number;
  st: number;
  bm: 0;
}

export interface LottieAnimation {
  v: string;
  fr: number;
  ip: number;
  op: number;
  w: number;
  h: number;
  nm: string;
  ddd: 0;
  assets: [];
  layers: LottieLayer[];
}

/** A cubic-bezier easing for the segment that starts at a keyframe: [x1, y1, x2, y2] as in CSS. */
export type Ease = readonly [number, number, number, number];

export const EASE = {
  /** Gentle start, long settle: the coin's travel. */
  travel: [0.45, 0, 0.2, 1],
  /** Symmetric, for colour cross-fades. */
  inOut: [0.65, 0, 0.35, 1],
  /** Decelerate hard: recoil of the snapped line, fade-ins. */
  out: [0.16, 1, 0.3, 1],
  /** Accelerate away: fading out. */
  in: [0.55, 0, 0.75, 0.3],
  /** Overshoot and settle: the coin appearing and flashing. */
  pop: [0.34, 1.56, 0.64, 1],
} as const satisfies Record<string, Ease>;

const round = (n: number, places = 3): number => {
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** "#RRGGBB" → [r, g, b, 1] with channels in 0..1. */
export function hex(c: string): Rgba {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (!m) throw new Error(`hex: expected #RRGGBB, got ${c}`);
  const ch = (s: string | undefined) => round(parseInt(s ?? "0", 16) / 255, 4);
  return [ch(m[1]), ch(m[2]), ch(m[3]), 1];
}

/**
 * Eased keyframes. Each entry is [frame, value, ease?]; the ease shapes the segment from
 * that keyframe to the next (default EASE.inOut). The last keyframe carries no easing.
 */
export function anim(keys: [frame: number, value: number[], ease?: Ease][], fallback: Ease = EASE.inOut): Animated {
  return {
    a: 1,
    k: keys.map(([t, value, ease], idx): Keyframe => {
      const s = value.map((v) => round(v, 4));
      if (idx === keys.length - 1) return { t, s };
      const [x1, y1, x2, y2] = ease ?? fallback;
      return { t, s, o: { x: [x1], y: [y1] }, i: { x: [x2], y: [y2] } };
    }),
  };
}

const fixed = <T>(k: T): Static<T> => ({ a: 0, k });
const pt = (p: Point): number[] => [round(p[0]), round(p[1])];
const pct = (alpha: number): number => round(alpha * 100, 2);

function transform(): Shape {
  return {
    ty: "tr",
    p: fixed([0, 0]),
    a: fixed([0, 0]),
    s: fixed([100, 100]),
    r: fixed(0),
    o: fixed(100),
    sk: fixed(0),
    sa: fixed(0),
    nm: "Transform",
  };
}

function fill(c: Prop<number[]>, o: Prop<number>): Shape {
  return { ty: "fl", nm: "Fill", c, o, r: 1, bm: 0 };
}

function stroke(c: Prop<number[]>, o: Prop<number>, w: number, extra: Record<string, unknown> = {}): Shape {
  return { ty: "st", nm: "Stroke", c, o, w: fixed(w), lc: 2, lj: 2, bm: 0, ...extra };
}

function group(nm: string, it: Shape[], opacity: Prop<number> = fixed(100)): Shape {
  return { ty: "gr", nm, it: [...it, { ...transform(), o: opacity }], np: it.length, bm: 0 };
}

function line(a: Point, b: Point): Shape {
  return {
    ty: "sh",
    nm: "Path",
    d: 1,
    ks: fixed({ c: false, v: [pt(a), pt(b)], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] }),
  };
}

function layer(nm: string, shapes: Shape[], ks: Partial<LottieTransform> = {}): Omit<LottieLayer, "ind"> {
  return {
    ddd: 0,
    ty: 4,
    nm,
    sr: 1,
    ks: {
      o: fixed(100),
      r: fixed(0),
      p: fixed([0, 0, 0]),
      a: fixed([0, 0, 0]),
      s: fixed([100, 100, 100]),
      ...ks,
    },
    ao: 0,
    shapes,
    ip: 0,
    // One frame past the composition so a player seeking to frame `end` still draws the
    // final frame (lottie-web hides a layer from its op onward).
    op: TIMELINE.end + 1,
    st: 0,
    bm: 0,
  };
}

const WHITE = hex(COLORS.white);
const GOLD = hex(COLORS.coin);
const PURPLE = hex(COLORS.hop);
const GREEN = hex(COLORS.you);
const RED = hex(COLORS.line);

function boxLayer(id: NodeId, b: Box): Omit<LottieLayer, "ind"> {
  const rect: Shape = {
    ty: "rc",
    nm: "Box",
    d: 1,
    s: fixed([b.w, b.h]),
    p: fixed(pt(centre(b))),
    r: fixed(STYLE.radius),
  };
  let strokeC: Prop<number[]> = fixed(WHITE);
  let strokeO: Prop<number> = fixed(pct(ALPHA.boxStroke));
  let fillC: Prop<number[]> = fixed(WHITE);
  let fillO: Prop<number> = fixed(pct(ALPHA.boxFill));

  if (id === "hop") {
    // The hop lights up purple as the coin arrives, holds through the flash, then cools off.
    const [start, peak, end] = TIMELINE.hopGlow;
    strokeC = anim([
      [start, WHITE, EASE.inOut],
      [peak, PURPLE, EASE.inOut],
      [end, WHITE],
    ]);
    strokeO = anim([
      [start, [pct(ALPHA.boxStroke)], EASE.inOut],
      [peak, [pct(ALPHA.hopStroke)], EASE.inOut],
      [end, [pct(ALPHA.boxStroke)]],
    ]);
  }
  if (id === "you") {
    // Hue commits to green early while the box is still faint, then the glow rises, so the
    // box never passes through a bright grey-white on its way to green.
    const [start, end] = TIMELINE.youGreen;
    const hue = () =>
      anim([
        [start, WHITE, EASE.out],
        [end, GREEN],
      ]);
    strokeC = hue();
    fillC = hue();
    strokeO = anim([
      [start, [pct(ALPHA.boxStroke)], EASE.inOut],
      [end, [pct(ALPHA.youStroke)]],
    ]);
    fillO = anim([
      [start, [pct(ALPHA.boxFill)], EASE.inOut],
      [end, [pct(ALPHA.youFill)]],
    ]);
  }
  return layer(`box ${id}`, [group(id, [rect, stroke(strokeC, strokeO, STYLE.boxStroke), fill(fillC, fillO)])]);
}

function connectorLayers(layout: Layout): Omit<LottieLayer, "ind">[] {
  const g = geometry(layout);
  const out: Omit<LottieLayer, "ind">[] = [];
  const red = () => stroke(fixed(RED), fixed(pct(ALPHA.line)), STYLE.line);
  const [snapStart, snapEnd] = TIMELINE.snap;

  for (const [from, to] of g.links) {
    const [a, b] = linkEnds(layout, g.nodes[from], g.nodes[to]);
    if (to !== "you") {
      out.push(layer(`link ${from}-${to}`, [group(`${from}-${to}`, [line(a, b), red()])]));
      continue;
    }
    // Underneath: the grey dashed remainder, from the snap point to "you", fading in as the line snaps.
    const remainder = group(
      "remainder",
      [
        line(a, b),
        { ty: "tm", nm: "Trim", s: fixed(round(g.snapAt * 100, 2)), e: fixed(100), o: fixed(0), m: 1 },
        stroke(fixed(WHITE), fixed(pct(ALPHA.remainder)), STYLE.line, {
          lc: 1,
          d: [
            { n: "d", nm: "dash", v: fixed(STYLE.dash[0]) },
            { n: "g", nm: "gap", v: fixed(STYLE.dash[1]) },
            { n: "o", nm: "offset", v: fixed(0) },
          ],
        }),
      ],
      anim([
        [snapStart, [0], EASE.out],
        [snapEnd, [100]],
      ]),
    );
    out.push(layer(`remainder ${from}-${to}`, [remainder]));

    // On top: the red line recoils from "you" back to a short stub.
    out.push(
      layer(`link ${from}-${to}`, [
        group(`${from}-${to}`, [
          line(a, b),
          {
            ty: "tm",
            nm: "Trim",
            s: fixed(0),
            e: anim([
              [snapStart, [100], EASE.out],
              [snapEnd, [round(g.snapAt * 100, 2)]],
            ]),
            o: fixed(0),
            m: 1,
          },
          red(),
        ]),
      ]),
    );
  }
  return out;
}

function coinLayer(layout: Layout): Omit<LottieLayer, "ind"> {
  const g = geometry(layout);
  const t = TIMELINE;
  const [inStart, inEnd] = t.coinIn;
  const [flashStart, flashEnd] = t.flash;
  const [outStart, outEnd] = t.coinOut;

  const start = linkEnds(layout, g.nodes.customer, g.nodes.fresh)[0];
  const fresh = centre(g.nodes.fresh);
  const hop = centre(g.nodes.hop);
  const p3 = (p: Point) => [...pt(p), 0];

  const colour = () =>
    anim([
      [flashStart, GOLD, EASE.inOut],
      [flashEnd, PURPLE],
    ]);
  const ellipse = (nm: string, d: number): Shape => ({ ty: "el", nm, d: 1, s: fixed([d, d]), p: fixed([0, 0]) });
  const glowPeak = Math.round(flashStart + (flashEnd - flashStart) * 0.45);

  return layer(
    "coin",
    [
      group("coin", [ellipse("Coin", STYLE.coin), fill(colour(), fixed(100))]),
      group("glow", [
        ellipse("Glow", STYLE.coinGlow),
        fill(
          colour(),
          anim([
            [flashStart, [pct(ALPHA.coinGlow)], EASE.out],
            [glowPeak, [pct(ALPHA.coinGlow) * 1.9], EASE.inOut],
            [flashEnd, [pct(ALPHA.coinGlow)]],
          ]),
        ),
      ]),
    ],
    {
      p: anim([
        [inEnd, p3(start), EASE.travel],
        [t.coinAtFresh, p3(fresh), EASE.travel],
        [t.coinAtHop, p3(hop)],
      ]),
      s: anim([
        [inStart, [40, 40, 100], EASE.pop],
        [inEnd, [100, 100, 100], EASE.inOut],
        [flashStart, [100, 100, 100], EASE.pop],
        [flashEnd, [140, 140, 100], EASE.in],
        [outEnd, [60, 60, 100]],
      ]),
      o: anim([
        [inStart, [0], EASE.out],
        [inEnd, [100], EASE.inOut],
        [outStart, [100], EASE.in],
        [outEnd, [0]],
      ]),
    },
  );
}

export function buildTrail(layout: Layout): LottieAnimation {
  const g = geometry(layout);
  const { w, h } = CANVAS[layout];
  // Bottom to top; Lottie lists the top layer first.
  const bottomUp = [...NODE_IDS.map((id) => boxLayer(id, g.nodes[id])), ...connectorLayers(layout), coinLayer(layout)];
  const layers = bottomUp.reverse().map((l, i): LottieLayer => ({ ...l, ind: i + 1 }));
  return {
    v: "5.12.2",
    fr: TIMELINE.fps,
    ip: 0,
    op: TIMELINE.end,
    w,
    h,
    nm: `0crypto trail ${layout}`,
    ddd: 0,
    assets: [],
    layers,
  };
}
