import { describe, expect, it } from "vitest";
import { bytesForKey } from "./keys";

describe("a key pressed while a program is reading keys", () => {
  it("sends the character itself", () => {
    expect(bytesForKey({ key: "a" })).toBe("a");
    expect(bytesForKey({ key: "€" })).toBe("€");
  });

  it("sends the control code for a control combination", () => {
    expect(bytesForKey({ key: "c", ctrlKey: true })).toBe("\x03");
    expect(bytesForKey({ key: "D", ctrlKey: true })).toBe("\x04");
    expect(bytesForKey({ key: "[", ctrlKey: true })).toBe("\x1b");
  });

  it("sends the editing keys a terminal expects", () => {
    expect(bytesForKey({ key: "Enter" })).toBe("\r");
    expect(bytesForKey({ key: "Backspace" })).toBe("\x7f");
    expect(bytesForKey({ key: "Tab" })).toBe("\t");
    expect(bytesForKey({ key: "Delete" })).toBe("\x1b[3~");
  });

  it("follows the program's cursor mode, because the two forms are not interchangeable", () => {
    expect(bytesForKey({ key: "ArrowUp" })).toBe("\x1b[A");
    expect(bytesForKey({ key: "ArrowUp" }, true)).toBe("\x1bOA");
  });

  it("sends Alt as the escape prefix terminals read as Meta", () => {
    expect(bytesForKey({ key: "f", altKey: true })).toBe("\x1bf");
    expect(bytesForKey({ key: "Backspace", altKey: true })).toBe("\x1b\x7f");
  });

  it("leaves the platform shortcuts to the browser, so output can still be copied", () => {
    expect(bytesForKey({ key: "c", metaKey: true })).toBeNull();
    expect(bytesForKey({ key: "v", metaKey: true })).toBeNull();
  });

  it("guesses at nothing it does not know", () => {
    expect(bytesForKey({ key: "Shift" })).toBeNull();
    expect(bytesForKey({ key: "AudioVolumeUp" })).toBeNull();
  });
});
