import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptOrigin, forget, forgetAll, passwordFor, rememberForOrigin, setPasswordOwner,
} from "./session-passwords";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: fakeStorage() });
  setPasswordOwner("uid-1");
});

describe("remembering a password for a session this browser started", () => {
  it("moves from the request to the session that appears", () => {
    rememberForOrigin("cmd_1", "Kw9eHbru");
    expect(passwordFor("sess_1")).toBeNull();

    adoptOrigin("cmd_1", "sess_1");
    expect(passwordFor("sess_1")).toBe("Kw9eHbru");
  });

  it("adopts only once, so a later session cannot claim the same password", () => {
    rememberForOrigin("cmd_1", "Kw9eHbru");
    adoptOrigin("cmd_1", "sess_1");
    adoptOrigin("cmd_1", "sess_2");
    expect(passwordFor("sess_1")).toBe("Kw9eHbru");
    expect(passwordFor("sess_2")).toBeNull();
  });

  it("knows nothing about a session started from a terminal", () => {
    /* Those still prompt, because this browser never chose their password. */
    expect(passwordFor("sess_elsewhere")).toBeNull();
    adoptOrigin(undefined, "sess_elsewhere");
    expect(passwordFor("sess_elsewhere")).toBeNull();
  });

  it("forgets a password that no longer works", () => {
    rememberForOrigin("cmd_1", "wrong");
    adoptOrigin("cmd_1", "sess_1");
    forget("sess_1");
    expect(passwordFor("sess_1")).toBeNull();
  });

  it("ignores empty inputs rather than storing junk", () => {
    rememberForOrigin("", "pw");
    rememberForOrigin("cmd", "");
    adoptOrigin("cmd_missing", "sess_x");
    expect(passwordFor("sess_x")).toBeNull();
  });

  it("survives storage being unavailable", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem() { throw new Error("blocked"); },
        setItem() { throw new Error("blocked"); },
        removeItem() { throw new Error("blocked"); },
      } as unknown as Storage,
    });
    /* A private window should degrade to prompting, not to a crash. */
    expect(() => rememberForOrigin("cmd_1", "pw")).not.toThrow();
    expect(passwordFor("sess_1")).toBeNull();
  });

  it("keeps the store bounded", () => {
    for (let i = 0; i < 80; i += 1) rememberForOrigin(`cmd_${i}`, `pw_${i}`);
    adoptOrigin("cmd_79", "sess_79");
    expect(passwordFor("sess_79")).toBe("pw_79");
    /* The oldest are dropped, so a long-lived browser does not grow forever. */
    adoptOrigin("cmd_0", "sess_0");
    expect(passwordFor("sess_0")).toBeNull();
  });
});

describe("passwords belong to one account", () => {
  it("does not hand a password to whoever signs in next on the same computer", () => {
    /* This is what let a colleague read a session nobody had shared with them. */
    setPasswordOwner("uid-1");
    rememberForOrigin("cmd_1", "Kw9eHbru");
    adoptOrigin("cmd_1", "sess_1");
    expect(passwordFor("sess_1")).toBe("Kw9eHbru");

    setPasswordOwner("uid-2");
    expect(passwordFor("sess_1")).toBeNull();

    setPasswordOwner("uid-1");
    expect(passwordFor("sess_1")).toBe("Kw9eHbru");
  });

  it("keeps two accounts' passwords for one session apart", () => {
    setPasswordOwner("uid-1");
    rememberForOrigin("cmd_1", "first");
    adoptOrigin("cmd_1", "sess_1");

    setPasswordOwner("uid-2");
    rememberForOrigin("cmd_2", "second");
    adoptOrigin("cmd_2", "sess_1");
    expect(passwordFor("sess_1")).toBe("second");

    setPasswordOwner("uid-1");
    expect(passwordFor("sess_1")).toBe("first");
  });

  it("forgets everything on sign out", () => {
    setPasswordOwner("uid-1");
    rememberForOrigin("cmd_1", "Kw9eHbru");
    adoptOrigin("cmd_1", "sess_1");
    forgetAll();
    expect(passwordFor("sess_1")).toBeNull();
  });

  it("forgets one session without touching the rest", () => {
    setPasswordOwner("uid-1");
    rememberForOrigin("cmd_1", "a");
    adoptOrigin("cmd_1", "sess_1");
    rememberForOrigin("cmd_2", "b");
    adoptOrigin("cmd_2", "sess_2");
    forget("sess_1");
    expect(passwordFor("sess_1")).toBeNull();
    expect(passwordFor("sess_2")).toBe("b");
  });
});
