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

  it("offers only options each tool's own --help accepts", () => {
    /*
     * Every flag below was read from the installed tool rather than from its
     * documentation, and rejected flags were removed: codex 0.153.4 answers
     * `--full-auto` with "unexpected argument", so the launcher no longer
     * builds it. What a given machine can run is a separate question, reported
     * by its agent; see harnessMissing.
     */
    const built = SESSION_KINDS.flatMap((kind) =>
      kind.fields.map((field) => kind.build({ [field.name]: field.kind === "toggle" ? true : "v" })),
    );
    expect(built.join(" ")).not.toContain("--full-auto");
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
  it("starts fresh with no options", () => {
    expect(codex.build({})).toBe("codex");
  });

  it("resumes by id, and by --last only when no id was given", () => {
    expect(codex.build({ sessionId: "s1" })).toBe("codex resume s1");
    expect(codex.build({ resumeLast: true })).toBe("codex resume --last");
    /* An id is the more specific request, so it wins over "the last one". */
    expect(codex.build({ sessionId: "s1", resumeLast: true })).toBe("codex resume s1");
  });

  it("passes the sandbox and approval choices through", () => {
    expect(codex.build({ sandbox: "workspace-write" })).toBe(
      "codex --sandbox workspace-write",
    );
    expect(codex.build({ approval: "never" })).toBe("codex --ask-for-approval never");
    expect(codex.build({ search: true })).toBe("codex --search");
  });

  it("leaves both choices out when neither was made", () => {
    /* An empty select means "whatever codex defaults to", not a flag. */
    expect(codex.build({ sandbox: "", approval: "" })).toBe("codex");
  });

  it("puts options after the resume subcommand, where the CLI takes them", () => {
    expect(
      codex.build({ sessionId: "s1", sandbox: "read-only", approval: "never", search: true }),
    ).toBe("codex resume s1 --sandbox read-only --ask-for-approval never --search");
  });

  it("quotes a session id that would otherwise split", () => {
    expect(codex.build({ sessionId: "two words" })).toBe("codex resume 'two words'");
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
  it("defaults to the bare command", () => {
    expect(hermes.build({})).toBe("hermes");
  });

  it("puts every option before the subcommand, as the parser requires", () => {
    /* `hermes sessions --yolo` is an error; only this order parses. */
    expect(hermes.build({ subcommand: "sessions", yolo: true })).toBe(
      "hermes --yolo sessions",
    );
    expect(hermes.build({ subcommand: "gateway", model: "gpt-5", worktree: true })).toBe(
      "hermes --model gpt-5 --worktree gateway",
    );
  });

  it("resumes a named session", () => {
    expect(hermes.build({ sessionId: "s1" })).toBe("hermes --resume s1");
    expect(hermes.build({ sessionId: "two words" })).toBe("hermes --resume 'two words'");
  });

  it("continues the last session only when nothing could be eaten by it", () => {
    /*
     * --continue takes an optional value, so a bare one swallows whatever
     * follows: `hermes --continue sessions` resumes a session called
     * "sessions" instead of running the subcommand. It is emitted last, and
     * only when there is no subcommand and no explicit session to resume.
     */
    expect(hermes.build({ continueLast: true })).toBe("hermes --continue");
    expect(hermes.build({ continueLast: true, subcommand: "sessions" })).toBe(
      "hermes sessions",
    );
    expect(hermes.build({ continueLast: true, sessionId: "s1" })).toBe("hermes --resume s1");
    expect(hermes.build({ continueLast: true, yolo: true })).toBe("hermes --yolo --continue");
  });

  it("does not let the session name reach the command line", () => {
    expect(hermes.build({ name: "my run" })).toBe("hermes");
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
