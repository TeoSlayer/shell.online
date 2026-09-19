import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS,
  motionReduced,
  normaliseOptions,
  optionsToStyle,
  SAFE_ZONE_RANGE,
  UI_SCALE_RANGE,
} from "./options";

describe("bringing stored options into range", () => {
  it("keeps values that are already sensible", () => {
    const options = { safeZone: 7, uiScale: 150, motion: "reduced", colour: "protanopia" };
    expect(normaliseOptions(options)).toEqual(options);
  });

  it("clamps a safe area beyond what the slider offers", () => {
    /*
     * A safe area of 80% is a game played through a letterbox. Whatever wrote
     * it -- an old build, a hand-edited value -- the renderer has to be handed
     * something it can draw.
     */
    expect(normaliseOptions({ safeZone: 80 }).safeZone).toBe(SAFE_ZONE_RANGE.max);
    expect(normaliseOptions({ safeZone: -20 }).safeZone).toBe(SAFE_ZONE_RANGE.min);
  });

  it("clamps an interface scale to something readable", () => {
    expect(normaliseOptions({ uiScale: 5 }).uiScale).toBe(UI_SCALE_RANGE.min);
    expect(normaliseOptions({ uiScale: 1000 }).uiScale).toBe(UI_SCALE_RANGE.max);
  });

  it("falls back for a setting it does not recognise", () => {
    expect(normaliseOptions({ motion: "spinny" }).motion).toBe(DEFAULT_OPTIONS.motion);
    expect(normaliseOptions({ colour: "beige" }).colour).toBe(DEFAULT_OPTIONS.colour);
  });

  it("survives anything at all, because localStorage can hold anything at all", () => {
    expect(normaliseOptions(null)).toEqual(DEFAULT_OPTIONS);
    expect(normaliseOptions("not an object")).toEqual(DEFAULT_OPTIONS);
    expect(normaliseOptions(42)).toEqual(DEFAULT_OPTIONS);
    expect(normaliseOptions({ safeZone: Number.NaN })).toEqual(DEFAULT_OPTIONS);
  });

  it("defaults to a safe area a television will not eat", () => {
    /*
     * The recoverable mistake is a little wasted margin on a monitor. The
     * unrecoverable one is a player who cannot see the menu they would need in
     * order to fix it, so the default errs towards the monitor's loss.
     */
    expect(DEFAULT_OPTIONS.safeZone).toBeGreaterThan(0);
  });
});

describe("deciding whether to animate", () => {
  it("follows the system when asked to", () => {
    const options = { ...DEFAULT_OPTIONS, motion: "system" as const };
    expect(motionReduced(options, true)).toBe(true);
    expect(motionReduced(options, false)).toBe(false);
  });

  it("lets an explicit choice override the system either way", () => {
    expect(motionReduced({ ...DEFAULT_OPTIONS, motion: "full" }, true)).toBe(false);
    expect(motionReduced({ ...DEFAULT_OPTIONS, motion: "reduced" }, false)).toBe(true);
  });
});

describe("handing the options to the stylesheet", () => {
  it("writes the custom properties game.css reads", () => {
    const style = optionsToStyle({ safeZone: 8, uiScale: 125, motion: "full", colour: "default" }, false);
    expect(style["--keep-safe"]).toBe("8%");
    expect(style["--keep-scale"]).toBe("1.25");
    expect(style["--keep-motion"]).toBe("1");
  });

  it("collapses every duration to nothing when motion is reduced", () => {
    /* game.css multiplies its durations by this, so zero stops all of them. */
    const style = optionsToStyle({ ...DEFAULT_OPTIONS, motion: "reduced" }, false);
    expect(style["--keep-motion"]).toBe("0");
  });
});

describe("the safe area on a handset", () => {
  it("comes from the device rather than from the overscan slider", () => {
    /*
     * These properties are set inline, and an inline property beats every rule
     * in the stylesheet -- so the media query that used to redefine this for a
     * phone had never once applied. A phone has no overscan; it has a notch.
     */
    const style = optionsToStyle({ ...DEFAULT_OPTIONS, safeZone: 10 }, false, "phone");
    expect(style["--keep-safe-top"]).toContain("env(safe-area-inset-top)");
    expect(style["--keep-safe-bottom"]).toContain("env(safe-area-inset-bottom)");
  });

  it("asks each edge about itself", () => {
    /*
     * One number is the right shape for overscan and the wrong shape for a
     * handset: in portrait the left and right insets are zero while the top is
     * the status bar and the bottom is the gesture strip. Taking the left
     * inset for all four is how a HUD ends up under the clock.
     */
    const style = optionsToStyle(DEFAULT_OPTIONS, false, "phone");
    const sides = ["top", "right", "bottom", "left"] as const;
    for (const side of sides) {
      expect(style[`--keep-safe-${side}`]).toContain(`env(safe-area-inset-${side})`);
    }
  });

  it("is still the slider's on anything else, on every edge", () => {
    const style = optionsToStyle({ ...DEFAULT_OPTIONS, safeZone: 7 }, false, "room");
    expect(style["--keep-safe"]).toBe("7%");
    expect(style["--keep-safe-top"]).toBe("7%");
    expect(style["--keep-safe-bottom"]).toBe("7%");
  });
});
