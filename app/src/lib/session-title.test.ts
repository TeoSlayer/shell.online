import { describe, expect, it } from "vitest";
import { SESSION_TITLE_MAX, commandLabel, sessionSummary, sessionTitle } from "./session-title";
import type { SessionRecord } from "./api";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    shareUrl: "http://127.0.0.1:8788/s/s1",
    command: "top",
    readOnly: false,
    encrypted: false,
    persistent: false,
    host: "ana-mbp",
    startedAt: 1,
    ...overrides,
  };
}

describe("commandLabel", () => {
  it("reduces a Unix path to its executable name and drops the arguments", () => {
    expect(commandLabel("/opt/homebrew/bin/opencode -s ses_abc -m calin/Qwen3.8-27B")).toBe("opencode");
  });

  it("keeps a bare command as its own label", () => {
    expect(commandLabel("bash")).toBe("bash");
    expect(commandLabel("npm run dev")).toBe("npm");
    expect(commandLabel("  htop  ")).toBe("htop");
  });

  it("reads a quoted first word as one token, path included", () => {
    expect(commandLabel('"/opt/my bin/tool" --flag "a long quoted argument"')).toBe("tool");
    expect(commandLabel("'C:\\Program Files\\app\\run.exe' arg")).toBe("run");
  });

  it("reduces Windows paths and strips the executable extension", () => {
    expect(commandLabel("C:\\Users\\me\\AppData\\Roaming\\npm\\node.exe server.js")).toBe("node");
    expect(commandLabel("C:\\tools\\opencode.exe run")).toBe("opencode");
    expect(commandLabel("\\\\server\\share\\run.bat /go")).toBe("run.bat");
  });

  it("does not special-case any one program", () => {
    expect(commandLabel("/usr/local/bin/claude --print")).toBe("claude");
    expect(commandLabel("/usr/bin/python3 script.py --verbose")).toBe("python3");
  });

  it("falls back when there is no executable to name", () => {
    expect(commandLabel("")).toBe("Session");
    expect(commandLabel("   ")).toBe("Session");
    expect(commandLabel("-rf /tmp")).toBe("Command");
  });

  it("caps a label so one odd command cannot widen a list", () => {
    const label = commandLabel("a".repeat(200));
    expect(label.length).toBeLessThanOrEqual(SESSION_TITLE_MAX);
    expect(label.endsWith("…")).toBe(true);
  });

  it("treats the command as text, not as something to run", () => {
    expect(commandLabel("echo should-not-print")).toBe("echo");
    expect(commandLabel("echo $HOME")).toBe("echo");
    expect(commandLabel("`pwd`/bin/tool --x")).toBe("tool");
  });
});

describe("sessionTitle", () => {
  it("uses an existing conversation title only behind the manual name", () => {
    expect(sessionTitle(session({suggestedTitle:"Fix terminal replay"}))).toBe("Fix terminal replay");
    expect(sessionTitle(session({name:"My name",suggestedTitle:"Automatic"}))).toBe("My name");
  });
  it("prefers the name somebody gave the session", () => {
    expect(sessionTitle(session({ name: "nightly build", command: "/opt/bin/thing --x" })))
      .toBe("nightly build");
  });

  it("treats a blank name as no name", () => {
    expect(sessionTitle(session({ name: "   ", command: "/opt/homebrew/bin/opencode -s ses_abc" })))
      .toBe("opencode");
  });

  it("derives from the command when there is no name", () => {
    expect(sessionTitle(session({ command: "C:\\bin\\node.exe server.js" }))).toBe("node");
  });

  it("caps a long name and keeps the stored name untouched", () => {
    const name = "b".repeat(120);
    const record = session({ name, command: "top" });
    const title = sessionTitle(record);
    expect(title.length).toBe(SESSION_TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
    expect(record.name).toBe(name);
  });

  it("never mutates the record it reads", () => {
    const record = session({ command: "/opt/homebrew/bin/opencode -s ses_abc -m calin/x" });
    sessionTitle(record);
    expect(record).toEqual(session({ command: "/opt/homebrew/bin/opencode -s ses_abc -m calin/x" }));
  });
});

describe("sessionSummary", () => {
  it("returns a genuine description when the record carries one", () => {
    expect(sessionSummary(session({ description: "Nightly build and upload." })))
      .toBe("Nightly build and upload.");
  });

  it("is null when there is no description, so the UI shows an empty state", () => {
    expect(sessionSummary(session({}))).toBeNull();
    expect(sessionSummary(session({ description: "   " }))).toBeNull();
  });

  it("never falls back to the command as a summary", () => {
    const record = session({ command: "/opt/homebrew/bin/opencode -s ses_abc -m calin/x" });
    expect(sessionSummary(record)).toBeNull();
  });
});
