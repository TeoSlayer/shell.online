package xterm

// Ported from xterm.js src/common/input/TextDecoder.ts.
// Simplified for Go: Go strings are UTF-8 natively, so we use unicode/utf8.

import "unicode/utf8"

// Utf8ToUtf32 is a streaming UTF-8 to UTF-32 decoder.
// It handles partial multi-byte sequences across chunk boundaries.
type Utf8ToUtf32 struct {
	interim [3]byte
	count   int // number of bytes stored in interim
}

// Clear resets the decoder state, discarding any partial sequence.
func (d *Utf8ToUtf32) Clear() {
	d.interim = [3]byte{}
	d.count = 0
}

// Decode decodes UTF-8 bytes from input into UTF-32 codepoints in target.
// Returns the number of codepoints written to target.
// Handles streaming: partial multi-byte sequences are buffered for the next call.
// Invalid sequences and surrogates are silently skipped. BOM (U+FEFF) is skipped.
func (d *Utf8ToUtf32) Decode(input []byte, target []uint32) int {
	length := len(input)
	if length == 0 {
		return 0
	}

	size := 0
	startPos := 0

	// Handle leftover bytes from previous call.
	if d.count > 0 {
		// Reconstruct partial sequence: interim bytes + new input bytes.
		needed := utf8SeqLen(d.interim[0]) - d.count
		if needed <= 0 {
			// Invalid state, discard.
			d.count = 0
		} else {
			// Collect continuation bytes from input.
			buf := make([]byte, 0, 4)
			for i := range d.count {
				buf = append(buf, d.interim[i])
			}
			discardInterim := false
			for range needed {
				if startPos >= length {
					// Not enough input yet, save what we have.
					copy(d.interim[:], buf)
					d.count = len(buf)
					return 0
				}
				b := input[startPos]
				startPos++
				if b&0xC0 != 0x80 {
					// Bad continuation byte, discard interim.
					startPos--
					discardInterim = true
					break
				}
				buf = append(buf, b)
			}
			if !discardInterim {
				r, _ := utf8.DecodeRune(buf)
				if r != utf8.RuneError && r != 0xFEFF {
					target[size] = uint32(r)
					size++
				}
			}
			d.count = 0
			d.interim = [3]byte{}
		}
	}

	// Main decode loop.
	for i := startPos; i < length; {
		b := input[i]

		// ASCII fast path.
		if b < 0x80 {
			target[size] = uint32(b)
			size++
			i++
			continue
		}

		// Determine sequence length.
		seqLen := utf8SeqLen(b)
		if seqLen == 0 {
			// Invalid start byte, skip.
			i++
			continue
		}

		// Check if we have enough bytes.
		if i+seqLen > length {
			// Partial sequence at end of input — save to interim.
			d.count = length - i
			for j := 0; j < d.count && j < 3; j++ {
				d.interim[j] = input[i+j]
			}
			return size
		}

		r, n := utf8.DecodeRune(input[i:])
		if r == utf8.RuneError && n <= 1 {
			// Invalid byte.
			i++
			continue
		}
		i += n

		// Skip BOM and surrogates.
		if r == 0xFEFF {
			continue
		}
		if r >= 0xD800 && r <= 0xDFFF {
			continue
		}

		target[size] = uint32(r)
		size++
	}

	return size
}

// utf8SeqLen returns the expected byte length of a UTF-8 sequence given its first byte.
// Returns 0 for invalid start bytes.
func utf8SeqLen(b byte) int {
	if b < 0x80 {
		return 1
	}
	if b&0xE0 == 0xC0 {
		return 2
	}
	if b&0xF0 == 0xE0 {
		return 3
	}
	if b&0xF8 == 0xF0 {
		return 4
	}
	return 0
}

// StringToUtf32 decodes a Go string (UTF-8) into UTF-32 codepoints.
// This is simpler than the JS version since Go strings are UTF-8, not UTF-16.
func StringToUtf32(s string, target []uint32) int {
	size := 0
	for _, r := range s {
		if r == 0xFEFF {
			continue
		}
		target[size] = uint32(r)
		size++
	}
	return size
}

// Utf32ToString converts UTF-32 codepoints back to a Go string.
func Utf32ToString(data []uint32, start, end int) string {
	runes := make([]rune, 0, end-start)
	for i := start; i < end; i++ {
		runes = append(runes, rune(data[i]))
	}
	return string(runes)
}
