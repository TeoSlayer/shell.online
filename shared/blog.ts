import registry from "../blog/posts.json";

/** One entry of blog/posts.json. The body is blog/posts/<slug>.html. */
export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  iso_date: string;
  author?: string;
  /** Path under /blog/ of custom artwork. Without one the build draws a title card. */
  banner?: string;
  /** Where the post was first published, when that is not this site. */
  canonical?: string;
}

export type BlogRoute = { kind: "index" } | { kind: "post"; slug: string };

const BLOG_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BLOG_ROUTE = /^\/blog(?:\/([a-z0-9]+(?:-[a-z0-9]+)*))?\/?$/;
// Directories the build writes next to the posts.
const RESERVED_SLUGS = new Set(["banners"]);

export function sortBlogPosts(posts: readonly BlogPost[]): BlogPost[] {
  return [...posts].sort((a, b) => b.iso_date.localeCompare(a.iso_date));
}

/** Every published post, newest first. */
export const blogPosts: BlogPost[] = sortBlogPosts(registry as BlogPost[]);

export function blogCategories(posts: readonly BlogPost[]): string[] {
  return [...new Set(posts.map((post) => post.category))];
}

export function blogHref(slug: string): string {
  return `/blog/${slug}/`;
}

export function resolveBlogRoute(
  pathname: string,
  posts: readonly BlogPost[] = blogPosts,
): BlogRoute | null {
  const match = pathname.match(BLOG_ROUTE);
  if (!match) return null;
  if (!match[1]) return { kind: "index" };
  return posts.some((post) => post.slug === match[1])
    ? { kind: "post", slug: match[1] }
    : null;
}

/**
 * Where a request under /blogs belongs: the same path under /blog/. People
 * type the plural; it should land on the index or the post, not a 404.
 */
export function blogAliasRedirect(pathname: string): string | null {
  if (pathname === "/blogs" || pathname === "/blogs/") return "/blog/";
  if (!pathname.startsWith("/blogs/")) return null;
  const rest = pathname.slice("/blogs/".length);
  return `/blog/${rest}`;
}

// The assets binding answers an unknown path with the landing page. Under
// /blog/ that would make every mistyped post URL a 200 copy of the homepage.
export function blogAssetIsSpaFallback(
  pathname: string,
  contentType: string | null,
): boolean {
  return (
    (pathname === "/blog" || pathname.startsWith("/blog/")) &&
    (contentType?.toLowerCase().startsWith("text/html") ?? false) &&
    resolveBlogRoute(pathname) === null
  );
}

/** Posts that share tags with this one, closest first. */
export function relatedBlogPosts(
  post: BlogPost,
  posts: readonly BlogPost[],
  limit = 3,
): BlogPost[] {
  const tags = new Set(post.tags.map((tag) => tag.toLowerCase()));
  return posts
    .filter((other) => other.slug !== post.slug)
    .map((other) => ({
      other,
      shared: other.tags.filter((tag) => tags.has(tag.toLowerCase())).length,
    }))
    .filter(({ shared }) => shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, limit)
    .map(({ other }) => other);
}

/** Everything wrong with the registry. The build refuses to ship any of it. */
export function blogRegistryProblems(posts: readonly unknown[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  posts.forEach((entry, index) => {
    const post = entry as Partial<BlogPost>;
    const name =
      typeof post?.slug === "string" ? post.slug : `entry ${index + 1}`;
    const problem = (message: string) => problems.push(`${name}: ${message}`);
    if (typeof post?.slug !== "string" || !BLOG_SLUG.test(post.slug))
      return problem("slug must be lowercase words joined by hyphens");
    if (RESERVED_SLUGS.has(post.slug)) problem("slug is reserved");
    if (seen.has(post.slug)) problem("slug is used twice");
    seen.add(post.slug);
    for (const field of ["title", "description", "category"] as const)
      if (typeof post[field] !== "string" || !post[field].trim())
        problem(`${field} is missing`);
    if (
      !Array.isArray(post.tags) ||
      !post.tags.every((tag) => typeof tag === "string" && tag.trim())
    )
      problem("tags must be a list of words");
    if (
      typeof post.iso_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(post.iso_date) ||
      Number.isNaN(Date.parse(`${post.iso_date}T00:00:00Z`))
    )
      problem("iso_date must be YYYY-MM-DD");
    if (post.author !== undefined && typeof post.author !== "string")
      problem("author must be a name");
    if (
      post.banner !== undefined &&
      (typeof post.banner !== "string" ||
        !/^banners\/[a-z0-9-]+\.(?:svg|png|jpg|webp)$/.test(post.banner))
    )
      problem("banner must be a file under banners/");
    if (
      post.canonical !== undefined &&
      (typeof post.canonical !== "string" ||
        !/^https:\/\/[^\s"<>]+$/.test(post.canonical))
    )
      problem("canonical must be an https URL");
  });
  return problems;
}
