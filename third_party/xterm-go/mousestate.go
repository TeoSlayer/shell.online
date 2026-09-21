package xterm

// Ported from xterm.js src/common/services/MouseStateService.ts.
// Provides mouse tracking reports with different protocols and encodings.

import "fmt"

// mouseModShift is the modifier bit for Shift in mouse event codes.
const mouseModShift = 4

// mouseModAlt is the modifier bit for Alt in mouse event codes.
const mouseModAlt = 8

// mouseModCtrl is the modifier bit for Ctrl in mouse event codes.
const mouseModCtrl = 16

// coreMouseProtocol defines which events a mouse tracking mode accepts
// and a restrict function that filters/modifies events.
type coreMouseProtocol struct {
	events   CoreMouseEventType
	restrict func(e *CoreMouseEvent) bool
}

// defaultProtocols maps tracking mode names to their protocol definitions.
var defaultProtocols = map[string]coreMouseProtocol{
	// NONE: no events reported.
	"NONE": {
		events: MouseEventNone,
		restrict: func(e *CoreMouseEvent) bool {
			return false
		},
	},
	// X10: mousedown only, no modifiers.
	"X10": {
		events: MouseEventDown,
		restrict: func(e *CoreMouseEvent) bool {
			if e.Button == MouseButtonWheel || e.Action != MouseActionDown {
				return false
			}
			e.Ctrl = false
			e.Alt = false
			e.Shift = false
			return true
		},
	},
	// VT200: mousedown, mouseup, wheel. All modifiers.
	"VT200": {
		events: MouseEventDown | MouseEventUp | MouseEventWheel,
		restrict: func(e *CoreMouseEvent) bool {
			if e.Action == MouseActionMove {
				return false
			}
			return true
		},
	},
	// DRAG: mousedown, mouseup, wheel, drag. All modifiers.
	"DRAG": {
		events: MouseEventDown | MouseEventUp | MouseEventWheel | MouseEventDrag,
		restrict: func(e *CoreMouseEvent) bool {
			if e.Action == MouseActionMove && e.Button == MouseButtonNone {
				return false
			}
			return true
		},
	},
	// ANY: all mouse events. All modifiers.
	"ANY": {
		events: MouseEventDown | MouseEventUp | MouseEventWheel | MouseEventDrag | MouseEventMove,
		restrict: func(e *CoreMouseEvent) bool {
			return true
		},
	},
}

// mouseEventCode computes the numeric event code for a mouse event.
// isSGR controls whether button release can report the actual button.
func mouseEventCode(e *CoreMouseEvent, isSGR bool) int {
	code := 0
	if e.Ctrl {
		code |= mouseModCtrl
	}
	if e.Shift {
		code |= mouseModShift
	}
	if e.Alt {
		code |= mouseModAlt
	}

	if e.Button == MouseButtonWheel {
		code |= 64
		code |= int(e.Action)
	} else {
		code |= int(e.Button) & 3
		if int(e.Button)&4 != 0 {
			code |= 64
		}
		if int(e.Button)&8 != 0 {
			code |= 128
		}
		if e.Action == MouseActionMove {
			code |= int(MouseActionMove)
		} else if e.Action == MouseActionUp && !isSGR {
			// Only SGR can report button on release; others use NONE.
			code |= int(MouseButtonNone)
		}
	}
	return code
}

// CoreMouseEncoding is a function that encodes a CoreMouseEvent into an escape sequence.
type CoreMouseEncoding func(e *CoreMouseEvent) string

// defaultEncodings maps encoding names to their encoding functions.
var defaultEncodings = map[string]CoreMouseEncoding{
	// DEFAULT: CSI M Pb Px Py — single-byte encoding, values up to 223 (1-based).
	"DEFAULT": func(e *CoreMouseEvent) string {
		p0 := mouseEventCode(e, false) + 32
		p1 := e.Col + 32
		p2 := e.Row + 32
		if p0 > 255 || p1 > 255 || p2 > 255 {
			return ""
		}
		return fmt.Sprintf("\x1b[M%c%c%c", rune(p0), rune(p1), rune(p2))
	},
	// SGR: CSI < Pb ; Px ; Py M|m — no encoding limitation, reports button on release.
	"SGR": func(e *CoreMouseEvent) string {
		final := byte('M')
		if e.Action == MouseActionUp && e.Button != MouseButtonWheel {
			final = 'm'
		}
		return fmt.Sprintf("\x1b[<%d;%d;%d%c", mouseEventCode(e, true), e.Col, e.Row, final)
	},
	// SGR_PIXELS: like SGR but uses pixel coordinates (X, Y) instead of cell coordinates.
	"SGR_PIXELS": func(e *CoreMouseEvent) string {
		final := byte('M')
		if e.Action == MouseActionUp && e.Button != MouseButtonWheel {
			final = 'm'
		}
		return fmt.Sprintf("\x1b[<%d;%d;%d%c", mouseEventCode(e, true), e.X, e.Y, final)
	},
}

// MouseStateService manages mouse tracking protocols and encodings.
type MouseStateService struct {
	protocols      map[string]coreMouseProtocol
	encodings      map[string]CoreMouseEncoding
	activeProtocol string
	activeEncoding string

	OnProtocolChangeEmitter EventEmitter[CoreMouseEventType]
}

// NewMouseStateService creates a MouseStateService with default protocols and encodings.
func NewMouseStateService() *MouseStateService {
	m := &MouseStateService{
		protocols: make(map[string]coreMouseProtocol),
		encodings: make(map[string]CoreMouseEncoding),
	}
	for name, p := range defaultProtocols {
		m.protocols[name] = p
	}
	for name, enc := range defaultEncodings {
		m.encodings[name] = enc
	}
	m.Reset()
	return m
}

// ActiveProtocol returns the name of the active mouse tracking protocol.
func (m *MouseStateService) ActiveProtocol() string {
	return m.activeProtocol
}

// SetActiveProtocol sets the active mouse tracking protocol by name.
func (m *MouseStateService) SetActiveProtocol(name string) {
	p, ok := m.protocols[name]
	if !ok {
		return
	}
	m.activeProtocol = name
	m.OnProtocolChangeEmitter.Fire(p.events)
}

// ActiveEncoding returns the name of the active mouse encoding.
func (m *MouseStateService) ActiveEncoding() string {
	return m.activeEncoding
}

// SetActiveEncoding sets the active mouse encoding by name.
func (m *MouseStateService) SetActiveEncoding(name string) {
	if _, ok := m.encodings[name]; !ok {
		return
	}
	m.activeEncoding = name
}

// AreMouseEventsActive returns true if the active protocol accepts any events.
func (m *MouseStateService) AreMouseEventsActive() bool {
	return m.protocols[m.activeProtocol].events != 0
}

// Reset restores the default protocol (NONE) and encoding (DEFAULT).
func (m *MouseStateService) Reset() {
	m.SetActiveProtocol("NONE")
	m.SetActiveEncoding("DEFAULT")
}

// TriggerMouseEvent applies the active protocol's filter and encoding to the event.
// Returns the encoded escape sequence and true if the event was accepted,
// or ("", false) if the protocol rejected it.
func (m *MouseStateService) TriggerMouseEvent(e CoreMouseEvent) (string, bool) {
	proto := m.protocols[m.activeProtocol]
	if proto.events == MouseEventNone {
		return "", false
	}
	if !proto.restrict(&e) {
		return "", false
	}
	encoded := m.encodings[m.activeEncoding](&e)
	if encoded == "" {
		return "", false
	}
	return encoded, true
}

// Dispose cleans up event emitters.
func (m *MouseStateService) Dispose() {
	m.OnProtocolChangeEmitter.Dispose()
}
