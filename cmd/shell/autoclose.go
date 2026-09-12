package main

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var closeDurationToken = regexp.MustCompile(`(?i)^(\d+(?:\.\d+)?)(mo|ms|s|m|h|d|w|y)`)

type autoCloseFlag struct {
	value string
}

func newAutoCloseFlag() *autoCloseFlag {
	return &autoCloseFlag{value: "task"}
}

func (flag *autoCloseFlag) String() string {
	return flag.value
}

func (flag *autoCloseFlag) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" || value == "true" {
		flag.value = "task"
		return nil
	}
	if value == "false" || strings.EqualFold(value, "never") {
		return fmt.Errorf("sessions always close when their task exits")
	}
	flag.value = value
	return nil
}

// normalizeAutoCloseArguments permits unquoted multi-token deadlines such as
// --auto-close tomorrow 09:00. The longest valid prefix becomes the flag value;
// a missing or invalid value is reported as a flag error instead of accidentally
// becoming the command to execute.
func normalizeAutoCloseArguments(arguments []string, now time.Time) ([]string, error) {
	normalized := make([]string, 0, len(arguments))
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if argument == "--" {
			normalized = append(normalized, arguments[index:]...)
			return normalized, nil
		}
		if argument != "--auto-close" {
			normalized = append(normalized, argument)
			if (argument == "--server" || argument == "--persistent") && index+1 < len(arguments) {
				normalized = append(normalized, arguments[index+1])
				index++
				continue
			}
			if !strings.HasPrefix(argument, "-") {
				normalized = append(normalized, arguments[index+1:]...)
				return normalized, nil
			}
			continue
		}
		if index+1 >= len(arguments) || strings.HasPrefix(arguments[index+1], "-") {
			return nil, fmt.Errorf("--auto-close requires a duration or date")
		}

		lastValid := -1
		// Why the first token's error is kept: when no prefix parses, the
		// value the user actually wrote is the single token, and its own
		// error says what is wrong with it. Reporting "invalid" for all of
		// them turns "that time has passed" into a grammar complaint.
		var firstError error
		for end := index + 1; end < len(arguments); end++ {
			candidate := strings.Join(arguments[index+1:end+1], " ")
			if _, err := parseCloseDeadline(candidate, now); err == nil {
				lastValid = end
				continue
			} else if end == index+1 {
				firstError = err
			}
			if lastValid >= 0 {
				break
			}
			// "in 15m" first becomes valid after its second token. Other invalid
			// first tokens cannot become a supported deadline by consuming a command.
			if end == index+1 && strings.EqualFold(arguments[end], "in") {
				continue
			}
			break
		}
		if lastValid < 0 {
			if firstError != nil {
				return nil, firstError
			}
			return nil, fmt.Errorf("invalid auto-close value %q", arguments[index+1])
		}
		normalized = append(normalized, "--auto-close="+strings.Join(arguments[index+1:lastValid+1], " "))
		index = lastValid
	}
	return normalized, nil
}

func parseCloseDeadline(value string, now time.Time) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" || value == "true" || strings.EqualFold(value, "task") {
		return time.Time{}, nil
	}
	if strings.HasPrefix(strings.ToLower(value), "in ") {
		value = strings.TrimSpace(value[3:])
	}

	if deadline, ok := parseRelativeDeadline(value, now); ok {
		if !deadline.After(now) {
			return time.Time{}, fmt.Errorf("auto-close deadline must be in the future")
		}
		return deadline, nil
	}

	if deadline, ok := parseAbsoluteDeadline(value, now); ok {
		if !deadline.After(now) {
			return time.Time{}, fmt.Errorf("auto-close deadline must be in the future")
		}
		return deadline, nil
	}

	return time.Time{}, fmt.Errorf("invalid auto-close value %q (try 5m, 2h, 3d, 1w, 2mo, or an ISO date)", value)
}

// processCloseDeadline starts relative durations when the shared process is
// ready to launch. Network/session setup must not consume a duration such as
// --auto-close 5s. Absolute dates retain their original wall-clock meaning.
func processCloseDeadline(value string, parsedDeadline, processStart time.Time) time.Time {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(strings.ToLower(value), "in ") {
		value = strings.TrimSpace(value[3:])
	}
	if deadline, ok := parseRelativeDeadline(value, processStart); ok {
		return deadline
	}
	return parsedDeadline
}

func parseRelativeDeadline(value string, now time.Time) (time.Time, bool) {
	remainder := strings.ReplaceAll(strings.TrimSpace(value), " ", "")
	if remainder == "" {
		return time.Time{}, false
	}

	deadline := now
	matched := false
	for remainder != "" {
		parts := closeDurationToken.FindStringSubmatch(remainder)
		if parts == nil {
			return time.Time{}, false
		}
		amount, err := strconv.ParseFloat(parts[1], 64)
		if err != nil || amount <= 0 || math.IsInf(amount, 0) || math.IsNaN(amount) {
			return time.Time{}, false
		}
		unit := strings.ToLower(parts[2])
		switch unit {
		case "y", "mo":
			if amount != math.Trunc(amount) {
				return time.Time{}, false
			}
			count := int(amount)
			if unit == "y" {
				deadline = deadline.AddDate(count, 0, 0)
			} else {
				deadline = deadline.AddDate(0, count, 0)
			}
		case "w", "d", "h", "m", "s", "ms":
			unitDuration := map[string]time.Duration{
				"w":  7 * 24 * time.Hour,
				"d":  24 * time.Hour,
				"h":  time.Hour,
				"m":  time.Minute,
				"s":  time.Second,
				"ms": time.Millisecond,
			}[unit]
			duration := amount * float64(unitDuration)
			if duration > float64(math.MaxInt64) {
				return time.Time{}, false
			}
			deadline = deadline.Add(time.Duration(duration))
		default:
			return time.Time{}, false
		}
		matched = true
		remainder = remainder[len(parts[0]):]
	}
	return deadline, matched
}

func parseAbsoluteDeadline(value string, now time.Time) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, true
		}
	}

	lower := strings.ToLower(value)
	for _, prefix := range []string{"today", "tomorrow"} {
		if lower == prefix || strings.HasPrefix(lower, prefix+" ") {
			day := now
			if prefix == "tomorrow" {
				day = day.AddDate(0, 0, 1)
			}
			// A bare day keyword carries no time of day, so it has to stand
			// for one. "tomorrow" takes the start of that day, which is still
			// ahead. "today" cannot: midnight has already passed whenever the
			// command runs, so the only reading of "close this today" that is
			// ever a deadline is the end of it. The last second rather than
			// the last minute, so that the form still works during 23:59.
			clock := "00:00"
			second := 0
			nanosecond := 0
			if prefix == "today" {
				clock = "23:59"
				second = 59
				nanosecond = int(time.Second - time.Nanosecond)
			}
			if len(value) > len(prefix) {
				clock = strings.TrimSpace(value[len(prefix):])
				second = 0
				nanosecond = 0
			}
			parsedClock, err := time.ParseInLocation("15:04", clock, now.Location())
			if err != nil {
				return time.Time{}, false
			}
			return time.Date(day.Year(), day.Month(), day.Day(), parsedClock.Hour(), parsedClock.Minute(), second, nanosecond, now.Location()), true
		}
	}

	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02"} {
		if parsed, err := time.ParseInLocation(layout, value, now.Location()); err == nil {
			return parsed, true
		}
	}

	if parsed, err := time.ParseInLocation("15:04", value, now.Location()); err == nil {
		deadline := time.Date(now.Year(), now.Month(), now.Day(), parsed.Hour(), parsed.Minute(), 0, 0, now.Location())
		if !deadline.After(now) {
			deadline = deadline.AddDate(0, 0, 1)
		}
		return deadline, true
	}
	return time.Time{}, false
}
