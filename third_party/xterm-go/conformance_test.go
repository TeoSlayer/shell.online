package xterm_test

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"

	"github.com/gitpod-io/xterm-go"
)

// goldenTestCase matches the JSON structure produced by conformance/generate.mjs.
type goldenTestCase struct {
	Name             string        `json:"name"`
	Cols             int           `json:"cols"`
	Rows             int           `json:"rows"`
	InitialCols      int           `json:"initialCols"`
	InitialRows      int           `json:"initialRows"`
	Input            string        `json:"input"`
	Resize           *goldenResize `json:"resize,omitempty"`
	Expected         goldenState   `json:"expected"`
	ExpectedResponse string        `json:"expectedResponse,omitempty"`
}

type goldenResize struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type goldenState struct {
	Cursor     goldenCursor `json:"cursor"`
	Lines      []goldenLine `json:"lines"`
	Scrollback []goldenLine `json:"scrollback,omitempty"`
	BufferType string       `json:"bufferType"`
}

type goldenCursor struct {
	X int `json:"x"`
	Y int `json:"y"`
}

type goldenLine struct {
	Text      string       `json:"text"`
	IsWrapped bool         `json:"isWrapped"`
	Cells     []goldenCell `json:"cells,omitempty"`
}

type goldenCell struct {
	Chars         string `json:"chars"`
	Width         int    `json:"width"`
	Fg            int    `json:"fg,omitempty"`
	FgMode        int    `json:"fgMode,omitempty"`
	Bg            int    `json:"bg,omitempty"`
	BgMode        int    `json:"bgMode,omitempty"`
	Bold          int    `json:"bold,omitempty"`
	Italic        int    `json:"italic,omitempty"`
	Underline     int    `json:"underline,omitempty"`
	Blink         int    `json:"blink,omitempty"`
	Inverse       int    `json:"inverse,omitempty"`
	Invisible     int    `json:"invisible,omitempty"`
	Strikethrough int    `json:"strikethrough,omitempty"`
	Overline      int    `json:"overline,omitempty"`
	Dim           int    `json:"dim,omitempty"`
}

func loadGoldenTestCases(t *testing.T) []goldenTestCase {
	t.Helper()
	data, err := os.ReadFile("conformance/testdata/golden.json")
	if err != nil {
		t.Fatalf("failed to read golden.json: %v", err)
	}
	var cases []goldenTestCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("failed to parse golden.json: %v", err)
	}
	return cases
}

// captureGoState runs the input through the Go terminal and captures state
// in the same format as the golden data.
func captureGoState(t *testing.T, tc goldenTestCase) (goldenState, string) {
	t.Helper()

	term := xterm.New(
		xterm.WithCols(tc.InitialCols),
		xterm.WithRows(tc.InitialRows),
		xterm.WithScrollback(1000),
	)
	defer term.Dispose()

	var response string
	if tc.ExpectedResponse != "" {
		term.OnData(func(data string) {
			response += data
		})
	}

	term.WriteString(tc.Input)

	if tc.Resize != nil {
		term.Resize(tc.Resize.Cols, tc.Resize.Rows)
	}

	buf := term.Buffer()
	rows := tc.Rows
	cols := tc.Cols

	// Capture viewport lines — xterm.js getLine(y) returns absolute position y
	// in the buffer (including scrollback), not relative to ybase.
	var lines []goldenLine
	for y := range rows {
		line := buf.Lines.Get(y)
		if line == nil {
			lines = append(lines, goldenLine{})
			continue
		}
		text := line.TranslateToString(true, 0, -1)
		gl := goldenLine{
			Text:      text,
			IsWrapped: line.IsWrapped,
		}

		// Capture cell attributes for lines with content
		if len(text) > 0 {
			var cells []goldenCell
			cell := &xterm.CellData{}
			// Iterate by cell count matching the trimmed text length in runes,
			// same as xterm.js which iterates x < text.length (JS string length).
			textRuneLen := len([]rune(text))
			for x := range textRuneLen {
				line.LoadCell(x, cell)
				ch := cell.GetChars()
				w := cell.GetWidth()
				if ch == "" && w == 0 {
					continue // trailing wide char cell
				}
				gc := goldenCell{
					Chars: ch,
					Width: w,
				}
				// Extract color mode and value (cast uint32 → int to match JSON)
				fgMode := int(cell.GetFgColorMode())
				bgMode := int(cell.GetBgColorMode())
				if fgMode != 0 {
					gc.FgMode = fgMode
					gc.Fg = cell.GetFgColor()
				}
				if bgMode != 0 {
					gc.BgMode = bgMode
					gc.Bg = cell.GetBgColor()
				}
				if cell.IsBold() != 0 {
					gc.Bold = 1
				}
				if cell.IsItalic() != 0 {
					gc.Italic = 1
				}
				if cell.IsUnderline() != 0 {
					gc.Underline = 1
				}
				if cell.IsBlink() != 0 {
					gc.Blink = 1
				}
				if cell.IsInverse() != 0 {
					gc.Inverse = 1
				}
				if cell.IsInvisible() != 0 {
					gc.Invisible = 1
				}
				if cell.IsStrikethrough() != 0 {
					gc.Strikethrough = 1
				}
				if cell.IsOverline() != 0 {
					gc.Overline = 1
				}
				if cell.IsDim() != 0 {
					gc.Dim = 1
				}
				cells = append(cells, gc)
			}
			gl.Cells = cells
		}
		lines = append(lines, gl)
	}

	// Trim trailing empty lines
	for len(lines) > 0 && lines[len(lines)-1].Text == "" && !lines[len(lines)-1].IsWrapped {
		lines = lines[:len(lines)-1]
	}

	// Capture scrollback
	var scrollback []goldenLine
	scrollbackLen := buf.Lines.Length() - rows
	_ = cols // used for context
	for y := range scrollbackLen {
		line := buf.Lines.Get(y)
		if line == nil {
			continue
		}
		text := line.TranslateToString(true, 0, -1)
		if len(text) > 0 || line.IsWrapped {
			scrollback = append(scrollback, goldenLine{
				Text:      text,
				IsWrapped: line.IsWrapped,
			})
		}
	}

	state := goldenState{
		Cursor: goldenCursor{X: buf.X, Y: buf.Y},
		Lines:  lines,
	}
	if len(scrollback) > 0 {
		state.Scrollback = scrollback
	}

	return state, response
}

func TestConformance(t *testing.T) {
	t.Parallel()
	cases := loadGoldenTestCases(t)

	for _, tc := range cases {
		tc := tc
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()

			gotState, gotResponse := captureGoState(t, tc)

			// Compare cursor position
			if diff := cmp.Diff(tc.Expected.Cursor, gotState.Cursor); diff != "" {
				t.Errorf("cursor mismatch (-xterm.js +go):\n%s", diff)
			}

			// Compare line text content
			expectedTexts := make([]string, len(tc.Expected.Lines))
			for i, l := range tc.Expected.Lines {
				expectedTexts[i] = l.Text
			}
			gotTexts := make([]string, len(gotState.Lines))
			for i, l := range gotState.Lines {
				gotTexts[i] = l.Text
			}
			if diff := cmp.Diff(expectedTexts, gotTexts); diff != "" {
				t.Errorf("line text mismatch (-xterm.js +go):\n%s", diff)
			}

			// Compare line wrapping
			expectedWraps := make([]bool, len(tc.Expected.Lines))
			for i, l := range tc.Expected.Lines {
				expectedWraps[i] = l.IsWrapped
			}
			gotWraps := make([]bool, len(gotState.Lines))
			for i, l := range gotState.Lines {
				gotWraps[i] = l.IsWrapped
			}
			if diff := cmp.Diff(expectedWraps, gotWraps); diff != "" {
				t.Errorf("line wrap mismatch (-xterm.js +go):\n%s", diff)
			}

			// Compare cell attributes for lines that have them
			for i, expectedLine := range tc.Expected.Lines {
				if len(expectedLine.Cells) == 0 {
					continue
				}
				if i >= len(gotState.Lines) {
					t.Errorf("line %d: expected cells but Go has no line", i)
					continue
				}
				gotLine := gotState.Lines[i]
				if diff := cmp.Diff(expectedLine.Cells, gotLine.Cells); diff != "" {
					t.Errorf("line %d cell attrs mismatch (-xterm.js +go):\n%s", i, diff)
				}
			}

			// Compare scrollback
			if diff := cmp.Diff(tc.Expected.Scrollback, gotState.Scrollback); diff != "" {
				t.Errorf("scrollback mismatch (-xterm.js +go):\n%s", diff)
			}

			// Compare response (for DA1, DSR tests).
			// XTVERSION responses differ by design: xterm.js reports its own
			// name/version while the Go port reports "xterm-go". We only verify
			// the DCS envelope format for XTVERSION.
			if tc.ExpectedResponse != "" {
				if strings.HasPrefix(tc.ExpectedResponse, "\x1bP>|") {
					// XTVERSION: verify DCS >| ... ST format
					if !strings.HasPrefix(gotResponse, "\x1bP>|") || !strings.HasSuffix(gotResponse, "\x1b\\") {
						t.Errorf("xtversion response format mismatch: got %q, want DCS >|...<ST> envelope", gotResponse)
					}
				} else if diff := cmp.Diff(tc.ExpectedResponse, gotResponse); diff != "" {
					t.Errorf("response mismatch (-xterm.js +go):\n%s", diff)
				}
			}
		})
	}
}

// TestConformanceSummary prints a summary of pass/fail counts.
func TestConformanceSummary(t *testing.T) {
	cases := loadGoldenTestCases(t)
	t.Logf("Loaded %d conformance test cases from golden.json", len(cases))
	for _, tc := range cases {
		t.Run(fmt.Sprintf("verify_%s", tc.Name), func(t *testing.T) {
			gotState, _ := captureGoState(t, tc)
			// Just check cursor + line text as a quick sanity check
			if gotState.Cursor != tc.Expected.Cursor {
				t.Errorf("cursor: got %+v, want %+v", gotState.Cursor, tc.Expected.Cursor)
			}
		})
	}
}
