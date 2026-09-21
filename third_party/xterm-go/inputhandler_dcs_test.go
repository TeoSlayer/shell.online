package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestRequestStatusString(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Response string
	}

	t.Run("DECSCA_unprotected", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		// Query DECSCA — default is unprotected (0)
		h.ParseString("\x1bP$q\"q\x1b\\")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP1$r0\"q\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("DECSCA_protected", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		// Enable protected mode via DECSCA (CSI 1 " q), then query
		h.ParseString("\x1b[1\"q")
		h.ParseString("\x1bP$q\"q\x1b\\")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP1$r1\"q\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("DECSCL_conformance_level", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		h.ParseString("\x1bP$q\"p\x1b\\")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP1$r61;1\"p\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("DECSTBM_default_scroll_region", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		// Default scroll region is full screen: 1;24
		h.ParseString("\x1bP$qr\x1b\\")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP1$r1;24r\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("DECSTBM_custom_scroll_region", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		// Set scroll region to lines 5-20, then query
		h.ParseString("\x1b[5;20r")
		h.ParseString("\x1bP$qr\x1b\\")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP1$r5;20r\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("SGR_default", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		h.ParseString("\x1bP$qm\x1b\\")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP1$r0m\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("DECSCUSR_default_cursor_style", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		// Default: block, no blink → style 2
		h.ParseString("\x1bP$q q\x1b\\")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP1$r2 q\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("DECSCUSR_blinking_block", func(t *testing.T) {
		t.Parallel()
		opts := DefaultOptions()
		opts.Cols = 80
		opts.Rows = 24
		opts.CursorBlink = true
		opts.CursorStyle = CursorStyleBlock
		optsSvc := NewOptionsService(&opts)
		bufSvc := NewBufferService(optsSvc)
		charSvc := NewCharsetService()
		coreSvc := NewCoreService(optsSvc)
		oscLinkSvc := NewOscLinkService(bufSvc)
		uniSvc := NewUnicodeService()
		h := NewInputHandler(bufSvc, charSvc, coreSvc, optsSvc, oscLinkSvc, uniSvc)

		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		// Blinking block → style 1
		h.ParseString("\x1bP$q q\x1b\\")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP1$r1 q\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("DECSCUSR_underline_no_blink", func(t *testing.T) {
		t.Parallel()
		opts := DefaultOptions()
		opts.Cols = 80
		opts.Rows = 24
		opts.CursorStyle = CursorStyleUnderline
		optsSvc := NewOptionsService(&opts)
		bufSvc := NewBufferService(optsSvc)
		charSvc := NewCharsetService()
		coreSvc := NewCoreService(optsSvc)
		oscLinkSvc := NewOscLinkService(bufSvc)
		uniSvc := NewUnicodeService()
		h := NewInputHandler(bufSvc, charSvc, coreSvc, optsSvc, oscLinkSvc, uniSvc)

		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		// Underline, no blink → style 4
		h.ParseString("\x1bP$q q\x1b\\")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP1$r4 q\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("DECSCUSR_bar_blinking", func(t *testing.T) {
		t.Parallel()
		opts := DefaultOptions()
		opts.Cols = 80
		opts.Rows = 24
		opts.CursorBlink = true
		opts.CursorStyle = CursorStyleBar
		optsSvc := NewOptionsService(&opts)
		bufSvc := NewBufferService(optsSvc)
		charSvc := NewCharsetService()
		coreSvc := NewCoreService(optsSvc)
		oscLinkSvc := NewOscLinkService(bufSvc)
		uniSvc := NewUnicodeService()
		h := NewInputHandler(bufSvc, charSvc, coreSvc, optsSvc, oscLinkSvc, uniSvc)

		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		// Bar, blinking → style 5
		h.ParseString("\x1bP$q q\x1b\\")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP1$r5 q\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("unknown_request", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		// Unknown request string
		h.ParseString("\x1bP$qz\x1b\\")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP0$r\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})
}
