package xterm

// Ported from xterm.js src/common/buffer/BufferReflow.ts.

// NewLayoutResult holds the result of reflowLargerCreateNewLayout.
type NewLayoutResult struct {
	layout       []int
	countRemoved int
}

// reflowLargerGetLinesToRemove evaluates wrapped lines and returns pairs of
// [startIndex, count] for lines that can be removed after a reflow to larger width.
func reflowLargerGetLinesToRemove(lines *CircularList[*BufferLine], oldCols, newCols int, bufferAbsoluteY int, nullCell *CellData, reflowCursorLine bool) []int {
	toRemove := []int{}
	for y := 0; y < lines.Length()-1; y++ {
		i := y
		nextLine := lines.Get(i + 1)
		if !nextLine.IsWrapped {
			continue
		}
		i++

		wrappedLines := []*BufferLine{lines.Get(y)}
		for i < lines.Length() && nextLine.IsWrapped {
			wrappedLines = append(wrappedLines, nextLine)
			i++
			if i < lines.Length() {
				nextLine = lines.Get(i)
			}
		}

		if !reflowCursorLine {
			if bufferAbsoluteY >= y && bufferAbsoluteY < i {
				y += len(wrappedLines) - 1
				continue
			}
		}

		// Copy buffer data to new locations
		destLineIndex := 0
		destCol := getWrappedLineTrimmedLength(wrappedLines, destLineIndex, oldCols)
		srcLineIndex := 1
		srcCol := 0

		for srcLineIndex < len(wrappedLines) {
			srcTrimmedLength := getWrappedLineTrimmedLength(wrappedLines, srcLineIndex, oldCols)
			srcRemainingCells := srcTrimmedLength - srcCol
			destRemainingCells := newCols - destCol
			cellsToCopy := min(srcRemainingCells, destRemainingCells)

			wrappedLines[destLineIndex].CopyCellsFrom(wrappedLines[srcLineIndex], srcCol, destCol, cellsToCopy, false)
			destCol += cellsToCopy
			if destCol == newCols {
				destLineIndex++
				destCol = 0
			}
			srcCol += cellsToCopy
			if srcCol == srcTrimmedLength {
				srcLineIndex++
				srcCol = 0
			}

			// Handle wide char at line boundary
			if destCol == 0 && destLineIndex != 0 {
				if wrappedLines[destLineIndex-1].GetWidth(newCols-1) == 2 {
					wrappedLines[destLineIndex].CopyCellsFrom(wrappedLines[destLineIndex-1], newCols-1, 0, 1, false)
					destCol++
					wrappedLines[destLineIndex-1].SetCell(newCols-1, nullCell)
				}
			}
		}

		// Clear remaining cells
		wrappedLines[destLineIndex].ReplaceCells(destCol, newCols, nullCell, false)

		// Count removable trailing empty lines
		countToRemove := 0
		for i := len(wrappedLines) - 1; i > 0; i-- {
			if i > destLineIndex || wrappedLines[i].GetTrimmedLength() == 0 {
				countToRemove++
			} else {
				break
			}
		}
		if countToRemove > 0 {
			toRemove = append(toRemove, y+len(wrappedLines)-countToRemove)
			toRemove = append(toRemove, countToRemove)
		}
		y += len(wrappedLines) - 1
	}
	return toRemove
}

// reflowLargerCreateNewLayout creates the new line layout after removing lines.
func reflowLargerCreateNewLayout(lines *CircularList[*BufferLine], toRemove []int) NewLayoutResult {
	layout := []int{}
	nextToRemoveIndex := 0
	nextToRemoveStart := -1
	if len(toRemove) > 0 {
		nextToRemoveStart = toRemove[0]
	}
	countRemovedSoFar := 0

	for i := 0; i < lines.Length(); i++ {
		if nextToRemoveStart == i {
			nextToRemoveIndex++
			countToRemove := toRemove[nextToRemoveIndex]
			lines.OnDeleteEmitter.Fire(DeleteEvent{Index: i - countRemovedSoFar, Amount: countToRemove})
			i += countToRemove - 1
			countRemovedSoFar += countToRemove
			nextToRemoveIndex++
			if nextToRemoveIndex < len(toRemove) {
				nextToRemoveStart = toRemove[nextToRemoveIndex]
			} else {
				nextToRemoveStart = -1
			}
		} else {
			layout = append(layout, i)
		}
	}
	return NewLayoutResult{layout: layout, countRemoved: countRemovedSoFar}
}

// reflowLargerApplyNewLayout rearranges lines according to the new layout.
func reflowLargerApplyNewLayout(lines *CircularList[*BufferLine], newLayout []int) {
	newLayoutLines := make([]*BufferLine, len(newLayout))
	for i, idx := range newLayout {
		newLayoutLines[i] = lines.Get(idx)
	}
	for i, line := range newLayoutLines {
		lines.Set(i, line)
	}
	lines.SetLength(len(newLayout))
}

// reflowSmallerGetNewLineLengths computes the new line lengths when reflowing to smaller width.
func reflowSmallerGetNewLineLengths(wrappedLines []*BufferLine, oldCols, newCols int) []int {
	newLineLengths := []int{}
	cellsNeeded := 0
	for i := range wrappedLines {
		cellsNeeded += getWrappedLineTrimmedLength(wrappedLines, i, oldCols)
	}

	srcCol := 0
	srcLine := 0
	cellsAvailable := 0

	for cellsAvailable < cellsNeeded {
		if cellsNeeded-cellsAvailable < newCols {
			newLineLengths = append(newLineLengths, cellsNeeded-cellsAvailable)
			break
		}
		srcCol += newCols
		oldTrimmedLength := getWrappedLineTrimmedLength(wrappedLines, srcLine, oldCols)
		if srcCol > oldTrimmedLength {
			srcCol -= oldTrimmedLength
			srcLine++
		}
		endsWithWide := srcLine < len(wrappedLines) && wrappedLines[srcLine].GetWidth(srcCol-1) == 2
		if endsWithWide {
			srcCol--
		}
		lineLength := newCols
		if endsWithWide {
			lineLength = newCols - 1
		}
		newLineLengths = append(newLineLengths, lineLength)
		cellsAvailable += lineLength
	}
	return newLineLengths
}

// getWrappedLineTrimmedLength returns the trimmed length of a line within a wrapped group.
func getWrappedLineTrimmedLength(lines []*BufferLine, i, cols int) int {
	if i == len(lines)-1 {
		return lines[i].GetTrimmedLength()
	}
	endsInNull := lines[i].HasContent(cols-1) == 0 && lines[i].GetWidth(cols-1) == 1
	followingLineStartsWithWide := i+1 < len(lines) && lines[i+1].GetWidth(0) == 2
	if endsInNull && followingLineStartsWithWide {
		return cols - 1
	}
	return cols
}
