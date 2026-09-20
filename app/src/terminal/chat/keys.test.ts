import { describe, expect, it } from "vitest";
import { KEY_CHIPS, bytesForKey, chipsFor } from "./keys";

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

describe("the control keys offered as buttons", () => {
  it("sends the same bytes the keyboard would", () => {
    const chip = (label: string) => KEY_CHIPS.find((entry) => entry.label === label)?.bytes;
    expect(chip("Ctrl-C")).toBe(bytesForKey({ key: "c", ctrlKey: true }));
    expect(chip("Tab")).toBe(bytesForKey({ key: "Tab" }));
    expect(chip("Esc")).toBe(bytesForKey({ key: "Escape" }));
    expect(chip("↑")).toBe(bytesForKey({ key: "ArrowUp" }));
  });
});

describe("which control keys are offered", () => {
  it("offers the shell's signals while the composer writes lines", () => {
    expect(chipsFor(false).map((chip) => chip.label)).toEqual(["Ctrl-C", "Ctrl-D", "Esc"]);
  });

  it("offers the keys a full-screen program reads once one is running", () => {
    expect(chipsFor(true).map((chip) => chip.label)).toEqual(["Ctrl-C", "Esc", "Tab", "Enter", "↑", "↓"]);
  });

  /*
   * The arrows walk the shell's own history, which lands on the prompt row --
   * the one row a conversation never shows. Offering them while composing
   * would move a line nobody can see, and the next thing sent would overwrite
   * it. The composer's own Up and Down walk the thread instead.
   */
  it("keeps the arrows out of line mode, where their result would be invisible", () => {
    expect(chipsFor(false).some((chip) => chip.label === "↑")).toBe(false);
    expect(chipsFor(false).some((chip) => chip.label === "Tab")).toBe(false);
  });
});
