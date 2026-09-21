package xterm

import (
	"fmt"
	"strings"
)

// titleStackLimit is the maximum number of entries in the title/icon name push
// stacks. Matches upstream xterm.js STACK_LIMIT (InputHandler.ts:47).
const titleStackLimit = 10

// moveCursor moves the cursor by a relative offset, clamping to valid range.
func (h *InputHandler) moveCursor(x, y int) {
	h.restrictCursor()
	h.setCursor(h.activeBuffer().X+x, h.activeBuffer().Y+y)
}

// eraseInBufferLine erases cells in a buffer line.
func (h *InputHandler) eraseInBufferLine(y, start, end int, clearWrap bool, respectProtect bool) {
	buf := h.activeBuffer()
	line := buf.Lines.Get(buf.YBase + y)
	if line == nil {
		return
	}
	line.ReplaceCells(start, end, buf.GetNullCell(h.eraseAttrData()), respectProtect)
	if clearWrap {
		line.IsWrapped = false
	}
}

// resetBufferLine resets an entire buffer line.
func (h *InputHandler) resetBufferLine(y int, respectProtect bool) {
	buf := h.activeBuffer()
	line := buf.Lines.Get(buf.YBase + y)
	if line != nil {
		line.Fill(buf.GetNullCell(h.eraseAttrData()), respectProtect)
		buf.ClearMarkers(buf.YBase + y)
		line.IsWrapped = false
	}
}

// --- Cursor movement ---

func (h *InputHandler) cursorUp(params *Params) bool {
	buf := h.activeBuffer()
	diffToTop := buf.Y - buf.ScrollTop
	n := max(int(params.Params[0]), 1)
	if diffToTop >= 0 {
		h.moveCursor(0, -min(diffToTop, n))
	} else {
		h.moveCursor(0, -n)
	}
	return true
}

func (h *InputHandler) cursorDown(params *Params) bool {
	buf := h.activeBuffer()
	diffToBottom := buf.ScrollBottom - buf.Y
	n := max(int(params.Params[0]), 1)
	if diffToBottom >= 0 {
		h.moveCursor(0, min(diffToBottom, n))
	} else {
		h.moveCursor(0, n)
	}
	return true
}

func (h *InputHandler) cursorForward(params *Params) bool {
	h.moveCursor(max(int(params.Params[0]), 1), 0)
	return true
}

func (h *InputHandler) cursorBackward(params *Params) bool {
	h.moveCursor(-max(int(params.Params[0]), 1), 0)
	return true
}

func (h *InputHandler) cursorNextLine(params *Params) bool {
	h.cursorDown(params)
	h.activeBuffer().X = 0
	return true
}

func (h *InputHandler) cursorPrecedingLine(params *Params) bool {
	h.cursorUp(params)
	h.activeBuffer().X = 0
	return true
}

func (h *InputHandler) cursorCharAbsolute(params *Params) bool {
	h.setCursor(max(int(params.Params[0]), 1)-1, h.activeBuffer().Y)
	return true
}

func (h *InputHandler) cursorPosition(params *Params) bool {
	col := 0
	if params.Length >= 2 {
		col = max(int(params.Params[1]), 1) - 1
	}
	row := max(int(params.Params[0]), 1) - 1
	h.setCursor(col, row)
	return true
}

func (h *InputHandler) charPosAbsolute(params *Params) bool {
	h.setCursor(max(int(params.Params[0]), 1)-1, h.activeBuffer().Y)
	return true
}

func (h *InputHandler) hPositionRelative(params *Params) bool {
	h.moveCursor(max(int(params.Params[0]), 1), 0)
	return true
}

func (h *InputHandler) linePosAbsolute(params *Params) bool {
	h.setCursor(h.activeBuffer().X, max(int(params.Params[0]), 1)-1)
	return true
}

func (h *InputHandler) vPositionRelative(params *Params) bool {
	h.moveCursor(0, max(int(params.Params[0]), 1))
	return true
}

func (h *InputHandler) hVPosition(params *Params) bool {
	return h.cursorPosition(params)
}

// --- Tab ---

func (h *InputHandler) cursorForwardTab(params *Params) bool {
	buf := h.activeBuffer()
	if buf.X >= h.bufferService.Cols {
		return true
	}
	n := max(int(params.Params[0]), 1)
	for n > 0 {
		buf.X = buf.NextStop(buf.X)
		n--
	}
	return true
}

func (h *InputHandler) cursorBackwardTab(params *Params) bool {
	buf := h.activeBuffer()
	if buf.X >= h.bufferService.Cols {
		return true
	}
	n := max(int(params.Params[0]), 1)
	for n > 0 {
		buf.X = buf.PrevStop(buf.X)
		n--
	}
	return true
}

func (h *InputHandler) tabClear(params *Params) bool {
	buf := h.activeBuffer()
	switch p := params.Params[0]; p {
	case 0:
		delete(buf.Tabs, buf.X)
	case 3:
		buf.Tabs = make(map[int]bool)
	}
	return true
}

// --- Erase ---

func (h *InputHandler) eraseInDisplay(params *Params) bool {
	return h.eraseInDisplayInternal(params, false)
}

func (h *InputHandler) eraseInDisplayProtected(params *Params) bool {
	return h.eraseInDisplayInternal(params, true)
}

func (h *InputHandler) eraseInDisplayInternal(params *Params, respectProtect bool) bool {
	h.restrictCursor(h.bufferService.Cols)
	buf := h.activeBuffer()
	switch params.Params[0] {
	case 0: // erase below
		j := buf.Y
		h.dirtyRowTracker.MarkDirty(j)
		h.eraseInBufferLine(j, buf.X, h.bufferService.Cols, buf.X == 0, respectProtect)
		j++
		for ; j < h.bufferService.Rows; j++ {
			h.resetBufferLine(j, respectProtect)
		}
		h.dirtyRowTracker.MarkDirty(j - 1)
	case 1: // erase above
		j := buf.Y
		h.dirtyRowTracker.MarkDirty(j)
		h.eraseInBufferLine(j, 0, buf.X+1, true, respectProtect)
		if buf.X+1 >= h.bufferService.Cols {
			nextLine := buf.Lines.Get(buf.YBase + j + 1)
			if nextLine != nil {
				nextLine.IsWrapped = false
			}
		}
		for j > 0 {
			j--
			h.resetBufferLine(j, respectProtect)
		}
		h.dirtyRowTracker.MarkDirty(0)
	case 2: // erase all
		j := h.bufferService.Rows
		h.dirtyRowTracker.MarkDirty(j - 1)
		for j > 0 {
			j--
			h.resetBufferLine(j, respectProtect)
		}
		h.dirtyRowTracker.MarkDirty(0)
	case 3: // erase scrollback
		scrollBackSize := buf.Lines.Length() - h.bufferService.Rows
		if scrollBackSize > 0 {
			buf.Lines.TrimStart(scrollBackSize)
			buf.YBase = max(buf.YBase-scrollBackSize, 0)
			buf.YDisp = max(buf.YDisp-scrollBackSize, 0)
		}
		if buf == h.bufferService.Buffers.Normal() {
			h.bufferService.IsUserScrolling = false
		}
	}
	return true
}

func (h *InputHandler) eraseInLine(params *Params) bool {
	return h.eraseInLineInternal(params, false)
}

func (h *InputHandler) eraseInLineProtected(params *Params) bool {
	return h.eraseInLineInternal(params, true)
}

func (h *InputHandler) eraseInLineInternal(params *Params, respectProtect bool) bool {
	h.restrictCursor(h.bufferService.Cols)
	buf := h.activeBuffer()
	switch params.Params[0] {
	case 0: // erase right
		h.eraseInBufferLine(buf.Y, buf.X, h.bufferService.Cols, buf.X == 0, respectProtect)
	case 1: // erase left
		h.eraseInBufferLine(buf.Y, 0, buf.X+1, false, respectProtect)
	case 2: // erase entire line
		h.eraseInBufferLine(buf.Y, 0, h.bufferService.Cols, true, respectProtect)
	}
	h.dirtyRowTracker.MarkDirty(buf.Y)
	return true
}

func (h *InputHandler) eraseChars(params *Params) bool {
	h.restrictCursor()
	buf := h.activeBuffer()
	line := buf.Lines.Get(buf.YBase + buf.Y)
	if line != nil {
		line.ReplaceCells(buf.X, buf.X+max(int(params.Params[0]), 1),
			buf.GetNullCell(h.eraseAttrData()), false)
		h.dirtyRowTracker.MarkDirty(buf.Y)
	}
	return true
}

// --- Insert / Delete ---

func (h *InputHandler) insertChars(params *Params) bool {
	h.restrictCursor()
	buf := h.activeBuffer()
	line := buf.Lines.Get(buf.YBase + buf.Y)
	if line != nil {
		line.InsertCells(buf.X, max(int(params.Params[0]), 1),
			buf.GetNullCell(h.eraseAttrData()))
		h.dirtyRowTracker.MarkDirty(buf.Y)
	}
	return true
}

func (h *InputHandler) deleteChars(params *Params) bool {
	h.restrictCursor()
	buf := h.activeBuffer()
	line := buf.Lines.Get(buf.YBase + buf.Y)
	if line != nil {
		line.DeleteCells(buf.X, max(int(params.Params[0]), 1),
			buf.GetNullCell(h.eraseAttrData()))
		h.dirtyRowTracker.MarkDirty(buf.Y)
	}
	return true
}

func (h *InputHandler) insertLines(params *Params) bool {
	h.restrictCursor()
	buf := h.activeBuffer()
	if buf.Y > buf.ScrollBottom || buf.Y < buf.ScrollTop {
		return true
	}
	n := max(int(params.Params[0]), 1)
	row := buf.YBase + buf.Y
	scrollBottomRowsOffset := h.bufferService.Rows - 1 - buf.ScrollBottom
	scrollBottomAbsolute := h.bufferService.Rows - 1 + buf.YBase - scrollBottomRowsOffset + 1
	for range n {
		buf.Lines.Splice(scrollBottomAbsolute-1, 1)
		buf.Lines.Splice(row, 0, buf.GetBlankLine(h.eraseAttrData(), false))
	}
	h.dirtyRowTracker.MarkRangeDirty(buf.Y, buf.ScrollBottom)
	buf.X = 0
	return true
}

func (h *InputHandler) deleteLines(params *Params) bool {
	h.restrictCursor()
	buf := h.activeBuffer()
	if buf.Y > buf.ScrollBottom || buf.Y < buf.ScrollTop {
		return true
	}
	n := max(int(params.Params[0]), 1)
	row := buf.YBase + buf.Y
	j := h.bufferService.Rows - 1 - buf.ScrollBottom
	j = h.bufferService.Rows - 1 + buf.YBase - j
	for range n {
		buf.Lines.Splice(row, 1)
		buf.Lines.Splice(j, 0, buf.GetBlankLine(h.eraseAttrData(), false))
	}
	h.dirtyRowTracker.MarkRangeDirty(buf.Y, buf.ScrollBottom)
	buf.X = 0
	return true
}

// --- Scroll ---

func (h *InputHandler) scrollUp(params *Params) bool {
	buf := h.activeBuffer()
	n := max(int(params.Params[0]), 1)
	for range n {
		buf.Lines.Splice(buf.YBase+buf.ScrollTop, 1)
		buf.Lines.Splice(buf.YBase+buf.ScrollBottom, 0, buf.GetBlankLine(h.eraseAttrData(), false))
	}
	h.dirtyRowTracker.MarkRangeDirty(buf.ScrollTop, buf.ScrollBottom)
	return true
}

func (h *InputHandler) scrollDown(params *Params) bool {
	buf := h.activeBuffer()
	n := max(int(params.Params[0]), 1)
	for range n {
		buf.Lines.Splice(buf.YBase+buf.ScrollBottom, 1)
		defAttr := DefaultAttrData()
		buf.Lines.Splice(buf.YBase+buf.ScrollTop, 0, buf.GetBlankLine(&defAttr, false))
	}
	h.dirtyRowTracker.MarkRangeDirty(buf.ScrollTop, buf.ScrollBottom)
	return true
}

func (h *InputHandler) scrollLeft(params *Params) bool {
	buf := h.activeBuffer()
	if buf.Y > buf.ScrollBottom || buf.Y < buf.ScrollTop {
		return true
	}
	n := max(int(params.Params[0]), 1)
	for y := buf.ScrollTop; y <= buf.ScrollBottom; y++ {
		line := buf.Lines.Get(buf.YBase + y)
		if line != nil {
			line.DeleteCells(0, n, buf.GetNullCell(h.eraseAttrData()))
			line.IsWrapped = false
		}
	}
	h.dirtyRowTracker.MarkRangeDirty(buf.ScrollTop, buf.ScrollBottom)
	return true
}

func (h *InputHandler) scrollRight(params *Params) bool {
	buf := h.activeBuffer()
	if buf.Y > buf.ScrollBottom || buf.Y < buf.ScrollTop {
		return true
	}
	n := max(int(params.Params[0]), 1)
	for y := buf.ScrollTop; y <= buf.ScrollBottom; y++ {
		line := buf.Lines.Get(buf.YBase + y)
		if line != nil {
			line.InsertCells(0, n, buf.GetNullCell(h.eraseAttrData()))
			line.IsWrapped = false
		}
	}
	h.dirtyRowTracker.MarkRangeDirty(buf.ScrollTop, buf.ScrollBottom)
	return true
}

func (h *InputHandler) insertColumns(params *Params) bool {
	buf := h.activeBuffer()
	if buf.Y > buf.ScrollBottom || buf.Y < buf.ScrollTop {
		return true
	}
	n := max(int(params.Params[0]), 1)
	for y := buf.ScrollTop; y <= buf.ScrollBottom; y++ {
		line := buf.Lines.Get(buf.YBase + y)
		if line != nil {
			line.InsertCells(buf.X, n, buf.GetNullCell(h.eraseAttrData()))
			line.IsWrapped = false
		}
	}
	h.dirtyRowTracker.MarkRangeDirty(buf.ScrollTop, buf.ScrollBottom)
	return true
}

func (h *InputHandler) deleteColumns(params *Params) bool {
	buf := h.activeBuffer()
	if buf.Y > buf.ScrollBottom || buf.Y < buf.ScrollTop {
		return true
	}
	n := max(int(params.Params[0]), 1)
	for y := buf.ScrollTop; y <= buf.ScrollBottom; y++ {
		line := buf.Lines.Get(buf.YBase + y)
		if line != nil {
			line.DeleteCells(buf.X, n, buf.GetNullCell(h.eraseAttrData()))
			line.IsWrapped = false
		}
	}
	h.dirtyRowTracker.MarkRangeDirty(buf.ScrollTop, buf.ScrollBottom)
	return true
}

// --- Repeat ---

func (h *InputHandler) repeatPrecedingCharacter(params *Params) bool {
	joinState := h.parser.PrecedingJoinState()
	if joinState == 0 {
		return true
	}
	n := max(int(params.Params[0]), 1)
	buf := h.activeBuffer()
	chWidth := ExtractCharPropsWidth(joinState)
	x := buf.X - chWidth
	if x < 0 {
		x = 0
	}
	bufferRow := buf.Lines.Get(buf.YBase + buf.Y)
	if bufferRow == nil {
		return true
	}
	text := bufferRow.GetString(x)
	data := make([]uint32, 0, len(text)*n)
	for _, r := range text {
		data = append(data, uint32(r))
	}
	idata := len(data)
	for i := 1; i < n; i++ {
		data = append(data, data[:idata]...)
	}
	h.Print(data, 0, len(data))
	return true
}

// --- Device attributes ---

func (h *InputHandler) sendDeviceAttributesPrimary(params *Params) bool {
	if params.Params[0] > 0 {
		return true
	}
	tn := h.optionsService.Options.TermName
	switch {
	case strings.HasPrefix(tn, "xterm"), strings.HasPrefix(tn, "rxvt-unicode"), strings.HasPrefix(tn, "screen"):
		h.coreService.TriggerDataEvent("\x1b[?1;2c", false, false)
	case strings.HasPrefix(tn, "linux"):
		h.coreService.TriggerDataEvent("\x1b[?6c", false, false)
	}
	return true
}

func (h *InputHandler) sendDeviceAttributesSecondary(params *Params) bool {
	if params.Params[0] > 0 {
		return true
	}
	tn := h.optionsService.Options.TermName
	switch {
	case strings.HasPrefix(tn, "xterm"):
		h.coreService.TriggerDataEvent("\x1b[>0;276;0c", false, false)
	case strings.HasPrefix(tn, "rxvt-unicode"):
		h.coreService.TriggerDataEvent("\x1b[>85;95;0c", false, false)
	case strings.HasPrefix(tn, "linux"):
		h.coreService.TriggerDataEvent(fmt.Sprintf("%dc", params.Params[0]), false, false)
	case strings.HasPrefix(tn, "screen"):
		h.coreService.TriggerDataEvent("\x1b[>83;40003;0c", false, false)
	}
	return true
}

// sendXtVersion responds to XTVERSION (CSI > q) with a DCS response.
func (h *InputHandler) sendXtVersion(params *Params) bool {
	if params.Params[0] > 0 {
		return true
	}
	h.coreService.TriggerDataEvent("\x1bP>|xterm-go(0.1.0)\x1b\\", false, false)
	return true
}

func (h *InputHandler) deviceStatus(params *Params) bool {
	buf := h.activeBuffer()
	switch params.Params[0] {
	case 5:
		h.coreService.TriggerDataEvent("\x1b[0n", false, false)
	case 6:
		y := buf.Y + 1
		x := buf.X + 1
		h.coreService.TriggerDataEvent(fmt.Sprintf("\x1b[%d;%dR", y, x), false, false)
	}
	return true
}

func (h *InputHandler) deviceStatusPrivate(params *Params) bool {
	buf := h.activeBuffer()
	switch params.Params[0] {
	case 6:
		y := buf.Y + 1
		x := buf.X + 1
		h.coreService.TriggerDataEvent(fmt.Sprintf("\x1b[?%d;%dR", y, x), false, false)
	case 996:
		if h.coreService.DecPrivateModes.ColorSchemeUpdates {
			h.OnRequestColorSchemeQueryEmitter.Fire(struct{}{})
		}
	}
	return true
}

// --- Soft reset ---

func (h *InputHandler) softReset(_ *Params) bool {
	h.coreService.IsCursorHidden = false
	h.OnRequestSyncScrollBarEmitter.Fire(struct{}{})
	buf := h.activeBuffer()
	buf.ScrollTop = 0
	buf.ScrollBottom = h.bufferService.Rows - 1
	h.curAttrData = DefaultAttrData()
	h.coreService.Reset()
	h.charsetService.Reset()
	buf.SavedState.X = 0
	buf.SavedState.Y = buf.YBase
	buf.SavedState.CurAttrData.Fg = h.curAttrData.Fg
	buf.SavedState.CurAttrData.Bg = h.curAttrData.Bg
	buf.SavedState.Charset = h.charsetService.Charset
	h.coreService.DecPrivateModes.Origin = false
	return true
}

// --- Cursor style ---

func (h *InputHandler) setCursorStyle(params *Params) bool {
	p := int32(1)
	if params.Length > 0 {
		p = params.Params[0]
	}
	if p == 0 {
		h.coreService.DecPrivateModes.CursorStyle = nil
		h.coreService.DecPrivateModes.CursorBlinkOverride = nil
	} else {
		var style CursorStyle
		switch p {
		case 1, 2:
			style = CursorStyleBlock
		case 3, 4:
			style = CursorStyleUnderline
		case 5, 6:
			style = CursorStyleBar
		default:
			style = CursorStyleBlock
		}
		h.coreService.DecPrivateModes.CursorStyle = &style
		isBlinking := p%2 == 1
		h.coreService.DecPrivateModes.CursorBlinkOverride = &isBlinking
	}
	return true
}

// --- Scroll region ---

func (h *InputHandler) setScrollRegion(params *Params) bool {
	top := max(int(params.Params[0]), 1)
	bottom := h.bufferService.Rows
	if params.Length >= 2 && params.Params[1] > 0 && int(params.Params[1]) <= h.bufferService.Rows {
		bottom = int(params.Params[1])
	}
	if bottom > top {
		buf := h.activeBuffer()
		buf.ScrollTop = top - 1
		buf.ScrollBottom = bottom - 1
		h.setCursor(0, 0)
	}
	return true
}

// --- Save/Restore cursor (CSI s / CSI u) ---

func (h *InputHandler) csiSaveCursor(_ *Params) bool {
	return h.SaveCursor()
}

func (h *InputHandler) csiRestoreCursor(_ *Params) bool {
	return h.RestoreCursor()
}

// --- Select character protection ---

func (h *InputHandler) selectProtected(params *Params) bool {
	p := params.Params[0]
	if p == 1 {
		h.curAttrData.Bg |= BgFlagProtected
	}
	if p == 2 || p == 0 {
		h.curAttrData.Bg &^= BgFlagProtected
	}
	return true
}

// --- Mode set/reset ---

func (h *InputHandler) setMode(params *Params) bool {
	for i := range params.Length {
		switch params.Params[i] {
		case 4:
			h.coreService.Modes.InsertMode = true
		case 20:
			h.optionsService.Options.ConvertEol = true
		}
	}
	return true
}

func (h *InputHandler) resetMode(params *Params) bool {
	for i := range params.Length {
		switch params.Params[i] {
		case 4:
			h.coreService.Modes.InsertMode = false
		case 20:
			h.optionsService.Options.ConvertEol = false
		}
	}
	return true
}

func (h *InputHandler) setModePrivate(params *Params) bool {
	for i := range params.Length {
		switch params.Params[i] {
		case 1:
			h.coreService.DecPrivateModes.ApplicationCursorKeys = true
		case 6:
			h.coreService.DecPrivateModes.Origin = true
			h.setCursor(0, 0)
		case 7:
			h.coreService.DecPrivateModes.Wraparound = true
		case 25:
			h.coreService.IsCursorHidden = false
		case 45:
			h.coreService.DecPrivateModes.ReverseWraparound = true
		case 66:
			h.coreService.DecPrivateModes.ApplicationKeypad = true
			h.OnRequestSyncScrollBarEmitter.Fire(struct{}{})
		case 9:
			h.coreService.DecPrivateModes.MouseTrackingMode = "X10"
		case 1000:
			h.coreService.DecPrivateModes.MouseTrackingMode = "VT200"
		case 1002:
			h.coreService.DecPrivateModes.MouseTrackingMode = "DRAG"
		case 1003:
			h.coreService.DecPrivateModes.MouseTrackingMode = "ANY"
		case 1004:
			h.coreService.DecPrivateModes.SendFocus = true
			h.OnRequestSendFocusEmitter.Fire(struct{}{})
		case 1006:
			h.coreService.DecPrivateModes.MouseEncoding = "SGR"
		case 1016:
			h.coreService.DecPrivateModes.MouseEncoding = "SGR_PIXELS"
		case 1048:
			h.SaveCursor()
		case 1049:
			h.SaveCursor()
			fallthrough
		case 47, 1047:
			// Swap kitty keyboard flags: save main, restore alt
			if h.optionsService.Options.VtExtensions.KittyKeyboard {
				kk := &h.coreService.KittyKeyboard
				kk.MainFlags = kk.Flags
				kk.Flags = kk.AltFlags
				kk.MainStack, kk.AltStack = kk.AltStack, kk.MainStack
			}
			h.bufferService.Buffers.ActivateAltBuffer(h.eraseAttrData())
			h.coreService.IsCursorInitialized = true
			h.OnRequestRefreshRowsEmitter.Fire(RowRange{})
			h.OnRequestSyncScrollBarEmitter.Fire(struct{}{})
		case 2004:
			h.coreService.DecPrivateModes.BracketedPasteMode = true
		case 2026:
			h.coreService.DecPrivateModes.SynchronizedOutput = true
		case 2031:
			if h.optionsService.Options.VtExtensions.colorSchemeQueryEnabled() {
				h.coreService.DecPrivateModes.ColorSchemeUpdates = true
			}
		case 9001:
			if h.optionsService.Options.VtExtensions.Win32InputMode {
				h.coreService.DecPrivateModes.Win32InputMode = true
			}
		}
	}
	return true
}

func (h *InputHandler) resetModePrivate(params *Params) bool {
	for i := range params.Length {
		switch params.Params[i] {
		case 1:
			h.coreService.DecPrivateModes.ApplicationCursorKeys = false
		case 6:
			h.coreService.DecPrivateModes.Origin = false
			h.setCursor(0, 0)
		case 7:
			h.coreService.DecPrivateModes.Wraparound = false
		case 25:
			h.coreService.IsCursorHidden = true
		case 45:
			h.coreService.DecPrivateModes.ReverseWraparound = false
		case 66:
			h.coreService.DecPrivateModes.ApplicationKeypad = false
			h.OnRequestSyncScrollBarEmitter.Fire(struct{}{})
		case 9, 1000, 1002, 1003:
			h.coreService.DecPrivateModes.MouseTrackingMode = "NONE"
		case 1004:
			h.coreService.DecPrivateModes.SendFocus = false
		case 1006:
			h.coreService.DecPrivateModes.MouseEncoding = "DEFAULT"
		case 1016:
			h.coreService.DecPrivateModes.MouseEncoding = "DEFAULT"
		case 1048:
			h.RestoreCursor()
		case 1049:
			// Swap kitty keyboard flags: save alt, restore main
			if h.optionsService.Options.VtExtensions.KittyKeyboard {
				kk := &h.coreService.KittyKeyboard
				kk.AltFlags = kk.Flags
				kk.Flags = kk.MainFlags
				kk.MainStack, kk.AltStack = kk.AltStack, kk.MainStack
			}
			h.bufferService.Buffers.ActivateNormalBuffer()
			h.RestoreCursor()
			h.coreService.IsCursorInitialized = true
			h.OnRequestRefreshRowsEmitter.Fire(RowRange{})
			h.OnRequestSyncScrollBarEmitter.Fire(struct{}{})
		case 47, 1047:
			// Swap kitty keyboard flags: save alt, restore main
			if h.optionsService.Options.VtExtensions.KittyKeyboard {
				kk := &h.coreService.KittyKeyboard
				kk.AltFlags = kk.Flags
				kk.Flags = kk.MainFlags
				kk.MainStack, kk.AltStack = kk.AltStack, kk.MainStack
			}
			h.bufferService.Buffers.ActivateNormalBuffer()
			h.coreService.IsCursorInitialized = true
			h.OnRequestRefreshRowsEmitter.Fire(RowRange{})
			h.OnRequestSyncScrollBarEmitter.Fire(struct{}{})
		case 2004:
			h.coreService.DecPrivateModes.BracketedPasteMode = false
		case 2026:
			h.coreService.DecPrivateModes.SynchronizedOutput = false
			h.OnRequestRefreshRowsEmitter.Fire(RowRange{})
		case 2031:
			if h.optionsService.Options.VtExtensions.colorSchemeQueryEnabled() {
				h.coreService.DecPrivateModes.ColorSchemeUpdates = false
			}
		case 9001:
			if h.optionsService.Options.VtExtensions.Win32InputMode {
				h.coreService.DecPrivateModes.Win32InputMode = false
			}
		}
	}
	return true
}

// requestMode handles DECRPM — DEC Private Mode Report and ANSI Mode Report.
// CSI Ps $ p (isPrivate=false) reports ANSI mode status.
// CSI ? Ps $ p (isPrivate=true) reports DEC private mode status.
// Response: CSI Ps ; Pm $ y (ANSI) or CSI ? Ps ; Pm $ y (private).
// Pm: 1=set, 2=reset, 0=not recognized.
func (h *InputHandler) requestMode(params *Params, isPrivate bool) bool {
	mode := int(params.Params[0])
	pm := 0 // not recognized

	if isPrivate {
		pm = h.privateModeSetting(mode)
	} else {
		pm = h.ansiModeSetting(mode)
	}

	var resp string
	if isPrivate {
		resp = fmt.Sprintf("\x1b[?%d;%d$y", mode, pm)
	} else {
		resp = fmt.Sprintf("\x1b[%d;%d$y", mode, pm)
	}
	h.coreService.TriggerDataEvent(resp, false, false)
	return true
}

// privateModeSetting returns the DECRPM Pm value for a DEC private mode.
func (h *InputHandler) privateModeSetting(mode int) int {
	dm := &h.coreService.DecPrivateModes
	switch mode {
	case 1:
		return boolToPm(dm.ApplicationCursorKeys)
	case 6:
		return boolToPm(dm.Origin)
	case 7:
		return boolToPm(dm.Wraparound)
	case 8:
		return 3 // DECARM: permanently set
	case 12:
		return boolToPm(h.optionsService.Options.CursorBlink)
	case 25:
		return boolToPm(!h.coreService.IsCursorHidden)
	case 45:
		return boolToPm(dm.ReverseWraparound)
	case 66:
		return boolToPm(dm.ApplicationKeypad)
	case 67:
		return 4 // DECBKM: permanently reset
	case 9:
		return boolToPm(dm.MouseTrackingMode == "X10")
	case 1000:
		return boolToPm(dm.MouseTrackingMode == "VT200")
	case 1002:
		return boolToPm(dm.MouseTrackingMode == "DRAG")
	case 1003:
		return boolToPm(dm.MouseTrackingMode == "ANY")
	case 1004:
		return boolToPm(dm.SendFocus)
	case 1005:
		return 4 // UTF-8 mouse: permanently reset
	case 1006:
		return boolToPm(dm.MouseEncoding == "SGR")
	case 1015:
		return 4 // urxvt mouse: permanently reset
	case 1016:
		return boolToPm(dm.MouseEncoding == "SGR_PIXELS")
	case 1048:
		return 1 // save cursor: always set
	case 47, 1047, 1049:
		return boolToPm(h.bufferService.Buffers.Active() == h.bufferService.Buffers.Alt())
	case 2004:
		return boolToPm(dm.BracketedPasteMode)
	case 2026:
		return boolToPm(dm.SynchronizedOutput)
	case 2031:
		if !h.optionsService.Options.VtExtensions.colorSchemeQueryEnabled() {
			return 0
		}
		return boolToPm(dm.ColorSchemeUpdates)
	case 9001:
		if !h.optionsService.Options.VtExtensions.Win32InputMode {
			return 0
		}
		return boolToPm(dm.Win32InputMode)
	default:
		return 0 // not recognized
	}
}

// ansiModeSetting returns the DECRPM Pm value for an ANSI mode.
func (h *InputHandler) ansiModeSetting(mode int) int {
	switch mode {
	case 2:
		return 4 // KAM: permanently reset
	case 4:
		return boolToPm(h.coreService.Modes.InsertMode)
	case 12:
		return 3 // SRM: permanently set
	case 20:
		return boolToPm(h.optionsService.Options.ConvertEol)
	default:
		return 0 // not recognized
	}
}

// boolToPm converts a boolean to a DECRPM Pm value (1=set, 2=reset).
func boolToPm(set bool) int {
	if set {
		return 1
	}
	return 2
}

// kittyKeyboardMaxStackSize is the maximum depth of the kitty keyboard flag stack.
const kittyKeyboardMaxStackSize = 10

// kittyKeyboardSet handles CSI = Ps ; Pm u — set kitty keyboard flags.
// Ps = flags value (default 0), Pm = mode: 1=set (OR), 2=clear (AND NOT), 3=assign (default 1).
func (h *InputHandler) kittyKeyboardSet(params *Params) bool {
	if !h.optionsService.Options.VtExtensions.KittyKeyboard {
		return true
	}
	kk := &h.coreService.KittyKeyboard
	flags := 0
	if params.Params[0] > 0 {
		flags = int(params.Params[0])
	}
	mode := 1
	if params.Length >= 2 && params.Params[1] > 0 {
		mode = int(params.Params[1])
	}
	switch mode {
	case 1:
		kk.Flags |= flags
	case 2:
		kk.Flags &^= flags
	case 3:
		kk.Flags = flags
	}
	return true
}

// kittyKeyboardQuery handles CSI ? u — query current kitty keyboard flags.
// Responds with CSI ? <flags> u.
func (h *InputHandler) kittyKeyboardQuery(params *Params) bool {
	if !h.optionsService.Options.VtExtensions.KittyKeyboard {
		return true
	}
	buf := h.activeBuffer()
	shouldScroll := buf.YBase != buf.YDisp
	h.coreService.TriggerDataEvent(fmt.Sprintf("\x1b[?%du", h.coreService.KittyKeyboard.Flags), false, shouldScroll)
	return true
}

// kittyKeyboardPush handles CSI > Ps u — push flags onto stack.
// Pushes current flags, then sets flags = Ps (default 0).
func (h *InputHandler) kittyKeyboardPush(params *Params) bool {
	if !h.optionsService.Options.VtExtensions.KittyKeyboard {
		return true
	}
	kk := &h.coreService.KittyKeyboard
	if len(kk.MainStack) < kittyKeyboardMaxStackSize {
		kk.MainStack = append(kk.MainStack, kk.Flags)
	}
	flags := 0
	if params.Params[0] > 0 {
		flags = int(params.Params[0])
	}
	kk.Flags = flags
	return true
}

// kittyKeyboardPop handles CSI < Ps u — pop flags from stack.
// Ps = number of entries to pop (default 1). Restores flags from the last popped entry.
// If stack is empty, sets flags = 0.
func (h *InputHandler) kittyKeyboardPop(params *Params) bool {
	if !h.optionsService.Options.VtExtensions.KittyKeyboard {
		return true
	}
	kk := &h.coreService.KittyKeyboard
	n := 1
	if params.Params[0] > 0 {
		n = int(params.Params[0])
	}
	for i := 0; i < n; i++ {
		if len(kk.MainStack) == 0 {
			kk.Flags = 0
			break
		}
		kk.Flags = kk.MainStack[len(kk.MainStack)-1]
		kk.MainStack = kk.MainStack[:len(kk.MainStack)-1]
	}
	return true
}

// --- Window manipulation (CSI Ps t) ---

// windowOptions handles CSI Ps ; Ps ; Ps t — window manipulation commands.
// Implements sub-commands 18 (report size), 22 (push title), and 23 (pop title).
func (h *InputHandler) windowOptions(params *Params) bool {
	if params.Length == 0 {
		return true
	}
	switch params.Params[0] {
	case 18:
		// Report terminal size in characters: CSI 8 ; rows ; cols t
		h.coreService.TriggerDataEvent(
			fmt.Sprintf("\x1b[8;%d;%dt", h.bufferService.Rows, h.bufferService.Cols),
			false, false,
		)
	case 22:
		// Push title onto stack.
		// Ps2: 0 = both icon+title, 1 = icon only, 2 = title only.
		ps2 := int32(0)
		if params.Length >= 2 {
			ps2 = params.Params[1]
		}
		if ps2 == 0 || ps2 == 2 {
			h.windowTitleStack = append(h.windowTitleStack, h.windowTitle)
			if len(h.windowTitleStack) > titleStackLimit {
				h.windowTitleStack = h.windowTitleStack[len(h.windowTitleStack)-titleStackLimit:]
			}
		}
		if ps2 == 0 || ps2 == 1 {
			h.iconNameStack = append(h.iconNameStack, h.iconName)
			if len(h.iconNameStack) > titleStackLimit {
				h.iconNameStack = h.iconNameStack[len(h.iconNameStack)-titleStackLimit:]
			}
		}
	case 23:
		// Pop title from stack.
		ps2 := int32(0)
		if params.Length >= 2 {
			ps2 = params.Params[1]
		}
		if ps2 == 0 || ps2 == 2 {
			if len(h.windowTitleStack) > 0 {
				title := h.windowTitleStack[len(h.windowTitleStack)-1]
				h.windowTitleStack = h.windowTitleStack[:len(h.windowTitleStack)-1]
				h.windowTitle = title
				h.OnTitleChangeEmitter.Fire(title)
			}
		}
		if ps2 == 0 || ps2 == 1 {
			if len(h.iconNameStack) > 0 {
				name := h.iconNameStack[len(h.iconNameStack)-1]
				h.iconNameStack = h.iconNameStack[:len(h.iconNameStack)-1]
				h.iconName = name
				h.OnIconNameChangeEmitter.Fire(name)
			}
		}
	case 14:
		// Report window size in pixels. Ps2 == 2 means cell size (handled by case 16 upstream),
		// otherwise report window size.
		ps2 := int32(0)
		if params.Length >= 2 {
			ps2 = params.Params[1]
		}
		if ps2 != 2 {
			h.OnRequestWindowsOptionsReportEmitter.Fire(GetWinSizePixels)
		}
	case 16:
		// Report cell size in pixels.
		h.OnRequestWindowsOptionsReportEmitter.Fire(GetCellSizePixels)
	default:
		// Other sub-commands are renderer-specific; silently ignore.
	}
	return true
}
