import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppearance, initializeAppearance, parseAppearance, setAppearance, subscribeAppearance } from "./appearance";

afterEach(() => vi.unstubAllGlobals());

function fixture(saved: string | null = null, blocked = false) {
  const window = new EventTarget();
  const media = Object.assign(new EventTarget(), { matches: false });
  Object.assign(window, { matchMedia: () => media });
  const dataset: Record<string, string> = {};
  const colors: string[] = [];
  const storage = { getItem: vi.fn(() => { if (blocked) throw Error(); return saved; }), setItem: vi.fn(), removeItem: vi.fn() };
  if (blocked) storage.setItem.mockImplementation(() => { throw Error(); });
  vi.stubGlobal("window", window);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", { documentElement: { dataset }, querySelectorAll: () => [{ setAttribute: (_: string, color: string) => colors.push(color) }] });
  return { window, media, dataset, colors, storage };
}

describe("appearance preference", () => {
  it("accepts only the three display choices", () => {
    expect(["light", "dark", "system", null, "unknown"].map(parseAppearance)).toEqual(["light", "dark", "system", "system", "system"]);
  });
  it("restores explicit light and ignores the system until reset", () => {
    const f = fixture("light"), stop = initializeAppearance();
    expect(f.dataset.theme).toBe("light");
    f.media.matches = true; f.media.dispatchEvent(new Event("change"));
    expect(f.colors.at(-1)).toBe("#f3f1e9");
    setAppearance("system");
    expect(f.dataset.theme).toBeUndefined();
    expect(f.colors.at(-1)).toBe("#161914");
    expect(f.storage.removeItem).toHaveBeenCalledWith("shell-online-app-theme");
    stop();
  });
  it("changes immediately without storage access", () => {
    const f = fixture(null, true), stop = initializeAppearance();
    const listener = vi.fn(), unsubscribe = subscribeAppearance(listener);
    setAppearance("dark");
    expect(getAppearance()).toBe("dark");
    expect(f.dataset.theme).toBe("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe(); stop();
  });
  it("synchronizes sibling tabs, including storage clear", () => {
    const f = fixture(), stop = initializeAppearance();
    const emit = (key: string | null, newValue: string | null) => f.window.dispatchEvent(Object.assign(new Event("storage"), { key, newValue }));
    emit("shell-online-app-theme", "dark");
    expect(f.dataset.theme).toBe("dark");
    emit("unrelated", "light"); expect(getAppearance()).toBe("dark");
    emit(null, null); expect(f.dataset.theme).toBeUndefined();
    stop();
    emit("shell-online-app-theme", "dark"); expect(getAppearance()).toBe("system");
  });
});
