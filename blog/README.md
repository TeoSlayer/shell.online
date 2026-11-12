# Blog

The pages under [shell.online/blog/](https://shell.online/blog/). The build
renders them as static HTML, the same way it renders the guides.

| File | What it is |
| --- | --- |
| `blog/posts.json` | The registry: one entry per post. |
| `blog/posts/<slug>.html` | The body of that post. |
| `shared/blog.ts` | Registry types, validation and routes. |
| `shared/blog-view.ts` | The index, post, feed, sitemap and banner markup. |
| `web/blog.html`, `web/blog.css`, `web/blog-entry.ts` | The page template, its styles and its script. |

## Publish a post

1. Add an entry to `blog/posts.json`. Order does not matter; posts are sorted
   by date.

   ```json
   {
     "slug": "revoke-a-shared-link",
     "title": "How to Revoke a Shared Terminal Link",
     "description": "One or two sentences, 70 to 170 characters, shown on the card and to search engines.",
     "category": "Security",
     "tags": ["terminal-sharing", "credential-rotation"],
     "iso_date": "2026-10-02"
   }
   ```

2. Write the body in `blog/posts/<slug>.html`. It is the HTML that goes under
   the title: paragraphs, `<h2>` sections, `<pre><code>` blocks, lists,
   `<div class="callout">` for a note and `<div class="cta">` for a closing
   call to action. Do not include an `<h1>`, scripts, styles or images hosted
   elsewhere; the build refuses them.

3. Run `npm run build:web`. It fails if the registry or a body is invalid.

Each `<h2>` becomes an entry in the post's table of contents. A new category
becomes a filter on the index.

## Optional fields

| Field | Effect |
| --- | --- |
| `author` | A person's name for the byline. Without it the post is by the shell.online team. |
| `banner` | Artwork for the post, as `banners/<name>.png` (or `.svg`, `.jpg`, `.webp`) in `public/blog/`. Without it the build draws a title card. |
| `canonical` | The `https` URL where the post was first published. The page names that URL as canonical, credits it, and stays out of the sitemap. |

## Preview

```sh
npx vite
```

Open `/blog/` on the address it prints. Post bodies are read on every
request, so an edit shows on reload.
