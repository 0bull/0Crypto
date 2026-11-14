// Client side of the landing "trail". The markup ships the final frame (static SVG, every
// label in its end state), so this module only ever upgrades it: it lazy-loads the Lottie
// light player for the visible composition, swaps it in once its DOM is built, and plays it
// once when the section is in view. Any failure leaves the static markup alone.

import type { AnimationItem } from "lottie-web";
import { TIMELINE } from "../../scripts/trail/geometry.ts";

export type TrailMode = "static" | "animate";
type Span = [delay: number, duration: number];

export function chooseTrailMode(env: { reducedMotion: boolean; hasObserver: boolean }): TrailMode {
  return env.reducedMotion || !env.hasObserver ? "static" : "animate";
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const span = (from: number, to: number, fr: number): Span => [r3(from / fr), r3((to - from) / fr)];

/** When the HTML labels change, in seconds from play(), as [delay, duration]. */
export function labelDelays(fr: number): { cut: Span; you: Span } {
  return {
    cut: span(TIMELINE.label[0], TIMELINE.label[1], fr),
    you: span(TIMELINE.youGreen[0], TIMELINE.youGreen[1], fr),
  };
}

/** The hop label glows with its box: up to the peak, then back down. */
export function hopDelays(fr: number): { in: Span; out: Span } {
  const [start, peak, end] = TIMELINE.hopGlow;
  return { in: span(start, peak, fr), out: span(peak, end, fr) };
}

type State = "ready" | "playing" | "done";

function setTimings(block: HTMLElement, fr: number): void {
  const { cut, you } = labelDelays(fr);
  const hop = hopDelays(fr);
  // CSSOM custom properties (not a style attribute in markup); trail.css reads them.
  const vars: Record<string, number> = {
    "--trail-cut-delay": cut[0],
    "--trail-cut-dur": cut[1],
    "--trail-you-delay": you[0],
    "--trail-you-dur": you[1],
    "--trail-hop-in-delay": hop.in[0],
    "--trail-hop-in-dur": hop.in[1],
    "--trail-hop-out-delay": hop.out[0],
    "--trail-hop-out-dur": hop.out[1],
  };
  for (const [name, s] of Object.entries(vars)) block.style.setProperty(name, `${s}s`);
}

const isShown = (el: Element): boolean => el.getClientRects().length > 0;

export function initTrail(root: HTMLElement): void {
  const mode = chooseTrailMode({
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    hasObserver: "IntersectionObserver" in window,
  });
  if (mode === "static") return;

  // Only the composition the media query shows animates; the other keeps its final frame.
  const block = [...root.querySelectorAll<HTMLElement>(".trail")].find(isShown);
  const player = block?.querySelector<HTMLElement>(".trail__player");
  const src = player?.dataset.src;
  if (!block || !player || !src) return;

  let anim: AnimationItem | undefined;
  let watcher: IntersectionObserver | undefined;
  const setState = (s: State) => (block.dataset.state = s);

  const restoreStatic = () => {
    watcher?.disconnect();
    window.removeEventListener("resize", onResize);
    anim?.destroy();
    anim = undefined;
    player.replaceChildren();
    delete block.dataset.state;
  };

  // If the layout flips across the breakpoint mid-play, this copy is hidden (and its CSS
  // animations cancelled). Settle it on the final frame so it is whole if it comes back.
  const onResize = () => {
    if (!anim || isShown(block) || block.dataset.state !== "playing") return;
    anim.goToAndStop(anim.totalFrames - 1, true);
    setState("done");
    window.removeEventListener("resize", onResize);
  };

  const play = () => {
    if (!anim) return;
    setState("playing");
    anim.play();
  };

  const watchForPlay = () => {
    // "Half in view": half the block, or — when the block is taller than two viewports
    // (portrait layout on a short landscape phone) — half the viewport filled by it.
    watcher = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const vh = e.rootBounds?.height ?? window.innerHeight;
          if (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= vh * 0.5) {
            watcher?.disconnect();
            play();
          }
        }
      },
      { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5] },
    );
    watcher.observe(block);
  };

  const load = async () => {
    try {
      const { default: lottie } = await import("lottie-web/build/player/lottie_light");
      anim = lottie.loadAnimation({
        container: player,
        renderer: "svg",
        loop: false,
        autoplay: false,
        path: src,
        rendererSettings: { preserveAspectRatio: "xMidYMid meet", progressiveLoad: false },
      });
    } catch {
      restoreStatic();
      return;
    }
    anim.addEventListener("data_failed", restoreStatic);
    anim.addEventListener("error", restoreStatic);
    anim.addEventListener("DOMLoaded", () => {
      if (!anim) return;
      setTimings(block, anim.frameRate || TIMELINE.fps);
      setState("ready");
      window.addEventListener("resize", onResize, { passive: true });
      watchForPlay();
    });
    anim.addEventListener("complete", () => {
      setState("done");
      window.removeEventListener("resize", onResize);
    });
  };

  const near = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      near.disconnect();
      void load();
    },
    { rootMargin: "300px" },
  );
  near.observe(block);
}
