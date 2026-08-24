import { readFile } from "node:fs/promises";

const repositoryRoot = new URL("../", import.meta.url);
const readSource = (path) => readFile(new URL(path, repositoryRoot), "utf8");
const [indexHtml, landingSource, sitemap, robots, readme] = await Promise.all([
  readSource("index.html"),
  readSource("web/main.ts"),
  readSource("public/sitemap.xml"),
  readSource("public/robots.txt"),
  readSource("README.md"),
]);

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

const title = indexHtml.match(/<title>([^<]+)<\/title>/)?.[1] ?? "";
const description = indexHtml.match(/<meta name="description" content="([^"]+)"/u)?.[1] ?? "";
check(title === "Share a Live Terminal in Any Browser | shell.online", "Unexpected landing title");
check(description.length >= 120 && description.length <= 170, "Meta description should be specific and concise");
check(indexHtml.includes('<link rel="canonical" href="https://shell.online/"'), "Canonical URL is missing");
check(!indexHtml.includes("seo-fallback"), "Landing content must not use visually hidden SEO fallback text");
check(indexHtml.includes("coding agents, builds, servers, remote shells"), "Visible loading copy should describe real use cases");

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
check(website?.publisher?.["@id"] === organization?.["@id"], "WebSite publisher is not Pilot Protocol");
check(application?.name === "shell.online", "SoftwareApplication name is invalid");
check(application?.creator?.["@id"] === organization?.["@id"], "Software creator is not Pilot Protocol");
check(application?.offers?.price === "0", "Free software offer is missing");
check(application?.operatingSystem === "macOS, Linux", "Supported operating systems are missing");
check(application?.sameAs === "https://github.com/TeoSlayer/shell.online", "Source repository is missing from schema");
check(landingSource.includes("Developed by"), "Visible Pilot Protocol attribution is missing");
check(landingSource.includes("https://pilotprotocol.network/"), "Visible Pilot Protocol link is missing");
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
check(sitemap.includes("<lastmod>2026-08-24</lastmod>"), "Sitemap lastmod is missing");
check(robots.includes("Sitemap: https://shell.online/sitemap.xml"), "robots.txt does not advertise the sitemap");

console.log("Landing SEO and use-case checks passed.");
