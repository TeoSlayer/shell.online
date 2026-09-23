/**
 * Lays a session's screen out again for one viewer's width.
 *
 * A session runs at one grid, because a process can only be told one size.
 * Every viewer keeps an exact copy of that grid, and this module decides what
 * that copy looks like on a screen of a different width. It is a pure
 * function of the rows it is handed and the width asked for, so the same
 * screen at the same width always comes out the same, however often and in
 * whatever order it is asked.
 *
 * Nothing here can make a full-screen program fit a smaller screen: a program
 * that places every character itself has one layout, and the caller shows
 * that grid as it is. What this handles is everything else, which is most of
 * what people run: a shell, logs, builds, and coding agents, which print into
 * the normal buffer and break their own lines at the session's width.
 *
 * The unit of layout is a block: the rows the program meant as one line.
 * Two kinds of break are undone to find it.
 *
 * - The terminal's own wrap. A line longer than the grid continues on the
 *   next row, and the emulator marks that row as a continuation.
 * - The program's. Coding agents break their prose themselves, at the
 *   session's width, with an ordinary line break. The rule that recovers it
 *   is the one a reader uses: a row that ran to the edge is continued by the
 *   next row, a row that stopped short of it stopped on purpose. The next
 *   row's first word is the proof -- if it would have fitted on the row above,
 *   the break was deliberate.
 *
 * A block whose spacing is carrying meaning -- columns, drawing, a table -- is
 * never joined with anything, and is only cut where it has to be.
 */

/** One cell of the session's grid, reduced to what layout and painting need. */
export interface Cell {
  /** The glyph, or "" for an empty cell. */
  chars: string;
  /** 1, or 2 for a wide character. Never 0: the trailing half is not a cell here. */
  width: number;
  /** The SGR parameters that draw it, "" for the default appearance. */
  style: string;
  /** Whether it shows anything: a glyph, or a colored background. */
  ink: boolean;
}

export interface SourceRow {
  cells: readonly Cell[];
  /** The emulator's own mark: this row continues the one above it. */
  wrapped: boolean;
}

/** Read access to the session's buffer, by absolute row number. */
export interface SourceScreen {
  /** The session grid's width, which is where the program broke its lines. */
  readonly width: number;
  /** Rows in the buffer, scrollback included. */
  readonly length: number;
  row(y: number): SourceRow;
}

/** A row laid out for the viewer. */
export interface LaidRow {
  cells: Cell[];
  /** Where the cursor is on this row, when it is on this row. */
  cursor?: number;
}

export interface CursorAt {
  x: number;
  y: number;
}

const BLANK: Cell = { chars: " ", width: 1, style: "", ink: false };

/* Box drawing, block elements and braille: a line with one in it is a picture. */
const DRAWING = /[─-▟⠀-⣿]/u;

/* A line made of one drawing character repeated, such as a rule. */
const RULE_CHARS = /^[─-╿▀-▟=\-_~·•]$/u;

/*
 * What starts an item rather than continuing one: list bullets, numbers, and
 * the markers coding agents put in front of what was said and what was typed.
 */
const MARKER = /^(?:[-*+•●○◦▪▸►▶◆◇⏺⎿❯›>✻✳✶✽✢·※→⚠✓✔✗✘]|\d{1,3}[.)]|\[[ xX]\])(?= )/u;

/** How close to the edge a row must end to count as having run to it. */
const EDGE_SLACK = 2;

/* ------------------------------------------------------------------------ */
/* Reading rows                                                              */
/* ------------------------------------------------------------------------ */

/** Cells up to and including the last one that shows anything. */
export function inkEnd(cells: readonly Cell[]): number {
  let width = 0;
  let end = 0;
  for (const cell of cells) {
    width += cell.width;
    if (cell.ink) end = width;
  }
  return end;
}

/** Columns of blank cells before the first one that shows anything. */
function indentOf(cells: readonly Cell[]): number {
  let width = 0;
  for (const cell of cells) {
    if (cell.ink) return width;
    width += cell.width;
  }
  return width;
}

function textOf(cells: readonly Cell[]): string {
  let text = "";
  for (const cell of cells) text += cell.chars || " ";
  return text;
}

/** The width of the first word at or after `from`. */
function firstWordWidth(cells: readonly Cell[], from: number): number {
  let column = 0;
  let width = 0;
  for (const cell of cells) {
    if (column >= from) {
      if (!cell.ink || cell.chars === " ") break;
      width += cell.width;
    }
    column += cell.width;
  }
  return width;
}

/** A logical line: one row, plus the rows the terminal wrapped it onto. */
export interface Line {
  /** Absolute row of its first row. */
  start: number;
  /** Absolute row after its last row. */
  end: number;
  cells: Cell[];
  /** The cells of its last row, which decide whether it ran to the edge. */
  last: readonly Cell[];
}

/*
 * The longest logical line laid out as one. `cat` of a minified file is one
 * line of thousands of rows; past this it is cut at rows whose number is a
 * multiple of it, which every window agrees on, so no row is ever part of two
 * different lines.
 */
const MAX_LINE_ROWS = 128;

/** The logical line containing absolute row `y`. */
export function lineAt(screen: SourceScreen, y: number): Line {
  let start = y;
  while (start > 0 && start % MAX_LINE_ROWS !== 0 && screen.row(start).wrapped) start -= 1;
  let end = y + 1;
  while (end < screen.length && end % MAX_LINE_ROWS !== 0 && screen.row(end).wrapped) end += 1;
  const cells: Cell[] = [];
  for (let row = start; row < end; row += 1) cells.push(...screen.row(row).cells);
  return { start, end, cells, last: screen.row(end - 1).cells };
}

interface Shape {
  blank: boolean;
  indent: number;
  /** Where text starts after a list marker, or the indent when there is none. */
  hang: number;
  marker: boolean;
  structural: boolean;
  /** Column after the last inked cell of the line's last row. */
  lastRowEnd: number;
  text: string;
}

function shapeOf(line: Line): Shape {
  const text = textOf(line.cells);
  const blank = !line.cells.some((cell) => cell.ink);
  const indent = indentOf(line.cells);
  const body = text.slice(indent).replace(/\s+$/u, "");
  const marker = MARKER.exec(body);
  let hang = indent;
  if (marker) {
    hang = indent + marker[0].length;
    while (body[hang - indent] === " ") hang += 1;
  }
  return {
    blank,
    indent,
    hang,
    marker: marker !== null,
    structural: DRAWING.test(body) || /\S {2,}\S/u.test(body),
    lastRowEnd: inkEnd(line.last),
    text: body,
  };
}

/**
 * Whether `next` carries on the sentence `previous` was writing, because the
 * program broke the line rather than ending it.
 */
export function continues(previous: Line, next: Line, width: number): boolean {
  const a = shapeOf(previous);
  const b = shapeOf(next);
  if (a.blank || b.blank || a.structural || b.structural || b.marker) return false;
  /*
   * A line the terminal wrapped was never broken by the program: it was
   * written as one line and it ended where it ended, however near the edge.
   */
  if (previous.end - previous.start > 1) return false;
  if (b.indent !== a.hang) return false;
  const word = firstWordWidth(next.cells, b.indent);
  /* The next row's first word would have fitted: the row stopped on purpose. */
  return a.lastRowEnd + 1 + word > width - EDGE_SLACK;
}

/* ------------------------------------------------------------------------ */
/* Blocks                                                                    */
/* ------------------------------------------------------------------------ */

export interface Block {
  start: number;
  end: number;
  lines: Line[];
}

/** The block that absolute row `y` belongs to. */
export function blockAt(screen: SourceScreen, y: number): Block {
  let first = lineAt(screen, y);
  const lines = [first];
  while (first.start > 0) {
    const previous = lineAt(screen, first.start - 1);
    if (!continues(previous, first, screen.width)) break;
    lines.unshift(previous);
    first = previous;
  }
  let last = lines[lines.length - 1];
  while (last.end < screen.length) {
    const next = lineAt(screen, last.end);
    if (!continues(last, next, screen.width)) break;
    lines.push(next);
    last = next;
  }
  return { start: lines[0].start, end: last.end, lines };
}

/* ------------------------------------------------------------------------ */
/* Laying a block out                                                        */
/* ------------------------------------------------------------------------ */

interface Piece {
  cell: Cell;
  cursor: boolean;
}

/**
 * The block at the viewer's width. `cursor` is the cursor's position in the
 * session grid, when it is inside this block.
 */
export function layBlock(block: Block, sessionWidth: number, width: number, cursor?: CursorAt): LaidRow[] {
  const cursorLine = cursor ? block.lines.find((line) => cursor.y >= line.start && cursor.y < line.end) : undefined;
  const cursorColumn = cursor && cursorLine ? (cursor.y - cursorLine.start) * sessionWidth + cursor.x : -1;

  /* A line keeps its cells up to its ink, and up to the cursor if that is further. */
  const kept = (line: Line): Cell[] => {
    let end = inkEnd(line.cells);
    if (line === cursorLine) end = Math.max(end, cursorColumn + 1);
    const cells: Cell[] = [];
    let column = 0;
    for (const cell of line.cells) {
      if (column >= end) break;
      cells.push(cell);
      column += cell.width;
    }
    while (column < end) {
      cells.push(BLANK);
      column += 1;
    }
    return cells;
  };

  const first = block.lines[0];
  const shape = shapeOf(first);
  if (shape.blank && first !== cursorLine) return [{ cells: [] }];

  const single = block.lines.length === 1;
  const cells = kept(first);
  const used = cells.reduce((sum, cell) => sum + cell.width, 0);

  /* Fits as it is: nothing to do, and the common case at a wide viewer. */
  if (single && used <= width) return [withCursor(cells, cursorColumn)];

  /* A rule is drawn across the viewer's width, not wrapped into two. */
  if (single && isRule(cells, shape.indent)) {
    const glyph = cells[shape.indent];
    return [{ cells: Array.from({ length: width }, () => glyph) }];
  }

  /* Pushed against the right edge: kept against the viewer's right edge. */
  if (single && shape.indent >= 4 && used >= sessionWidth - EDGE_SLACK && used - shape.indent <= width) {
    const content = cells.slice(cellIndexAt(cells, shape.indent));
    const pad = width - (used - shape.indent);
    return [{ cells: [...Array.from({ length: pad }, () => BLANK), ...content] }];
  }

  const pieces = (line: Line, from: number): Piece[] => {
    const lineCells = kept(line);
    const out: Piece[] = [];
    let column = 0;
    for (const cell of lineCells) {
      const here = column;
      column += cell.width;
      if (here < from) continue;
      out.push({ cell, cursor: line === cursorLine && here === cursorColumn });
    }
    return out;
  };

  /* Spacing that carries meaning is cut at the edge and nowhere else. */
  if (shape.structural && single) {
    return spaceWrap(pieces(first, 0), width);
  }

  const indent = Math.min(shape.indent, Math.floor(width / 3));
  const hang = Math.min(shape.hang, Math.floor(width / 3));
  const flow: Piece[] = pieces(first, shape.indent);
  for (const line of block.lines.slice(1)) {
    const next = pieces(line, indentOf(line.cells));
    if (next.length === 0) continue;
    const last = flow[flow.length - 1];
    if (last && last.cell.chars !== " ") flow.push({ cell: BLANK, cursor: false });
    flow.push(...next);
  }
  /* The cursor sitting before the text, on an indented empty line, still has to show. */
  if (cursorLine === first && cursorColumn < shape.indent && cursorColumn >= 0) {
    return [withCursor(cells, cursorColumn)];
  }
  return wordWrap(flow, width, indent, hang);
}

function isRule(cells: readonly Cell[], indent: number): boolean {
  const body = cells.slice(cellIndexAt(cells, indent)).filter((cell) => cell.ink);
  if (body.length < 3) return false;
  const glyph = body[0].chars;
  return RULE_CHARS.test(glyph) && body.every((cell) => cell.chars === glyph && cell.style === body[0].style);
}

function cellIndexAt(cells: readonly Cell[], column: number): number {
  let width = 0;
  for (let index = 0; index < cells.length; index += 1) {
    if (width >= column) return index;
    width += cells[index].width;
  }
  return cells.length;
}

function withCursor(cells: Cell[], column: number): LaidRow {
  if (column < 0) return { cells };
  let width = 0;
  for (const cell of cells) {
    if (width >= column) break;
    width += cell.width;
  }
  return { cells, cursor: Math.max(0, Math.min(column, width)) };
}

/**
 * Cuts a line whose spacing matters, keeping every space it has: at the last
 * space that leaves at least half a row, or at the edge when there is none.
 */
function spaceWrap(pieces: readonly Piece[], width: number): LaidRow[] {
  const rows: LaidRow[] = [];
  let rest = pieces.slice();
  while (rest.length > 0) {
    let used = 0;
    let cut = 0;
    while (cut < rest.length && used + rest[cut].cell.width <= width) {
      used += rest[cut].cell.width;
      cut += 1;
    }
    if (cut < rest.length && rest[cut].cell.chars !== " ") {
      /* The last space that still fits ends the row, and goes with it. */
      let space = cut - 1;
      while (space > 0 && rest[space].cell.chars !== " ") space -= 1;
      if (space > cut / 2) cut = space + 1;
    }
    const taken = rest.slice(0, Math.max(1, cut));
    const row: LaidRow = { cells: taken.map((piece) => piece.cell) };
    let column = 0;
    for (const piece of taken) {
      if (piece.cursor) row.cursor = column;
      column += piece.cell.width;
    }
    rows.push(rows.length === 0 ? row : trimRow(row));
    rest = rest.slice(taken.length);
    /* A row that continues does not start with the space it was cut at. */
    if (rest.length > 0 && rest[0].cell.chars === " " && !rest[0].cursor) rest = rest.slice(1);
  }
  return rows.length ? rows : [{ cells: [] }];
}

/**
 * Greedy word wrap. Spaces are where lines may break, and a space at the
 * start of a continued row is dropped -- unless the cursor is on it, which is
 * how a prompt's trailing space keeps its cursor.
 */
function wordWrap(flow: readonly Piece[], width: number, indent: number, hang: number): LaidRow[] {
  /* Words: runs of non-space pieces, and each space as its own token. */
  const tokens: Piece[][] = [];
  let word: Piece[] = [];
  for (const piece of flow) {
    if (piece.cell.chars === " " || piece.cell.chars === "") {
      if (word.length) tokens.push(word);
      tokens.push([piece]);
      word = [];
    } else {
      word.push(piece);
    }
  }
  if (word.length) tokens.push(word);

  const rows: LaidRow[] = [];
  let row: LaidRow = { cells: Array.from({ length: indent }, () => BLANK) };
  let used = indent;
  const breakRow = () => {
    rows.push(trimRow(row));
    row = { cells: Array.from({ length: hang }, () => BLANK) };
    used = hang;
  };
  const place = (piece: Piece) => {
    if (piece.cursor) row.cursor = used;
    row.cells.push(piece.cell);
    used += piece.cell.width;
  };

  for (const token of tokens) {
    const tokenWidth = token.reduce((sum, piece) => sum + piece.cell.width, 0);
    const space = token.length === 1 && (token[0].cell.chars === " " || token[0].cell.chars === "");
    if (space) {
      if (used === hang && rows.length > 0 && !token[0].cursor) continue;
      if (used + 1 > width) {
        breakRow();
        if (!token[0].cursor) continue;
      }
      place(token[0]);
      continue;
    }
    if (used + tokenWidth > width && used > (rows.length > 0 ? hang : indent)) breakRow();
    for (const piece of token) {
      if (used + piece.cell.width > width) breakRow();
      place(piece);
    }
  }
  rows.push(trimRow(row));
  return rows;
}

/* Trailing blanks carry nothing, except where the cursor is. */
function trimRow(row: LaidRow): LaidRow {
  let end = row.cells.length;
  while (end > 0 && !row.cells[end - 1].ink && (row.cursor === undefined || end - 1 > row.cursor)) end -= 1;
  return end === row.cells.length ? row : { cells: row.cells.slice(0, end), cursor: row.cursor };
}

/* ------------------------------------------------------------------------ */
/* Windows onto the laid-out document                                        */
/* ------------------------------------------------------------------------ */

export interface LayoutOptions {
  /** The session grid's cursor, in absolute rows. */
  cursor?: CursorAt;
  /**
   * Collapse runs of blank rows to one. A full-screen program pads between
   * what it has drawn and the box at the foot of the screen, and that padding
   * is sized for the session's height, not the viewer's. A shell's blank
   * lines are what the program printed, so the normal buffer keeps them.
   */
  collapseBlankRuns?: boolean;
  /** Rows above this are not part of the document: the top of the alternate screen. */
  top?: number;
}

/**
 * Where a viewer is looking: the block that starts the window, and how many
 * of that block's laid-out rows are above the top of it.
 */
export interface Anchor {
  y: number;
  offset: number;
}

export interface Window {
  rows: LaidRow[];
  /** The top of the window, for keeping it in place while more output arrives. */
  anchor: Anchor;
  /** Whether the window's last row is the document's last row. */
  atBottom: boolean;
}

/**
 * The row after the last row of the document: the last row with ink or the
 * cursor on it. Blank rows at the foot of the grid are the part of the screen
 * nobody has written to yet, not content.
 */
export function documentEnd(screen: SourceScreen, options: LayoutOptions = {}): number {
  const top = options.top ?? 0;
  let end = options.cursor ? options.cursor.y + 1 : top;
  for (let y = screen.length - 1; y >= end; y -= 1) {
    if (screen.row(y).cells.some((cell) => cell.ink)) {
      end = y + 1;
      break;
    }
  }
  return Math.max(end, Math.min(top + 1, screen.length));
}

/* One block within the document, laid out, with blank runs collapsed when asked. */
function laid(screen: SourceScreen, block: Block, width: number, end: number, options: LayoutOptions): LaidRow[] {
  const rows = layBlock(clip(block, end), screen.width, width, options.cursor);
  if (!options.collapseBlankRuns) return rows;
  const top = options.top ?? 0;
  const blank = rows.length === 1 && rows[0].cells.length === 0 && rows[0].cursor === undefined;
  if (!blank || block.start <= top) return rows;
  const above = screen.row(block.start - 1);
  return above.cells.some((cell) => cell.ink) || isCursorRow(block.start - 1, options) ? rows : [];
}

function isCursorRow(y: number, options: LayoutOptions): boolean {
  return options.cursor?.y === y;
}

function blockWithin(screen: SourceScreen, y: number, options: LayoutOptions): Block {
  const block = blockAt(screen, y);
  const top = options.top ?? 0;
  if (block.start >= top) return block;
  const lines = block.lines.filter((line) => line.start >= top);
  return lines.length ? { start: lines[0].start, end: block.end, lines } : { ...block, start: top };
}

/** Lays out from `anchor` downwards until `height` rows are filled or the document ends. */
export function windowFrom(
  screen: SourceScreen,
  width: number,
  height: number,
  anchor: Anchor,
  options: LayoutOptions = {},
): Window {
  const top = options.top ?? 0;
  const end = documentEnd(screen, options);
  const rows: LaidRow[] = [];
  let y = blockWithin(screen, Math.max(top, Math.min(anchor.y, end - 1)), options).start;
  let skip = Math.max(0, anchor.offset);
  let first: Anchor | null = null;
  while (y < end && rows.length < height) {
    const block = blockWithin(screen, y, options);
    const blockRows = laid(screen, block, width, end, options);
    if (skip >= blockRows.length) {
      skip -= blockRows.length;
      y = block.end;
      continue;
    }
    first ??= { y: block.start, offset: skip };
    rows.push(...blockRows.slice(skip, skip + height - rows.length));
    skip = 0;
    y = block.end;
  }
  return { rows, anchor: first ?? { y, offset: 0 }, atBottom: y >= end };
}

/**
 * The last `height` rows of the document, and the anchor that shows the same
 * window, so a viewer who scrolls up starts from what they were looking at.
 */
export function windowAtBottom(screen: SourceScreen, width: number, height: number, options: LayoutOptions = {}): Window {
  const top = options.top ?? 0;
  const end = documentEnd(screen, options);
  const collected: { block: Block; rows: LaidRow[] }[] = [];
  let count = 0;
  let y = end;
  while (y > top && count < height) {
    const block = blockWithin(screen, y - 1, options);
    const rows = laid(screen, block, width, end, options);
    collected.unshift({ block, rows });
    count += rows.length;
    y = block.start;
  }
  const all = collected.flatMap((entry) => entry.rows);
  const drop = Math.max(0, all.length - height);
  const anchor: Anchor = collected.length ? { y: collected[0].block.start, offset: drop } : { y: top, offset: 0 };
  return { rows: all.slice(drop), anchor, atBottom: true };
}

/** Moves an anchor by `delta` laid-out rows, negative for up. */
export function scrollAnchor(
  screen: SourceScreen,
  width: number,
  anchor: Anchor,
  delta: number,
  options: LayoutOptions = {},
): Anchor {
  const top = options.top ?? 0;
  const end = documentEnd(screen, options);
  let block = blockWithin(screen, Math.max(top, Math.min(anchor.y, end - 1)), options);
  let offset = anchor.offset + delta;
  while (offset < 0) {
    if (block.start <= top) return { y: top, offset: 0 };
    block = blockWithin(screen, block.start - 1, options);
    offset += laid(screen, block, width, end, options).length;
  }
  for (;;) {
    const length = laid(screen, block, width, end, options).length;
    if (offset < length || block.end >= end) {
      return { y: block.start, offset: Math.max(0, Math.min(offset, length - 1)) };
    }
    offset -= length;
    block = blockWithin(screen, block.end, options);
  }
}

function clip(block: Block, end: number): Block {
  if (block.end <= end) return block;
  const lines = block.lines.filter((line) => line.start < end);
  return { start: block.start, end, lines: lines.length ? lines : block.lines.slice(0, 1) };
}
