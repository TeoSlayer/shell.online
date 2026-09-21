package xterm

// Ported from xterm.js src/common/buffer/CellData.ts.

import "unicode/utf8"

// CellData represents a single cell in the terminal buffer.
// It embeds AttributeData for fg/bg/extended and adds content + combined data.
type CellData struct {
	AttributeData
	Content      uint32
	CombinedData string
}

// NewCellData creates a zero-valued CellData with initialized extended attrs.
func NewCellData() *CellData {
	return &CellData{
		AttributeData: DefaultAttrData(),
	}
}

// CellDataFromCharData creates a CellData from a legacy CharData tuple.
func CellDataFromCharData(cd CharData) *CellData {
	c := NewCellData()
	c.SetFromCharData(cd)
	return c
}

// IsCombined returns non-zero if the cell contains combined/multi-codepoint content.
func (c *CellData) IsCombined() uint32 {
	return c.Content & ContentIsCombinedMask
}

// GetWidth returns the display width of the cell (0, 1, or 2).
func (c *CellData) GetWidth() int {
	return int(c.Content >> ContentWidthShift)
}

// GetChars returns the string representation of the cell content.
func (c *CellData) GetChars() string {
	if c.Content&ContentIsCombinedMask != 0 {
		return c.CombinedData
	}
	cp := c.Content & ContentCodepointMask
	if cp != 0 {
		return string(rune(cp))
	}
	return ""
}

// GetCode returns the codepoint of the cell. For combined strings, returns
// the codepoint of the last character (matching xterm.js behavior).
func (c *CellData) GetCode() uint32 {
	if c.IsCombined() != 0 {
		if len(c.CombinedData) == 0 {
			return 0
		}
		// Get the last rune
		var lastRune rune
		for i := 0; i < len(c.CombinedData); {
			r, size := utf8.DecodeRuneInString(c.CombinedData[i:])
			lastRune = r
			i += size
		}
		return uint32(lastRune)
	}
	return c.Content & ContentCodepointMask
}

// SetFromCharData populates the cell from a legacy CharData tuple.
func (c *CellData) SetFromCharData(cd CharData) {
	c.Fg = CharDataAttr(cd)
	c.Bg = 0
	ch := CharDataChar(cd)
	width := CharDataWidth(cd)

	combined := false
	runes := []rune(ch)

	if len(runes) > 2 {
		combined = true
	} else if len(runes) == 2 {
		// Check for surrogate pair (already decoded in Go, so this is a 2-rune string).
		// In Go, strings are UTF-8 and runes are already full codepoints.
		// A 2-rune string is always "combined" in Go since surrogates don't exist.
		combined = true
	} else if len(runes) == 1 {
		c.Content = uint32(runes[0]) | (uint32(width) << ContentWidthShift)
	} else {
		// empty string
		c.Content = uint32(width) << ContentWidthShift
	}

	if combined {
		c.CombinedData = ch
		c.Content = ContentIsCombinedMask | (uint32(width) << ContentWidthShift)
	}
}

// AttributesEqual returns true if this cell has the same visual attributes as other.
// Compares fg/bg color and mode, all text decoration flags, and underline style/color.
func (c *CellData) AttributesEqual(other *CellData) bool {
	if c.GetFgColorMode() != other.GetFgColorMode() || c.GetFgColor() != other.GetFgColor() {
		return false
	}
	if c.GetBgColorMode() != other.GetBgColorMode() || c.GetBgColor() != other.GetBgColor() {
		return false
	}
	if c.IsInverse() != other.IsInverse() {
		return false
	}
	if c.IsBold() != other.IsBold() {
		return false
	}
	if c.IsUnderline() != other.IsUnderline() {
		return false
	}
	if c.IsOverline() != other.IsOverline() {
		return false
	}
	if c.IsBlink() != other.IsBlink() {
		return false
	}
	if c.IsInvisible() != other.IsInvisible() {
		return false
	}
	if c.IsItalic() != other.IsItalic() {
		return false
	}
	if c.IsDim() != other.IsDim() {
		return false
	}
	if c.IsStrikethrough() != other.IsStrikethrough() {
		return false
	}
	if c.GetUnderlineStyle() != other.GetUnderlineStyle() {
		return false
	}
	if c.GetUnderlineColor() != other.GetUnderlineColor() {
		return false
	}
	return true
}

// GetAsCharData returns the cell as a legacy CharData tuple.
func (c *CellData) GetAsCharData() CharData {
	return NewCharData(c.Fg, c.GetChars(), c.GetWidth(), c.GetCode())
}
