package xterm

// Ported from xterm.js src/common/InputHandler.ts — OSC sequence handlers.

import (
	"regexp"
	"strconv"
	"strings"
)

// specialColors maps offset indices to special color slots.
var specialColors = []SpecialColorIndex{
	SpecialColorForeground,
	SpecialColorBackground,
	SpecialColorCursor,
}

// SetTitle (OSC 2) — set the terminal window title.
func (h *InputHandler) SetTitle(data string) bool {
	h.windowTitle = data
	h.OnTitleChangeEmitter.Fire(data)
	return true
}

// setTitleAndIconName (OSC 0) — set both the window title and icon name.
func (h *InputHandler) setTitleAndIconName(data string) bool {
	h.SetTitle(data)
	h.setIconName(data)
	return true
}

// setIconName (OSC 1) — set the terminal icon name.
func (h *InputHandler) setIconName(data string) bool {
	h.iconName = data
	h.OnIconNameChangeEmitter.Fire(data)
	return true
}

// SetOrReportIndexedColor (OSC 4) — set or query palette colors.
func (h *InputHandler) SetOrReportIndexedColor(data string) bool {
	var events []ColorEvent
	slots := strings.Split(data, ";")

	for len(slots) > 1 {
		idx := slots[0]
		spec := slots[1]
		slots = slots[2:]

		if isDigitString(idx) {
			index, _ := strconv.Atoi(idx)
			if isValidColorIndex(index) {
				if spec == "?" {
					events = append(events, ColorEvent{
						Type:  ColorRequestReport,
						Index: index,
					})
				} else {
					color := parseColor(spec)
					if color != nil {
						events = append(events, ColorEvent{
							Type:  ColorRequestSet,
							Index: index,
							Color: color,
						})
					}
				}
			}
		}
	}

	if len(events) > 0 {
		h.OnColorEmitter.Fire(events)
	}
	return true
}

// setOrReportSpecialColor handles OSC 10/11/12 with stacking support.
func (h *InputHandler) setOrReportSpecialColor(data string, offset int) bool {
	slots := strings.Split(data, ";")
	for i := 0; i < len(slots) && offset < len(specialColors); i++ {
		if slots[i] == "?" {
			h.OnColorEmitter.Fire([]ColorEvent{{
				Type:  ColorRequestReport,
				Index: int(specialColors[offset]),
			}})
		} else {
			color := parseColor(slots[i])
			if color != nil {
				h.OnColorEmitter.Fire([]ColorEvent{{
					Type:  ColorRequestSet,
					Index: int(specialColors[offset]),
					Color: color,
				}})
			}
		}
		offset++
	}
	return true
}

// SetOrReportFgColor (OSC 10) — set or query default foreground color.
func (h *InputHandler) SetOrReportFgColor(data string) bool {
	return h.setOrReportSpecialColor(data, 0)
}

// SetOrReportBgColor (OSC 11) — set or query default background color.
func (h *InputHandler) SetOrReportBgColor(data string) bool {
	return h.setOrReportSpecialColor(data, 1)
}

// SetOrReportCursorColor (OSC 12) — set or query default cursor color.
func (h *InputHandler) SetOrReportCursorColor(data string) bool {
	return h.setOrReportSpecialColor(data, 2)
}

// RestoreIndexedColor (OSC 104) — restore palette colors to theme defaults.
func (h *InputHandler) RestoreIndexedColor(data string) bool {
	if data == "" {
		h.OnColorEmitter.Fire([]ColorEvent{{Type: ColorRequestRestore}})
		return true
	}

	var events []ColorEvent
	slots := strings.Split(data, ";")
	for _, s := range slots {
		if isDigitString(s) {
			index, _ := strconv.Atoi(s)
			if isValidColorIndex(index) {
				events = append(events, ColorEvent{
					Type:  ColorRequestRestore,
					Index: index,
				})
			}
		}
	}
	if len(events) > 0 {
		h.OnColorEmitter.Fire(events)
	}
	return true
}

// RestoreFgColor (OSC 110) — restore default foreground color.
func (h *InputHandler) RestoreFgColor(_ string) bool {
	h.OnColorEmitter.Fire([]ColorEvent{{
		Type:  ColorRequestRestore,
		Index: int(SpecialColorForeground),
	}})
	return true
}

// RestoreBgColor (OSC 111) — restore default background color.
func (h *InputHandler) RestoreBgColor(_ string) bool {
	h.OnColorEmitter.Fire([]ColorEvent{{
		Type:  ColorRequestRestore,
		Index: int(SpecialColorBackground),
	}})
	return true
}

// RestoreCursorColor (OSC 112) — restore default cursor color.
func (h *InputHandler) RestoreCursorColor(_ string) bool {
	h.OnColorEmitter.Fire([]ColorEvent{{
		Type:  ColorRequestRestore,
		Index: int(SpecialColorCursor),
	}})
	return true
}

// SetHyperlink (OSC 8) — create or finish a hyperlink.
func (h *InputHandler) SetHyperlink(data string) bool {
	idx := strings.Index(data, ";")
	if idx == -1 {
		return true // malformed
	}
	params := data[:idx]
	uri := data[idx+1:]

	if uri != "" {
		return h.createHyperlink(params, uri)
	}
	if strings.TrimSpace(params) != "" {
		return false
	}
	return h.finishHyperlink()
}

func (h *InputHandler) createHyperlink(params, uri string) bool {
	// Close any open hyperlink first.
	if h.getCurrentLinkId() != 0 {
		h.finishHyperlink()
	}

	parsedParams := strings.Split(params, ":")
	var id string
	for _, p := range parsedParams {
		if strings.HasPrefix(p, "id=") {
			id = p[3:]
			break
		}
	}

	h.curAttrData.Extended = h.curAttrData.Extended.Clone()
	h.curAttrData.Extended.SetURLID(h.oscLinkService.RegisterLink(OscLinkData{ID: id, URI: uri}))
	h.curAttrData.UpdateExtended()
	return true
}

func (h *InputHandler) finishHyperlink() bool {
	h.curAttrData.Extended = h.curAttrData.Extended.Clone()
	h.curAttrData.Extended.SetURLID(0)
	h.curAttrData.UpdateExtended()
	return true
}

// --- Color parsing ---

var (
	rgbColorRe  = regexp.MustCompile(`^rgb:([0-9a-fA-F]{1,4})/([0-9a-fA-F]{1,4})/([0-9a-fA-F]{1,4})$`)
	hashColorRe = regexp.MustCompile(`^#([0-9a-fA-F]{3,12})$`)
	digitRe     = regexp.MustCompile(`^\d+$`)
)

// parseColor parses an XParseColor-style color specification.
// Supports: rgb:r/g/b (1-4 hex digits per channel), #RGB, #RRGGBB, #RRRGGGBBB, #RRRRGGGGBBBB.
func parseColor(spec string) *ColorRGB {
	// Try rgb:r/g/b format.
	if m := rgbColorRe.FindStringSubmatch(spec); m != nil {
		r := scaleHexChannel(m[1])
		g := scaleHexChannel(m[2])
		b := scaleHexChannel(m[3])
		return &ColorRGB{r, g, b}
	}

	// Try #hex format.
	if m := hashColorRe.FindStringSubmatch(spec); m != nil {
		hex := m[1]
		switch len(hex) {
		case 3: // #RGB → 4-bit per channel
			r := parseHex(hex[0:1]) * 0x10
			g := parseHex(hex[1:2]) * 0x10
			b := parseHex(hex[2:3]) * 0x10
			return &ColorRGB{uint8(r), uint8(g), uint8(b)}
		case 6: // #RRGGBB
			r := parseHex(hex[0:2])
			g := parseHex(hex[2:4])
			b := parseHex(hex[4:6])
			return &ColorRGB{uint8(r), uint8(g), uint8(b)}
		case 9: // #RRRGGGBBB — 12-bit, truncate to 8-bit
			r := parseHex(hex[0:2])
			g := parseHex(hex[3:5])
			b := parseHex(hex[6:8])
			return &ColorRGB{uint8(r), uint8(g), uint8(b)}
		case 12: // #RRRRGGGGBBBB — 16-bit, truncate to 8-bit
			r := parseHex(hex[0:2])
			g := parseHex(hex[4:6])
			b := parseHex(hex[8:10])
			return &ColorRGB{uint8(r), uint8(g), uint8(b)}
		}
	}

	return nil
}

// scaleHexChannel scales a 1-4 hex digit channel value to 8-bit.
func scaleHexChannel(s string) uint8 {
	v := parseHex(s)
	switch len(s) {
	case 1: // 4-bit → 8-bit
		return uint8(v * 0x11)
	case 2: // 8-bit
		return uint8(v)
	case 3: // 12-bit → 8-bit
		return uint8(v >> 4)
	case 4: // 16-bit → 8-bit
		return uint8(v >> 8)
	}
	return uint8(v)
}

// parseHex parses a hex string to an integer.
func parseHex(s string) int {
	v, _ := strconv.ParseInt(s, 16, 32)
	return int(v)
}

// isDigitString returns true if s consists entirely of ASCII digits.
func isDigitString(s string) bool {
	return digitRe.MatchString(s)
}

// isValidColorIndex returns true if the index is in the 0-255 palette range.
func isValidColorIndex(index int) bool {
	return index >= 0 && index < 256
}
