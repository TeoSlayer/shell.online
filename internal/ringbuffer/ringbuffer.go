package ringbuffer

import "sync"

type Buffer struct {
	mu       sync.RWMutex
	capacity int
	data     []byte
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
	if buffer.capacity == 0 {
		return written, nil
	}
	if len(value) >= buffer.capacity {
		buffer.data = append(buffer.data[:0], value[len(value)-buffer.capacity:]...)
		return written, nil
	}

	overflow := len(buffer.data) + len(value) - buffer.capacity
	if overflow > 0 {
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

func (buffer *Buffer) Len() int {
	buffer.mu.RLock()
	defer buffer.mu.RUnlock()
	return len(buffer.data)
}
