package xterm

// Ported from xterm.js src/common/CircularList.ts.

import "fmt"

// CircularList is a generic circular buffer with a fixed maximum size.
// When Push is called on a full list, the oldest element is overwritten
// and the OnTrim event fires.
type CircularList[T any] struct {
	array    []T
	startIdx int
	length   int
	maxLen   int

	OnDeleteEmitter EventEmitter[DeleteEvent]
	OnInsertEmitter EventEmitter[InsertEvent]
	OnTrimEmitter   EventEmitter[int]
}

// NewCircularList creates a CircularList with the given maximum length.
func NewCircularList[T any](maxLength int) *CircularList[T] {
	return &CircularList[T]{
		array:  make([]T, maxLength),
		maxLen: maxLength,
	}
}

// Length returns the number of elements in the list.
func (cl *CircularList[T]) Length() int {
	return cl.length
}

// SetLength sets the logical length. If growing, new slots contain zero values.
func (cl *CircularList[T]) SetLength(newLength int) {
	if newLength > cl.length {
		var zero T
		for i := cl.length; i < newLength; i++ {
			cl.array[cl.getCyclicIndex(i)] = zero
		}
	}
	cl.length = newLength
}

// MaxLength returns the maximum capacity.
func (cl *CircularList[T]) MaxLength() int {
	return cl.maxLen
}

// SetMaxLength resizes the backing array, preserving existing elements.
func (cl *CircularList[T]) SetMaxLength(newMaxLength int) {
	if cl.maxLen == newMaxLength {
		return
	}
	newArray := make([]T, newMaxLength)
	copyLen := cl.length
	if newMaxLength < copyLen {
		copyLen = newMaxLength
	}
	for i := range copyLen {
		newArray[i] = cl.array[cl.getCyclicIndex(i)]
	}
	cl.array = newArray
	cl.maxLen = newMaxLength
	cl.startIdx = 0
	if cl.length > newMaxLength {
		cl.length = newMaxLength
	}
}

// IsFull returns true if the list is at maximum capacity.
func (cl *CircularList[T]) IsFull() bool {
	return cl.length == cl.maxLen
}

// Get returns the element at the given logical index.
// No bounds checking for performance (matches xterm.js).
func (cl *CircularList[T]) Get(index int) T {
	return cl.array[cl.getCyclicIndex(index)]
}

// Set sets the element at the given logical index.
func (cl *CircularList[T]) Set(index int, value T) {
	cl.array[cl.getCyclicIndex(index)] = value
}

// Push appends a value. If the list is full, the oldest element is overwritten
// and OnTrim fires with count=1.
func (cl *CircularList[T]) Push(value T) {
	cl.array[cl.getCyclicIndex(cl.length)] = value
	if cl.length == cl.maxLen {
		cl.startIdx = (cl.startIdx + 1) % cl.maxLen
		cl.OnTrimEmitter.Fire(1)
	} else {
		cl.length++
	}
}

// Recycle advances the ring buffer and returns the current tail element for reuse.
// The buffer must be full or this panics.
func (cl *CircularList[T]) Recycle() T {
	if cl.length != cl.maxLen {
		panic(fmt.Sprintf("CircularList.Recycle: buffer not full (length=%d, maxLen=%d)", cl.length, cl.maxLen))
	}
	cl.startIdx = (cl.startIdx + 1) % cl.maxLen
	cl.OnTrimEmitter.Fire(1)
	return cl.array[cl.getCyclicIndex(cl.length-1)]
}

// Pop removes and returns the last element.
func (cl *CircularList[T]) Pop() T {
	cl.length--
	return cl.array[cl.getCyclicIndex(cl.length)]
}

// Splice deletes deleteCount elements starting at start, then inserts items at that position.
func (cl *CircularList[T]) Splice(start, deleteCount int, items ...T) {
	// Delete
	if deleteCount > 0 {
		for i := start; i < cl.length-deleteCount; i++ {
			cl.array[cl.getCyclicIndex(i)] = cl.array[cl.getCyclicIndex(i+deleteCount)]
		}
		cl.length -= deleteCount
		cl.OnDeleteEmitter.Fire(DeleteEvent{Index: start, Amount: deleteCount})
	}

	// Insert
	if len(items) > 0 {
		// Shift existing elements right to make room
		for i := cl.length - 1; i >= start; i-- {
			cl.array[cl.getCyclicIndex(i+len(items))] = cl.array[cl.getCyclicIndex(i)]
		}
		for i, item := range items {
			cl.array[cl.getCyclicIndex(start+i)] = item
		}
		cl.OnInsertEmitter.Fire(InsertEvent{Index: start, Amount: len(items)})
	}

	// Adjust length, trimming if over capacity
	if cl.length+len(items) > cl.maxLen {
		countToTrim := (cl.length + len(items)) - cl.maxLen
		cl.startIdx += countToTrim
		cl.length = cl.maxLen
		cl.OnTrimEmitter.Fire(countToTrim)
	} else {
		cl.length += len(items)
	}
}

// TrimStart removes count elements from the beginning of the list.
func (cl *CircularList[T]) TrimStart(count int) {
	if count > cl.length {
		count = cl.length
	}
	cl.startIdx += count
	cl.length -= count
	cl.OnTrimEmitter.Fire(count)
}

// ShiftElements shifts count elements starting at start by offset positions.
func (cl *CircularList[T]) ShiftElements(start, count, offset int) {
	if count <= 0 {
		return
	}
	if start < 0 || start >= cl.length {
		panic(fmt.Sprintf("CircularList.ShiftElements: start %d out of range [0, %d)", start, cl.length))
	}
	if start+offset < 0 {
		panic("CircularList.ShiftElements: cannot shift elements beyond index 0")
	}

	if offset > 0 {
		for i := count - 1; i >= 0; i-- {
			cl.Set(start+i+offset, cl.Get(start+i))
		}
		expandBy := (start + count + offset) - cl.length
		if expandBy > 0 {
			cl.length += expandBy
			for cl.length > cl.maxLen {
				cl.length--
				cl.startIdx++
				cl.OnTrimEmitter.Fire(1)
			}
		}
	} else {
		for i := range count {
			cl.Set(start+i+offset, cl.Get(start+i))
		}
	}
}

// Dispose cleans up event emitters.
func (cl *CircularList[T]) Dispose() {
	cl.OnDeleteEmitter.Dispose()
	cl.OnInsertEmitter.Dispose()
	cl.OnTrimEmitter.Dispose()
}

func (cl *CircularList[T]) getCyclicIndex(index int) int {
	return (cl.startIdx + index) % cl.maxLen
}
