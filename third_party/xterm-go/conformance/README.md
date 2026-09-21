# xterm.js ↔ Go Conformance Tests

Cross-implementation tests that verify the Go port produces identical behavior to xterm.js.

## How it works

1. **Test cases** are defined in `testcases.mjs` — each specifies terminal dimensions, input sequences, and optionally a resize operation.
2. **`generate.mjs`** runs each test case through `@xterm/headless` and captures the resulting terminal state (cursor position, line content, cell attributes, scrollback) as JSON.
3. **`conformance_test.go`** reads the golden JSON and runs the same inputs through the Go `xterm.Terminal`, comparing the output.

## Regenerating golden data

When xterm.js is updated or test cases are added:

```bash
cd conformance
yarn
node generate.mjs
```

Then run the Go tests:

```bash
cd ..
go test -run TestConformance -v
```

## Adding test cases

Add entries to `testcases.mjs`. Each test case has:

```javascript
{
  name: "descriptive_name",     // unique test name
  cols: 80, rows: 24,           // terminal dimensions
  input: "...",                  // escape sequences to write
  resize: { cols: 40, rows: 12 }, // optional: resize after input
  captureResponse: true,        // optional: capture DA/DSR responses
}
```

## What's compared

- Cursor position (x, y)
- Line text content (trimmed)
- Line wrap flags
- Per-cell attributes (fg/bg color, color mode, bold, italic, underline, etc.)
- Scrollback content
- Terminal responses (DA1, DSR)

## Rule

If the Go port behavior differs from xterm.js, **xterm.js is correct**. Fix the Go port.
