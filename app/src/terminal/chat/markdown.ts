/**
 * The little bit of Markdown an agent actually writes, as DOM.
 *
 * Agents write Markdown into a terminal, and a terminal cannot show it: what
 * arrives is `**bold**` with the stars, `## Heading` with the hashes, and a
 * fenced block as three backticks and some indented rows. Read as a
 * conversation it should look like what it is.
 *
 * Written here rather than taken off the shelf for two reasons. The input is
 * output from somebody else's machine, so nothing may become HTML: every node
 * below is built and its text set with `textContent`, and there is no path
 * from the input to `innerHTML` at all. And what is needed is a fraction of
 * the language -- headings, emphasis, code, lists, quotes, links -- which is
 * far less than a parser costs to carry.
 *
 * What is deliberately absent: raw HTML, images, reference links, tables.
 * Anything unrecognised stays exactly as it was typed, which is the right
 * answer for a renderer reading somebody else's output: show it, do not eat
 * it.
 */

/** Only schemes that go somewhere safe when clicked. */
const SAFE_LINK = /^https?:\/\//iu;

const FENCE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9+#._-]*)\s*$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const BULLET = /^(\s*)[-*+]\s+(.+)$/u;
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.+)$/u;
const QUOTE = /^\s*>\s?(.*)$/u;

/**
 * A row of something drawn rather than written.
 *
 * Box and block characters: the shapes a terminal makes a table, a tree or a
 * frame out of. A program asked to print a Markdown table prints one of these
 * -- the pipes and dashes are gone by the time it reaches a screen, and what
 * arrives is `┌───┬───┐` and the rows under it.
 */
const DRAWN = /[\u2500-\u259F\u2800-\u28FF]/u;

/** A table still written as Markdown: `| one | two |`. */
const PIPE_ROW = /^\s*\|.*\|\s*$/u;

/** The row under a pipe table's heading: `|---|:--:|`. */
const PIPE_RULE = /^\s*\|[\s:|-]+\|\s*$/u;

/** Whether this text has anything in it worth rendering as Markdown. */
export function looksMarkdown(text: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|`{3,})|`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:/u.test(text);
}

/**
 * Renders `text` into `host`, replacing whatever was there.
 *
 * The host is emptied with `replaceChildren`, never with `innerHTML`.
 */
export function renderMarkdown(host: HTMLElement, text: string): void {
  host.replaceChildren(...blocks(text.split("\n")));
}

function blocks(lines: readonly string[]): Node[] {
  const out: Node[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];

    const fence = FENCE.exec(line);
    if (fence) {
      const [, ticks, language] = fence;
      const body: string[] = [];
      at += 1;
      while (at < lines.length) {
        const close = FENCE.exec(lines[at]);
        if (close && close[1][0] === ticks[0] && close[1].length >= ticks.length) {
          at += 1;
          break;
        }
        body.push(lines[at]);
        at += 1;
      }
      out.push(codeBlock(body.join("\n"), language));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      const node = document.createElement(`h${Math.max(level, 3)}`);
      node.className = "md-heading";
      node.dataset.level = String(level);
      node.append(...inline(heading[2]));
      out.push(node);
      at += 1;
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      list.className = "md-list";
      while (at < lines.length) {
        const bullet = BULLET.exec(lines[at]);
        const numbered = NUMBERED.exec(lines[at]);
        if (!bullet && !numbered) break;
        if (Boolean(numbered) !== ordered) break;
        const item = document.createElement("li");
        item.append(...inline(bullet ? bullet[2] : numbered![3]));
        at += 1;
        /* Rows under an item that are indented past it continue it. */
        while (at < lines.length && /^\s{2,}\S/u.test(lines[at]) && !BULLET.test(lines[at]) && !NUMBERED.test(lines[at])) {
          item.append(document.createTextNode(" "), ...inline(lines[at].trim()));
          at += 1;
        }
        list.append(item);
      }
      out.push(list);
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const block = document.createElement("blockquote");
      block.className = "md-quote";
      const held: string[] = [];
      while (at < lines.length) {
        const more = QUOTE.exec(lines[at]);
        if (!more) break;
        held.push(more[1]);
        at += 1;
      }
      block.append(...inline(held.join(" ")));
      out.push(block);
      continue;
    }

    /*
     * Drawn, so kept exactly as drawn.
     *
     * Every row of a box table is a line of its own and none of them is
     * prose, so the paragraph rule below -- which joins consecutive rows with
     * a space, because that is what a terminal's wrapping needs undone --
     * turned a table into `┌───┬───┐ │ │ │ ├───┼───┤` on one line. Rows that
     * are drawn are never joined to anything.
     */
    if (DRAWN.test(line)) {
      const rows: string[] = [];
      while (at < lines.length && lines[at].trim() !== "" && DRAWN.test(lines[at])) {
        rows.push(lines[at]);
        at += 1;
      }
      out.push(drawnBlock(rows.join("\n")));
      continue;
    }

    /* A table still in Markdown, which an agent writing to a file produces. */
    if (PIPE_ROW.test(line) && at + 1 < lines.length && PIPE_RULE.test(lines[at + 1])) {
      const rows: string[] = [];
      while (at < lines.length && PIPE_ROW.test(lines[at])) {
        rows.push(lines[at]);
        at += 1;
      }
      out.push(pipeTable(rows));
      continue;
    }

    if (line.trim() === "") {
      at += 1;
      continue;
    }

    /* A paragraph: every row until a blank one or something that starts a block. */
    const held: string[] = [];
    while (at < lines.length && lines[at].trim() !== "" && !starts(lines[at])) {
      held.push(lines[at].trim());
      at += 1;
    }
    const paragraph = document.createElement("p");
    paragraph.className = "md-paragraph";
    paragraph.append(...inline(held.join(" ")));
    out.push(paragraph);
  }
  return out;
}

function starts(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    QUOTE.test(line) ||
    DRAWN.test(line) ||
    PIPE_ROW.test(line)
  );
}

/** Something a terminal drew: kept row for row, and scrolled rather than wrapped. */
function drawnBlock(source: string): HTMLElement {
  const block = document.createElement("pre");
  block.className = "md-drawn";
  block.textContent = source;
  return block;
}

/**
 * A Markdown table, as a table.
 *
 * Cells are split on the pipes, the heading rule is dropped, and every cell is
 * read for the emphasis and code inside it. A ragged row is not an error: the
 * short one gets fewer cells, which is what it says.
 */
function pipeTable(rows: readonly string[]): HTMLElement {
  const cellsOf = (row: string) =>
    row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const table = document.createElement("table");
  table.className = "md-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const cell of cellsOf(rows[0])) {
    const th = document.createElement("th");
    th.append(...inline(cell));
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);
  const body = document.createElement("tbody");
  for (const row of rows.slice(2)) {
    const tr = document.createElement("tr");
    for (const cell of cellsOf(row)) {
      const td = document.createElement("td");
      td.append(...inline(cell));
      tr.append(td);
    }
    body.append(tr);
  }
  if (body.childNodes.length > 0) table.append(body);
  return table;
}

/**
 * Emphasis, code and links, in one pass.
 *
 * The order matters: code first, because what is inside a backtick is not
 * Markdown and must not be read as any.
 */
function inline(text: string): Node[] {
  const out: Node[] = [];
  const pattern = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]]+)\]\(([^)\s]+)\)/gu;
  let from = 0;
  for (let hit = pattern.exec(text); hit !== null; hit = pattern.exec(text)) {
    if (hit.index > from) out.push(document.createTextNode(text.slice(from, hit.index)));
    const [, , code, strong, strongAlt, emphasis, emphasisAlt, label, href] = hit;
    if (code !== undefined) out.push(tag("code", "md-code", code));
    else if (strong !== undefined || strongAlt !== undefined) out.push(tag("strong", "md-strong", (strong ?? strongAlt)!));
    else if (emphasis !== undefined || emphasisAlt !== undefined) out.push(tag("em", "md-em", (emphasis ?? emphasisAlt)!));
    else if (label !== undefined && href !== undefined) out.push(link(label, href));
    from = hit.index + hit[0].length;
  }
  if (from < text.length) out.push(document.createTextNode(text.slice(from)));
  return out;
}

function tag(name: string, className: string, text: string): HTMLElement {
  const node = document.createElement(name);
  node.className = className;
  node.textContent = text;
  return node;
}

/** A link only where it goes somewhere a link may go; otherwise, the text. */
function link(label: string, href: string): Node {
  if (!SAFE_LINK.test(href)) return document.createTextNode(`${label} (${href})`);
  const anchor = document.createElement("a");
  anchor.className = "md-link";
  anchor.textContent = label;
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer nofollow";
  return anchor;
}

function codeBlock(source: string, language: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "md-codeblock";
  if (language) {
    const name = document.createElement("span");
    name.className = "md-codelang";
    name.textContent = language;
    wrap.append(name);
  }
  const block = document.createElement("pre");
  block.className = "md-pre";
  const code = document.createElement("code");
  code.append(...colour(source));
  block.append(code);
  wrap.append(block);
  return wrap;
}

/**
 * Colour, for the three things worth colouring in any language.
 *
 * A comment, a string and a number are lexical in every language an agent is
 * likely to print, and they are what the eye uses to find its place in a
 * block. Keywords are not: the set differs per language, guessing it wrongly
 * colours ordinary words, and a wrong colour is worse than none.
 */
function colour(source: string): Node[] {
  const out: Node[] = [];
  const pattern =
    /(\/\/[^\n]*|#[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)/gu;
  let from = 0;
  for (let hit = pattern.exec(source); hit !== null; hit = pattern.exec(source)) {
    if (hit.index > from) out.push(document.createTextNode(source.slice(from, hit.index)));
    const [text, comment, string] = hit;
    out.push(tag("span", comment ? "md-comment" : string ? "md-string" : "md-number", text));
    from = hit.index + text.length;
  }
  if (from < source.length) out.push(document.createTextNode(source.slice(from)));
  return out;
}
