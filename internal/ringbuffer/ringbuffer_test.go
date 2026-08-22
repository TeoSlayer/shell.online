package ringbuffer

import "testing"

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
