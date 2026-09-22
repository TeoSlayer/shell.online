import { readFile } from "node:fs/promises";

const repositoryRoot = new URL("../", import.meta.url);
const readSource = (path) => readFile(new URL(path, repositoryRoot), "utf8");
const [indexHtml, documentationHtml, landingSource, landingStyles, documentationRenderer, documentationRoutes, viteSource, sitemap, robots, manifestSource, readme, workerSource, docsSource, packageSource] = await Promise.all([
  readSource("index.html"),
  readSource("web/documentation.html"),
  readSource("web/landing-markup.ts"),
  readSource("web/landing.css"),
  readSource("web/documentation.ts"),
  readSource("shared/documentation.ts"),
  readSource("vite.config.ts"),
  readSource("public/sitemap.xml"),
  readSource("public/robots.txt"),
  readSource("public/site.webmanifest"),
  readSource("README.md"),
  readSource("worker/index.ts"),
  readSource("docs/content.json"),
  readSource("package.json"),
]);

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

const title = indexHtml.match(/<title>([^<]+)<\/title>/)?.[1] ?? "";
const description = indexHtml.match(/<meta name="description" content="([^"]+)"/u)?.[1] ?? "";
const landingMarkup = landingSource;
const manifest = JSON.parse(manifestSource);
const docsContent = JSON.parse(docsSource);
const packageMetadata = JSON.parse(packageSource);

// Keep the structured-data version aligned with the release.
const advertisedVersion = indexHtml.match(/"softwareVersion":\s*"([^"]+)"/u)?.[1];
check(
  advertisedVersion === packageMetadata.version,
  `Structured data advertises ${advertisedVersion} but package.json says ${packageMetadata.version}`,
);

check(indexHtml.includes('<html lang="en"'), "Document language is missing");
check(indexHtml.includes('<meta charset="UTF-8"'), "UTF-8 declaration is missing");
check(indexHtml.includes('<meta name="viewport"'), "Responsive viewport is missing");
check(title === "Your Coding Agent. On Your Phone. | shell.online", "Unexpected landing title");
check(description.length >= 120 && description.length <= 170, "Meta description should be specific and concise");
check(indexHtml.includes('<meta name="robots" content="index, follow, max-image-preview:large"'), "Homepage robots directive is invalid");
check(indexHtml.includes('<link rel="canonical" href="https://shell.online/"'), "Canonical URL is missing");
check((indexHtml.match(/rel="canonical"/gu) ?? []).length === 1, "Homepage must have exactly one canonical URL");
check(!indexHtml.includes("seo-fallback"), "Landing content must not use visually hidden SEO fallback text");
check(indexHtml.includes('<!--PUBLIC_LANDING-->') && viteSource.includes('landingMarkup()'), "Public copy must be rendered into the build, not only client-side");
check((landingMarkup.match(/<h1[ >]/gu) ?? []).length === 1, "Exactly one primary heading");
check(landingMarkup.includes('No account needed to try it.'), "First session must not require signup");
const optionalAccountLink = [...landingMarkup.matchAll(/href="([^"]+)"/gu)].some(([, href]) => {
  const url = new URL(href, "https://shell.online/");
  return url.origin === "https://app.shell.online" && url.pathname === "/signup";
});
check(optionalAccountLink, "Optional account link missing");
check(landingMarkup.includes('<noscript>'), "Setup must remain usable without JavaScript");
check(landingMarkup.indexOf('id="start"') < landingMarkup.indexOf('home-specs'), "Easy setup must precede specs");
check(landingMarkup.includes('data-copy="install"') && landingMarkup.includes('data-copy="run"'), "Both setup commands need copy controls");
check(landingMarkup.includes('/screenshots/codex-working-mobile.png'), "Real product proof missing");
check(!landingMarkup.includes('22ms') && !landingMarkup.includes('42 tests passed'), "Do not fabricate performance or proof");

for (const metadata of [
  '<meta property="og:type" content="website"',
  '<meta property="og:site_name" content="shell.online"',
  '<meta property="og:url" content="https://shell.online/"',
  '<meta property="og:title" content="Your coding agent. On your phone. | shell.online"',
  '<meta property="og:description"',
  '<meta property="og:image" content="https://shell.online/social-card.png"',
  '<meta property="og:image:width" content="1200"',
  '<meta property="og:image:height" content="630"',
  '<meta property="og:image:alt"',
  '<meta name="twitter:card" content="summary_large_image"',
  '<meta name="twitter:title"',
  '<meta name="twitter:description"',
  '<meta name="twitter:image" content="https://shell.online/social-card.png"',
  '<meta name="twitter:image:alt"',
]) {
  check(indexHtml.includes(metadata), `Social metadata is missing: ${metadata}`);
}
check(indexHtml.includes('<link rel="icon" href="/favicon.svg"'), "SVG favicon is missing");
check(indexHtml.includes('<link rel="icon" href="/favicon-48.png"'), "48px search favicon is missing");
check(indexHtml.includes('<link rel="manifest" href="/site.webmanifest"'), "Web manifest link is missing");
check(manifest.name === "shell.online" && manifest.start_url === "/", "Web manifest identity is invalid");

const structuredDataSource = indexHtml.match(
  /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/u,
)?.[1];
check(structuredDataSource, "JSON-LD is missing");
const structuredData = JSON.parse(structuredDataSource);
const organization = structuredData.find((entry) => entry["@type"] === "Organization");
const website = structuredData.find((entry) => entry["@type"] === "WebSite");
const application = structuredData.find((entry) => entry["@type"] === "SoftwareApplication");
check(organization?.name === "Pilot Protocol", "Pilot Protocol Organization schema is missing");
check(organization?.url === "https://pilotprotocol.network/", "Pilot Protocol schema URL is invalid");
check(website?.url === "https://shell.online/", "WebSite schema URL is invalid");
check(website?.name === "shell.online" && website?.alternateName === "shell online", "WebSite name schema is invalid");
check(website?.publisher?.["@id"] === organization?.["@id"], "WebSite publisher is not Pilot Protocol");
check(application?.name === "shell.online", "SoftwareApplication name is invalid");
check(application?.creator?.["@id"] === organization?.["@id"], "Software creator is not Pilot Protocol");
check(application?.offers?.price === "0", "Free software offer is missing");
check(application?.operatingSystem.includes("Windows") && application?.operatingSystem.includes("Linux"), "Supported operating systems are missing");
check(application?.sameAs === "https://github.com/TeoSlayer/shell.online", "Source repository is missing from schema");
check(application?.image === "https://shell.online/social-card.png", "Application image is missing from schema");
check(application?.screenshot === "https://shell.online/screenshots/codex-working-mobile.png", "Application screenshot is missing from schema");
check(landingSource.includes("Developed by"), "Visible Pilot Protocol attribution is missing");
check(landingSource.includes('href="https://pilotprotocol.network/"'), "Visible attribution missing");
check(landingSource.includes('shell --read-only &lt;command&gt;'), "Read-only example missing");
check(landingSource.includes("v${RELEASE_VERSION} · SHA-256"), "Visible release integrity link is missing");
check(readme.includes("[Pilot Protocol](https://pilotprotocol.network/)"), "README Pilot Protocol link is missing");

for (const command of ["shell codex", "shell claude", "shell opencode"]) check(landingMarkup.includes(command), "Missing easy command: " + command);

check(sitemap.includes("<loc>https://shell.online/</loc>"), "Homepage is missing from sitemap");
check(sitemap.includes("<lastmod>2026-09-22</lastmod>"), "Sitemap lastmod is missing");
check((sitemap.match(/<loc>/gu) ?? []).length === 13, "Sitemap should list the homepage and every guide");
check(documentationHtml.includes("__DOC_DESCRIPTION__"), "Documentation description build token is missing");
check(documentationHtml.includes("__DOC_SOCIAL_TITLE__"), "Documentation title build token is missing");
check(documentationHtml.includes("__DOC_SOCIAL_DESCRIPTION__"), "Documentation social-description build token is missing");
check(documentationHtml.includes("__DOC_PATH__"), "Documentation canonical-path build token is missing");
check(documentationHtml.includes('<meta name="robots" content="index, follow'), "Documentation robots directive is invalid");
for (const path of ["docs", "app", "cli", "platforms", "mobile", "agents", "refstream", "reliability", "security", "e2ee", "docker", "self-hosting"]) {
  const seo = docsContent.pages?.[path]?.seo;
  check(typeof seo?.description === "string", `${path} SEO description is missing from versioned content`);
  check(typeof seo?.socialTitle === "string", `${path} social title is missing from versioned content`);
  check(typeof seo?.socialDescription === "string", `${path} social description is missing from versioned content`);
  check(sitemap.includes(`<loc>https://shell.online/${path}/</loc>`), `${path} is missing from sitemap`);
}
for (const guide of ["app", "platforms", "mobile", "refstream", "reliability", "security", "e2ee", "docker"]) {
  check(readme.includes(`https://shell.online/${guide}/`), `README ${guide} guide link is missing`);
}
for (const guarantee of ["Any connected phone selects", "Paste input is split", "authenticated ciphertext", "e2ee_password", "docker compose up --build -d", "Refstream v0.1.0-alpha.5", "The vault is per account, not per organization"]) {
  check(docsSource.includes(guarantee), `Versioned documentation guarantee is missing: ${guarantee}`);
}
check(docsSource.includes("terminal_size") && docsSource.includes("plaintext"), "E2EE docs must disclose plaintext terminal-size control metadata");
check(!docsSource.includes("snapshots, resizes, and latency probes are authenticated ciphertext"), "E2EE docs must not claim relay-controlled resizes are ciphertext");
check(readme.includes("end-to-end encrypted by default"), "README default E2EE summary is missing");
check(readme.includes("--no-e2ee"), "README explicit E2EE opt-out is missing");
check(docsContent.version === packageMetadata.version, "Documentation version must match package version");
for (const page of ["docs", "app", "cli", "platforms", "mobile", "refstream", "reliability", "security", "e2ee", "docker"]) {
  check(Array.isArray(docsContent.pages?.[page]?.cards), `Versioned documentation page is missing: ${page}`);
}
check(documentationRenderer.includes('import documentationSource from "../docs/content.json"'), "Website must render from the repository documentation source");
check(documentationRenderer.includes('import("mermaid")'), "Documentation diagrams must load Mermaid only on documentation pages");
check(documentationRenderer.includes("await document.fonts?.ready"), "Documentation diagrams must wait for fonts before measuring labels");
check(documentationRenderer.includes("padding: 18"), "Documentation diagrams must leave enough room around labels");
check(landingStyles.includes(".knowledge-diagram-canvas foreignObject p"), "Mermaid labels must retain their measured font size inside documentation sections");
check(documentationHtml.includes("<!--DOCUMENTATION_BODY-->") && viteSource.includes("documentationMarkup(documentation, kind"), "Guides must render readable HTML at build time");
check(documentationHtml.includes("/web/documentation-entry.ts") && !documentationHtml.includes("/web/main.ts"), "Guides must not load the terminal runtime");
check(!documentationHtml.includes("user-scalable=no") && !documentationHtml.includes("maximum-scale=1"), "Docs must allow browser zoom");
const diagramPages = Object.values(docsContent.pages).filter((page) => Array.isArray(page.diagrams));
for (const page of diagramPages) {
  for (const diagram of page.diagrams) {
    check(diagram.desktop.startsWith("flowchart LR"), `${diagram.title} needs a desktop Mermaid layout`);
    check(diagram.mobile.startsWith("flowchart TD"), `${diagram.title} needs a mobile Mermaid layout`);
  }
}
check(documentationRenderer.includes("resolveAvailableDocumentationKind"), "Historical docs must fall back when a page did not exist yet");
check(documentationRoutes.includes("VERSIONED_DOCUMENTATION_ROUTE"), "Versioned documentation routing is missing");
check(viteSource.includes('documentation: resolve(import.meta.dirname, "web/documentation.html")'), "Vite must use one documentation entry point");
check(viteSource.includes('fileName: `${kind}/index.html`'), "Vite must generate each public documentation route");
check(workerSource.includes('url.pathname === "/api/docs/releases"'), "Dynamic documentation release endpoint is missing");
check(
  workerSource.includes('url.searchParams.get("go-get") === "1"') &&
    workerSource.includes('name="go-import" content="shell.online git https://github.com/TeoSlayer/shell.online"'),
  "The canonical domain must publish Go module discovery metadata",
);
check(workerSource.includes("raw.githubusercontent.com/TeoSlayer/shell.online/v${version}/docs/content.json"), "Tagged documentation source endpoint is missing");
check(workerSource.includes("isVersionedDocumentationPath(url.pathname)"), "Versioned routes must load the documentation shell");
check(workerSource.includes('documentationAssetPath(url.pathname, RELEASE_VERSION)'), "Archives must use the version-aware asset route");
check(robots.includes("User-agent: *\nAllow: /"), "robots.txt does not allow the canonical landing page");
check(robots.includes("Sitemap: https://shell.online/sitemap.xml"), "robots.txt does not advertise the sitemap");
check(
  workerSource.includes('"X-Robots-Tag": "noindex, nofollow, noarchive"'),
  "JSON APIs must carry an explicit noindex header",
);

console.log("Primary landing SEO, attribution, and use-case checks passed.");
