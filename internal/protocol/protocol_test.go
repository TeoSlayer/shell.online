package protocol

import (
	"encoding/binary"
	"testing"
)

func TestDecodeResize(t *testing.T) {
	frame := make([]byte, 5)
	frame[0] = Resize
	binary.BigEndian.PutUint16(frame[1:3], 132)
	binary.BigEndian.PutUint16(frame[3:5], 43)

	cols, rows, ok := DecodeResize(frame)
	if !ok || cols != 132 || rows != 43 {
		t.Fatalf("DecodeResize() = (%d, %d, %v)", cols, rows, ok)
	}
}

func TestDecodeResizeRejectsInvalidDimensions(t *testing.T) {
	frame := []byte{Resize, 0, 1, 0, 1}
	if _, _, ok := DecodeResize(frame); ok {
		t.Fatal("DecodeResize accepted invalid dimensions")
	}
}
