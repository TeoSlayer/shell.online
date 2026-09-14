import { describe, expect, it, vi } from "vitest";
import { bindRefstreamSessionPersistence } from "../web/refstream-session";
import type { SessionSnapshot } from "../web/vendor/refstream/v0.1.0-alpha.5/refstream.js";

function snapshot(sequence: number): SessionSnapshot {
  return { version: 1, sequence, terminal: {}, commands: [] };
}

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

class FakeSession {
  readonly signal = new AbortController().signal;
  current = snapshot(1);
  restored: SessionSnapshot | null = null;
  private listener: (() => void) | null = null;
  onChange(listener: () => void): { dispose(): void } {
    this.listener = listener;
    return { dispose: () => { this.listener = null; } };
  }
  snapshot(): SessionSnapshot { return this.current; }
  restore(value: SessionSnapshot): void { this.restored = value; this.current = value; }
  change(): void { this.listener?.(); }
}

describe("Refstream session persistence", () => {
  it("restores a recent snapshot and saves the latest state on dispose", () => {
    const storage = new MemoryStorage();
    const first = new FakeSession();
    const firstBinding = bindRefstreamSessionPersistence(first as never, "share/id", storage, () => 1_000);
    first.current = snapshot(7);
    firstBinding.dispose();

    const second = new FakeSession();
    const secondBinding = bindRefstreamSessionPersistence(second as never, "share/id", storage, () => 2_000);
    expect(second.restored?.sequence).toBe(7);
    secondBinding.dispose();
  });

  it("forgets expired snapshots instead of reviving stale handoffs", () => {
    const storage = new MemoryStorage();
    const first = new FakeSession();
    bindRefstreamSessionPersistence(first as never, "session", storage, () => 1).dispose();

    const second = new FakeSession();
    const fourHoursAndOneMillisecond = 4 * 60 * 60 * 1_000 + 2;
    const binding = bindRefstreamSessionPersistence(
      second as never,
      "session",
      storage,
      () => fourHoursAndOneMillisecond,
    );
    expect(second.restored).toBeNull();
    binding.dispose();
  });

  it("debounces output-heavy changes and never requires storage", () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const session = new FakeSession();
    const binding = bindRefstreamSessionPersistence(session as never, "busy", storage, () => 10);
    session.change();
    session.change();
    expect(storage.values.size).toBe(0);
    vi.advanceTimersByTime(750);
    expect(storage.values.size).toBe(1);
    binding.dispose();

    expect(() => bindRefstreamSessionPersistence(new FakeSession() as never, "private", null).dispose()).not.toThrow();
    const blocked = {
      getItem: () => { throw new DOMException("blocked"); },
      setItem: () => { throw new DOMException("blocked"); },
      removeItem: () => { throw new DOMException("blocked"); },
    };
    expect(() => bindRefstreamSessionPersistence(new FakeSession() as never, "blocked", blocked).dispose()).not.toThrow();
    vi.useRealTimers();
  });
});
