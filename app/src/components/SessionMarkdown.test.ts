import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";
import {SessionMarkdown} from "./SessionMarkdown";

const render = (text: string, compact = false) => renderToStaticMarkup(createElement(SessionMarkdown, {text, compact}));
describe("session Markdown", () => {
  it("renders structure rather than exposing Markdown punctuation", () => {
    const html = render("## Work\n\n**Ready** and *reviewed*\n\n- first\n- second\n\n```sh\necho ok\n```");
    for (const part of ["<h2>Work</h2>", "<strong>Ready</strong>", "<em>reviewed</em>", "<ul>", "<li>first</li>", "<pre><code"]) expect(html).toContain(part);
  });
  it("supports GFM tables and strikethrough", () => {
    const html = render("~~old~~\n\n| Task | State |\n| --- | --- |\n| Build | Ready |");
    expect(html).toContain("<del>old</del>");
    expect(html).toContain("<table>");
  });
  it("never executes raw HTML or loads remote images", () => {
    const html = render('<script>alert(1)</script>\n\n<img src="https://example.com/track">\n\n![diagram](https://example.com/pixel)');
    expect(html).not.toMatch(/<script|<img|src=|example\.com/);
    expect(html).toContain("diagram");
  });
  it.each(["javascript:alert(1)", "data:text/html,hello", "/api/delete", "//evil.example/path", "https://user:secret@example.com"])("rejects unsafe link %s", url => {
    expect(render(`[link](<${url}>)`)).not.toContain("href=");
  });
  it("opens explicit web links without opener or referrer", () => {
    const html = render("[docs](https://example.com/docs)");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('referrerPolicy="no-referrer"');
  });
  it("renders incomplete Markdown and bounds excessive input", () => {
    expect(render("**unfinished `code")).toContain("unfinished");
    expect(render("x".repeat(10000)).length).toBeLessThan(8500);
    expect(render("**preview**", true)).toContain("is-compact");
  });
});
