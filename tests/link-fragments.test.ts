import { beforeEach, describe, expect, it } from "vitest";
import {
  completeShareUrl,
  forgetLinkFragment,
  linkFragmentFor,
  rememberLinkFragment,
} from "../web/link-fragments";

const SESSION = "A".repeat(32);
const SHARE = `https://shell.online/s/${SESSION}`;
const FRAGMENT = "#salt=BqA2LRaslN49B94GK9rn_w";

function installStorage(working = true): void {
  const map = new Map<string, string>();
  const storage = working
    ? {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      }
    : {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
        removeItem: () => { throw new Error("blocked"); },
      };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

describe("saving and reopening an encrypted share", () => {
  beforeEach(() => installStorage());

  it("rebuilds the full link, key included, on the browser that saved it", () => {
    rememberLinkFragment(SESSION, FRAGMENT);
    expect(completeShareUrl(SHARE, SESSION)).toBe(SHARE + FRAGMENT);
  });

  it("accepts a fragment with or without its leading hash", () => {
    rememberLinkFragment(SESSION, "salt=abc");
    expect(linkFragmentFor(SESSION)).toBe("#salt=abc");
  });

  it("returns the bare link on a browser that never saw the key", () => {
    expect(linkFragmentFor(SESSION)).toBe("");
    expect(completeShareUrl(SHARE, SESSION)).toBe(SHARE);
  });

  it("leaves an unencrypted share untouched", () => {
    expect(completeShareUrl(SHARE, SESSION)).toBe(SHARE);
  });

  it("never double-appends when the URL already carries a fragment", () => {
    rememberLinkFragment(SESSION, FRAGMENT);
    expect(completeShareUrl(SHARE + FRAGMENT, SESSION)).toBe(SHARE + FRAGMENT);
  });

  it("keeps fragments separate per session", () => {
    const other = "B".repeat(32);
    rememberLinkFragment(SESSION, "#salt=one");
    rememberLinkFragment(other, "#salt=two");
    expect(linkFragmentFor(SESSION)).toBe("#salt=one");
    expect(linkFragmentFor(other)).toBe("#salt=two");
  });

  it("drops the key when the link is removed", () => {
    rememberLinkFragment(SESSION, FRAGMENT);
    forgetLinkFragment(SESSION);
    expect(linkFragmentFor(SESSION)).toBe("");
  });

  it("stores nothing for a share that has no fragment", () => {
    rememberLinkFragment(SESSION, "");
    rememberLinkFragment(SESSION, "#");
    expect(linkFragmentFor(SESSION)).toBe("");
  });

  it("degrades quietly when storage is unavailable", () => {
    installStorage(false);
    expect(() => rememberLinkFragment(SESSION, FRAGMENT)).not.toThrow();
    expect(linkFragmentFor(SESSION)).toBe("");
    expect(completeShareUrl(SHARE, SESSION)).toBe(SHARE);
  });
});
