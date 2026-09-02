import { describe, expect, it } from "vitest";
import { Opcode } from "../shared/protocol";
import { readOnlyFromControlMessage, viewerFrameAction } from "../shared/session-access";

describe("session access enforcement", () => {
  it("blocks input for read-only viewers", () => {
    expect(viewerFrameAction(Opcode.Input, true)).toBe("blocked-input");
    expect(viewerFrameAction(Opcode.Input, false)).toBe("input");
    expect(viewerFrameAction(Opcode.ConfirmedEOF, true)).toBe("blocked-input");
    expect(viewerFrameAction(Opcode.ConfirmedEOF, false)).toBe("confirmed-eof");
  });

  it("keeps display sizing and latency probes available", () => {
    for (const readOnly of [false, true]) {
      expect(viewerFrameAction(Opcode.Resize, readOnly)).toBe("resize");
      expect(viewerFrameAction(Opcode.Ping, readOnly)).toBe("ping");
    }
    expect(viewerFrameAction(255, true)).toBe("invalid");
  });

  it("only accepts an explicit boolean from server control messages", () => {
    expect(readOnlyFromControlMessage({ readOnly: true })).toBe(true);
    expect(readOnlyFromControlMessage({ readOnly: false })).toBe(false);
    expect(readOnlyFromControlMessage({ readOnly: "true" })).toBeNull();
    expect(readOnlyFromControlMessage({})).toBeNull();
    expect(readOnlyFromControlMessage(null)).toBeNull();
  });
});
