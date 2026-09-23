import { describe, expect, it } from "vitest";
import {
  DESKTOP_TERMINAL_GRID,
  LEGACY_MOBILE_TERMINAL_GRID,
  MOBILE_TERMINAL_GRID,
  WIDE_DESKTOP_TERMINAL_GRID,
  advertisesGrid,
  terminalGridForDevices,
  terminalGridsHeader,
  ownsItsGrid,
} from "../shared/terminal-grid";

/*
 * The grid is the session's, not the viewer's: the CLI opens the pty at it and
 * every viewer draws it. A relay that picks a size the host's CLI has never
 * heard of gets no resize at all -- the CLI ignores what it does not
 * recognise -- and the session then serves 120x36 while the app draws 160x48,
 * which is the same output in the wrong places. So the host says what it can
 * open and nothing is offered that was not advertised.
 */
describe("choosing a grid for the devices watching", () => {
  it("offers the wider desktop grid only to a host that advertised it", () => {
    expect(terminalGridForDevices(["desktop"], true, true)).toEqual(WIDE_DESKTOP_TERMINAL_GRID);
    expect(terminalGridForDevices(["desktop"], true, false)).toEqual(DESKTOP_TERMINAL_GRID);
    /* Absent means no, for a CLI too old to have an opinion. */
    expect(terminalGridForDevices(["desktop"], true)).toEqual(DESKTOP_TERMINAL_GRID);
  });

  it("still gives a phone the portrait grid, however wide the host can go", () => {
    expect(terminalGridForDevices(["mobile"], true, true)).toEqual(MOBILE_TERMINAL_GRID);
    expect(terminalGridForDevices(["portrait"], true, true)).toEqual(MOBILE_TERMINAL_GRID);
    expect(terminalGridForDevices(["portrait"], false, true)).toEqual(LEGACY_MOBILE_TERMINAL_GRID);
  });

  it("drops to the shared size as soon as a phone is watching", () => {
    expect(terminalGridForDevices(["desktop", "mobile"], true, true)).toEqual(MOBILE_TERMINAL_GRID);
  });
});

describe("what a host advertises", () => {
  /*
   * The header was a single size, `80x40`, meaning "I know the portrait
   * grid". It is a list now, and the old value has to keep meaning what it
   * meant -- otherwise every CLI already installed loses the portrait grid.
   */
  it("reads an older CLI's single size as the list of one that it is", () => {
    expect(advertisesGrid("80x40", MOBILE_TERMINAL_GRID)).toBe(true);
    expect(advertisesGrid("80x40", WIDE_DESKTOP_TERMINAL_GRID)).toBe(false);
  });

  it("reads this CLI's list", () => {
    const header = terminalGridsHeader();
    expect(advertisesGrid(header, MOBILE_TERMINAL_GRID)).toBe(true);
    expect(advertisesGrid(header, WIDE_DESKTOP_TERMINAL_GRID)).toBe(true);
  });

  it("says no for a CLI old enough to send nothing at all", () => {
    expect(advertisesGrid(null, MOBILE_TERMINAL_GRID)).toBe(false);
    expect(advertisesGrid(undefined, WIDE_DESKTOP_TERMINAL_GRID)).toBe(false);
    expect(advertisesGrid("", WIDE_DESKTOP_TERMINAL_GRID)).toBe(false);
  });

  /* And a size that merely looks similar is not the same size. */
  it("does not match on a prefix", () => {
    expect(advertisesGrid("160x480", WIDE_DESKTOP_TERMINAL_GRID)).toBe(false);
    expect(advertisesGrid("1160x48", WIDE_DESKTOP_TERMINAL_GRID)).toBe(false);
  });

  /* What the Go CLI sends must be what this reads; see internal/relay/relay.go. */
  it("is the header the CLI actually sets", () => {
    expect(terminalGridsHeader()).toBe("80x40,160x48,dynamic");
  });

  /*
   * "dynamic" is one more entry, not a replacement, so a relay that predates
   * it still reads the sizes around it, and a relay that knows it reads it
   * wherever it is in the list.
   */
  it("says the host owns its grid without hiding the sizes it can open", () => {
    const header = terminalGridsHeader();
    expect(ownsItsGrid(header)).toBe(true);
    expect(advertisesGrid(header, MOBILE_TERMINAL_GRID)).toBe(true);
    expect(advertisesGrid(header, WIDE_DESKTOP_TERMINAL_GRID)).toBe(true);
    expect(ownsItsGrid("dynamic")).toBe(true);
    expect(ownsItsGrid("80x40,160x48")).toBe(false);
    expect(ownsItsGrid("80x40")).toBe(false);
    expect(ownsItsGrid("dynamically")).toBe(false);
    expect(ownsItsGrid(null)).toBe(false);
  });
});
