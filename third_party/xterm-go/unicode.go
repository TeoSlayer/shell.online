package xterm

// Ported from xterm.js src/common/services/UnicodeService.ts and src/common/input/UnicodeV6.ts.

import "unicode/utf8"

// bmpCombining is the list of BMP combining character ranges (Unicode 6.0).
var bmpCombining = [][2]int{
	{0x0300, 0x036F}, {0x0483, 0x0486}, {0x0488, 0x0489},
	{0x0591, 0x05BD}, {0x05BF, 0x05BF}, {0x05C1, 0x05C2},
	{0x05C4, 0x05C5}, {0x05C7, 0x05C7}, {0x0600, 0x0603},
	{0x0610, 0x0615}, {0x064B, 0x065E}, {0x0670, 0x0670},
	{0x06D6, 0x06E4}, {0x06E7, 0x06E8}, {0x06EA, 0x06ED},
	{0x070F, 0x070F}, {0x0711, 0x0711}, {0x0730, 0x074A},
	{0x07A6, 0x07B0}, {0x07EB, 0x07F3}, {0x0901, 0x0902},
	{0x093C, 0x093C}, {0x0941, 0x0948}, {0x094D, 0x094D},
	{0x0951, 0x0954}, {0x0962, 0x0963}, {0x0981, 0x0981},
	{0x09BC, 0x09BC}, {0x09C1, 0x09C4}, {0x09CD, 0x09CD},
	{0x09E2, 0x09E3}, {0x0A01, 0x0A02}, {0x0A3C, 0x0A3C},
	{0x0A41, 0x0A42}, {0x0A47, 0x0A48}, {0x0A4B, 0x0A4D},
	{0x0A70, 0x0A71}, {0x0A81, 0x0A82}, {0x0ABC, 0x0ABC},
	{0x0AC1, 0x0AC5}, {0x0AC7, 0x0AC8}, {0x0ACD, 0x0ACD},
	{0x0AE2, 0x0AE3}, {0x0B01, 0x0B01}, {0x0B3C, 0x0B3C},
	{0x0B3F, 0x0B3F}, {0x0B41, 0x0B43}, {0x0B4D, 0x0B4D},
	{0x0B56, 0x0B56}, {0x0B82, 0x0B82}, {0x0BC0, 0x0BC0},
	{0x0BCD, 0x0BCD}, {0x0C3E, 0x0C40}, {0x0C46, 0x0C48},
	{0x0C4A, 0x0C4D}, {0x0C55, 0x0C56}, {0x0CBC, 0x0CBC},
	{0x0CBF, 0x0CBF}, {0x0CC6, 0x0CC6}, {0x0CCC, 0x0CCD},
	{0x0CE2, 0x0CE3}, {0x0D41, 0x0D43}, {0x0D4D, 0x0D4D},
	{0x0DCA, 0x0DCA}, {0x0DD2, 0x0DD4}, {0x0DD6, 0x0DD6},
	{0x0E31, 0x0E31}, {0x0E34, 0x0E3A}, {0x0E47, 0x0E4E},
	{0x0EB1, 0x0EB1}, {0x0EB4, 0x0EB9}, {0x0EBB, 0x0EBC},
	{0x0EC8, 0x0ECD}, {0x0F18, 0x0F19}, {0x0F35, 0x0F35},
	{0x0F37, 0x0F37}, {0x0F39, 0x0F39}, {0x0F71, 0x0F7E},
	{0x0F80, 0x0F84}, {0x0F86, 0x0F87}, {0x0F90, 0x0F97},
	{0x0F99, 0x0FBC}, {0x0FC6, 0x0FC6}, {0x102D, 0x1030},
	{0x1032, 0x1032}, {0x1036, 0x1037}, {0x1039, 0x1039},
	{0x1058, 0x1059}, {0x1160, 0x11FF}, {0x135F, 0x135F},
	{0x1712, 0x1714}, {0x1732, 0x1734}, {0x1752, 0x1753},
	{0x1772, 0x1773}, {0x17B4, 0x17B5}, {0x17B7, 0x17BD},
	{0x17C6, 0x17C6}, {0x17C9, 0x17D3}, {0x17DD, 0x17DD},
	{0x180B, 0x180D}, {0x18A9, 0x18A9}, {0x1920, 0x1922},
	{0x1927, 0x1928}, {0x1932, 0x1932}, {0x1939, 0x193B},
	{0x1A17, 0x1A18}, {0x1B00, 0x1B03}, {0x1B34, 0x1B34},
	{0x1B36, 0x1B3A}, {0x1B3C, 0x1B3C}, {0x1B42, 0x1B42},
	{0x1B6B, 0x1B73}, {0x1DC0, 0x1DCA}, {0x1DFE, 0x1DFF},
	{0x200B, 0x200F}, {0x202A, 0x202E}, {0x2060, 0x2063},
	{0x206A, 0x206F}, {0x20D0, 0x20EF}, {0x302A, 0x302F},
	{0x3099, 0x309A}, {0xA806, 0xA806}, {0xA80B, 0xA80B},
	{0xA825, 0xA826}, {0xFB1E, 0xFB1E}, {0xFE00, 0xFE0F},
	{0xFE20, 0xFE23}, {0xFEFF, 0xFEFF}, {0xFFF9, 0xFFFB},
}

// highCombining is the list of combining character ranges above the BMP.
var highCombining = [][2]int{
	{0x10A01, 0x10A03}, {0x10A05, 0x10A06}, {0x10A0C, 0x10A0F},
	{0x10A38, 0x10A3A}, {0x10A3F, 0x10A3F}, {0x1D167, 0x1D169},
	{0x1D173, 0x1D182}, {0x1D185, 0x1D18B}, {0x1D1AA, 0x1D1AD},
	{0x1D242, 0x1D244}, {0xE0001, 0xE0001}, {0xE0020, 0xE007F},
	{0xE0100, 0xE01EF},
}

// bmpWidthTable is a lookup table for BMP character widths (0-65535).
// Initialized once on first use.
var bmpWidthTable [65536]byte

func init() {
	// Default: width 1
	for i := range bmpWidthTable {
		bmpWidthTable[i] = 1
	}

	// Control chars: width 0
	bmpWidthTable[0] = 0
	for i := 1; i < 32; i++ {
		bmpWidthTable[i] = 0
	}
	for i := 0x7f; i < 0xa0; i++ {
		bmpWidthTable[i] = 0
	}

	// Wide chars: width 2
	for i := 0x1100; i < 0x1160; i++ {
		bmpWidthTable[i] = 2
	}
	bmpWidthTable[0x2329] = 2
	bmpWidthTable[0x232a] = 2
	for i := 0x2e80; i < 0xa4d0; i++ {
		bmpWidthTable[i] = 2
	}
	bmpWidthTable[0x303f] = 1 // exception
	for i := 0xac00; i < 0xd7a4; i++ {
		bmpWidthTable[i] = 2
	}
	for i := 0xf900; i < 0xfb00; i++ {
		bmpWidthTable[i] = 2
	}
	for i := 0xfe10; i < 0xfe1a; i++ {
		bmpWidthTable[i] = 2
	}
	for i := 0xfe30; i < 0xfe70; i++ {
		bmpWidthTable[i] = 2
	}
	for i := 0xff00; i < 0xff61; i++ {
		bmpWidthTable[i] = 2
	}
	for i := 0xffe0; i < 0xffe7; i++ {
		bmpWidthTable[i] = 2
	}

	// Combining marks override to width 0 (applied last to override wide ranges)
	for _, r := range bmpCombining {
		for i := r[0]; i <= r[1]; i++ {
			bmpWidthTable[i] = 0
		}
	}
}

// bisearch performs binary search on sorted ranges.
func bisearch(ucs int, data [][2]int) bool {
	lo, hi := 0, len(data)-1
	if ucs < data[0][0] || ucs > data[hi][1] {
		return false
	}
	for lo <= hi {
		mid := (lo + hi) >> 1
		if ucs > data[mid][1] {
			lo = mid + 1
		} else if ucs < data[mid][0] {
			hi = mid - 1
		} else {
			return true
		}
	}
	return false
}

// UnicodeService provides character width calculation for terminal rendering.
type UnicodeService struct{}

// NewUnicodeService creates a UnicodeService.
func NewUnicodeService() *UnicodeService {
	return &UnicodeService{}
}

// Wcwidth returns the display width of a codepoint.
// Control chars and combining marks return 0, East Asian wide chars return 2, others return 1.
func (u *UnicodeService) Wcwidth(cp rune) int {
	num := int(cp)
	if num < 32 {
		return 0
	}
	if num < 127 {
		return 1
	}
	if num < 65536 {
		return int(bmpWidthTable[num])
	}
	if bisearch(num, highCombining) {
		return 0
	}
	if (num >= 0x20000 && num <= 0x2fffd) || (num >= 0x30000 && num <= 0x3fffd) {
		return 2
	}
	return 1
}

// UnicodeCharProperties bit layout (mirrors xterm.js UnicodeService):
//   bit 0:     shouldJoin
//   bits 1-2:  width (0-2)
//   bits 3+:   charKind (unused in V6, always 0)

// ExtractShouldJoin returns the shouldJoin flag from a UnicodeCharProperties value.
func ExtractShouldJoin(value int) bool {
	return (value & 1) != 0
}

// ExtractCharPropsWidth returns the character width from a UnicodeCharProperties value.
func ExtractCharPropsWidth(value int) int {
	return (value >> 1) & 0x3
}

// CreatePropertyValue packs width and shouldJoin into a UnicodeCharProperties value.
func CreatePropertyValue(charKind, width int, shouldJoin bool) int {
	sj := 0
	if shouldJoin {
		sj = 1
	}
	return ((charKind & 0xffffff) << 3) | ((width & 3) << 1) | sj
}

// CharProperties determines character properties for terminal rendering,
// including whether a character should join with the preceding cell.
// Mirrors xterm.js UnicodeV6.charProperties().
func (u *UnicodeService) CharProperties(codepoint rune, preceding int) int {
	w := u.Wcwidth(codepoint)
	if w == 0 && preceding != 0 {
		oldWidth := ExtractCharPropsWidth(preceding)
		if oldWidth > 0 {
			return CreatePropertyValue(0, oldWidth, true)
		}
	}
	return CreatePropertyValue(0, w, false)
}

// GetStringCellWidth returns the total display width of a string.
func (u *UnicodeService) GetStringCellWidth(s string) int {
	result := 0
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size <= 1 {
			// Invalid UTF-8 byte, treat as width 1
			result++
			i++
			continue
		}
		result += u.Wcwidth(r)
		i += size
	}
	return result
}
