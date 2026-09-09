import { useCallback, useRef, useState } from "react";

/**
 * Copying, for browsers that do not all agree what copying is.
 *
 * Every copy button in this app used to be `await navigator.clipboard
 * .writeText(...)` inside a `try` whose `catch` was empty. On a phone that is
 * the whole bug: the promise rejects with NotAllowedError often enough
 * (Safari drops the user gesture the moment anything is awaited before the
 * write, a home-screen window can be denied the permission outright, an
 * embedded browser may not ship the API at all) and a swallowed rejection
 * looks exactly like a copy that worked. Nothing moves, nothing is said, and
 * the link is not on the clipboard.
 *
 * So: try the modern API, fall back to the selection-and-execCommand trick
 * that predates it, and report which of the three things happened rather than
 * leaving the button to imply success.
 */

/** The last-resort path. Deprecated, still the only thing WebKit always allows. */
function copyBySelection(value: string): boolean {
  const field = document.createElement("textarea");
  field.value = value;
  /*
   * readonly rather than disabled: iOS refuses to select inside a disabled
   * field, and a focused editable one summons the keyboard mid-copy.
   */
  field.setAttribute("readonly", "");
  field.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;";
  document.body.append(field);

  const previous = document.activeElement;
  try {
    field.select();
    /* iOS ignores select() on a readonly field; the explicit range is what works. */
    field.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}

/**
 * Puts `value` on the clipboard. Resolves to whether it got there.
 *
 * Call this straight out of the click handler with the text already in hand.
 * Anything awaited first spends the gesture, and WebKit will not write to the
 * clipboard once it is gone.
 */
export async function copyText(value: string): Promise<boolean> {
  if (!value) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      /* denied, or the gesture is spent: the older path may still be allowed */
    }
  }

  return copyBySelection(value);
}

export type CopyState = "idle" | "copied" | "failed";

/**
 * The state a copy button needs: which of its items was copied, or that the
 * copy failed, cleared after a moment.
 *
 * `key` distinguishes several buttons sharing one hook, which the session
 * clipboard menu does. A lone button can ignore it and read `state`.
 */
export function useCopy<Key extends string = string>() {
  const [state, setState] = useState<CopyState>("idle");
  const [key, setKey] = useState<Key | null>(null);
  const timer = useRef(0);

  const copy = useCallback(async (value: string | null, forKey?: Key) => {
    const ok = value ? await copyText(value) : false;
    window.clearTimeout(timer.current);
    setState(ok ? "copied" : "failed");
    setKey(forKey ?? null);
    /* Failure is worth reading twice as long, since it asks for a decision. */
    timer.current = window.setTimeout(() => {
      setState("idle");
      setKey(null);
    }, ok ? 1600 : 3600);
    return ok;
  }, []);

  const copiedKey = state === "copied" ? key : null;
  const failedKey = state === "failed" ? key : null;

  return { state, key, copiedKey, failedKey, copy };
}

/** What to tell someone whose clipboard the browser would not write to. */
export const COPY_FAILED = "The browser would not copy that. Select it and copy by hand.";
