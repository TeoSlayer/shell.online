import { describe, expect, it } from "vitest";
import {
  MobileViewportTracker,
  terminalTypography,
} from "../web/mobile-viewport";

describe("mobile viewport tracking", () => {
  it("distinguishes Safari toolbar motion from the software keyboard", () => {
    const viewport = new MobileViewportTracker();
    expect(viewport.observe(390, 844).keyboardOpen).toBe(false);
    expect(viewport.observe(390, 759).keyboardOpen).toBe(false);
    expect(viewport.observe(390, 844).keyboardOpen).toBe(false);
  });

  it("reports every keyboard animation frame at its current height", () => {
    const viewport = new MobileViewportTracker();
    viewport.observe(390, 844);

    expect(viewport.observe(390, 650)).toMatchObject({
      height: 650,
      keyboardOpen: true,
    });
    expect(viewport.observe(390, 580)).toMatchObject({
      height: 580,
      keyboardOpen: true,
    });
    expect(viewport.observe(390, 493)).toMatchObject({
      height: 493,
      keyboardOpen: true,
    });
  });

  it("restores the full viewport immediately when the keyboard closes", () => {
    const viewport = new MobileViewportTracker();
    viewport.observe(390, 844);
    viewport.observe(390, 493);

    expect(viewport.observe(390, 760)).toMatchObject({
      height: 760,
      keyboardOpen: false,
    });
  });

  it("keeps keyboard detection through an orientation change", () => {
    const viewport = new MobileViewportTracker();
    viewport.observe(390, 844);

    expect(viewport.observe(844, 150)).toMatchObject({
      orientationChanged: true,
      keyboardOpen: true,
    });
  });
});

describe("terminal typography", () => {
  it("uses a denser readable terminal while the mobile keyboard is open", () => {
    expect(terminalTypography(true, false, 390, 844)).toEqual({
      fontSize: 13,
      lineHeight: 1.18,
    });
    expect(terminalTypography(true, true, 390, 493)).toEqual({
      fontSize: 8.5,
      lineHeight: 1.1,
    });
    expect(terminalTypography(true, true, 360, 420)).toEqual({
      fontSize: 8,
      lineHeight: 1.08,
    });
  });

  it("provides at least one and a half times the mobile columns while typing", () => {
    const idle = terminalTypography(true, false, 390, 844);
    const typing = terminalTypography(true, true, 390, 493);
    expect(idle.fontSize / typing.fontSize).toBeGreaterThanOrEqual(1.5);
  });
});
