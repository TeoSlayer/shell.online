package xterm

// Ported from xterm.js src/common/InputHandler.ts.
// Core InputHandler struct, constructor, Parse, Print, and Reset.

const maxParseBufferLength = 131072

// ColorEvent is a single color request entry (set, report, or restore).
type ColorEvent struct {
	Type  ColorRequestType
	Index int // ColorIndex (0-255) or SpecialColorIndex
	Color *ColorRGB
}

// DirtyRowTracker tracks which rows were modified during a parse cycle.
type DirtyRowTracker struct {
	Start         int
	End           int
	bufferService *BufferService
}

func newDirtyRowTracker(bs *BufferService) *DirtyRowTracker {
	d := &DirtyRowTracker{bufferService: bs}
	d.ClearRange()
	return d
}

func (d *DirtyRowTracker) ClearRange() {
	y := d.bufferService.Buffer().Y
	d.Start = y
	d.End = y
}

func (d *DirtyRowTracker) MarkDirty(y int) {
	if y < d.Start {
		d.Start = y
	} else if y > d.End {
		d.End = y
	}
}

func (d *DirtyRowTracker) MarkRangeDirty(y1, y2 int) {
	if y1 > y2 {
		y1, y2 = y2, y1
	}
	if y1 < d.Start {
		d.Start = y1
	}
	if y2 > d.End {
		d.End = y2
	}
}

func (d *DirtyRowTracker) MarkAllDirty() {
	d.MarkRangeDirty(0, d.bufferService.Rows-1)
}

// glevelMap maps ESC intermediate characters to G-set indices.
var glevelMap = map[byte]int{
	'(': 0,
	')': 1,
	'*': 2,
	'+': 3,
	'-': 1,
	'.': 2,
	'/': 3,
}

// InputHandler wires the EscapeSequenceParser to the terminal buffer.
type InputHandler struct {
	parser         *EscapeSequenceParser
	bufferService  *BufferService
	charsetService *CharsetService
	coreService    *CoreService
	optionsService *OptionsService
	oscLinkService *OscLinkService
	unicodeService *UnicodeService

	curAttrData           AttributeData
	eraseAttrDataInternal AttributeData

	utf8Decoder     Utf8ToUtf32
	parseBuffer     []uint32
	dirtyRowTracker *DirtyRowTracker

	windowTitle      string
	iconName         string
	windowTitleStack []string
	iconNameStack    []string

	// Events
	OnCursorMoveEmitter           EventEmitter[struct{}]
	OnTitleChangeEmitter          EventEmitter[string]
	OnIconNameChangeEmitter       EventEmitter[string]
	OnLineFeedEmitter             EventEmitter[struct{}]
	OnA11yCharEmitter             EventEmitter[string]
	OnA11yTabEmitter              EventEmitter[int]
	OnRequestBellEmitter          EventEmitter[struct{}]
	OnRequestResetEmitter         EventEmitter[struct{}]
	OnRequestRefreshRowsEmitter   EventEmitter[RowRange]
	OnColorEmitter                          EventEmitter[[]ColorEvent]
	OnRequestSendFocusEmitter               EventEmitter[struct{}]
	OnRequestSyncScrollBarEmitter           EventEmitter[struct{}]
	OnRequestColorSchemeQueryEmitter        EventEmitter[struct{}]
	OnRequestWindowsOptionsReportEmitter    EventEmitter[WindowsOptionsReportType]
}

// NewInputHandler creates an InputHandler and registers all parser handlers.
func NewInputHandler(
	bufferService *BufferService,
	charsetService *CharsetService,
	coreService *CoreService,
	optionsService *OptionsService,
	oscLinkService *OscLinkService,
	unicodeService *UnicodeService,
) *InputHandler {
	h := &InputHandler{
		parser:                NewEscapeSequenceParser(),
		bufferService:         bufferService,
		charsetService:        charsetService,
		coreService:           coreService,
		optionsService:        optionsService,
		oscLinkService:        oscLinkService,
		unicodeService:        unicodeService,
		curAttrData:           DefaultAttrData(),
		eraseAttrDataInternal: DefaultAttrData(),
		parseBuffer:           make([]uint32, 4096),
		dirtyRowTracker:       newDirtyRowTracker(bufferService),
	}

	p := h.parser

	// Print handler
	p.SetPrintHandler(h.Print)

	// C0 execute handlers
	p.RegisterExecuteHandler(0x07, h.Bell)     // BEL
	p.RegisterExecuteHandler(0x0A, h.LineFeed) // LF
	p.RegisterExecuteHandler(0x0B, h.LineFeed) // VT (treated as LF)
	p.RegisterExecuteHandler(0x0C, h.LineFeed) // FF (treated as LF)
	p.RegisterExecuteHandler(0x0D, h.CarriageReturn)
	p.RegisterExecuteHandler(0x08, h.Backspace)
	p.RegisterExecuteHandler(0x09, h.Tab)
	p.RegisterExecuteHandler(0x0E, h.ShiftOut)
	p.RegisterExecuteHandler(0x0F, h.ShiftIn)

	// ESC handlers
	p.RegisterEscHandler(FunctionIdentifier{Final: '7'}, h.escSaveCursor)
	p.RegisterEscHandler(FunctionIdentifier{Final: '8'}, h.escRestoreCursor)
	p.RegisterEscHandler(FunctionIdentifier{Final: 'D'}, h.escIndex)
	p.RegisterEscHandler(FunctionIdentifier{Final: 'E'}, h.escNextLine)
	p.RegisterEscHandler(FunctionIdentifier{Final: 'H'}, h.escTabSet)
	p.RegisterEscHandler(FunctionIdentifier{Final: 'M'}, h.escReverseIndex)
	p.RegisterEscHandler(FunctionIdentifier{Final: '='}, h.escKeypadApplicationMode)
	p.RegisterEscHandler(FunctionIdentifier{Final: '>'}, h.escKeypadNumericMode)
	p.RegisterEscHandler(FunctionIdentifier{Final: 'c'}, h.escFullReset)
	p.RegisterEscHandler(FunctionIdentifier{Final: 'n'}, func() bool { return h.SetgLevel(2) })
	p.RegisterEscHandler(FunctionIdentifier{Final: 'o'}, func() bool { return h.SetgLevel(3) })
	p.RegisterEscHandler(FunctionIdentifier{Final: '|'}, func() bool { return h.SetgLevel(3) })
	p.RegisterEscHandler(FunctionIdentifier{Final: '}'}, func() bool { return h.SetgLevel(2) })
	p.RegisterEscHandler(FunctionIdentifier{Final: '~'}, func() bool { return h.SetgLevel(1) })

	// ESC % @ and ESC % G — select default charset
	p.RegisterEscHandler(FunctionIdentifier{Intermediates: "%", Final: '@'}, h.escSelectDefaultCharset)
	p.RegisterEscHandler(FunctionIdentifier{Intermediates: "%", Final: 'G'}, h.escSelectDefaultCharset)

	// ESC # 8 — DECALN screen alignment pattern
	p.RegisterEscHandler(FunctionIdentifier{Intermediates: "#", Final: '8'}, h.escScreenAlignmentPattern)

	// Charset designation: ESC ( ) * + - . / <flag>
	for flag := range CHARSETS {
		f := flag // capture
		for _, inter := range []string{"(", ")", "*", "+", "-", ".", "/"} {
			i := inter // capture
			p.RegisterEscHandler(FunctionIdentifier{Intermediates: i, Final: f}, func() bool {
				return h.SelectCharset(i + string(f))
			})
		}
	}

	// CSI handlers — cursor movement
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'A'}, h.cursorUp)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'B'}, h.cursorDown)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'C'}, h.cursorForward)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'D'}, h.cursorBackward)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'E'}, h.cursorNextLine)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'F'}, h.cursorPrecedingLine)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'G'}, h.cursorCharAbsolute)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'H'}, h.cursorPosition)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'I'}, h.cursorForwardTab)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'Z'}, h.cursorBackwardTab)
	p.RegisterCsiHandler(FunctionIdentifier{Final: '`'}, h.charPosAbsolute)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'a'}, h.hPositionRelative)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'd'}, h.linePosAbsolute)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'e'}, h.vPositionRelative)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'f'}, h.hVPosition)

	// CSI handlers — erase
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'J'}, h.eraseInDisplay)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'K'}, h.eraseInLine)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'X'}, h.eraseChars)
	// DECSED / DECSEL (CSI ? J / CSI ? K)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '?', Final: 'J'}, h.eraseInDisplayProtected)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '?', Final: 'K'}, h.eraseInLineProtected)

	// CSI handlers — insert/delete
	p.RegisterCsiHandler(FunctionIdentifier{Final: '@'}, h.insertChars)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'L'}, h.insertLines)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'M'}, h.deleteLines)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'P'}, h.deleteChars)

	// CSI handlers — scroll
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'S'}, h.scrollUp)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'T'}, h.scrollDown)
	p.RegisterCsiHandler(FunctionIdentifier{Final: '^'}, h.scrollDown)
	p.RegisterCsiHandler(FunctionIdentifier{Intermediates: " ", Final: '@'}, h.scrollLeft)
	p.RegisterCsiHandler(FunctionIdentifier{Intermediates: " ", Final: 'A'}, h.scrollRight)
	p.RegisterCsiHandler(FunctionIdentifier{Intermediates: "'", Final: '}'}, h.insertColumns)
	p.RegisterCsiHandler(FunctionIdentifier{Intermediates: "'", Final: '~'}, h.deleteColumns)

	// CSI handlers — other
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'b'}, h.repeatPrecedingCharacter)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'c'}, h.sendDeviceAttributesPrimary)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '>', Final: 'c'}, h.sendDeviceAttributesSecondary)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '>', Final: 'q'}, h.sendXtVersion)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'g'}, h.tabClear)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'm'}, h.charAttributes)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'n'}, h.deviceStatus)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '?', Final: 'n'}, h.deviceStatusPrivate)
	p.RegisterCsiHandler(FunctionIdentifier{Intermediates: "!", Final: 'p'}, h.softReset)
	p.RegisterCsiHandler(FunctionIdentifier{Intermediates: "$", Final: 'p'}, func(params *Params) bool {
		return h.requestMode(params, false)
	})
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '?', Intermediates: "$", Final: 'p'}, func(params *Params) bool {
		return h.requestMode(params, true)
	})
	p.RegisterCsiHandler(FunctionIdentifier{Intermediates: " ", Final: 'q'}, h.setCursorStyle)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'r'}, h.setScrollRegion)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 't'}, h.windowOptions)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 's'}, h.csiSaveCursor)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'u'}, h.csiRestoreCursor)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '=', Final: 'u'}, h.kittyKeyboardSet)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '?', Final: 'u'}, h.kittyKeyboardQuery)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '>', Final: 'u'}, h.kittyKeyboardPush)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '<', Final: 'u'}, h.kittyKeyboardPop)
	p.RegisterCsiHandler(FunctionIdentifier{Intermediates: "\"", Final: 'q'}, h.selectProtected)

	// CSI handlers — mode set/reset
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'h'}, h.setMode)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'l'}, h.resetMode)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '?', Final: 'h'}, h.setModePrivate)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '?', Final: 'l'}, h.resetModePrivate)

	// Fallback handlers (upstream uses these for debug logging)
	p.SetApcHandlerFallback(func(ident int, action string, payload ...interface{}) {
		// no-op: upstream logs "Unknown APC code" here
	})

	// DCS handlers
	p.RegisterDcsHandler(FunctionIdentifier{Intermediates: "$", Final: 'q'}, NewDcsStringHandler(h.requestStatusString))

	// OSC handlers
	p.RegisterOscHandler(0, NewOscStringHandler(h.setTitleAndIconName)) // OSC 0 — set title + icon name
	p.RegisterOscHandler(1, NewOscStringHandler(h.setIconName))        // OSC 1 — set icon name
	p.RegisterOscHandler(2, NewOscStringHandler(h.SetTitle))           // OSC 2 — set title
	p.RegisterOscHandler(4, NewOscStringHandler(h.SetOrReportIndexedColor))
	p.RegisterOscHandler(8, NewOscStringHandler(h.SetHyperlink))
	p.RegisterOscHandler(10, NewOscStringHandler(h.SetOrReportFgColor))
	p.RegisterOscHandler(11, NewOscStringHandler(h.SetOrReportBgColor))
	p.RegisterOscHandler(12, NewOscStringHandler(h.SetOrReportCursorColor))
	p.RegisterOscHandler(104, NewOscStringHandler(h.RestoreIndexedColor))
	p.RegisterOscHandler(110, NewOscStringHandler(h.RestoreFgColor))
	p.RegisterOscHandler(111, NewOscStringHandler(h.RestoreBgColor))
	p.RegisterOscHandler(112, NewOscStringHandler(h.RestoreCursorColor))

	return h
}

// Parser returns the underlying escape sequence parser.
func (h *InputHandler) Parser() *EscapeSequenceParser {
	return h.parser
}

// activeBuffer returns the currently active buffer.
func (h *InputHandler) activeBuffer() *Buffer {
	return h.bufferService.Buffer()
}

// eraseAttrData returns the erase attribute data (back_color_erase).
func (h *InputHandler) eraseAttrData() *AttributeData {
	h.eraseAttrDataInternal.Bg &= ^(AttrCMMask | 0xFFFFFF)
	h.eraseAttrDataInternal.Bg |= h.curAttrData.Bg & ^uint32(0xFC000000)
	return &h.eraseAttrDataInternal
}

// restrictCursor clamps the cursor to valid positions.
func (h *InputHandler) restrictCursor(maxCol ...int) {
	mc := h.bufferService.Cols - 1
	if len(maxCol) > 0 {
		mc = maxCol[0]
	}
	buf := h.activeBuffer()
	if buf.X < 0 {
		buf.X = 0
	}
	if buf.X > mc {
		buf.X = mc
	}
	if h.coreService.DecPrivateModes.Origin {
		if buf.Y < buf.ScrollTop {
			buf.Y = buf.ScrollTop
		}
		if buf.Y > buf.ScrollBottom {
			buf.Y = buf.ScrollBottom
		}
	} else {
		if buf.Y < 0 {
			buf.Y = 0
		}
		if buf.Y >= h.bufferService.Rows {
			buf.Y = h.bufferService.Rows - 1
		}
	}
}

// setCursor sets the cursor position, respecting origin mode.
func (h *InputHandler) setCursor(x, y int) {
	buf := h.activeBuffer()
	if h.coreService.DecPrivateModes.Origin {
		buf.X = x
		buf.Y = buf.ScrollTop + y
	} else {
		buf.X = x
		buf.Y = y
	}
	h.restrictCursor()
}

// getCurrentLinkId returns the current hyperlink URL ID.
func (h *InputHandler) getCurrentLinkId() int {
	if h.curAttrData.Extended == nil {
		return 0
	}
	return h.curAttrData.Extended.URLID()
}

// Parse decodes input data and feeds it to the parser.
func (h *InputHandler) Parse(data []byte) {
	if len(data) == 0 {
		return
	}

	cursorStartX := h.activeBuffer().X
	cursorStartY := h.activeBuffer().Y

	// Resize parse buffer if needed.
	if len(h.parseBuffer) < len(data) {
		newSize := len(data)
		if newSize > maxParseBufferLength {
			newSize = maxParseBufferLength
		}
		h.parseBuffer = make([]uint32, newSize)
	}

	h.dirtyRowTracker.ClearRange()

	if len(data) > maxParseBufferLength {
		for i := 0; i < len(data); i += maxParseBufferLength {
			end := i + maxParseBufferLength
			if end > len(data) {
				end = len(data)
			}
			n := h.utf8Decoder.Decode(data[i:end], h.parseBuffer)
			h.parser.Parse(h.parseBuffer, n)
		}
	} else {
		n := h.utf8Decoder.Decode(data, h.parseBuffer)
		h.parser.Parse(h.parseBuffer, n)
	}

	if h.activeBuffer().X != cursorStartX || h.activeBuffer().Y != cursorStartY {
		h.OnCursorMoveEmitter.Fire(struct{}{})
	}

	viewportEnd := h.dirtyRowTracker.End + (h.bufferService.Buffer().YBase - h.bufferService.Buffer().YDisp)
	viewportStart := h.dirtyRowTracker.Start + (h.bufferService.Buffer().YBase - h.bufferService.Buffer().YDisp)
	if viewportStart < h.bufferService.Rows {
		h.OnRequestRefreshRowsEmitter.Fire(RowRange{
			Start: min(viewportStart, h.bufferService.Rows-1),
			End:   min(viewportEnd, h.bufferService.Rows-1),
		})
	}
}

// ParseString is a convenience method that accepts a string.
func (h *InputHandler) ParseString(data string) {
	h.Parse([]byte(data))
}

// Print handles printable characters — writes them to the buffer.
func (h *InputHandler) Print(data []uint32, start, end int) {
	var code uint32
	var chWidth int
	charset := h.charsetService.Charset
	cols := h.bufferService.Cols
	wraparoundMode := h.coreService.DecPrivateModes.Wraparound
	insertMode := h.coreService.Modes.InsertMode
	curAttr := &h.curAttrData
	buf := h.activeBuffer()

	bufferRow := buf.Lines.Get(buf.YBase + buf.Y)
	if bufferRow == nil {
		return
	}

	h.dirtyRowTracker.MarkDirty(buf.Y)

	// Handle wide chars: reset start_cell-1 if we would overwrite the second cell of a wide char.
	if buf.X > 0 && end-start > 0 && bufferRow.GetWidth(buf.X-1) == 2 {
		bufferRow.SetCellFromCodepoint(buf.X-1, 0, 1, curAttr)
	}

	precedingJoinState := h.parser.PrecedingJoinState()
	for pos := start; pos < end; pos++ {
		code = data[pos]

		// Skip soft hyphen (U+00AD).
		if code == 0xAD {
			continue
		}

		// Charset translation for ASCII range.
		if code < 127 && charset != nil {
			if ch, ok := charset[byte(code)]; ok {
				code = uint32(ch)
			}
		}

		currentInfo := h.unicodeService.CharProperties(rune(code), precedingJoinState)
		chWidth = ExtractCharPropsWidth(currentInfo)
		shouldJoin := ExtractShouldJoin(currentInfo)
		oldWidth := 0
		if shouldJoin {
			oldWidth = ExtractCharPropsWidth(precedingJoinState)
		}

		precedingJoinState = currentInfo
		h.parser.SetPrecedingJoinState(precedingJoinState)

		if h.optionsService.Options.ScreenReaderMode {
			h.OnA11yCharEmitter.Fire(string(rune(code)))
		}

		if h.getCurrentLinkId() != 0 {
			h.oscLinkService.AddLineToLink(h.getCurrentLinkId(), buf.YBase+buf.Y)
		}

		// goto next line if ch would overflow
		if buf.X+chWidth-oldWidth > cols {
			// autowrap - DECAWM
			if wraparoundMode {
				oldRow := bufferRow
				oldCol := buf.X - oldWidth
				buf.X = oldWidth
				buf.Y++
				if buf.Y == buf.ScrollBottom+1 {
					buf.Y--
					h.bufferService.Scroll(h.eraseAttrData(), true)
				} else {
					if buf.Y >= h.bufferService.Rows {
						buf.Y = h.bufferService.Rows - 1
					}
					// row changed, get it again
					line := buf.Lines.Get(buf.YBase + buf.Y)
					if line != nil {
						line.IsWrapped = true
					}
				}
				bufferRow = buf.Lines.Get(buf.YBase + buf.Y)
				if bufferRow == nil {
					return
				}
				// When a combining character widens the preceding cell past the
				// line boundary, copy the widened cell to the new line and clear
				// the old cells on the previous line.
				if oldWidth > 0 {
					bufferRow.CopyCellsFrom(oldRow, oldCol, 0, oldWidth, false)
					for c := oldCol; c < cols; c++ {
						oldRow.SetCellFromCodepoint(c, 0, 1, curAttr)
					}
				}
			} else {
				buf.X = cols - 1
				// FIXME: check for xterm behavior
				if chWidth == 2 {
					continue
				}
			}
		}

		// insert combining char at last cursor position
		// this._activeBuffer.x should never be 0 for a combining char
		// since they always follow a cell consuming char
		// therefore we can test for buf.X to avoid overflow left
		if shouldJoin && buf.X > 0 {
			// if empty cell after fullwidth, need to go 2 cells back
			offset := 1
			if bufferRow.GetWidth(buf.X-1) == 0 {
				offset = 2
			}
			bufferRow.AddCodepointToCell(buf.X-offset, code, chWidth)
			continue
		}

		// insert mode: move characters to right
		if insertMode {
			// right shift cells according to the width
			bufferRow.InsertCells(buf.X, chWidth-oldWidth, buf.GetNullCell(curAttr))
			// test last cell - since the last cell has only room for
			// a halfwidth char any fullwidth shifted there is lost
			// and will be set to empty cell
			if bufferRow.GetWidth(cols-1) == 2 {
				bufferRow.SetCellFromCodepoint(cols-1, NullCellCode, NullCellWidth, curAttr)
			}
		}

		// write current char to buffer and advance cursor
		bufferRow.SetCellFromCodepoint(buf.X, code, chWidth, curAttr)
		buf.X++

		// fullwidth char - also set next cell to placeholder stub and advance cursor
		if chWidth > 0 {
			for chWidth--; chWidth > 0; chWidth-- {
				bufferRow.SetCellFromCodepoint(buf.X, 0, 0, curAttr)
				buf.X++
			}
		}
	}

	// Handle wide chars: reset cell to the right if it's a second cell of a wide char.
	if buf.X < cols && end-start > 0 && bufferRow.GetWidth(buf.X) == 0 && bufferRow.HasContent(buf.X) == 0 {
		bufferRow.SetCellFromCodepoint(buf.X, 0, 1, curAttr)
	}

	h.dirtyRowTracker.MarkDirty(buf.Y)
}

// Reset resets the input handler state.
func (h *InputHandler) Reset() {
	h.curAttrData = DefaultAttrData()
	h.eraseAttrDataInternal = DefaultAttrData()
}

// Dispose cleans up all event emitters.
func (h *InputHandler) Dispose() {
	h.parser.Dispose()
	h.OnCursorMoveEmitter.Dispose()
	h.OnTitleChangeEmitter.Dispose()
	h.OnIconNameChangeEmitter.Dispose()
	h.OnLineFeedEmitter.Dispose()
	h.OnA11yCharEmitter.Dispose()
	h.OnA11yTabEmitter.Dispose()
	h.OnRequestBellEmitter.Dispose()
	h.OnRequestResetEmitter.Dispose()
	h.OnRequestRefreshRowsEmitter.Dispose()
	h.OnColorEmitter.Dispose()
	h.OnRequestSendFocusEmitter.Dispose()
	h.OnRequestSyncScrollBarEmitter.Dispose()
	h.OnRequestColorSchemeQueryEmitter.Dispose()
	h.OnRequestWindowsOptionsReportEmitter.Dispose()
}
