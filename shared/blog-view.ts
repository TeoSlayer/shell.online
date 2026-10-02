import {
  blogCategories,
  blogHref,
  relatedBlogPosts,
  type BlogPost,
} from "./blog";
import { escapeDocumentation as esc } from "./documentation-view";

const ORIGIN = "https://shell.online";
const SOCIAL_CARD = `${ORIGIN}/social-card.png`;
const ISSUES = "https://github.com/TeoSlayer/shell.online/issues";
const INDEX_TITLE = "Blog | shell.online";
const INDEX_DESCRIPTION =
  "Guides, security notes and engineering write-ups from shell.online: sharing live terminal sessions, read-only links, end-to-end encryption and coding agents on your phone.";
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface BlogHeading {
  id: string;
  /** Escaped text, ready to place in markup. */
  label: string;
}

export interface PreparedBlogBody {
  html: string;
  headings: BlogHeading[];
  minutes: number;
}

// Formatted from the parts, so the build's time zone cannot move the day.
export function blogDate(iso: string, short = false): string {
  const [year, month, day] = iso.split("-").map(Number);
  const name = MONTHS[month - 1] ?? "";
  return `${short ? name.slice(0, 3) : name} ${day}, ${year}`;
}

export function blogBannerHref(post: BlogPost): string {
  return `/blog/${post.banner ?? `banners/${post.slug}.svg`}`;
}

/**
 * What a post body may not contain. Bodies are trusted repository HTML, but
 * the site's content security policy would silently break each of these, and
 * the page owns its only <h1>.
 */
export function blogBodyProblems(body: string): string[] {
  const problems: string[] = [];
  if (!body.trim()) problems.push("body is empty");
  if (/<h1\b/i.test(body)) problems.push("body must not contain an <h1>");
  if (/<(?:script|style|iframe|object|embed)\b/i.test(body))
    problems.push("body must not contain scripts, styles or embeds");
  if (/<[^>]+\son[a-z]+\s*=/i.test(body))
    problems.push("body must not contain inline event handlers");
  if (/(?:href|src)\s*=\s*["']?\s*javascript:/i.test(body))
    problems.push("body must not contain javascript: URLs");
  for (const image of body.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\ssrc\s*=\s*["']\/(?!\/)/i.test(image[0]))
      problems.push("images must be served from this site");
    if (!/\salt\s*=/i.test(image[0])) problems.push("images need alt text");
  }
  return problems;
}

// The text of a piece of markup, entities left as written. One pass can leave
// a tag behind ("<scr<b>ipt>"), so it strips until nothing changes and then
// escapes any bracket still standing: the result can never open an element.
function plainText(markup: string, gap = ""): string {
  let text = markup;
  let before: string;
  do {
    before = text;
    text = text.replace(/<[^>]*>/g, gap);
  } while (text !== before);
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Gives every <h2> an anchor, and measures the post. */
export function prepareBlogBody(body: string): PreparedBlogBody {
  const headings: BlogHeading[] = [];
  const used = new Set<string>();
  const html = body.replace(
    /<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi,
    (_, attributes: string, inner: string) => {
      const label = plainText(inner).trim();
      const given = attributes.match(/\sid\s*=\s*["']([^"']+)["']/i)?.[1];
      const base =
        given ??
        (label
          .replace(/&[a-z#0-9]+;/gi, " ")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") ||
          "section");
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      headings.push({ id, label });
      const rest = attributes.replace(/\sid\s*=\s*["'][^"']*["']/i, "");
      return `<h2${rest} id="${esc(id)}">${inner}</h2>`;
    },
  );
  const words = plainText(body, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return { html, headings, minutes: Math.max(1, Math.ceil(words / 200)) };
}

function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** The title card drawn for a post that brings no artwork of its own. */
export function blogBannerSvg(post: BlogPost): string {
  // An SVG shown through <img> cannot load the site font, so the widths are
  // estimated for a system sans: about half an em per character at this weight.
  let size = 46;
  let lines: string[] = [];
  for (const [candidate, limit] of [
    [72, 2],
    [62, 3],
    [54, 4],
    [46, 5],
  ]) {
    size = candidate;
    lines = wrapWords(post.title, Math.floor(1040 / (candidate * 0.5)));
    if (lines.length <= limit) break;
  }
  if (lines.length > 5) lines = [...lines.slice(0, 4), `${lines[4]}…`];
  const leading = Math.round(size * 1.16);
  const first = 322 - ((lines.length - 1) * leading) / 2 + size * 0.34;
  const title = lines
    .map(
      (line, index) =>
        `<text x="80" y="${Math.round(first + index * leading)}" font-family="system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif" font-size="${size}" font-weight="650" letter-spacing="${(-size * 0.03).toFixed(1)}" fill="#f4f7ec">${esc(line)}</text>`,
    )
    .join("");
  const mono = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(post.title)}">
  <rect width="1200" height="630" fill="#1c251f"/>
  <g fill="#3d4b40"><circle cx="89" cy="70" r="9"/><circle cx="119" cy="70" r="9"/><circle cx="149" cy="70" r="9"/></g>
  <text x="1120" y="78" text-anchor="end" font-family="${mono}" font-size="22" letter-spacing="3" fill="#9aab92">${esc(`${post.category} · ${blogDate(post.iso_date, true)}`.toUpperCase())}</text>
  <line x1="0" y1="118" x2="1200" y2="118" stroke="#2e3a31"/>
  ${title}
  <text x="80" y="566" font-family="${mono}" font-size="26" fill="#d5f568">❯ <tspan fill="#c3cebb">shell.online/blog</tspan></text>
  <rect x="393" y="543" width="15" height="29" fill="#d5f568"/>
</svg>
`;
}

function jsonLd(data: unknown): string {
  // "<" never appears raw, so a title cannot close the script element.
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

function header(current: boolean): string {
  return `<a class="blog-skip" href="#blog-content">Skip to content</a>
    <header class="blog-header blog-wrap"><a class="blog-logo" href="/" aria-label="shell.online home">shell<span>.</span>online</a><nav aria-label="Main navigation"><a href="/docs/">Docs</a><a href="/blog/"${current ? ' aria-current="page"' : ""}>Blog</a><a class="blog-login" href="https://app.shell.online/">Log in</a><a class="blog-button" href="/#start">Get started</a></nav></header>`;
}

function footer(): string {
  return `<footer class="blog-footer blog-wrap"><a class="blog-logo" href="/">shell<span>.</span>online</a><p>Developed by <a href="https://pilotprotocol.network/">Pilot Protocol</a>.</p><nav aria-label="Footer navigation"><a href="/docs/">Docs</a><a href="/blog/">Blog</a><a href="/security/">Security</a><a href="https://github.com/TeoSlayer/shell.online">GitHub</a><a href="/blog/feed.xml">RSS</a></nav></footer>
    <button type="button" class="blog-top" id="blog-top" aria-label="Scroll to top" hidden><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg></button>`;
}

function meta(post: BlogPost): string {
  return `<span class="blog-category">${esc(post.category)}</span><time datetime="${esc(post.iso_date)}">${blogDate(post.iso_date, true)}</time>`;
}

function banner(post: BlogPost, eager = false): string {
  // Decorative: the title is always printed next to it.
  return `<img src="${esc(blogBannerHref(post))}" alt="" width="1200" height="630" decoding="async" loading="${eager ? "eager" : "lazy"}"${eager ? ' fetchpriority="high"' : ""}>`;
}

export function blogIndexMarkup(posts: readonly BlogPost[]): string {
  const filters = ["All", ...blogCategories(posts)]
    .map(
      (category, index) =>
        `<button type="button" data-filter="${esc(category)}" aria-pressed="${index === 0}" aria-controls="blog-cards">${esc(category)}</button>`,
    )
    .join("");
  const cards = posts
    .map(
      (post, index) =>
        `<a class="blog-card${index === 0 ? " blog-hero" : ""}" href="${blogHref(post.slug)}" data-category="${esc(post.category)}" data-search="${esc(`${post.title} ${post.description} ${post.tags.join(" ")}`.toLowerCase())}">${banner(post, index === 0)}<div class="blog-card-body"><p class="blog-meta">${meta(post)}</p><h2>${esc(post.title)}</h2><p>${esc(post.description)}</p><ul class="blog-tags" aria-label="Tags">${post.tags
          .slice(0, 3)
          .map((tag) => `<li>${esc(tag)}</li>`)
          .join("")}</ul></div></a>`,
    )
    .join("");
  return `<div class="blog">${header(true)}
    <main id="blog-content" class="blog-list blog-wrap" tabindex="-1">
      <p class="blog-eyebrow">Blog</p>
      <h1>Terminal sharing, <span>explained.</span></h1>
      <p class="blog-subtitle">Guides, security notes and engineering write-ups on sharing live terminal sessions: read-only links, end-to-end encryption, self-hosting, and keeping an eye on a coding agent from your phone.</p>
      ${
        posts.length
          ? `<div class="blog-tools">
        <div class="blog-search"><label for="blog-search" class="blog-sr">Search posts</label><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input id="blog-search" type="search" placeholder="Search posts…" autocomplete="off" maxlength="120" aria-controls="blog-cards"></div>
        <div class="blog-rss"><a href="/blog/feed.xml"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><circle cx="6.18" cy="17.82" r="2.18"/><path d="M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83c0-8.59-6.97-15.56-15.56-15.56z"/><path d="M4 10.1v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9z"/></svg>RSS</a><button type="button" id="blog-rss-copy" data-feed="${ORIGIN}/blog/feed.xml" aria-label="Copy feed URL">Copy URL</button></div>
      </div>
      <div class="blog-filters" id="blog-filters" role="group" aria-label="Filter posts by category">${filters}</div>
      <p class="blog-sr" id="blog-results" role="status" aria-live="polite"></p>
      <div class="blog-cards" id="blog-cards">${cards}</div>
      <p class="blog-empty" id="blog-empty" hidden>No posts match your search.</p>`
          : `<p class="blog-none">No posts yet. The <a href="/blog/feed.xml">RSS feed</a> will carry the first one.</p>`
      }
    </main>${footer()}</div>`;
}

export function blogPostMarkup(
  post: BlogPost,
  body: string,
  posts: readonly BlogPost[],
): string {
  const prepared = prepareBlogBody(body);
  const at = posts.findIndex((other) => other.slug === post.slug);
  const newer = at > 0 ? posts[at - 1] : undefined;
  const older = at >= 0 ? posts[at + 1] : undefined;
  const related = relatedBlogPosts(post, posts);
  const toc = prepared.headings
    .map(({ id, label }) => `<a href="#${esc(id)}">${label}</a>`)
    .join("");
  const source = post.canonical
    ? ` First published on <a href="${esc(post.canonical)}">${esc(new URL(post.canonical).hostname)}</a>.`
    : "";
  return `<div class="blog"><div class="blog-progress" id="blog-progress" aria-hidden="true"></div>${header(false)}
    <div class="blog-article-layout blog-wrap">
      <main id="blog-content" class="blog-article" tabindex="-1">
        <nav class="blog-breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/blog/">Blog</a><span aria-hidden="true">/</span><span>${esc(post.category)}</span></nav>
        <h1>${esc(post.title)}</h1>
        <p class="blog-article-meta"><span>By ${esc(post.author ?? "the shell.online team")}</span><time datetime="${esc(post.iso_date)}">${blogDate(post.iso_date)}</time><span>${prepared.minutes} min read</span></p>
        ${post.banner ? `<div class="blog-article-banner">${banner(post, true)}</div>` : ""}
        ${toc ? `<details class="blog-mobile-toc"><summary>On this page</summary><nav aria-label="Sections">${toc}</nav></details>` : ""}
        <div class="blog-prose">${prepared.html}</div>
        <ul class="blog-tags" aria-label="Tags">${post.tags.map((tag) => `<li>${esc(tag)}</li>`).join("")}</ul>
        <footer class="blog-provenance"><p>Published by the shell.online team.${source} Commands and behavior are described as of the publication date; the <a href="/docs/">docs</a> follow the current release.</p><p><a href="${ISSUES}">Suggest a correction ↗</a></p></footer>
      </main>
      ${toc ? `<aside class="blog-toc"><p>On this page</p><nav aria-label="Sections">${toc}</nav></aside>` : ""}
    </div>
    ${
      related.length
        ? `<section class="blog-related blog-wrap" aria-labelledby="blog-related-title"><h2 id="blog-related-title">Related posts</h2><div class="blog-related-grid">${related
            .map(
              (other) =>
                `<a class="blog-card" href="${blogHref(other.slug)}">${banner(other)}<div class="blog-card-body"><p class="blog-meta">${meta(other)}</p><h3>${esc(other.title)}</h3></div></a>`,
            )
            .join("")}</div></section>`
        : ""
    }
    ${
      newer || older
        ? `<nav class="blog-pagination blog-wrap" aria-label="More posts">${newer ? `<a href="${blogHref(newer.slug)}"><small>Newer</small>← ${esc(newer.title)}</a>` : "<span></span>"}${older ? `<a href="${blogHref(older.slug)}"><small>Older</small>${esc(older.title)} →</a>` : ""}</nav>`
        : ""
    }${footer()}</div>`;
}

export function blogFeed(posts: readonly BlogPost[]): string {
  const items = posts
    .map(
      (post) =>
        `    <item><title>${esc(post.title)}</title><link>${ORIGIN}${blogHref(post.slug)}</link><guid isPermaLink="true">${ORIGIN}${blogHref(post.slug)}</guid><pubDate>${new Date(`${post.iso_date}T00:00:00Z`).toUTCString()}</pubDate><category>${esc(post.category)}</category><description>${esc(post.description)}</description></item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>shell.online blog</title>
    <link>${ORIGIN}/blog/</link>
    <description>${esc(INDEX_DESCRIPTION)}</description>
    <language>en</language>
    <atom:link href="${ORIGIN}/blog/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

// A post first published elsewhere names that page as canonical, so it stays out.
export function blogSitemap(posts: readonly BlogPost[]): string {
  const own = posts.filter((post) => !post.canonical);
  const urls = [
    `  <url><loc>${ORIGIN}/blog/</loc>${posts[0] ? `<lastmod>${posts[0].iso_date}</lastmod>` : ""}</url>`,
    ...own.map(
      (post) =>
        `  <url><loc>${ORIGIN}${blogHref(post.slug)}</loc><lastmod>${post.iso_date}</lastmod></url>`,
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
}

interface BlogPageHead {
  title: string;
  description: string;
  url: string;
  canonical: string;
  type: "website" | "article";
  image: string;
  head: string;
}

// The canonical URL, social image and feed link are written here, after Vite
// has processed the template, so it never mistakes them for assets to bundle.
function page(template: string, head: BlogPageHead, body: string): string {
  return template
    .replaceAll("__BLOG_TITLE__", esc(head.title))
    .replaceAll("__BLOG_DESCRIPTION__", esc(head.description))
    .replace(
      "<!--BLOG_HEAD-->",
      () =>
        `<link rel="canonical" href="${esc(head.canonical)}" /><meta property="og:type" content="${head.type}" /><meta property="og:url" content="${esc(head.url)}" /><meta property="og:image" content="${esc(head.image)}" /><link rel="alternate" type="application/rss+xml" title="shell.online blog" href="/blog/feed.xml" />${head.head}`,
    )
    .replace("<!--BLOG_BODY-->", () => body);
}

export function blogIndexPage(
  template: string,
  posts: readonly BlogPost[],
): string {
  const url = `${ORIGIN}/blog/`;
  return page(
    template,
    {
      title: INDEX_TITLE,
      description: INDEX_DESCRIPTION,
      url,
      canonical: url,
      type: "website",
      image: SOCIAL_CARD,
      head: jsonLd({
        "@context": "https://schema.org",
        "@type": "Blog",
        name: "shell.online blog",
        description: INDEX_DESCRIPTION,
        url,
        isPartOf: { "@id": `${ORIGIN}/#website` },
        publisher: { "@id": "https://pilotprotocol.network/#organization" },
        blogPost: posts.map((post) => ({
          "@type": "BlogPosting",
          headline: post.title,
          url: `${ORIGIN}${blogHref(post.slug)}`,
          datePublished: post.iso_date,
        })),
      }),
    },
    blogIndexMarkup(posts),
  );
}

export function blogPostPage(
  template: string,
  post: BlogPost,
  body: string,
  posts: readonly BlogPost[],
): string {
  const url = `${ORIGIN}${blogHref(post.slug)}`;
  // Social crawlers do not render SVG, so a drawn title card is never the preview.
  const image =
    post.banner && !post.banner.endsWith(".svg")
      ? `${ORIGIN}${blogBannerHref(post)}`
      : SOCIAL_CARD;
  return page(
    template,
    {
      title: `${post.title} | shell.online`,
      description: post.description,
      url,
      canonical: post.canonical ?? url,
      type: "article",
      image,
      head: `<meta property="article:published_time" content="${esc(post.iso_date)}" />${jsonLd(
        {
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          headline: post.title,
          description: post.description,
          image,
          author: post.author
            ? { "@type": "Person", name: post.author }
            : { "@type": "Organization", name: "shell.online", url: ORIGIN },
          publisher: { "@id": "https://pilotprotocol.network/#organization" },
          datePublished: post.iso_date,
          dateModified: post.iso_date,
          mainEntityOfPage: post.canonical ?? url,
          keywords: post.tags.join(", "),
        },
      )}`,
    },
    blogPostMarkup(post, body, posts),
  );
}

/**
 * Every file under /blog/, keyed by its path in the build output. The bodies
 * come from the caller because only the build can read them from disk.
 */
export function renderBlogSite(
  template: string,
  posts: readonly BlogPost[],
  bodies: Readonly<Record<string, string>>,
): Record<string, string> {
  const files: Record<string, string> = {
    "blog/index.html": blogIndexPage(template, posts),
    "blog/feed.xml": blogFeed(posts),
    "blog/sitemap.xml": blogSitemap(posts),
  };
  for (const post of posts) {
    const body = bodies[post.slug];
    if (body === undefined)
      throw new Error(`blog/posts/${post.slug}.html is missing`);
    const problems = blogBodyProblems(body);
    if (problems.length)
      throw new Error(`blog/posts/${post.slug}.html: ${problems.join("; ")}`);
    files[`blog/${post.slug}/index.html`] = blogPostPage(
      template,
      post,
      body,
      posts,
    );
    if (!post.banner)
      files[`blog/banners/${post.slug}.svg`] = blogBannerSvg(post);
  }
  return files;
}
