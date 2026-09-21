package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"shell.online/internal/account"
)

const openCodeContentLimit = 16 * 1024

var openCodeContentID = regexp.MustCompile(`^ses_[A-Za-z0-9]{1,120}$`)

// This binding describes the explicitly resumed launch conversation. OpenCode
// can switch conversations later; this is deliberately not a current-UI claim.
func openCodeContentSessionID(argv []string) (string, bool) {
	if len(argv) < 2 || filepath.Base(argv[0]) != "opencode" {
		return "", false
	}
	id := ""
	for i := 1; i < len(argv); i++ {
		flag, value, inline := strings.Cut(argv[i], "=")
		if flag == "--pure" && !inline {
			continue
		}
		switch flag {
		case "-s", "--session", "-m", "--model", "--agent", "--variant", "--port":
		default:
			return "", false
		}
		if !inline {
			i++
			if i >= len(argv) {
				return "", false
			}
			value = argv[i]
		}
		if value == "" || strings.HasPrefix(value, "-") {
			return "", false
		}
		if flag == "-s" || flag == "--session" {
			if id != "" || !openCodeContentID.MatchString(value) {
				return "", false
			}
			id = value
		}
	}
	return id, id != ""
}

type openCodeContentExecutor func(context.Context, string, string) ([]byte, error)

func readOpenCodeSessionContent(ctx context.Context, argv []string, now time.Time) (*account.SessionContent, error) {
	if _, ok := openCodeContentSessionID(argv); !ok {
		return nil, nil
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, nil
		}
		base = filepath.Join(home, ".local", "share")
	}
	if !filepath.IsAbs(base) {
		return nil, nil
	}
	return readOpenCodeSessionContentFrom(ctx, argv, now, filepath.Join(base, "opencode", "opencode.db"), executeOpenCodeContent)
}

func readOpenCodeSessionContentFrom(ctx context.Context, argv []string, now time.Time, path string, execute openCodeContentExecutor) (*account.SessionContent, error) {
	id, ok := openCodeContentSessionID(argv)
	if !ok {
		return nil, nil
	}
	// id has a strict ASCII allowlist; no other untrusted values enter the SQL.
	// LIMIT and SUBSTR bound projected text before it leaves SQLite. Parts are
	// ordered as OpenCode stores them, and tools/reasoning are never projected.
	query := `WITH latest AS (
 SELECT id, CAST(json_extract(data, '$.time.completed') AS INTEGER) AS completed
 FROM message WHERE session_id = '` + id + `'
 AND json_extract(data, '$.role') = 'assistant'
 AND json_extract(data, '$.finish') = 'stop'
 AND json_extract(data, '$.error') IS NULL
 AND COALESCE(json_extract(data, '$.summary'), 0) = 0
 AND json_extract(data, '$.time.completed') > 0
 ORDER BY time_created DESC, id DESC LIMIT 1
), texts AS (
 SELECT SUBSTR(json_extract(data, '$.text'), 1, 600) AS text FROM part
 WHERE session_id = '` + id + `' AND message_id = (SELECT id FROM latest)
 AND json_extract(data, '$.type') = 'text'
 AND COALESCE(json_extract(data, '$.synthetic'), 0) = 0
 ORDER BY id LIMIT 8
)
 SELECT SUBSTR(title, 1, 120) AS title,
 SUBSTR((SELECT group_concat(text, char(10)) FROM texts), 1, 600) AS description,
 COALESCE((SELECT completed FROM latest), time_updated) AS observed_at
 FROM session WHERE id = '` + id + `' LIMIT 1;`
	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	raw, err := execute(readCtx, path, query)
	if err != nil || len(raw) > openCodeContentLimit {
		return nil, nil
	}
	var rows []struct {
		Title       string `json:"title"`
		Description string `json:"description"`
		ObservedAt  int64  `json:"observed_at"`
	}
	if json.Unmarshal(raw, &rows) != nil || len(rows) != 1 {
		return nil, nil
	}
	row := rows[0]
	if row.ObservedAt <= 0 || row.ObservedAt > now.UnixMilli() {
		return nil, nil
	}
	title := cleanOpenCodeContent(row.Title, 120)
	description := cleanOpenCodeMarkdown(row.Description, 600)
	if title == "" && description == "" {
		return nil, nil
	}
	return &account.SessionContent{Version: 1, SuggestedTitle: title, Description: description, Source: "opencode-launch", ObservedAt: row.ObservedAt}, nil
}

func cleanOpenCodeContent(value string, limit int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return ' '
		}
		return r
	}, value)
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}

// Preserve Markdown structure while stripping terminal and bidi controls.
func cleanOpenCodeMarkdown(value string, limit int) string {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	value = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return ' '
		}
		return r
	}, value)
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > limit {
		runes = runes[:limit]
	}
	return string(runes)
}

type openCodeContentBuffer struct{ bytes.Buffer }

func (b *openCodeContentBuffer) Write(data []byte) (int, error) {
	if len(data) > openCodeContentLimit-b.Len() {
		return 0, errors.New("metadata exceeds limit")
	}
	return b.Buffer.Write(data)
}

func executeOpenCodeContent(ctx context.Context, path, query string) ([]byte, error) {
	// Never run OpenCode: its database command may migrate the database. Ignore
	// sqlite's user init file too, since it may contain arbitrary write commands.
	command := exec.CommandContext(ctx, "sqlite3", "-init", os.DevNull, "-readonly", "-json", path, query)
	var output openCodeContentBuffer
	command.Stdout = &output
	if err := command.Run(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}
