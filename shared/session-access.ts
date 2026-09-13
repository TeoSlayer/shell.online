import { Opcode } from "./protocol";

export type ViewerFrameAction = "input" | "confirmed-eof" | "resize" | "ping" | "file-request" | "blocked-input" | "invalid";

export function viewerFrameAction(opcode: number, readOnly: boolean): ViewerFrameAction {
  if (opcode === Opcode.Input) return readOnly ? "blocked-input" : "input";
  if (opcode === Opcode.ConfirmedEOF) return readOnly ? "blocked-input" : "confirmed-eof";
  if (opcode === Opcode.Resize) return "resize";
  if (opcode === Opcode.Ping) return "ping";
  // File access is independently opt-in at the CLI. A read-only terminal link
  // may inspect files that its owner deliberately shared.
  if (opcode === Opcode.FileRequest) return "file-request";
  return "invalid";
}

export function readOnlyFromControlMessage(value: unknown): boolean | null {
  if (typeof value !== "object" || value === null) return null;
  const readOnly = (value as Record<string, unknown>).readOnly;
  return typeof readOnly === "boolean" ? readOnly : null;
}
