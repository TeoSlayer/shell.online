package protocol

import (
	"bytes"
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

func TestBroadcastSnapshotOpcode(t *testing.T) {
	if BroadcastSnapshot != 0x08 || BroadcastSnapshot == Snapshot {
		t.Fatalf("BroadcastSnapshot opcode = %#x", BroadcastSnapshot)
	}
}

func TestSendOpcodesAreDistinct(t *testing.T) {
	if Send != 0x0c || SendAck != 0x0d || Send == FileRequest || SendAck == FileResponse {
		t.Fatalf("Send=%#x SendAck=%#x", Send, SendAck)
	}
}

func testDispatchToken(seed byte) []byte {
	token := make([]byte, SendDispatchTokenBytes)
	for i := range token {
		token[i] = seed + byte(i)
	}
	return token
}

func TestEncodeDecodeSend(t *testing.T) {
	opID := "550e8400-e29b-41d4-a716-446655440000"
	token := testDispatchToken(1)
	text := []byte("hello world")
	for _, enter := range []bool{false, true} {
		op, gotEnter, gotToken, gotText, ok := DecodeSend(EncodeSend(opID, enter, token, text))
		if !ok || op != opID || gotEnter != enter || !bytes.Equal(gotToken, token) || string(gotText) != string(text) {
			t.Fatalf("DecodeSend(EncodeSend(%v)) = (%q, %v, %q, %q, %v)", enter, op, gotEnter, gotToken, gotText, ok)
		}
	}
}

func TestDecodeSendRejectsMalformed(t *testing.T) {
	opID := "550e8400-e29b-41d4-a716-446655440000"
	token := testDispatchToken(1)
	// wrong opcode
	if _, _, _, _, ok := DecodeSend(Frame(Input, []byte(opID))); ok {
		t.Fatal("DecodeSend accepted a non-Send opcode")
	}
	// short dispatch token (15 bytes, one byte of text)
	if _, _, _, _, ok := DecodeSend(Frame(Send, append(append(append([]byte(opID), 0), token[:15]...), 'x'))); ok {
		t.Fatal("DecodeSend accepted a short dispatch token")
	}
	// empty text (payload is just opID + enter byte + token, no text)
	if _, _, _, _, ok := DecodeSend(Frame(Send, append(append([]byte(opID), 0), token...))); ok {
		t.Fatal("DecodeSend accepted empty text")
	}
	// text over the cap
	tooLong := make([]byte, SendMaxTextBytes+1)
	if _, _, _, _, ok := DecodeSend(Frame(Send, append(append(append([]byte(opID), 0), token...), tooLong...))); ok {
		t.Fatal("DecodeSend accepted text over the cap")
	}
}

func TestEncodeDecodeSendAck(t *testing.T) {
	opID := "550e8400-e29b-41d4-a716-446655440000"
	token := testDispatchToken(2)
	for _, result := range []byte{SendResultDelivered, SendResultUncertain} {
		op, gotToken, gotResult, ok := DecodeSendAck(EncodeSendAck(opID, token, result))
		if !ok || op != opID || !bytes.Equal(gotToken, token) || gotResult != result {
			t.Fatalf("DecodeSendAck(EncodeSendAck(%d)) = (%q, %q, %d, %v)", result, op, gotToken, gotResult, ok)
		}
	}
	// wrong opcode
	if _, _, _, ok := DecodeSendAck(Frame(Send, []byte(opID))); ok {
		t.Fatal("DecodeSendAck accepted a non-SendAck opcode")
	}
	// short dispatch token (15 bytes) → wrong total length
	if _, _, _, ok := DecodeSendAck(Frame(SendAck, append(append([]byte(opID), token[:15]...), 0))); ok {
		t.Fatal("DecodeSendAck accepted a short dispatch token")
	}
	// long dispatch token (17 bytes) → wrong total length
	if _, _, _, ok := DecodeSendAck(Frame(SendAck, append(append([]byte(opID), make([]byte, 17)...), 0))); ok {
		t.Fatal("DecodeSendAck accepted a long dispatch token")
	}
}

// TestSendAckTokenNeedNotMatchSend proves the host only echoes the token verbatim: a
// well-formed Send and a well-formed SendAck carrying a DIFFERENT token are each valid
// frames on their own — correlation between them is the DO's job.
func TestSendAckTokenNeedNotMatchSend(t *testing.T) {
	opID := "550e8400-e29b-41d4-a716-446655440000"
	sendToken := testDispatchToken(1)
	ackToken := testDispatchToken(0xff)

	op, enter, gotSendToken, text, ok := DecodeSend(EncodeSend(opID, true, sendToken, []byte("x")))
	if !ok || op != opID || !enter || !bytes.Equal(gotSendToken, sendToken) || string(text) != "x" {
		t.Fatalf("DecodeSend(EncodeSend) = (%q, %v, %q, %q, %v)", op, enter, gotSendToken, text, ok)
	}
	ackOp, gotAckToken, result, ackOK := DecodeSendAck(EncodeSendAck(opID, ackToken, SendResultDelivered))
	if !ackOK || ackOp != opID || !bytes.Equal(gotAckToken, ackToken) || result != SendResultDelivered {
		t.Fatalf("DecodeSendAck(EncodeSendAck) = (%q, %q, %d, %v)", ackOp, gotAckToken, result, ackOK)
	}
	if bytes.Equal(sendToken, ackToken) {
		t.Fatal("test tokens must differ to prove independence")
	}
}
