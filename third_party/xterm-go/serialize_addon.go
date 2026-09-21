package xterm

// Ported from xterm.js addons/addon-serialize/src/SerializeAddon.ts.
// Serializes terminal buffer state as escape sequences that can be replayed
// to reconstruct the terminal content.

import (
	"fmt"
	"strings"
)

// SerializeRange specifies a row range for serialization.
type SerializeRange struct {
	Start int
	End   int
}

// SerializeOptions controls what gets serialized.
type SerializeOptions struct {
	// Scrollback limits how many scrollback lines to include.
	// If nil, all scrollback is included.
	Scrollback *int

	// Range serializes only the specified line range instead of the full buffer.
	Range *SerializeRange

	// ExcludeAltBuffer skips alternate buffer serialization.
	ExcludeAltBuffer bool

	// ExcludeModes skips mode and scroll region serialization.
	ExcludeModes bool
}

// SerializeAddon serializes terminal buffer state as escape sequences.
type SerializeAddon struct {
	terminal *Terminal
}

// NewSerializeAddon creates a new SerializeAddon attached to the given terminal.
func NewSerializeAddon(t *Terminal) *SerializeAddon {
	return &SerializeAddon{terminal: t}
}

// Serialize returns the terminal buffer content as escape sequences.
func (sa *SerializeAddon) Serialize(opts *SerializeOptions) []byte {
	if opts == nil {
		opts = &SerializeOptions{}
	}
	t := sa.terminal

	// Normal buffer
	var content string
	if opts.Range != nil {
		content = sa.serializeBufferByRange(t, t.NormalBuffer(), *opts.Range, true)
	} else {
		content = sa.serializeBufferByScrollback(t, t.NormalBuffer(), opts.Scrollback)
	}

	// Alternate buffer
	if !opts.ExcludeAltBuffer && t.IsAltBufferActive() {
		altContent := sa.serializeBufferByScrollback(t, t.AltBuffer(), nil)
		content += "\x1b[?1049h\x1b[H" + altContent
	}

	// Modes and scroll region
	if !opts.ExcludeModes {
		content += sa.serializeModes(t)
		content += sa.serializeScrollRegion(t)
	}

	return []byte(content)
}

func (sa *SerializeAddon) serializeBufferByScrollback(t *Terminal, buffer *Buffer, scrollback *int) string {
	maxRows := buffer.Lines.Length()
	correctRows := maxRows
	if scrollback != nil {
		correctRows = constrain(*scrollback+t.Rows(), 0, maxRows)
	}
	return sa.serializeBufferByRange(t, buffer, SerializeRange{
		Start: maxRows - correctRows,
		End:   maxRows - 1,
	}, false)
}

func (sa *SerializeAddon) serializeBufferByRange(t *Terminal, buffer *Buffer, r SerializeRange, excludeFinalCursorPosition bool) string {
	handler := newStringSerializeHandler(buffer, t)
	return handler.serialize(r.Start, r.End, excludeFinalCursorPosition)
}

func (sa *SerializeAddon) serializeScrollRegion(t *Terminal) string {
	scrollTop := t.ScrollTop()
	scrollBottom := t.ScrollBottom()
	if scrollTop != 0 || scrollBottom != t.Rows()-1 {
		return fmt.Sprintf("\x1b[%d;%dr", scrollTop+1, scrollBottom+1)
	}
	return ""
}

func (sa *SerializeAddon) serializeModes(t *Terminal) string {
	var content strings.Builder
	modes := t.DecPrivateModes()

	// Default: false
	if modes.ApplicationCursorKeys {
		content.WriteString("\x1b[?1h")
	}
	if modes.ApplicationKeypad {
		content.WriteString("\x1b[?66h")
	}
	if modes.BracketedPasteMode {
		content.WriteString("\x1b[?2004h")
	}
	if t.Modes().InsertMode {
		content.WriteString("\x1b[4h")
	}
	if modes.Origin {
		content.WriteString("\x1b[?6h")
	}
	if modes.ReverseWraparound {
		content.WriteString("\x1b[?45h")
	}
	if modes.SendFocus {
		content.WriteString("\x1b[?1004h")
	}

	// Default: true
	if !modes.Wraparound {
		content.WriteString("\x1b[?7l")
	}

	// Mouse tracking
	switch modes.MouseTrackingMode {
	case "X10":
		content.WriteString("\x1b[?9h")
	case "VT200":
		content.WriteString("\x1b[?1000h")
	case "DRAG":
		content.WriteString("\x1b[?1002h")
	case "ANY":
		content.WriteString("\x1b[?1003h")
	}

	// Cursor visibility (DECTCEM) - default: visible
	if t.IsCursorHidden() {
		content.WriteString("\x1b[?25l")
	}

	return content.String()
}

// constrain clamps v to [min, max].
func constrain(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// --- stringSerializeHandler ---

// stringSerializeHandler serializes buffer content as escape sequences.
// Ported from xterm.js StringSerializeHandler.
type stringSerializeHandler struct {
	buffer   *Buffer
	terminal *Terminal
	cols     int

	allRows          []string
	allRowSeparators []string
	currentRow       strings.Builder
	nullCellCount    int
	rowIndex         int

	// cursorStyle tracks the last style we emitted, so we can diff.
	cursorStyle *CellData

	// cursorStyleRow/Col: where the cursor style came from.
	cursorStyleRow int
	cursorStyleCol int

	// backgroundCell: a null cell for checking whether background is empty.
	backgroundCell *CellData

	// Reusable cells for rowEnd wrapped-line handling.
	thisRowLastChar       *CellData
	thisRowLastSecondChar *CellData
	nextRowFirstChar      *CellData

	firstRow int

	lastCursorRow int
	lastCursorCol int

	lastContentCursorRow int
	lastContentCursorCol int
}

func newStringSerializeHandler(buffer *Buffer, terminal *Terminal) *stringSerializeHandler {
	return &stringSerializeHandler{
		buffer:                buffer,
		terminal:              terminal,
		cols:                  terminal.Cols(),
		cursorStyle:           NewCellData(),
		backgroundCell:        NewCellData(),
		thisRowLastChar:       NewCellData(),
		thisRowLastSecondChar: NewCellData(),
		nextRowFirstChar:      NewCellData(),
	}
}

func (h *stringSerializeHandler) serialize(start, end int, excludeFinalCursorPosition bool) string {
	rows := end - start + 1
	if rows <= 0 {
		return ""
	}

	h.allRows = make([]string, rows)
	h.allRowSeparators = make([]string, rows)
	h.rowIndex = 0
	h.lastContentCursorRow = start
	h.lastCursorRow = start
	h.lastContentCursorCol = 0
	h.lastCursorCol = 0
	h.firstRow = start

	// We need two of them to flip between old and new cell.
	cell1 := NewCellData()
	cell2 := NewCellData()
	oldCell := cell1

	for row := start; row <= end; row++ {
		// Guard against concurrent resize shrinking the buffer.
		if row >= h.buffer.Lines.Length() {
			h.rowEnd(row, row == end)
			continue
		}
		line := h.buffer.Lines.Get(row)
		if line == nil {
			h.rowEnd(row, row == end)
			continue
		}

		// Use the line's actual length, not the cached cols, to avoid
		// index-out-of-range panics when a concurrent resize shrinks lines.
		lineCols := line.Len
		if lineCols > h.cols {
			lineCols = h.cols
		}
		for col := range lineCols {
			var c *CellData
			if oldCell == cell1 {
				c = cell2
			} else {
				c = cell1
			}
			line.LoadCell(col, c)
			h.nextCell(c, oldCell, row, col)
			oldCell = c
		}

		h.rowEnd(row, row == end)
	}

	return h.serializeString(excludeFinalCursorPosition)
}

func (h *stringSerializeHandler) rowEnd(row int, isLastRow bool) {
	// If there are colorful empty cells at line end, pad them back
	if h.nullCellCount > 0 && !equalBg(h.cursorStyle, h.backgroundCell) {
		h.currentRow.WriteString(fmt.Sprintf("\x1b[%dX", h.nullCellCount))
	}

	rowSeparator := ""

	if !isLastRow {
		// Enable BCE: update background cell if we're past the initial viewport
		if row-h.firstRow >= h.terminal.Rows() {
			if h.cursorStyleRow < h.buffer.Lines.Length() {
				bgLine := h.buffer.Lines.Get(h.cursorStyleRow)
				if bgLine != nil && h.cursorStyleCol < bgLine.Len {
					bgLine.LoadCell(h.cursorStyleCol, h.backgroundCell)
				}
			}
		}

		// Guard against concurrent resize shrinking the buffer.
		var currentLine, nextLine *BufferLine
		if row < h.buffer.Lines.Length() {
			currentLine = h.buffer.Lines.Get(row)
		}
		if row+1 < h.buffer.Lines.Length() {
			nextLine = h.buffer.Lines.Get(row + 1)
		}

		if currentLine == nil || nextLine == nil {
			rowSeparator = "\r\n"
			h.lastCursorRow = row + 1
			h.lastCursorCol = 0
		} else if !nextLine.IsWrapped {
			rowSeparator = "\r\n"
			h.lastCursorRow = row + 1
			h.lastCursorCol = 0
		} else {
			// Wrapped line handling
			rowSeparator = ""

			if currentLine.Len > 0 {
				currentLine.LoadCell(currentLine.Len-1, h.thisRowLastChar)
			}
			if currentLine.Len >= 2 {
				currentLine.LoadCell(currentLine.Len-2, h.thisRowLastSecondChar)
			}
			if nextLine.Len > 0 {
				nextLine.LoadCell(0, h.nextRowFirstChar)
			}

			isNextRowFirstCharDoubleWidth := h.nextRowFirstChar.GetWidth() > 1

			isValid := false
			if h.nextRowFirstChar.GetChars() != "" {
				maxNullCount := 0
				if isNextRowFirstCharDoubleWidth {
					maxNullCount = 1
				}
				if h.nullCellCount <= maxNullCount {
					if (h.thisRowLastChar.GetChars() != "" || h.thisRowLastChar.GetWidth() == 0) &&
						equalBg(h.thisRowLastChar, h.nextRowFirstChar) {
						isValid = true
					}
					if isNextRowFirstCharDoubleWidth &&
						(h.thisRowLastSecondChar.GetChars() != "" || h.thisRowLastSecondChar.GetWidth() == 0) &&
						equalBg(h.thisRowLastChar, h.nextRowFirstChar) &&
						equalBg(h.thisRowLastSecondChar, h.nextRowFirstChar) {
						isValid = true
					}
				}
			}

			if !isValid {
				// Force the wrap with magic
				rowSeparator = strings.Repeat("-", h.nullCellCount+1)
				rowSeparator += "\x1b[1D\x1b[1X"
				if h.nullCellCount > 0 {
					rowSeparator += "\x1b[A"
					rowSeparator += fmt.Sprintf("\x1b[%dC", currentLine.Len-h.nullCellCount)
					rowSeparator += fmt.Sprintf("\x1b[%dX", h.nullCellCount)
					rowSeparator += fmt.Sprintf("\x1b[%dD", currentLine.Len-h.nullCellCount)
					rowSeparator += "\x1b[B"
				}
				h.lastContentCursorRow = row + 1
				h.lastContentCursorCol = 0
				h.lastCursorRow = row + 1
				h.lastCursorCol = 0
			}
		}
	}

	h.allRows[h.rowIndex] = h.currentRow.String()
	h.allRowSeparators[h.rowIndex] = rowSeparator
	h.rowIndex++
	h.currentRow.Reset()
	h.nullCellCount = 0
}

func (h *stringSerializeHandler) diffStyle(cell, oldCell *CellData) []string {
	var sgrSeq []string

	if attributesEquals(cell, oldCell) {
		return sgrSeq
	}

	fgChanged := !equalFg(cell, oldCell)
	bgChanged := !equalBg(cell, oldCell)
	flagsChanged := !equalFlags(cell, oldCell)

	if cell.IsAttributeDefault() {
		if !oldCell.IsAttributeDefault() {
			sgrSeq = append(sgrSeq, "0")
		}
	} else {
		if fgChanged {
			color := cell.GetFgColor()
			if cell.IsFgRGB() {
				sgrSeq = append(sgrSeq,
					"38", "2",
					fmt.Sprintf("%d", (uint32(color)>>16)&0xFF),
					fmt.Sprintf("%d", (uint32(color)>>8)&0xFF),
					fmt.Sprintf("%d", uint32(color)&0xFF))
			} else if cell.IsFgPalette() {
				if color >= 16 {
					sgrSeq = append(sgrSeq, "38", "5", fmt.Sprintf("%d", color))
				} else {
					if color&8 != 0 {
						sgrSeq = append(sgrSeq, fmt.Sprintf("%d", 90+(color&7)))
					} else {
						sgrSeq = append(sgrSeq, fmt.Sprintf("%d", 30+(color&7)))
					}
				}
			} else {
				sgrSeq = append(sgrSeq, "39")
			}
		}

		if bgChanged {
			color := cell.GetBgColor()
			if cell.IsBgRGB() {
				sgrSeq = append(sgrSeq,
					"48", "2",
					fmt.Sprintf("%d", (uint32(color)>>16)&0xFF),
					fmt.Sprintf("%d", (uint32(color)>>8)&0xFF),
					fmt.Sprintf("%d", uint32(color)&0xFF))
			} else if cell.IsBgPalette() {
				if color >= 16 {
					sgrSeq = append(sgrSeq, "48", "5", fmt.Sprintf("%d", color))
				} else {
					if color&8 != 0 {
						sgrSeq = append(sgrSeq, fmt.Sprintf("%d", 100+(color&7)))
					} else {
						sgrSeq = append(sgrSeq, fmt.Sprintf("%d", 40+(color&7)))
					}
				}
			} else {
				sgrSeq = append(sgrSeq, "49")
			}
		}

		if flagsChanged {
			if cell.IsInverse() != oldCell.IsInverse() {
				if cell.IsInverse() != 0 {
					sgrSeq = append(sgrSeq, "7")
				} else {
					sgrSeq = append(sgrSeq, "27")
				}
			}
			if cell.IsBold() != oldCell.IsBold() {
				if cell.IsBold() != 0 {
					sgrSeq = append(sgrSeq, "1")
				} else {
					sgrSeq = append(sgrSeq, "22")
				}
			}
			if cell.IsUnderline() != oldCell.IsUnderline() {
				if cell.IsUnderline() != 0 {
					sgrSeq = append(sgrSeq, "4")
				} else {
					sgrSeq = append(sgrSeq, "24")
				}
			}
			if cell.IsOverline() != oldCell.IsOverline() {
				if cell.IsOverline() != 0 {
					sgrSeq = append(sgrSeq, "53")
				} else {
					sgrSeq = append(sgrSeq, "55")
				}
			}
			if cell.IsBlink() != oldCell.IsBlink() {
				if cell.IsBlink() != 0 {
					sgrSeq = append(sgrSeq, "5")
				} else {
					sgrSeq = append(sgrSeq, "25")
				}
			}
			if cell.IsInvisible() != oldCell.IsInvisible() {
				if cell.IsInvisible() != 0 {
					sgrSeq = append(sgrSeq, "8")
				} else {
					sgrSeq = append(sgrSeq, "28")
				}
			}
			if cell.IsItalic() != oldCell.IsItalic() {
				if cell.IsItalic() != 0 {
					sgrSeq = append(sgrSeq, "3")
				} else {
					sgrSeq = append(sgrSeq, "23")
				}
			}
			if cell.IsDim() != oldCell.IsDim() {
				if cell.IsDim() != 0 {
					sgrSeq = append(sgrSeq, "2")
				} else {
					sgrSeq = append(sgrSeq, "22")
				}
			}
			if cell.IsStrikethrough() != oldCell.IsStrikethrough() {
				if cell.IsStrikethrough() != 0 {
					sgrSeq = append(sgrSeq, "9")
				} else {
					sgrSeq = append(sgrSeq, "29")
				}
			}
		}
	}

	return sgrSeq
}

func (h *stringSerializeHandler) nextCell(cell, oldCell *CellData, row, col int) {
	// Width-0 cells are placeholders after CJK characters
	if cell.GetWidth() == 0 {
		return
	}

	isEmptyCell := cell.GetChars() == ""

	sgrSeq := h.diffStyle(cell, h.cursorStyle)

	// The empty cell style is only assumed to be changed when background changed,
	// because foreground is always 0.
	var styleChanged bool
	if isEmptyCell {
		styleChanged = !equalBg(h.cursorStyle, cell)
	} else {
		styleChanged = len(sgrSeq) > 0
	}

	if styleChanged {
		// Before updating style, fill empty cells back
		if h.nullCellCount > 0 {
			// Use clear right to set background.
			if !equalBg(h.cursorStyle, h.backgroundCell) {
				h.currentRow.WriteString(fmt.Sprintf("\x1b[%dX", h.nullCellCount))
			}
			// Use move right to move cursor.
			h.currentRow.WriteString(fmt.Sprintf("\x1b[%dC", h.nullCellCount))
			h.nullCellCount = 0
		}

		h.lastContentCursorRow = row
		h.lastContentCursorCol = col
		h.lastCursorRow = row
		h.lastCursorCol = col

		h.currentRow.WriteString(fmt.Sprintf("\x1b[%sm", strings.Join(sgrSeq, ";")))

		// Update the last cursor style.
		if row < h.buffer.Lines.Length() {
			line := h.buffer.Lines.Get(row)
			if line != nil && col < line.Len {
				line.LoadCell(col, h.cursorStyle)
				h.cursorStyleRow = row
				h.cursorStyleCol = col
			}
		}
	}

	if isEmptyCell {
		h.nullCellCount += cell.GetWidth()
	} else {
		if h.nullCellCount > 0 {
			// Use move right when background is empty, use clear right when there is background.
			if equalBg(h.cursorStyle, h.backgroundCell) {
				h.currentRow.WriteString(fmt.Sprintf("\x1b[%dC", h.nullCellCount))
			} else {
				h.currentRow.WriteString(fmt.Sprintf("\x1b[%dX", h.nullCellCount))
				h.currentRow.WriteString(fmt.Sprintf("\x1b[%dC", h.nullCellCount))
			}
			h.nullCellCount = 0
		}

		h.currentRow.WriteString(cell.GetChars())

		h.lastContentCursorRow = row
		h.lastContentCursorCol = col + cell.GetWidth()
		h.lastCursorRow = row
		h.lastCursorCol = col + cell.GetWidth()
	}
}

func (h *stringSerializeHandler) serializeString(excludeFinalCursorPosition bool) string {
	rowEnd := len(h.allRows)

	// Trim trailing empty rows when buffer fits in viewport
	if h.buffer.Lines.Length()-h.firstRow <= h.terminal.Rows() {
		rowEnd = h.lastContentCursorRow + 1 - h.firstRow
		if rowEnd < 0 {
			rowEnd = 0
		}
		if rowEnd > len(h.allRows) {
			rowEnd = len(h.allRows)
		}
		h.lastCursorCol = h.lastContentCursorCol
		h.lastCursorRow = h.lastContentCursorRow
	}

	var content strings.Builder
	for i := range rowEnd {
		content.WriteString(h.allRows[i])
		if i+1 < rowEnd {
			content.WriteString(h.allRowSeparators[i])
		}
	}

	// Restore cursor position
	if !excludeFinalCursorPosition {
		realCursorRow := h.buffer.YBase + h.buffer.Y
		realCursorCol := h.buffer.X

		cursorMoved := realCursorRow != h.lastCursorRow || realCursorCol != h.lastCursorCol

		if cursorMoved {
			rowOffset := realCursorRow - h.lastCursorRow
			if rowOffset > 0 {
				content.WriteString(fmt.Sprintf("\x1b[%dB", rowOffset))
			} else if rowOffset < 0 {
				content.WriteString(fmt.Sprintf("\x1b[%dA", -rowOffset))
			}

			colOffset := realCursorCol - h.lastCursorCol
			if colOffset > 0 {
				content.WriteString(fmt.Sprintf("\x1b[%dC", colOffset))
			} else if colOffset < 0 {
				content.WriteString(fmt.Sprintf("\x1b[%dD", -colOffset))
			}
		}
	}

	// Restore the cursor's current style, see https://github.com/xtermjs/xterm.js/issues/3677
	// HACK: Internal API access since it's awkward to expose this in the API and serialize will
	// likely be the only consumer
	curAttr := h.terminal.CurAttrData()
	curAttrCell := NewCellData()
	curAttrCell.Fg = curAttr.Fg
	curAttrCell.Bg = curAttr.Bg

	sgrSeq := h.diffStyle(curAttrCell, h.cursorStyle)
	if len(sgrSeq) > 0 {
		content.WriteString(fmt.Sprintf("\x1b[%sm", strings.Join(sgrSeq, ";")))
	}

	return content.String()
}

// --- Helper functions ---

// equalFg compares foreground color mode and color value (ignoring flags).
func equalFg(a, b *CellData) bool {
	return a.GetFgColorMode() == b.GetFgColorMode() &&
		a.GetFgColor() == b.GetFgColor()
}

// equalBg compares background color mode and color value (ignoring flags).
func equalBg(a, b *CellData) bool {
	return a.GetBgColorMode() == b.GetBgColorMode() &&
		a.GetBgColor() == b.GetBgColor()
}

// equalUnderline compares underline style and color between two cells.
func equalUnderline(a, b *CellData) bool {
	if a.IsUnderline() == 0 && b.IsUnderline() == 0 {
		return true
	}
	if a.GetUnderlineStyle() != b.GetUnderlineStyle() {
		return false
	}
	aDefault := a.IsUnderlineColorDefault()
	bDefault := b.IsUnderlineColorDefault()
	if aDefault && bDefault {
		return true
	}
	if aDefault != bDefault {
		return false
	}
	return a.GetUnderlineColor() == b.GetUnderlineColor() &&
		a.GetUnderlineColorMode() == b.GetUnderlineColorMode()
}

// equalFlags compares all attribute flags between two cells.
func equalFlags(a, b *CellData) bool {
	return a.IsInverse() == b.IsInverse() &&
		a.IsBold() == b.IsBold() &&
		a.IsUnderline() == b.IsUnderline() &&
		equalUnderline(a, b) &&
		a.IsOverline() == b.IsOverline() &&
		a.IsBlink() == b.IsBlink() &&
		a.IsInvisible() == b.IsInvisible() &&
		a.IsItalic() == b.IsItalic() &&
		a.IsDim() == b.IsDim() &&
		a.IsStrikethrough() == b.IsStrikethrough()
}

// attributesEquals is the fast-path check that compares all attributes.
func attributesEquals(a, b *CellData) bool {
	return equalFg(a, b) && equalBg(a, b) && equalFlags(a, b)
}
