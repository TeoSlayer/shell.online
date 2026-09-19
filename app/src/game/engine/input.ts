/**
 * What the player can ask for, and what to call the button that asks for it.
 *
 * Nothing in the game writes "Press A". It writes `promptFor("confirm", device)`
 * and gets back whatever that player's hardware actually has, because "Press A"
 * is wrong for a PlayStation pad, wrong for a keyboard, wrong for a phone, and
 * wrong for anybody who has rebound it. Showing a button somebody does not have
 * is how a tutorial becomes unfollowable.
 *
 * The device is whichever one was used last. Games that pick a device at launch
 * and keep it get this wrong the moment somebody puts the pad down.
 */

export type GameAction =
  | "confirm"
  | "cancel"
  | "pause"
  | "inspect"
  | "up"
  | "down"
  | "left"
  | "right"
  | "tabPrev"
  | "tabNext";

export type InputDevice = "keyboard" | "xbox" | "playstation" | "nintendo" | "touch";

/** The default binding per device. Rebinding replaces the entry, not the call site. */
const BINDINGS: Record<InputDevice, Record<GameAction, string>> = {
  keyboard: {
    confirm: "Enter",
    cancel: "Esc",
    pause: "Esc",
    inspect: "Shift",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    tabPrev: "Q",
    tabNext: "E",
  },
  xbox: {
    confirm: "A",
    cancel: "B",
    pause: "Menu",
    inspect: "Y",
    up: "D-pad ↑",
    down: "D-pad ↓",
    left: "D-pad ←",
    right: "D-pad →",
    tabPrev: "LB",
    tabNext: "RB",
  },
  playstation: {
    confirm: "✕",
    cancel: "◯",
    pause: "Options",
    inspect: "△",
    up: "D-pad ↑",
    down: "D-pad ↓",
    left: "D-pad ←",
    right: "D-pad →",
    tabPrev: "L1",
    tabNext: "R1",
  },
  nintendo: {
    confirm: "A",
    cancel: "B",
    pause: "+",
    inspect: "X",
    up: "D-pad ↑",
    down: "D-pad ↓",
    left: "D-pad ←",
    right: "D-pad →",
    tabPrev: "L",
    tabNext: "R",
  },
  touch: {
    confirm: "Tap",
    cancel: "Back",
    pause: "Pause",
    inspect: "Hold",
    up: "Swipe up",
    down: "Swipe down",
    left: "Swipe left",
    right: "Swipe right",
    tabPrev: "Swipe left",
    tabNext: "Swipe right",
  },
};

/** What to call the button for an action on the device in the player's hands. */
export function promptFor(action: GameAction, device: InputDevice): string {
  return BINDINGS[device][action];
}

/**
 * A whole prompt, verb first.
 *
 * "Press Enter to muster" reads better to somebody who has never played this
 * than "Enter — muster", and a new player is the only one who needs it.
 */
export function promptLabel(action: GameAction, device: InputDevice, verb: string): string {
  const button = promptFor(action, device);
  if (device === "touch") return `${button} to ${verb}`;
  return `Press ${button} to ${verb}`;
}

/**
 * Which pad this is, from the id the browser reports.
 *
 * Gamepad ids are vendor strings with no schema, so this is a best guess that
 * falls back to the most common layout rather than to nothing. Guessing Xbox
 * for an unknown pad is right far more often than it is wrong, and the labels
 * for confirm and cancel are in the same physical places either way.
 */
export function deviceForGamepad(id: string): InputDevice {
  const lower = id.toLowerCase();
  if (/playstation|dualshock|dualsense|sony|\bps[345]\b/.test(lower)) return "playstation";
  if (/nintendo|switch|joy-con|joycon|pro controller/.test(lower)) return "nintendo";
  return "xbox";
}

/**
 * How long a device stays "current" after it was used.
 *
 * A mouse that brushes the desk while a pad is held should not flip every
 * prompt on screen for one frame, so a switch has to be deliberate: the new
 * device wins only once the old one has been quiet this long.
 */
export const DEVICE_SWITCH_GRACE_MS = 400;

/**
 * Whether an input from `next` should take over from `current`.
 *
 * Pure, so the flapping rule is testable without wiring up real hardware.
 */
export function shouldSwitchDevice(
  current: InputDevice,
  next: InputDevice,
  msSinceCurrentUsed: number,
): boolean {
  if (current === next) return false;
  return msSinceCurrentUsed >= DEVICE_SWITCH_GRACE_MS;
}

/** Standard gamepad button indices, named so the mapping below reads. */
const PAD_BUTTON: Partial<Record<number, GameAction>> = {
  0: "confirm",
  1: "cancel",
  3: "inspect",
  4: "tabPrev",
  5: "tabNext",
  9: "pause",
  12: "up",
  13: "down",
  14: "left",
  15: "right",
};

export function actionForPadButton(index: number): GameAction | undefined {
  return PAD_BUTTON[index];
}

/**
 * The action a key press means, or nothing when the key is not bound.
 *
 * Escape is both cancel and pause; which one it is depends on whether anything
 * is open to cancel, and that is the caller's question rather than this one's.
 */
export function actionForKey(key: string): GameAction | undefined {
  switch (key) {
    case "Enter":
    case " ":
      return "confirm";
    case "Escape":
      return "cancel";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "q":
    case "Q":
      return "tabPrev";
    case "e":
    case "E":
      return "tabNext";
    default:
      return undefined;
  }
}
