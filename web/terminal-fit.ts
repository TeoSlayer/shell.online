/**
 * Scale the current session-wide terminal grid into an individual viewport.
 */
export function fittedTerminalFontSize(
  baseFontSize: number,
  availableColumns: number,
  availableRows: number,
  zoomPercent = 100,
  terminalColumns = 80,
  terminalRows = 24,
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
    availableColumns / terminalColumns,
    availableRows / terminalRows,
  );
  const scaled = baseFontSize * fitScale * (zoomPercent / 100) * 0.985;
  return Math.min(32, Math.max(4, Math.floor(scaled * 4) / 4));
}
