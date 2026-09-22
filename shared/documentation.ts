export const DOCUMENTATION_KINDS = [
  "docs",
  "app",
  "cli",
  "platforms",
  "mobile",
  "agents",
  "refstream",
  "reliability",
  "security",
  "e2ee",
  "docker",
  "self-hosting",
] as const;

export type DocumentationKind = (typeof DOCUMENTATION_KINDS)[number];

export interface DocumentationPage {
  eyebrow: string;
  title: string;
  intro: string;
  seo?: {
    description: string;
    socialTitle: string;
    socialDescription: string;
  };
  cards: [string, string, [string, string][]?][];
  diagrams?: DocumentationDiagram[];
}

export interface DocumentationDiagram {
  after: number;
  title: string;
  caption: string;
  desktop: string;
  mobile: string;
}

export interface DocumentationContent {
  version: string;
  pages: Partial<Record<DocumentationKind, DocumentationPage>>;
}

export interface DocumentationRoute {
  kind: DocumentationKind;
  version: string;
}

export const DOCUMENTATION_NAVIGATION: readonly {
  section: string;
  entries: readonly { kind: DocumentationKind; label: string }[];
}[] = [
  {
    section: "Start here",
    entries: [
      { kind: "docs", label: "Your first session" },
      { kind: "platforms", label: "Install & update" },
      { kind: "mobile", label: "Use your phone" },
    ],
  },
  {
    section: "Do more",
    entries: [
      { kind: "app", label: "Sessions & teammates" },
      { kind: "agents", label: "Connect an agent · MCP" },
      { kind: "docker", label: "Keep a Docker workspace" },
      { kind: "refstream", label: "Try Refstream · alpha" },
    ],
  },
  {
    section: "Help & safety",
    entries: [
      { kind: "reliability", label: "Fix a connection" },
      { kind: "security", label: "Share safely" },
      { kind: "e2ee", label: "Passwords & encryption" },
    ],
  },
  {
    section: "Reference",
    entries: [
      { kind: "cli", label: "Command reference" },
      { kind: "self-hosting", label: "Run your own relay" },
    ],
  },
];

const DOCUMENTATION_KIND_PATTERN = DOCUMENTATION_KINDS.join("|");
const VERSIONED_SUBPAGE_PATTERN = DOCUMENTATION_KINDS.filter(
  (kind) => kind !== "docs",
).join("|");
const SHORT_DOCUMENTATION_ROUTE = new RegExp(
  `^/(${DOCUMENTATION_KIND_PATTERN})/?$`,
);
const VERSIONED_DOCUMENTATION_ROUTE = new RegExp(
  `^/docs/v(\\d+\\.\\d+\\.\\d+)(?:/(${VERSIONED_SUBPAGE_PATTERN}))?/?$`,
);

export function resolveDocumentationRoute(
  pathname: string,
  currentVersion: string,
): DocumentationRoute | null {
  const shortRoute = pathname.match(SHORT_DOCUMENTATION_ROUTE);
  if (shortRoute) {
    return {
      kind: shortRoute[1] as DocumentationKind,
      version: currentVersion,
    };
  }
  const versionedRoute = pathname.match(VERSIONED_DOCUMENTATION_ROUTE);
  if (!versionedRoute) return null;
  return {
    kind: (versionedRoute[2] ?? "docs") as DocumentationKind,
    version: versionedRoute[1],
  };
}

export function documentationHref(
  version: string,
  kind: DocumentationKind,
): string {
  return `/docs/v${version}/${kind === "docs" ? "" : `${kind}/`}`;
}

export function currentDocumentationHref(kind: DocumentationKind): string {
  return `/${kind}/`;
}

export function normalizeDocumentationVersion(value: string): string | null {
  const match = value.match(/^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/);
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

export function isVersionedDocumentationPath(pathname: string): boolean {
  return VERSIONED_DOCUMENTATION_ROUTE.test(pathname);
}

// Never serve today's instructions as the static body of an older release.
export function documentationAssetPath(
  pathname: string,
  currentVersion: string,
): string {
  if (!isVersionedDocumentationPath(pathname)) return pathname;
  const route = resolveDocumentationRoute(pathname, currentVersion)!;
  return route.version === currentVersion
    ? currentDocumentationHref(route.kind)
    : "/docs/archive/";
}

export function resolveAvailableDocumentationKind(
  content: DocumentationContent,
  requested: DocumentationKind,
): DocumentationKind | null {
  if (content.pages[requested]) return requested;
  if (content.pages.docs) return "docs";
  return DOCUMENTATION_KINDS.find((kind) => content.pages[kind]) ?? null;
}

export function nextDocumentationKind(
  content: DocumentationContent,
  current: DocumentationKind,
): DocumentationKind {
  const available = DOCUMENTATION_KINDS.filter((kind) => content.pages[kind]);
  const index = available.indexOf(current);
  return available[(index + 1) % available.length] ?? current;
}

export function isDocumentationContent(
  value: unknown,
  version: string,
): value is DocumentationContent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { version?: unknown; pages?: unknown };
  if (
    candidate.version !== version ||
    typeof candidate.pages !== "object" ||
    candidate.pages === null
  ) {
    return false;
  }
  return DOCUMENTATION_KINDS.every((kind) => {
    const page = (candidate.pages as Record<string, unknown>)[kind];
    if (page === undefined) return true;
    if (typeof page !== "object" || page === null) return false;
    const fields = page as Record<string, unknown>;
    const cardsAreValid =
      Array.isArray(fields.cards) &&
      fields.cards.every(
        (card) =>
          Array.isArray(card) &&
          (card.length === 2 || card.length === 3) &&
          typeof card[0] === "string" &&
          typeof card[1] === "string" &&
          (card[2] === undefined ||
            (Array.isArray(card[2]) &&
              card[2].every(
                (entry) =>
                  Array.isArray(entry) &&
                  entry.length === 2 &&
                  entry.every((item) => typeof item === "string"),
              ))),
      );
    if (
      typeof fields.eyebrow !== "string" ||
      typeof fields.title !== "string" ||
      typeof fields.intro !== "string" ||
      !cardsAreValid
    )
      return false;
    if (fields.diagrams === undefined) return true;
    return (
      Array.isArray(fields.diagrams) &&
      fields.diagrams.every((diagram) => {
        if (typeof diagram !== "object" || diagram === null) return false;
        const diagramFields = diagram as Record<string, unknown>;
        return (
          Number.isInteger(diagramFields.after) &&
          Number(diagramFields.after) > 0 &&
          typeof diagramFields.title === "string" &&
          typeof diagramFields.caption === "string" &&
          typeof diagramFields.desktop === "string" &&
          typeof diagramFields.mobile === "string"
        );
      })
    );
  });
}
