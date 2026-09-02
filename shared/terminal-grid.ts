export interface TerminalGrid {
  cols: number;
  rows: number;
}

export const DESKTOP_TERMINAL_GRID: TerminalGrid = { cols: 120, rows: 36 };
export const MOBILE_TERMINAL_GRID: TerminalGrid = { cols: 80, rows: 24 };

export function terminalGridForDevices(devices: readonly string[]): TerminalGrid {
  return devices.includes("mobile") ? MOBILE_TERMINAL_GRID : DESKTOP_TERMINAL_GRID;
}
