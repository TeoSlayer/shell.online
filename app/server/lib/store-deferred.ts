import type { Store } from "./store";

/**
 * Wraps a store so every call resolves on a later turn of the event loop.
 *
 * The in-memory store does its work synchronously and returns an already
 * settled promise, so a caller that forgets to `await` a write still sees it
 * land. Postgres does not: the response goes out before the row exists, and a
 * failed insert is an unhandled rejection rather than an error.
 *
 * Running the route tests through this makes that difference visible where it
 * is cheap to find. It caught `issueTokens` returning CLI credentials before
 * the device row was written.
 */
export function deferred(inner: Store): Store {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as Store;
}
