export type TerminalKeyAction =
  | { kind: "default" }
  | { kind: "copy-selection" }
  | { kind: "send"; bytes: Uint8Array };

const mobileTerminalKeys: Record<string, readonly number[]> = {
  escape: [27],
  tab: [9],
  left: [27, 91, 68],
  up: [27, 91, 65],
  down: [27, 91, 66],
  right: [27, 91, 67],
  enter: [13],
  interrupt: [3],
};

export function mobileTerminalKeyBytes(key: string | undefined): Uint8Array | null {
  if (key === undefined || !(key in mobileTerminalKeys)) return null;
  return new Uint8Array(mobileTerminalKeys[key]);
}

export function terminalKeyAction(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "keyCode">,
  hasSelection: boolean,
): TerminalKeyAction {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "c" && hasSelection) {
    return { kind: "copy-selection" };
  }
  if (event.ctrlKey && !event.metaKey && key === "c" && event.keyCode === 13) {
    return { kind: "send", bytes: new Uint8Array([3]) };
  }
  if (event.ctrlKey && !event.metaKey && key === "w") {
    return { kind: "send", bytes: new Uint8Array([23]) };
  }
  return { kind: "default" };
}
