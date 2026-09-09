/**
 * The kinds of session the launcher can build a command for.
 *
 * Each kind is a small form plus a pure function from its fields to a command
 * line. Keeping the building separate from the modal means the thing worth
 * checking, the command that will actually run on someone's machine, is
 * testable without a DOM.
 */

export type FieldKind = "text" | "toggle" | "select";

export interface Field {
  name: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export type FieldValues = Record<string, string | boolean>;

export interface SessionKind {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  /** Shown under the form so the command is never a surprise. */
  build(values: FieldValues): string;
  fields: Field[];
}

function text(values: FieldValues, name: string): string {
  const value = values[name];
  return typeof value === "string" ? value.trim() : "";
}

function on(values: FieldValues, name: string): boolean {
  return values[name] === true;
}

/**
 * Quotes an argument for a POSIX shell when it needs it.
 *
 * The command is executed on the operator's own machine, by their own agent,
 * from their own browser. Quoting is here so a path with a space survives, not
 * as a security boundary.
 */
export function quote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const SESSION_KINDS: SessionKind[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    blurb: "Anthropic's coding agent, in a shared terminal.",
    icon: "/icons/claude-code.svg",
    fields: [
      {
        name: "sessionId",
        label: "Resume session ID",
        kind: "text",
        placeholder: "leave empty to start fresh",
        help: "Passed to --resume.",
      },
      {
        name: "model",
        label: "Model",
        kind: "select",
        options: [
          { value: "", label: "Whatever the machine is set to" },
          { value: "opus", label: "Opus" },
          { value: "sonnet", label: "Sonnet" },
          { value: "haiku", label: "Haiku" },
        ],
        help: "Passed to --model. Left alone, the machine's own default is used.",
      },
      {
        name: "skipPermissions",
        label: "Skip permission checks",
        kind: "toggle",
        help: "Adds --dangerously-skip-permissions. The agent will not ask before acting.",
      },
      { name: "name", label: "Session name", kind: "text", placeholder: "optional" },
    ],
    build(values) {
      const parts = ["claude"];
      const id = text(values, "sessionId");
      if (id) parts.push("--resume", quote(id));
      const model = text(values, "model");
      if (model) parts.push("--model", quote(model));
      if (on(values, "skipPermissions")) parts.push("--dangerously-skip-permissions");
      return parts.join(" ");
    },
  },
  {
    id: "codex",
    title: "GPT Codex",
    blurb: "OpenAI's coding agent.",
    icon: "/icons/codex.webp",
    fields: [
      {
        name: "sessionId",
        label: "Resume session ID",
        kind: "text",
        placeholder: "leave empty to start fresh",
        help: "Runs codex resume <id>. Accepts a session UUID or a session name.",
      },
      {
        name: "model",
        label: "Model",
        kind: "text",
        placeholder: "leave empty for the codex default",
        help: "Passed to --model as written.",
      },
      {
        name: "resumeLast",
        label: "Resume the most recent session",
        kind: "toggle",
        help: "Runs codex resume --last. Ignored when a session ID is given.",
      },
      {
        name: "sandbox",
        label: "Sandbox",
        kind: "select",
        help: "Passed to --sandbox, bounding what generated commands may touch.",
        options: [
          { value: "", label: "codex default" },
          { value: "read-only", label: "read-only" },
          { value: "workspace-write", label: "workspace-write" },
          { value: "danger-full-access", label: "danger-full-access" },
        ],
      },
      {
        name: "approval",
        label: "Approvals",
        kind: "select",
        help: "Passed to --ask-for-approval. never runs without stopping to ask.",
        options: [
          { value: "", label: "codex default" },
          { value: "on-request", label: "on-request" },
          { value: "never", label: "never" },
        ],
      },
      {
        name: "search",
        label: "Web search",
        kind: "toggle",
        help: "Adds --search, giving the model the native web_search tool.",
      },
      { name: "name", label: "Session name", kind: "text", placeholder: "optional" },
    ],
    /*
     * Options follow `resume <id>`, which is where the CLI accepts them: the
     * subcommand takes the same --sandbox, --ask-for-approval and --search as
     * the root command, so one order works for both a fresh and a resumed run.
     */
    build(values) {
      const parts = ["codex"];
      const id = text(values, "sessionId");
      if (id) parts.push("resume", quote(id));
      else if (on(values, "resumeLast")) parts.push("resume", "--last");
      const model = text(values, "model");
      if (model) parts.push("--model", quote(model));
      const sandbox = text(values, "sandbox");
      if (sandbox) parts.push("--sandbox", sandbox);
      const approval = text(values, "approval");
      if (approval) parts.push("--ask-for-approval", approval);
      if (on(values, "search")) parts.push("--search");
      return parts.join(" ");
    },
  },
  {
    id: "hermes",
    title: "Hermes Agent",
    blurb: "Your Hermes agent, wrapped in a shareable terminal.",
    icon: "/icons/hermes.png",
    fields: [
      {
        name: "subcommand",
        label: "Command",
        kind: "select",
        options: [
          { value: "", label: "hermes (interactive chat)" },
          { value: "chat", label: "chat" },
          { value: "gateway", label: "gateway" },
          { value: "sessions", label: "sessions" },
          { value: "dashboard", label: "dashboard" },
          { value: "status", label: "status" },
          { value: "doctor", label: "doctor" },
          { value: "acp", label: "acp" },
        ],
      },
      {
        name: "sessionId",
        label: "Resume session",
        kind: "text",
        placeholder: "leave empty to start fresh",
        help: "Passed to --resume. Accepts a session ID or title.",
      },
      {
        name: "continueLast",
        label: "Continue the most recent session",
        kind: "toggle",
        help: "Adds --continue. Ignored when a command or a session is chosen.",
      },
      {
        name: "model",
        label: "Model",
        kind: "text",
        placeholder: "anthropic/claude-sonnet-4.6",
        help: "Passed to --model for this run only.",
      },
      {
        name: "worktree",
        label: "Isolated git worktree",
        kind: "toggle",
        help: "Adds --worktree, so parallel agents do not share a checkout.",
      },
      {
        name: "yolo",
        label: "Skip approval prompts",
        kind: "toggle",
        help: "Adds --yolo. The agent will not ask before running a command.",
      },
      { name: "name", label: "Session name", kind: "text", placeholder: "optional" },
    ],
    /*
     * Every option here belongs to the top-level parser, so all of them go
     * before the subcommand; `hermes sessions --yolo` is an error where
     * `hermes --yolo sessions` is not.
     *
     * --continue takes an optional value, which makes a bare one greedy: in
     * `hermes --continue sessions` the subcommand is read as the session name
     * to resume. So it is emitted last and only when nothing follows it.
     */
    build(values) {
      const parts = ["hermes"];
      const model = text(values, "model");
      if (model) parts.push("--model", quote(model));
      if (on(values, "worktree")) parts.push("--worktree");
      if (on(values, "yolo")) parts.push("--yolo");
      const id = text(values, "sessionId");
      if (id) parts.push("--resume", quote(id));
      const subcommand = text(values, "subcommand");
      if (subcommand) parts.push(subcommand);
      else if (!id && on(values, "continueLast")) parts.push("--continue");
      return parts.join(" ");
    },
  },
  {
    id: "openclaw",
    title: "OpenClaw",
    blurb: "All your chats, one OpenClaw.",
    icon: "/icons/openclaw.png",
    fields: [
      {
        name: "subcommand",
        label: "Command",
        kind: "select",
        options: [
          { value: "", label: "openclaw (default)" },
          { value: "agent", label: "agent" },
          { value: "gateway", label: "gateway" },
          { value: "attach", label: "attach" },
        ],
      },
      {
        name: "profile",
        label: "Profile",
        kind: "text",
        placeholder: "optional",
        help: "Passed to --profile, isolating state under ~/.openclaw-<name>.",
      },
      { name: "name", label: "Session name", kind: "text", placeholder: "optional" },
    ],
    build(values) {
      const parts = ["openclaw"];
      const profile = text(values, "profile");
      if (profile) parts.push("--profile", quote(profile));
      const subcommand = text(values, "subcommand");
      if (subcommand) parts.push(subcommand);
      return parts.join(" ");
    },
  },
  {
    id: "terminal",
    title: "Terminal process",
    blurb: "Any command at all.",
    icon: "/icons/terminal.png",
    fields: [
      {
        name: "command",
        label: "Command",
        kind: "text",
        placeholder: "npm run dev",
        help: "Runs exactly as typed.",
      },
      { name: "name", label: "Session name", kind: "text", placeholder: "optional" },
    ],
    build(values) {
      return text(values, "command");
    },
  },
];

export function kindById(id: string): SessionKind | undefined {
  return SESSION_KINDS.find((kind) => kind.id === id);
}

/**
 * Which kind a running session is, from the command it wraps.
 *
 * Matched on the program being run, so `claude --resume abc` is Claude Code
 * and `npm run claude-thing` is not. Anything unrecognised is a terminal
 * process, which is what it is.
 */
/*
 * Sees through the shell a session was started under.
 *
 * A session started from the browser is handed to the machine as
 * `sh -c "claude ..."`, so the program being run is the second thing on the
 * line and reading the first gives every one of them a terminal icon. Quotes
 * are stripped when present; an argv recorded by joining its parts with spaces
 * no longer has them, so their absence is not a reason to give up.
 *
 * This is for sessions recorded before the CLI carried the requested command
 * through to registration. A machine running a current release publishes what
 * was asked for, so nothing new needs unwrapping; rows already stored do.
 *
 * Only the leading wrapper is unwrapped, and only once: `sh -c "sh -c ..."` is
 * not a thing anything here produces, and following it would be guessing.
 */
export function unwrapShell(command: string): string {
  const trimmed = command.trim();
  const wrapper = trimmed.match(/^(?:\/\S*\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+([\s\S]+)$/);
  if (!wrapper) return trimmed;
  /*
   * The wrapped line is one argument to sh, but an argv joined back together
   * for display has lost the quotes that made it one. `sh -c claude` and
   * `sh -c "claude --resume"` are the same shape with and without them.
   */
  const rest = wrapper[1].trim();
  const quoted = rest.match(/^(['"])([\s\S]*)\1$/);
  return (quoted ? quoted[2] : rest).trim();
}

export function kindForCommand(command: string): SessionKind {
  const program = unwrapShell(command).split(/\s+/)[0]?.toLowerCase() ?? "";
  /* Strip any path, so /usr/local/bin/claude still reads as Claude Code. */
  const leaf = program.split(/[\\/]/).pop() ?? "";
  const byProgram: Record<string, string> = {
    claude: "claude-code",
    codex: "codex",
    hermes: "hermes",
    openclaw: "openclaw",
  };
  const id = byProgram[leaf];
  return (id ? kindById(id) : undefined) ?? SESSION_KINDS[SESSION_KINDS.length - 1];
}

/** The label a session should carry, falling back to the command itself. */
export function sessionName(values: FieldValues, command: string): string {
  return text(values, "name") || command;
}
