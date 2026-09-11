package main

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestParseCloseDeadline(t *testing.T) {
	location := time.FixedZone("test", 2*60*60)
	now := time.Date(2026, time.August, 19, 23, 40, 0, 0, location)

	tests := []struct {
		name  string
		value string
		want  time.Time
	}{
		{name: "task", value: "task", want: time.Time{}},
		{name: "seconds", value: "5s", want: now.Add(5 * time.Second)},
		{name: "fractional minutes", value: "1.5m", want: now.Add(90 * time.Second)},
		{name: "compound", value: "2d 3h 4m", want: now.Add(51*time.Hour + 4*time.Minute)},
		{name: "weeks", value: "5w", want: now.Add(35 * 24 * time.Hour)},
		{name: "months", value: "2mo", want: now.AddDate(0, 2, 0)},
		{name: "years", value: "1y", want: now.AddDate(1, 0, 0)},
		{name: "in prefix", value: "in 15m", want: now.Add(15 * time.Minute)},
		{name: "tomorrow", value: "tomorrow 09:15", want: time.Date(2026, time.August, 20, 9, 15, 0, 0, location)},
		{name: "bare tomorrow", value: "tomorrow", want: time.Date(2026, time.August, 20, 0, 0, 0, 0, location)},
		{name: "bare today", value: "today", want: time.Date(2026, time.August, 19, 23, 59, 59, 0, location)},
		{name: "today with clock", value: "today 23:50", want: time.Date(2026, time.August, 19, 23, 50, 0, 0, location)},
		{name: "clock rolls forward", value: "22:00", want: time.Date(2026, time.August, 20, 22, 0, 0, 0, location)},
		{name: "local date", value: "2026-08-21 12:30", want: time.Date(2026, time.August, 21, 12, 30, 0, 0, location)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseCloseDeadline(test.value, now)
			if err != nil {
				t.Fatalf("parseCloseDeadline(%q): %v", test.value, err)
			}
			if !got.Equal(test.want) {
				t.Fatalf("parseCloseDeadline(%q) = %v, want %v", test.value, got, test.want)
			}
		})
	}
}

func TestParseCloseDeadlineRejectsInvalidValues(t *testing.T) {
	now := time.Date(2026, time.August, 19, 23, 40, 0, 0, time.UTC)
	for _, value := range []string{"0s", "-5m", "1.5mo", "forever", "2020-01-01", "false"} {
		t.Run(value, func(t *testing.T) {
			if _, err := parseCloseDeadline(value, now); err == nil {
				t.Fatalf("parseCloseDeadline(%q) unexpectedly succeeded", value)
			}
		})
	}
}

func TestProcessCloseDeadlineStartsRelativeDurationAfterSetup(t *testing.T) {
	parsedAt := time.Date(2026, time.August, 19, 23, 40, 0, 0, time.UTC)
	processStart := parsedAt.Add(12 * time.Second)
	parsedDeadline, err := parseCloseDeadline("25ms", parsedAt)
	if err != nil {
		t.Fatal(err)
	}

	got := processCloseDeadline("25ms", parsedDeadline, processStart)
	want := processStart.Add(25 * time.Millisecond)
	if !got.Equal(want) {
		t.Fatalf("processCloseDeadline() = %v, want %v", got, want)
	}
}

func TestProcessCloseDeadlinePreservesAbsoluteTime(t *testing.T) {
	parsedAt := time.Date(2026, time.August, 19, 23, 40, 0, 0, time.UTC)
	processStart := parsedAt.Add(12 * time.Second)
	parsedDeadline := parsedAt.Add(time.Hour)

	got := processCloseDeadline("2026-08-20T00:40:00Z", parsedDeadline, processStart)
	if !got.Equal(parsedDeadline) {
		t.Fatalf("processCloseDeadline() = %v, want %v", got, parsedDeadline)
	}
}

func TestNormalizeAutoCloseArguments(t *testing.T) {
	now := time.Date(2026, time.August, 19, 23, 40, 0, 0, time.UTC)
	tests := []struct {
		input []string
		want  []string
	}{
		{input: []string{"--auto-close", "5m", "sleep", "30"}, want: []string{"--auto-close=5m", "sleep", "30"}},
		{input: []string{"--auto-close", "tomorrow", "09:00", "sleep", "30"}, want: []string{"--auto-close=tomorrow 09:00", "sleep", "30"}},
		{input: []string{"--auto-close", "today", "sleep", "30"}, want: []string{"--auto-close=today", "sleep", "30"}},
		{input: []string{"--auto-close", "in", "15m", "sleep", "30"}, want: []string{"--auto-close=in 15m", "sleep", "30"}},
		{input: []string{"--auto-close", "2d", "3h", "sleep", "30"}, want: []string{"--auto-close=2d 3h", "sleep", "30"}},
		{input: []string{"--auto-close=2h", "echo"}, want: []string{"--auto-close=2h", "echo"}},
		{input: []string{"--server", "https://example.test", "--auto-close", "5m", "sleep"}, want: []string{"--server", "https://example.test", "--auto-close=5m", "sleep"}},
		{input: []string{"echo", "--auto-close", "not-a-shell-flag"}, want: []string{"echo", "--auto-close", "not-a-shell-flag"}},
		{input: []string{"--", "echo", "--auto-close", "not-a-shell-flag"}, want: []string{"--", "echo", "--auto-close", "not-a-shell-flag"}},
	}
	for _, test := range tests {
		got, err := normalizeAutoCloseArguments(test.input, now)
		if err != nil {
			t.Fatalf("normalizeAutoCloseArguments(%q): %v", test.input, err)
		}
		if !reflect.DeepEqual(got, test.want) {
			t.Fatalf("normalizeAutoCloseArguments(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}

func TestNormalizeAutoCloseArgumentsRejectsMissingAndInvalidValues(t *testing.T) {
	now := time.Date(2026, time.August, 19, 23, 40, 0, 0, time.UTC)
	for _, input := range [][]string{
		{"--auto-close"},
		{"--auto-close", "notatime", "sleep", "30"},
		{"--auto-close", "5minutes", "sleep", "30"},
	} {
		if _, err := normalizeAutoCloseArguments(input, now); err == nil {
			t.Fatalf("normalizeAutoCloseArguments(%q) unexpectedly succeeded", input)
		}
	}
}

// A bare "today" is only useful if it is a deadline at every hour it can be
// typed, including during the last minute of the day.
func TestBareTodayIsADeadlineAllDay(t *testing.T) {
	location := time.FixedZone("test", 2*60*60)
	for _, clock := range []struct{ hour, minute, second int }{
		{0, 0, 0}, {9, 15, 0}, {23, 58, 0}, {23, 59, 30},
	} {
		now := time.Date(2026, time.August, 19, clock.hour, clock.minute, clock.second, 0, location)
		deadline, err := parseCloseDeadline("today", now)
		if err != nil {
			t.Fatalf("parseCloseDeadline(\"today\") at %v: %v", now, err)
		}
		if !deadline.After(now) {
			t.Fatalf("parseCloseDeadline(\"today\") at %v = %v, want a future deadline", now, deadline)
		}
		if deadline.Day() != now.Day() {
			t.Fatalf("parseCloseDeadline(\"today\") at %v = %v, want the same day", now, deadline)
		}
	}
}

// A date that has passed is a different mistake from one that cannot be read,
// and the unquoted form used to report both as "invalid".
func TestNormalizeAutoCloseArgumentsReportsPastDeadlines(t *testing.T) {
	now := time.Date(2026, time.August, 19, 23, 40, 0, 0, time.UTC)
	_, err := normalizeAutoCloseArguments([]string{"--auto-close", "2020-01-01", "sleep", "30"}, now)
	if err == nil {
		t.Fatal("normalizeAutoCloseArguments unexpectedly accepted a past date")
	}
	if !strings.Contains(err.Error(), "must be in the future") {
		t.Fatalf("normalizeAutoCloseArguments error = %q, want it to say the deadline has passed", err)
	}
}
