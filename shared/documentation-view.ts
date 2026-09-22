import {
  DOCUMENTATION_NAVIGATION,
  currentDocumentationHref,
  documentationHref,
  type DocumentationContent,
  type DocumentationKind,
} from "./documentation";

export function escapeDocumentation(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

export function documentationLabel(kind: DocumentationKind): string {
  return (
    DOCUMENTATION_NAVIGATION.flatMap((g) => g.entries).find(
      (e) => e.kind === kind,
    )?.label ?? kind
  );
}

export function guideHref(
  content: DocumentationContent,
  currentVersion: string,
  kind: DocumentationKind,
): string {
  return content.version === currentVersion
    ? currentDocumentationHref(kind)
    : documentationHref(content.version, kind);
}

// Deliberately small inline syntax, not HTML. Archived release content is data.
export function documentationInline(value: string): string {
  let out = "",
    end = 0;
  for (const m of value.matchAll(/`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    out += escapeDocumentation(value.slice(end, m.index));
    if (m[1]) out += `<code>${escapeDocumentation(m[1])}</code>`;
    else {
      const safe =
        !/[\\\u0000-\u0020\u007f]/.test(m[3]) &&
        (/^\/(?!\/)/.test(m[3]) || /^https:\/\//.test(m[3]));
      out += safe
        ? `<a href="${escapeDocumentation(m[3])}">${escapeDocumentation(m[2])}</a>`
        : escapeDocumentation(m[2]);
    }
    end = m.index! + m[0].length;
  }
  return out + escapeDocumentation(value.slice(end));
}

export function isDocumentationCommand(value: string): boolean {
  return /^(shell(?:\s|$)|curl |irm |brew |docker |git |cd |npm |npx |SHELL_ONLINE_[A-Z_]+=)/.test(
    value,
  );
}

export interface DocumentationMatch {
  kind: DocumentationKind;
  section: number;
  title: string;
  excerpt: string;
}
export function searchDocumentation(
  content: DocumentationContent,
  query: string,
): DocumentationMatch[] {
  const words = query
    .trim()
    .toLowerCase()
    .slice(0, 120)
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || query.trim().length < 2) return [];
  const matches: (DocumentationMatch & { score: number })[] = [];
  for (const { entries } of DOCUMENTATION_NAVIGATION)
    for (const { kind } of entries) {
      const page = content.pages[kind];
      page?.cards.forEach(([title, copy, terms], index) => {
        const text =
          `${page.title} ${title} ${copy} ${terms?.flat().join(" ") ?? ""}`.toLowerCase();
        if (words.every((word) => text.includes(word)))
          matches.push({
            kind,
            section: index + 1,
            title,
            excerpt: copy.replace(/`/g, "").slice(0, 135),
            score: words.filter((w) => title.toLowerCase().includes(w)).length,
          });
      });
    }
  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score: _, ...match }) => match);
}

export function documentationMarkup(
  content: DocumentationContent,
  kind: DocumentationKind,
  currentVersion: string,
): string {
  const page = content.pages[kind];
  if (!page) throw new Error("Missing documentation page");
  const esc = escapeDocumentation,
    inline = documentationInline;
  const href = (k: DocumentationKind) => guideHref(content, currentVersion, k);
  const available = DOCUMENTATION_NAVIGATION.flatMap((g) => g.entries).filter(
    (e) => content.pages[e.kind],
  );
  const at = available.findIndex((e) => e.kind === kind),
    next = available[at + 1],
    previous = available[at - 1];
  const groups = DOCUMENTATION_NAVIGATION.map(
    (g) =>
      `<div class="guide-nav-group"><p>${esc(g.section)}</p>${g.entries
        .filter((e) => content.pages[e.kind])
        .map(
          (e) =>
            `<a href="${href(e.kind)}"${e.kind === kind ? ' aria-current="page"' : ""}>${esc(e.label)}</a>`,
        )
        .join("")}</div>`,
  ).join("");
  const toc = page.cards
    .map(([title], i) => `<a href="#section-${i + 1}">${esc(title)}</a>`)
    .join("");
  const version = `<label class="guide-version">Version<select class="docs-version-select" aria-label="Documentation version"><option value="${esc(content.version)}">v${esc(content.version)}${content.version === currentVersion ? " · current" : ""}</option></select></label>`;
  const cards = page.cards
    .map(
      ([title, copy, entries], i) =>
        `<section class="guide-section" id="section-${i + 1}"><h2><a href="#section-${i + 1}">${esc(title)}</a></h2>${copy
          .split("\n\n")
          .map((p) => `<p>${inline(p)}</p>`)
          .join("")}${
          entries
            ? `<dl class="guide-reference">${entries
                .map(([term, meaning]) => {
                  const command = isDocumentationCommand(term);
                  return `<div class="${command ? "guide-example" : "guide-definition"}"><dt>${command ? `<div class="guide-code"><pre><code>${esc(term)}</code></pre><button type="button" data-doc-copy aria-label="Copy command">Copy</button></div>` : `<span>${inline(term)}</span>`}</dt><dd>${inline(meaning)}</dd></div>`;
                })
                .join("")}</dl>`
            : ""
        }${(page.diagrams ?? [])
          .filter((d) => d.after === i + 1)
          .map(
            (d) =>
              `<figure class="knowledge-diagram" data-mermaid-desktop="${esc(d.desktop)}" data-mermaid-mobile="${esc(d.mobile)}"><figcaption><strong>${esc(d.title)}</strong><span>${esc(d.caption)}</span></figcaption><div class="knowledge-diagram-canvas" role="img" aria-label="${esc(d.title)}" aria-busy="true">Loading diagram…</div></figure>`,
          )
          .join("")}</section>`,
    )
    .join("");
  const starts: [DocumentationKind, string, string][] = [
    ["mobile", "Use your phone", "Scroll, type and keep work moving."],
    ["security", "Share with someone", "Choose who can watch or type."],
    ["agents", "Connect another agent", "Give it limited MCP access."],
    ["reliability", "Something isn’t working", "Find the cause and next step."],
  ];
  return `<div class="guide"><a class="guide-skip" href="#guide-content">Skip to content</a>
    <header class="guide-header"><a class="guide-logo" href="/">shell.online</a><a class="guide-docs-link" href="${href("docs")}">Docs</a><nav aria-label="Site"><a href="https://app.shell.online/">Open app ↗</a><a href="https://github.com/TeoSlayer/shell.online" class="guide-source">Source ↗</a></nav></header>
    <div class="guide-tools"><details class="guide-mobile-nav"><summary>Browse docs</summary><nav aria-label="Mobile guides">${groups}${version}</nav></details>
      <div class="guide-search"><label for="docs-search" class="guide-sr">Search all guides</label><input id="docs-search" type="search" placeholder="Search guides, commands, problems…" autocomplete="off" maxlength="120" aria-controls="docs-search-results"><kbd aria-hidden="true">⌘ K</kbd><div id="docs-search-results" class="guide-search-results" hidden></div><span class="guide-sr" role="status" id="docs-search-status"></span></div>
    </div>
    <div class="guide-layout"><aside class="guide-sidebar"><nav aria-label="Guides">${groups}</nav>${version}</aside>
      <main id="guide-content" class="guide-article" tabindex="-1"><div class="guide-breadcrumb"><a href="${href("docs")}">Docs</a><span>/</span>${esc(page.eyebrow)}</div>
        ${content.version !== currentVersion ? `<p class="guide-notice">You’re reading v${esc(content.version)}. <a href="${currentDocumentationHref(kind)}">Read the current guide →</a></p>` : ""}
        <h1>${esc(page.title)}</h1><p class="guide-intro">${esc(page.intro)}</p>
        ${
          kind === "docs"
            ? `<div class="guide-start-links">${starts
                .filter(([k]) => content.pages[k])
                .map(
                  ([k, title, description]) =>
                    `<a href="${href(k)}"><strong>${title} <span aria-hidden="true">↗</span></strong><span>${description}</span></a>`,
                )
                .join("")}</div>`
            : ""
        }
        <details class="guide-mobile-toc"><summary>On this page</summary><nav aria-label="Sections">${toc}</nav></details>
        ${cards}<p class="guide-copy-status" role="status" aria-live="polite"></p>
        <nav class="guide-pagination" aria-label="More guides">${previous ? `<a href="${href(previous.kind)}"><small>Previous</small>← ${esc(previous.label)}</a>` : "<span></span>"}${next ? `<a href="${href(next.kind)}"><small>Next</small>${esc(next.label)} →</a>` : ""}</nav>
      </main><aside class="guide-toc"><p>On this page</p><nav aria-label="Sections">${toc}</nav><a class="guide-release" href="https://github.com/TeoSlayer/shell.online/releases/tag/v${esc(content.version)}">v${esc(content.version)} · Release notes ↗</a></aside>
    </div><footer class="guide-footer"><a href="/">shell.online</a><span>Your terminal. Wherever you need it.</span><a href="https://github.com/TeoSlayer/shell.online/issues">Report a docs issue ↗</a></footer></div>`;
}
