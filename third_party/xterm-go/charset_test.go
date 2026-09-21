package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestCharsetDECSpecialGraphics(t *testing.T) {
	t.Parallel()

	type TestCase struct {
		Name     string
		Input    byte
		Expected rune
	}
	tests := []TestCase{
		{"diamond", '`', '\u25c6'},
		{"checkerboard", 'a', '\u2592'},
		{"degree", 'f', '\u00b0'},
		{"lower-right corner", 'j', '\u2518'},
		{"upper-right corner", 'k', '\u2510'},
		{"upper-left corner", 'l', '\u250c'},
		{"lower-left corner", 'm', '\u2514'},
		{"crossing", 'n', '\u253c'},
		{"horizontal line", 'q', '\u2500'},
		{"vertical line", 'x', '\u2502'},
		{"pi", '{', '\u03c0'},
		{"not-equal", '|', '\u2260'},
		{"pound", '}', '\u00a3'},
		{"middle dot", '~', '\u00b7'},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			type Expectation struct {
				Rune  rune
				Found bool
			}
			r, ok := CharsetDECSpecialGraphics[tc.Input]
			got := Expectation{Rune: r, Found: ok}
			expected := Expectation{Rune: tc.Expected, Found: true}
			if diff := cmp.Diff(expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestCHARSETSMap(t *testing.T) {
	t.Parallel()

	type TestCase struct {
		Name       string
		Designator byte
		IsNil      bool
		SampleKey  byte
		SampleVal  rune
	}
	tests := []TestCase{
		{"US (B) is nil", 'B', true, 0, 0},
		{"DEC special (0)", '0', false, 'q', '\u2500'},
		{"British (A)", 'A', false, '#', '\u00a3'},
		{"Finnish (C)", 'C', false, '[', '\u00c4'},
		{"Finnish alias (5)", '5', false, '[', '\u00c4'},
		{"German (K)", 'K', false, '~', '\u00df'},
		{"Swedish (H)", 'H', false, '@', '\u00c9'},
		{"Swedish alias (7)", '7', false, '@', '\u00c9'},
		{"Swiss (=)", '=', false, '#', '\u00f9'},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			type Expectation struct {
				Found     bool
				IsNil     bool
				SampleVal rune
			}
			cs, found := CHARSETS[tc.Designator]
			var sampleVal rune
			if cs != nil && tc.SampleKey != 0 {
				sampleVal = cs[tc.SampleKey]
			}
			got := Expectation{Found: found, IsNil: cs == nil, SampleVal: sampleVal}
			expected := Expectation{Found: true, IsNil: tc.IsNil, SampleVal: tc.SampleVal}
			if diff := cmp.Diff(expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestCharsetServiceReset(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		CharsetNil bool
		GLevel     int
		NumSlots   int
	}

	cs := NewCharsetService()
	cs.SetgCharset(0, CharsetDECSpecialGraphics)
	cs.SetgLevel(0)
	cs.Reset()

	got := Expectation{
		CharsetNil: cs.Charset == nil,
		GLevel:     cs.GLevel,
		NumSlots:   len(cs.Charsets()),
	}
	expected := Expectation{CharsetNil: true, GLevel: 0, NumSlots: 4}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCharsetServiceSetgCharset(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ActiveCharsetNil bool
		G1CharsetNil     bool
		MappedRune       rune
	}

	cs := NewCharsetService()
	cs.SetgCharset(1, CharsetBritish)
	// Active charset should still be nil (GLevel=0, G0 is nil)
	got := Expectation{
		ActiveCharsetNil: cs.Charset == nil,
		G1CharsetNil:     cs.Charsets()[1] == nil,
	}
	expected := Expectation{ActiveCharsetNil: true, G1CharsetNil: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}

	// Now switch to G1
	cs.SetgLevel(1)
	r := cs.Charset['#']
	got2 := Expectation{
		ActiveCharsetNil: cs.Charset == nil,
		MappedRune:       r,
	}
	expected2 := Expectation{ActiveCharsetNil: false, MappedRune: '\u00a3'}
	if diff := cmp.Diff(expected2, got2); diff != "" {
		t.Errorf("after SetgLevel (-want +got):\n%s", diff)
	}
}

func TestCharsetServiceSetgLevel(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		GLevel       int
		CharsetIsNil bool
	}

	cs := NewCharsetService()
	cs.SetgCharset(0, CharsetDECSpecialGraphics)
	cs.SetgCharset(2, CharsetGerman)
	cs.SetgLevel(2)

	got := Expectation{GLevel: cs.GLevel, CharsetIsNil: cs.Charset == nil}
	expected := Expectation{GLevel: 2, CharsetIsNil: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}

	// Verify the active charset is German
	type Expectation2 struct {
		Rune rune
	}
	got2 := Expectation2{Rune: cs.Charset['~']}
	expected2 := Expectation2{Rune: '\u00df'}
	if diff := cmp.Diff(expected2, got2); diff != "" {
		t.Errorf("charset mapping (-want +got):\n%s", diff)
	}
}

func TestCharsetServiceSetgCharsetUpdatesActive(t *testing.T) {
	t.Parallel()

	// When setting a charset on the active GLevel, the active charset should update.
	type Expectation struct {
		CharsetNil bool
		MappedRune rune
	}

	cs := NewCharsetService()
	// GLevel defaults to 0
	cs.SetgCharset(0, CharsetFrench)

	got := Expectation{
		CharsetNil: cs.Charset == nil,
		MappedRune: cs.Charset['#'],
	}
	expected := Expectation{CharsetNil: false, MappedRune: '\u00a3'}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCharsetServiceSetgCharsetExpandsSlots(t *testing.T) {
	t.Parallel()

	// Setting G3 should expand the charsets slice if needed.
	type Expectation struct {
		MinSlots int
		G3IsNil  bool
	}

	cs := NewCharsetService()
	cs.SetgCharset(3, CharsetSwiss)

	got := Expectation{
		MinSlots: len(cs.Charsets()),
		G3IsNil:  cs.Charsets()[3] == nil,
	}
	expected := Expectation{MinSlots: 4, G3IsNil: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
