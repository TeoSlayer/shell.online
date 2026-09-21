package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestContentBitmasks(t *testing.T) {
	type Expectation struct {
		Value uint32
	}
	type TestCase struct {
		Name     string
		Got      uint32
		Expected Expectation
	}
	tests := []TestCase{
		{"CODEPOINT_MASK", ContentCodepointMask, Expectation{0x1FFFFF}},
		{"IS_COMBINED_MASK", ContentIsCombinedMask, Expectation{1 << 21}},
		{"HAS_CONTENT_MASK", ContentHasContentMask, Expectation{0x3FFFFF}},
		{"WIDTH_MASK", ContentWidthMask, Expectation{3 << 22}},
		{"WIDTH_SHIFT", ContentWidthShift, Expectation{22}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			got := Expectation{tc.Got}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestAttributeBitmasks(t *testing.T) {
	type Expectation struct {
		Value uint32
	}
	type TestCase struct {
		Name     string
		Got      uint32
		Expected Expectation
	}
	tests := []TestCase{
		{"BLUE_MASK", AttrBlueMask, Expectation{0xFF}},
		{"GREEN_MASK", AttrGreenMask, Expectation{0xFF00}},
		{"RED_MASK", AttrRedMask, Expectation{0xFF0000}},
		{"CM_MASK", AttrCMMask, Expectation{0x3000000}},
		{"CM_DEFAULT", AttrCMDefault, Expectation{0}},
		{"CM_P16", AttrCMP16, Expectation{0x1000000}},
		{"CM_P256", AttrCMP256, Expectation{0x2000000}},
		{"CM_RGB", AttrCMRGB, Expectation{0x3000000}},
		{"RGB_MASK", AttrRGBMask, Expectation{0xFFFFFF}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			got := Expectation{tc.Got}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestFgBgFlags(t *testing.T) {
	type Expectation struct {
		Value uint32
	}
	type TestCase struct {
		Name     string
		Got      uint32
		Expected Expectation
	}
	tests := []TestCase{
		{"FG_INVERSE", FgFlagInverse, Expectation{0x4000000}},
		{"FG_BOLD", FgFlagBold, Expectation{0x8000000}},
		{"FG_UNDERLINE", FgFlagUnderline, Expectation{0x10000000}},
		{"FG_BLINK", FgFlagBlink, Expectation{0x20000000}},
		{"FG_INVISIBLE", FgFlagInvisible, Expectation{0x40000000}},
		{"FG_STRIKETHROUGH", FgFlagStrikethrough, Expectation{0x80000000}},
		{"BG_ITALIC", BgFlagItalic, Expectation{0x4000000}},
		{"BG_DIM", BgFlagDim, Expectation{0x8000000}},
		{"BG_HAS_EXTENDED", BgFlagHasExtended, Expectation{0x10000000}},
		{"BG_PROTECTED", BgFlagProtected, Expectation{0x20000000}},
		{"BG_OVERLINE", BgFlagOverline, Expectation{0x40000000}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			got := Expectation{tc.Got}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestParserEnums(t *testing.T) {
	type Expectation struct {
		State  ParserState
		Action ParserAction
	}
	type TestCase struct {
		Name     string
		Expected Expectation
	}
	tests := []TestCase{
		{"ground/ignore", Expectation{State: 0, Action: 0}},
		{"apc_passthrough/apc_end", Expectation{State: 16, Action: 17}},
		{"state_length/print", Expectation{State: 17, Action: 2}},
	}
	states := []ParserState{ParserStateGround, ParserStateAPCPassthrough, ParserStateLength}
	actions := []ParserAction{ParserActionIgnore, ParserActionAPCEnd, ParserActionPrint}
	for i, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			got := Expectation{State: states[i], Action: actions[i]}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestContentBitLayout(t *testing.T) {
	type Expectation struct {
		Codepoint  uint32
		Width      uint32
		IsCombined bool
		HasContent bool
	}
	type TestCase struct {
		Name     string
		Content  uint32
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:    "ASCII A width 1",
			Content: uint32('A') | (1 << ContentWidthShift),
			Expected: Expectation{
				Codepoint: uint32('A'), Width: 1,
				IsCombined: false, HasContent: true,
			},
		},
		{
			Name:    "combined width 2",
			Content: ContentIsCombinedMask | (2 << ContentWidthShift),
			Expected: Expectation{
				Codepoint: 0, Width: 2,
				IsCombined: true, HasContent: true,
			},
		},
		{
			Name:    "null cell",
			Content: 0,
			Expected: Expectation{
				Codepoint: 0, Width: 0,
				IsCombined: false, HasContent: false,
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			got := Expectation{
				Codepoint:  tc.Content & ContentCodepointMask,
				Width:      tc.Content >> ContentWidthShift,
				IsCombined: tc.Content&ContentIsCombinedMask != 0,
				HasContent: tc.Content&ContentHasContentMask != 0,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestFgBitLayout(t *testing.T) {
	type Expectation struct {
		Red       uint8
		Green     uint8
		Blue      uint8
		ColorMode uint32
		IsBold    bool
		IsInverse bool
	}

	fg := uint32(0xAB)<<AttrRedShift | uint32(0xCD)<<AttrGreenShift | uint32(0xEF) | AttrCMRGB | FgFlagBold

	got := Expectation{
		Red:       uint8((fg & AttrRedMask) >> AttrRedShift),
		Green:     uint8((fg & AttrGreenMask) >> AttrGreenShift),
		Blue:      uint8(fg & AttrBlueMask),
		ColorMode: fg & AttrCMMask,
		IsBold:    fg&FgFlagBold != 0,
		IsInverse: fg&FgFlagInverse != 0,
	}
	expected := Expectation{
		Red: 0xAB, Green: 0xCD, Blue: 0xEF,
		ColorMode: AttrCMRGB, IsBold: true, IsInverse: false,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
