import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import documentationSource from "./docs/content.json" with { type: "json" };
import { landingMarkup } from "./web/landing-markup.ts";
import { documentationMarkup } from "./shared/documentation-view.ts";
import { blogPosts, blogRegistryProblems } from "./shared/blog.ts";
import { renderBlogSite } from "./shared/blog-view.ts";
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
        (output) =>
          output.type === "asset" &&
          output.fileName === "web/documentation.html",
      );
      if (!template || template.type !== "asset") {
        this.error("Vite did not emit the documentation template");
        return;
      }
      const source =
        typeof template.source === "string"
          ? template.source
          : new TextDecoder().decode(template.source);
      for (const kind of DOCUMENTATION_KINDS) {
        const page = documentation.pages[kind];
        if (!page?.seo)
          this.error(`Documentation metadata is missing for ${kind}`);
        this.emitFile({
          type: "asset",
          fileName: `${kind}/index.html`,
          source: renderDocumentationPage(source, kind),
        });
      }
      this.emitFile({
        type: "asset",
        fileName: "docs/archive/index.html",
        source: renderDocumentationPage(source, "docs", true),
      });
      delete bundle[template.fileName];
    },
  };
}

// Every file under /blog/, rendered from blog/posts.json and blog/posts/*.html.
function blogFiles(template: string): Record<string, string> {
  const problems = blogRegistryProblems(blogPosts);
  if (problems.length)
    throw new Error(`blog/posts.json: ${problems.join("; ")}`);
  const bodies = Object.fromEntries(
    blogPosts.map((post) => [
      post.slug,
      readFileSync(
        resolve(import.meta.dirname, `blog/posts/${post.slug}.html`),
        "utf8",
      ),
    ]),
  );
  return renderBlogSite(template, blogPosts, bodies);
}

const BLOG_CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
};

function blogPages(): Plugin {
  return {
    name: "blog-pages",
    enforce: "post",
    generateBundle(_, bundle) {
      const template = Object.values(bundle).find(
        (output) =>
          output.type === "asset" && output.fileName === "web/blog.html",
      );
      if (!template || template.type !== "asset") {
        this.error("Vite did not emit the blog template");
        return;
      }
      const source =
        typeof template.source === "string"
          ? template.source
          : new TextDecoder().decode(template.source);
      for (const [fileName, content] of Object.entries(blogFiles(source)))
        this.emitFile({ type: "asset", fileName, source: content });
      delete bundle[template.fileName];
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split("?")[0] ?? "";
        if (path !== "/blog" && !path.startsWith("/blog/")) return next();
        try {
          // Post bodies are read on every request, so an edit shows on reload.
          const template = await server.transformIndexHtml(
            request.url!,
            readFileSync(resolve(import.meta.dirname, "web/blog.html"), "utf8"),
          );
          const name = path.slice(1).replace(/\/$/, "");
          const fileName = /\.[a-z]+$/.test(name) ? name : `${name}/index.html`;
          const content = blogFiles(template)[fileName];
          // Custom banners live in public/blog/ and are served by Vite itself.
          if (content === undefined && fileName !== `${name}/index.html`)
            return next();
          response.statusCode = content === undefined ? 404 : 200;
          response.setHeader(
            "Content-Type",
            content === undefined
              ? "text/plain; charset=utf-8"
              : BLOG_CONTENT_TYPES[fileName.split(".").pop()!],
          );
          response.end(content ?? "Post not found\n");
        } catch (error) {
          next(error as Error);
        }
      });
    },
  };
}

function renderDocumentationPage(
  template: string,
  kind: DocumentationKind,
  archive = false,
): string {
  const seo = documentation.pages[kind]?.seo;
  if (!seo) throw new Error(`Documentation metadata is missing for ${kind}`);
  return template
    .replaceAll("__DOC_PATH__", kind)
    .replaceAll("__DOC_DESCRIPTION__", escapeHtml(seo.description))
    .replaceAll("__DOC_SOCIAL_TITLE__", escapeHtml(seo.socialTitle))
    .replaceAll("__DOC_SOCIAL_DESCRIPTION__", escapeHtml(seo.socialDescription))
    .replaceAll("__DOC_ID__", archive ? "" : `${documentation.version}:${kind}`)
    .replace(
      "<!--DOCUMENTATION_BODY-->",
      archive
        ? '<main class="guide guide-article"><h1>Loading archived guide…</h1><p><a href="/docs/">Read the current docs</a>. Archived guides need JavaScript to load their release content.</p></main>'
        : documentationMarkup(documentation, kind, documentation.version),
    );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export default defineConfig({
  plugins: [
    documentationPages(),
    blogPages(),
    {
      name: "public-landing-html",
      transformIndexHtml(html) {
        return html.replace("<!--PUBLIC_LANDING-->", landingMarkup());
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const kind = DOCUMENTATION_KINDS.find(
            (k) =>
              request.url?.split("?")[0] === `/${k}/` ||
              request.url?.split("?")[0] === `/${k}`,
          );
          if (!kind) return next();
          try {
            const { readFile } = await import("node:fs/promises");
            const template = await readFile(
              resolve(import.meta.dirname, "web/documentation.html"),
              "utf8",
            );
            const html = await server.transformIndexHtml(
              request.url!,
              renderDocumentationPage(template, kind),
            );
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(html);
          } catch (error) {
            next(error as Error);
          }
        });
      },
    },
  ],
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        documentation: resolve(import.meta.dirname, "web/documentation.html"),
        blog: resolve(import.meta.dirname, "web/blog.html"),
      },
    },
  },
});
