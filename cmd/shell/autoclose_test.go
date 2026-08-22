package main

import (
	"reflect"
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

func TestNormalizeAutoCloseArguments(t *testing.T) {
	now := time.Date(2026, time.August, 19, 23, 40, 0, 0, time.UTC)
	tests := []struct {
		input []string
		want  []string
	}{
		{input: []string{"--auto-close", "5m", "sleep", "30"}, want: []string{"--auto-close=5m", "sleep", "30"}},
		{input: []string{"--auto-close", "echo"}, want: []string{"--auto-close", "echo"}},
		{input: []string{"--auto-close=2h", "echo"}, want: []string{"--auto-close=2h", "echo"}},
	}
	for _, test := range tests {
		if got := normalizeAutoCloseArguments(test.input, now); !reflect.DeepEqual(got, test.want) {
			t.Fatalf("normalizeAutoCloseArguments(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}
