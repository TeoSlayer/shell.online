package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestCellDataFromCharData(t *testing.T) {
	type Expectation struct {
		Chars      string
		Width      int
		Code       uint32
		IsCombined bool
	}
	type TestCase struct {
		Name     string
		Input    CharData
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:  "ASCII",
			Input: NewCharData(0, "A", 1, uint32('A')),
			Expected: Expectation{
				Chars: "A", Width: 1, Code: uint32('A'), IsCombined: false,
			},
		},
		{
			Name:  "empty",
			Input: NewCharData(0, "", 1, 0),
			Expected: Expectation{
				Chars: "", Width: 1, Code: 0, IsCombined: false,
			},
		},
		{
			Name:  "wide CJK",
			Input: NewCharData(0, "中", 2, uint32('中')), //nolint:gosmopolitan
			Expected: Expectation{
				Chars: "中", Width: 2, Code: uint32('中'), IsCombined: false, //nolint:gosmopolitan
			},
		},
		{
			Name:  "emoji single rune",
			Input: NewCharData(0, "😀", 2, uint32(0x1F600)),
			Expected: Expectation{
				Chars: "😀", Width: 2, Code: 0x1F600, IsCombined: false,
			},
		},
		{
			Name:  "combined e+accent",
			Input: NewCharData(0, "e\u0301", 1, uint32('\u0301')),
			Expected: Expectation{
				Chars: "e\u0301", Width: 1, Code: uint32('\u0301'), IsCombined: true,
			},
		},
		{
			Name:  "three rune combined",
			Input: NewCharData(0, "abc", 1, uint32('c')),
			Expected: Expectation{
				Chars: "abc", Width: 1, Code: uint32('c'), IsCombined: true,
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			cell := CellDataFromCharData(tc.Input)
			got := Expectation{
				Chars:      cell.GetChars(),
				Width:      cell.GetWidth(),
				Code:       cell.GetCode(),
				IsCombined: cell.IsCombined() != 0,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestCellDataPreservesAttributes(t *testing.T) {
	type Expectation struct {
		Fg     uint32
		Bg     uint32
		IsBold bool
	}

	fg := AttrCMRGB | 0xAABBCC | FgFlagBold
	cell := CellDataFromCharData(NewCharData(fg, "Z", 1, uint32('Z')))

	got := Expectation{Fg: cell.Fg, Bg: cell.Bg, IsBold: cell.IsBold() != 0}
	expected := Expectation{Fg: fg, Bg: 0, IsBold: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCellDataGetAsCharDataRoundTrip(t *testing.T) {
	type Expectation struct {
		Char  string
		Width int
		Code  uint32
	}
	type TestCase struct {
		Name     string
		Input    CharData
		Expected Expectation
	}
	tests := []TestCase{
		{"ASCII", NewCharData(0, "A", 1, uint32('A')), Expectation{"A", 1, uint32('A')}},
		{"empty", NewCharData(0, "", 1, uint32(0)), Expectation{"", 1, 0}},
		{"wide", NewCharData(0, "中", 2, uint32('中')), Expectation{"中", 2, uint32('中')}}, //nolint:gosmopolitan
		{"emoji", NewCharData(0, "😀", 2, uint32(0x1F600)), Expectation{"😀", 2, 0x1F600}},
		{"combined", NewCharData(0, "e\u0301", 1, uint32('\u0301')), Expectation{"e\u0301", 1, uint32('\u0301')}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			cell := CellDataFromCharData(tc.Input)
			out := cell.GetAsCharData()
			got := Expectation{
				Char:  CharDataChar(out),
				Width: CharDataWidth(out),
				Code:  CharDataCode(out),
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestNewCellDataZeroValue(t *testing.T) {
	type Expectation struct {
		Content      uint32
		Fg           uint32
		Bg           uint32
		CombinedData string
		Chars        string
		Width        int
	}

	cell := NewCellData()
	got := Expectation{
		Content:      cell.Content,
		Fg:           cell.Fg,
		Bg:           cell.Bg,
		CombinedData: cell.CombinedData,
		Chars:        cell.GetChars(),
		Width:        cell.GetWidth(),
	}
	expected := Expectation{
		Content: 0, Fg: 0, Bg: 0,
		CombinedData: "", Chars: "", Width: 0,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCellDataGetCodeEmptyCombined(t *testing.T) {
	type Expectation struct {
		Code uint32
	}

	cell := NewCellData()
	cell.Content = ContentIsCombinedMask
	cell.CombinedData = ""

	got := Expectation{Code: cell.GetCode()}
	expected := Expectation{Code: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
