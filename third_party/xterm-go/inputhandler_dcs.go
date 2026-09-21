package xterm

// Ported from xterm.js src/common/InputHandler.ts — DCS sequence handlers.

import "fmt"

// requestStatusString handles DECRQSS (DCS $ q Pt ST).
// It responds with DECRPSS containing the requested terminal setting.
//
// Supported requests:
//   - "q  → DECSCA (protection attribute): responds with 0 or 1
//   - "p  → DECSCL (conformance level): responds with 61;1
//   - r   → DECSTBM (scroll region): responds with top;bottom
//   - m   → SGR (graphic rendition): responds with 0m
//   - ' 'q (SP q) → DECSCUSR (cursor style): responds with style number
//
// Unknown requests receive DCS 0 $ r ST.
func (h *InputHandler) requestStatusString(data string, params *Params) bool {
	respond := func(s string) bool {
		h.coreService.TriggerDataEvent("\x1b"+s+"\x1b\\", false, false)
		return true
	}

	switch data {
	case "\"q":
		// DECSCA — protection attribute
		p := 0
		if h.curAttrData.IsProtected() != 0 {
			p = 1
		}
		return respond(fmt.Sprintf("P1$r%d\"q", p))

	case "\"p":
		// DECSCL — conformance level (always report VT100 level 1)
		return respond("P1$r61;1\"p")

	case "r":
		// DECSTBM — scroll region
		buf := h.activeBuffer()
		return respond(fmt.Sprintf("P1$r%d;%dr", buf.ScrollTop+1, buf.ScrollBottom+1))

	case "m":
		// SGR — graphic rendition (report default for now)
		return respond("P1$r0m")

	case " q":
		// DECSCUSR — cursor style
		styles := map[CursorStyle]int{
			CursorStyleBlock:     2,
			CursorStyleUnderline: 4,
			CursorStyleBar:       6,
		}
		opts := h.optionsService.Options
		style := styles[opts.CursorStyle]
		if opts.CursorBlink {
			style--
		}
		return respond(fmt.Sprintf("P1$r%d q", style))

	default:
		// Unknown request
		return respond("P0$r")
	}
}
