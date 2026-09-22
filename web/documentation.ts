import documentationSource from "../docs/content.json";
import {
  currentDocumentationHref,
  documentationHref,
  isDocumentationContent,
  normalizeDocumentationVersion,
  resolveAvailableDocumentationKind,
  resolveDocumentationRoute,
  type DocumentationContent,
  type DocumentationKind,
  type DocumentationRoute,
} from "../shared/documentation";
import {
  documentationMarkup,
  documentationLabel,
  escapeDocumentation,
  guideHref,
  searchDocumentation,
} from "../shared/documentation-view";
import { trackPublicEvent } from "./analytics";
import "./documentation.css";

const currentContent = documentationSource as DocumentationContent;

export function resolveCurrentDocumentationRoute(
  pathname: string,
): DocumentationRoute | null {
  return resolveDocumentationRoute(pathname, currentContent.version);
}

export async function renderDocumentation(
  app: HTMLElement,
  route: DocumentationRoute,
  renderNotFound: () => void,
): Promise<void> {
  document.documentElement.classList.remove("home-root", "marketing-root");
  document.documentElement.classList.add("guide-root");
  document.body.classList.remove("marketing-body", "knowledge-body");
  const content = await loadDocumentationContent(route.version);
  const kind = content
    ? resolveAvailableDocumentationKind(content, route.kind)
    : null;
  if (!content || !kind || !content.pages[kind]) {
    renderNotFound();
    return;
  }
  if (kind !== route.kind)
    history.replaceState(null, "", documentationHref(route.version, kind));
  const page = content.pages[kind]!;
  const canonical = new URL(
    guideHref(content, currentContent.version, kind),
    location.origin,
  ).href;
  document.title = page.seo?.socialTitle ?? `${page.title} | shell.online`;
  document
    .querySelector('link[rel="canonical"]')
    ?.setAttribute("href", canonical);
  for (const [selector, value] of [
    ['meta[name="description"]', page.seo?.description ?? page.intro],
    ['meta[property="og:title"]', document.title],
    ['meta[property="og:url"]', canonical],
    [
      'meta[property="og:description"]',
      page.seo?.socialDescription ?? page.intro,
    ],
  ])
    document.querySelector(selector)?.setAttribute("content", value);
  const identity = `${content.version}:${kind}`;
  if (app.dataset.documentation !== identity) {
    app.innerHTML = documentationMarkup(content, kind, currentContent.version);
    app.dataset.documentation = identity;
  }
  wireDocumentationControls(kind, content);
  void renderDocumentationDiagrams();
  // A client-rendered archive needs to restore its incoming section anchor.
  if (/^#section-\d{1,3}$/.test(location.hash))
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

async function loadDocumentationContent(
  version: string,
): Promise<DocumentationContent | null> {
  if (version === currentContent.version) return currentContent;
  try {
    const response = await fetch(
      `/api/docs/content?version=${encodeURIComponent(version)}`,
      {
        headers: { Accept: "application/json" },
        cache: "force-cache",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) return null;
    const content: unknown = await response.json();
    return isDocumentationContent(content, version) ? content : null;
  } catch {
    return null;
  }
}

function wireDocumentationControls(
  kind: DocumentationKind,
  content: DocumentationContent,
): void {
  const selectors = [
    ...document.querySelectorAll<HTMLSelectElement>(".docs-version-select"),
  ];
  for (const selector of selectors)
    selector.addEventListener("change", () => {
      const target = normalizeDocumentationVersion(selector.value);
      if (!target) return;
      for (const other of selectors) other.disabled = true;
      void loadDocumentationContent(target).then((next) => {
        if (!next) {
          for (const other of selectors) {
            other.disabled = false;
            other.value = content.version;
          }
          const status =
            document.querySelector<HTMLElement>(".guide-copy-status");
          if (status)
            status.textContent =
              "That version could not be loaded. Your current guide is still available.";
          return;
        }
        location.href = guideHref(
          next,
          currentContent.version,
          resolveAvailableDocumentationKind(next, kind) ?? "docs",
        );
      });
    });
  void fetch("/api/docs/releases", {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  })
    .then(async (response) =>
      response.ok ? (response.json() as Promise<unknown>) : null,
    )
    .then((payload) => {
      if (!payload || typeof payload !== "object") return;
      const releases = (payload as { releases?: unknown }).releases;
      if (!Array.isArray(releases)) return;
      const versions = new Set([content.version, currentContent.version]);
      for (const release of releases) {
        if (!release || typeof release !== "object") continue;
        const value = (release as { version?: unknown }).version;
        if (typeof value === "string" && normalizeDocumentationVersion(value))
          versions.add(normalizeDocumentationVersion(value)!);
      }
      const ordered = [...versions].sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      );
      for (const selector of selectors)
        selector.replaceChildren(
          ...ordered.map((version) => {
            const option = document.createElement("option");
            option.value = version;
            option.textContent = `v${version}${version === currentContent.version ? " · current" : ""}`;
            option.selected = version === content.version;
            return option;
          }),
        );
    })
    .catch(() => undefined);

  const input = document.querySelector<HTMLInputElement>("#docs-search");
  const results = document.querySelector<HTMLElement>("#docs-search-results");
  const status = document.querySelector<HTMLElement>("#docs-search-status");
  if (input && results) {
    input.addEventListener("input", () => {
      const query = input.value.trim();
      if (query.length < 2) {
        results.hidden = true;
        if (status) status.textContent = "";
        return;
      }
      const matches = searchDocumentation(content, query);
      results.innerHTML = matches.length
        ? matches
            .map(
              (m) =>
                `<a href="${guideHref(content, currentContent.version, m.kind)}#section-${m.section}"><small>${escapeDocumentation(documentationLabel(m.kind))}</small><strong>${escapeDocumentation(m.title)}</strong><span>${escapeDocumentation(m.excerpt)}</span></a>`,
            )
            .join("")
        : "<p>No matching guide. Try a command, “password”, or “offline”.</p>";
      results.hidden = false;
      if (status) status.textContent = `${matches.length} matching sections.`;
    });
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.focus();
      }
      if (event.key === "Escape" && !results.hidden) {
        results.hidden = true;
        input.focus();
      }
      if (
        results.hidden ||
        !input.closest(".guide-search")?.contains(document.activeElement)
      )
        return;
      const links = [...results.querySelectorAll<HTMLAnchorElement>("a")];
      if (!links.length) return;
      const at = links.indexOf(document.activeElement as HTMLAnchorElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        links[(at + 1) % links.length].focus();
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        links[(at - 1 + links.length) % links.length].focus();
      }
      if (event.key === "Enter" && document.activeElement === input) {
        event.preventDefault();
        links[0].click();
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (!input.closest(".guide-search")?.contains(event.target as Node))
        results.hidden = true;
    });
  }
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  document
    .querySelectorAll<HTMLButtonElement>("[data-doc-copy]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const command = button
          .closest(".guide-code")
          ?.querySelector("code")?.textContent;
        if (!command) return;
        const status =
          document.querySelector<HTMLElement>(".guide-copy-status");
        try {
          if (!navigator.clipboard?.writeText)
            throw new Error("Clipboard unavailable");
          await navigator.clipboard.writeText(command);
          button.textContent = "Copied";
          if (status)
            status.textContent = "Copied. Run this on the host computer.";
          trackPublicEvent("copy", "docs_command");
        } catch {
          if (status)
            status.textContent =
              "Could not copy. Select the command and copy it manually.";
        }
        clearTimeout(feedbackTimer);
        feedbackTimer = setTimeout(() => {
          if (status) status.textContent = "";
        }, 5000);
        setTimeout(() => {
          button.textContent = "Copy";
        }, 2000);
      });
    });
}

async function renderDocumentationDiagrams(): Promise<void> {
  const figures = Array.from(
    document.querySelectorAll<HTMLElement>(".knowledge-diagram"),
  );
  if (figures.length === 0) return;

  // Mermaid measures labels before it draws their nodes. Waiting here prevents
  // a fallback font from producing boxes that are too narrow once web fonts
  // finish loading, which otherwise clips the final characters on slower
  // browsers and mobile connections.
  await document.fonts?.ready;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: {
      background: "#ffffff",
      primaryColor: "#f0efff",
      primaryTextColor: "#0a2540",
      primaryBorderColor: "#8e88ff",
      secondaryColor: "#ecf7ff",
      secondaryTextColor: "#0a2540",
      secondaryBorderColor: "#80bfff",
      tertiaryColor: "#f6f9fc",
      tertiaryTextColor: "#425466",
      tertiaryBorderColor: "#cbd6e2",
      lineColor: "#697386",
      edgeLabelBackground: "#ffffff",
      fontFamily:
        "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      fontSize: "14px",
    },
    flowchart: {
      curve: "basis",
      htmlLabels: false,
      useMaxWidth: true,
      padding: 18,
      nodeSpacing: 34,
      rankSpacing: 42,
    },
  });

  const compact = window.matchMedia("(max-width: 720px)");
  let renderGeneration = 0;
  const renderAll = async (): Promise<void> => {
    const generation = ++renderGeneration;
    const layout = compact.matches ? "mobile" : "desktop";
    for (const [index, figure] of figures.entries()) {
      if (generation !== renderGeneration) return;
      if (figure.dataset.renderedLayout === layout) continue;
      const canvas = figure.querySelector<HTMLElement>(
        ".knowledge-diagram-canvas",
      );
      const source =
        layout === "mobile"
          ? figure.dataset.mermaidMobile
          : figure.dataset.mermaidDesktop;
      if (!canvas || !source) continue;
      canvas.setAttribute("aria-busy", "true");
      try {
        const id = `docs-mermaid-${generation}-${index}`;
        const { svg, bindFunctions } = await mermaid.render(id, source);
        if (generation !== renderGeneration) return;
        canvas.innerHTML = svg;
        bindFunctions?.(canvas);
        figure.dataset.renderedLayout = layout;
      } catch {
        canvas.innerHTML = "<span>Diagram unavailable.</span>";
      } finally {
        canvas.setAttribute("aria-busy", "false");
      }
    }
  };
  compact.addEventListener("change", () => {
    void renderAll();
  });
  await renderAll();
}
