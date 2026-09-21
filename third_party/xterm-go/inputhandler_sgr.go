package xterm

// Ported from xterm.js src/common/InputHandler.ts — charAttributes (SGR handler).
// Handles CSI Pm m (Select Graphic Rendition) sequences.

// charAttributes processes SGR (Select Graphic Rendition) parameters,
// modifying curAttrData accordingly.
func (h *InputHandler) charAttributes(params *Params) bool {
	// Optimize a single SGR 0.
	if params.Length == 1 && params.Params[0] == 0 {
		h.processSGR0(&h.curAttrData)
		return true
	}

	l := params.Length
	attr := &h.curAttrData

	for i := 0; i < l; i++ {
		p := params.Params[i]

		switch {
		case p >= 30 && p <= 37:
			// fg color 8
			attr.Fg &= ^(AttrCMMask | AttrRGBMask)
			attr.Fg |= AttrCMP16 | uint32(p-30)

		case p >= 40 && p <= 47:
			// bg color 8
			attr.Bg &= ^(AttrCMMask | AttrRGBMask)
			attr.Bg |= AttrCMP16 | uint32(p-40)

		case p >= 90 && p <= 97:
			// fg color 16 (bright)
			attr.Fg &= ^(AttrCMMask | AttrRGBMask)
			attr.Fg |= AttrCMP16 | uint32(p-90) | 8

		case p >= 100 && p <= 107:
			// bg color 16 (bright)
			attr.Bg &= ^(AttrCMMask | AttrRGBMask)
			attr.Bg |= AttrCMP16 | uint32(p-100) | 8

		case p == 0:
			h.processSGR0(attr)

		case p == 1:
			// bold
			attr.Fg |= FgFlagBold

		case p == 2:
			// dim
			attr.Bg |= BgFlagDim

		case p == 3:
			// italic
			attr.Bg |= BgFlagItalic

		case p == 4:
			// underline
			attr.Fg |= FgFlagUnderline
			style := int32(UnderlineStyleSingle)
			if params.HasSubParams(i) {
				sub := params.GetSubParams(i)
				if len(sub) > 0 {
					style = sub[0]
				}
			}
			h.processUnderline(style, attr)

		case p == 5:
			// blink
			attr.Fg |= FgFlagBlink

		case p == 7:
			// inverse
			attr.Fg |= FgFlagInverse

		case p == 8:
			// invisible
			attr.Fg |= FgFlagInvisible

		case p == 9:
			// strikethrough
			attr.Fg |= FgFlagStrikethrough

		case p == 21:
			// double underline
			h.processUnderline(int32(UnderlineStyleDouble), attr)

		case p == 22:
			// not bold nor faint
			attr.Fg &= ^FgFlagBold
			attr.Bg &= ^BgFlagDim

		case p == 23:
			// not italic
			attr.Bg &= ^BgFlagItalic

		case p == 24:
			// not underlined
			attr.Fg &= ^FgFlagUnderline
			h.processUnderline(int32(UnderlineStyleNone), attr)

		case p == 25:
			// not blink
			attr.Fg &= ^FgFlagBlink

		case p == 27:
			// not inverse
			attr.Fg &= ^FgFlagInverse

		case p == 28:
			// not invisible
			attr.Fg &= ^FgFlagInvisible

		case p == 29:
			// not strikethrough
			attr.Fg &= ^FgFlagStrikethrough

		case p == 39:
			// reset fg
			attr.Fg &= ^(AttrCMMask | AttrRGBMask)
			def := DefaultAttrData()
			attr.Fg |= def.Fg & AttrRGBMask

		case p == 49:
			// reset bg
			attr.Bg &= ^(AttrCMMask | AttrRGBMask)
			def := DefaultAttrData()
			attr.Bg |= def.Bg & AttrRGBMask

		case p == 38 || p == 48 || p == 58:
			// extended color (fg/bg/underline)
			i += h.extractColor(params, i, attr)

		case p == 53:
			// overline
			attr.Bg |= BgFlagOverline

		case p == 55:
			// not overline
			attr.Bg &= ^BgFlagOverline

		case p == 59:
			// default underline color — reset to CM_DEFAULT (0)
			attr.Extended = attr.extended().Clone()
			attr.Extended.SetUnderlineColor(0)
			attr.UpdateExtended()

		case p == 221:
			// kitty extension: reset bold only (leaves faint intact)
			if h.optionsService.Options.VtExtensions.kittySgrBoldFaintControlEnabled() {
				attr.Fg &^= FgFlagBold
			}

		case p == 222:
			// kitty extension: reset faint/dim only (leaves bold intact)
			if h.optionsService.Options.VtExtensions.kittySgrBoldFaintControlEnabled() {
				attr.Bg &^= BgFlagDim
			}
		}
	}
	return true
}

// processSGR0 resets all SGR attributes to defaults.
func (h *InputHandler) processSGR0(attr *AttributeData) {
	def := DefaultAttrData()
	attr.Fg = def.Fg
	attr.Bg = def.Bg
	attr.Extended = attr.extended().Clone()
	attr.Extended.SetUnderlineStyle(UnderlineStyleNone)
	uc := attr.Extended.UnderlineColor()
	uc &= ^(AttrCMMask | AttrRGBMask)
	attr.Extended.SetUnderlineColor(uc)
	attr.UpdateExtended()
}

// updateAttrColor applies a color mode and components to a packed color value.
func (h *InputHandler) updateAttrColor(color uint32, mode int32, c1, c2, c3 int32) uint32 {
	switch mode {
	case 2: // RGB
		color |= AttrCMRGB
		color &= ^AttrRGBMask
		color |= FromColorRGB(ColorRGB{uint8(c1), uint8(c2), uint8(c3)})
	case 5: // P256
		color &= ^(AttrCMMask | AttrRGBMask)
		color |= AttrCMP256 | (uint32(c1) & 0xFF)
	}
	return color
}

// extractColor parses extended color parameters (38/48/58) from params.
// Returns the number of additional params consumed (advance).
func (h *InputHandler) extractColor(params *Params, pos int, attr *AttributeData) int {
	// accu: [target, CM, ign, val, val, val]
	// RGB:  [38/48,  2,  ign, r,   g,   b  ]
	// P256: [38/48,  5,  ign, v,   ign,  ign]
	var accu [6]int32
	accu[2] = -1
	accu[3] = 0
	accu[4] = 0
	accu[5] = 0

	cSpace := 0
	advance := 0

	for pos+advance < params.Length {
		accu[advance+cSpace] = params.Params[pos+advance]

		if params.HasSubParams(pos + advance) {
			subparams := params.GetSubParams(pos + advance)
			i := 0
			for {
				if accu[1] == 5 {
					cSpace = 1
				}
				idx := advance + i + 1 + cSpace
				if idx >= len(accu) {
					break
				}
				accu[idx] = subparams[i]
				i++
				if i >= len(subparams) || i+advance+1+cSpace >= len(accu) {
					break
				}
			}
			break
		}

		// exit early if can decide color mode with semicolons
		if (accu[1] == 5 && advance+cSpace >= 2) || (accu[1] == 2 && advance+cSpace >= 5) {
			break
		}

		// offset colorSpace slot for semicolon mode
		if accu[1] != 0 {
			cSpace = 1
		}

		advance++
		if advance+pos >= params.Length || advance+cSpace >= len(accu) {
			break
		}
	}

	// set default values to 0 for unset slots
	for i := 2; i < len(accu); i++ {
		if accu[i] == -1 {
			accu[i] = 0
		}
	}

	// apply colors
	switch accu[0] {
	case 38:
		attr.Fg = h.updateAttrColor(attr.Fg, accu[1], accu[3], accu[4], accu[5])
	case 48:
		attr.Bg = h.updateAttrColor(attr.Bg, accu[1], accu[3], accu[4], accu[5])
	case 58:
		attr.Extended = attr.extended().Clone()
		uc := attr.Extended.UnderlineColor()
		attr.Extended.SetUnderlineColor(h.updateAttrColor(uc, accu[1], accu[3], accu[4], accu[5]))
		attr.UpdateExtended()
	}

	return advance
}

// processUnderline sets the underline style on extended attrs.
func (h *InputHandler) processUnderline(style int32, attr *AttributeData) {
	attr.Extended = attr.extended().Clone()

	// default to single underline for out-of-range or -1
	if style < 0 || style > 5 {
		style = 1
	}

	attr.Extended.SetUnderlineStyle(UnderlineStyle(style))
	attr.Fg |= FgFlagUnderline

	// 0 deactivates underline
	if style == 0 {
		attr.Fg &= ^FgFlagUnderline
	}

	attr.UpdateExtended()
}
