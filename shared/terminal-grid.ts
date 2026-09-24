export interface TerminalGrid {
  cols: number;
  rows: number;
}

export const DESKTOP_TERMINAL_GRID: TerminalGrid = { cols: 120, rows: 36 };
export const LEGACY_MOBILE_TERMINAL_GRID: TerminalGrid = { cols: 80, rows: 24 };
export const MOBILE_TERMINAL_GRID: TerminalGrid = { cols: 80, rows: 40 };

/**
 * What a desktop gets when the host can open one.
 *
 * A terminal shows what fits in its grid and nothing else, so on a wide
 * screen 120x36 is the amount of work you can see at once -- a third of a
 * file, a third of a diff, a build log that has already scrolled past the
 * error. The window has the room; the grid was what was stopping it.
 *
 * It is offered rather than assumed, because the size is the session's and
 * not the viewer's: the CLI opens the pty at it, every viewer draws it, and a
 * CLI that has never heard of this size ignores a resize to it and keeps
 * serving 120x36 while the app draws 160x48 -- the same output in the wrong
 * places. So the host says what it can open, and only a host that says this
 * one is asked for it. See `X-Shell-Terminal-Grid`.
 */
export const WIDE_DESKTOP_TERMINAL_GRID: TerminalGrid = { cols: 160, rows: 48 };

/** What the host advertises on attach: every grid its CLI will open. */
export function terminalGridsHeader(): string {
  return `${MOBILE_TERMINAL_GRID.cols}x${MOBILE_TERMINAL_GRID.rows},${WIDE_DESKTOP_TERMINAL_GRID.cols}x${WIDE_DESKTOP_TERMINAL_GRID.rows}`;
}

/**
 * Whether a host's advertisement includes a given grid.
 *
 * The header was one size, `80x40`, meaning "I know the portrait grid". It is
 * a list now, and the old single value still reads correctly as a list of one,
 * which is what keeps an older CLI working: it says 80x40, so it is offered
 * the portrait grid and never the wide one.
 */
export function advertisesGrid(header: string | null | undefined, grid: TerminalGrid): boolean {
  if (!header) return false;
  const wanted = `${grid.cols}x${grid.rows}`;
  return header.split(",").some((entry) => entry.trim() === wanted);
}

export function terminalGridForDevices(
  devices: readonly string[],
  supportsPortraitGrid: boolean,
  supportsWideGrid = false,
): TerminalGrid {
  const needsPortraitGrid = devices.some((device) => device === "mobile" || device === "portrait");
  if (!needsPortraitGrid) return supportsWideGrid ? WIDE_DESKTOP_TERMINAL_GRID : DESKTOP_TERMINAL_GRID;
  return supportsPortraitGrid ? MOBILE_TERMINAL_GRID : LEGACY_MOBILE_TERMINAL_GRID;
}
