import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import registry from "../blog/posts.json";
import {
  blogAliasRedirect,
  blogAssetIsSpaFallback,
  blogCategories,
  blogPosts,
  blogRegistryProblems,
  relatedBlogPosts,
  resolveBlogRoute,
  sortBlogPosts,
  type BlogPost,
} from "../shared/blog";
import {
  blogBannerSvg,
  blogBodyProblems,
  blogDate,
  blogFeed,
  blogPostMarkup,
  blogSitemap,
  prepareBlogBody,
  renderBlogSite,
} from "../shared/blog-view";

const template = readFileSync(
  new URL("../web/blog.html", import.meta.url),
  "utf8",
);
const body = (slug: string) =>
  readFileSync(new URL(`../blog/posts/${slug}.html`, import.meta.url), "utf8");
const post = (fields: Partial<BlogPost> = {}): BlogPost => ({
  slug: "a-post",
  title: "A post",
  description: "About a post.",
  category: "Guide",
  tags: ["terminal-sharing"],
  iso_date: "2026-09-01",
  ...fields,
});

describe("blog registry", () => {
  it("ships a valid registry with a clean body for every post", () => {
    expect(blogRegistryProblems(registry)).toEqual([]);
    for (const { slug } of blogPosts)
      expect(blogBodyProblems(body(slug)), slug).toEqual([]);
  });

  it("names what is wrong with a bad entry", () => {
    const problems = blogRegistryProblems([
      post(),
      post(),
      post({ slug: "Not A Slug" }),
      post({ slug: "banners" }),
      post({ slug: "b", iso_date: "Sep 1", banner: "../x.svg" }),
      post({ slug: "c", title: " ", tags: [""], canonical: "http://x" }),
    ]);
    expect(problems).toEqual([
      "a-post: slug is used twice",
      "Not A Slug: slug must be lowercase words joined by hyphens",
      "banners: slug is reserved",
      "b: iso_date must be YYYY-MM-DD",
      "b: banner must be a file under banners/",
      "c: title is missing",
      "c: tags must be a list of words",
      "c: canonical must be an https URL",
    ]);
  });

  it("lists posts newest first and categories in that order", () => {
    const posts = sortBlogPosts([
      post({ slug: "old", iso_date: "2026-01-02", category: "Security" }),
      post({ slug: "new", iso_date: "2026-03-04" }),
    ]);
    expect(posts.map(({ slug }) => slug)).toEqual(["new", "old"]);
    expect(blogCategories(posts)).toEqual(["Guide", "Security"]);
  });

  it("relates posts by the tags they share", () => {
    const posts = [
      post({ slug: "a", tags: ["mcp", "agents"] }),
      post({ slug: "b", tags: ["MCP", "agents"] }),
      post({ slug: "c", tags: ["mcp"] }),
      post({ slug: "d", tags: ["docker"] }),
    ];
    expect(relatedBlogPosts(posts[0], posts).map(({ slug }) => slug)).toEqual([
      "b",
      "c",
    ]);
  });
});

describe("blog routing", () => {
  const posts = [post()];

  it("resolves the index and published posts only", () => {
    expect(resolveBlogRoute("/blog", posts)).toEqual({ kind: "index" });
    expect(resolveBlogRoute("/blog/", posts)).toEqual({ kind: "index" });
    for (const path of ["/blog/a-post/", "/blog/a-post"])
      expect(resolveBlogRoute(path, posts)).toEqual({
        kind: "post",
        slug: "a-post",
      });
    expect(resolveBlogRoute("/blog/not-a-post/", posts)).toBeNull();
    expect(resolveBlogRoute("/blog/a-post/extra/", posts)).toBeNull();
    expect(resolveBlogRoute("/blog/feed.xml", posts)).toBeNull();
    expect(resolveBlogRoute("/blogs/", posts)).toBeNull();
    for (const { slug } of blogPosts)
      expect(resolveBlogRoute(`/blog/${slug}/`)).toEqual({ kind: "post", slug });
  });

  it("sends /blogs to the same place under /blog/", () => {
    expect(blogAliasRedirect("/blogs")).toBe("/blog/");
    expect(blogAliasRedirect("/blogs/")).toBe("/blog/");
    expect(blogAliasRedirect("/blogs/a-post/")).toBe("/blog/a-post/");
    expect(blogAliasRedirect("/blogs/feed.xml")).toBe("/blog/feed.xml");
    expect(blogAliasRedirect("/blog/")).toBeNull();
    expect(blogAliasRedirect("/blogsx")).toBeNull();
    expect(blogAliasRedirect("/")).toBeNull();
  });

  it("detects the landing page returned for a missing post", () => {
    const html = "text/html; charset=utf-8";
    expect(blogAssetIsSpaFallback("/blog/not-a-post/", html)).toBe(true);
    expect(blogAssetIsSpaFallback("/blog/banners/missing.svg", html)).toBe(true);
    expect(blogAssetIsSpaFallback("/blog/", html)).toBe(false);
    expect(blogAssetIsSpaFallback("/blog/feed.xml", "application/xml")).toBe(false);
    expect(blogAssetIsSpaFallback("/blog", null)).toBe(false);
    expect(blogAssetIsSpaFallback("/docs/", html)).toBe(false);
    for (const { slug } of blogPosts)
      expect(blogAssetIsSpaFallback(`/blog/${slug}/`, html)).toBe(false);
  });
});

describe("blog pages", () => {
  it("formats dates without consulting a time zone", () => {
    expect(blogDate("2026-09-01")).toBe("September 1, 2026");
    expect(blogDate("2026-12-31", true)).toBe("Dec 31, 2026");
  });

  it("anchors every section heading and measures the post", () => {
    const prepared = prepareBlogBody(
      `<p>${"word ".repeat(450)}</p><h2>Q&amp;A: <code>shell</code></h2><h2>Q&amp;A: shell</h2><h2 id="kept" class="x">Kept</h2>`,
    );
    expect(prepared.headings).toEqual([
      { id: "q-a-shell", label: "Q&amp;A: shell" },
      { id: "q-a-shell-2", label: "Q&amp;A: shell" },
      { id: "kept", label: "Kept" },
    ]);
    expect(prepared.html).toContain(
      '<h2 id="q-a-shell">Q&amp;A: <code>shell</code></h2>',
    );
    expect(prepared.html).toContain('<h2 class="x" id="kept">Kept</h2>');
    expect(prepared.minutes).toBe(3);
  });

  it("never lets a heading smuggle an element into the table of contents", () => {
    const { headings } = prepareBlogBody(
      "<h2><scr<b>ipt>alert(1)</scr</b>ipt> a < b</h2>",
    );
    expect(headings[0].label).not.toMatch(/[<>]/);
    expect(headings[0].label).toContain("alert(1)");
    expect(headings[0].id).not.toMatch(/[<>]/);
  });

  it("rejects body markup the page or its security policy cannot carry", () => {
    expect(blogBodyProblems("<p>Fine.</p><img src=\"/blog/a.png\" alt=\"A\">")).toEqual([]);
    expect(blogBodyProblems(" ")).toContain("body is empty");
    expect(blogBodyProblems("<h1>Title</h1>")).toHaveLength(1);
    expect(blogBodyProblems("<script>alert(1)</script>")).toHaveLength(1);
    expect(blogBodyProblems('<p onclick="x()">a</p>')).toHaveLength(1);
    expect(blogBodyProblems('<a href="javascript:x()">a</a>')).toHaveLength(1);
    expect(blogBodyProblems('<img src="https://example.com/a.png">')).toEqual([
      "images must be served from this site",
      "images need alt text",
    ]);
  });

  it("renders the index, every post, its banner, the feed and the sitemap", () => {
    const posts = sortBlogPosts([
      post({ slug: "first", iso_date: "2026-09-01", category: "Security" }),
      post({ slug: "second", iso_date: "2026-09-02" }),
    ]);
    const text = "<p>Intro.</p><h2>One</h2><p>Text.</p><pre><code>shell codex</code></pre><h2>Two</h2><p>Text.</p>";
    const files = renderBlogSite(template, posts, { first: text, second: text });
    expect(Object.keys(files).sort()).toEqual([
      "blog/banners/first.svg",
      "blog/banners/second.svg",
      "blog/feed.xml",
      "blog/first/index.html",
      "blog/index.html",
      "blog/second/index.html",
      "blog/sitemap.xml",
    ]);
    const index = files["blog/index.html"];
    expect(index.match(/<h1[ >]/g)).toHaveLength(1);
    expect(index).toContain('<link rel="canonical" href="https://shell.online/blog/" />');
    expect(index.match(/<a class="blog-card/g)).toHaveLength(2);
    expect(index.indexOf('href="/blog/second/"')).toBeLessThan(index.indexOf('href="/blog/first/"'));
    for (const filter of ["All", "Guide", "Security"])
      expect(index).toContain(`data-filter="${filter}"`);
    for (const { slug } of posts) {
      const html = files[`blog/${slug}/index.html`];
      expect(html.match(/<h1[ >]/g), slug).toHaveLength(1);
      expect(html).toContain(`<link rel="canonical" href="https://shell.online/blog/${slug}/" />`);
      expect(html).toContain('"@type":"BlogPosting"');
      expect(html).not.toMatch(/__BLOG_|<!--BLOG_/);
      // Every in-page link lands on a heading that exists.
      expect([...html.matchAll(/href="#([^"]+)"/g)].length).toBeGreaterThan(0);
      for (const [, id] of html.matchAll(/href="#([^"]+)"/g))
        expect(html, `${slug} #${id}`).toContain(`id="${id}"`);
      expect(files[`blog/banners/${slug}.svg`]).toContain("<svg");
      expect(files["blog/sitemap.xml"]).toContain(`<loc>https://shell.online/blog/${slug}/</loc>`);
      expect(files["blog/feed.xml"]).toContain(`<link>https://shell.online/blog/${slug}/</link>`);
    }
    expect(() => renderBlogSite(template, posts, {})).toThrow(/is missing/);
    expect(() =>
      renderBlogSite(template, [post()], { "a-post": "<h1>No</h1>" }),
    ).toThrow(/must not contain an <h1>/);
  });

  it("renders the published registry, and says so when it is empty", () => {
    const files = renderBlogSite(
      template,
      blogPosts,
      Object.fromEntries(blogPosts.map(({ slug }) => [slug, body(slug)])),
    );
    for (const { slug } of blogPosts)
      expect(files[`blog/${slug}/index.html`]).toContain("<h1>");
    const empty = renderBlogSite(template, [], {});
    expect(Object.keys(empty)).toEqual([
      "blog/index.html",
      "blog/feed.xml",
      "blog/sitemap.xml",
    ]);
    expect(empty["blog/index.html"]).toContain("No posts yet.");
    expect(empty["blog/index.html"]).not.toContain('id="blog-search"');
    expect(empty["blog/sitemap.xml"]).toContain("<loc>https://shell.online/blog/</loc>");
  });

  it("escapes registry text everywhere it is printed", () => {
    const hostile = post({
      title: 'A "quoted" <b>title</b> & more</script>',
      description: "<img src=x>",
      tags: ["<i>"],
    });
    const files = renderBlogSite(template, [hostile], {
      "a-post": "<p>Body.</p>",
    });
    for (const file of Object.values(files)) {
      expect(file).not.toContain("<b>title</b>");
      expect(file).not.toContain("<img src=x>");
      expect(file).not.toContain("<i>");
      expect(file).not.toContain("more</script>");
    }
    expect(blogBannerSvg(hostile)).toContain("&lt;b&gt;");
  });

  it("keeps a post's own artwork and credits where it first appeared", () => {
    const posts = [
      post({ banner: "banners/art.png", canonical: "https://example.com/a" }),
      post({ slug: "b", iso_date: "2026-08-01" }),
    ];
    const html = blogPostMarkup(posts[0], "<p>Body.</p>", posts);
    expect(html).toContain('class="blog-article-banner"');
    expect(html).toContain('src="/blog/banners/art.png"');
    expect(html).toContain('First published on <a href="https://example.com/a">example.com</a>');
    expect(html).toContain("<small>Older</small>");
    expect(html).not.toContain("<small>Newer</small>");
    const files = renderBlogSite(template, posts, {
      "a-post": "<p>Body.</p>",
      b: "<p>Body.</p>",
    });
    expect(files["blog/banners/a-post.svg"]).toBeUndefined();
    expect(files["blog/a-post/index.html"]).toContain(
      '<meta property="og:image" content="https://shell.online/blog/banners/art.png" />',
    );
    // The original stays canonical, so only our own post is offered to crawlers.
    expect(blogSitemap(posts)).not.toContain("/blog/a-post/");
    expect(blogSitemap(posts)).toContain("<loc>https://shell.online/blog/b/</loc>");
    expect(blogFeed(posts)).toContain("<link>https://shell.online/blog/a-post/</link>");
  });
});
