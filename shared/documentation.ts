export const DOCUMENTATION_KINDS = [
  "docs",
  "cli",
  "platforms",
  "mobile",
  "reliability",
  "security",
  "e2ee",
  "docker",
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
    section: "Get started",
    entries: [
      { kind: "docs", label: "Overview" },
      { kind: "platforms", label: "Platforms and devices" },
    ],
  },
  {
    section: "Terminal experience",
    entries: [
      { kind: "mobile", label: "Mobile terminals" },
      { kind: "reliability", label: "Reliability" },
    ],
  },
  {
    section: "Operations and trust",
    entries: [
      { kind: "security", label: "Security model" },
      { kind: "e2ee", label: "End-to-end encryption" },
      { kind: "docker", label: "Persistent Docker" },
    ],
  },
  {
    section: "Reference",
    entries: [{ kind: "cli", label: "CLI reference" }],
  },
];

const DOCUMENTATION_KIND_PATTERN = DOCUMENTATION_KINDS.join("|");
const VERSIONED_SUBPAGE_PATTERN = DOCUMENTATION_KINDS
  .filter((kind) => kind !== "docs")
  .join("|");
const SHORT_DOCUMENTATION_ROUTE = new RegExp(`^/(${DOCUMENTATION_KIND_PATTERN})/?$`);
const VERSIONED_DOCUMENTATION_ROUTE = new RegExp(
  `^/docs/v(\\d+\\.\\d+\\.\\d+)(?:/(${VERSIONED_SUBPAGE_PATTERN}))?/?$`,
);

export function resolveDocumentationRoute(
  pathname: string,
  currentVersion: string,
): DocumentationRoute | null {
  const shortRoute = pathname.match(SHORT_DOCUMENTATION_ROUTE);
  if (shortRoute) {
    return { kind: shortRoute[1] as DocumentationKind, version: currentVersion };
  }
  const versionedRoute = pathname.match(VERSIONED_DOCUMENTATION_ROUTE);
  if (!versionedRoute) return null;
  return {
    kind: (versionedRoute[2] ?? "docs") as DocumentationKind,
    version: versionedRoute[1],
  };
}

export function documentationHref(version: string, kind: DocumentationKind): string {
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
  if (candidate.version !== version || typeof candidate.pages !== "object" || candidate.pages === null) {
    return false;
  }
  return DOCUMENTATION_KINDS.every((kind) => {
    const page = (candidate.pages as Record<string, unknown>)[kind];
    if (page === undefined) return true;
    if (typeof page !== "object" || page === null) return false;
    const fields = page as Record<string, unknown>;
    return typeof fields.eyebrow === "string" && typeof fields.title === "string" &&
      typeof fields.intro === "string" && Array.isArray(fields.cards) &&
      fields.cards.every((card) => Array.isArray(card) && (card.length === 2 || card.length === 3) &&
        typeof card[0] === "string" && typeof card[1] === "string" &&
        (card[2] === undefined || (Array.isArray(card[2]) && card[2].every((entry) =>
          Array.isArray(entry) && entry.length === 2 && entry.every((item) => typeof item === "string")))));
  });
}
