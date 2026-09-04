import { readFile } from "node:fs/promises";

const repositoryRoot = new URL("../", import.meta.url);
const readSource = (path) => readFile(new URL(path, repositoryRoot), "utf8");
const [indexHtml, docsHtml, cliHtml, mobileHtml, reliabilityHtml, securityHtml, e2eeHtml, dockerHtml, landingSource, sitemap, robots, manifestSource, readme, workerSource, docsSource, packageSource] = await Promise.all([
  readSource("index.html"),
  readSource("docs/index.html"),
  readSource("cli/index.html"),
  readSource("mobile/index.html"),
  readSource("reliability/index.html"),
  readSource("security/index.html"),
  readSource("e2ee/index.html"),
  readSource("docker/index.html"),
  readSource("web/main.ts"),
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
const landingMarkup = landingSource.match(/function renderLanding\(\): void \{([\s\S]*?)\n\}\n\nasync function wireGitHubStarCount/u)?.[1] ?? "";
const manifest = JSON.parse(manifestSource);
const docsContent = JSON.parse(docsSource);
const packageMetadata = JSON.parse(packageSource);

check(indexHtml.includes('<html lang="en">'), "Document language is missing");
check(indexHtml.includes('<meta charset="UTF-8"'), "UTF-8 declaration is missing");
check(indexHtml.includes('<meta name="viewport"'), "Responsive viewport is missing");
check(title === "Share a Live Terminal in Any Browser | shell.online", "Unexpected landing title");
check(description.length >= 120 && description.length <= 170, "Meta description should be specific and concise");
check(indexHtml.includes('<meta name="robots" content="index, follow, max-image-preview:large"'), "Homepage robots directive is invalid");
check(indexHtml.includes('<link rel="canonical" href="https://shell.online/"'), "Canonical URL is missing");
check((indexHtml.match(/rel="canonical"/gu) ?? []).length === 1, "Homepage must have exactly one canonical URL");
check(!indexHtml.includes("seo-fallback"), "Landing content must not use visually hidden SEO fallback text");
check(indexHtml.includes("coding agents, builds, servers, remote shells"), "Visible loading copy should describe real use cases");
check(indexHtml.includes("read-only browser link"), "Read-only access should be present in crawlable copy");
check(indexHtml.includes("<noscript>"), "Crawlable no-script product summary is missing");
check((landingMarkup.match(/<h1[ >]/gu) ?? []).length === 1, "Landing page must have exactly one primary heading");
check(landingMarkup.includes('id="use-cases"'), "Visible use-case section is missing");

for (const metadata of [
  '<meta property="og:type" content="website"',
  '<meta property="og:site_name" content="shell.online"',
  '<meta property="og:url" content="https://shell.online/"',
  '<meta property="og:title" content="Share a live terminal in any browser"',
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
check(application?.operatingSystem === "macOS, Linux", "Supported operating systems are missing");
check(application?.sameAs === "https://github.com/TeoSlayer/shell.online", "Source repository is missing from schema");
check(application?.image === "https://shell.online/social-card.png", "Application image is missing from schema");
check(application?.screenshot === "https://shell.online/screenshots/codex-working-mobile.png", "Application screenshot is missing from schema");
check(landingSource.includes("Developed by"), "Visible Pilot Protocol attribution is missing");
check(landingSource.includes("https://pilotprotocol.network/"), "Visible Pilot Protocol link is missing");
check(landingSource.includes("shell --read-only python train.py"), "Visible read-only example is missing");
check(landingSource.includes("v${RELEASE_VERSION} · SHA-256"), "Visible release integrity link is missing");
check(readme.includes("[Pilot Protocol](https://pilotprotocol.network/)"), "README Pilot Protocol link is missing");

const useCaseCards = landingSource.match(/class="use-case-card"/gu) ?? [];
check(useCaseCards.length === 8, `Expected 8 visible use-case cards, found ${useCaseCards.length}`);
for (const example of [
  "shell codex",
  "shell go test -race ./...",
  "shell python train.py",
  "shell docker compose up",
  "shell terraform apply",
  "shell ssh my-server",
  "shell htop",
  "shell bash",
]) {
  check(landingSource.includes(example), `Missing use-case example: ${example}`);
}

check(sitemap.includes("<loc>https://shell.online/</loc>"), "Homepage is missing from sitemap");
check(sitemap.includes("<lastmod>2026-09-02</lastmod>"), "Sitemap lastmod is missing");
check((sitemap.match(/<loc>/gu) ?? []).length === 8, "Sitemap should list the homepage and knowledge base");
for (const [html, path] of [[docsHtml, "docs"], [cliHtml, "cli"], [mobileHtml, "mobile"], [reliabilityHtml, "reliability"], [securityHtml, "security"], [e2eeHtml, "e2ee"], [dockerHtml, "docker"]]) {
  check(html.includes(`<link rel="canonical" href="https://shell.online/${path}/"`), `${path} canonical URL is missing`);
  check(html.includes('<meta name="robots" content="index, follow'), `${path} robots directive is invalid`);
  check(sitemap.includes(`<loc>https://shell.online/${path}/</loc>`), `${path} is missing from sitemap`);
}
for (const guide of ["mobile", "reliability", "security", "e2ee", "docker"]) {
  check(readme.includes(`https://shell.online/${guide}/`), `README ${guide} guide link is missing`);
}
for (const guarantee of ["Any connected phone selects", "Paste input is split", "authenticated ciphertext", "e2ee_password", "docker compose up --build -d"]) {
  check(docsSource.includes(guarantee), `Versioned documentation guarantee is missing: ${guarantee}`);
}
check(readme.includes("end-to-end encrypted by default"), "README default E2EE summary is missing");
check(readme.includes("--no-e2ee"), "README explicit E2EE opt-out is missing");
check(docsContent.version === packageMetadata.version, "Documentation version must match package version");
for (const page of ["docs", "cli", "mobile", "reliability", "security", "e2ee", "docker"]) {
  check(Array.isArray(docsContent.pages?.[page]?.cards), `Versioned documentation page is missing: ${page}`);
}
check(landingSource.includes('import documentationContent from "../docs/content.json"'), "Website must render from the repository documentation source");
check(workerSource.includes('url.pathname === "/api/docs/releases"'), "Dynamic documentation release endpoint is missing");
check(workerSource.includes("raw.githubusercontent.com/TeoSlayer/shell.online/v${version}/docs/content.json"), "Tagged documentation source endpoint is missing");
check(robots.includes("User-agent: *\nAllow: /"), "robots.txt does not allow the canonical landing page");
check(robots.includes("Sitemap: https://shell.online/sitemap.xml"), "robots.txt does not advertise the sitemap");
check(
  workerSource.includes('"X-Robots-Tag": "noindex, nofollow, noarchive"'),
  "JSON APIs must carry an explicit noindex header",
);

console.log("Primary landing SEO, attribution, and use-case checks passed.");
