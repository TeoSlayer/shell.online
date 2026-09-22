/*
 * The feedback sheet's vocabulary, and the little that travels with a message.
 *
 * Pure on purpose: nothing here touches the network or the account, so it can
 * be tested without a browser and rendered outside the app.
 */

export type FeedbackKind = "problem" | "idea" | "question";

export const MAX_FEEDBACK = 4000;

export interface KindOption {
  id: FeedbackKind;
  label: string;
  placeholder: string;
}

export const FEEDBACK_KINDS: readonly KindOption[] = [
  {
    id: "problem",
    label: "Something broke",
    placeholder: "What were you doing, and what happened instead?",
  },
  {
    id: "idea",
    label: "An idea",
    placeholder: "What would you change, and what would it save you?",
  },
  {
    id: "question",
    label: "A question",
    placeholder: "What are you trying to work out?",
  },
];

/** What is sent, in the shape the service reads. */
export interface FeedbackPayload {
  kind: FeedbackKind;
  body: string;
  surface: string;
  route: string;
  app_version: string;
  can_reply: boolean;
  context: Record<string, string>;
}

/*
 * Where in the app a message was written, said the way the person reading it
 * would say it. The id is what is stored; the sentence is what the sheet shows
 * so the sender can see what "from" will mean.
 */
const SURFACE_LABELS: Record<string, string> = {
  "shared-terminal": "a shared terminal",
  "feedback-page": "the feedback page",
  "account-menu": "the account menu",
  account: "the Account page",
  "new-session": "the new session form",
  "signed-in": "the terminal-linked notice",
  "session-gate": "the session password gate",
  "session-ended": "a session that ended",
  "vault-setup": "vault setup",
  "vault-unlock": "the vault unlock screen",
  "vault-error": "a vault that could not be reached",
  "first-run": "the empty sessions list",
  "sessions-error": "an error on the sessions list",
  "session-error": "an error on a session page",
  "machines-error": "an error on the machines list",
  "delete-account": "the delete account form",
};

export function surfaceLabel(surface: string): string {
  return SURFACE_LABELS[surface] ?? surface;
}

/*
 * The version vite.config.ts stamps into the bundle, so a message can say
 * which build it came from. "dev" wherever nothing stamped it, which is the
 * dev server and the tests.
 */
export const APP_VERSION: string =
  typeof __SHELL_ONLINE_VERSION__ === "string" ? __SHELL_ONLINE_VERSION__ : "dev";

/*
 * "Chrome 129 on macOS": enough to know which browser a report is about, and
 * nothing that would tell two people on the same browser apart. Edge and
 * Chrome both carry "Chrome/", and both carry "Safari/", so the order of the
 * checks is the whole trick.
 */
export function describeBrowser(userAgent: string): string {
  const system = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /CrOS/.test(userAgent)
            ? "ChromeOS"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "";
  const browsers: [string, RegExp][] = [
    ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
    ["Safari", /Version\/(\d+)[.\d]* .*Safari/],
  ];
  let browser = "Unknown browser";
  for (const [name, pattern] of browsers) {
    const match = userAgent.match(pattern);
    if (match) {
      browser = `${name} ${match[1]}`;
      break;
    }
  }
  return system ? `${browser} on ${system}` : browser;
}

/*
 * Path only. A query string can name a session (?open=...) and a hash is
 * where a share link keeps its key, so neither leaves the browser.
 */
export function routeForFeedback(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0];
  return path.startsWith("/") ? path : "/";
}

/*
 * Drops facts that are empty, so the "sent with your message" list shows
 * exactly what is sent and nothing that reads as a blank.
 */
export function trimContext(context: Record<string, string | undefined> = {}): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    const trimmed = value?.trim();
    if (trimmed) kept[key] = trimmed.slice(0, 200);
  }
  return kept;
}
