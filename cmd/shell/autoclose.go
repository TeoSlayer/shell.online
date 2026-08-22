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

func (*autoCloseFlag) IsBoolFlag() bool {
	return true
}

// normalizeAutoCloseArguments permits both --auto-close=5m and
// --auto-close 5m while retaining bare --auto-close as "close on task exit".
func normalizeAutoCloseArguments(arguments []string, now time.Time) []string {
	normalized := make([]string, 0, len(arguments))
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if argument == "--auto-close" && index+1 < len(arguments) {
			candidate := arguments[index+1]
			if !strings.HasPrefix(candidate, "-") {
				if _, err := parseCloseDeadline(candidate, now); err == nil {
					normalized = append(normalized, "--auto-close="+candidate)
					index++
					continue
				}
			}
		}
		normalized = append(normalized, argument)
	}
	return normalized
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
			clock := "00:00"
			if len(value) > len(prefix) {
				clock = strings.TrimSpace(value[len(prefix):])
			}
			parsedClock, err := time.ParseInLocation("15:04", clock, now.Location())
			if err != nil {
				return time.Time{}, false
			}
			return time.Date(day.Year(), day.Month(), day.Day(), parsedClock.Hour(), parsedClock.Minute(), 0, 0, now.Location()), true
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
