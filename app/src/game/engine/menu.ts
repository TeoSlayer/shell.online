/**
 * Menu navigation that a pad can actually drive.
 *
 * The rule the skill is emphatic about is that every interactive element must
 * be reachable and nothing may trap focus. That is mostly index arithmetic, so
 * it lives here as pure functions: a dead end is a bug you want a test to
 * catch, not one you want to find by picking up a controller.
 */

/**
 * The next selectable index in a direction, wrapping at the ends.
 *
 * Wrapping matters more than it sounds: without it the last item is a wall,
 * and on a pad a wall reads as the menu having stopped responding. Disabled
 * items are stepped over rather than landed on, so a greyed-out purchase never
 * swallows the stick.
 *
 * Returns the current index when nothing is selectable, which is the only
 * honest answer and keeps the caller from looping forever.
 */
export function nextIndex(current: number, delta: number, enabled: boolean[]): number {
  const count = enabled.length;
  if (count === 0) return current;
  if (!enabled.some(Boolean)) return current;

  let index = current;
  for (let step = 0; step < count; step += 1) {
    index = (index + delta + count) % count;
    if (enabled[index]) return index;
  }
  return current;
}

/** The first thing a menu should land on when it opens. */
export function firstEnabled(enabled: boolean[]): number {
  const index = enabled.findIndex(Boolean);
  return index === -1 ? 0 : index;
}

/**
 * Keeps a remembered position usable after the menu behind it has changed.
 *
 * Coming back to a menu should put you where you were -- but "where you were"
 * may since have been removed, or become unaffordable and therefore disabled.
 * Clamping and then re-seeking is what stops a remembered index from selecting
 * nothing at all.
 */
export function restoreIndex(remembered: number, enabled: boolean[]): number {
  if (enabled.length === 0) return 0;
  const clamped = Math.min(Math.max(remembered, 0), enabled.length - 1);
  if (enabled[clamped]) return clamped;
  return nextIndex(clamped, 1, enabled);
}
