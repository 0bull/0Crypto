// One source of truth for the landing "trail": where the four boxes sit, how they link,
// when things happen, and which colours they use. The Lottie compositions, the static
// final-frame SVGs and the HTML label CSS are all derived from this module.

export type Layout = "landscape" | "portrait";
export type NodeId = "customer" | "fresh" | "hop" | "you";
export type Box = { x: number; y: number; w: number; h: number };
export type Point = [number, number];

export const LAYOUTS: readonly Layout[] = ["landscape", "portrait"];
export const NODE_IDS: readonly NodeId[] = ["customer", "fresh", "hop", "you"];

export const CANVAS: Record<Layout, { w: number; h: number }> = {
  landscape: { w: 1200, h: 300 },
  portrait: { w: 360, h: 760 },
};

/** Frames at 60 fps. The composition plays once, 0..360 (6 s). */
export const TIMELINE = {
  fps: 60,
  coinIn: [0, 22],
  coinAtFresh: 108,
  coinAtHop: 173,
  flash: [173, 194],
  hopGlow: [162, 187, 252],
  coinOut: [194, 223],
  snap: [198, 230],
  label: [216, 245],
  youGreen: [238, 266],
  end: 360,
} as const;

export const COLORS = {
  coin: "#FFD86B",
  hop: "#B48CFF",
  you: "#7FE0A8",
  line: "#FF453A",
  white: "#FFFFFF",
} as const;

/** Opacities in 0..1, paired with the colours above. */
export const ALPHA = {
  line: 0.85, // rgba(255,69,58,.85)
  remainder: 0.16, // rgba(255,255,255,.16)
  boxFill: 0.045, // rgba(255,255,255,.045)
  boxStroke: 0.08, // rgba(255,255,255,.08)
  hopStroke: 0.9,
  youFill: 0.12,
  youStroke: 0.9,
  coinGlow: 0.3,
} as const;

export const STYLE = {
  radius: 14,
  boxStroke: 1.5,
  line: 2,
  dash: [6, 6],
  coin: 14,
  coinGlow: 36,
} as const;

type Geometry = { nodes: Record<NodeId, Box>; links: [NodeId, NodeId][]; snapAt: number };

const LINKS: [NodeId, NodeId][] = [
  ["customer", "fresh"],
  ["fresh", "hop"],
  ["hop", "you"],
];

/** Fraction along hop→you where the red line stops: a short stub stays, the rest goes grey. */
const SNAP_AT = 0.34;

function row(): Record<NodeId, Box> {
  const w = 184;
  const h = 112;
  const x0 = 28;
  const gap = 136; // (1200 - 2·28 - 4·184) / 3
  const y = (CANVAS.landscape.h - h) / 2;
  const at = (i: number): Box => ({ x: x0 + i * (w + gap), y, w, h });
  return { customer: at(0), fresh: at(1), hop: at(2), you: at(3) };
}

function column(): Record<NodeId, Box> {
  const w = 240;
  const h = 108;
  const y0 = 20;
  const gap = 96; // (760 - 2·20 - 4·108) / 3
  const x = (CANVAS.portrait.w - w) / 2;
  const at = (i: number): Box => ({ x, y: y0 + i * (h + gap), w, h });
  return { customer: at(0), fresh: at(1), hop: at(2), you: at(3) };
}

export function geometry(layout: Layout): Geometry {
  return {
    nodes: layout === "landscape" ? row() : column(),
    links: LINKS.map(([a, b]) => [a, b]),
    snapAt: SNAP_AT,
  };
}

export function centre(b: Box): Point {
  return [b.x + b.w / 2, b.y + b.h / 2];
}

/** The straight segment between two boxes: right→left edge in a row, bottom→top edge in a column. */
export function linkEnds(layout: Layout, a: Box, b: Box): [Point, Point] {
  if (layout === "landscape") {
    const y = a.y + a.h / 2;
    return [
      [a.x + a.w, y],
      [b.x, y],
    ];
  }
  const x = a.x + a.w / 2;
  return [
    [x, a.y + a.h],
    [x, b.y],
  ];
}

export function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Clearance between the hop→you line and the "No on-chain link" label box. */
const CUT_OFFSET = 10;
/** Room for up to two lines of label text under the landscape line. */
const CUT_LANDSCAPE_H = 44;

/**
 * Where the HTML "No on-chain link" label (`.trail__cut`) sits: over the snapped part of
 * hop→you (from the snap point to "you"), just off the line — below it in a row, beside it
 * in a column. It stays inside the gap between the boxes, so it never covers one.
 */
export function cutBox(layout: Layout): Box {
  const g = geometry(layout);
  const [a, b] = linkEnds(layout, g.nodes.hop, g.nodes.you);
  const cut = lerp(a, b, g.snapAt);
  if (layout === "landscape") {
    return { x: cut[0], y: a[1] + CUT_OFFSET, w: b[0] - cut[0], h: CUT_LANDSCAPE_H };
  }
  const x = a[0] + CUT_OFFSET;
  return { x, y: cut[1], w: CANVAS.portrait.w - CUT_OFFSET - x, h: b[1] - cut[1] };
}
