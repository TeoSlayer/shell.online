import { describe, expect, it } from "vitest";
import { sessionEnded, sessionOnline, sessionStateLabel } from "./session-liveness";

describe("session liveness presentation", () => {
  it("keeps a disconnected session reopenable without calling it online", () => {
    const session = { relayStatus: "disconnected" as const };
    expect(sessionEnded(session)).toBe(false);
    expect(sessionOnline(session)).toBe(false);
    expect(sessionStateLabel(session)).toBe("Offline");
  });

  it("treats exited and missing relay sessions as ended", () => {
    for (const relayStatus of ["exited", "missing"] as const) {
      expect(sessionEnded({ relayStatus })).toBe(true);
      expect(sessionOnline({ relayStatus })).toBe(false);
    }
  });

  it("does not turn a failed liveness check into a false process exit", () => {
    const session = { relayStatus: "unknown" as const };
    expect(sessionEnded(session)).toBe(false);
    expect(sessionStateLabel(session)).toBe("Status unavailable");
  });
});
