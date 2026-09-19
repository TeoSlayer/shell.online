import { describe, expect, it } from "vitest";
import {
  DEVICE_SWITCH_GRACE_MS,
  actionForKey,
  actionForPadButton,
  deviceForGamepad,
  promptFor,
  promptLabel,
  shouldSwitchDevice,
  type GameAction,
  type InputDevice,
} from "./input";

const DEVICES: InputDevice[] = ["keyboard", "xbox", "playstation", "nintendo", "touch"];
const ACTIONS: GameAction[] = [
  "confirm", "cancel", "pause", "inspect",
  "up", "down", "left", "right", "tabPrev", "tabNext",
];

describe("naming the button", () => {
  it("has a name for every action on every device", () => {
    /*
     * The point of the whole module: no combination may come back empty, or a
     * prompt somewhere reads "Press  to muster".
     */
    for (const device of DEVICES) {
      for (const action of ACTIONS) {
        expect(promptFor(action, device)).toBeTruthy();
      }
    }
  });

  it("names the button each platform actually has", () => {
    expect(promptFor("confirm", "playstation")).toBe("✕");
    expect(promptFor("cancel", "playstation")).toBe("◯");
    expect(promptFor("confirm", "xbox")).toBe("A");
    expect(promptFor("confirm", "keyboard")).toBe("Enter");
  });

  it("never tells a touch player to press anything", () => {
    expect(promptLabel("confirm", "touch", "muster")).toBe("Tap to muster");
    expect(promptLabel("confirm", "touch", "muster")).not.toContain("Press");
  });

  it("puts the verb after the button, so the sentence reads", () => {
    expect(promptLabel("confirm", "xbox", "muster")).toBe("Press A to muster");
  });
});

describe("recognising a pad", () => {
  it("reads the vendor out of the id", () => {
    expect(deviceForGamepad("Wireless Controller (STANDARD GAMEPAD Vendor: 054c)")).toBe("xbox");
    expect(deviceForGamepad("DualSense Wireless Controller")).toBe("playstation");
    expect(deviceForGamepad("Xbox Wireless Controller")).toBe("xbox");
    expect(deviceForGamepad("Pro Controller (Nintendo)")).toBe("nintendo");
  });

  it("guesses the commonest layout for a pad it does not know", () => {
    /*
     * Better than refusing to show a prompt at all: confirm and cancel are in
     * the same two physical places on almost everything.
     */
    expect(deviceForGamepad("Generic USB Joystick")).toBe("xbox");
    expect(deviceForGamepad("")).toBe("xbox");
  });
});

describe("switching between devices", () => {
  it("ignores an input from the device already in use", () => {
    expect(shouldSwitchDevice("xbox", "xbox", 10_000)).toBe(false);
  });

  it("refuses a switch while the current device is still being used", () => {
    /* A mouse brushed on the desk should not relabel a pad player's screen. */
    expect(shouldSwitchDevice("xbox", "keyboard", 10)).toBe(false);
  });

  it("switches once the old device has gone quiet", () => {
    expect(shouldSwitchDevice("xbox", "keyboard", DEVICE_SWITCH_GRACE_MS)).toBe(true);
  });
});

describe("what a press means", () => {
  it("maps the keys a menu needs", () => {
    expect(actionForKey("Enter")).toBe("confirm");
    expect(actionForKey(" ")).toBe("confirm");
    expect(actionForKey("Escape")).toBe("cancel");
    expect(actionForKey("ArrowDown")).toBe("down");
  });

  it("ignores a key that is not bound", () => {
    expect(actionForKey("F7")).toBeUndefined();
    expect(actionForKey("z")).toBeUndefined();
  });

  it("maps the standard pad buttons, and nothing beyond them", () => {
    expect(actionForPadButton(0)).toBe("confirm");
    expect(actionForPadButton(1)).toBe("cancel");
    expect(actionForPadButton(9)).toBe("pause");
    expect(actionForPadButton(13)).toBe("down");
    expect(actionForPadButton(17)).toBeUndefined();
  });
});
