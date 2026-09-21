package xterm

// Ported from xterm.js src/common/Types.ts and src/common/buffer/Types.ts.

// CharData is the legacy cell representation: [attr, char, width, code].
type CharData [4]interface{}

// CharDataAttr returns the attribute (fg) from CharData.
func CharDataAttr(cd CharData) uint32 { return cd[charDataAttrIndex].(uint32) }

// CharDataChar returns the character string from CharData.
func CharDataChar(cd CharData) string { return cd[charDataCharIndex].(string) }

// CharDataWidth returns the display width from CharData.
func CharDataWidth(cd CharData) int { return cd[charDataWidthIndex].(int) }

// CharDataCode returns the codepoint from CharData.
func CharDataCode(cd CharData) uint32 { return cd[charDataCodeIndex].(uint32) }

// NewCharData creates a CharData tuple.
func NewCharData(attr uint32, ch string, width int, code uint32) CharData {
	return CharData{attr, ch, width, code}
}

// Charset maps single-byte characters to replacement strings (e.g., DEC special graphics).
type Charset map[byte]rune

// ColorRGB is an [R, G, B] color triple, each component 0-255.
type ColorRGB [3]uint8

// Color represents a color with a CSS string and a 32-bit RGBA value.
type Color struct {
	CSS  string
	RGBA uint32
}

// Modes tracks standard ANSI modes.
type Modes struct {
	InsertMode bool
}

// CursorStyle is the shape of the cursor.
type CursorStyle string

const (
	CursorStyleBlock     CursorStyle = "block"
	CursorStyleUnderline CursorStyle = "underline"
	CursorStyleBar       CursorStyle = "bar"
)

// CursorInactiveStyle is the shape of the cursor when the terminal is not focused.
type CursorInactiveStyle string

const (
	CursorInactiveStyleOutline   CursorInactiveStyle = "outline"
	CursorInactiveStyleBlock     CursorInactiveStyle = "block"
	CursorInactiveStyleBar       CursorInactiveStyle = "bar"
	CursorInactiveStyleUnderline CursorInactiveStyle = "underline"
	CursorInactiveStyleNone      CursorInactiveStyle = "none"
)

// DecPrivateModes tracks DEC private mode settings.
type DecPrivateModes struct {
	ApplicationCursorKeys bool
	ApplicationKeypad     bool
	BracketedPasteMode    bool
	ColorSchemeUpdates    bool
	CursorBlink           *bool        // nil = not set by DECSET/DECRST
	CursorBlinkOverride   *bool        // nil = not set by DECSCUSR
	CursorStyle           *CursorStyle // nil = not set
	MouseEncoding         string       // "DEFAULT", "SGR", "SGR_PIXELS"
	MouseTrackingMode     string       // "NONE", "X10", "VT200", "DRAG", "ANY"
	Origin                bool
	ReverseWraparound     bool
	SendFocus             bool
	SynchronizedOutput    bool
	Win32InputMode        bool
	Wraparound            bool
}

// CoreMouseButton identifies a mouse button.
type CoreMouseButton int

const (
	MouseButtonLeft   CoreMouseButton = 0
	MouseButtonMiddle CoreMouseButton = 1
	MouseButtonRight  CoreMouseButton = 2
	MouseButtonNone   CoreMouseButton = 3
	MouseButtonWheel  CoreMouseButton = 4
	MouseButtonAux1   CoreMouseButton = 8
	MouseButtonAux2   CoreMouseButton = 9
	MouseButtonAux3   CoreMouseButton = 10
	MouseButtonAux4   CoreMouseButton = 11
	MouseButtonAux5   CoreMouseButton = 12
	MouseButtonAux6   CoreMouseButton = 13
	MouseButtonAux7   CoreMouseButton = 14
	MouseButtonAux8   CoreMouseButton = 15
)

// CoreMouseAction identifies a mouse action.
type CoreMouseAction int

const (
	MouseActionUp    CoreMouseAction = 0
	MouseActionDown  CoreMouseAction = 1
	MouseActionLeft  CoreMouseAction = 2
	MouseActionRight CoreMouseAction = 3
	MouseActionMove  CoreMouseAction = 32
)

// CoreMouseEvent represents a mouse event in the terminal core.
type CoreMouseEvent struct {
	Col    int
	Row    int
	X      int
	Y      int
	Button CoreMouseButton
	Action CoreMouseAction
	Ctrl   bool
	Alt    bool
	Shift  bool
}

// CoreMouseEventType is a bitmask of mouse event categories a protocol wants to receive.
type CoreMouseEventType int

const (
	MouseEventNone  CoreMouseEventType = 0
	MouseEventDown  CoreMouseEventType = 1
	MouseEventUp    CoreMouseEventType = 2
	MouseEventDrag  CoreMouseEventType = 4
	MouseEventMove  CoreMouseEventType = 8
	MouseEventWheel CoreMouseEventType = 16
)

// ColorRequestType identifies the kind of color request (OSC 4/10/11/12).
type ColorRequestType int

const (
	ColorRequestReport  ColorRequestType = 0
	ColorRequestSet     ColorRequestType = 1
	ColorRequestRestore ColorRequestType = 2
)

// SpecialColorIndex identifies special color slots beyond the 256-color palette.
type SpecialColorIndex int

const (
	SpecialColorForeground SpecialColorIndex = 256
	SpecialColorBackground SpecialColorIndex = 257
	SpecialColorCursor     SpecialColorIndex = 258
)

// ScrollEvent carries a scroll position.
type ScrollEvent struct {
	Position int
}

// RowRange represents a range of rows [Start, End).
type RowRange struct {
	Start int
	End   int
}

// InsertEvent is fired when items are inserted into a CircularList.
type InsertEvent struct {
	Index  int
	Amount int
}

// DeleteEvent is fired when items are deleted from a CircularList.
type DeleteEvent struct {
	Index  int
	Amount int
}

// BufferIndex denotes a position in the buffer: [rowIndex, colIndex].
type BufferIndex [2]int

// WindowsOptionsReportType identifies a window-options report request (CSI t).
type WindowsOptionsReportType int

const (
	// GetWinSizePixels requests the window size in pixels (CSI 14 t).
	GetWinSizePixels WindowsOptionsReportType = 0
	// GetCellSizePixels requests the cell size in pixels (CSI 16 t).
	GetCellSizePixels WindowsOptionsReportType = 1
)

// KittyKeyboardState tracks the kitty keyboard protocol state.
type KittyKeyboardState struct {
	Flags     int
	MainFlags int
	AltFlags  int
	MainStack []int
	AltStack  []int
}
