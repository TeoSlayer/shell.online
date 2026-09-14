import { getTerminalSession } from "./vendor/refstream/v0.1.0-alpha.4/refstream.js";
import { attachTerminalTools, type TerminalTools } from "./vendor/refstream/v0.1.0-alpha.4/ui.js";
import { bindRefstreamSessionPersistence } from "./refstream-session";

const REFSTREAM_THEMES = [
  "shell",
  "midnight",
  "ocean",
  "amethyst",
  "ember",
  "arctic",
  "paper",
  "sand",
] as const;

export interface RefstreamToolsOptions {
  terminal: unknown;
  /** Stable share identity used only to restore this tab after a reload. */
  sessionKey: string;
  toolbar: HTMLElement;
  overlay: HTMLElement;
  frame?: HTMLElement;
  isActive?: () => boolean;
  onThemeChange?: (theme: unknown) => void;
  onFontSizeChange?: (size: number) => void;
  exportFilename?: string;
}

/**
 * Mount Refstream's optional browser tools only when its native engine is in
 * use. shell.online keeps ownership of transport, encryption, permissions and
 * collaboration; Refstream owns terminal-local navigation and inspection.
 */
export function attachRefstreamTools(
  renderer: "xterm" | "refstream",
  options: RefstreamToolsOptions,
): Promise<TerminalTools | null> {
  if (renderer !== "refstream") return Promise.resolve(null);

  const session = getTerminalSession(options.terminal);
  const persistence = bindRefstreamSessionPersistence(session, options.sessionKey);

  return attachTerminalTools({
    terminal: options.terminal,
    session,
    engine: "native",
    toolbar: options.toolbar,
    overlay: options.overlay,
    frame: options.frame,
    isActive: options.isActive,
    onThemeChange: options.onThemeChange,
    onFontSizeChange: options.onFontSizeChange,
    ui: {
      toolbar: ["search", "agent", "explore", "menu"],
      menu: ["theme", "fontSize", "export"],
      themes: REFSTREAM_THEMES,
      explore: {
        tabs: ["commands", "agent"],
        initialTab: "commands",
        title: "Terminal tools",
      },
      labels: {
        explore: "Commands",
        exploreTitle: "Commands",
        agent: "Connect agent",
        agentInstructions: "Copy one scoped invitation into your agent chat. Choose read-only access or allow terminal input and commands.",
        agentPrivacy: "Only this live terminal is exposed. Disconnect at any time; file access remains a separate CLI opt-in.",
        agentRead: "Read terminal",
        agentControl: "Read and control",
        noCommands: "No command boundaries yet. Commands appear when the process reports shell markers.",
        export: "Download output",
      },
      exportFilename: options.exportFilename ?? "shell-online-output.txt",
      backToLive: true,
    },
  }).then((tools) => {
    let disposed = false;
    return {
      ...tools,
      dispose() {
        if (disposed) return;
        disposed = true;
        persistence.dispose();
        tools.dispose();
      },
    };
  }, (error: unknown) => {
    persistence.dispose();
    throw error;
  });
}
