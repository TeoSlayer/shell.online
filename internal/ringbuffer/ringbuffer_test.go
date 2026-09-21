package ringbuffer

import (
	"bytes"
	"testing"
)

// Each snapshot test writes one synthetic stream into a buffer whose capacity
// is exactly the length of the retained tail, so the ring wrap lands at a
// known point inside a known sequence.

func TestBufferRetainsNewestBytes(t *testing.T) {
	buffer := New(5)
	_, _ = buffer.Write([]byte("abc"))
	_, _ = buffer.Write([]byte("defg"))
	if got := string(buffer.Bytes()); got != "cdefg" {
		t.Fatalf("Bytes() = %q, want %q", got, "cdefg")
	}
}

func TestLargeWriteIsTruncatedFromTheFront(t *testing.T) {
	buffer := New(4)
	_, _ = buffer.Write([]byte("abcdefgh"))
	if got := string(buffer.Bytes()); got != "efgh" {
		t.Fatalf("Bytes() = %q, want %q", got, "efgh")
	}
}

func TestSnapshotDropsSplitCsiHead(t *testing.T) {
	// Wrap inside ESC[1;23H: the raw head is the CSI tail ";23H".
	stream := []byte("ab\x1b[1;23H\x1b[2J")
	tail := []byte(";23H\x1b[2J")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "\x1b[2J" {
		t.Fatalf("Snapshot() = %q, want %q", got, "\x1b[2J")
	}
}

// Control: the same digit-shaped head in ground state is real text and must
// be preserved.
func TestSnapshotKeepsDigitTextInGroundState(t *testing.T) {
	stream := []byte("xy23m rest")
	tail := []byte("23m rest")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if !bytes.Equal(buffer.Snapshot(), tail) {
		t.Fatalf("Snapshot() = %q, want %q (ground-state text preserved)", buffer.Snapshot(), tail)
	}
}

func TestSnapshotKeepsUnwrappedHead(t *testing.T) {
	stream := []byte("23 files found\n\x1b[2J")
	tail := stream
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Snapshot(), tail) {
		t.Fatalf("Snapshot() = %q, want the unwrapped stream unchanged", buffer.Snapshot())
	}
}

func TestSnapshotDropsSplitOscHead(t *testing.T) {
	// Wrap inside an OSC title: the raw head is the payload tail to the BEL.
	stream := []byte("ab\x1b]0;title\x07next")
	tail := []byte("title\x07next")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "next" {
		t.Fatalf("Snapshot() = %q, want %q", got, "next")
	}
}

func TestSnapshotDropsSplitOscStHead(t *testing.T) {
	// Wrap inside a hyperlink OSC; the retained head ends the OSC at ST.
	stream := []byte("ab\x1b]8;;u\x1b\\x rest")
	tail := []byte(";u\x1b\\x rest")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "x rest" {
		t.Fatalf("Snapshot() = %q, want %q", got, "x rest")
	}
}

func TestSnapshotDropsSplitTwoByteEscapeHead(t *testing.T) {
	// Wrap between ESC and M (DEC line insert): the raw head is "M".
	stream := []byte("ab\x1bMc")
	tail := []byte("Mc")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "c" {
		t.Fatalf("Snapshot() = %q, want %q", got, "c")
	}
}

func TestSnapshotDropsSplitUtf8Head(t *testing.T) {
	// Wrap between the lead and continuation bytes of é.
	stream := []byte("abé\x1b[2J")
	tail := []byte("\xa9\x1b[2J")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "\x1b[2J" {
		t.Fatalf("Snapshot() = %q, want %q", got, "\x1b[2J")
	}
}

func TestSnapshotDropsSplitDcsHead(t *testing.T) {
	// Wrap inside a DCS string; the retained head ends the DCS at ST.
	stream := []byte("ab\x1bPq;data\x1b\\rest")
	tail := []byte("data\x1b\\rest")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "rest" {
		t.Fatalf("Snapshot() = %q, want %q", got, "rest")
	}
}

// Only the ESC of a CSI is evicted: the scan must consume the complete CSI,
// not just the "[", or "31m" leaks as literal text.
func TestSnapshotDropsSplitCsiAfterEscEviction(t *testing.T) {
	stream := []byte("ab\x1b[31mTEXT")
	tail := []byte("[31mTEXT")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "TEXT" {
		t.Fatalf("Snapshot() = %q, want %q", got, "TEXT")
	}
}

// The ESC of an ST terminator is evicted: the retained backslash completes
// the ST and the following text is ground state.
func TestSnapshotKeepsTextAfterSplitSt(t *testing.T) {
	stream := []byte("ab\x1b]0;t\x1b\\TEXT")
	tail := []byte("\\TEXT")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "TEXT" {
		t.Fatalf("Snapshot() = %q, want %q", got, "TEXT")
	}
}

func TestSnapshotKeepsTextAfterSplitDcsSt(t *testing.T) {
	stream := []byte("ab\x1bPq;d\x1b\\TEXT")
	tail := []byte("\\TEXT")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "TEXT" {
		t.Fatalf("Snapshot() = %q, want %q", got, "TEXT")
	}
}

// CAN cancels an in-flight CSI, as a real terminal does: the "m" after the
// cancellation is ground-state text.
func TestSnapshotCanCancelsCsi(t *testing.T) {
	stream := []byte("ab\x1b[31\x18mTEXT")
	tail := []byte("mTEXT")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if !bytes.Equal(buffer.Snapshot(), tail) {
		t.Fatalf("Snapshot() = %q, want %q (CAN cancelled the CSI)", buffer.Snapshot(), tail)
	}
}

func TestSnapshotSubCancelsCsi(t *testing.T) {
	stream := []byte("ab\x1b[31\x1amTEXT")
	tail := []byte("mTEXT")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Snapshot(), tail) {
		t.Fatalf("Snapshot() = %q, want %q (SUB cancelled the CSI)", buffer.Snapshot(), tail)
	}
}

// CAN cancels an in-flight OSC too.
func TestSnapshotCanCancelsOsc(t *testing.T) {
	stream := []byte("ab\x1b]0;ti\x18TEXT")
	tail := []byte("TEXT")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if !bytes.Equal(buffer.Snapshot(), tail) {
		t.Fatalf("Snapshot() = %q, want %q (CAN cancelled the OSC)", buffer.Snapshot(), tail)
	}
}

// An ESC inside a CSI interrupts it and starts a new sequence.
func TestSnapshotEscInterruptsCsi(t *testing.T) {
	stream := []byte("ab\x1b[31\x1b[2Jx")
	tail := []byte("[2Jx")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "x" {
		t.Fatalf("Snapshot() = %q, want %q", got, "x")
	}
}

// An ESC inside a control string interrupts it (not only as ST).
func TestSnapshotEscInterruptsOsc(t *testing.T) {
	stream := []byte("ab\x1b]0;ti\x1b[2Jx")
	tail := []byte("\x1b[2Jx")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "x" {
		t.Fatalf("Snapshot() = %q, want %q", got, "x")
	}
}

// Escape intermediates span 0x20..0x2f, not only the charset selectors:
// after "ESC SP" the next byte still belongs to the escape.
func TestSnapshotEscIntermediateRange(t *testing.T) {
	stream := []byte("ab\x1b\x20A\x1b[2Jx")
	tail := []byte("A\x1b[2Jx")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "\x1b[2Jx" {
		t.Fatalf("Snapshot() = %q, want %q", got, "\x1b[2Jx")
	}
}

// C0 executable controls do not complete an escape: BEL after ESC leaves the
// parser in the escape state, so "M" is still the escape's final byte.
func TestSnapshotExecutableDoesNotEndEscape(t *testing.T) {
	stream := []byte("ab\x1b\x07Mc")
	tail := []byte("Mc")
	buffer := New(len(tail))
	_, _ = buffer.Write(stream)
	if !bytes.Equal(buffer.Bytes(), tail) {
		t.Fatalf("Bytes() = %q, want %q", buffer.Bytes(), tail)
	}
	if got := string(buffer.Snapshot()); got != "c" {
		t.Fatalf("Snapshot() = %q, want %q", got, "c")
	}
}

// The head state must track evictions across many wraps, so the final head is
// resolved against the sequence that actually split it, not a stale one.
func TestSnapshotHeadStateSurvivesManyWraps(t *testing.T) {
	buffer := New(64)
	iteration := []byte("\x1b[1;1H\x1b[1mtext\x1b[0m")
	if len(iteration) != 18 {
		t.Fatalf("test stream changed: iteration is %d bytes", len(iteration))
	}
	stream := make([]byte, 0, 512*len(iteration))
	for i := 0; i < 512; i++ {
		stream = append(stream, iteration...)
	}
	// Write in 40-byte chunks (not a multiple of 18) so intermediate wraps
	// land at varied points.
	for len(stream) > 0 {
		end := 40
		if end > len(stream) {
			end = len(stream)
		}
		_, _ = buffer.Write(stream[:end])
		stream = stream[end:]
	}
	raw := buffer.Bytes()
	if !bytes.HasPrefix(raw, []byte("1m")) {
		t.Fatalf("test stream changed: raw head %q does not start mid-CSI", raw[:8])
	}
	safe := buffer.Snapshot()
	// The CSI "\x1b[1m" split at the head completes at "m": exactly "1m" is
	// dropped and ground-state text is preserved from there.
	if !bytes.Equal(safe, raw[2:]) {
		t.Fatalf("Snapshot() head diverged from raw[2:]")
	}
}
