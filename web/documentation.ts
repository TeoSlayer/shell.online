import documentationSource from "../docs/content.json";
import { GITHUB_REPOSITORY_URL } from "../shared/github";
import {
  currentDocumentationHref,
  DOCUMENTATION_KINDS,
  DOCUMENTATION_NAVIGATION,
  documentationHref,
  isDocumentationContent,
  nextDocumentationKind,
  normalizeDocumentationVersion,
  resolveAvailableDocumentationKind,
  resolveDocumentationRoute,
  type DocumentationContent,
  type DocumentationKind,
  type DocumentationPage,
  type DocumentationRoute,
} from "../shared/documentation";

const currentContent = documentationSource as DocumentationContent;

export function resolveCurrentDocumentationRoute(pathname: string): DocumentationRoute | null {
  return resolveDocumentationRoute(pathname, currentContent.version);
}

export async function renderDocumentation(
  app: HTMLElement,
  route: DocumentationRoute,
  renderNotFound: () => void,
): Promise<void> {
  const content = await loadDocumentationContent(route.version);
  const kind = content ? resolveAvailableDocumentationKind(content, route.kind) : null;
  const page = kind && content?.pages[kind];
  if (!content || !kind || !page) {
    renderNotFound();
    return;
  }

  if (kind !== route.kind) {
    history.replaceState(null, "", documentationHref(route.version, kind));
  }

  const docsLink = (target: DocumentationKind): string => documentationHref(route.version, target);
  const availableKinds = DOCUMENTATION_KINDS.filter((candidate) => content.pages[candidate]);
  const nextKind = nextDocumentationKind(content, kind);
  const nextLabel = navigationLabel(nextKind);

  applyDocumentationMetadata(kind, route.version, page);
  document.documentElement.classList.add("marketing-root");
  document.body.classList.add("marketing-body", "knowledge-body");
  app.innerHTML = `
    <section class="marketing assurance-page">
      <header class="marketing-nav knowledge-nav">
        <a class="wordmark knowledge-wordmark" href="/docs/" aria-label="shell.online documentation"><span>shell</span><i>.</i>online<b>Docs</b></a>
        <details class="knowledge-mobile-menu">
          <summary aria-label="Open documentation navigation"><span aria-hidden="true"></span>Menu</summary>
          <nav aria-label="Mobile documentation navigation">
            <label>Version<select class="docs-version-select" id="docs-version-mobile" aria-label="Documentation version"><option value="${escapeText(route.version)}">v${escapeText(route.version)}</option></select></label>
            ${availableKinds.map((candidate) => documentationLink(candidate, kind, docsLink)).join("")}
          </nav>
        </details>
        <nav class="marketing-links" aria-label="Documentation navigation">
          <label class="knowledge-search"><span aria-hidden="true">⌕</span><input id="docs-search" type="search" placeholder="Search docs" autocomplete="off" aria-label="Search documentation" /><kbd>⌘ K</kbd></label>
          <a href="${GITHUB_REPOSITORY_URL}" target="_blank" rel="noreferrer">GitHub ↗</a>
        </nav>
      </header>
      <main class="knowledge-layout">
        <aside class="knowledge-sidebar" aria-label="Knowledge base">
          <div class="knowledge-version"><span>Documentation</span><select class="docs-version-select" id="docs-version" aria-label="Documentation version"><option value="${escapeText(route.version)}">v${escapeText(route.version)}</option></select></div>
          <a class="knowledge-home" href="${docsLink("docs")}">shell.online docs</a>
          ${DOCUMENTATION_NAVIGATION.map(({ section, entries }) => {
            const availableEntries = entries.filter(({ kind: candidate }) => content.pages[candidate]);
            if (availableEntries.length === 0) return "";
            return `<div><p>${escapeText(section)}</p>${availableEntries.map(({ kind: candidate }) => documentationLink(candidate, kind, docsLink)).join("")}${section === "Reference" ? `<a href="${GITHUB_REPOSITORY_URL}">Source ↗</a>` : ""}</div>`;
          }).join("")}
        </aside>
        <article class="knowledge-article">
          <div class="knowledge-breadcrumb"><a href="${docsLink("docs")}">Docs</a><span>/</span>v${escapeText(route.version)}<span>/</span>${escapeText(page.eyebrow)}</div>
          <p class="assurance-eyebrow">${escapeText(page.eyebrow)}</p>
          <h1>${escapeText(page.title)}</h1>
          <p class="assurance-intro">${escapeText(page.intro)}</p>
          ${documentationCommand(kind)}
          <div class="knowledge-sections">
            ${page.cards.map(([title, copy, entries], index) => `<section id="section-${index + 1}"><span>${String(index + 1).padStart(2, "0")}</span><h2>${escapeText(title)}</h2><p>${escapeText(copy)}</p>${entries ? `<dl class="knowledge-reference-list">${entries.map(([term, description]) => `<div><dt><code>${escapeText(term)}</code></dt><dd>${escapeText(description)}</dd></div>`).join("")}</dl>` : ""}</section>`).join("")}
          </div>
          <nav class="knowledge-next" aria-label="Continue reading"><span>Continue reading</span><a href="${docsLink(nextKind)}">${escapeText(nextLabel)} →</a></nav>
        </article>
        <aside class="knowledge-toc" aria-label="On this page"><p>On this page</p>${page.cards.map(([title], index) => `<a href="#section-${index + 1}">${escapeText(title)}</a>`).join("")}<div class="knowledge-release"><span>Release</span><strong>v${escapeText(route.version)}</strong><a href="${GITHUB_REPOSITORY_URL}/releases/tag/v${escapeText(route.version)}">View release notes ↗</a></div></aside>
      </main>
      <footer class="marketing-footer">
        <a class="wordmark" href="/"><span>shell</span><i>.</i>online</a>
        <p>Live browser terminals for the work your machine is already doing.</p>
        <nav>${availableKinds.map((candidate) => `<a href="${docsLink(candidate)}">${escapeText(navigationLabel(candidate))}</a>`).join("")}<a href="${GITHUB_REPOSITORY_URL}">Source</a></nav>
      </footer>
    </section>`;

  wireDocumentationControls(kind, route.version, content);
}

async function loadDocumentationContent(version: string): Promise<DocumentationContent | null> {
  if (version === currentContent.version) return currentContent;
  try {
    const response = await fetch(`/api/docs/content?version=${encodeURIComponent(version)}`, {
      headers: { Accept: "application/json" },
      cache: "force-cache",
    });
    if (!response.ok) return null;
    const content: unknown = await response.json();
    return isDocumentationContent(content, version) ? content : null;
  } catch {
    return null;
  }
}

function navigationLabel(kind: DocumentationKind): string {
  for (const group of DOCUMENTATION_NAVIGATION) {
    const entry = group.entries.find((candidate) => candidate.kind === kind);
    if (entry) return entry.label;
  }
  return kind;
}

function documentationLink(
  candidate: DocumentationKind,
  current: DocumentationKind,
  href: (kind: DocumentationKind) => string,
): string {
  return `<a class="${candidate === current ? "active" : ""}" href="${href(candidate)}">${escapeText(navigationLabel(candidate))}</a>`;
}

function documentationCommand(kind: DocumentationKind): string {
  if (kind === "docs") return `<pre class="knowledge-command"><code><span>$</span> curl -fsSL https://shell.online/install | sh
<span>$</span> shell --read-only python train.py</code></pre>`;
  if (kind === "e2ee") return `<pre class="knowledge-command"><code><span>$</span> shell &lt;command&gt;
<span>$</span> SHELL_ONLINE_E2EE_PASSWORD='…' shell &lt;command&gt;</code></pre>`;
  if (kind === "docker") return `<pre class="knowledge-command"><code><span>$</span> docker compose up --build -d
<span>$</span> docker compose logs shell-online</code></pre>`;
  if (kind === "self-hosting") return `<pre class="knowledge-command"><code><span>$</span> cd standalone
<span>$</span> SHELL_ONLINE_PUBLIC_URL=https://relay.example.com \\
  SHELL_ONLINE_SITE=relay.example.com docker compose up -d --build</code></pre>`;
  if (kind === "platforms") return `<pre class="knowledge-command"><code><span>$</span> shell ros2 launch &lt;package&gt; &lt;launch-file&gt;
<span>PS&gt;</span> irm https://shell.online/install.ps1 | iex</code></pre>`;
  if (kind === "cli") return `<pre class="knowledge-command"><code><span>$</span> shell help reference
<span>$</span> shell [options] -- &lt;command&gt; [arguments...]</code></pre>`;
  return "";
}

function applyDocumentationMetadata(
  kind: DocumentationKind,
  version: string,
  page: DocumentationPage,
): void {
  const isCurrent = version === currentContent.version;
  const canonicalPath = isCurrent ? currentDocumentationHref(kind) : documentationHref(version, kind);
  const canonical = new URL(canonicalPath, window.location.origin).href;
  const title = `${page.eyebrow}${isCurrent ? "" : ` · v${version}`} | shell.online`;
  document.title = title;
  document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", canonical);
  setMeta('meta[name="description"]', page.seo?.description ?? page.intro);
  setMeta('meta[property="og:url"]', canonical);
  setMeta('meta[property="og:title"]', page.seo?.socialTitle ?? title);
  setMeta('meta[property="og:description"]', page.seo?.socialDescription ?? page.intro);
}

function setMeta(selector: string, value: string): void {
  document.querySelector<HTMLMetaElement>(selector)?.setAttribute("content", value);
}

function wireDocumentationControls(
  kind: DocumentationKind,
  version: string,
  content: DocumentationContent,
): void {
  const selectors = Array.from(document.querySelectorAll<HTMLSelectElement>(".docs-version-select"));
  const searchInput = document.querySelector<HTMLInputElement>("#docs-search");
  const searchShell = searchInput?.closest<HTMLElement>(".knowledge-search");
  for (const selector of selectors) {
    selector.addEventListener("change", () => {
      const targetVersion = normalizeDocumentationVersion(selector.value);
      if (!targetVersion) return;
      for (const candidate of selectors) candidate.disabled = true;
      void loadDocumentationContent(targetVersion).then((targetContent) => {
        const targetKind = targetContent
          ? resolveAvailableDocumentationKind(targetContent, kind) ?? "docs"
          : "docs";
        window.location.href = documentationHref(targetVersion, targetKind);
      });
    });
  }
  if (selectors.length > 0) {
    void fetch("/api/docs/releases", { headers: { Accept: "application/json" } })
      .then(async (response) => response.ok ? response.json() as Promise<unknown> : null)
      .then((payload) => {
        if (typeof payload !== "object" || payload === null) return;
        const releases = (payload as { releases?: unknown }).releases;
        if (!Array.isArray(releases)) return;
        const versions = new Set([version]);
        for (const release of releases) {
          if (typeof release !== "object" || release === null) continue;
          const candidate = (release as { version?: unknown }).version;
          if (typeof candidate === "string" && /^\d+\.\d+\.\d+$/.test(candidate)) versions.add(candidate);
        }
        const ordered = Array.from(versions).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
        for (const selector of selectors) {
          selector.replaceChildren(...ordered.map((candidate) => {
            const option = document.createElement("option");
            option.value = candidate;
            option.textContent = `v${candidate}${candidate === currentContent.version ? " · current" : ""}`;
            option.selected = candidate === version;
            return option;
          }));
        }
      })
      .catch(() => undefined);
  }

  if (!searchInput || !searchShell) return;
  const results = document.createElement("div");
  results.className = "knowledge-search-results";
  results.hidden = true;
  searchShell.append(results);
  const closeResults = (): void => { results.hidden = true; };
  const renderResults = (): void => {
    const query = searchInput.value.trim().toLocaleLowerCase();
    if (query.length < 2) {
      closeResults();
      return;
    }
    const matches: { kind: DocumentationKind; title: string; section: number }[] = [];
    for (const candidateKind of DOCUMENTATION_KINDS) {
      const candidatePage = content.pages[candidateKind];
      if (!candidatePage) continue;
      candidatePage.cards.forEach(([title, copy, entries], index) => {
        const referenceCopy = entries?.flat().join(" ") ?? "";
        if (`${title} ${copy} ${referenceCopy}`.toLocaleLowerCase().includes(query)) {
          matches.push({ kind: candidateKind, title, section: index + 1 });
        }
      });
    }
    results.innerHTML = matches.length === 0
      ? `<span>No results in v${escapeText(version)}</span>`
      : matches.slice(0, 8).map((match) => `<a href="${documentationHref(version, match.kind)}#section-${match.section}"><small>${escapeText(content.pages[match.kind]?.eyebrow ?? match.kind)}</small>${escapeText(match.title)}</a>`).join("");
    results.hidden = false;
  };
  searchInput.addEventListener("input", renderResults);
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      searchInput.value = "";
      closeResults();
      searchInput.blur();
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault();
      searchInput.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!searchShell.contains(event.target as Node)) closeResults();
  });
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}
