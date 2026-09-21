package xterm

// Ported from xterm.js src/common/parser/EscapeSequenceParser.ts.
// Synchronous VT500-compatible escape sequence parser.

import "reflect"

// Handler types for the escape sequence parser.
type (
	// PrintHandler handles printable character ranges.
	PrintHandler func(data []uint32, start, end int)

	// ExecuteHandler handles C0/C1 control codes.
	ExecuteHandler func()

	// CsiHandler handles CSI sequences. Returns true to stop handler chain bubbling.
	CsiHandler func(params *Params) bool

	// EscHandler handles ESC sequences. Returns true to stop handler chain bubbling.
	EscHandler func() bool

	// ExecuteFallbackHandler is called when no execute handler matches.
	ExecuteFallbackHandler func(code uint32)

	// CsiFallbackHandler is called when no CSI handler matches.
	CsiFallbackHandler func(ident int, params *Params)

	// EscFallbackHandler is called when no ESC handler matches.
	EscFallbackHandler func(ident int)

	// PrintFallbackHandler is called when no print handler is set.
	// Same signature as PrintHandler.
	PrintFallbackHandler = PrintHandler

	// ErrorHandler processes parsing errors. Returns a (possibly modified) ParsingState.
	// Set abort=true in the returned state to stop parsing.
	ErrorHandler func(state ParsingState) ParsingState
)

// ParsingState describes the parser state at the point of an error.
type ParsingState struct {
	Position     int
	Code         uint32
	CurrentState ParserState
	Collect      int
	Params       *Params
	Abort        bool
}

// FunctionIdentifier identifies a parser function by its prefix, intermediates, and final character.
type FunctionIdentifier struct {
	Prefix        byte // 0 for none, or '<', '=', '>', '?'
	Intermediates string
	Final         byte
}

// EscapeSequenceParser is a synchronous VT500-compatible escape sequence parser.
type EscapeSequenceParser struct {
	initialState       ParserState
	currentState       ParserState
	precedingJoinState int
	transitions        *TransitionTable

	params  *Params
	collect int

	printHandler     PrintHandler
	printHandlerFb   PrintFallbackHandler
	executeHandlers  [128]ExecuteHandler
	executeHandlerFb ExecuteFallbackHandler

	csiHandlers  map[int][]CsiHandler
	csiHandlerFb CsiFallbackHandler
	escHandlers  map[int][]EscHandler
	escHandlerFb EscFallbackHandler

	oscParser *OscParser
	dcsParser *DcsParser
	apcParser *ApcParser

	errorHandler   ErrorHandler
	errorHandlerFb ErrorHandler
}

// NewEscapeSequenceParser creates a new parser with the VT500 transition table.
func NewEscapeSequenceParser() *EscapeSequenceParser {
	return NewEscapeSequenceParserWithTable(VT500TransitionTable)
}

// NewEscapeSequenceParserWithTable creates a new parser with a custom transition table.
func NewEscapeSequenceParserWithTable(table *TransitionTable) *EscapeSequenceParser {
	defaultErrorHandler := func(state ParsingState) ParsingState {
		return state
	}
	p := &EscapeSequenceParser{
		initialState:     ParserStateGround,
		currentState:     ParserStateGround,
		transitions:      table,
		params:           DefaultParams(),
		csiHandlers:      make(map[int][]CsiHandler),
		escHandlers:      make(map[int][]EscHandler),
		oscParser:        NewOscParser(),
		dcsParser:        NewDcsParser(),
		apcParser:        NewApcParser(),
		printHandler:     func(data []uint32, start, end int) {},
		printHandlerFb:   func(data []uint32, start, end int) {},
		executeHandlerFb: func(code uint32) {},
		csiHandlerFb:     func(ident int, params *Params) {},
		escHandlerFb:     func(ident int) {},
		errorHandler:     defaultErrorHandler,
		errorHandlerFb:   defaultErrorHandler,
	}
	p.params.AddParam(0) // ZDM
	return p
}

// identifier computes the numeric identifier for a FunctionIdentifier.
func (p *EscapeSequenceParser) identifier(id FunctionIdentifier) int {
	var collect int
	if id.Prefix != 0 {
		validateIdentifierPrefix(id.Prefix)
		collect = int(id.Prefix)
	}
	for i := range len(id.Intermediates) {
		collect = collect<<8 | int(id.Intermediates[i])
	}
	return collect<<8 | int(id.Final)
}

func validateIdentifierPrefix(prefix byte) {
	if prefix < 0x3c || prefix > 0x3f {
		panic("prefix must be in range 0x3c .. 0x3f")
	}
}

// IdentToString converts a numeric identifier back to a human-readable string.
func IdentToString(ident int) string {
	var res []byte
	for ident != 0 {
		res = append([]byte{byte(ident & 0xFF)}, res...)
		ident >>= 8
	}
	return string(res)
}

// --- Print handler ---

// SetPrintHandler sets the handler for printable character ranges.
func (p *EscapeSequenceParser) SetPrintHandler(handler PrintHandler) {
	p.printHandler = handler
}

// ClearPrintHandler resets the print handler to the fallback.
func (p *EscapeSequenceParser) ClearPrintHandler() {
	p.printHandler = p.printHandlerFb
}

// SetPrintHandlerFallback sets the fallback print handler.
func (p *EscapeSequenceParser) SetPrintHandlerFallback(handler PrintFallbackHandler) {
	p.printHandlerFb = handler
}

// --- Execute handlers ---

// RegisterExecuteHandler registers a handler for a specific control code.
// Returns a Disposable that removes the handler.
func (p *EscapeSequenceParser) RegisterExecuteHandler(code byte, handler ExecuteHandler) Disposable {
	p.executeHandlers[code] = handler
	return toDisposable(func() {
		p.executeHandlers[code] = nil
	})
}

// ClearExecuteHandler removes the handler for a specific control code.
func (p *EscapeSequenceParser) ClearExecuteHandler(code byte) {
	p.executeHandlers[code] = nil
}

// SetExecuteHandlerFallback sets the fallback execute handler.
func (p *EscapeSequenceParser) SetExecuteHandlerFallback(handler ExecuteFallbackHandler) {
	p.executeHandlerFb = handler
}

// --- CSI handlers ---

// RegisterCsiHandler registers a handler for a CSI function identifier.
// Returns a Disposable that removes the handler.
func (p *EscapeSequenceParser) RegisterCsiHandler(id FunctionIdentifier, handler CsiHandler) Disposable {
	ident := p.identifier(id)
	p.csiHandlers[ident] = append(p.csiHandlers[ident], handler)
	hPtr := reflect.ValueOf(handler).Pointer()
	return toDisposable(func() {
		list := p.csiHandlers[ident]
		for i := len(list) - 1; i >= 0; i-- {
			if reflect.ValueOf(list[i]).Pointer() == hPtr {
				p.csiHandlers[ident] = append(list[:i], list[i+1:]...)
				return
			}
		}
	})
}

// ClearCsiHandler removes all handlers for a CSI function identifier.
func (p *EscapeSequenceParser) ClearCsiHandler(id FunctionIdentifier) {
	delete(p.csiHandlers, p.identifier(id))
}

// SetCsiHandlerFallback sets the fallback CSI handler.
func (p *EscapeSequenceParser) SetCsiHandlerFallback(handler CsiFallbackHandler) {
	p.csiHandlerFb = handler
}

// --- ESC handlers ---

// RegisterEscHandler registers a handler for an ESC function identifier.
// Returns a Disposable that removes the handler.
func (p *EscapeSequenceParser) RegisterEscHandler(id FunctionIdentifier, handler EscHandler) Disposable {
	ident := p.identifier(id)
	p.escHandlers[ident] = append(p.escHandlers[ident], handler)
	hPtr := reflect.ValueOf(handler).Pointer()
	return toDisposable(func() {
		list := p.escHandlers[ident]
		for i := len(list) - 1; i >= 0; i-- {
			if reflect.ValueOf(list[i]).Pointer() == hPtr {
				p.escHandlers[ident] = append(list[:i], list[i+1:]...)
				return
			}
		}
	})
}

// ClearEscHandler removes all handlers for an ESC function identifier.
func (p *EscapeSequenceParser) ClearEscHandler(id FunctionIdentifier) {
	delete(p.escHandlers, p.identifier(id))
}

// SetEscHandlerFallback sets the fallback ESC handler.
func (p *EscapeSequenceParser) SetEscHandlerFallback(handler EscFallbackHandler) {
	p.escHandlerFb = handler
}

// --- Sub-parser delegation ---

// RegisterDcsHandler registers a DCS handler.
func (p *EscapeSequenceParser) RegisterDcsHandler(id FunctionIdentifier, handler DcsHandler) Disposable {
	return p.dcsParser.RegisterHandler(p.identifier(id), handler)
}

// ClearDcsHandler removes all DCS handlers for the identifier.
func (p *EscapeSequenceParser) ClearDcsHandler(id FunctionIdentifier) {
	p.dcsParser.ClearHandler(p.identifier(id))
}

// SetDcsHandlerFallback sets the DCS fallback handler.
func (p *EscapeSequenceParser) SetDcsHandlerFallback(handler DcsFallbackHandler) {
	p.dcsParser.SetHandlerFallback(handler)
}

// RegisterOscHandler registers an OSC handler.
func (p *EscapeSequenceParser) RegisterOscHandler(ident int, handler OscHandler) Disposable {
	return p.oscParser.RegisterHandler(ident, handler)
}

// ClearOscHandler removes all OSC handlers for the identifier.
func (p *EscapeSequenceParser) ClearOscHandler(ident int) {
	p.oscParser.ClearHandler(ident)
}

// SetOscHandlerFallback sets the OSC fallback handler.
func (p *EscapeSequenceParser) SetOscHandlerFallback(handler OscFallbackHandler) {
	p.oscParser.SetHandlerFallback(handler)
}

// RegisterApcHandler registers an APC handler.
func (p *EscapeSequenceParser) RegisterApcHandler(id FunctionIdentifier, handler ApcHandler) Disposable {
	if id.Prefix != 0 {
		validateIdentifierPrefix(id.Prefix)
	}
	id.Prefix = 0 // APC does not support prefix byte
	return p.apcParser.RegisterHandler(p.identifier(id), handler)
}

// ClearApcHandler removes all APC handlers for the identifier.
func (p *EscapeSequenceParser) ClearApcHandler(id FunctionIdentifier) {
	if id.Prefix != 0 {
		validateIdentifierPrefix(id.Prefix)
	}
	id.Prefix = 0 // APC does not support prefix byte
	p.apcParser.ClearHandler(p.identifier(id))
}

// SetApcHandlerFallback sets the APC fallback handler.
func (p *EscapeSequenceParser) SetApcHandlerFallback(handler ApcFallbackHandler) {
	p.apcParser.SetHandlerFallback(handler)
}

// --- Error handler ---

// SetErrorHandler sets the error handler.
func (p *EscapeSequenceParser) SetErrorHandler(handler ErrorHandler) {
	p.errorHandler = handler
}

// ClearErrorHandler resets the error handler to the default.
func (p *EscapeSequenceParser) ClearErrorHandler() {
	p.errorHandler = p.errorHandlerFb
}

// --- State access ---

// CurrentState returns the current parser state.
func (p *EscapeSequenceParser) CurrentState() ParserState {
	return p.currentState
}

// PrecedingJoinState returns the preceding grapheme join state.
func (p *EscapeSequenceParser) PrecedingJoinState() int {
	return p.precedingJoinState
}

// SetPrecedingJoinState sets the preceding grapheme join state.
func (p *EscapeSequenceParser) SetPrecedingJoinState(state int) {
	p.precedingJoinState = state
}

// --- Reset ---

// Reset resets the parser to its initial state.
func (p *EscapeSequenceParser) Reset() {
	p.currentState = p.initialState
	p.oscParser.Reset()
	p.dcsParser.Reset()
	p.apcParser.Reset()
	p.params.ResetZdm()
	p.collect = 0
	p.precedingJoinState = 0
}

// Dispose cleans up all parser resources.
func (p *EscapeSequenceParser) Dispose() {
	p.oscParser.Dispose()
	p.dcsParser.Dispose()
	p.apcParser.Dispose()
}

// --- Parse ---

// Parse processes UTF-32 codepoints in data[0:length].
// This is the main parse loop, fully synchronous (no async/promise support).
func (p *EscapeSequenceParser) Parse(data []uint32, length int) {
	var code uint32
	var transition uint16

	table := p.transitions.table

	for i := 0; i < length; i++ {
		code = data[i]

		// EXE fast-path: common control bytes (0x00-0x17) in non-payload states
		// bypass the transition table entirely and dispatch directly.
		if code < 0x18 && p.currentState <= ParserStateCSIIgnore {
			if p.executeHandlers[code] != nil {
				p.executeHandlers[code]()
			} else {
				p.executeHandlerFb(code)
			}
			p.precedingJoinState = 0
			continue
		}

		// CSI fast-path: when ESC [ is detected in a non-string state, parse
		// params and final byte in a tight loop without table lookups.
		if code == 0x1b && p.currentState < ParserStateOSCString &&
			i+2 < length && data[i+1] == 0x5b {
			p.params.ResetZdm()
			p.collect = 0
			k := i + 2
			ch := data[k]
			// Prefix byte (< = > ?)
			if ch >= 0x3c && ch <= 0x3f {
				p.collect = int(ch)
				k++
			}
			csiDone := false
			for ; k < length; k++ {
				ch = data[k]
				if ch >= 0x30 && ch <= 0x39 {
					p.params.AddDigit(int32(ch) - 48)
				} else if ch == 0x3b {
					p.params.AddParam(0) // ZDM
				} else if ch == 0x3a {
					p.params.AddSubParam(-1)
				} else if ch >= 0x40 && ch <= 0x7e {
					// Final byte — dispatch CSI handler
					ident := p.collect<<8 | int(ch)
					handlers := p.csiHandlers[ident]
					j := len(handlers) - 1
					for ; j >= 0; j-- {
						if handlers[j](p.params) {
							break
						}
					}
					if j < 0 {
						p.csiHandlerFb(ident, p.params)
					}
					p.precedingJoinState = 0
					i = k
					p.currentState = ParserStateGround
					csiDone = true
					break
				} else {
					// Intermediate byte or unexpected — fall back to table-driven path
					break
				}
			}
			if !csiDone {
				// Ran out of data or hit an intermediate; let the table-driven
				// path continue from the CSI_PARAM state.
				i = k - 1
				p.currentState = ParserStateCSIParam
			}
			continue
		}

		// Map non-ASCII printable to the 0xA0 slot
		if code < 0xa0 {
			transition = table[int(p.currentState)<<tableIndexStateShift|int(code)]
		} else {
			transition = table[int(p.currentState)<<tableIndexStateShift|nonASCIIPrintable]
		}

		switch ParserAction(transition >> tableTransitionActionShift) {
		case ParserActionPrint:
			// Read ahead for contiguous printable range (loop unrolling)
			j := i + 1
			for ; j < length; j++ {
				code = data[j]
				if code < 0x20 || (code > 0x7e && code < nonASCIIPrintable) {
					break
				}
			}
			p.printHandler(data, i, j)
			i = j - 1

		case ParserActionExecute:
			if code < 128 && p.executeHandlers[code] != nil {
				p.executeHandlers[code]()
			} else {
				p.executeHandlerFb(code)
			}
			p.precedingJoinState = 0

		case ParserActionIgnore:
			// do nothing

		case ParserActionError:
			inject := p.errorHandler(ParsingState{
				Position:     i,
				Code:         code,
				CurrentState: p.currentState,
				Collect:      p.collect,
				Params:       p.params,
				Abort:        false,
			})
			if inject.Abort {
				return
			}

		case ParserActionCSIDispatch:
			// Dispatch to CSI handlers
			ident := p.collect<<8 | int(code)
			handlers := p.csiHandlers[ident]
			j := len(handlers) - 1
			for ; j >= 0; j-- {
				if handlers[j](p.params) {
					break
				}
			}
			if j < 0 {
				p.csiHandlerFb(ident, p.params)
			}
			p.precedingJoinState = 0

		case ParserActionParam:
			// Inner loop: digits (0x30-0x39), ';' (0x3b), ':' (0x3a)
			for {
				switch code {
				case 0x3b:
					p.params.AddParam(0) // ZDM
				case 0x3a:
					p.params.AddSubParam(-1)
				default: // 0x30-0x39
					p.params.AddDigit(int32(code) - 48)
				}
				i++
				if i >= length {
					break
				}
				code = data[i]
				if code < 0x30 || code > 0x3b {
					break
				}
			}
			i--

		case ParserActionCollect:
			p.collect = p.collect<<8 | int(code)

		case ParserActionESCDispatch:
			ident := p.collect<<8 | int(code)
			handlers := p.escHandlers[ident]
			j := len(handlers) - 1
			for ; j >= 0; j-- {
				if handlers[j]() {
					break
				}
			}
			if j < 0 {
				p.escHandlerFb(ident)
			}
			p.precedingJoinState = 0

		case ParserActionClear:
			p.params.ResetZdm()
			p.collect = 0

		case ParserActionDCSHook:
			p.dcsParser.Hook(p.collect<<8|int(code), p.params)

		case ParserActionDCSPut:
			// Inner loop: exit on 0x18, 0x1a, 0x1b, 0x7f, 0x80-0x9f
			j := i + 1
			for ; j < length; j++ {
				code = data[j]
				if code == 0x18 || code == 0x1a || code == 0x1b || (code > 0x7f && code < nonASCIIPrintable) {
					break
				}
			}
			p.dcsParser.Put(data, i, j)
			i = j - 1

		case ParserActionDCSUnhook:
			p.dcsParser.Unhook(code != 0x18 && code != 0x1a)
			if code == 0x1b {
				transition |= uint16(ParserStateEscape)
			}
			p.params.ResetZdm()
			p.collect = 0
			p.precedingJoinState = 0

		case ParserActionOSCStart:
			p.oscParser.Start()

		case ParserActionOSCPut:
			// Inner loop: 0x20 (SP) included, 0x7F (DEL) included
			j := i + 1
			for ; j < length; j++ {
				code = data[j]
				if code < 0x20 || (code > 0x7f && code < nonASCIIPrintable) {
					break
				}
			}
			p.oscParser.Put(data, i, j)
			i = j - 1

		case ParserActionOSCEnd:
			p.oscParser.End(code != 0x18 && code != 0x1a)
			if code == 0x1b {
				transition |= uint16(ParserStateEscape)
			}
			p.params.ResetZdm()
			p.collect = 0
			p.precedingJoinState = 0

		case ParserActionAPCStart:
			p.apcParser.Start(p.collect<<8 | int(code))

		case ParserActionAPCPut:
			// Inner loop: allow 0x08-0x0d, 0x20-0x7e, non-ASCII printable
			j := i + 1
			for ; j < length; j++ {
				code = data[j]
				if (code >= 0x20 && code < 0x7f) || (code >= 0x08 && code < 0x0e) || code >= nonASCIIPrintable {
					continue
				}
				break
			}
			p.apcParser.Put(data, i, j)
			i = j - 1

		case ParserActionAPCEnd:
			p.apcParser.End(code != 0x18 && code != 0x1a)
			if code == 0x1b {
				transition |= uint16(ParserStateEscape)
			}
			p.params.ResetZdm()
			p.collect = 0
			p.precedingJoinState = 0
		}

		p.currentState = ParserState(transition & tableTransitionStateMask)
	}
}
