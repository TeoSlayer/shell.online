package xterm

// Ported from xterm.js src/common/services/CoreService.ts.

// defaultModes returns the default ANSI modes.
func defaultModes() Modes {
	return Modes{InsertMode: false}
}

// defaultDecPrivateModes returns the default DEC private modes.
func defaultDecPrivateModes() DecPrivateModes {
	return DecPrivateModes{
		Wraparound: true, // xterm default
	}
}

// defaultKittyKeyboardState returns a fresh kitty keyboard state.
func defaultKittyKeyboardState() KittyKeyboardState {
	return KittyKeyboardState{}
}

// CoreService manages terminal modes and provides data/binary event plumbing.
type CoreService struct {
	IsCursorInitialized bool
	IsCursorHidden      bool
	Modes               Modes
	DecPrivateModes     DecPrivateModes
	KittyKeyboard       KittyKeyboardState

	options *OptionsService

	OnDataEmitter                  EventEmitter[string]
	OnUserInputEmitter             EventEmitter[struct{}]
	OnBinaryEmitter                EventEmitter[string]
	OnRequestScrollToBottomEmitter EventEmitter[struct{}]
}

// NewCoreService creates a CoreService. The OptionsService is used to check
// disableStdin and scrollOnUserInput. bufferService is not stored; callers
// pass buffer state through TriggerDataEvent parameters.
func NewCoreService(opts *OptionsService) *CoreService {
	return &CoreService{
		IsCursorInitialized: opts.Options.ShowCursorImmediately,
		Modes:               defaultModes(),
		DecPrivateModes:     defaultDecPrivateModes(),
		KittyKeyboard:       defaultKittyKeyboardState(),
		options:             opts,
	}
}

// Reset restores modes and kitty keyboard state to defaults.
func (cs *CoreService) Reset() {
	cs.Modes = defaultModes()
	cs.DecPrivateModes = defaultDecPrivateModes()
	cs.KittyKeyboard = defaultKittyKeyboardState()
}

// TriggerDataEvent fires the OnData event. If wasUserInput is true and
// scrollOnUserInput is enabled, it also fires OnRequestScrollToBottom
// and OnUserInput. Respects disableStdin.
//
// shouldScroll indicates whether the viewport is not at the bottom (ybase != ydisp).
// The caller is responsible for computing this from the active buffer.
func (cs *CoreService) TriggerDataEvent(data string, wasUserInput bool, shouldScroll bool) {
	if cs.options.Options.DisableStdin {
		return
	}
	if wasUserInput && cs.options.Options.ScrollOnUserInput && shouldScroll {
		cs.OnRequestScrollToBottomEmitter.Fire(struct{}{})
	}
	if wasUserInput {
		cs.OnUserInputEmitter.Fire(struct{}{})
	}
	cs.OnDataEmitter.Fire(data)
}

// TriggerBinaryEvent fires the OnBinary event. Respects disableStdin.
func (cs *CoreService) TriggerBinaryEvent(data string) {
	if cs.options.Options.DisableStdin {
		return
	}
	cs.OnBinaryEmitter.Fire(data)
}

// Dispose cleans up all event emitters.
func (cs *CoreService) Dispose() {
	cs.OnDataEmitter.Dispose()
	cs.OnUserInputEmitter.Dispose()
	cs.OnBinaryEmitter.Dispose()
	cs.OnRequestScrollToBottomEmitter.Dispose()
}
