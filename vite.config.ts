import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";
import documentationSource from "./docs/content.json" with { type: "json" };
import {
  DOCUMENTATION_KINDS,
  type DocumentationContent,
  type DocumentationKind,
} from "./shared/documentation.ts";

const documentation = documentationSource as DocumentationContent;

function documentationPages(): Plugin {
  return {
    name: "documentation-pages",
    enforce: "post",
    generateBundle(_, bundle) {
      const template = Object.values(bundle).find(
        (output) => output.type === "asset" && output.fileName === "web/documentation.html",
      );
      if (!template || template.type !== "asset") {
        this.error("Vite did not emit the documentation template");
        return;
      }
      const source = typeof template.source === "string"
        ? template.source
        : new TextDecoder().decode(template.source);
      for (const kind of DOCUMENTATION_KINDS) {
        const page = documentation.pages[kind];
        if (!page?.seo) this.error(`Documentation metadata is missing for ${kind}`);
        this.emitFile({
          type: "asset",
          fileName: `${kind}/index.html`,
          source: renderDocumentationPage(source, kind),
        });
      }
      delete bundle[template.fileName];
    },
  };
}

function renderDocumentationPage(template: string, kind: DocumentationKind): string {
  const seo = documentation.pages[kind]?.seo;
  if (!seo) throw new Error(`Documentation metadata is missing for ${kind}`);
  return template
    .replaceAll("__DOC_PATH__", kind)
    .replaceAll("__DOC_DESCRIPTION__", escapeHtml(seo.description))
    .replaceAll("__DOC_SOCIAL_TITLE__", escapeHtml(seo.socialTitle))
    .replaceAll("__DOC_SOCIAL_DESCRIPTION__", escapeHtml(seo.socialDescription));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export default defineConfig({
  plugins: [documentationPages()],
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        documentation: resolve(import.meta.dirname, "web/documentation.html"),
      },
    },
  },
});
