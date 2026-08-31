package relay

import "testing"

func TestTrySendDoesNotBlockWhenQueueIsFull(t *testing.T) {
	connection := &Connection{outgoing: make(chan outgoingMessage, 1)}
	if !connection.TrySend(BinaryMessage, []byte("first")) {
		t.Fatal("TrySend rejected available queue capacity")
	}
	if connection.TrySend(BinaryMessage, []byte("second")) {
		t.Fatal("TrySend accepted a frame beyond bounded queue capacity")
	}
}
