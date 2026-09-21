package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestEventEmitterFire(t *testing.T) {
	type Expectation struct {
		Results []int
	}
	type TestCase struct {
		Name      string
		Listeners int
		FireValue int
		Expected  Expectation
	}
	tests := []TestCase{
		{"no listeners", 0, 5, Expectation{Results: nil}},
		{"single listener", 1, 3, Expectation{Results: []int{30}}},
		{"two listeners", 2, 3, Expectation{Results: []int{30, 300}}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			var e EventEmitter[int]
			var results []int
			if tc.Listeners >= 1 {
				e.Event(func(v int) { results = append(results, v*10) })
			}
			if tc.Listeners >= 2 {
				e.Event(func(v int) { results = append(results, v*100) })
			}
			e.Fire(tc.FireValue)
			got := Expectation{Results: results}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestEventEmitterUnsubscribe(t *testing.T) {
	type Expectation struct {
		CallCount int
	}

	var e EventEmitter[string]
	count := 0
	d := e.Event(func(string) { count++ })
	e.Fire("a")
	d.Dispose()
	e.Fire("b")

	got := Expectation{CallCount: count}
	expected := Expectation{CallCount: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestEventEmitterDispose(t *testing.T) {
	type Expectation struct {
		CallCount    int
		HasListeners bool
	}

	var e EventEmitter[int]
	count := 0
	e.Event(func(int) { count++ })
	e.Dispose()
	e.Fire(1)
	d := e.Event(func(int) { count++ })
	e.Fire(2)
	d.Dispose()

	got := Expectation{CallCount: count, HasListeners: e.HasListeners()}
	expected := Expectation{CallCount: 0, HasListeners: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestEventEmitterSelfUnsubscribeDuringFire(t *testing.T) {
	type Expectation struct {
		FirstFire  []string
		SecondFire []string
	}

	var e EventEmitter[int]

	var target *[]string
	firstResults := []string{}
	secondResults := []string{}

	target = &firstResults
	var d1 Disposable
	d1 = e.Event(func(int) {
		*target = append(*target, "first")
		d1.Dispose()
	})
	e.Event(func(int) {
		*target = append(*target, "second")
	})

	e.Fire(1)
	target = &secondResults
	e.Fire(2)

	got := Expectation{FirstFire: firstResults, SecondFire: secondResults}
	expected := Expectation{
		FirstFire:  []string{"first", "second"},
		SecondFire: []string{"second"},
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestEventEmitterHasListeners(t *testing.T) {
	type Expectation struct {
		Before     bool
		After      bool
		AfterUnsub bool
	}

	var e EventEmitter[int]
	before := e.HasListeners()
	d := e.Event(func(int) {})
	after := e.HasListeners()
	d.Dispose()
	afterUnsub := e.HasListeners()

	got := Expectation{Before: before, After: after, AfterUnsub: afterUnsub}
	expected := Expectation{Before: false, After: true, AfterUnsub: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestEventEmitterDoubleDispose(t *testing.T) {
	type Expectation struct {
		CallCount int
	}

	var e EventEmitter[int]
	count := 0
	e.Event(func(int) { count++ })
	e.Dispose()
	e.Dispose()
	e.Fire(1)

	got := Expectation{CallCount: count}
	expected := Expectation{CallCount: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
