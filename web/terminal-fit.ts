export const SHARED_TERMINAL_COLS = 80;
export const SHARED_TERMINAL_ROWS = 24;

/**
 * Scale one immutable terminal grid into an individual browser viewport.
 * The process keeps the same geometry while every viewer gets an independent
 * presentation size.
 */
export function fittedTerminalFontSize(
  baseFontSize: number,
  availableColumns: number,
  availableRows: number,
  zoomPercent = 100,
): number {
  if (
    !Number.isFinite(baseFontSize) ||
    !Number.isFinite(availableColumns) ||
    !Number.isFinite(availableRows) ||
    !Number.isFinite(zoomPercent) ||
    baseFontSize <= 0 ||
    availableColumns <= 0 ||
    availableRows <= 0
  ) {
    return Math.max(4, baseFontSize || 14);
  }

  const fitScale = Math.min(
    availableColumns / SHARED_TERMINAL_COLS,
    availableRows / SHARED_TERMINAL_ROWS,
  );
  const scaled = baseFontSize * fitScale * (zoomPercent / 100) * 0.985;
  return Math.min(32, Math.max(4, Math.floor(scaled * 4) / 4));
}
