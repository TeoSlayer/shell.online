import { describe, expect, it, vi } from "vitest";
import { attachRefstreamTools } from "../web/refstream-tools";
import { purgeLegacyRefstreamSessionCaches } from "../web/refstream-session";
import {
  getTerminalSession,
  Terminal,
  type TerminalSession,
} from "../web/vendor/refstream/v0.1.0-alpha.5/refstream.js";
import { attachTerminalTools as attachToolsImpl } from "../web/vendor/refstream/v0.1.0-alpha.5/ui.js";

vi.mock("../web/vendor/refstream/v0.1.0-alpha.5/ui.js", () => ({
  attachTerminalTools: vi.fn(async () => ({ dispose: () => {} })),
}));

const attachTools = vi.mocked(attachToolsImpl);

const TERMINAL_SECRET = "TOP-SECRET-TERMINAL-OUTPUT";
const PREFIX = "shell-online-refstream-session:";

class MemoryStorage {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.writes.push(value); this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function legacySnapshotValue(): string {
  return JSON.stringify({
    version: 1,
    savedAt: 1,
    snapshot: {
      version: 1,
      sequence: 7,
      terminal: { output: TERMINAL_SECRET },
      commands: [],
      tasks: [],
      input: { revision: 0, owner: "unknown" },
    },
  });
}

interface CoreLike {
  serialize(): unknown;
  restore(state: unknown): void;
}

function fakeTerminal(): { terminal: unknown; write(data: string): void } {
  const term = new Terminal({ cols: 80, rows: 24 });
  const core = (term as unknown as { core: CoreLike }).core;
  const terminal = {
    signal: new AbortController().signal,
    core,
    onInput: () => ({ dispose: () => {} }),
    serialize: () => ({ model: core.serialize() }),
    restore: (state: { model: unknown }) => core.restore(state.model),
  };
  return { terminal, write: (data: string) => term.write(data) };
}

function toolsOptions(terminal: unknown) {
  return {
    terminal,
    toolbar: {} as HTMLElement,
    overlay: {} as HTMLElement,
  };
}

describe("Refstream session caches", () => {
  it("purges only legacy Refstream cache keys and leaves unrelated storage untouched", () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    session.values.set(`${PREFIX}share%2Fid`, legacySnapshotValue());
    local.values.set(`${PREFIX}other`, legacySnapshotValue());
    session.values.set("shell-online-refstream-notice", "1");
    session.values.set("shell-online-vault:account", "vault-secret");
    session.values.set("shell-online-refstream-session", "no-colon");
    session.values.set(`x${PREFIX}other-owner`, "not ours");
    local.values.set("shell-online-terminal-theme", "dark");
    local.values.set("shell-online-terminal-zoom", "110");
    local.values.set("unrelated:key", "value");

    purgeLegacyRefstreamSessionCaches({ sessionStorage: session, localStorage: local });

    expect([...session.values.keys()]).toEqual([
      "shell-online-refstream-notice",
      "shell-online-vault:account",
      "shell-online-refstream-session",
      `x${PREFIX}other-owner`,
    ]);
    expect([...local.values.keys()]).toEqual([
      "shell-online-terminal-theme",
      "shell-online-terminal-zoom",
      "unrelated:key",
    ]);
  });

  it("survives unavailable or throwing browser storage", () => {
    const blocked = (): never => { throw new DOMException("blocked"); };
    const throwing = {
      get length(): number { return blocked(); },
      key: blocked,
      removeItem: blocked,
    };
    const flaky = new MemoryStorage();
    flaky.values.set(`${PREFIX}kept`, "unremovable");
    const flakyStorage = {
      get length() { return flaky.length; },
      key: (index: number) => flaky.key(index),
      removeItem: blocked,
    };

    expect(() => purgeLegacyRefstreamSessionCaches({ sessionStorage: throwing, localStorage: throwing })).not.toThrow();
    expect(() => purgeLegacyRefstreamSessionCaches({ sessionStorage: null, localStorage: undefined })).not.toThrow();
    expect(() => purgeLegacyRefstreamSessionCaches({ sessionStorage: flakyStorage, localStorage: null })).not.toThrow();
  });

  it("writes no terminal content to any browser storage while a session is live", async () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    vi.stubGlobal("sessionStorage", session);
    vi.stubGlobal("localStorage", local);
    try {
      purgeLegacyRefstreamSessionCaches();
      const { terminal, write } = fakeTerminal();
      const attached = await attachRefstreamTools("refstream", toolsOptions(terminal));
      write(TERMINAL_SECRET);
      write(TERMINAL_SECRET);
      attached?.dispose();

      expect(session.writes).toEqual([]);
      expect(local.writes).toEqual([]);
      for (const store of [session, local]) {
        for (const value of store.values.values()) expect(value).not.toContain(TERMINAL_SECRET);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never restores a legacy snapshot at startup", async () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    vi.stubGlobal("sessionStorage", session);
    vi.stubGlobal("localStorage", local);
    try {
      session.values.set(`${PREFIX}share%2Fid`, legacySnapshotValue());
      purgeLegacyRefstreamSessionCaches();
      const { terminal } = fakeTerminal();
      const model = getTerminalSession(terminal) as TerminalSession;
      const restoreSpy = vi.spyOn(model, "restore");

      await attachRefstreamTools("refstream", toolsOptions(terminal));

      expect(restoreSpy).not.toHaveBeenCalled();
      expect(session.values.has(`${PREFIX}share%2Fid`)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the live session tools and task model working", async () => {
    const { terminal, write } = fakeTerminal();
    const model = getTerminalSession(terminal) as TerminalSession;
    write(TERMINAL_SECRET);
    const snapshot = model.snapshot();
    expect((snapshot.terminal as { model: { title: string } }).model.title).toBe("");
    model.restore(snapshot);

    let fired = 0;
    const subscription = model.onChange(() => fired++);
    write("ls");
    expect(fired).toBe(1);
    subscription.dispose();

    expect(attachTools).not.toHaveBeenCalled();
    const xtermTools = await attachRefstreamTools("xterm", toolsOptions(terminal));
    expect(xtermTools).toBeNull();
    expect(attachTools).not.toHaveBeenCalled();

    const refstreamTools = await attachRefstreamTools("refstream", toolsOptions(terminal));
    expect(attachTools).toHaveBeenCalledTimes(1);
    expect(attachTools.mock.calls[0][0].session).toBe(model);
    const disposeSpy = vi.spyOn(refstreamTools!, "dispose");
    refstreamTools!.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
