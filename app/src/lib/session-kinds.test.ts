import { describe, expect, it } from "vitest";
import { SESSION_KINDS, kindById, kindForCommand, quote, sessionName, unwrapShell } from "./session-kinds";

const claude = kindById("claude-code")!;
const codex = kindById("codex")!;
const openclaw = kindById("openclaw")!;
const hermes = kindById("hermes")!;
const terminal = kindById("terminal")!;

describe("the catalogue", () => {
  it("offers exactly the five kinds, each with an icon", () => {
    expect(SESSION_KINDS).toHaveLength(5);
    for (const kind of SESSION_KINDS) {
      expect(kind.icon).toMatch(/^\/icons\//);
      expect(kind.title).toBeTruthy();
    }
  });

  it("gives every kind a session name field", () => {
    for (const kind of SESSION_KINDS) {
      expect(kind.fields.some((field) => field.name === "name")).toBe(true);
    }
  });

  it("marks which flag sets came from a published interface rather than --help", () => {
    /*
     * A property of how each builder was written, not of any machine. What a
     * given machine can actually run is reported by its agent; see
     * harnessMissing.
     */
    expect(claude.flagsFromPublishedInterface).toBeFalsy();
    expect(openclaw.flagsFromPublishedInterface).toBeFalsy();
    expect(codex.flagsFromPublishedInterface).toBe(true);
    expect(hermes.flagsFromPublishedInterface).toBe(true);
  });
});

describe("Claude Code", () => {
  it("starts fresh with no options", () => {
    expect(claude.build({})).toBe("claude");
  });

  it("resumes a session", () => {
    expect(claude.build({ sessionId: "abc-123" })).toBe("claude --resume abc-123");
  });

  it("adds the skip-permissions flag only when asked", () => {
    expect(claude.build({ skipPermissions: false })).toBe("claude");
    expect(claude.build({ skipPermissions: true })).toBe(
      "claude --dangerously-skip-permissions",
    );
  });

  it("combines both", () => {
    expect(claude.build({ sessionId: "abc", skipPermissions: true })).toBe(
      "claude --resume abc --dangerously-skip-permissions",
    );
  });

  it("ignores a whitespace-only session id", () => {
    expect(claude.build({ sessionId: "   " })).toBe("claude");
  });

  it("does not let the session name reach the command line", () => {
    /* The name labels the session; it is not an argument to the tool. */
    expect(claude.build({ name: "my run" })).toBe("claude");
  });

  it("quotes a session id that would otherwise split", () => {
    expect(claude.build({ sessionId: "two words" })).toBe("claude --resume 'two words'");
  });
});

describe("GPT Codex", () => {
  it("starts fresh, resumes, and goes full auto", () => {
    expect(codex.build({})).toBe("codex");
    expect(codex.build({ sessionId: "s1" })).toBe("codex resume s1");
    expect(codex.build({ fullAuto: true })).toBe("codex --full-auto");
    expect(codex.build({ sessionId: "s1", fullAuto: true })).toBe(
      "codex resume s1 --full-auto",
    );
  });
});

describe("OpenClaw", () => {
  it("defaults to the bare command", () => {
    expect(openclaw.build({})).toBe("openclaw");
  });

  it("puts the profile before the subcommand, as the CLI expects", () => {
    expect(openclaw.build({ subcommand: "agent", profile: "work" })).toBe(
      "openclaw --profile work agent",
    );
  });

  it("takes a subcommand alone", () => {
    expect(openclaw.build({ subcommand: "gateway" })).toBe("openclaw gateway");
  });
});

describe("Hermes", () => {
  it("passes arguments through unchanged", () => {
    expect(hermes.build({})).toBe("hermes");
    expect(hermes.build({ args: "run --task build" })).toBe("hermes run --task build");
  });
});

describe("Terminal process", () => {
  it("runs exactly what was typed", () => {
    expect(terminal.build({ command: "npm run dev" })).toBe("npm run dev");
    expect(terminal.build({ command: "  python3 -q  " })).toBe("python3 -q");
  });

  it("builds nothing from an empty box", () => {
    expect(terminal.build({})).toBe("");
  });
});

describe("quote", () => {
  it("leaves safe values alone", () => {
    for (const value of ["claude", "abc-123", "/usr/local/bin", "a.b_c@d"]) {
      expect(quote(value)).toBe(value);
    }
  });

  it("wraps anything with a space or a shell character", () => {
    expect(quote("two words")).toBe("'two words'");
    expect(quote("a;b")).toBe("'a;b'");
    expect(quote("$HOME")).toBe("'$HOME'");
  });

  it("escapes an embedded single quote rather than closing early", () => {
    expect(quote("it's")).toBe(`'it'\\''s'`);
  });

  it("keeps an empty value as an explicit empty argument", () => {
    expect(quote("")).toBe("''");
  });
});

describe("sessionName", () => {
  it("prefers the given name", () => {
    expect(sessionName({ name: "nightly build" }, "npm run build")).toBe("nightly build");
  });

  it("falls back to the command", () => {
    expect(sessionName({}, "npm run build")).toBe("npm run build");
    expect(sessionName({ name: "   " }, "npm run build")).toBe("npm run build");
  });
});

describe("kindForCommand", () => {
  it("recognises each agent by the program being run", () => {
    expect(kindForCommand("claude").id).toBe("claude-code");
    expect(kindForCommand("codex resume abc").id).toBe("codex");
    expect(kindForCommand("hermes run --task build").id).toBe("hermes");
    expect(kindForCommand("openclaw --profile work agent").id).toBe("openclaw");
  });

  it("keeps recognising one with flags after it", () => {
    expect(kindForCommand("claude --resume abc --dangerously-skip-permissions").id)
      .toBe("claude-code");
  });

  it("looks past a path", () => {
    expect(kindForCommand("/usr/local/bin/claude").id).toBe("claude-code");
    expect(kindForCommand("./bin/codex").id).toBe("codex");
  });

  it("is not fooled by the name appearing later in the line", () => {
    /* This runs npm, not the agent. */
    expect(kindForCommand("npm run claude-thing").id).toBe("terminal");
    expect(kindForCommand("echo claude").id).toBe("terminal");
  });

  it("falls back to a terminal process for anything else", () => {
    expect(kindForCommand("htop").id).toBe("terminal");
    expect(kindForCommand("npm run dev").id).toBe("terminal");
    expect(kindForCommand("").id).toBe("terminal");
    expect(kindForCommand("   ").id).toBe("terminal");
  });

  it("ignores case in the program name", () => {
    expect(kindForCommand("CLAUDE --resume x").id).toBe("claude-code");
  });
});

describe("the kind of a session started from the browser", () => {
  /*
   * The browser hands the machine `sh -c "claude ..."`, so the program is the
   * second thing on the line. Reading the first gave every browser-started
   * session a terminal icon, whatever it was actually running.
   */
  it("sees through the shell a browser-started session runs under", () => {
    expect(kindForCommand('sh -c "claude --dangerously-skip-permissions"').id).toBe("claude-code");
    expect(kindForCommand("sh -c 'codex exec'").id).toBe("codex");
    expect(kindForCommand('/bin/sh -c "openclaw"').id).toBe("openclaw");
    expect(kindForCommand('bash -lc "hermes"').id).toBe("hermes");
  });

  it("still reads a command that was not wrapped", () => {
    expect(kindForCommand("claude --resume abc").id).toBe("claude-code");
    expect(kindForCommand("/usr/local/bin/claude").id).toBe("claude-code");
  });

  /* Unwrapping must not turn an ordinary command into a harness. */
  it("leaves a wrapped ordinary command as a terminal process", () => {
    expect(kindForCommand('sh -c "npm run dev"').id).toBe("terminal");
    expect(kindForCommand("npm run claude-thing").id).toBe("terminal");
    expect(kindForCommand("sh").id).toBe("terminal");
  });

  it("unwraps only the leading shell, and only once", () => {
    expect(unwrapShell('sh -c "claude"')).toBe("claude");
  });

  /*
   * An older CLI recorded the argv it was given by joining it with spaces, so
   * the quotes that made the wrapped line one argument are gone from the row.
   */
  it("unwraps a shell whose quotes were lost on the way to the record", () => {
    expect(unwrapShell("sh -c claude")).toBe("claude");
    expect(unwrapShell("sh -c claude --dangerously-skip-permissions")).toBe(
      "claude --dangerously-skip-permissions",
    );
    expect(kindForCommand("sh -c claude").id).toBe("claude-code");
    expect(unwrapShell("claude")).toBe("claude");
    /* Not something anything here produces; following it would be guessing. */
    expect(unwrapShell(`sh -c "sh -c 'claude'"`)).toBe("sh -c 'claude'");
  });
});
