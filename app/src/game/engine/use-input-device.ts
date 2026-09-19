import { useEffect, useRef, useState } from "react";
import {
  deviceForGamepad,
  shouldSwitchDevice,
  type InputDevice,
} from "./input";

/**
 * Which device the player is using right now.
 *
 * Listens rather than asks: there is no way to enquire what somebody is
 * holding, only to notice what they last touched. A pad that is connected but
 * resting should not win over the keyboard being typed on, so connection alone
 * does not count -- a button has to move.
 */
export function useInputDevice(initial?: InputDevice): InputDevice {
  /*
   * A coarse pointer is a finger, and the first thing the interface says on a
   * handset should not be the name of a key it does not have. Guessed from the
   * device rather than assumed, and corrected the moment anything is actually
   * used -- which is what the rest of this hook is for.
   */
  const [device, setDevice] = useState<InputDevice>(
    () =>
      initial ??
      (window.matchMedia?.("(pointer: coarse)").matches ? "touch" : "keyboard"),
  );
  /* When the current device was last used, for the anti-flapping grace. */
  const lastUsed = useRef(0);
  const currentRef = useRef(device);
  currentRef.current = device;

  useEffect(() => {
    const now = () => performance.now();
    lastUsed.current = now();

    const offer = (next: InputDevice) => {
      const elapsed = now() - lastUsed.current;
      if (currentRef.current === next) {
        lastUsed.current = now();
        return;
      }
      if (!shouldSwitchDevice(currentRef.current, next, elapsed)) return;
      lastUsed.current = now();
      setDevice(next);
    };

    const onKey = () => offer("keyboard");
    const onPointer = (event: PointerEvent) => {
      offer(event.pointerType === "touch" || event.pointerType === "pen" ? "touch" : "keyboard");
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);

    /*
     * Pads do not raise events. The only way to know a button moved is to look,
     * so this polls -- but only while the game is mounted and visible, and only
     * at a rate a menu needs. The game loop polls its own copy at frame rate
     * for actual play; this is just for keeping the prompts honest.
     */
    let frame = 0;
    const pressed = new Map<number, boolean>();
    const poll = () => {
      frame = window.setTimeout(poll, 120);
      const pads = navigator.getGamepads?.() ?? [];
      for (const pad of pads) {
        if (!pad) continue;
        let moved = false;
        pad.buttons.forEach((button, index) => {
          const was = pressed.get(index) ?? false;
          if (button.pressed && !was) moved = true;
          pressed.set(index, button.pressed);
        });
        if (pad.axes.some((axis) => Math.abs(axis) > 0.5)) moved = true;
        if (moved) offer(deviceForGamepad(pad.id));
      }
    };
    poll();

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      window.clearTimeout(frame);
    };
  }, []);

  return device;
}
