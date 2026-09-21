package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestAttributeDataFgFlags(t *testing.T) {
	type Expectation struct {
		Before uint32
		After  uint32
	}
	type TestCase struct {
		Name     string
		Flag     uint32
		Query    func(*AttributeData) uint32
		Expected Expectation
	}
	tests := []TestCase{
		{"Inverse", FgFlagInverse, (*AttributeData).IsInverse, Expectation{0, FgFlagInverse}},
		{"Bold", FgFlagBold, (*AttributeData).IsBold, Expectation{0, FgFlagBold}},
		{"Blink", FgFlagBlink, (*AttributeData).IsBlink, Expectation{0, FgFlagBlink}},
		{"Invisible", FgFlagInvisible, (*AttributeData).IsInvisible, Expectation{0, FgFlagInvisible}},
		{"Strikethrough", FgFlagStrikethrough, (*AttributeData).IsStrikethrough, Expectation{0, FgFlagStrikethrough}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			a := DefaultAttrData()
			before := tc.Query(&a)
			a.Fg |= tc.Flag
			after := tc.Query(&a)
			got := Expectation{Before: before, After: after}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestAttributeDataBgFlags(t *testing.T) {
	type Expectation struct {
		Before uint32
		After  uint32
	}
	type TestCase struct {
		Name     string
		Flag     uint32
		Query    func(*AttributeData) uint32
		Expected Expectation
	}
	tests := []TestCase{
		{"Italic", BgFlagItalic, (*AttributeData).IsItalic, Expectation{0, BgFlagItalic}},
		{"Dim", BgFlagDim, (*AttributeData).IsDim, Expectation{0, BgFlagDim}},
		{"Protected", BgFlagProtected, (*AttributeData).IsProtected, Expectation{0, BgFlagProtected}},
		{"Overline", BgFlagOverline, (*AttributeData).IsOverline, Expectation{0, BgFlagOverline}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			a := DefaultAttrData()
			before := tc.Query(&a)
			a.Bg |= tc.Flag
			after := tc.Query(&a)
			got := Expectation{Before: before, After: after}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestAttributeDataFgColorModes(t *testing.T) {
	type Expectation struct {
		ColorMode uint32
		Color     int
		IsRGB     bool
		IsPalette bool
		IsDefault bool
	}
	type TestCase struct {
		Name     string
		Fg       uint32
		Expected Expectation
	}
	tests := []TestCase{
		{"default", 0, Expectation{AttrCMDefault, -1, false, false, true}},
		{"P16", AttrCMP16 | 7, Expectation{AttrCMP16, 7, false, true, false}},
		{"P256", AttrCMP256 | 42, Expectation{AttrCMP256, 42, false, true, false}},
		{"RGB", AttrCMRGB | 0xABCDEF, Expectation{AttrCMRGB, 0xABCDEF, true, false, false}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			a := DefaultAttrData()
			a.Fg = tc.Fg
			got := Expectation{
				ColorMode: a.GetFgColorMode(),
				Color:     a.GetFgColor(),
				IsRGB:     a.IsFgRGB(),
				IsPalette: a.IsFgPalette(),
				IsDefault: a.IsFgDefault(),
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestAttributeDataBgColorModes(t *testing.T) {
	type Expectation struct {
		ColorMode uint32
		Color     int
		IsRGB     bool
		IsPalette bool
		IsDefault bool
	}
	type TestCase struct {
		Name     string
		Bg       uint32
		Expected Expectation
	}
	tests := []TestCase{
		{"default", 0, Expectation{AttrCMDefault, -1, false, false, true}},
		{"P16", AttrCMP16 | 7, Expectation{AttrCMP16, 7, false, true, false}},
		{"P256", AttrCMP256 | 200, Expectation{AttrCMP256, 200, false, true, false}},
		{"RGB", AttrCMRGB | 0xABCDEF, Expectation{AttrCMRGB, 0xABCDEF, true, false, false}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			a := DefaultAttrData()
			a.Bg = tc.Bg
			got := Expectation{
				ColorMode: a.GetBgColorMode(),
				Color:     a.GetBgColor(),
				IsRGB:     a.IsBgRGB(),
				IsPalette: a.IsBgPalette(),
				IsDefault: a.IsBgDefault(),
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestAttributeDataIsAttributeDefault(t *testing.T) {
	type Expectation struct {
		IsDefault bool
	}
	type TestCase struct {
		Name     string
		Fg       uint32
		Bg       uint32
		Expected Expectation
	}
	tests := []TestCase{
		{"zero fg/bg", 0, 0, Expectation{true}},
		{"bold fg", FgFlagBold, 0, Expectation{false}},
		{"italic bg", 0, BgFlagItalic, Expectation{false}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			a := DefaultAttrData()
			a.Fg = tc.Fg
			a.Bg = tc.Bg
			got := Expectation{IsDefault: a.IsAttributeDefault()}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestAttributeDataClone(t *testing.T) {
	type Expectation struct {
		Fg             uint32
		Bg             uint32
		UnderlineStyle UnderlineStyle
		Isolated       bool
	}

	a := DefaultAttrData()
	a.Fg = AttrCMRGB | 0x112233 | FgFlagBold
	a.Bg = BgFlagItalic | BgFlagHasExtended
	a.Extended.SetUnderlineStyle(UnderlineStyleCurly)

	b := a.Clone()
	b.Fg = 0
	b.Extended.SetUnderlineStyle(UnderlineStyleNone)

	got := Expectation{
		Fg:             a.Fg,
		Bg:             a.Bg,
		UnderlineStyle: a.Extended.UnderlineStyle(),
		Isolated:       b.Fg == 0 && b.Extended.UnderlineStyle() == UnderlineStyleNone,
	}
	expected := Expectation{
		Fg:             AttrCMRGB | 0x112233 | FgFlagBold,
		Bg:             BgFlagItalic | BgFlagHasExtended,
		UnderlineStyle: UnderlineStyleCurly,
		Isolated:       true,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestColorRGBRoundTrip(t *testing.T) {
	type Expectation struct {
		RGB ColorRGB
	}
	type TestCase struct {
		Name     string
		Input    ColorRGB
		Expected Expectation
	}
	tests := []TestCase{
		{"black", ColorRGB{0, 0, 0}, Expectation{ColorRGB{0, 0, 0}}},
		{"white", ColorRGB{255, 255, 255}, Expectation{ColorRGB{255, 255, 255}}},
		{"arbitrary", ColorRGB{0xAB, 0xCD, 0xEF}, Expectation{ColorRGB{0xAB, 0xCD, 0xEF}}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			got := Expectation{RGB: ToColorRGB(FromColorRGB(tc.Input))}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestExtendedAttrsExtGetSet(t *testing.T) {
	type Expectation struct {
		ExtWithoutURL uint32
		ExtWithURL    uint32
	}

	e := NewExtendedAttrs(0, 0)
	e.SetExt(0x12345678)
	withoutURL := e.Ext()

	e.SetURLID(1)
	withURL := e.Ext()

	got := Expectation{ExtWithoutURL: withoutURL, ExtWithURL: withURL}
	wantStyleBits := uint32(UnderlineStyleDashed) << 26
	expected := Expectation{
		ExtWithoutURL: 0x12345678,
		ExtWithURL:    (0x12345678 & ^ExtFlagUnderlineStyle) | wantStyleBits,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestExtendedAttrsUnderlineStyle(t *testing.T) {
	type Expectation struct {
		Style UnderlineStyle
	}
	type TestCase struct {
		Name     string
		Style    UnderlineStyle
		URLID    int
		Expected Expectation
	}
	tests := []TestCase{
		{"default", UnderlineStyleNone, 0, Expectation{UnderlineStyleNone}},
		{"curly", UnderlineStyleCurly, 0, Expectation{UnderlineStyleCurly}},
		{"url overrides to dashed", UnderlineStyleCurly, 1, Expectation{UnderlineStyleDashed}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			e := NewExtendedAttrs(0, 0)
			e.SetUnderlineStyle(tc.Style)
			e.SetURLID(tc.URLID)
			got := Expectation{Style: e.UnderlineStyle()}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestExtendedAttrsUnderlineColor(t *testing.T) {
	type Expectation struct {
		Color uint32
	}

	e := NewExtendedAttrs(0, 0)
	e.SetUnderlineColor(AttrCMRGB | 0xFF0000)
	got := Expectation{Color: e.UnderlineColor()}
	expected := Expectation{Color: AttrCMRGB | 0xFF0000}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestExtendedAttrsUnderlineVariantOffset(t *testing.T) {
	type Expectation struct {
		Offset int
	}
	type TestCase struct {
		Name     string
		Value    int
		Expected Expectation
	}
	tests := []TestCase{
		{"zero", 0, Expectation{0}},
		{"three", 3, Expectation{3}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			e := NewExtendedAttrs(0, 0)
			e.SetUnderlineVariantOffset(tc.Value)
			got := Expectation{Offset: e.UnderlineVariantOffset()}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestExtendedAttrsIsEmpty(t *testing.T) {
	type Expectation struct {
		IsEmpty bool
	}
	type TestCase struct {
		Name     string
		Style    UnderlineStyle
		URLID    int
		Payload  any
		Expected Expectation
	}
	tests := []TestCase{
		{"default", UnderlineStyleNone, 0, nil, Expectation{true}},
		{"with style", UnderlineStyleSingle, 0, nil, Expectation{false}},
		{"with url", UnderlineStyleNone, 1, nil, Expectation{false}},
		{"with payload", UnderlineStyleNone, 0, struct{}{}, Expectation{false}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			e := NewExtendedAttrs(0, 0)
			e.SetUnderlineStyle(tc.Style)
			e.SetURLID(tc.URLID)
			e.Payload = tc.Payload
			got := Expectation{IsEmpty: e.IsEmpty()}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestExtendedAttrsClone(t *testing.T) {
	type Expectation struct {
		OrigStyle  UnderlineStyle
		CloneStyle UnderlineStyle
		CloneURLID int
	}

	payload := &struct{ ID int }{ID: 42}
	e := NewExtendedAttrs(0, 0)
	e.SetUnderlineStyle(UnderlineStyleDouble)
	e.SetURLID(5)
	e.Payload = payload
	c := e.Clone()
	c.SetURLID(0)
	c.SetUnderlineStyle(UnderlineStyleNone)
	e.SetURLID(0) // clear URL to read stored style

	got := Expectation{
		OrigStyle:  e.UnderlineStyle(),
		CloneStyle: c.UnderlineStyle(),
		CloneURLID: c.URLID(),
	}
	expected := Expectation{
		OrigStyle:  UnderlineStyleDouble,
		CloneStyle: UnderlineStyleNone,
		CloneURLID: 0,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
	if c.Payload != payload {
		t.Errorf("clone payload = %v, want original payload %v", c.Payload, payload)
	}
}

func TestAttributeDataUnderline(t *testing.T) {
	type Expectation struct {
		IsUnderline    uint32
		UnderlineStyle UnderlineStyle
	}
	type TestCase struct {
		Name     string
		Fg       uint32
		Bg       uint32
		ExtStyle UnderlineStyle
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name: "no underline",
			Expected: Expectation{
				IsUnderline: 0, UnderlineStyle: UnderlineStyleNone,
			},
		},
		{
			Name: "fg flag only",
			Fg:   FgFlagUnderline,
			Expected: Expectation{
				IsUnderline: FgFlagUnderline, UnderlineStyle: UnderlineStyleSingle,
			},
		},
		{
			Name:     "fg flag with extended curly",
			Fg:       FgFlagUnderline,
			Bg:       BgFlagHasExtended,
			ExtStyle: UnderlineStyleCurly,
			Expected: Expectation{
				IsUnderline: 1, UnderlineStyle: UnderlineStyleCurly,
			},
		},
		{
			Name:     "extended style without fg flag",
			Bg:       BgFlagHasExtended,
			ExtStyle: UnderlineStyleDouble,
			Expected: Expectation{
				IsUnderline: 1, UnderlineStyle: UnderlineStyleNone,
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			a := DefaultAttrData()
			a.Fg = tc.Fg
			a.Bg = tc.Bg
			if tc.ExtStyle != UnderlineStyleNone {
				a.Extended.SetUnderlineStyle(tc.ExtStyle)
			}
			got := Expectation{
				IsUnderline:    a.IsUnderline(),
				UnderlineStyle: a.GetUnderlineStyle(),
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestAttributeDataUpdateExtended(t *testing.T) {
	type Expectation struct {
		HasExtAfterSet   bool
		HasExtAfterClear bool
	}

	a := DefaultAttrData()
	a.Extended.SetUnderlineStyle(UnderlineStyleDouble)
	a.UpdateExtended()
	hasAfterSet := a.Bg&BgFlagHasExtended != 0

	a.Extended.SetUnderlineStyle(UnderlineStyleNone)
	a.UpdateExtended()
	hasAfterClear := a.Bg&BgFlagHasExtended != 0

	got := Expectation{HasExtAfterSet: hasAfterSet, HasExtAfterClear: hasAfterClear}
	expected := Expectation{HasExtAfterSet: true, HasExtAfterClear: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestAttributeDataUnderlineColor(t *testing.T) {
	type Expectation struct {
		Color     int
		ColorMode uint32
		IsRGB     bool
		IsPalette bool
		IsDefault bool
	}
	type TestCase struct {
		Name       string
		Fg         uint32
		Bg         uint32
		ExtULColor uint32
		Expected   Expectation
	}
	tests := []TestCase{
		{
			Name: "falls back to fg RGB",
			Fg:   AttrCMRGB | 0x112233,
			Expected: Expectation{
				Color: 0x112233, ColorMode: AttrCMRGB,
				IsRGB: true, IsPalette: false, IsDefault: false,
			},
		},
		{
			Name: "falls back to fg default",
			Expected: Expectation{
				Color: -1, ColorMode: AttrCMDefault,
				IsRGB: false, IsPalette: false, IsDefault: true,
			},
		},
		{
			Name:       "extended P256",
			Fg:         AttrCMRGB | 0x112233,
			Bg:         BgFlagHasExtended,
			ExtULColor: AttrCMP256 | 42,
			Expected: Expectation{
				Color: 42, ColorMode: AttrCMP256,
				IsRGB: false, IsPalette: true, IsDefault: false,
			},
		},
		{
			Name:       "extended RGB",
			Bg:         BgFlagHasExtended,
			ExtULColor: AttrCMRGB | 0xFF0000,
			Expected: Expectation{
				Color: 0xFF0000, ColorMode: AttrCMRGB,
				IsRGB: true, IsPalette: false, IsDefault: false,
			},
		},
		{
			Name:       "extended with zero underline color",
			Fg:         AttrCMP16 | 3,
			Bg:         BgFlagHasExtended,
			ExtULColor: 0, // ^uint32(0) != 0 → extended path taken; CM_DEFAULT → GetUnderlineColor falls back to fg
			Expected: Expectation{
				Color: 3, ColorMode: AttrCMDefault,
				IsRGB: false, IsPalette: false, IsDefault: true,
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			a := DefaultAttrData()
			a.Fg = tc.Fg
			a.Bg = tc.Bg
			if tc.ExtULColor != 0 {
				a.Extended.SetUnderlineColor(tc.ExtULColor)
			}
			got := Expectation{
				Color:     a.GetUnderlineColor(),
				ColorMode: a.GetUnderlineColorMode(),
				IsRGB:     a.IsUnderlineColorRGB(),
				IsPalette: a.IsUnderlineColorPalette(),
				IsDefault: a.IsUnderlineColorDefault(),
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestAttributeDataGetUnderlineVariantOffset(t *testing.T) {
	type Expectation struct {
		Offset int
	}

	a := DefaultAttrData()
	a.Extended.SetUnderlineVariantOffset(3)
	got := Expectation{Offset: a.GetUnderlineVariantOffset()}
	expected := Expectation{Offset: 3}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
