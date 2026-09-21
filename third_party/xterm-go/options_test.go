package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestDefaultOptions(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Cols         int
		Rows         int
		Scrollback   int
		CursorStyle  CursorStyle
		CursorWidth  int
		TabStopWidth int
		FontFamily   string
		FontSize     int
		LineHeight   float64
		LogLevel     LogLevel
		TermName     string
	}

	opts := DefaultOptions()
	got := Expectation{
		Cols:         opts.Cols,
		Rows:         opts.Rows,
		Scrollback:   opts.Scrollback,
		CursorStyle:  opts.CursorStyle,
		CursorWidth:  opts.CursorWidth,
		TabStopWidth: opts.TabStopWidth,
		FontFamily:   opts.FontFamily,
		FontSize:     opts.FontSize,
		LineHeight:   opts.LineHeight,
		LogLevel:     opts.LogLevel,
		TermName:     opts.TermName,
	}
	expected := Expectation{
		Cols:         80,
		Rows:         24,
		Scrollback:   1000,
		CursorStyle:  CursorStyleBlock,
		CursorWidth:  1,
		TabStopWidth: 8,
		FontFamily:   "monospace",
		FontSize:     15,
		LineHeight:   1.0,
		LogLevel:     LogLevelInfo,
		TermName:     "xterm",
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestNewOptionsServiceDefaults(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Cols       int
		Rows       int
		Scrollback int
	}

	s := NewOptionsService(nil)
	got := Expectation{
		Cols:       s.Options.Cols,
		Rows:       s.Options.Rows,
		Scrollback: s.Options.Scrollback,
	}
	expected := Expectation{Cols: 80, Rows: 24, Scrollback: 1000}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestNewOptionsServiceOverrides(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Cols       int
		Rows       int
		Scrollback int
		FontFamily string
	}

	s := NewOptionsService(&TerminalOptions{
		Cols:       120,
		Rows:       40,
		Scrollback: 5000,
	})
	got := Expectation{
		Cols:       s.Options.Cols,
		Rows:       s.Options.Rows,
		Scrollback: s.Options.Scrollback,
		FontFamily: s.Options.FontFamily,
	}
	expected := Expectation{Cols: 120, Rows: 40, Scrollback: 5000, FontFamily: "monospace"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestWindowsPtyMode(t *testing.T) {
	t.Parallel()

	type TestCase struct {
		Name     string
		Value    WindowsPty
		Expected bool
	}
	tests := []TestCase{
		{
			Name:     "old conpty build",
			Value:    WindowsPty{Backend: "conpty", BuildNo: 21375},
			Expected: true,
		},
		{
			Name:     "fixed conpty build",
			Value:    WindowsPty{Backend: "conpty", BuildNo: 21376},
			Expected: false,
		},
		{
			Name:     "missing build number",
			Value:    WindowsPty{Backend: "conpty"},
			Expected: false,
		},
		{
			Name:     "non-conpty backend",
			Value:    WindowsPty{Backend: "winpty", BuildNo: 21375},
			Expected: false,
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()

			got := tc.Value.windowsPtyMode()
			if got != tc.Expected {
				t.Errorf("windowsPtyMode() = %v, want %v", got, tc.Expected)
			}
		})
	}
}

func TestWindowsPtyHasWindowsPtyOptions(t *testing.T) {
	t.Parallel()

	type TestCase struct {
		Name     string
		Value    WindowsPty
		Expected bool
	}
	tests := []TestCase{
		{
			Name:     "unset",
			Value:    WindowsPty{},
			Expected: false,
		},
		{
			Name:     "backend only",
			Value:    WindowsPty{Backend: "winpty"},
			Expected: true,
		},
		{
			Name:     "build number only",
			Value:    WindowsPty{BuildNo: 21376},
			Expected: true,
		},
		{
			Name:     "backend and build number",
			Value:    WindowsPty{Backend: "conpty", BuildNo: 21375},
			Expected: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()

			got := tc.Value.hasWindowsPtyOptions()
			if got != tc.Expected {
				t.Errorf("hasWindowsPtyOptions() = %v, want %v", got, tc.Expected)
			}
		})
	}
}

func TestOptionsServiceSetOption(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Cols       int
		FiredEvent string
	}

	s := NewOptionsService(nil)
	var firedName string
	s.OnOptionChangeEmitter.Event(func(name string) {
		firedName = name
	})
	s.SetOption("cols", 120)

	got := Expectation{Cols: s.Options.Cols, FiredEvent: firedName}
	expected := Expectation{Cols: 120, FiredEvent: "cols"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOptionsServiceSetOptionNoChangeNoFire(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		FireCount int
	}

	s := NewOptionsService(nil)
	count := 0
	s.OnOptionChangeEmitter.Event(func(string) { count++ })
	s.SetOption("cols", 80) // same as default

	got := Expectation{FireCount: count}
	expected := Expectation{FireCount: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOptionsServiceSetOptionWindowsPty(t *testing.T) {
	t.Parallel()

	s := NewOptionsService(nil)
	var firedName string
	s.OnOptionChangeEmitter.Event(func(name string) {
		firedName = name
	})
	s.SetOption("windowsPty", WindowsPty{Backend: "conpty", BuildNo: 21375})

	got := struct {
		WindowsPty WindowsPty
		FiredEvent string
	}{
		WindowsPty: s.Options.WindowsPty,
		FiredEvent: firedName,
	}
	expected := struct {
		WindowsPty WindowsPty
		FiredEvent string
	}{
		WindowsPty: WindowsPty{Backend: "conpty", BuildNo: 21375},
		FiredEvent: "windowsPty",
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOptionsServiceSetOptionScrollback(t *testing.T) {
	t.Parallel()

	type TestCase struct {
		Name     string
		Value    int
		Expected int
	}
	tests := []TestCase{
		{"normal value", 500, 500},
		{"negative clamped to 0", -1, 0},
		{"max clamped", MaxBufferSize + 1, MaxBufferSize},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			s := NewOptionsService(nil)
			s.SetOption("scrollback", tc.Value)

			type Expectation struct {
				Scrollback int
			}
			got := Expectation{Scrollback: s.Options.Scrollback}
			expected := Expectation{Scrollback: tc.Expected}
			if diff := cmp.Diff(expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestOptionsServiceSetOptionCursorStyle(t *testing.T) {
	t.Parallel()

	type TestCase struct {
		Name     string
		Value    CursorStyle
		Expected CursorStyle
	}
	tests := []TestCase{
		{"block", CursorStyleBlock, CursorStyleBlock},
		{"underline", CursorStyleUnderline, CursorStyleUnderline},
		{"bar", CursorStyleBar, CursorStyleBar},
		{"invalid stays default", CursorStyle("invalid"), CursorStyleBlock},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			s := NewOptionsService(nil)
			s.SetOption("cursorStyle", tc.Value)

			type Expectation struct {
				CursorStyle CursorStyle
			}
			got := Expectation{CursorStyle: s.Options.CursorStyle}
			expected := Expectation{CursorStyle: tc.Expected}
			if diff := cmp.Diff(expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestOptionsServiceSetOptionTabStopWidth(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		TabStopWidth int
	}

	t.Run("valid value", func(t *testing.T) {
		t.Parallel()
		s := NewOptionsService(nil)
		s.SetOption("tabStopWidth", 4)
		got := Expectation{TabStopWidth: s.Options.TabStopWidth}
		expected := Expectation{TabStopWidth: 4}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("(-want +got):\n%s", diff)
		}
	})

	t.Run("zero rejected", func(t *testing.T) {
		t.Parallel()
		s := NewOptionsService(nil)
		s.SetOption("tabStopWidth", 0)
		got := Expectation{TabStopWidth: s.Options.TabStopWidth}
		expected := Expectation{TabStopWidth: 8} // default unchanged
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("(-want +got):\n%s", diff)
		}
	})
}

func TestOptionsServiceOnSpecificOptionChange(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		CallCount int
	}

	s := NewOptionsService(nil)
	count := 0
	s.OnSpecificOptionChange("cols", func() { count++ })
	s.SetOption("cols", 120)
	s.SetOption("rows", 40) // should not trigger

	got := Expectation{CallCount: count}
	expected := Expectation{CallCount: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOptionsServiceOnMultipleOptionChange(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		CallCount int
	}

	s := NewOptionsService(nil)
	count := 0
	s.OnMultipleOptionChange([]string{"cols", "rows"}, func() { count++ })
	s.SetOption("cols", 120)
	s.SetOption("rows", 40)
	s.SetOption("cursorBlink", true) // should not trigger

	got := Expectation{CallCount: count}
	expected := Expectation{CallCount: 2}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOptionsServiceDispose(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		CallCount int
	}

	s := NewOptionsService(nil)
	count := 0
	s.OnOptionChangeEmitter.Event(func(string) { count++ })
	s.Dispose()
	s.SetOption("cols", 120)

	got := Expectation{CallCount: count}
	expected := Expectation{CallCount: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOptionsServiceSetOptionConvertEol(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ConvertEol bool
		FireCount  int
	}

	s := NewOptionsService(nil)
	count := 0
	s.OnOptionChangeEmitter.Event(func(string) { count++ })
	s.SetOption("convertEol", true)

	got := Expectation{ConvertEol: s.Options.ConvertEol, FireCount: count}
	expected := Expectation{ConvertEol: true, FireCount: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOptionsServiceSetOptionMouseEventsRequireAlt(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		MouseEventsRequireAlt bool
		SpecificChangeCount   int
	}

	s := NewOptionsService(nil)
	changed := 0
	s.OnSpecificOptionChange("mouseEventsRequireAlt", func() { changed++ })
	s.SetOption("mouseEventsRequireAlt", true)
	s.SetOption("mouseEventsRequireAlt", true)

	got := Expectation{
		MouseEventsRequireAlt: s.Options.MouseEventsRequireAlt,
		SpecificChangeCount:   changed,
	}
	expected := Expectation{
		MouseEventsRequireAlt: true,
		SpecificChangeCount:   1,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestDefaultOptionsMouseEventsRequireAlt(t *testing.T) {
	t.Parallel()

	opts := DefaultOptions()
	if opts.MouseEventsRequireAlt != false {
		t.Errorf("MouseEventsRequireAlt default = %v, want false", opts.MouseEventsRequireAlt)
	}
}

func TestNewOptionsServiceMouseEventsRequireAltOverride(t *testing.T) {
	t.Parallel()

	s := NewOptionsService(&TerminalOptions{MouseEventsRequireAlt: true})
	if !s.Options.MouseEventsRequireAlt {
		t.Errorf("MouseEventsRequireAlt = %v, want true after override", s.Options.MouseEventsRequireAlt)
	}
}

func TestParamToWindowOption(t *testing.T) {
	t.Parallel()

	type TestCase struct {
		Name    string
		Param   int32
		Opts    WindowOptions
		Allowed bool
	}
	tests := []TestCase{
		{"default denies all", 18, WindowOptions{}, false},
		{"getWinSizeChars allowed", 18, WindowOptions{GetWinSizeChars: true}, true},
		{"restoreWin allowed", 1, WindowOptions{RestoreWin: true}, true},
		{"minimizeWin allowed", 2, WindowOptions{MinimizeWin: true}, true},
		{"setWinPosition allowed", 3, WindowOptions{SetWinPosition: true}, true},
		{"setWinSizePixels allowed", 4, WindowOptions{SetWinSizePixels: true}, true},
		{"raiseWin allowed", 5, WindowOptions{RaiseWin: true}, true},
		{"lowerWin allowed", 6, WindowOptions{LowerWin: true}, true},
		{"refreshWin allowed", 7, WindowOptions{RefreshWin: true}, true},
		{"setWinSizeChars allowed", 8, WindowOptions{SetWinSizeChars: true}, true},
		{"maximizeWin allowed", 9, WindowOptions{MaximizeWin: true}, true},
		{"fullscreenWin allowed", 10, WindowOptions{FullscreenWin: true}, true},
		{"getWinState allowed", 11, WindowOptions{GetWinState: true}, true},
		{"getWinPosition allowed", 13, WindowOptions{GetWinPosition: true}, true},
		{"getWinSizePixels allowed", 14, WindowOptions{GetWinSizePixels: true}, true},
		{"getScreenSizePixels allowed", 15, WindowOptions{GetScreenSizePixels: true}, true},
		{"getCellSizePixels allowed", 16, WindowOptions{GetCellSizePixels: true}, true},
		{"getScreenSizeChars allowed", 19, WindowOptions{GetScreenSizeChars: true}, true},
		{"getIconTitle allowed", 20, WindowOptions{GetIconTitle: true}, true},
		{"getWinTitle allowed", 21, WindowOptions{GetWinTitle: true}, true},
		{"pushTitle allowed", 22, WindowOptions{PushTitle: true}, true},
		{"popTitle allowed", 23, WindowOptions{PopTitle: true}, true},
		{"setWinLines allowed", 24, WindowOptions{SetWinLines: true}, true},
		{"param > 24 uses setWinLines", 25, WindowOptions{SetWinLines: true}, true},
		{"param > 24 denied without setWinLines", 30, WindowOptions{}, false},
		{"unmapped param 12 denied", 12, WindowOptions{}, false},
		{"wrong option for param", 14, WindowOptions{GetCellSizePixels: true}, false},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			got := paramToWindowOption(tc.Param, tc.Opts)
			if got != tc.Allowed {
				t.Errorf("paramToWindowOption(%d, ...) = %v, want %v", tc.Param, got, tc.Allowed)
			}
		})
	}
}
