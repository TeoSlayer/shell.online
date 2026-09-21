package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

// --- OSC title tests ---

func TestOSC_SetTitle_OSC2(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var title string
	h.OnTitleChangeEmitter.Event(func(s string) { title = s })

	// OSC 2 ; <title> BEL
	h.ParseString("\x1b]2;My Terminal\x07")

	if title != "My Terminal" {
		t.Errorf("expected title 'My Terminal', got %q", title)
	}
}

func TestOSC_SetTitle_OSC0(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var title string
	h.OnTitleChangeEmitter.Event(func(s string) { title = s })

	// OSC 0 ; <title> BEL
	h.ParseString("\x1b]0;Window Title\x07")

	if title != "Window Title" {
		t.Errorf("expected title 'Window Title', got %q", title)
	}
}

func TestOSC_SetTitle_ST(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var title string
	h.OnTitleChangeEmitter.Event(func(s string) { title = s })

	// OSC 2 ; <title> ST (ESC \)
	h.ParseString("\x1b]2;Title With ST\x1b\\")

	if title != "Title With ST" {
		t.Errorf("expected title 'Title With ST', got %q", title)
	}
}

func TestOSC_SetTitle_Empty(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var title string
	h.OnTitleChangeEmitter.Event(func(s string) { title = s })

	h.ParseString("\x1b]2;\x07")

	if title != "" {
		t.Errorf("expected empty title, got %q", title)
	}
}

// --- OSC icon name tests ---

func TestOSC1_SetIconName(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var iconName string
	h.OnIconNameChangeEmitter.Event(func(s string) { iconName = s })

	// OSC 1 ; <name> BEL
	h.ParseString("\x1b]1;my-icon\x07")

	if iconName != "my-icon" {
		t.Errorf("expected icon name 'my-icon', got %q", iconName)
	}
	if h.iconName != "my-icon" {
		t.Errorf("expected h.iconName 'my-icon', got %q", h.iconName)
	}
}

func TestOSC1_SetIconName_ST(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var iconName string
	h.OnIconNameChangeEmitter.Event(func(s string) { iconName = s })

	// OSC 1 ; <name> ST (ESC \)
	h.ParseString("\x1b]1;icon-st\x1b\\")

	if iconName != "icon-st" {
		t.Errorf("expected icon name 'icon-st', got %q", iconName)
	}
}

func TestOSC1_SetIconName_Empty(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// Set a non-empty icon name first.
	h.ParseString("\x1b]1;something\x07")

	var iconName string
	h.OnIconNameChangeEmitter.Event(func(s string) { iconName = s })

	h.ParseString("\x1b]1;\x07")

	if iconName != "" {
		t.Errorf("expected empty icon name, got %q", iconName)
	}
}

func TestOSC0_SetsTitleAndIconName(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var title, iconName string
	h.OnTitleChangeEmitter.Event(func(s string) { title = s })
	h.OnIconNameChangeEmitter.Event(func(s string) { iconName = s })

	// OSC 0 should set both title and icon name.
	h.ParseString("\x1b]0;both-value\x07")

	if title != "both-value" {
		t.Errorf("expected title 'both-value', got %q", title)
	}
	if iconName != "both-value" {
		t.Errorf("expected icon name 'both-value', got %q", iconName)
	}
}

func TestOSC2_DoesNotSetIconName(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	iconNameChanged := false
	h.OnIconNameChangeEmitter.Event(func(s string) { iconNameChanged = true })

	// OSC 2 should only set title, not icon name.
	h.ParseString("\x1b]2;title-only\x07")

	if iconNameChanged {
		t.Error("OSC 2 should not fire icon name change event")
	}
}

// --- OSC color tests ---

func TestOSC4_SetIndexedColor(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	// OSC 4 ; 1 ; #ff0000 BEL
	h.ParseString("\x1b]4;1;#ff0000\x07")

	type Expectation struct {
		Len   int
		Type  ColorRequestType
		Index int
		Color *ColorRGB
	}
	if len(events) == 0 {
		t.Fatal("expected color events, got none")
	}
	got := Expectation{
		Len:   len(events),
		Type:  events[0].Type,
		Index: events[0].Index,
		Color: events[0].Color,
	}
	want := Expectation{
		Len:   1,
		Type:  ColorRequestSet,
		Index: 1,
		Color: &ColorRGB{0xff, 0x00, 0x00},
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestOSC4_QueryIndexedColor(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	// OSC 4 ; 5 ; ? BEL
	h.ParseString("\x1b]4;5;?\x07")

	type Expectation struct {
		Len   int
		Type  ColorRequestType
		Index int
	}
	if len(events) == 0 {
		t.Fatal("expected color events, got none")
	}
	got := Expectation{Len: len(events), Type: events[0].Type, Index: events[0].Index}
	want := Expectation{Len: 1, Type: ColorRequestReport, Index: 5}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestOSC4_MultipleColors(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	// OSC 4 ; 0 ; #000000 ; 1 ; #ffffff BEL
	h.ParseString("\x1b]4;0;#000000;1;#ffffff\x07")

	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}

	type Expectation struct {
		Index0 int
		Color0 ColorRGB
		Index1 int
		Color1 ColorRGB
	}
	got := Expectation{
		Index0: events[0].Index,
		Color0: *events[0].Color,
		Index1: events[1].Index,
		Color1: *events[1].Color,
	}
	want := Expectation{
		Index0: 0,
		Color0: ColorRGB{0, 0, 0},
		Index1: 1,
		Color1: ColorRGB{0xff, 0xff, 0xff},
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestOSC10_SetFgColor(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	// OSC 10 ; rgb:ff/00/ff BEL
	h.ParseString("\x1b]10;rgb:ff/00/ff\x07")

	type Expectation struct {
		Type  ColorRequestType
		Index int
		Color *ColorRGB
	}
	if len(events) == 0 {
		t.Fatal("expected color events, got none")
	}
	got := Expectation{Type: events[0].Type, Index: events[0].Index, Color: events[0].Color}
	want := Expectation{Type: ColorRequestSet, Index: int(SpecialColorForeground), Color: &ColorRGB{0xff, 0x00, 0xff}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestOSC10_QueryFgColor(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	h.ParseString("\x1b]10;?\x07")

	if len(events) == 0 {
		t.Fatal("expected color events")
	}
	if events[0].Type != ColorRequestReport || events[0].Index != int(SpecialColorForeground) {
		t.Errorf("expected REPORT for foreground, got type=%d index=%d", events[0].Type, events[0].Index)
	}
}

func TestOSC11_SetBgColor(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	h.ParseString("\x1b]11;#00ff00\x07")

	if len(events) == 0 {
		t.Fatal("expected color events")
	}
	if events[0].Index != int(SpecialColorBackground) {
		t.Errorf("expected background index %d, got %d", SpecialColorBackground, events[0].Index)
	}
}

func TestOSC12_SetCursorColor(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	h.ParseString("\x1b]12;#aabbcc\x07")

	if len(events) == 0 {
		t.Fatal("expected color events")
	}
	if events[0].Index != int(SpecialColorCursor) {
		t.Errorf("expected cursor index %d, got %d", SpecialColorCursor, events[0].Index)
	}
}

func TestOSC104_RestoreIndexedColor(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	// OSC 104 ; 5 BEL
	h.ParseString("\x1b]104;5\x07")

	if len(events) == 0 {
		t.Fatal("expected color events")
	}
	if events[0].Type != ColorRequestRestore || events[0].Index != 5 {
		t.Errorf("expected RESTORE index=5, got type=%d index=%d", events[0].Type, events[0].Index)
	}
}

func TestOSC104_RestoreAll(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	// OSC 104 BEL (no params = restore all)
	h.ParseString("\x1b]104;\x07")

	if len(events) == 0 {
		t.Fatal("expected color events")
	}
	if events[0].Type != ColorRequestRestore {
		t.Errorf("expected RESTORE, got type=%d", events[0].Type)
	}
}

func TestOSC110_RestoreFgColor(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	h.ParseString("\x1b]110;\x07")

	if len(events) == 0 {
		t.Fatal("expected color events")
	}
	if events[0].Type != ColorRequestRestore || events[0].Index != int(SpecialColorForeground) {
		t.Errorf("expected RESTORE foreground, got type=%d index=%d", events[0].Type, events[0].Index)
	}
}

func TestOSC111_RestoreBgColor(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	h.ParseString("\x1b]111;\x07")

	if len(events) == 0 {
		t.Fatal("expected color events")
	}
	if events[0].Type != ColorRequestRestore || events[0].Index != int(SpecialColorBackground) {
		t.Errorf("expected RESTORE background, got type=%d index=%d", events[0].Type, events[0].Index)
	}
}

func TestOSC112_RestoreCursorColor(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var events []ColorEvent
	h.OnColorEmitter.Event(func(e []ColorEvent) { events = e })

	h.ParseString("\x1b]112;\x07")

	if len(events) == 0 {
		t.Fatal("expected color events")
	}
	if events[0].Type != ColorRequestRestore || events[0].Index != int(SpecialColorCursor) {
		t.Errorf("expected RESTORE cursor, got type=%d index=%d", events[0].Type, events[0].Index)
	}
}

// --- Color parsing tests ---

func TestParseColor_HashRRGGBB(t *testing.T) {
	t.Parallel()
	got := parseColor("#ff8040")
	want := &ColorRGB{0xff, 0x80, 0x40}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestParseColor_HashRGB(t *testing.T) {
	t.Parallel()
	got := parseColor("#f80")
	want := &ColorRGB{0xf0, 0x80, 0x00}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestParseColor_RgbFormat(t *testing.T) {
	t.Parallel()
	got := parseColor("rgb:ff/00/80")
	want := &ColorRGB{0xff, 0x00, 0x80}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestParseColor_RgbSingleDigit(t *testing.T) {
	t.Parallel()
	got := parseColor("rgb:f/0/8")
	want := &ColorRGB{0xff, 0x00, 0x88}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestParseColor_RgbFourDigit(t *testing.T) {
	t.Parallel()
	got := parseColor("rgb:ffff/0000/8000")
	want := &ColorRGB{0xff, 0x00, 0x80}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestParseColor_Invalid(t *testing.T) {
	t.Parallel()
	got := parseColor("not-a-color")
	if got != nil {
		t.Errorf("expected nil for invalid color, got %v", got)
	}
}

func TestParseColor_Hash12Digit(t *testing.T) {
	t.Parallel()
	got := parseColor("#ffff00008000")
	want := &ColorRGB{0xff, 0x00, 0x80}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

// --- OSC 8 hyperlink tests ---

func TestOSC8_CreateHyperlink(t *testing.T) {
	t.Parallel()
	h := newTestHandler()

	// OSC 8 ; ; http://example.com BEL
	h.ParseString("\x1b]8;;http://example.com\x07")

	linkId := h.getCurrentLinkId()
	if linkId == 0 {
		t.Fatal("expected non-zero link ID after creating hyperlink")
	}

	data := h.oscLinkService.GetLinkData(linkId)
	if data == nil {
		t.Fatal("expected link data")
	}
	if data.URI != "http://example.com" {
		t.Errorf("expected URI 'http://example.com', got %q", data.URI)
	}
}

func TestOSC8_FinishHyperlink(t *testing.T) {
	t.Parallel()
	h := newTestHandler()

	h.ParseString("\x1b]8;;http://example.com\x07")
	if h.getCurrentLinkId() == 0 {
		t.Fatal("expected link to be active")
	}

	// Finish: OSC 8 ; ; BEL
	h.ParseString("\x1b]8;;\x07")
	if h.getCurrentLinkId() != 0 {
		t.Error("expected link ID to be 0 after finishing hyperlink")
	}
}

func TestOSC8_HyperlinkWithId(t *testing.T) {
	t.Parallel()
	h := newTestHandler()

	// OSC 8 ; id=mylink ; http://example.com BEL
	h.ParseString("\x1b]8;id=mylink;http://example.com\x07")

	linkId := h.getCurrentLinkId()
	if linkId == 0 {
		t.Fatal("expected non-zero link ID")
	}

	data := h.oscLinkService.GetLinkData(linkId)
	if data == nil {
		t.Fatal("expected link data")
	}
	if data.ID != "mylink" {
		t.Errorf("expected ID 'mylink', got %q", data.ID)
	}
}
