/*
 * Vendored verbatim from shell.online: shared/terminal-grid.ts
 *
 * The session-wide grid the relay picks and the CLI opens the PTY at. It is
 * copied rather than reimplemented so the app cannot disagree with the relay
 * about how big a terminal is, and checked by `npm run check:protocol`, which
 * fails if the upstream file changes. Do not edit here; edit upstream.
 */
export interface TerminalGrid {
  cols: number;
  rows: number;
}

export const DESKTOP_TERMINAL_GRID: TerminalGrid = { cols: 120, rows: 36 };
export const LEGACY_MOBILE_TERMINAL_GRID: TerminalGrid = { cols: 80, rows: 24 };
export const MOBILE_TERMINAL_GRID: TerminalGrid = { cols: 80, rows: 40 };

export function terminalGridForDevices(
  devices: readonly string[],
  supportsPortraitGrid: boolean,
): TerminalGrid {
  const needsPortraitGrid = devices.some((device) => device === "mobile" || device === "portrait");
  if (!needsPortraitGrid) return DESKTOP_TERMINAL_GRID;
  return supportsPortraitGrid ? MOBILE_TERMINAL_GRID : LEGACY_MOBILE_TERMINAL_GRID;
}
