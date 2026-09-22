import { describe, expect, it } from "vitest";
import source from "../docs/content.json";
import { sourceBuildCommands } from "../shared/source-build";
import {
  DOCUMENTATION_KINDS,
  documentationAssetPath,
  isDocumentationContent,
  resolveDocumentationRoute,
  type DocumentationContent,
} from "../shared/documentation";
import {
  documentationInline,
  documentationMarkup,
  isDocumentationCommand,
  searchDocumentation,
} from "../shared/documentation-view";

const content = source as DocumentationContent;
describe("task-first documentation", () => {
  it("keeps both source-build recipes pinned to this release and in the install guide", () => {
    const guide = content.pages.platforms!;
    expect(guide.cards[3][0]).toBe("Build the CLI from source");
    const examples = guide.cards[3][2]!.map(([command]) => command);
    for (const windows of [false, true]) {
      const command = sourceBuildCommands(content.version, windows);
      expect(examples).toContain(command);
      expect(command).toContain(`--branch v${content.version}`);
      expect(command).toContain(`-X main.version=${content.version}`);
      expect(command).not.toContain("sudo");
    }
  });
  it("renders every guide with its full static body, accessible navigation and unique section anchors", () => {
    expect(isDocumentationContent(content, content.version)).toBe(true);
    for (const kind of DOCUMENTATION_KINDS) {
      const html = documentationMarkup(content, kind, content.version);
      expect(html.match(/<h1>/g)).toHaveLength(1);
      expect(
        html.match(/class="guide-section" id="section-\d+"/g),
      ).toHaveLength(content.pages[kind]!.cards.length);
      expect(html).toContain('aria-current="page"');
      const commands = content.pages[kind]!.cards.flatMap(
        (c) => c[2] ?? [],
      ).filter(([term]) => isDocumentationCommand(term));
      expect(html.match(/aria-label="Copy command"/g) ?? []).toHaveLength(
        commands.length,
      );
      expect(html).toContain('id="docs-search"');
      expect(html).not.toContain("undefined");
    }
  });
  it("escapes archived content and code, and does not allow unsafe inline links", () => {
    expect(
      documentationInline('<img src=x onerror="alert(1)"> `shell <ID>`'),
    ).toContain("&lt;img");
    expect(documentationInline("`shell <ID>`")).toBe(
      "<code>shell &lt;ID&gt;</code>",
    );
    for (const target of [
      "javascript:bad",
      "data:text/html,bad",
      "//bad.example",
      "/\\bad.example",
      "https://bad.example/\\x",
    ]) {
      expect(documentationInline(`[unsafe](${target})`)).not.toContain("<a ");
    }
    expect(documentationInline("[Safe](/agents/)")).toBe(
      '<a href="/agents/">Safe</a>',
    );
  });
  it("keeps historical navigation within that version and omits absent guides", () => {
    const archive: DocumentationContent = {
      version: "0.6.0",
      pages: { docs: content.pages.docs },
    };
    const html = documentationMarkup(archive, "docs", content.version);
    expect(html).toContain("You’re reading v0.6.0");
    expect(html).toContain('href="/docs/v0.6.0/"');
    expect(html).not.toContain("Connect an agent · MCP");
    expect(
      documentationAssetPath("/docs/v0.6.0/mobile/", content.version),
    ).toBe("/docs/archive/");
    expect(
      documentationAssetPath(
        `/docs/v${content.version}/mobile/`,
        content.version,
      ),
    ).toBe("/mobile/");
    expect(resolveDocumentationRoute("/agents/", content.version)?.kind).toBe(
      "agents",
    );
  });
  it("searches commands and problems locally, bounds results and points to existing sections", () => {
    expect(searchDocumentation(content, "")).toEqual([]);
    expect(searchDocumentation(content, "x")).toEqual([]);
    expect(searchDocumentation(content, "NOT_A_REAL_DOC_TOPIC")).toEqual([]);
    for (const query of ["password", "offline", "shell mcp grant"]) {
      const found = searchDocumentation(content, query);
      expect(found.length).toBeGreaterThan(0);
      expect(found.length).toBeLessThanOrEqual(8);
      for (const match of found)
        expect(
          content.pages[match.kind]!.cards[match.section - 1],
        ).toBeDefined();
    }
  });
});
