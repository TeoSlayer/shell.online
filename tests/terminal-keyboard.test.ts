import { describe, expect, it } from "vitest";
import { terminalKeyAction } from "../web/terminal-keyboard";

const key = (value: string, ctrlKey = false, metaKey = false, keyCode = 0) =>
  ({ key: value, ctrlKey, metaKey, keyCode });

describe("mobile and browser terminal keyboard handling", () => {
  it("copies selected terminal text instead of sending Ctrl-C", () => {
    expect(terminalKeyAction(key("c", true), true).kind).toBe("copy-selection");
    expect(terminalKeyAction(key("c", false, true), true).kind).toBe("copy-selection");
  });

  it("repairs the iOS hardware-keyboard Ctrl-C anomaly", () => {
    const action = terminalKeyAction(key("c", true, false, 13), false);
    expect(action.kind).toBe("send");
    if (action.kind === "send") expect([...action.bytes]).toEqual([3]);
  });

  it("sends terminal Ctrl-W when the browser delivers it", () => {
    const action = terminalKeyAction(key("w", true), false);
    expect(action.kind).toBe("send");
    if (action.kind === "send") expect([...action.bytes]).toEqual([23]);
    expect(terminalKeyAction(key("w", false, true), false).kind).toBe("default");
  });
});
