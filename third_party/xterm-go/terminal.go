package xterm

// Ported from xterm.js src/headless/Terminal.ts and src/common/CoreTerminal.ts.
// Top-level Terminal that wires all services together and provides the public API.

import "strings"

// Option configures a Terminal.
type Option func(*TerminalOptions)

// WithCols sets the number of columns.
func WithCols(cols int) Option {
	return func(o *TerminalOptions) { o.Cols = cols }
}

// WithRows sets the number of rows.
func WithRows(rows int) Option {
	return func(o *TerminalOptions) { o.Rows = rows }
}

// WithScrollback sets the scrollback buffer size.
func WithScrollback(n int) Option {
	return func(o *TerminalOptions) { o.Scrollback = n }
}

// WithScreenReaderMode enables screen reader / accessibility mode.
func WithScreenReaderMode(on bool) Option {
	return func(o *TerminalOptions) { o.ScreenReaderMode = on }
}

// WithMouseEventsRequireAlt requires Alt for mouse event reporting.
func WithMouseEventsRequireAlt(on bool) Option {
	return func(o *TerminalOptions) { o.MouseEventsRequireAlt = on }
}

// WithWindowOptions configures which CSI t sub-commands are permitted.
func WithWindowOptions(wo WindowOptions) Option {
	return func(o *TerminalOptions) { o.WindowOptions = wo }
}

// WithVtExtensions configures non-standard VT extensions.
func WithVtExtensions(ext VtExtensions) Option {
	return func(o *TerminalOptions) { o.VtExtensions = ext }
}

// WithWindowsPty configures Windows pseudo-terminal compatibility behavior.
func WithWindowsPty(wp WindowsPty) Option {
	return func(o *TerminalOptions) { o.WindowsPty = wp }
}

// Terminal is a headless terminal emulator.
type Terminal struct {
	optionsService    *OptionsService
	bufferService     *BufferService
	charsetService    *CharsetService
	coreService       *CoreService
	mouseStateService *MouseStateService
	oscLinkService    *OscLinkService
	unicodeService    *UnicodeService
	inputHandler      *InputHandler
	isDisposed        bool

	windowsWrappingHeuristics  MutableDisposable
	windowsPtyOptionDisposable Disposable

	// Public event emitters (forwarded from sub-components).
	OnBellEmitter                        EventEmitter[struct{}]
	OnTitleChangeEmitter                 EventEmitter[string]
	OnIconNameChangeEmitter              EventEmitter[string]
	OnLineFeedEmitter                    EventEmitter[struct{}]
	OnCursorMoveEmitter                  EventEmitter[struct{}]
	OnResizeEmitter                      EventEmitter[BufferResizeEvent]
	OnScrollEmitter                      EventEmitter[int]
	OnRenderEmitter                      EventEmitter[RowRange]
	OnWriteParsedEmitter                 EventEmitter[struct{}]
	OnRequestSendFocusEmitter            EventEmitter[struct{}]
	OnRequestColorSchemeQueryEmitter     EventEmitter[struct{}]
	OnRequestWindowsOptionsReportEmitter EventEmitter[WindowsOptionsReportType]
}

// New creates a new Terminal with the given options.
func New(opts ...Option) *Terminal {
	termOpts := DefaultOptions()
	for _, fn := range opts {
		fn(&termOpts)
	}

	optsSvc := NewOptionsService(&termOpts)
	bufSvc := NewBufferService(optsSvc)
	charSvc := NewCharsetService()
	coreSvc := NewCoreService(optsSvc)
	mouseSvc := NewMouseStateService()
	oscLinkSvc := NewOscLinkService(bufSvc)
	uniSvc := NewUnicodeService()
	ih := NewInputHandler(bufSvc, charSvc, coreSvc, optsSvc, oscLinkSvc, uniSvc)

	t := &Terminal{
		optionsService:    optsSvc,
		bufferService:     bufSvc,
		charsetService:    charSvc,
		coreService:       coreSvc,
		mouseStateService: mouseSvc,
		oscLinkService:    oscLinkSvc,
		unicodeService:    uniSvc,
		inputHandler:      ih,
	}

	// Forward input handler events.
	ih.OnRequestBellEmitter.Event(func(struct{}) { t.OnBellEmitter.Fire(struct{}{}) })
	ih.OnTitleChangeEmitter.Event(func(s string) { t.OnTitleChangeEmitter.Fire(s) })
	ih.OnIconNameChangeEmitter.Event(func(s string) { t.OnIconNameChangeEmitter.Fire(s) })
	ih.OnLineFeedEmitter.Event(func(struct{}) { t.OnLineFeedEmitter.Fire(struct{}{}) })
	ih.OnCursorMoveEmitter.Event(func(struct{}) { t.OnCursorMoveEmitter.Fire(struct{}{}) })
	ih.OnRequestRefreshRowsEmitter.Event(func(r RowRange) { t.OnRenderEmitter.Fire(r) })
	ih.OnRequestSendFocusEmitter.Event(func(struct{}) { t.OnRequestSendFocusEmitter.Fire(struct{}{}) })
	ih.OnRequestColorSchemeQueryEmitter.Event(func(struct{}) { t.OnRequestColorSchemeQueryEmitter.Fire(struct{}{}) })
	ih.OnRequestWindowsOptionsReportEmitter.Event(func(rt WindowsOptionsReportType) { t.OnRequestWindowsOptionsReportEmitter.Fire(rt) })

	// Forward buffer service events.
	bufSvc.OnResizeEmitter.Event(func(e BufferResizeEvent) { t.OnResizeEmitter.Fire(e) })
	bufSvc.OnScrollEmitter.Event(func(pos int) { t.OnScrollEmitter.Fire(pos) })

	// Forward core service data events (response data from DA, DSR, etc.).
	// No additional wiring needed — coreService.OnDataEmitter is the canonical source.

	// Handle reset requests from input handler (ESC c).
	ih.OnRequestResetEmitter.Event(func(struct{}) { t.Reset() })

	// Legacy ConPTY versions do not report wrapped lines, so infer them from
	// line feeds and cursor-position sequences while the affected mode is active.
	t.windowsPtyOptionDisposable = optsSvc.OnSpecificOptionChange("windowsPty", t.handleWindowsPtyOptionChange)
	t.handleWindowsPtyOptionChange()

	return t
}

func (t *Terminal) handleWindowsPtyOptionChange() {
	if t.optionsService.Options.WindowsPty.windowsPtyMode() {
		t.enableWindowsWrappingHeuristics()
		return
	}
	t.windowsWrappingHeuristics.Clear()
}

func (t *Terminal) enableWindowsWrappingHeuristics() {
	if t.windowsWrappingHeuristics.Value() != nil {
		return
	}

	lineFeedDisposable := t.OnLineFeed(func() {
		updateWindowsModeWrappedState(t.bufferService)
	})
	cursorPositionDisposable := t.RegisterCsiHandler(FunctionIdentifier{Final: 'H'}, func(*Params) bool {
		updateWindowsModeWrappedState(t.bufferService)
		return false
	})
	t.windowsWrappingHeuristics.SetValue(CombinedDisposable(lineFeedDisposable, cursorPositionDisposable))
}

// Write writes data to the terminal, implementing io.Writer.
func (t *Terminal) Write(p []byte) (n int, err error) {
	if t.isDisposed {
		return len(p), nil
	}
	t.inputHandler.Parse(p)
	t.OnWriteParsedEmitter.Fire(struct{}{})
	return len(p), nil
}

// WriteString writes a string to the terminal.
func (t *Terminal) WriteString(s string) {
	if t.isDisposed {
		return
	}
	t.inputHandler.ParseString(s)
	t.OnWriteParsedEmitter.Fire(struct{}{})
}

// Resize changes the terminal dimensions.
func (t *Terminal) Resize(cols, rows int) {
	if cols < MinimumCols {
		cols = MinimumCols
	}
	if rows < MinimumRows {
		rows = MinimumRows
	}
	if cols == t.bufferService.Cols && rows == t.bufferService.Rows {
		return
	}
	t.optionsService.Options.Cols = cols
	t.optionsService.Options.Rows = rows
	t.bufferService.Resize(cols, rows)
}

// Reset performs a full terminal reset.
func (t *Terminal) Reset() {
	t.optionsService.Options.Rows = t.bufferService.Rows
	t.optionsService.Options.Cols = t.bufferService.Cols
	t.inputHandler.Reset()
	t.bufferService.Reset()
	t.charsetService.Reset()
	t.coreService.Reset()
	t.mouseStateService.Reset()
}

// Cols returns the number of columns.
func (t *Terminal) Cols() int { return t.bufferService.Cols }

// Rows returns the number of rows.
func (t *Terminal) Rows() int { return t.bufferService.Rows }

// CursorX returns the cursor column (0-based).
func (t *Terminal) CursorX() int { return t.bufferService.Buffer().X }

// CursorY returns the cursor row (0-based, relative to viewport).
func (t *Terminal) CursorY() int { return t.bufferService.Buffer().Y }

// Buffer returns the active buffer (for advanced access).
func (t *Terminal) Buffer() *Buffer { return t.bufferService.Buffer() }

// CharsetState returns the active G-set designations for snapshot serialization.
// The returned charset maps are read-only, like Buffer's saved charset state.
func (t *Terminal) CharsetState() ([]Charset, int) {
	return append([]Charset(nil), t.charsetService.Charsets()...), t.charsetService.GLevel
}

// GetLine returns the content of a viewport line as a string.
// Returns "" if y is out of range.
func (t *Terminal) GetLine(y int) string {
	buf := t.bufferService.Buffer()
	if y < 0 || y >= t.bufferService.Rows {
		return ""
	}
	line := buf.Lines.Get(buf.YBase + y)
	if line == nil {
		return ""
	}
	return line.TranslateToString(true, 0, -1)
}

// String returns the entire visible viewport as a string.
// Trailing blank lines are trimmed. Each line has trailing whitespace trimmed.
func (t *Terminal) String() string {
	rows := t.bufferService.Rows
	lines := make([]string, rows)
	for i := range rows {
		lines[i] = t.GetLine(i)
	}
	// Trim trailing empty lines.
	last := rows - 1
	for last >= 0 && lines[last] == "" {
		last--
	}
	return strings.Join(lines[:last+1], "\n")
}

// TriggerMouseEvent dispatches a mouse event through the active tracking protocol
// and encoding. Returns true if the event was accepted and sent via the data event.
// The active protocol is determined by DecPrivateModes.MouseTrackingMode and the
// active encoding by DecPrivateModes.MouseEncoding.
func (t *Terminal) TriggerMouseEvent(ev CoreMouseEvent) bool {
	// Sync the mouse state service with the current DEC private modes.
	dm := t.coreService.DecPrivateModes
	t.mouseStateService.SetActiveProtocol(dm.MouseTrackingMode)
	if dm.MouseEncoding != "" {
		t.mouseStateService.SetActiveEncoding(dm.MouseEncoding)
	}
	if t.optionsService.Options.MouseEventsRequireAlt && ev.Button != MouseButtonWheel {
		if !ev.Alt {
			return false
		}
		ev.Alt = false
	}

	encoded, ok := t.mouseStateService.TriggerMouseEvent(ev)
	if !ok {
		return false
	}

	buf := t.bufferService.Buffer()
	shouldScroll := buf.YBase != buf.YDisp
	t.coreService.TriggerDataEvent(encoded, false, shouldScroll)
	return true
}

// OnData registers a callback for data sent from the terminal (e.g. DA responses).
func (t *Terminal) OnData(fn func(string)) Disposable {
	return t.coreService.OnDataEmitter.Event(fn)
}

// OnBinary subscribes to binary data events from the terminal.
func (t *Terminal) OnBinary(fn func(string)) Disposable {
	return t.coreService.OnBinaryEmitter.Event(func(data string) { fn(data) })
}

// OnWriteParsed subscribes to write-parsed events.
// Fires after each Write/WriteString call completes parsing.
func (t *Terminal) OnWriteParsed(fn func()) Disposable {
	return t.OnWriteParsedEmitter.Event(func(struct{}) { fn() })
}

// OnBell registers a callback for bell events.
func (t *Terminal) OnBell(fn func()) Disposable {
	return t.OnBellEmitter.Event(func(struct{}) { fn() })
}

// OnTitleChange registers a callback for title change events.
func (t *Terminal) OnTitleChange(fn func(string)) Disposable {
	return t.OnTitleChangeEmitter.Event(fn)
}

// IconName returns the current icon name set via OSC 1 or OSC 0.
func (t *Terminal) IconName() string { return t.inputHandler.iconName }

// OnIconNameChange registers a callback for icon name change events.
func (t *Terminal) OnIconNameChange(fn func(string)) Disposable {
	return t.OnIconNameChangeEmitter.Event(fn)
}

// OnLineFeed registers a callback for line feed events.
func (t *Terminal) OnLineFeed(fn func()) Disposable {
	return t.OnLineFeedEmitter.Event(func(struct{}) { fn() })
}

// OnCursorMove registers a callback for cursor move events.
func (t *Terminal) OnCursorMove(fn func()) Disposable {
	return t.OnCursorMoveEmitter.Event(func(struct{}) { fn() })
}

// OnResize registers a callback for terminal resize events.
func (t *Terminal) OnResize(fn func(BufferResizeEvent)) Disposable {
	return t.OnResizeEmitter.Event(fn)
}

// OnScroll registers a callback for scroll events.
func (t *Terminal) OnScroll(fn func(int)) Disposable {
	return t.OnScrollEmitter.Event(fn)
}

// OnRender registers a callback fired when terminal rows are dirty.
func (t *Terminal) OnRender(fn func(RowRange)) Disposable {
	return t.OnRenderEmitter.Event(fn)
}

// OnRequestSendFocus subscribes to focus-reporting enable events (DECSET 1004).
// Fired when the application enables focus tracking so the host can immediately
// report the current focus state.
func (t *Terminal) OnRequestSendFocus(fn func()) Disposable {
	return t.OnRequestSendFocusEmitter.Event(func(struct{}) { fn() })
}

// OnRequestColorSchemeQuery subscribes to DSR 996 color scheme query events.
// Fired when the client sends CSI ? 996 n while color scheme updates (DECSET 2031) are enabled.
func (t *Terminal) OnRequestColorSchemeQuery(fn func()) Disposable {
	return t.OnRequestColorSchemeQueryEmitter.Event(func(struct{}) { fn() })
}

// OnRequestWindowsOptionsReport subscribes to window-options report requests (CSI 14 t, CSI 16 t).
func (t *Terminal) OnRequestWindowsOptionsReport(fn func(WindowsOptionsReportType)) Disposable {
	return t.OnRequestWindowsOptionsReportEmitter.Event(fn)
}

// OnColor subscribes to color palette query/set/restore events (OSC 4/10/11/12).
func (t *Terminal) OnColor(fn func([]ColorEvent)) Disposable {
	return t.inputHandler.OnColorEmitter.Event(fn)
}

// OnA11yChar subscribes to accessibility character announcements.
func (t *Terminal) OnA11yChar(fn func(string)) Disposable {
	return t.inputHandler.OnA11yCharEmitter.Event(fn)
}

// OnA11yTab subscribes to accessibility tab movement announcements.
func (t *Terminal) OnA11yTab(fn func(int)) Disposable {
	return t.inputHandler.OnA11yTabEmitter.Event(fn)
}

// RegisterApcHandler registers a handler for APC escape sequences.
// id identifies the APC function by its final character (e.g., Final: 'G' for Kitty graphics).
func (t *Terminal) RegisterApcHandler(id FunctionIdentifier, handler func(data string) bool) Disposable {
	return t.inputHandler.parser.RegisterApcHandler(id, NewApcStringHandler(handler))
}

// RegisterCsiHandler registers a custom handler for a CSI escape sequence.
// The handler returns true to stop the handler chain from bubbling further.
// For CSI t (window options), the handler is wrapped with a permission check
// against the terminal's WindowOptions configuration.
func (t *Terminal) RegisterCsiHandler(id FunctionIdentifier, handler CsiHandler) Disposable {
	if id.Final == 't' && id.Prefix == 0 && id.Intermediates == "" {
		return t.inputHandler.parser.RegisterCsiHandler(id, func(params *Params) bool {
			if !paramToWindowOption(params.Params[0], t.optionsService.Options.WindowOptions) {
				return true
			}
			return handler(params)
		})
	}
	return t.inputHandler.parser.RegisterCsiHandler(id, handler)
}

// RegisterEscHandler registers a custom handler for an ESC escape sequence.
// The handler returns true to stop the handler chain from bubbling further.
func (t *Terminal) RegisterEscHandler(id FunctionIdentifier, handler EscHandler) Disposable {
	return t.inputHandler.parser.RegisterEscHandler(id, handler)
}

// RegisterDcsHandler registers a custom handler for a DCS escape sequence.
func (t *Terminal) RegisterDcsHandler(id FunctionIdentifier, handler DcsHandler) Disposable {
	return t.inputHandler.parser.RegisterDcsHandler(id, handler)
}

// RegisterOscHandler registers a custom handler for an OSC escape sequence.
func (t *Terminal) RegisterOscHandler(ident int, handler OscHandler) Disposable {
	return t.inputHandler.parser.RegisterOscHandler(ident, handler)
}

// NormalBuffer returns the normal (primary) buffer.
func (t *Terminal) NormalBuffer() *Buffer { return t.bufferService.Buffers.Normal() }

// AltBuffer returns the alternate buffer.
func (t *Terminal) AltBuffer() *Buffer { return t.bufferService.Buffers.Alt() }

// IsAltBufferActive returns true if the alternate buffer is active.
func (t *Terminal) IsAltBufferActive() bool {
	return t.bufferService.Buffer() == t.bufferService.Buffers.Alt()
}

// CurAttrData returns the current cursor attribute data from the input handler.
func (t *Terminal) CurAttrData() AttributeData { return t.inputHandler.curAttrData }

// Modes returns the current ANSI modes.
func (t *Terminal) Modes() Modes { return t.coreService.Modes }

// DecPrivateModes returns the current DEC private modes.
func (t *Terminal) DecPrivateModes() DecPrivateModes { return t.coreService.DecPrivateModes }

// IsCursorHidden returns whether the cursor is hidden (DECTCEM).
func (t *Terminal) IsCursorHidden() bool { return t.coreService.IsCursorHidden }

// ScrollTop returns the top of the scroll region (0-based).
func (t *Terminal) ScrollTop() int { return t.bufferService.Buffer().ScrollTop }

// ScrollBottom returns the bottom of the scroll region (0-based).
func (t *Terminal) ScrollBottom() int { return t.bufferService.Buffer().ScrollBottom }

// ScrollLines scrolls the viewport by disp lines (negative = up, positive = down).
func (t *Terminal) ScrollLines(disp int) {
	t.bufferService.ScrollLines(disp, false)
}

// ScrollPages scrolls the viewport by pageCount pages.
func (t *Terminal) ScrollPages(pageCount int) {
	t.ScrollLines(pageCount * t.bufferService.Rows)
}

// ScrollToTop scrolls the viewport to the top of the scrollback.
func (t *Terminal) ScrollToTop() {
	t.ScrollLines(-t.bufferService.Buffer().YDisp)
}

// ScrollToBottom scrolls the viewport to the bottom (latest output).
func (t *Terminal) ScrollToBottom() {
	t.ScrollLines(t.bufferService.Buffer().YBase - t.bufferService.Buffer().YDisp)
}

// ScrollToLine scrolls the viewport so that the given line is at the top.
func (t *Terminal) ScrollToLine(line int) {
	t.ScrollLines(line - t.bufferService.Buffer().YDisp)
}

// Clear clears the viewport and scrollback buffer, preserving the line the
// cursor is on. Ported from xterm.js src/headless/Terminal.ts clear().
func (t *Terminal) Clear() {
	buf := t.bufferService.Buffer()
	buf.ClearAllMarkers()

	// Copy the current cursor line to position 0.
	buf.Lines.Set(0, buf.Lines.Get(buf.YBase+buf.Y))
	buf.Lines.SetLength(1)

	// Reset scroll and cursor positions.
	buf.YDisp = 0
	buf.YBase = 0
	buf.Y = 0

	// Fill remaining viewport rows with blank lines.
	for i := 1; i < t.bufferService.Rows; i++ {
		buf.Lines.Push(buf.GetBlankLine(nil, false))
	}

	t.OnScrollEmitter.Fire(buf.YDisp)
}

// RegisterMarker creates a marker at the cursor position plus the given offset.
func (t *Terminal) RegisterMarker(cursorYOffset int) *Marker {
	buf := t.bufferService.Buffer()
	return buf.AddMarker(buf.YBase + buf.Y + cursorYOffset)
}

// AddMarker creates a marker at the cursor position plus the given offset.
func (t *Terminal) AddMarker(cursorYOffset int) *Marker {
	return t.RegisterMarker(cursorYOffset)
}

// Scrollback returns the scrollback buffer size.
func (t *Terminal) Scrollback() int { return t.optionsService.Options.Scrollback }

// Dispose cleans up all resources.
func (t *Terminal) Dispose() {
	if t.isDisposed {
		return
	}
	t.isDisposed = true
	if t.windowsPtyOptionDisposable != nil {
		t.windowsPtyOptionDisposable.Dispose()
	}
	t.windowsWrappingHeuristics.Dispose()
	t.inputHandler.Dispose()
	t.coreService.Dispose()
	t.mouseStateService.Dispose()
	t.OnBellEmitter.Dispose()
	t.OnTitleChangeEmitter.Dispose()
	t.OnIconNameChangeEmitter.Dispose()
	t.OnLineFeedEmitter.Dispose()
	t.OnCursorMoveEmitter.Dispose()
	t.OnResizeEmitter.Dispose()
	t.OnScrollEmitter.Dispose()
	t.OnRenderEmitter.Dispose()
	t.OnWriteParsedEmitter.Dispose()
	t.OnRequestSendFocusEmitter.Dispose()
	t.OnRequestColorSchemeQueryEmitter.Dispose()
	t.OnRequestWindowsOptionsReportEmitter.Dispose()
}
