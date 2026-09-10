import { describe, expect, it } from "vitest";
import {
  documentationHref,
  isDocumentationContent,
  isVersionedDocumentationPath,
  nextDocumentationKind,
  normalizeDocumentationVersion,
  resolveAvailableDocumentationKind,
  resolveDocumentationRoute,
  type DocumentationContent,
} from "../shared/documentation";

const historicalContent: DocumentationContent = {
  version: "0.6.0",
  pages: {
    docs: { eyebrow: "Docs", title: "Overview", intro: "Intro", cards: [] },
    mobile: { eyebrow: "Mobile", title: "Mobile", intro: "Intro", cards: [] },
    security: { eyebrow: "Security", title: "Security", intro: "Intro", cards: [] },
  },
};

describe("documentation routes", () => {
  it("resolves current and versioned routes", () => {
    expect(resolveDocumentationRoute("/cli/", "0.11.2")).toEqual({ kind: "cli", version: "0.11.2" });
    expect(resolveDocumentationRoute("/docs/v0.6.0/mobile/", "0.11.2")).toEqual({ kind: "mobile", version: "0.6.0" });
    expect(resolveDocumentationRoute("/docs/v0.6.0/", "0.11.2")).toEqual({ kind: "docs", version: "0.6.0" });
    expect(resolveDocumentationRoute("/docs/v0.6/mobile/", "0.11.2")).toBeNull();
  });

  it("falls back to the release overview when a newer page did not exist", () => {
    expect(resolveAvailableDocumentationKind(historicalContent, "cli")).toBe("docs");
    expect(documentationHref("0.6.0", "docs")).toBe("/docs/v0.6.0/");
  });

  it("skips unavailable pages in continue navigation", () => {
    expect(nextDocumentationKind(historicalContent, "docs")).toBe("mobile");
    expect(nextDocumentationKind(historicalContent, "mobile")).toBe("security");
    expect(nextDocumentationKind(historicalContent, "security")).toBe("docs");
  });

  it("recognizes versioned document paths only", () => {
    expect(isVersionedDocumentationPath("/docs/v0.6.0/security/")).toBe(true);
    expect(isVersionedDocumentationPath("/docs/v0.6.0/")).toBe(true);
    expect(isVersionedDocumentationPath("/docs/")).toBe(false);
  });

  it("normalizes selector versions before constructing a navigation URL", () => {
    expect(normalizeDocumentationVersion("0.06.002")).toBe("0.6.2");
    expect(normalizeDocumentationVersion("javascript:alert(1)")).toBeNull();
    expect(normalizeDocumentationVersion("1.2.3/../../")).toBeNull();
  });

  it("accepts historical content with missing newer pages", () => {
    expect(isDocumentationContent(historicalContent, "0.6.0")).toBe(true);
    expect(isDocumentationContent(historicalContent, "0.7.0")).toBe(false);
  });
});
