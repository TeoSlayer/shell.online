package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestCircularListPushAndGet(t *testing.T) {
	type Expectation struct {
		Length int
		Items  []int
	}
	type TestCase struct {
		Name     string
		MaxLen   int
		Pushes   []int
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:   "under capacity",
			MaxLen: 5, Pushes: []int{1, 2, 3},
			Expected: Expectation{Length: 3, Items: []int{1, 2, 3}},
		},
		{
			Name:   "at capacity",
			MaxLen: 3, Pushes: []int{1, 2, 3},
			Expected: Expectation{Length: 3, Items: []int{1, 2, 3}},
		},
		{
			Name:   "wraps around",
			MaxLen: 3, Pushes: []int{1, 2, 3, 4},
			Expected: Expectation{Length: 3, Items: []int{2, 3, 4}},
		},
		{
			Name:   "wraps multiple times",
			MaxLen: 3, Pushes: []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
			Expected: Expectation{Length: 3, Items: []int{8, 9, 10}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			cl := NewCircularList[int](tc.MaxLen)
			for _, v := range tc.Pushes {
				cl.Push(v)
			}
			items := make([]int, cl.Length())
			for i := range items {
				items[i] = cl.Get(i)
			}
			got := Expectation{Length: cl.Length(), Items: items}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestCircularListTrimEvent(t *testing.T) {
	type Expectation struct {
		TrimCounts []int
	}

	cl := NewCircularList[int](3)
	var trimCounts []int
	cl.OnTrimEmitter.Event(func(count int) {
		trimCounts = append(trimCounts, count)
	})
	cl.Push(1)
	cl.Push(2)
	cl.Push(3)
	cl.Push(4) // triggers trim of 1
	cl.Push(5) // triggers trim of 1

	got := Expectation{TrimCounts: trimCounts}
	expected := Expectation{TrimCounts: []int{1, 1}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCircularListPop(t *testing.T) {
	type Expectation struct {
		Popped int
		Length int
	}

	cl := NewCircularList[string](5)
	cl.Push("a")
	cl.Push("b")
	cl.Push("c")
	popped := cl.Pop()

	got := Expectation{Popped: len(popped), Length: cl.Length()}
	// "c" has length 1
	expected := Expectation{Popped: 1, Length: 2}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCircularListSet(t *testing.T) {
	type Expectation struct {
		Items []int
	}

	cl := NewCircularList[int](5)
	cl.Push(10)
	cl.Push(20)
	cl.Set(1, 99)

	got := Expectation{Items: []int{cl.Get(0), cl.Get(1)}}
	expected := Expectation{Items: []int{10, 99}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCircularListSetMaxLength(t *testing.T) {
	type Expectation struct {
		Length int
		MaxLen int
		Items  []int
	}
	type TestCase struct {
		Name       string
		InitPushes []int
		NewMaxLen  int
		Expected   Expectation
	}
	tests := []TestCase{
		{
			Name:       "shrink",
			InitPushes: []int{0, 1, 2, 3, 4}, NewMaxLen: 3,
			Expected: Expectation{Length: 3, MaxLen: 3, Items: []int{0, 1, 2}},
		},
		{
			Name:       "grow",
			InitPushes: []int{0, 1, 2}, NewMaxLen: 10,
			Expected: Expectation{Length: 3, MaxLen: 10, Items: []int{0, 1, 2}},
		},
		{
			Name:       "no change",
			InitPushes: []int{1}, NewMaxLen: 5,
			Expected: Expectation{Length: 1, MaxLen: 5, Items: []int{1}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			cl := NewCircularList[int](5)
			for _, v := range tc.InitPushes {
				cl.Push(v)
			}
			cl.SetMaxLength(tc.NewMaxLen)
			items := make([]int, cl.Length())
			for i := range items {
				items[i] = cl.Get(i)
			}
			got := Expectation{Length: cl.Length(), MaxLen: cl.MaxLength(), Items: items}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestCircularListSetLength(t *testing.T) {
	type Expectation struct {
		Length int
		Slot3  int
	}

	cl := NewCircularList[int](10)
	cl.Push(1)
	cl.Push(2)
	cl.SetLength(5)

	got := Expectation{Length: cl.Length(), Slot3: cl.Get(3)}
	expected := Expectation{Length: 5, Slot3: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCircularListSpliceDelete(t *testing.T) {
	type Expectation struct {
		Length  int
		Items   []int
		Deleted []DeleteEvent
	}

	cl := NewCircularList[int](10)
	for i := range 5 {
		cl.Push(i)
	}
	var deleted []DeleteEvent
	cl.OnDeleteEmitter.Event(func(e DeleteEvent) {
		deleted = append(deleted, e)
	})
	cl.Splice(1, 2) // delete [1,2] → [0, 3, 4]

	items := make([]int, cl.Length())
	for i := range items {
		items[i] = cl.Get(i)
	}
	got := Expectation{Length: cl.Length(), Items: items, Deleted: deleted}
	expected := Expectation{
		Length: 3, Items: []int{0, 3, 4},
		Deleted: []DeleteEvent{{Index: 1, Amount: 2}},
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCircularListSpliceInsert(t *testing.T) {
	type Expectation struct {
		Length   int
		Items    []int
		Inserted []InsertEvent
	}

	cl := NewCircularList[int](10)
	cl.Push(1)
	cl.Push(2)
	cl.Push(3)
	var inserted []InsertEvent
	cl.OnInsertEmitter.Event(func(e InsertEvent) {
		inserted = append(inserted, e)
	})
	cl.Splice(1, 0, 10, 20) // [1, 10, 20, 2, 3]

	items := make([]int, cl.Length())
	for i := range items {
		items[i] = cl.Get(i)
	}
	got := Expectation{Length: cl.Length(), Items: items, Inserted: inserted}
	expected := Expectation{
		Length: 5, Items: []int{1, 10, 20, 2, 3},
		Inserted: []InsertEvent{{Index: 1, Amount: 2}},
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCircularListSpliceInsertOverflow(t *testing.T) {
	type Expectation struct {
		Length    int
		TrimTotal int
	}

	cl := NewCircularList[int](5)
	for i := range 4 {
		cl.Push(i)
	}
	trimTotal := 0
	cl.OnTrimEmitter.Event(func(count int) {
		trimTotal += count
	})
	cl.Splice(2, 0, 10, 20, 30) // 4+3=7 > 5

	got := Expectation{Length: cl.Length(), TrimTotal: trimTotal}
	expected := Expectation{Length: 5, TrimTotal: 2}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCircularListTrimStart(t *testing.T) {
	type Expectation struct {
		Length    int
		First     int
		TrimTotal int
	}
	type TestCase struct {
		Name     string
		Count    int
		Expected Expectation
	}
	tests := []TestCase{
		{"trim 2", 2, Expectation{Length: 3, First: 2, TrimTotal: 2}},
		{"trim exceeds length", 100, Expectation{Length: 0, First: 0, TrimTotal: 5}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			cl := NewCircularList[int](10)
			for i := range 5 {
				cl.Push(i)
			}
			trimTotal := 0
			cl.OnTrimEmitter.Event(func(count int) {
				trimTotal += count
			})
			cl.TrimStart(tc.Count)
			first := 0
			if cl.Length() > 0 {
				first = cl.Get(0)
			}
			got := Expectation{Length: cl.Length(), First: first, TrimTotal: trimTotal}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestCircularListShiftElements(t *testing.T) {
	type Expectation struct {
		Items []int
	}
	type TestCase struct {
		Name     string
		Start    int
		Count    int
		Offset   int
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:  "shift forward",
			Start: 1, Count: 3, Offset: 2,
			// [0,1,2,3,4] → indices 3,4,5 get values 1,2,3
			Expected: Expectation{Items: []int{0, 1, 2, 1, 2, 3}},
		},
		{
			Name:  "shift backward",
			Start: 2, Count: 3, Offset: -1,
			// [0,1,2,3,4] → [0,2,3,4,4]
			Expected: Expectation{Items: []int{0, 2, 3, 4, 4}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			cl := NewCircularList[int](10)
			for i := range 5 {
				cl.Push(i)
			}
			cl.ShiftElements(tc.Start, tc.Count, tc.Offset)
			items := make([]int, cl.Length())
			for i := range items {
				items[i] = cl.Get(i)
			}
			got := Expectation{Items: items}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestCircularListShiftElementsZeroCount(t *testing.T) {
	type Expectation struct {
		Items []int
	}

	cl := NewCircularList[int](10)
	cl.Push(1)
	cl.Push(2)
	cl.ShiftElements(0, 0, 1) // no-op

	got := Expectation{Items: []int{cl.Get(0), cl.Get(1)}}
	expected := Expectation{Items: []int{1, 2}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCircularListShiftElementsPanics(t *testing.T) {
	type Expectation struct {
		Panicked bool
	}
	type TestCase struct {
		Name     string
		Start    int
		Count    int
		Offset   int
		Expected Expectation
	}
	tests := []TestCase{
		{"start negative", -1, 1, 0, Expectation{true}},
		{"start >= length", 5, 1, 0, Expectation{true}},
		{"shift beyond 0", 0, 1, -1, Expectation{true}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			cl := NewCircularList[int](10)
			cl.Push(1)
			cl.Push(2)
			panicked := false
			func() {
				defer func() {
					if r := recover(); r != nil {
						panicked = true
					}
				}()
				cl.ShiftElements(tc.Start, tc.Count, tc.Offset)
			}()
			got := Expectation{Panicked: panicked}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestCircularListRecycle(t *testing.T) {
	type Expectation struct {
		Recycled  int
		TrimCount int
	}

	cl := NewCircularList[int](3)
	cl.Push(1)
	cl.Push(2)
	cl.Push(3)
	trimCount := 0
	cl.OnTrimEmitter.Event(func(count int) {
		trimCount += count
	})
	recycled := cl.Recycle()

	got := Expectation{Recycled: recycled, TrimCount: trimCount}
	expected := Expectation{Recycled: 1, TrimCount: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCircularListRecyclePanicsWhenNotFull(t *testing.T) {
	type Expectation struct {
		Panicked bool
	}

	cl := NewCircularList[int](5)
	cl.Push(1)
	panicked := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				panicked = true
			}
		}()
		cl.Recycle()
	}()

	got := Expectation{Panicked: panicked}
	expected := Expectation{Panicked: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCircularListIsFull(t *testing.T) {
	type Expectation struct {
		IsFull bool
	}
	type TestCase struct {
		Name     string
		Pushes   int
		Expected Expectation
	}
	tests := []TestCase{
		{"empty", 0, Expectation{false}},
		{"partial", 2, Expectation{false}},
		{"full", 3, Expectation{true}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			cl := NewCircularList[int](3)
			for i := range tc.Pushes {
				cl.Push(i)
			}
			got := Expectation{IsFull: cl.IsFull()}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestCircularListDispose(t *testing.T) {
	type Expectation struct {
		EventFired bool
	}

	cl := NewCircularList[int](3)
	fired := false
	cl.OnTrimEmitter.Event(func(int) { fired = true })
	cl.Dispose()
	cl.Push(1)
	cl.Push(2)
	cl.Push(3)
	cl.Push(4) // would normally fire trim

	got := Expectation{EventFired: fired}
	expected := Expectation{EventFired: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCircularListShiftForwardWithTrim(t *testing.T) {
	type Expectation struct {
		Length    int
		TrimTotal int
	}

	cl := NewCircularList[int](5)
	for i := range 5 {
		cl.Push(i)
	}
	trimTotal := 0
	cl.OnTrimEmitter.Event(func(count int) {
		trimTotal += count
	})
	// Shift elements forward past maxLen to trigger trim
	cl.ShiftElements(0, 5, 2)

	got := Expectation{Length: cl.Length(), TrimTotal: trimTotal}
	expected := Expectation{Length: 5, TrimTotal: 2}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
