import { useEffect, useRef } from "react";
import { actionForPadButton, type GameAction } from "./input";

/** How far the stick must move before it counts as a direction, not a wobble. */
const STICK_THRESHOLD = 0.6;
/** Held-direction repeat, matching a comfortable key-repeat rather than frame rate. */
const REPEAT_FIRST_MS = 420;
const REPEAT_NEXT_MS = 120;

const DIRECTIONS: GameAction[] = ["up", "down", "left", "right"];

/**
 * Turns a gamepad into the same actions a keyboard produces.
 *
 * Menus should not know which of the two they are being driven by; they get
 * "down" and "confirm" either way. Doing the translation here is what makes
 * "every menu is navigable with a pad" a property of the app rather than
 * something each screen has to remember to implement.
 *
 * Polls, because the Gamepad API has no events for button state. Runs only
 * while mounted, does nothing while the document is hidden, and allocates
 * nothing per frame when no pad is connected.
 */
export function useGamepadActions(onAction: (action: GameAction) => void, active = true): void {
  /* Through a ref so a changing handler does not restart the polling loop. */
  const handler = useRef(onAction);
  handler.current = onAction;

  useEffect(() => {
    if (!active) return;
    if (typeof navigator.getGamepads !== "function") return;

    let frame = 0;
    /* Which actions were held on the previous frame, to find the edges. */
    let previous = new Set<GameAction>();
    /* When a held direction is due to fire again. */
    const repeatAt = new Map<GameAction, number>();

    const poll = () => {
      frame = requestAnimationFrame(poll);
      if (document.hidden) return;

      const now = performance.now();
      /*
       * Gathered across every pad and every source first, then compared. The
       * d-pad and the left stick both produce "up", and two passes that each
       * set the held state would cancel each other out -- the pad would fire
       * "up" on every single frame, which reads as a menu that has gone mad.
       */
      const held = new Set<GameAction>();
      const pads = navigator.getGamepads?.() ?? [];

      for (const pad of pads) {
        if (!pad) continue;

        pad.buttons.forEach((button, index) => {
          if (!button.pressed) return;
          const action = actionForPadButton(index);
          if (action) held.add(action);
        });

        /* The left stick does what the d-pad does; players expect both. */
        const [x = 0, y = 0] = pad.axes;
        if (x < -STICK_THRESHOLD) held.add("left");
        if (x > STICK_THRESHOLD) held.add("right");
        if (y < -STICK_THRESHOLD) held.add("up");
        if (y > STICK_THRESHOLD) held.add("down");
      }

      /* Newly pressed fires immediately and arms the repeat. */
      for (const action of held) {
        if (!previous.has(action)) {
          handler.current(action);
          repeatAt.set(action, now + REPEAT_FIRST_MS);
        }
      }

      /*
       * Only directions repeat while held. A held confirm that fired every
       * 120ms would buy the whole shop, which is the sort of thing a player
       * discovers only once the gold has gone.
       */
      for (const action of DIRECTIONS) {
        if (!held.has(action)) {
          repeatAt.delete(action);
          continue;
        }
        const due = repeatAt.get(action);
        if (due !== undefined && now >= due) {
          handler.current(action);
          repeatAt.set(action, now + REPEAT_NEXT_MS);
        }
      }

      previous = held;
    };

    poll();
    return () => cancelAnimationFrame(frame);
  }, [active]);
}
