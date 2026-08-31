export type TerminalKeyAction =
  | { kind: "default" }
  | { kind: "copy-selection" }
  | { kind: "send"; bytes: Uint8Array };

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
