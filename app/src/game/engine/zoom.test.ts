import { describe, expect, it } from "vitest";
import { atLimit, headroom, openingZoom, plateCeiling, stepZoom, zoomBounds } from "./zoom";

/** The Marches, in world pixels: 128 tiles at 64 by 32. */
const WORLD = { width: 128 * 64, height: 128 * 32 };
const bounds = (w: number, h: number) => zoomBounds(w, h, WORLD.width, WORLD.height);

const PHONE = { width: 390, height: 844 };
const PHONE_SIDEWAYS = { width: 844, height: 390 };
const LAPTOP = { width: 1440, height: 900 };

describe("how far the camera may pull back", () => {
  it("lets a phone see the whole country", () => {
    const limits = bounds(PHONE.width, PHONE.height);
    expect(limits.min).toBeLessThan(0.1);
    expect(PHONE.width / limits.min).toBeGreaterThanOrEqual(WORLD.width);
  });

  it("never asks for a floor above the ceiling", () => {
    /* A canvas measured before layout is 0 by 0, and a min above max freezes it. */
    const limits = bounds(99_999, 99_999);
    expect(limits.min).toBeLessThanOrEqual(limits.max);
  });

  it("gives a zero-sized canvas a usable range rather than nothing", () => {
    const limits = bounds(0, 0);
    expect(limits.max).toBeGreaterThan(limits.min);
  });
});

describe("a press of a zoom control", () => {
  it("cannot be pushed past the limits", () => {
    const limits = bounds(LAPTOP.width, LAPTOP.height);
    expect(stepZoom(limits.max, 1.4, limits)).toBe(limits.max);
    expect(stepZoom(limits.min, 1 / 1.4, limits)).toBe(limits.min);
  });

  it("moves when there is room", () => {
    const limits = bounds(LAPTOP.width, LAPTOP.height);
    expect(stepZoom(1, 1.4, limits)).toBeCloseTo(1.4);
    expect(stepZoom(1, 1 / 1.4, limits)).toBeCloseTo(1 / 1.4);
  });

  it("says when a control has nowhere left to go", () => {
    const limits = bounds(LAPTOP.width, LAPTOP.height);
    expect(atLimit(limits.min, limits).out).toBe(true);
    expect(atLimit(limits.max, limits).in).toBe(true);
    expect(atLimit(1, limits)).toEqual({ out: false, in: false });
  });
});

describe("where the camera opens", () => {
  it("opens on a readable view on a phone, not on a diagram", () => {
    const limits = bounds(PHONE.width, PHONE.height);
    expect(openingZoom(PHONE.width, PHONE.height, limits)).toBeGreaterThanOrEqual(0.45);
  });

  it("opens wider on a laptop than on a phone", () => {
    const wide = openingZoom(LAPTOP.width, LAPTOP.height, bounds(LAPTOP.width, LAPTOP.height));
    const narrow = openingZoom(PHONE.width, PHONE.height, bounds(PHONE.width, PHONE.height));
    expect(wide).toBeGreaterThan(narrow);
  });

  it("stays inside the limits it is given", () => {
    const limits = bounds(PHONE.width, PHONE.height);
    const zoom = openingZoom(PHONE.width, PHONE.height, limits);
    expect(zoom).toBeGreaterThanOrEqual(limits.min);
    expect(zoom).toBeLessThanOrEqual(limits.max);
  });
});

describe("how far above a subject the camera sits", () => {
  it("does not lift a subject off a short screen", () => {
    expect(headroom(PHONE_SIDEWAYS.height)).toBeLessThan(PHONE_SIDEWAYS.height / 2);
  });

  it("is bounded on a tall one", () => {
    expect(headroom(2160)).toBeLessThanOrEqual(150);
  });
});

describe("how large a name board may grow", () => {
  it("is held down on a handset, where the map is the scarce thing", () => {
    expect(plateCeiling(PHONE.width)).toBeLessThan(plateCeiling(LAPTOP.width));
  });

  it("never shrinks a board below its drawn size", () => {
    expect(plateCeiling(PHONE.width)).toBeGreaterThanOrEqual(1);
  });
});
