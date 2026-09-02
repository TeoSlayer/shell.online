package protocol

import "encoding/binary"

const (
	Output            byte = 0x01
	Input             byte = 0x02
	Snapshot          byte = 0x03
	Resize            byte = 0x04
	FinalSnapshot     byte = 0x05
	Ping              byte = 0x06
	Pong              byte = 0x07
	BroadcastSnapshot byte = 0x08
	ConfirmedEOF      byte = 0x09
)

func Frame(opcode byte, payload []byte) []byte {
	frame := make([]byte, len(payload)+1)
	frame[0] = opcode
	copy(frame[1:], payload)
	return frame
}

func DecodeResize(frame []byte) (cols, rows uint16, ok bool) {
	if len(frame) != 5 || frame[0] != Resize {
		return 0, 0, false
	}
	cols = binary.BigEndian.Uint16(frame[1:3])
	rows = binary.BigEndian.Uint16(frame[3:5])
	if cols < 10 || cols > 500 || rows < 4 || rows > 300 {
		return 0, 0, false
	}
	return cols, rows, true
}
