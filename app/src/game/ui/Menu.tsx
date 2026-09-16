import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { actionForKey, type GameAction } from "../engine/input";
import { firstEnabled, nextIndex, restoreIndex } from "../engine/menu";
import { useGamepadActions } from "../engine/use-gamepad";

export interface MenuItem {
  id: string;
  label: string;
  /** A second line, for what the choice costs or what it will do. */
  detail?: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Draws it as the way out, and never as the item focus lands on first. */
  danger?: boolean;
  onSelect: () => void;
}

/**
 * A vertical menu that a keyboard, a pad and a thumb can all drive.
 *
 * Real `<button>` elements with real DOM focus, rather than a painted
 * selection: a menu whose "selected" item is only a CSS class is invisible to
 * a screen reader and unreachable by Tab, and every menu in the keep has to be
 * reachable by all three. The pad drives it by moving that same focus, so
 * there is one notion of where you are, not two that can disagree.
 */
export function Menu({
  items,
  label,
  onCancel,
  /* Remembered by the caller, so returning to a menu returns you to your place. */
  initialIndex = 0,
  onIndexChange,
}: {
  items: MenuItem[];
  label: string;
  onCancel?: () => void;
  initialIndex?: number;
  onIndexChange?: (index: number) => void;
}) {
  const enabled = items.map((item) => !item.disabled);
  const list = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [index, setIndex] = useState(() =>
    initialIndex > 0 ? restoreIndex(initialIndex, enabled) : firstEnabled(enabled),
  );

  const focusAt = useCallback(
    (next: number) => {
      setIndex(next);
      onIndexChange?.(next);
      buttons.current[next]?.focus();
    },
    [onIndexChange],
  );

  /* Opening a menu puts focus in it, or a pad has nothing to move. */
  useEffect(() => {
    buttons.current[index]?.focus();
    /* Once, on open: later focus moves are driven by input, not by this. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(
    (action: GameAction) => {
      switch (action) {
        case "up":
          focusAt(nextIndex(index, -1, enabled));
          return;
        case "down":
          focusAt(nextIndex(index, 1, enabled));
          return;
        case "confirm": {
          const item = items[index];
          if (item && !item.disabled) item.onSelect();
          return;
        }
        case "cancel":
        case "pause":
          onCancel?.();
          return;
        default:
      }
    },
    [enabled, focusAt, index, items, onCancel],
  );

  useGamepadActions(run);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const action = actionForKey(event.key);
    /*
     * Enter and Space are left to the button itself: the browser already
     * turns them into a click, and handling them here as well fired the
     * selection twice.
     */
    if (!action || action === "confirm") return;
    event.preventDefault();
    run(action);
  };

  return (
    <div
      className="keep-menu"
      role="menu"
      aria-label={label}
      ref={list}
      onKeyDown={onKeyDown}
    >
      {items.map((item, position) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          ref={(element) => {
            buttons.current[position] = element;
          }}
          className={[
            "keep-menu-item",
            item.danger ? "is-danger" : "",
            position === index ? "is-current" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          disabled={item.disabled}
          /*
           * One stop for the whole menu. Tabbing through eight options to
           * reach the one after it is not navigation, it is a queue; arrows
           * and the pad move within, Tab moves past.
           */
          tabIndex={position === index ? 0 : -1}
          onFocus={() => {
            setIndex(position);
            onIndexChange?.(position);
          }}
          onClick={item.onSelect}
        >
          {item.icon && <span className="keep-menu-icon" aria-hidden="true">{item.icon}</span>}
          <span className="keep-menu-text">
            <span className="keep-menu-label">{item.label}</span>
            {item.detail && <span className="keep-menu-detail">{item.detail}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
