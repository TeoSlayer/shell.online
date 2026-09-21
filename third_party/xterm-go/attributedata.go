package xterm

// Ported from xterm.js src/common/buffer/AttributeData.ts.

// ExtendedAttrs holds extended cell attributes (underline style, underline color, URL ID,
// and an arbitrary payload).
type ExtendedAttrs struct {
	ext     uint32
	urlID   int
	Payload any
}

// NewExtendedAttrs creates an ExtendedAttrs with the given raw ext value and URL ID.
func NewExtendedAttrs(ext uint32, urlID int) *ExtendedAttrs {
	return &ExtendedAttrs{ext: ext, urlID: urlID}
}

// Ext returns the raw extended attributes value. If a URL is set, the underline
// style bits are overridden to DASHED.
func (e *ExtendedAttrs) Ext() uint32 {
	if e.urlID != 0 {
		return (e.ext & ^ExtFlagUnderlineStyle) | (uint32(UnderlineStyleDashed) << 26)
	}
	return e.ext
}

// SetExt sets the raw extended attributes value.
func (e *ExtendedAttrs) SetExt(v uint32) {
	e.ext = v
}

// UnderlineStyle returns the underline style. Returns DASHED if a URL is active.
func (e *ExtendedAttrs) UnderlineStyle() UnderlineStyle {
	if e.urlID != 0 {
		return UnderlineStyleDashed
	}
	return UnderlineStyle((e.ext & ExtFlagUnderlineStyle) >> 26)
}

// SetUnderlineStyle sets the underline style bits.
func (e *ExtendedAttrs) SetUnderlineStyle(v UnderlineStyle) {
	e.ext &= ^ExtFlagUnderlineStyle
	e.ext |= (uint32(v) << 26) & ExtFlagUnderlineStyle
}

// UnderlineColor returns the underline color (color mode + RGB/palette bits).
func (e *ExtendedAttrs) UnderlineColor() uint32 {
	return e.ext & (AttrCMMask | AttrRGBMask)
}

// SetUnderlineColor sets the underline color bits.
func (e *ExtendedAttrs) SetUnderlineColor(v uint32) {
	e.ext &= ^(AttrCMMask | AttrRGBMask)
	e.ext |= v & (AttrCMMask | AttrRGBMask)
}

// URLID returns the OSC hyperlink ID.
func (e *ExtendedAttrs) URLID() int {
	return e.urlID
}

// SetURLID sets the OSC hyperlink ID.
func (e *ExtendedAttrs) SetURLID(v int) {
	e.urlID = v
}

// UnderlineVariantOffset returns the variant offset (3-bit unsigned from bits 29-31).
func (e *ExtendedAttrs) UnderlineVariantOffset() int {
	val := int32(e.ext&ExtFlagVariantOffset) >> 29
	if val < 0 {
		return int(val ^ (^int32(0) << 3))
	}
	return int(val)
}

// SetUnderlineVariantOffset sets the variant offset bits.
func (e *ExtendedAttrs) SetUnderlineVariantOffset(v int) {
	e.ext &= ^ExtFlagVariantOffset
	e.ext |= (uint32(v) << 29) & ExtFlagVariantOffset
}

// Clone returns a copy.
func (e *ExtendedAttrs) Clone() *ExtendedAttrs {
	return &ExtendedAttrs{ext: e.ext, urlID: e.urlID, Payload: e.Payload}
}

// IsEmpty returns true if the extended attrs carry no meaningful data.
func (e *ExtendedAttrs) IsEmpty() bool {
	return e.UnderlineStyle() == UnderlineStyleNone && e.urlID == 0 && e.Payload == nil
}

// AttributeData holds the fg, bg, and extended attributes for a cell.
type AttributeData struct {
	Fg       uint32
	Bg       uint32
	Extended *ExtendedAttrs
}

// DefaultAttrData returns an AttributeData with default (zero) values.
func DefaultAttrData() AttributeData {
	return AttributeData{Extended: &ExtendedAttrs{}}
}

// Clone returns a deep copy.
func (a *AttributeData) Clone() AttributeData {
	return AttributeData{
		Fg:       a.Fg,
		Bg:       a.Bg,
		Extended: a.extended().Clone(),
	}
}

func (a *AttributeData) extended() *ExtendedAttrs {
	if a.Extended == nil {
		a.Extended = &ExtendedAttrs{}
	}
	return a.Extended
}

// --- Static helpers ---

// ToColorRGB extracts an RGB triple from a packed color value.
func ToColorRGB(v uint32) ColorRGB {
	return ColorRGB{
		uint8((v >> AttrRedShift) & 0xFF),
		uint8((v >> AttrGreenShift) & 0xFF),
		uint8(v & 0xFF),
	}
}

// FromColorRGB packs an RGB triple into a uint32.
func FromColorRGB(c ColorRGB) uint32 {
	return (uint32(c[0])&0xFF)<<AttrRedShift |
		(uint32(c[1])&0xFF)<<AttrGreenShift |
		uint32(c[2])&0xFF
}

// --- Flag queries (return non-zero if set, matching xterm.js convention) ---

func (a *AttributeData) IsInverse() uint32       { return a.Fg & FgFlagInverse }
func (a *AttributeData) IsBold() uint32          { return a.Fg & FgFlagBold }
func (a *AttributeData) IsBlink() uint32         { return a.Fg & FgFlagBlink }
func (a *AttributeData) IsInvisible() uint32     { return a.Fg & FgFlagInvisible }
func (a *AttributeData) IsStrikethrough() uint32 { return a.Fg & FgFlagStrikethrough }
func (a *AttributeData) IsItalic() uint32        { return a.Bg & BgFlagItalic }
func (a *AttributeData) IsDim() uint32           { return a.Bg & BgFlagDim }
func (a *AttributeData) IsProtected() uint32     { return a.Bg & BgFlagProtected }
func (a *AttributeData) IsOverline() uint32      { return a.Bg & BgFlagOverline }

// IsUnderline checks both the fg underline flag and extended underline style.
func (a *AttributeData) IsUnderline() uint32 {
	if a.HasExtendedAttrs() != 0 && a.extended().UnderlineStyle() != UnderlineStyleNone {
		return 1
	}
	return a.Fg & FgFlagUnderline
}

// --- Color mode queries ---

func (a *AttributeData) GetFgColorMode() uint32 { return a.Fg & AttrCMMask }
func (a *AttributeData) GetBgColorMode() uint32 { return a.Bg & AttrCMMask }

func (a *AttributeData) IsFgRGB() bool     { return (a.Fg & AttrCMMask) == AttrCMRGB }
func (a *AttributeData) IsBgRGB() bool     { return (a.Bg & AttrCMMask) == AttrCMRGB }
func (a *AttributeData) IsFgDefault() bool { return (a.Fg & AttrCMMask) == 0 }
func (a *AttributeData) IsBgDefault() bool { return (a.Bg & AttrCMMask) == 0 }

func (a *AttributeData) IsFgPalette() bool {
	cm := a.Fg & AttrCMMask
	return cm == AttrCMP16 || cm == AttrCMP256
}

func (a *AttributeData) IsBgPalette() bool {
	cm := a.Bg & AttrCMMask
	return cm == AttrCMP16 || cm == AttrCMP256
}

func (a *AttributeData) IsAttributeDefault() bool {
	return a.Fg == 0 && a.Bg == 0
}

// --- Color value queries ---

// GetFgColor returns the foreground color value. Returns -1 for default color mode.
func (a *AttributeData) GetFgColor() int {
	switch a.Fg & AttrCMMask {
	case AttrCMP16, AttrCMP256:
		return int(a.Fg & AttrPColorMask)
	case AttrCMRGB:
		return int(a.Fg & AttrRGBMask)
	default:
		return -1
	}
}

// GetBgColor returns the background color value. Returns -1 for default color mode.
func (a *AttributeData) GetBgColor() int {
	switch a.Bg & AttrCMMask {
	case AttrCMP16, AttrCMP256:
		return int(a.Bg & AttrPColorMask)
	case AttrCMRGB:
		return int(a.Bg & AttrRGBMask)
	default:
		return -1
	}
}

// --- Extended attributes ---

func (a *AttributeData) HasExtendedAttrs() uint32 { return a.Bg & BgFlagHasExtended }

// UpdateExtended sets or clears the HAS_EXTENDED flag based on whether extended attrs are empty.
func (a *AttributeData) UpdateExtended() {
	if a.extended().IsEmpty() {
		a.Bg &= ^BgFlagHasExtended
	} else {
		a.Bg |= BgFlagHasExtended
	}
}

// GetUnderlineColor returns the underline color value, falling back to fg color.
func (a *AttributeData) GetUnderlineColor() int {
	if (a.Bg&BgFlagHasExtended) != 0 && ^a.extended().UnderlineColor() != 0 {
		switch a.extended().UnderlineColor() & AttrCMMask {
		case AttrCMP16, AttrCMP256:
			return int(a.extended().UnderlineColor() & AttrPColorMask)
		case AttrCMRGB:
			return int(a.extended().UnderlineColor() & AttrRGBMask)
		default:
			return a.GetFgColor()
		}
	}
	return a.GetFgColor()
}

// GetUnderlineColorMode returns the color mode of the underline color, falling back to fg.
func (a *AttributeData) GetUnderlineColorMode() uint32 {
	if (a.Bg&BgFlagHasExtended) != 0 && ^a.extended().UnderlineColor() != 0 {
		return a.extended().UnderlineColor() & AttrCMMask
	}
	return a.GetFgColorMode()
}

// IsUnderlineColorRGB returns whether the underline color is RGB.
func (a *AttributeData) IsUnderlineColorRGB() bool {
	if (a.Bg&BgFlagHasExtended) != 0 && ^a.extended().UnderlineColor() != 0 {
		return (a.extended().UnderlineColor() & AttrCMMask) == AttrCMRGB
	}
	return a.IsFgRGB()
}

// IsUnderlineColorPalette returns whether the underline color is a palette color.
func (a *AttributeData) IsUnderlineColorPalette() bool {
	if (a.Bg&BgFlagHasExtended) != 0 && ^a.extended().UnderlineColor() != 0 {
		cm := a.extended().UnderlineColor() & AttrCMMask
		return cm == AttrCMP16 || cm == AttrCMP256
	}
	return a.IsFgPalette()
}

// IsUnderlineColorDefault returns whether the underline color is the default.
func (a *AttributeData) IsUnderlineColorDefault() bool {
	if (a.Bg&BgFlagHasExtended) != 0 && ^a.extended().UnderlineColor() != 0 {
		return (a.extended().UnderlineColor() & AttrCMMask) == 0
	}
	return a.IsFgDefault()
}

// GetUnderlineStyle returns the effective underline style.
func (a *AttributeData) GetUnderlineStyle() UnderlineStyle {
	if a.Fg&FgFlagUnderline == 0 {
		return UnderlineStyleNone
	}
	if a.Bg&BgFlagHasExtended != 0 {
		return a.extended().UnderlineStyle()
	}
	return UnderlineStyleSingle
}

// GetUnderlineVariantOffset returns the underline variant offset from extended attrs.
func (a *AttributeData) GetUnderlineVariantOffset() int {
	return a.extended().UnderlineVariantOffset()
}
