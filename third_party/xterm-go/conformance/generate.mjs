#!/usr/bin/env node
// Generates golden test data by running test cases through @xterm/headless.
// Output: testdata/golden.json consumed by the Go conformance test.

import pkg from "@xterm/headless";
const { Terminal } = pkg;
import { testCases } from "./testcases.mjs";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function captureState(term, tc) {
  const buf = term.buffer.active;
  const lines = [];
  // Capture viewport lines — only include non-empty lines and cells with content
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(y);
    if (!line) {
      lines.push({ text: "", isWrapped: false });
      continue;
    }
    const text = line.translateToString(true);
    const lineObj = { text, isWrapped: line.isWrapped };

    // Only capture cell attributes for lines with content
    if (text.length > 0) {
      const cells = [];
      for (let x = 0; x < text.length; x++) {
        const cell = line.getCell(x);
        if (!cell) break;
        const ch = cell.getChars();
        const w = cell.getWidth();
        if (ch === "" && w === 0) continue; // trailing wide char cell
        const c = {
          chars: ch,
          width: w,
        };
        // Only include non-default attributes to keep JSON small
        const fgColor = cell.getFgColor();
        const bgColor = cell.getBgColor();
        const fgMode = cell.getFgColorMode();
        const bgMode = cell.getBgColorMode();
        if (fgMode !== 0) { c.fgMode = fgMode; c.fg = fgColor; }
        if (bgMode !== 0) { c.bgMode = bgMode; c.bg = bgColor; }
        if (cell.isBold()) c.bold = 1;
        if (cell.isItalic()) c.italic = 1;
        if (cell.isUnderline()) c.underline = 1;
        if (cell.isBlink()) c.blink = 1;
        if (cell.isInverse()) c.inverse = 1;
        if (cell.isInvisible()) c.invisible = 1;
        if (cell.isStrikethrough()) c.strikethrough = 1;
        if (cell.isOverline()) c.overline = 1;
        if (cell.isDim()) c.dim = 1;
        cells.push(c);
      }
      lineObj.cells = cells;
    }
    lines.push(lineObj);
  }

  // Trim trailing empty lines from the array
  while (lines.length > 0 && lines[lines.length - 1].text === "" && !lines[lines.length - 1].isWrapped) {
    lines.pop();
  }

  // Capture scrollback lines (above viewport)
  const scrollback = [];
  const scrollbackLen = buf.length - term.rows;
  for (let y = 0; y < scrollbackLen; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text.length > 0 || line.isWrapped) {
      scrollback.push({
        text,
        isWrapped: line.isWrapped,
      });
    }
  }

  return {
    cursor: { x: buf.cursorX, y: buf.cursorY },
    lines,
    scrollback: scrollback.length > 0 ? scrollback : undefined,
    bufferType: buf.type,
  };
}

async function run() {
  const results = [];

  for (const tc of testCases) {
    const term = new Terminal({
      cols: tc.cols,
      rows: tc.rows,
      scrollback: tc.scrollback ?? 1000,
      allowProposedApi: true,
    });

    let response = "";
    if (tc.captureResponse) {
      term.onData((data) => {
        response += data;
      });
    }

    // Write input
    term.write(tc.input);
    // Flush — xterm-headless processes synchronously in write()
    // but we need to wait for the write buffer to flush
    await new Promise((r) => setTimeout(r, 50));

    // Apply resize if specified
    if (tc.resize) {
      term.resize(tc.resize.cols, tc.resize.rows);
    }

    const state = captureState(term, tc);

    const result = {
      name: tc.name,
      cols: tc.resize ? tc.resize.cols : tc.cols,
      rows: tc.resize ? tc.resize.rows : tc.rows,
      initialCols: tc.cols,
      initialRows: tc.rows,
      input: tc.input,
      expected: state,
    };

    if (tc.captureResponse) {
      result.expectedResponse = response;
    }
    if (tc.resize) {
      result.resize = tc.resize;
    }

    results.push(result);
    term.dispose();
  }

  const outPath = join(__dirname, "testdata", "golden.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
  console.log(`Generated ${results.length} golden test cases → ${outPath}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
