package xterm

// Ported from xterm.js src/common/WindowsMode.ts.

// updateWindowsModeWrappedState marks the current line as wrapped when the
// previous line's final cell contains a non-whitespace character.
func updateWindowsModeWrappedState(bufferService *BufferService) {
	buf := bufferService.Buffer()
	previousLine := buf.Lines.Get(buf.YBase + buf.Y - 1)
	currentLine := buf.Lines.Get(buf.YBase + buf.Y)
	if previousLine == nil || currentLine == nil {
		return
	}

	lastCodepoint := previousLine.GetCodePoint(bufferService.Cols - 1)
	currentLine.IsWrapped = lastCodepoint != NullCellCode && lastCodepoint != WhitespaceCellCode
}
