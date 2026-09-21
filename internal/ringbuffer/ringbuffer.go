package ringbuffer

import "sync"

// Parser phases at the head of the retained window, following the VT500
// transition table the client parsers use (node_modules/@xterm/xterm/src/
// common/parser/EscapeSequenceParser.ts).
const (
	phaseGround = iota
	phaseEscape
	phaseEscIntermediate
	phaseCsi
	phaseOsc
	phaseString // DCS/SOS/PM/APC control string
)

const (
	bel = 0x07
	can = 0x18
	sub = 0x1a
	esc = 0x1b
)

type Buffer struct {
	mu       sync.RWMutex
	capacity int
	data     []byte
	// endOffset counts every byte ever written, so a consistent cut of the
	// retained window can be expressed as an absolute [Start, End) range even
	// after evictions.
	endOffset int64
	// The terminal parser state at data[0], advanced as bytes are evicted from
	// the front. It says whether the head sits mid-escape-sequence (and which
	// kind) and how many UTF-8 continuation bytes a split leading character
	// still owes. Snapshot uses it to drop exactly the incomplete head.
	headPhase byte
	headUtf8  int
	terminal  *terminalState
}

func New(capacity int) *Buffer {
	if capacity < 0 {
		capacity = 0
	}
	return &Buffer{capacity: capacity, data: make([]byte, 0, capacity)}
}

func (buffer *Buffer) Write(value []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()

	written := len(value)
	if buffer.terminal != nil {
		buffer.terminal.write(value)
	}
	buffer.endOffset += int64(written)
	if buffer.capacity == 0 {
		return written, nil
	}
	if len(value) >= buffer.capacity {
		// Everything retained so far, plus the front of value, is evicted.
		buffer.feedEvicted(buffer.data, value[:len(value)-buffer.capacity])
		buffer.data = append(buffer.data[:0], value[len(value)-buffer.capacity:]...)
		return written, nil
	}

	overflow := len(buffer.data) + len(value) - buffer.capacity
	if overflow > 0 {
		buffer.feedEvicted(buffer.data[:overflow])
		copy(buffer.data, buffer.data[overflow:])
		buffer.data = buffer.data[:len(buffer.data)-overflow]
	}
	buffer.data = append(buffer.data, value...)
	return written, nil
}

func (buffer *Buffer) Bytes() []byte {
	buffer.mu.RLock()
	defer buffer.mu.RUnlock()
	return append([]byte(nil), buffer.data...)
}

// View is one atomic cut of the retained window: the absolute offset range
// the raw bytes cover, plus the safe-snapshot trim computed for that same
// state. Bytes is a copy; the ring lock is held only for the copy.
type View struct {
	Start int64
	End   int64
	Bytes []byte
	Skip  int
	// Replay is a stateful screen snapshot when requested via SnapshotView.
	// Bytes and its offsets remain the original PTY stream for live deltas.
	Replay []byte
}

// SnapshotView captures both the replay state and raw stream offsets under
// one lock. Normal output flushes use View and do not serialize a screen.
func (buffer *Buffer) SnapshotView() View {
	// Serializers may populate cached cell attributes while reading. Exclude
	// other snapshot readers as well as writes for a consistent state cut.
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	data := append([]byte(nil), buffer.data...)
	view := View{Start: buffer.endOffset - int64(len(data)), End: buffer.endOffset, Bytes: data, Skip: buffer.skipHead(data)}
	if buffer.terminal != nil {
		view.Replay = buffer.terminal.snapshot()
	} else {
		// An empty screen is a valid snapshot, distinct from a stateful
		// snapshot that cannot yet be emitted (nil: partial-control overflow).
		view.Replay = append([]byte{}, data[view.Skip:]...)
	}
	return view
}

func (buffer *Buffer) View() View {
	buffer.mu.RLock()
	defer buffer.mu.RUnlock()
	bytes := append([]byte(nil), buffer.data...)
	return View{
		Start: buffer.endOffset - int64(len(buffer.data)),
		End:   buffer.endOffset,
		Bytes: bytes,
		Skip:  buffer.skipHead(bytes),
	}
}

// Snapshot returns terminal state for NewTerminal, or a parser-safe raw tail
// for New. A nil stateful replay means an oversized unfinished control string
// must complete before a safe snapshot can be sent. Bytes always retains its
// generic raw semantics; serialized bytes never advance the raw stream cut.
func (buffer *Buffer) Snapshot() []byte {
	return buffer.SnapshotView().Replay
}

func (buffer *Buffer) Len() int {
	buffer.mu.RLock()
	defer buffer.mu.RUnlock()
	return len(buffer.data)
}

// End reports the absolute offset one past the last byte ever written,
// without copying the retained window.
func (buffer *Buffer) End() int64 {
	buffer.mu.RLock()
	defer buffer.mu.RUnlock()
	return buffer.endOffset
}

// step is the single parser transition used both to track the head as bytes
// are evicted (feedByte) and to scan a retained head back to ground state
// (skipHead), so the two can never disagree about where a sequence ends. It
// follows the VT500/xterm.js transition table: CAN/SUB cancel a sequence in
// every state, ESC interrupts any sequence by starting a new one (this is
// how ST = ESC \ terminates control strings), C0 executable controls do not
// complete an escape, and escape intermediates span 0x20..0x2f. Bytes 0x80
// and above are not treated as C1 controls, since at byte level they are
// usually UTF-8 continuation bytes; they hold their phase.
func step(phase byte, b byte) byte {
	switch b {
	case can, sub:
		return phaseGround
	case esc:
		return phaseEscape
	}
	switch phase {
	case phaseGround:
		return phaseGround
	case phaseEscape:
		switch b {
		case '[':
			return phaseCsi
		case ']':
			return phaseOsc
		case 'P', 'X', '^', '_':
			return phaseString
		}
		switch {
		case b >= 0x20 && b <= 0x2f:
			return phaseEscIntermediate
		case b >= 0x30 && b <= 0x7e:
			return phaseGround
		default:
			return phaseEscape
		}
	case phaseEscIntermediate:
		if b >= 0x30 && b <= 0x7e {
			return phaseGround
		}
		return phaseEscIntermediate
	case phaseCsi:
		if b >= 0x40 && b <= 0x7e {
			return phaseGround
		}
		return phaseCsi
	case phaseOsc:
		if b == bel {
			return phaseGround
		}
		return phaseOsc
	case phaseString:
		return phaseString
	}
	return phaseGround
}

// feedEvicted advances the head state over bytes leaving the window, in
// stream order. Callers hold buffer.mu.
func (buffer *Buffer) feedEvicted(parts ...[]byte) {
	for _, part := range parts {
		for _, b := range part {
			buffer.feedByte(b)
		}
	}
}

func (buffer *Buffer) feedByte(b byte) {
	buffer.headPhase = step(buffer.headPhase, b)

	if buffer.headUtf8 > 0 {
		if b&0xC0 == 0x80 {
			buffer.headUtf8--
		} else {
			buffer.headUtf8 = 0
		}
	}
	if buffer.headUtf8 == 0 {
		switch {
		case b >= 0xC2 && b <= 0xDF:
			buffer.headUtf8 = 1
		case b >= 0xE0 && b <= 0xEF:
			buffer.headUtf8 = 2
		case b >= 0xF0 && b <= 0xF4:
			buffer.headUtf8 = 3
		}
	}
}

// skipHead returns the number of leading bytes that belong to an incomplete
// head: the continuation bytes of a split UTF-8 character, then the bytes of
// the split escape sequence, replayed through the same step transition until
// the parser is back in ground state. Callers hold at least buffer.mu.RLock.
func (buffer *Buffer) skipHead(data []byte) int {
	skip := 0
	for pending := buffer.headUtf8; pending > 0 && skip < len(data) && data[skip]&0xC0 == 0x80; pending-- {
		skip++
	}
	phase := buffer.headPhase
	if phase == phaseGround {
		return skip
	}
	for skip < len(data) {
		phase = step(phase, data[skip])
		skip++
		if phase == phaseGround {
			return skip
		}
	}
	return skip
}
