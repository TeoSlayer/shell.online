package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestUtf8ToUtf32_ASCII(t *testing.T) {
	t.Parallel()
	d := &Utf8ToUtf32{}
	target := make([]uint32, 64)
	n := d.Decode([]byte("Hello"), target)

	type Expectation struct {
		N      int
		Values []uint32
	}
	got := Expectation{N: n, Values: target[:n]}
	want := Expectation{N: 5, Values: []uint32{'H', 'e', 'l', 'l', 'o'}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestUtf8ToUtf32_MultiByte(t *testing.T) {
	t.Parallel()
	d := &Utf8ToUtf32{}
	target := make([]uint32, 64)

	// U+00E9 (é) = 0xC3 0xA9 (2-byte)
	// U+4E16 (世) = 0xE4 0xB8 0x96 (3-byte)
	// U+1F600 (😀) = 0xF0 0x9F 0x98 0x80 (4-byte)
	input := []byte("é世\xF0\x9F\x98\x80") //nolint:gosmopolitan
	n := d.Decode(input, target)

	type Expectation struct {
		N      int
		Values []uint32
	}
	got := Expectation{N: n, Values: target[:n]}
	want := Expectation{N: 3, Values: []uint32{0xE9, 0x4E16, 0x1F600}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestUtf8ToUtf32_StreamingPartialSequence(t *testing.T) {
	t.Parallel()
	d := &Utf8ToUtf32{}
	target := make([]uint32, 64)

	// U+4E16 (世) = 0xE4 0xB8 0x96 — split across two calls
	n1 := d.Decode([]byte{0xE4}, target)
	if n1 != 0 {
		t.Fatalf("expected 0 codepoints from partial, got %d", n1)
	}

	n2 := d.Decode([]byte{0xB8, 0x96, 'A'}, target)

	type Expectation struct {
		N      int
		Values []uint32
	}
	got := Expectation{N: n2, Values: target[:n2]}
	want := Expectation{N: 2, Values: []uint32{0x4E16, 'A'}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestUtf8ToUtf32_StreamingFourByte(t *testing.T) {
	t.Parallel()
	d := &Utf8ToUtf32{}
	target := make([]uint32, 64)

	// U+1F600 = 0xF0 0x9F 0x98 0x80 — split: first 2 bytes, then last 2
	n1 := d.Decode([]byte{0xF0, 0x9F}, target)
	if n1 != 0 {
		t.Fatalf("expected 0 codepoints from partial 4-byte, got %d", n1)
	}

	n2 := d.Decode([]byte{0x98, 0x80}, target)

	type Expectation struct {
		N      int
		Values []uint32
	}
	got := Expectation{N: n2, Values: target[:n2]}
	want := Expectation{N: 1, Values: []uint32{0x1F600}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestUtf8ToUtf32_SkipsBOM(t *testing.T) {
	t.Parallel()
	d := &Utf8ToUtf32{}
	target := make([]uint32, 64)

	// BOM (U+FEFF) = 0xEF 0xBB 0xBF
	input := []byte{0xEF, 0xBB, 0xBF, 'A'}
	n := d.Decode(input, target)

	type Expectation struct {
		N      int
		Values []uint32
	}
	got := Expectation{N: n, Values: target[:n]}
	want := Expectation{N: 1, Values: []uint32{'A'}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestUtf8ToUtf32_InvalidContinuation(t *testing.T) {
	t.Parallel()
	d := &Utf8ToUtf32{}
	target := make([]uint32, 64)

	// 0xC3 followed by non-continuation 'A' — should skip the bad sequence
	input := []byte{0xC3, 'A', 'B'}
	n := d.Decode(input, target)

	// The decoder should recover and decode 'A' and 'B'
	if n < 2 {
		t.Fatalf("expected at least 2 codepoints, got %d", n)
	}
	// Last two should be A, B
	if target[n-2] != 'A' || target[n-1] != 'B' {
		t.Errorf("expected last two codepoints to be A, B, got %d, %d", target[n-2], target[n-1])
	}
}

func TestUtf8ToUtf32_Clear(t *testing.T) {
	t.Parallel()
	d := &Utf8ToUtf32{}
	target := make([]uint32, 64)

	// Start a partial sequence
	d.Decode([]byte{0xE4}, target)
	d.Clear()

	// After clear, should not try to complete the old sequence
	n := d.Decode([]byte{'X'}, target)

	type Expectation struct {
		N      int
		Values []uint32
	}
	got := Expectation{N: n, Values: target[:n]}
	want := Expectation{N: 1, Values: []uint32{'X'}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestUtf8ToUtf32_EmptyInput(t *testing.T) {
	t.Parallel()
	d := &Utf8ToUtf32{}
	target := make([]uint32, 64)
	n := d.Decode([]byte{}, target)
	if n != 0 {
		t.Errorf("expected 0, got %d", n)
	}
}

func TestStringToUtf32(t *testing.T) {
	t.Parallel()
	target := make([]uint32, 64)
	n := StringToUtf32("A世😀", target) //nolint:gosmopolitan

	type Expectation struct {
		N      int
		Values []uint32
	}
	got := Expectation{N: n, Values: target[:n]}
	want := Expectation{N: 3, Values: []uint32{'A', 0x4E16, 0x1F600}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestStringToUtf32_SkipsBOM(t *testing.T) {
	t.Parallel()
	target := make([]uint32, 64)
	n := StringToUtf32("\uFEFFHi", target)

	type Expectation struct {
		N      int
		Values []uint32
	}
	got := Expectation{N: n, Values: target[:n]}
	want := Expectation{N: 2, Values: []uint32{'H', 'i'}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestUtf32ToString(t *testing.T) {
	t.Parallel()
	data := []uint32{'H', 'i', 0x1F600}
	got := Utf32ToString(data, 0, 3)
	want := "Hi😀"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestUtf32ToString_SubRange(t *testing.T) {
	t.Parallel()
	data := []uint32{'A', 'B', 'C', 'D'}
	got := Utf32ToString(data, 1, 3)
	want := "BC"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
