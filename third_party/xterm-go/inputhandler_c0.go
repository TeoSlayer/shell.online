package xterm

// Ported from xterm.js src/common/InputHandler.ts — C0 control code handlers.

// Bell (BEL, 0x07) — ring the bell.
func (h *InputHandler) Bell() {
	h.OnRequestBellEmitter.Fire(struct{}{})
}

// LineFeed (LF, 0x0A / VT, 0x0B / FF, 0x0C) — move cursor down one row, scrolling if needed.
func (h *InputHandler) LineFeed() {
	buf := h.activeBuffer()
	h.dirtyRowTracker.MarkDirty(buf.Y)

	if h.optionsService.Options.ConvertEol {
		buf.X = 0
	}

	buf.Y++
	if buf.Y == buf.ScrollBottom+1 {
		buf.Y--
		h.bufferService.Scroll(h.eraseAttrData(), false)
	} else if buf.Y >= h.bufferService.Rows {
		buf.Y = h.bufferService.Rows - 1
	} else {
		// Explicit line feed clears wrapped state of the new line.
		line := buf.Lines.Get(buf.YBase + buf.Y)
		if line != nil {
			line.IsWrapped = false
		}
	}

	// Prevent cursor from wrapping past end of line.
	if buf.X >= h.bufferService.Cols {
		buf.X--
	}

	h.dirtyRowTracker.MarkDirty(buf.Y)
	h.OnLineFeedEmitter.Fire(struct{}{})
}

// CarriageReturn (CR, 0x0D) — move cursor to column 0.
func (h *InputHandler) CarriageReturn() {
	h.activeBuffer().X = 0
}

// Backspace (BS, 0x08) — move cursor one position left.
// With reverse wraparound enabled, can undo soft line wraps.
func (h *InputHandler) Backspace() {
	buf := h.activeBuffer()

	if !h.coreService.DecPrivateModes.ReverseWraparound {
		h.restrictCursor()
		if buf.X > 0 {
			buf.X--
		}
		return
	}

	// Reverse wraparound enabled: allow cursor at x=cols.
	h.restrictCursor(h.bufferService.Cols)

	if buf.X > 0 {
		buf.X--
	} else if buf.X == 0 &&
		buf.Y > buf.ScrollTop &&
		buf.Y <= buf.ScrollBottom {
		// Reverse wrap: only undo soft wraps within scroll region.
		line := buf.Lines.Get(buf.YBase + buf.Y)
		if line != nil && line.IsWrapped {
			line.IsWrapped = false
			buf.Y--
			buf.X = h.bufferService.Cols - 1
			// Handle empty cell from early-wrapped wide char.
			prevLine := buf.Lines.Get(buf.YBase + buf.Y)
			if prevLine != nil && prevLine.HasWidth(buf.X) != 0 && prevLine.HasContent(buf.X) == 0 {
				buf.X--
			}
		}
	}

	h.restrictCursor()
}

// Tab (HT, 0x09) — move cursor to next tab stop.
func (h *InputHandler) Tab() {
	buf := h.activeBuffer()
	if buf.X >= h.bufferService.Cols {
		return
	}
	originalX := buf.X
	buf.X = buf.NextStop(buf.X)
	if h.optionsService.Options.ScreenReaderMode {
		h.OnA11yTabEmitter.Fire(buf.X - originalX)
	}
}

// ShiftOut (SO, 0x0E) — switch to G1 character set.
func (h *InputHandler) ShiftOut() {
	h.charsetService.SetgLevel(1)
}

// ShiftIn (SI, 0x0F) — switch to G0 character set.
func (h *InputHandler) ShiftIn() {
	h.charsetService.SetgLevel(0)
}
