package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestToDisposable(t *testing.T) {
	type Expectation struct {
		CallCount int
	}
	type TestCase struct {
		Name     string
		NumCalls int
		Expected Expectation
	}
	tests := []TestCase{
		{"single dispose", 1, Expectation{CallCount: 1}},
		{"double dispose is idempotent", 2, Expectation{CallCount: 1}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			count := 0
			d := toDisposable(func() { count++ })
			for range tc.NumCalls {
				d.Dispose()
			}
			got := Expectation{CallCount: count}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestCombinedDisposable(t *testing.T) {
	type Expectation struct {
		Calls []string
	}

	var calls []string
	d1 := toDisposable(func() { calls = append(calls, "a") })
	d2 := toDisposable(func() { calls = append(calls, "b") })
	CombinedDisposable(d1, d2).Dispose()

	got := Expectation{Calls: calls}
	expected := Expectation{Calls: []string{"a", "b"}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestDisposableStore(t *testing.T) {
	type Expectation struct {
		CallCount        int
		IsDisposed       bool
		LateItemDisposed bool
	}
	type TestCase struct {
		Name     string
		Expected Expectation
	}
	tests := []TestCase{
		{"dispose all then add late item", Expectation{
			CallCount: 2, IsDisposed: true, LateItemDisposed: true,
		}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			callCount := 0
			s := &DisposableStore{}
			s.Add(toDisposable(func() { callCount++ }))
			s.Add(toDisposable(func() { callCount++ }))
			s.Dispose()

			lateDisposed := false
			s.Add(toDisposable(func() { lateDisposed = true }))

			got := Expectation{
				CallCount:        callCount,
				IsDisposed:       s.IsDisposed(),
				LateItemDisposed: lateDisposed,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestDisposableStoreClear(t *testing.T) {
	type Expectation struct {
		CallsAfterClear   int
		IsDisposed        bool
		CallsAfterDispose int
	}

	callCount := 0
	s := &DisposableStore{}
	s.Add(toDisposable(func() { callCount++ }))
	s.Clear()
	afterClear := callCount
	isDisposed := s.IsDisposed()

	s.Add(toDisposable(func() { callCount++ }))
	s.Dispose()

	got := Expectation{
		CallsAfterClear:   afterClear,
		IsDisposed:        isDisposed,
		CallsAfterDispose: callCount,
	}
	expected := Expectation{
		CallsAfterClear:   1,
		IsDisposed:        false,
		CallsAfterDispose: 2,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMutableDisposable(t *testing.T) {
	type Expectation struct {
		Calls      []string
		ValueAfter bool
	}
	type TestCase struct {
		Name     string
		Action   func(m *MutableDisposable, calls *[]string)
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name: "replace disposes old",
			Action: func(m *MutableDisposable, calls *[]string) {
				m.SetValue(toDisposable(func() { *calls = append(*calls, "a") }))
				m.SetValue(toDisposable(func() { *calls = append(*calls, "b") }))
			},
			Expected: Expectation{Calls: []string{"a"}, ValueAfter: true},
		},
		{
			Name: "clear disposes current",
			Action: func(m *MutableDisposable, calls *[]string) {
				m.SetValue(toDisposable(func() { *calls = append(*calls, "x") }))
				m.Clear()
			},
			Expected: Expectation{Calls: []string{"x"}, ValueAfter: false},
		},
		{
			Name: "dispose then set is noop",
			Action: func(m *MutableDisposable, calls *[]string) {
				m.SetValue(toDisposable(func() { *calls = append(*calls, "d") }))
				m.Dispose()
				m.SetValue(toDisposable(func() { *calls = append(*calls, "should not appear") }))
			},
			Expected: Expectation{Calls: []string{"d"}, ValueAfter: false},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			var calls []string
			m := &MutableDisposable{}
			tc.Action(m, &calls)
			got := Expectation{
				Calls:      calls,
				ValueAfter: m.Value() != nil,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestDisposableStoreDoubleDispose(t *testing.T) {
	type Expectation struct {
		CallCount int
	}

	callCount := 0
	s := &DisposableStore{}
	s.Add(toDisposable(func() { callCount++ }))
	s.Dispose()
	s.Dispose() // second dispose is idempotent

	got := Expectation{CallCount: callCount}
	expected := Expectation{CallCount: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
