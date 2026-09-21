package xterm

import (
	"fmt"
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestSGR_Reset(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[1;31m")
	h.ParseString("\x1b[0m")
	type E struct{ Fg, Bg uint32 }
	def := DefaultAttrData()
	got := E{h.curAttrData.Fg, h.curAttrData.Bg}
	want := E{def.Fg, def.Bg}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestSGR_Bold(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[1m")
	if h.curAttrData.Fg&FgFlagBold == 0 {
		t.Error("expected bold flag set")
	}
	h.ParseString("\x1b[22m")
	if h.curAttrData.Fg&FgFlagBold != 0 {
		t.Error("expected bold flag cleared")
	}
}

func TestSGR_Dim(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[2m")
	if h.curAttrData.Bg&BgFlagDim == 0 {
		t.Error("expected dim flag set")
	}
	h.ParseString("\x1b[22m")
	if h.curAttrData.Bg&BgFlagDim != 0 {
		t.Error("expected dim flag cleared")
	}
}

func TestSGR_Italic(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[3m")
	if h.curAttrData.Bg&BgFlagItalic == 0 {
		t.Error("expected italic flag set")
	}
	h.ParseString("\x1b[23m")
	if h.curAttrData.Bg&BgFlagItalic != 0 {
		t.Error("expected italic flag cleared")
	}
}

func TestSGR_Underline(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[4m")
	if h.curAttrData.Fg&FgFlagUnderline == 0 {
		t.Error("expected underline flag set")
	}
	if h.curAttrData.Extended.UnderlineStyle() != UnderlineStyleSingle {
		t.Errorf("expected single underline, got %d", h.curAttrData.Extended.UnderlineStyle())
	}
	h.ParseString("\x1b[24m")
	if h.curAttrData.Fg&FgFlagUnderline != 0 {
		t.Error("expected underline flag cleared")
	}
}

func TestSGR_Blink(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[5m")
	if h.curAttrData.Fg&FgFlagBlink == 0 {
		t.Error("expected blink flag set")
	}
	h.ParseString("\x1b[25m")
	if h.curAttrData.Fg&FgFlagBlink != 0 {
		t.Error("expected blink flag cleared")
	}
}

func TestSGR_Inverse(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[7m")
	if h.curAttrData.Fg&FgFlagInverse == 0 {
		t.Error("expected inverse flag set")
	}
	h.ParseString("\x1b[27m")
	if h.curAttrData.Fg&FgFlagInverse != 0 {
		t.Error("expected inverse flag cleared")
	}
}

func TestSGR_Invisible(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[8m")
	if h.curAttrData.Fg&FgFlagInvisible == 0 {
		t.Error("expected invisible flag set")
	}
	h.ParseString("\x1b[28m")
	if h.curAttrData.Fg&FgFlagInvisible != 0 {
		t.Error("expected invisible flag cleared")
	}
}

func TestSGR_Strikethrough(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[9m")
	if h.curAttrData.Fg&FgFlagStrikethrough == 0 {
		t.Error("expected strikethrough flag set")
	}
	h.ParseString("\x1b[29m")
	if h.curAttrData.Fg&FgFlagStrikethrough != 0 {
		t.Error("expected strikethrough flag cleared")
	}
}

func TestSGR_Overline(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[53m")
	if h.curAttrData.Bg&BgFlagOverline == 0 {
		t.Error("expected overline flag set")
	}
	h.ParseString("\x1b[55m")
	if h.curAttrData.Bg&BgFlagOverline != 0 {
		t.Error("expected overline flag cleared")
	}
}

func TestSGR_DoubleUnderline(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[21m")
	if h.curAttrData.Fg&FgFlagUnderline == 0 {
		t.Error("expected underline flag set")
	}
	if h.curAttrData.Extended.UnderlineStyle() != UnderlineStyleDouble {
		t.Errorf("expected double underline, got %d", h.curAttrData.Extended.UnderlineStyle())
	}
}

func TestSGR_FgColors8(t *testing.T) {
	t.Parallel()
	for i := int32(30); i <= 37; i++ {
		t.Run(fmt.Sprintf("SGR_%d", i), func(t *testing.T) {
			h := newTestHandler()
			h.ParseString(fmt.Sprintf("\x1b[%dm", i))
			type E struct{ CM, Color uint32 }
			got := E{h.curAttrData.Fg & AttrCMMask, h.curAttrData.Fg & AttrPColorMask}
			want := E{AttrCMP16, uint32(i - 30)}
			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestSGR_BgColors8(t *testing.T) {
	t.Parallel()
	for i := int32(40); i <= 47; i++ {
		t.Run(fmt.Sprintf("SGR_%d", i), func(t *testing.T) {
			h := newTestHandler()
			h.ParseString(fmt.Sprintf("\x1b[%dm", i))
			type E struct{ CM, Color uint32 }
			got := E{h.curAttrData.Bg & AttrCMMask, h.curAttrData.Bg & AttrPColorMask}
			want := E{AttrCMP16, uint32(i - 40)}
			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestSGR_BrightFgColors(t *testing.T) {
	t.Parallel()
	for i := int32(90); i <= 97; i++ {
		t.Run(fmt.Sprintf("SGR_%d", i), func(t *testing.T) {
			h := newTestHandler()
			h.ParseString(fmt.Sprintf("\x1b[%dm", i))
			type E struct{ CM, Color uint32 }
			got := E{h.curAttrData.Fg & AttrCMMask, h.curAttrData.Fg & AttrPColorMask}
			want := E{AttrCMP16, uint32(i-90) | 8}
			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestSGR_BrightBgColors(t *testing.T) {
	t.Parallel()
	for i := int32(100); i <= 107; i++ {
		t.Run(fmt.Sprintf("SGR_%d", i), func(t *testing.T) {
			h := newTestHandler()
			h.ParseString(fmt.Sprintf("\x1b[%dm", i))
			type E struct{ CM, Color uint32 }
			got := E{h.curAttrData.Bg & AttrCMMask, h.curAttrData.Bg & AttrPColorMask}
			want := E{AttrCMP16, uint32(i-100) | 8}
			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestSGR_256Color_Fg(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[38;5;196m")
	type E struct{ CM, Color uint32 }
	got := E{h.curAttrData.Fg & AttrCMMask, h.curAttrData.Fg & AttrPColorMask}
	want := E{AttrCMP256, 196}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestSGR_256Color_Bg(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[48;5;42m")
	type E struct{ CM, Color uint32 }
	got := E{h.curAttrData.Bg & AttrCMMask, h.curAttrData.Bg & AttrPColorMask}
	want := E{AttrCMP256, 42}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestSGR_RGB_Fg(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[38;2;100;150;200m")
	type E struct{ CM, Color uint32 }
	got := E{h.curAttrData.Fg & AttrCMMask, h.curAttrData.Fg & AttrRGBMask}
	want := E{AttrCMRGB, FromColorRGB(ColorRGB{100, 150, 200})}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestSGR_RGB_Bg(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[48;2;10;20;30m")
	type E struct{ CM, Color uint32 }
	got := E{h.curAttrData.Bg & AttrCMMask, h.curAttrData.Bg & AttrRGBMask}
	want := E{AttrCMRGB, FromColorRGB(ColorRGB{10, 20, 30})}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestSGR_RGB_SubParams(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// 38:2::R:G:B format — colon-separated with empty color space
	params := NewParams(32, 32)
	params.AddParam(38)
	params.AddSubParam(2)
	params.AddSubParam(-1) // empty color space
	params.AddSubParam(50)
	params.AddSubParam(100)
	params.AddSubParam(150)
	h.charAttributes(params)

	type E struct{ CM, Color uint32 }
	got := E{h.curAttrData.Fg & AttrCMMask, h.curAttrData.Fg & AttrRGBMask}
	want := E{AttrCMRGB, FromColorRGB(ColorRGB{50, 100, 150})}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestSGR_UnderlineStyles(t *testing.T) {
	t.Parallel()
	tests := []struct {
		subParam int32
		style    UnderlineStyle
		hasUL    bool
	}{
		{0, UnderlineStyleNone, false},
		{1, UnderlineStyleSingle, true},
		{2, UnderlineStyleDouble, true},
		{3, UnderlineStyleCurly, true},
		{4, UnderlineStyleDotted, true},
		{5, UnderlineStyleDashed, true},
	}
	for _, tc := range tests {
		t.Run(fmt.Sprintf("4:%d", tc.subParam), func(t *testing.T) {
			h := newTestHandler()
			params := NewParams(32, 32)
			params.AddParam(4)
			params.AddSubParam(tc.subParam)
			h.charAttributes(params)

			type E struct {
				Style UnderlineStyle
				HasUL bool
			}
			got := E{h.curAttrData.Extended.UnderlineStyle(), h.curAttrData.Fg&FgFlagUnderline != 0}
			want := E{tc.style, tc.hasUL}
			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestSGR_UnderlineColor_RGB(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[58;2;200;100;50m")
	ext := h.curAttrData.Extended
	uc := ext.UnderlineColor()
	type E struct{ CM, Color uint32 }
	got := E{uc & AttrCMMask, uc & AttrRGBMask}
	want := E{AttrCMRGB, FromColorRGB(ColorRGB{200, 100, 50})}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestSGR_UnderlineColor_256(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[58;5;123m")
	ext := h.curAttrData.Extended
	uc := ext.UnderlineColor()
	type E struct{ CM, Color uint32 }
	got := E{uc & AttrCMMask, uc & AttrPColorMask}
	want := E{AttrCMP256, 123}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestSGR_UnderlineColor_Reset(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[58;2;200;100;50m")
	h.ParseString("\x1b[59m")
	// After reset, underline color should be 0 (CM_DEFAULT)
	ext := h.curAttrData.Extended
	uc := ext.UnderlineColor()
	if uc != 0 {
		t.Errorf("expected underline color 0 after reset, got %08x", uc)
	}
}

func TestSGR_ResetFg(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[31m")
	h.ParseString("\x1b[39m")
	def := DefaultAttrData()
	if h.curAttrData.Fg&AttrCMMask != def.Fg&AttrCMMask {
		t.Error("expected fg color mode to be default after SGR 39")
	}
}

func TestSGR_ResetBg(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[41m")
	h.ParseString("\x1b[49m")
	def := DefaultAttrData()
	if h.curAttrData.Bg&AttrCMMask != def.Bg&AttrCMMask {
		t.Error("expected bg color mode to be default after SGR 49")
	}
}

func TestSGR_Combined(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// bold + italic + red fg + green bg in one sequence
	h.ParseString("\x1b[1;3;31;42m")
	type E struct {
		Bold, Italic bool
		FgCM, FgCol  uint32
		BgCM, BgCol  uint32
	}
	got := E{
		Bold:   h.curAttrData.Fg&FgFlagBold != 0,
		Italic: h.curAttrData.Bg&BgFlagItalic != 0,
		FgCM:   h.curAttrData.Fg & AttrCMMask,
		FgCol:  h.curAttrData.Fg & AttrPColorMask,
		BgCM:   h.curAttrData.Bg & AttrCMMask,
		BgCol:  h.curAttrData.Bg & AttrPColorMask,
	}
	want := E{
		Bold: true, Italic: true,
		FgCM: AttrCMP16, FgCol: 1,
		BgCM: AttrCMP16, BgCol: 2,
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestSGR_256Color_SubParams(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// 38:5:196 format — colon-separated
	params := NewParams(32, 32)
	params.AddParam(38)
	params.AddSubParam(5)
	params.AddSubParam(196)
	h.charAttributes(params)

	type E struct{ CM, Color uint32 }
	got := E{h.curAttrData.Fg & AttrCMMask, h.curAttrData.Fg & AttrPColorMask}
	want := E{AttrCMP256, 196}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestSGR_SGR0_Preserves_URLId(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// Set a URL ID on extended attrs
	h.curAttrData.Extended = h.curAttrData.extended().Clone()
	h.curAttrData.Extended.SetURLID(42)
	h.curAttrData.UpdateExtended()
	// SGR 0 should reset styles but preserve URL ID
	h.ParseString("\x1b[0m")
	if h.curAttrData.Extended.URLID() != 42 {
		t.Errorf("expected URL ID 42 preserved, got %d", h.curAttrData.Extended.URLID())
	}
}

func TestSGR_RGBToP16_ClearsStaleRGBBits_Fg(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// Set RGB fg #FF8040
	h.ParseString("\x1b[38;2;255;128;64m")
	// Switch to P16 red (index 1)
	h.ParseString("\x1b[31m")

	// The full 24-bit color field must be clean — no stale RGB bytes
	colorBits := h.curAttrData.Fg & AttrRGBMask
	wantColor := uint32(1) // palette index 1 (red)
	if colorBits != wantColor {
		t.Errorf("stale RGB bits in Fg: got 0x%06x, want 0x%06x", colorBits, wantColor)
	}
	if cm := h.curAttrData.Fg & AttrCMMask; cm != AttrCMP16 {
		t.Errorf("wrong color mode: got 0x%x, want 0x%x (P16)", cm, AttrCMP16)
	}
}

func TestSGR_RGBToP16_ClearsStaleRGBBits_Bg(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// Set RGB bg #FF8040
	h.ParseString("\x1b[48;2;255;128;64m")
	// Switch to P16 green bg (index 2)
	h.ParseString("\x1b[42m")

	colorBits := h.curAttrData.Bg & AttrRGBMask
	wantColor := uint32(2)
	if colorBits != wantColor {
		t.Errorf("stale RGB bits in Bg: got 0x%06x, want 0x%06x", colorBits, wantColor)
	}
	if cm := h.curAttrData.Bg & AttrCMMask; cm != AttrCMP16 {
		t.Errorf("wrong color mode: got 0x%x, want 0x%x (P16)", cm, AttrCMP16)
	}
}

func TestSGR_RGBToP16Bright_ClearsStaleRGBBits(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// Set RGB fg
	h.ParseString("\x1b[38;2;200;100;50m")
	// Switch to bright red fg (SGR 91 = index 1|8 = 9)
	h.ParseString("\x1b[91m")

	colorBits := h.curAttrData.Fg & AttrRGBMask
	wantColor := uint32(1) | 8
	if colorBits != wantColor {
		t.Errorf("stale RGB bits in Fg after bright: got 0x%06x, want 0x%06x", colorBits, wantColor)
	}
}

func TestSGR_RGBToP256_ClearsStaleRGBBits_Fg(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// Set RGB fg #AABBCC
	h.ParseString("\x1b[38;2;170;187;204m")
	// Switch to P256 color 196
	h.ParseString("\x1b[38;5;196m")

	colorBits := h.curAttrData.Fg & AttrRGBMask
	wantColor := uint32(196)
	if colorBits != wantColor {
		t.Errorf("stale RGB bits in Fg: got 0x%06x, want 0x%06x", colorBits, wantColor)
	}
	if cm := h.curAttrData.Fg & AttrCMMask; cm != AttrCMP256 {
		t.Errorf("wrong color mode: got 0x%x, want 0x%x (P256)", cm, AttrCMP256)
	}
}

func TestSGR_RGBToP256_ClearsStaleRGBBits_Bg(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// Set RGB bg
	h.ParseString("\x1b[48;2;170;187;204m")
	// Switch to P256 bg color 42
	h.ParseString("\x1b[48;5;42m")

	colorBits := h.curAttrData.Bg & AttrRGBMask
	wantColor := uint32(42)
	if colorBits != wantColor {
		t.Errorf("stale RGB bits in Bg: got 0x%06x, want 0x%06x", colorBits, wantColor)
	}
	if cm := h.curAttrData.Bg & AttrCMMask; cm != AttrCMP256 {
		t.Errorf("wrong color mode: got 0x%x, want 0x%x (P256)", cm, AttrCMP256)
	}
}

func TestSGR_MultipleResets(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\x1b[1;3;4;7;9;53m")
	h.ParseString("\x1b[0m")
	def := DefaultAttrData()
	if h.curAttrData.Fg != def.Fg {
		t.Errorf("fg not reset: got %08x, want %08x", h.curAttrData.Fg, def.Fg)
	}
	// bg may have HAS_EXTENDED cleared
	bgMask := ^BgFlagHasExtended
	if h.curAttrData.Bg&bgMask != def.Bg&bgMask {
		t.Errorf("bg not reset: got %08x, want %08x", h.curAttrData.Bg&bgMask, def.Bg&bgMask)
	}
}

func TestVtExtensions_KittySgrBoldFaintControlGating(t *testing.T) {
	t.Parallel()

	t.Run("SGR_221_resets_bold_when_enabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		h.ParseString("\x1b[1m")
		if h.curAttrData.Fg&FgFlagBold == 0 {
			t.Fatal("precondition: bold should be set")
		}
		h.ParseString("\x1b[221m")
		if h.curAttrData.Fg&FgFlagBold != 0 {
			t.Error("SGR 221 should reset bold when kittySgrBoldFaintControl is enabled")
		}
	})

	t.Run("SGR_221_ignored_when_disabled", func(t *testing.T) {
		t.Parallel()
		f := false
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{KittySgrBoldFaintControl: &f})
		h.ParseString("\x1b[1m")
		if h.curAttrData.Fg&FgFlagBold == 0 {
			t.Fatal("precondition: bold should be set")
		}
		h.ParseString("\x1b[221m")
		if h.curAttrData.Fg&FgFlagBold == 0 {
			t.Error("SGR 221 should be ignored when kittySgrBoldFaintControl is disabled")
		}
	})

	t.Run("SGR_222_resets_dim_when_enabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		h.ParseString("\x1b[2m")
		if h.curAttrData.Bg&BgFlagDim == 0 {
			t.Fatal("precondition: dim should be set")
		}
		h.ParseString("\x1b[222m")
		if h.curAttrData.Bg&BgFlagDim != 0 {
			t.Error("SGR 222 should reset dim when kittySgrBoldFaintControl is enabled")
		}
	})

	t.Run("SGR_222_ignored_when_disabled", func(t *testing.T) {
		t.Parallel()
		f := false
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{KittySgrBoldFaintControl: &f})
		h.ParseString("\x1b[2m")
		if h.curAttrData.Bg&BgFlagDim == 0 {
			t.Fatal("precondition: dim should be set")
		}
		h.ParseString("\x1b[222m")
		if h.curAttrData.Bg&BgFlagDim == 0 {
			t.Error("SGR 222 should be ignored when kittySgrBoldFaintControl is disabled")
		}
	})

	t.Run("SGR_221_222_enabled_by_default_when_nil", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{})
		h.ParseString("\x1b[1m")
		h.ParseString("\x1b[221m")
		if h.curAttrData.Fg&FgFlagBold != 0 {
			t.Error("SGR 221 should work when KittySgrBoldFaintControl is nil (default true)")
		}
	})
}
