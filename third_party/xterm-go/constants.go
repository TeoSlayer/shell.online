package xterm

// Ported from xterm.js src/common/buffer/Constants.ts and src/common/parser/Constants.ts.
// Bit layouts MUST match xterm.js exactly for buffer state compatibility.

// Content bitmasks for the cell content uint32.
//
//	bits 0-20:  codepoint (max 0x10FFFF)
//	bit  21:    IS_COMBINED flag
//	bits 22-23: wcwidth (0-2)
const (
	ContentCodepointMask  uint32 = 0x1FFFFF
	ContentIsCombinedMask uint32 = 0x200000 // 1 << 21
	ContentHasContentMask uint32 = 0x3FFFFF // codepoint | isCombined
	ContentWidthMask      uint32 = 0xC00000 // 3 << 22
	ContentWidthShift     uint32 = 22
)

// Attributes bitmasks for fg/bg uint32 color fields.
//
//	bits 0-7:   blue (RGB) or palette index
//	bits 8-15:  green (RGB)
//	bits 16-23: red (RGB)
//	bits 24-25: color mode
const (
	AttrBlueMask   uint32 = 0xFF
	AttrBlueShift  uint32 = 0
	AttrPColorMask uint32 = 0xFF
	AttrGreenMask  uint32 = 0xFF00
	AttrGreenShift uint32 = 8
	AttrRedMask    uint32 = 0xFF0000
	AttrRedShift   uint32 = 16
	AttrCMMask     uint32 = 0x3000000
	AttrCMDefault  uint32 = 0
	AttrCMP16      uint32 = 0x1000000
	AttrCMP256     uint32 = 0x2000000
	AttrCMRGB      uint32 = 0x3000000
	AttrRGBMask    uint32 = 0xFFFFFF
)

// FgFlags are attribute flags stored in the upper bits of the fg uint32.
//
//	bits 26-31
const (
	FgFlagInverse       uint32 = 0x4000000
	FgFlagBold          uint32 = 0x8000000
	FgFlagUnderline     uint32 = 0x10000000
	FgFlagBlink         uint32 = 0x20000000
	FgFlagInvisible     uint32 = 0x40000000
	FgFlagStrikethrough uint32 = 0x80000000
)

// BgFlags are attribute flags stored in the upper bits of the bg uint32.
//
//	bits 26-30
const (
	BgFlagItalic      uint32 = 0x4000000
	BgFlagDim         uint32 = 0x8000000
	BgFlagHasExtended uint32 = 0x10000000
	BgFlagProtected   uint32 = 0x20000000
	BgFlagOverline    uint32 = 0x40000000
)

// ExtFlags are flags in the extended attributes uint32.
const (
	ExtFlagUnderlineStyle uint32 = 0x1C000000 // bits 26-28
	ExtFlagVariantOffset  uint32 = 0xE0000000 // bits 29-31
)

// UnderlineStyle values for extended attributes.
type UnderlineStyle uint32

const (
	UnderlineStyleNone   UnderlineStyle = 0
	UnderlineStyleSingle UnderlineStyle = 1
	UnderlineStyleDouble UnderlineStyle = 2
	UnderlineStyleCurly  UnderlineStyle = 3
	UnderlineStyleDotted UnderlineStyle = 4
	UnderlineStyleDashed UnderlineStyle = 5
)

// CharData field indices (used when converting to/from the legacy [attr, char, width, code] tuple).
const (
	charDataAttrIndex  = 0
	charDataCharIndex  = 1
	charDataWidthIndex = 2
	charDataCodeIndex  = 3
)

// Null cell constants.
const (
	NullCellChar  = ""
	NullCellWidth = 1
	NullCellCode  = 0
)

// Whitespace cell constants.
const (
	WhitespaceCellChar  = " "
	WhitespaceCellWidth = 1
	WhitespaceCellCode  = 32
)

// Default attribute values.
const (
	DefaultColor uint32 = 0
	DefaultAttr  uint32 = (0 << 18) | (0 << 9) | (256 << 0)
	DefaultExt   uint32 = 0
)

// ParserState enumerates the internal states of the VT500 escape sequence parser.
type ParserState uint8

const (
	ParserStateGround             ParserState = 0
	ParserStateEscape             ParserState = 1
	ParserStateEscapeIntermediate ParserState = 2
	ParserStateCSIEntry           ParserState = 3
	ParserStateCSIParam           ParserState = 4
	ParserStateCSIIntermediate    ParserState = 5
	ParserStateCSIIgnore          ParserState = 6
	ParserStateSOSPMString        ParserState = 7
	ParserStateOSCString          ParserState = 8
	ParserStateDCSEntry           ParserState = 9
	ParserStateDCSParam           ParserState = 10
	ParserStateDCSIgnore          ParserState = 11
	ParserStateDCSIntermediate    ParserState = 12
	ParserStateDCSPassthrough     ParserState = 13
	ParserStateAPCEntry           ParserState = 14
	ParserStateAPCIntermediate    ParserState = 15
	ParserStateAPCPassthrough     ParserState = 16
	ParserStateLength             ParserState = 17 // number of states
)

// ParserAction enumerates the internal actions of the escape sequence parser.
type ParserAction uint8

const (
	ParserActionIgnore      ParserAction = 0
	ParserActionError       ParserAction = 1
	ParserActionPrint       ParserAction = 2
	ParserActionExecute     ParserAction = 3
	ParserActionOSCStart    ParserAction = 4
	ParserActionOSCPut      ParserAction = 5
	ParserActionOSCEnd      ParserAction = 6
	ParserActionCSIDispatch ParserAction = 7
	ParserActionParam       ParserAction = 8
	ParserActionCollect     ParserAction = 9
	ParserActionESCDispatch ParserAction = 10
	ParserActionClear       ParserAction = 11
	ParserActionDCSHook     ParserAction = 12
	ParserActionDCSPut      ParserAction = 13
	ParserActionDCSUnhook   ParserAction = 14
	ParserActionAPCStart    ParserAction = 15
	ParserActionAPCPut      ParserAction = 16
	ParserActionAPCEnd      ParserAction = 17
)

// OscState enumerates the internal states of the OSC parser.
type OscState uint8

const (
	OscStateStart   OscState = 0
	OscStateID      OscState = 1
	OscStatePayload OscState = 2
	OscStateAbort   OscState = 3
)

// ParserPayloadLimit is the maximum payload size for OSC and DCS sequences.
const ParserPayloadLimit = 10000000
