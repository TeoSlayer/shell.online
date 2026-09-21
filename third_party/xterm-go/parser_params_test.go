package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestParamsAddAndReset(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Length int
		Values []int32
	}
	type TestCase struct {
		Name     string
		Params   []int32
		Reset    bool
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:     "add single param",
			Params:   []int32{1},
			Expected: Expectation{Length: 1, Values: []int32{1}},
		},
		{
			Name:     "add multiple params",
			Params:   []int32{1, 2, 3},
			Expected: Expectation{Length: 3, Values: []int32{1, 2, 3}},
		},
		{
			Name:     "add default param marker",
			Params:   []int32{-1},
			Expected: Expectation{Length: 1, Values: []int32{-1}},
		},
		{
			Name:     "reset clears all",
			Params:   []int32{1, 2, 3},
			Reset:    true,
			Expected: Expectation{Length: 0, Values: []int32{}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			p := DefaultParams()
			for _, v := range tc.Params {
				p.AddParam(v)
			}
			if tc.Reset {
				p.Reset()
			}
			got := Expectation{
				Length: p.Length,
				Values: make([]int32, p.Length),
			}
			copy(got.Values, p.Params[:p.Length])
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestParamsSubParams(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		HasSub    []bool
		SubParams [][]int32
	}
	type TestCase struct {
		Name     string
		Setup    func(p *Params)
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name: "no sub params",
			Setup: func(p *Params) {
				p.AddParam(1)
				p.AddParam(2)
			},
			Expected: Expectation{
				HasSub:    []bool{false, false},
				SubParams: [][]int32{nil, nil},
			},
		},
		{
			Name: "sub params on second param",
			Setup: func(p *Params) {
				p.AddParam(1)
				p.AddParam(2)
				p.AddSubParam(3)
				p.AddSubParam(4)
			},
			Expected: Expectation{
				HasSub:    []bool{false, true},
				SubParams: [][]int32{nil, {3, 4}},
			},
		},
		{
			Name: "sub params on first param",
			Setup: func(p *Params) {
				p.AddParam(1)
				p.AddSubParam(10)
				p.AddParam(2)
			},
			Expected: Expectation{
				HasSub:    []bool{true, false},
				SubParams: [][]int32{{10}, nil},
			},
		},
		{
			Name: "sub params ignored before any param",
			Setup: func(p *Params) {
				p.AddSubParam(99)
				p.AddParam(1)
			},
			Expected: Expectation{
				HasSub:    []bool{false},
				SubParams: [][]int32{nil},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			p := DefaultParams()
			tc.Setup(p)
			got := Expectation{
				HasSub:    make([]bool, p.Length),
				SubParams: make([][]int32, p.Length),
			}
			for i := range p.Length {
				got.HasSub[i] = p.HasSubParams(i)
				got.SubParams[i] = p.GetSubParams(i)
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestParamsClone(t *testing.T) {
	t.Parallel()
	p := DefaultParams()
	p.AddParam(1)
	p.AddSubParam(10)
	p.AddParam(2)
	p.AddParam(3)

	c := p.Clone()

	// Mutate original
	p.AddParam(99)

	type Expectation struct {
		Length   int
		Values   []int32
		HasSub0  bool
		SubP0    []int32
		CloneLen int
	}
	expected := Expectation{
		Length:   4,
		Values:   []int32{1, 2, 3, 99},
		HasSub0:  true,
		SubP0:    []int32{10},
		CloneLen: 3,
	}
	got := Expectation{
		Length:   p.Length,
		Values:   make([]int32, p.Length),
		HasSub0:  p.HasSubParams(0),
		SubP0:    p.GetSubParams(0),
		CloneLen: c.Length,
	}
	copy(got.Values, p.Params[:p.Length])

	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
	// Clone should be independent
	if c.Length != 3 {
		t.Errorf("clone length = %d, want 3", c.Length)
	}
}

func TestParamsOverflow(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		ParamLength    int
		SubParamLength int
	}
	type TestCase struct {
		Name     string
		Setup    func(p *Params)
		MaxLen   int
		MaxSub   int
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:   "params overflow",
			MaxLen: 3, MaxSub: 32,
			Setup: func(p *Params) {
				for i := range int32(10) {
					p.AddParam(i)
				}
			},
			Expected: Expectation{ParamLength: 3, SubParamLength: 0},
		},
		{
			Name:   "sub params overflow",
			MaxLen: 32, MaxSub: 3,
			Setup: func(p *Params) {
				p.AddParam(1)
				for i := range int32(10) {
					p.AddSubParam(i)
				}
			},
			Expected: Expectation{ParamLength: 1, SubParamLength: 3},
		},
		{
			Name:   "value clamped to max",
			MaxLen: 32, MaxSub: 32,
			Setup: func(p *Params) {
				// Use AddDigit to exceed maxParamValue via accumulation
				p.AddParam(maxParamValue)
				p.AddDigit(9)
			},
			Expected: Expectation{ParamLength: 1, SubParamLength: 0},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			p := NewParams(tc.MaxLen, tc.MaxSub)
			tc.Setup(p)
			got := Expectation{
				ParamLength:    p.Length,
				SubParamLength: p.subParamsLength,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestParamsFromArray(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Array []interface{}
	}
	type TestCase struct {
		Name     string
		Input    []interface{}
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:     "empty",
			Input:    []interface{}{},
			Expected: Expectation{Array: []interface{}{}},
		},
		{
			Name:     "simple params",
			Input:    []interface{}{int32(1), int32(2), int32(3)},
			Expected: Expectation{Array: []interface{}{int32(1), int32(2), int32(3)}},
		},
		{
			Name:     "with sub params",
			Input:    []interface{}{int32(1), int32(2), []int32{3, 4}, int32(5)},
			Expected: Expectation{Array: []interface{}{int32(1), int32(2), []int32{3, 4}, int32(5)}},
		},
		{
			Name:     "leading sub params skipped",
			Input:    []interface{}{[]int32{99}, int32(1)},
			Expected: Expectation{Array: []interface{}{int32(1)}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			p := ParamsFromArray(tc.Input)
			got := Expectation{Array: p.ToArray()}
			if len(got.Array) == 0 {
				got.Array = []interface{}{}
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestParamsToArray(t *testing.T) {
	t.Parallel()
	// Simulate sequence "1;2:3:4;5::6"
	p := DefaultParams()
	p.AddParam(1)
	p.AddParam(2)
	p.AddSubParam(3)
	p.AddSubParam(4)
	p.AddParam(5)
	p.AddSubParam(-1)
	p.AddSubParam(6)

	expected := []interface{}{
		int32(1),
		int32(2), []int32{3, 4},
		int32(5), []int32{-1, 6},
	}
	got := p.ToArray()
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestParamsAddDigit(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Values []int32
	}
	type TestCase struct {
		Name     string
		Setup    func(p *Params)
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name: "accumulate digits on param",
			Setup: func(p *Params) {
				p.AddParam(0)
				p.AddDigit(1)
				p.AddDigit(2)
				p.AddDigit(3)
			},
			Expected: Expectation{Values: []int32{123}},
		},
		{
			Name: "digit on default param replaces -1",
			Setup: func(p *Params) {
				p.AddParam(-1)
				p.AddDigit(5)
			},
			Expected: Expectation{Values: []int32{5}},
		},
		{
			Name: "digit ignored when no params",
			Setup: func(p *Params) {
				p.AddDigit(5)
			},
			Expected: Expectation{Values: []int32{}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			p := DefaultParams()
			tc.Setup(p)
			got := Expectation{
				Values: make([]int32, p.Length),
			}
			copy(got.Values, p.Params[:p.Length])
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestParamsGetSubParamsAll(t *testing.T) {
	t.Parallel()
	p := DefaultParams()
	p.AddParam(1)
	p.AddSubParam(10)
	p.AddSubParam(11)
	p.AddParam(2)
	p.AddParam(3)
	p.AddSubParam(30)

	expected := map[int][]int32{
		0: {10, 11},
		2: {30},
	}
	got := p.GetSubParamsAll()
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestParamsResetZdm(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Length int
		Values []int32
	}
	type TestCase struct {
		Name     string
		Setup    func(p *Params)
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:     "fresh params seeded with zero default",
			Setup:    func(p *Params) {},
			Expected: Expectation{Length: 1, Values: []int32{0}},
		},
		{
			Name: "previously populated params collapse to single zero",
			Setup: func(p *Params) {
				p.AddParam(5)
				p.AddSubParam(7)
				p.AddParam(9)
			},
			Expected: Expectation{Length: 1, Values: []int32{0}},
		},
		{
			Name: "matches Reset followed by AddParam(0)",
			Setup: func(p *Params) {
				p.AddParam(42)
				p.AddSubParam(1)
				p.AddSubParam(2)
			},
			Expected: Expectation{Length: 1, Values: []int32{0}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			p := DefaultParams()
			tc.Setup(p)
			p.ResetZdm()
			got := Expectation{
				Length: p.Length,
				Values: append([]int32{}, p.Params[:p.Length]...),
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}

			// Confirm equivalence with Reset() + AddParam(0).
			ref := DefaultParams()
			tc.Setup(ref)
			ref.Reset()
			ref.AddParam(0)
			if diff := cmp.Diff(ref.Params[:ref.Length], p.Params[:p.Length]); diff != "" {
				t.Errorf("ResetZdm not equivalent to Reset+AddParam(0) (-ref +zdm):\n%s", diff)
			}
			if ref.Length != p.Length {
				t.Errorf("Length mismatch: ref=%d zdm=%d", ref.Length, p.Length)
			}
		})
	}
}
