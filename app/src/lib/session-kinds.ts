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
  /**
   * True when this flag set was taken from the tool's published interface
   * rather than read from its own --help.
   *
   * A fact about how the builder above was written, fixed when it was written.
   * It says nothing about any machine: whether a machine can run the tool is
   * reported by the agent on it, and read through harnessMissing.
   */
  flagsFromPublishedInterface?: boolean;
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
      if (on(values, "skipPermissions")) parts.push("--dangerously-skip-permissions");
      return parts.join(" ");
    },
  },
  {
    id: "codex",
    title: "GPT Codex",
    blurb: "OpenAI's coding agent.",
    icon: "/icons/codex.webp",
    flagsFromPublishedInterface: true,
    fields: [
      {
        name: "sessionId",
        label: "Resume session ID",
        kind: "text",
        placeholder: "leave empty to start fresh",
        help: "Runs codex resume <id>.",
      },
      {
        name: "fullAuto",
        label: "Full auto",
        kind: "toggle",
        help: "Adds --full-auto, so it works without stopping to ask.",
      },
      { name: "name", label: "Session name", kind: "text", placeholder: "optional" },
    ],
    build(values) {
      const parts = ["codex"];
      const id = text(values, "sessionId");
      if (id) parts.push("resume", quote(id));
      if (on(values, "fullAuto")) parts.push("--full-auto");
      return parts.join(" ");
    },
  },
  {
    id: "hermes",
    title: "Hermes Agent",
    blurb: "Your Hermes agent, wrapped in a shareable terminal.",
    icon: "/icons/hermes.png",
    // The builder stays a pass-through rather than inventing a flag set that
    // was never read from the tool.
    flagsFromPublishedInterface: true,
    fields: [
      {
        name: "args",
        label: "Arguments",
        kind: "text",
        placeholder: "run --task build",
        help: "Appended to hermes as written.",
      },
      { name: "name", label: "Session name", kind: "text", placeholder: "optional" },
    ],
    build(values) {
      const args = text(values, "args");
      return args ? `hermes ${args}` : "hermes";
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
export function kindForCommand(command: string): SessionKind {
  const program = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
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
