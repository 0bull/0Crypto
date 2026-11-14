import { describe, expect, it } from "vitest";
import { chooseTrailMode, hopDelays, labelDelays } from "../src/scripts/trail.ts";

describe("chooseTrailMode", () => {
  it("stays static when the visitor prefers reduced motion", () => {
    expect(chooseTrailMode({ reducedMotion: true, hasObserver: true })).toBe("static");
  });
  it("stays static without IntersectionObserver", () => {
    expect(chooseTrailMode({ reducedMotion: false, hasObserver: false })).toBe("static");
  });
  it("animates otherwise", () => {
    expect(chooseTrailMode({ reducedMotion: false, hasObserver: true })).toBe("animate");
  });
});

describe("labelDelays", () => {
  it("turns the label and You-green frames into [delay, duration] seconds", () => {
    expect(labelDelays(60)).toEqual({ cut: [3.6, 0.483], you: [3.967, 0.467] });
  });
});

describe("hopDelays", () => {
  it("follows the hop box glow up to its peak and back", () => {
    expect(hopDelays(60)).toEqual({ in: [2.7, 0.417], out: [3.117, 1.083] });
  });
});
