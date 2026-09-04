import { describe, expect, it } from "vitest";
import { mobileTerminalKeyBytes, terminalKeyAction } from "../web/terminal-keyboard";

const key = (value: string, ctrlKey = false, metaKey = false, keyCode = 0) =>
  ({ key: value, ctrlKey, metaKey, keyCode });

describe("mobile and browser terminal keyboard handling", () => {
  it("encodes the mobile TUI key deck", () => {
    expect([...mobileTerminalKeyBytes("escape")!]).toEqual([27]);
    expect([...mobileTerminalKeyBytes("tab")!]).toEqual([9]);
    expect([...mobileTerminalKeyBytes("left")!]).toEqual([27, 91, 68]);
    expect([...mobileTerminalKeyBytes("up")!]).toEqual([27, 91, 65]);
    expect([...mobileTerminalKeyBytes("down")!]).toEqual([27, 91, 66]);
    expect([...mobileTerminalKeyBytes("right")!]).toEqual([27, 91, 67]);
    expect([...mobileTerminalKeyBytes("enter")!]).toEqual([13]);
    expect([...mobileTerminalKeyBytes("interrupt")!]).toEqual([3]);
    expect(mobileTerminalKeyBytes("unknown")).toBeNull();
  });

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

  it("lets xterm emit Ctrl-D through the guarded byte-stream path", () => {
    expect(terminalKeyAction(key("d", true), false).kind).toBe("default");
    expect(terminalKeyAction(key("d", false, true), false).kind).toBe("default");
  });
});
