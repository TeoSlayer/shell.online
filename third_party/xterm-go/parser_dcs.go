package xterm

// Ported from xterm.js src/common/parser/DcsParser.ts.
//
// DcsParser handles Device Control String sequences. It dispatches to
// registered handlers based on a numeric identifier, managing the
// hook/put/unhook lifecycle.

// DcsHandler is the interface for handlers that process DCS sequences.
type DcsHandler interface {
	Hook(params *Params)
	Put(data []uint32, start, end int)
	Unhook(success bool) bool
}

// DcsFallbackHandler is called when no registered handler matches the DCS identifier.
type DcsFallbackHandler func(ident int, action string, payload ...interface{})

// DcsParser parses DCS sequences and dispatches to registered handlers.
type DcsParser struct {
	handlers  map[int][]DcsHandler
	active    []DcsHandler
	ident     int
	handlerFb DcsFallbackHandler
}

// NewDcsParser creates a new DcsParser.
func NewDcsParser() *DcsParser {
	return &DcsParser{
		handlers:  make(map[int][]DcsHandler),
		handlerFb: func(int, string, ...interface{}) {},
	}
}

// RegisterHandler registers a handler for the given DCS identifier.
// Returns a Disposable that removes the handler when disposed.
func (p *DcsParser) RegisterHandler(ident int, handler DcsHandler) Disposable {
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
func (p *DcsParser) ClearHandler(ident int) {
	delete(p.handlers, ident)
}

// SetHandlerFallback sets the fallback handler called when no handler matches.
func (p *DcsParser) SetHandlerFallback(handler DcsFallbackHandler) {
	p.handlerFb = handler
}

// Dispose removes all handlers and resets state.
func (p *DcsParser) Dispose() {
	p.handlers = make(map[int][]DcsHandler)
	p.handlerFb = func(int, string, ...interface{}) {}
	p.active = nil
}

// Reset forces cleanup of active handlers and resets parser state.
func (p *DcsParser) Reset() {
	if len(p.active) > 0 {
		for j := len(p.active) - 1; j >= 0; j-- {
			p.active[j].Unhook(false)
		}
	}
	p.active = nil
	p.ident = 0
}

// Hook begins a new DCS sequence with the given identifier and parameters.
func (p *DcsParser) Hook(ident int, params *Params) {
	p.Reset()
	p.ident = ident
	if handlers, ok := p.handlers[ident]; ok && len(handlers) > 0 {
		p.active = handlers
		for j := len(p.active) - 1; j >= 0; j-- {
			p.active[j].Hook(params)
		}
	} else {
		p.active = nil
		p.handlerFb(p.ident, "HOOK", params)
	}
}

// Put feeds payload data to the active DCS handlers.
func (p *DcsParser) Put(data []uint32, start, end int) {
	if len(p.active) == 0 {
		p.handlerFb(p.ident, "PUT", utf32ToString(data, start, end))
	} else {
		for j := len(p.active) - 1; j >= 0; j-- {
			p.active[j].Put(data, start, end)
		}
	}
}

// Unhook signals the end of a DCS sequence. success indicates whether the
// sequence terminated normally or was aborted.
func (p *DcsParser) Unhook(success bool) {
	if len(p.active) == 0 {
		p.handlerFb(p.ident, "UNHOOK", success)
	} else {
		for j := len(p.active) - 1; j >= 0; j-- {
			if p.active[j].Unhook(success) {
				// Handler consumed; clean up remaining
				for k := j - 1; k >= 0; k-- {
					p.active[k].Unhook(false)
				}
				break
			}
		}
	}
	p.active = nil
	p.ident = 0
}

// DcsStringHandler is a convenience wrapper that collects DCS payload as a
// string and calls a callback function on Unhook.
type DcsStringHandler struct {
	handler  func(data string, params *Params) bool
	data     string
	params   *Params
	hitLimit bool
}

// NewDcsStringHandler creates a DcsStringHandler from a callback.
func NewDcsStringHandler(handler func(data string, params *Params) bool) *DcsStringHandler {
	return &DcsStringHandler{
		handler: handler,
		params:  emptyDcsParams(),
	}
}

// emptyDcsParams returns a Params with a single 0 param (ZDM default).
func emptyDcsParams() *Params {
	p := DefaultParams()
	p.AddParam(0)
	return p
}

// Hook stores the params (cloned if non-trivial) and resets the accumulator.
func (h *DcsStringHandler) Hook(params *Params) {
	if params.Length > 1 || params.Params[0] != 0 {
		h.params = params.Clone()
	} else {
		h.params = emptyDcsParams()
	}
	h.data = ""
	h.hitLimit = false
}

// Put appends payload data as a string.
func (h *DcsStringHandler) Put(data []uint32, start, end int) {
	if h.hitLimit {
		return
	}
	h.data += utf32ToString(data, start, end)
	if len(h.data) > ParserPayloadLimit {
		h.data = ""
		h.hitLimit = true
	}
}

// Unhook calls the handler callback if the sequence ended successfully.
func (h *DcsStringHandler) Unhook(success bool) bool {
	ret := false
	if !h.hitLimit && success {
		ret = h.handler(h.data, h.params)
	}
	h.params = emptyDcsParams()
	h.data = ""
	h.hitLimit = false
	return ret
}
