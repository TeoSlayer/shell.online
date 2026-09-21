package xterm

// Ported from xterm.js src/common/Event.ts.
// Synchronous, callback-based event system. No channels.

// EventEmitter is a synchronous event emitter.
// Listeners are called in registration order when Fire is called.
type EventEmitter[T any] struct {
	listeners []*eventEntry[T]
	disposed  bool
}

type eventEntry[T any] struct {
	fn      func(T)
	removed bool
}

// Fire invokes all registered listeners synchronously with the given value.
// Listeners that unsubscribe during iteration are handled safely via snapshot.
func (e *EventEmitter[T]) Fire(value T) {
	if e.disposed {
		return
	}
	n := len(e.listeners)
	switch n {
	case 0:
		return
	case 1:
		if !e.listeners[0].removed {
			e.listeners[0].fn(value)
		}
	default:
		// Snapshot to allow modifications during iteration.
		snapshot := make([]*eventEntry[T], n)
		copy(snapshot, e.listeners)
		for _, entry := range snapshot {
			if !entry.removed {
				entry.fn(value)
			}
		}
	}
}

// Event registers a listener and returns a Disposable that removes it.
func (e *EventEmitter[T]) Event(listener func(T)) Disposable {
	if e.disposed {
		return nopDisposable
	}
	entry := &eventEntry[T]{fn: listener}
	e.listeners = append(e.listeners, entry)
	return toDisposable(func() {
		entry.removed = true
		for i, l := range e.listeners {
			if l == entry {
				e.listeners = append(e.listeners[:i], e.listeners[i+1:]...)
				break
			}
		}
	})
}

// Dispose removes all listeners and prevents future subscriptions.
func (e *EventEmitter[T]) Dispose() {
	if e.disposed {
		return
	}
	e.disposed = true
	e.listeners = nil
}

// HasListeners returns true if there are any active listeners.
func (e *EventEmitter[T]) HasListeners() bool {
	return len(e.listeners) > 0
}
