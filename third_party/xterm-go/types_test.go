package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestNewCharData(t *testing.T) {
	type Expectation struct {
		Attr  uint32
		Char  string
		Width int
		Code  uint32
	}

	cd := NewCharData(42, "X", 1, uint32('X'))
	got := Expectation{
		Attr:  CharDataAttr(cd),
		Char:  CharDataChar(cd),
		Width: CharDataWidth(cd),
		Code:  CharDataCode(cd),
	}
	expected := Expectation{Attr: 42, Char: "X", Width: 1, Code: uint32('X')}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMouseConstants(t *testing.T) {
	type Expectation struct {
		Value int
	}
	type TestCase struct {
		Name     string
		Got      int
		Expected Expectation
	}
	tests := []TestCase{
		{"MouseButtonLeft", int(MouseButtonLeft), Expectation{0}},
		{"MouseButtonNone", int(MouseButtonNone), Expectation{3}},
		{"MouseButtonWheel", int(MouseButtonWheel), Expectation{4}},
		{"MouseActionUp", int(MouseActionUp), Expectation{0}},
		{"MouseActionMove", int(MouseActionMove), Expectation{32}},
		{"MouseEventDown", int(MouseEventDown), Expectation{1}},
		{"MouseEventWheel", int(MouseEventWheel), Expectation{16}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			got := Expectation{Value: tc.Got}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}
