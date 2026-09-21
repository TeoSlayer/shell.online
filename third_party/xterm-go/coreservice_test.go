package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestCoreServiceDefaults(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		InsertMode            bool
		Wraparound            bool
		ApplicationCursorKeys bool
		BracketedPasteMode    bool
		IsCursorInitialized   bool
		KittyKeyboardFlags    int
	}

	opts := NewOptionsService(nil)
	cs := NewCoreService(opts)

	got := Expectation{
		InsertMode:            cs.Modes.InsertMode,
		Wraparound:            cs.DecPrivateModes.Wraparound,
		ApplicationCursorKeys: cs.DecPrivateModes.ApplicationCursorKeys,
		BracketedPasteMode:    cs.DecPrivateModes.BracketedPasteMode,
		IsCursorInitialized:   cs.IsCursorInitialized,
		KittyKeyboardFlags:    cs.KittyKeyboard.Flags,
	}
	expected := Expectation{
		InsertMode:            false,
		Wraparound:            true,
		ApplicationCursorKeys: false,
		BracketedPasteMode:    false,
		IsCursorInitialized:   false,
		KittyKeyboardFlags:    0,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCoreServiceShowCursorImmediately(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		IsCursorInitialized bool
	}

	opts := NewOptionsService(&TerminalOptions{ShowCursorImmediately: true})
	cs := NewCoreService(opts)

	got := Expectation{IsCursorInitialized: cs.IsCursorInitialized}
	expected := Expectation{IsCursorInitialized: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCoreServiceReset(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		InsertMode bool
		Wraparound bool
		Flags      int
	}

	opts := NewOptionsService(nil)
	cs := NewCoreService(opts)
	cs.Modes.InsertMode = true
	cs.DecPrivateModes.Wraparound = false
	cs.KittyKeyboard.Flags = 42
	cs.Reset()

	got := Expectation{
		InsertMode: cs.Modes.InsertMode,
		Wraparound: cs.DecPrivateModes.Wraparound,
		Flags:      cs.KittyKeyboard.Flags,
	}
	expected := Expectation{InsertMode: false, Wraparound: true, Flags: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCoreServiceTriggerDataEvent(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		DataEvents []string
		UserInputs int
	}

	opts := NewOptionsService(nil)
	cs := NewCoreService(opts)

	var dataEvents []string
	userInputs := 0
	cs.OnDataEmitter.Event(func(s string) { dataEvents = append(dataEvents, s) })
	cs.OnUserInputEmitter.Event(func(struct{}) { userInputs++ })

	cs.TriggerDataEvent("hello", false, false)
	cs.TriggerDataEvent("world", true, false)

	got := Expectation{DataEvents: dataEvents, UserInputs: userInputs}
	expected := Expectation{DataEvents: []string{"hello", "world"}, UserInputs: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCoreServiceTriggerDataEventDisableStdin(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		DataEvents int
	}

	opts := NewOptionsService(&TerminalOptions{DisableStdin: true})
	cs := NewCoreService(opts)

	count := 0
	cs.OnDataEmitter.Event(func(string) { count++ })
	cs.TriggerDataEvent("hello", false, false)

	got := Expectation{DataEvents: count}
	expected := Expectation{DataEvents: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCoreServiceTriggerDataEventScrollToBottom(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ScrollRequests int
	}

	opts := NewOptionsService(&TerminalOptions{ScrollOnUserInput: true})
	cs := NewCoreService(opts)

	scrollRequests := 0
	cs.OnRequestScrollToBottomEmitter.Event(func(struct{}) { scrollRequests++ })

	// shouldScroll=true means ybase != ydisp
	cs.TriggerDataEvent("a", true, true)
	// shouldScroll=false means already at bottom
	cs.TriggerDataEvent("b", true, false)

	got := Expectation{ScrollRequests: scrollRequests}
	expected := Expectation{ScrollRequests: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCoreServiceTriggerBinaryEvent(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		BinaryEvents []string
	}

	opts := NewOptionsService(nil)
	cs := NewCoreService(opts)

	var events []string
	cs.OnBinaryEmitter.Event(func(s string) { events = append(events, s) })
	cs.TriggerBinaryEvent("\x1b[2J")

	got := Expectation{BinaryEvents: events}
	expected := Expectation{BinaryEvents: []string{"\x1b[2J"}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCoreServiceTriggerBinaryEventDisableStdin(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		BinaryEvents int
	}

	opts := NewOptionsService(&TerminalOptions{DisableStdin: true})
	cs := NewCoreService(opts)

	count := 0
	cs.OnBinaryEmitter.Event(func(string) { count++ })
	cs.TriggerBinaryEvent("data")

	got := Expectation{BinaryEvents: count}
	expected := Expectation{BinaryEvents: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCoreServiceDispose(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		DataEvents   int
		BinaryEvents int
	}

	opts := NewOptionsService(nil)
	cs := NewCoreService(opts)

	dataCount := 0
	binaryCount := 0
	cs.OnDataEmitter.Event(func(string) { dataCount++ })
	cs.OnBinaryEmitter.Event(func(string) { binaryCount++ })
	cs.Dispose()
	cs.TriggerDataEvent("a", false, false)
	cs.TriggerBinaryEvent("b")

	got := Expectation{DataEvents: dataCount, BinaryEvents: binaryCount}
	expected := Expectation{DataEvents: 0, BinaryEvents: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
