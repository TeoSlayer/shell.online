package xterm

// Ported from xterm.js src/common/InputHandler.ts — ESC sequence handlers.

// ESC handler wrappers (return bool for the parser chain).

func (h *InputHandler) escSaveCursor() bool    { return h.SaveCursor() }
func (h *InputHandler) escRestoreCursor() bool { return h.RestoreCursor() }
func (h *InputHandler) escIndex() bool         { return h.Index() }
func (h *InputHandler) escNextLine() bool      { return h.NextLine() }
func (h *InputHandler) escTabSet() bool        { return h.TabSet() }
func (h *InputHandler) escReverseIndex() bool  { return h.ReverseIndex() }
func (h *InputHandler) escFullReset() bool     { return h.FullReset() }

func (h *InputHandler) escKeypadApplicationMode() bool  { return h.KeypadApplicationMode() }
func (h *InputHandler) escKeypadNumericMode() bool      { return h.KeypadNumericMode() }
func (h *InputHandler) escSelectDefaultCharset() bool   { return h.SelectDefaultCharset() }
func (h *InputHandler) escScreenAlignmentPattern() bool { return h.ScreenAlignmentPattern() }

// SaveCursor (ESC 7 / DECSC) — save cursor position, attributes, charset state.
func (h *InputHandler) SaveCursor() bool {
	buf := h.activeBuffer()
	buf.SavedState.X = buf.X
	buf.SavedState.Y = buf.YBase + buf.Y
	buf.SavedState.CurAttrData = h.curAttrData.Clone()
	buf.SavedState.Charset = h.charsetService.Charset
	charsets := h.charsetService.Charsets()
	buf.SavedState.Charsets = make([]Charset, len(charsets))
	copy(buf.SavedState.Charsets, charsets)
	buf.SavedState.GLevel = h.charsetService.GLevel
	buf.SavedState.OriginMode = h.coreService.DecPrivateModes.Origin
	buf.SavedState.WraparoundMode = h.coreService.DecPrivateModes.Wraparound
	return true
}

// RestoreCursor (ESC 8 / DECRC) — restore saved cursor state.
func (h *InputHandler) RestoreCursor() bool {
	buf := h.activeBuffer()
	buf.X = buf.SavedState.X
	buf.Y = max(buf.SavedState.Y-buf.YBase, 0)
	h.curAttrData.Fg = buf.SavedState.CurAttrData.Fg
	h.curAttrData.Bg = buf.SavedState.CurAttrData.Bg
	for i, cs := range buf.SavedState.Charsets {
		h.charsetService.SetgCharset(i, cs)
	}
	h.charsetService.SetgLevel(buf.SavedState.GLevel)
	h.coreService.DecPrivateModes.Origin = buf.SavedState.OriginMode
	h.coreService.DecPrivateModes.Wraparound = buf.SavedState.WraparoundMode
	h.restrictCursor()
	return true
}

// Index (ESC D / IND) — move cursor down one line, scroll if at bottom of scroll region.
func (h *InputHandler) Index() bool {
	buf := h.activeBuffer()
	h.restrictCursor()
	buf.Y++
	if buf.Y == buf.ScrollBottom+1 {
		buf.Y--
		h.bufferService.Scroll(h.eraseAttrData(), false)
	} else if buf.Y >= h.bufferService.Rows {
		buf.Y = h.bufferService.Rows - 1
	}
	h.restrictCursor()
	return true
}

// ReverseIndex (ESC M / RI) — move cursor up one line, scroll down if at top of scroll region.
func (h *InputHandler) ReverseIndex() bool {
	buf := h.activeBuffer()
	h.restrictCursor()
	if buf.Y == buf.ScrollTop {
		scrollRegionHeight := buf.ScrollBottom - buf.ScrollTop
		buf.Lines.ShiftElements(buf.YBase+buf.Y, scrollRegionHeight, 1)
		buf.Lines.Set(buf.YBase+buf.Y, buf.GetBlankLine(h.eraseAttrData(), false))
		h.dirtyRowTracker.MarkRangeDirty(buf.ScrollTop, buf.ScrollBottom)
	} else {
		buf.Y--
		h.restrictCursor()
	}
	return true
}

// NextLine (ESC E / NEL) — CR + LF.
func (h *InputHandler) NextLine() bool {
	h.activeBuffer().X = 0
	h.Index()
	return true
}

// TabSet (ESC H / HTS) — set a tab stop at the current cursor column.
func (h *InputHandler) TabSet() bool {
	buf := h.activeBuffer()
	buf.Tabs[buf.X] = true
	return true
}

// KeypadApplicationMode (ESC =) — enable application keypad mode.
func (h *InputHandler) KeypadApplicationMode() bool {
	h.coreService.DecPrivateModes.ApplicationKeypad = true
	h.OnRequestSyncScrollBarEmitter.Fire(struct{}{})
	return true
}

// KeypadNumericMode (ESC >) — enable numeric keypad mode.
func (h *InputHandler) KeypadNumericMode() bool {
	h.coreService.DecPrivateModes.ApplicationKeypad = false
	h.OnRequestSyncScrollBarEmitter.Fire(struct{}{})
	return true
}

// FullReset (ESC c / RIS) — complete terminal reset.
func (h *InputHandler) FullReset() bool {
	h.parser.Reset()
	h.OnRequestResetEmitter.Fire(struct{}{})
	return true
}

// SetgLevel sets the active GL level (ESC n/o/|/}/~).
func (h *InputHandler) SetgLevel(level int) bool {
	h.charsetService.SetgLevel(level)
	return true
}

// SelectCharset designates a charset to a G-set (ESC ( ) * + - . / <flag>).
func (h *InputHandler) SelectCharset(collectAndFlag string) bool {
	if len(collectAndFlag) != 2 {
		h.SelectDefaultCharset()
		return true
	}
	if collectAndFlag[0] == '/' {
		return true // unsupported
	}
	g, ok := glevelMap[collectAndFlag[0]]
	if !ok {
		return true
	}
	cs, exists := CHARSETS[collectAndFlag[1]]
	if !exists {
		cs = nil // default US ASCII
	}
	h.charsetService.SetgCharset(g, cs)
	return true
}

// SelectDefaultCharset (ESC % @ / ESC % G) — select default (US ASCII) charset.
func (h *InputHandler) SelectDefaultCharset() bool {
	h.charsetService.SetgLevel(0)
	h.charsetService.SetgCharset(0, nil) // nil = US ASCII default
	return true
}

// ScreenAlignmentPattern (ESC # 8 / DECALN) — fill screen with 'E'.
func (h *InputHandler) ScreenAlignmentPattern() bool {
	cell := &CellData{}
	cell.Content = 1<<ContentWidthShift | uint32('E')
	cell.Fg = h.curAttrData.Fg
	cell.Bg = h.curAttrData.Bg

	buf := h.activeBuffer()
	h.setCursor(0, 0)

	for yOffset := range h.bufferService.Rows {
		row := buf.YBase + buf.Y + yOffset
		line := buf.Lines.Get(row)
		if line != nil {
			line.Fill(cell, false)
			line.IsWrapped = false
		}
	}

	h.dirtyRowTracker.MarkAllDirty()
	h.setCursor(0, 0)
	return true
}
