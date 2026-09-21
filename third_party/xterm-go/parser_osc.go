package xterm

// Ported from xterm.js src/common/parser/OscParser.ts.
//
// OscParser handles Operating System Command sequences. It parses the numeric
// identifier, dispatches payload data to registered handlers, and manages
// handler lifecycle (start/put/end).

import "strings"

// utf32ToString converts a slice of uint32 codepoints to a Go string.
func utf32ToString(data []uint32, start, end int) string {
	var b strings.Builder
	for i := start; i < end; i++ {
		b.WriteRune(rune(data[i]))
	}
	return b.String()
}

// OscHandler is the interface for handlers that process OSC sequences.
// Intentionally separate from ApcHandler to mirror xterm.js type structure.
type OscHandler interface { //nolint:iface
	Start()
	Put(data []uint32, start, end int)
	End(success bool) bool
}

// OscFallbackHandler is called when no registered handler matches the OSC identifier.
type OscFallbackHandler func(ident int, action string, payload ...interface{})

// OscParser parses OSC sequences and dispatches to registered handlers.
type OscParser struct {
	state     OscState
	active    []OscHandler
	id        int
	handlers  map[int][]OscHandler
	handlerFb OscFallbackHandler
}

// NewOscParser creates a new OscParser.
func NewOscParser() *OscParser {
	return &OscParser{
		state:     OscStateStart,
		id:        -1,
		handlers:  make(map[int][]OscHandler),
		handlerFb: func(int, string, ...interface{}) {},
	}
}

// RegisterHandler registers a handler for the given OSC identifier.
// Returns a Disposable that removes the handler when disposed.
func (p *OscParser) RegisterHandler(ident int, handler OscHandler) Disposable {
	p.handlers[ident] = append(p.handlers[ident], handler)
	handlerList := p.handlers[ident]
	return toDisposable(func() {
		for i, h := range handlerList {
			if h == handler {
				p.handlers[ident] = append(handlerList[:i], handlerList[i+1:]...)
				return
			}
		}
	})
}

// ClearHandler removes all handlers for the given identifier.
func (p *OscParser) ClearHandler(ident int) {
	delete(p.handlers, ident)
}

// SetHandlerFallback sets the fallback handler called when no handler matches.
func (p *OscParser) SetHandlerFallback(handler OscFallbackHandler) {
	p.handlerFb = handler
}

// Dispose removes all handlers and resets state.
func (p *OscParser) Dispose() {
	p.handlers = make(map[int][]OscHandler)
	p.handlerFb = func(int, string, ...interface{}) {}
	p.active = nil
}

// Reset forces cleanup of active handlers and resets parser state.
func (p *OscParser) Reset() {
	if p.state == OscStatePayload {
		for j := len(p.active) - 1; j >= 0; j-- {
			p.active[j].End(false)
		}
	}
	p.active = nil
	p.id = -1
	p.state = OscStateStart
}

func (p *OscParser) start() {
	if handlers, ok := p.handlers[p.id]; ok && len(handlers) > 0 {
		p.active = handlers
		for j := len(p.active) - 1; j >= 0; j-- {
			p.active[j].Start()
		}
	} else {
		p.active = nil
		p.handlerFb(p.id, "START")
	}
}

func (p *OscParser) put(data []uint32, start, end int) {
	if len(p.active) == 0 {
		p.handlerFb(p.id, "PUT", utf32ToString(data, start, end))
	} else {
		for j := len(p.active) - 1; j >= 0; j-- {
			p.active[j].Put(data, start, end)
		}
	}
}

// Start begins a new OSC sequence, resetting any leftover state.
func (p *OscParser) Start() {
	p.Reset()
	p.state = OscStateID
}

// Put feeds data to the current OSC command. Parses the numeric identifier
// from the leading digits, then passes payload to handlers.
func (p *OscParser) Put(data []uint32, start, end int) {
	if p.state == OscStateAbort {
		return
	}
	if p.state == OscStateID {
		for start < end {
			code := data[start]
			start++
			if code == 0x3b { // ';'
				p.state = OscStatePayload
				p.start()
				break
			}
			if code < 0x30 || code > 0x39 {
				p.state = OscStateAbort
				return
			}
			if p.id == -1 {
				p.id = 0
			}
			p.id = p.id*10 + int(code) - 48
		}
	}
	if p.state == OscStatePayload && end-start > 0 {
		p.put(data, start, end)
	}
}

// End signals the end of an OSC sequence. success indicates whether the
// sequence terminated normally (ST/BEL) or was aborted.
func (p *OscParser) End(success bool) {
	if p.state == OscStateStart {
		return
	}
	if p.state != OscStateAbort {
		// Early end while still in ID state: announce start then end immediately
		if p.state == OscStateID {
			p.start()
		}
		if len(p.active) == 0 {
			p.handlerFb(p.id, "END", success)
		} else {
			for j := len(p.active) - 1; j >= 0; j-- {
				if p.active[j].End(success) {
					// Handler consumed the sequence; clean up remaining
					for k := j - 1; k >= 0; k-- {
						p.active[k].End(false)
					}
					break
				}
			}
		}
	}
	p.active = nil
	p.id = -1
	p.state = OscStateStart
}

// OscStringHandler is a convenience wrapper that collects OSC payload as a
// string and calls a callback function on End.
type OscStringHandler struct {
	handler  func(data string) bool
	data     string
	hitLimit bool
}

// NewOscStringHandler creates an OscStringHandler from a callback.
func NewOscStringHandler(handler func(data string) bool) *OscStringHandler {
	return &OscStringHandler{handler: handler}
}

// Start resets the string accumulator.
func (h *OscStringHandler) Start() {
	h.data = ""
	h.hitLimit = false
}

// Put appends payload data as a string.
func (h *OscStringHandler) Put(data []uint32, start, end int) {
	if h.hitLimit {
		return
	}
	h.data += utf32ToString(data, start, end)
	if len(h.data) > ParserPayloadLimit {
		h.data = ""
		h.hitLimit = true
	}
}

// End calls the handler callback if the sequence ended successfully.
func (h *OscStringHandler) End(success bool) bool {
	ret := false
	if !h.hitLimit && success {
		ret = h.handler(h.data)
	}
	h.data = ""
	h.hitLimit = false
	return ret
}
