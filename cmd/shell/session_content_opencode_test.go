package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestOpenCodeContentSessionBinding(t *testing.T) {
	for _, argv := range [][]string{
		{"opencode", "-s", "ses_123"},
		{"opencode", "--session=ses_123"},
		{"opencode", "--pure", "-s", "ses_123", "--model", "provider/model"},
		{"/opt/bin/opencode", "--session=ses_123", "--model", "provider/model", "--variant=high"},
	} {
		if id, ok := openCodeContentSessionID(argv); !ok || id != "ses_123" {
			t.Fatalf("valid binding rejected: %q", argv)
		}
	}
	for _, argv := range [][]string{
		nil, {"opencode"}, {"sh", "-c", "opencode -s ses_123"}, {"env", "opencode", "-s", "ses_123"},
		{"opencode", "--continue", "-s", "ses_123"}, {"opencode", "--fork", "-s", "ses_123"},
		{"opencode", "run", "-s", "ses_123"}, {"opencode", "-s", "ses_123", "--session", "ses_456"},
		{"opencode", "-s", "ses_123' OR 1=1--"}, {"opencode", "--session"},
		{"opencode", "-s", "ses_123", "--model"}, {"opencode", "-s", "ses_123", "--unknown=yes"},
		{"opencode", "-s", "ses_123", "--model", "--fork"},
		{"opencode", "-s", "ses_123", "--pure=true"},
	} {
		if _, ok := openCodeContentSessionID(argv); ok {
			t.Fatalf("ambiguous binding accepted: %q", argv)
		}
		called := false
		result, err := readOpenCodeSessionContentFrom(context.Background(), argv, time.Now(), "unused", func(context.Context, string, string) ([]byte, error) {
			called = true
			return nil, nil
		})
		if result != nil || err != nil || called {
			t.Fatal("unsupported launch must not read anything")
		}
	}
}

func TestOpenCodeContentBoundedReader(t *testing.T) {
	now := time.UnixMilli(2000)
	read := func(raw string, failure error) bool {
		t.Helper()
		result, err := readOpenCodeSessionContentFrom(context.Background(), []string{"opencode", "-s", "ses_123"}, now, "/fixture.db", func(ctx context.Context, path, query string) ([]byte, error) {
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > 2*time.Second {
				t.Fatal("missing bounded deadline")
			}
			if path != "/fixture.db" || !strings.Contains(query, "session_id = 'ses_123'") || !strings.Contains(query, "SUBSTR") {
				t.Fatal("missing exact bounded projection")
			}
			return []byte(raw), failure
		})
		if err != nil {
			t.Fatal(err)
		}
		return result != nil
	}
	for _, raw := range []string{"", "invalid", "[]", "[{},{}]", `[{"title":"ok","observed_at":0}]`, `[{"title":"ok","observed_at":2001}]`, strings.Repeat("x", openCodeContentLimit+1)} {
		if read(raw, nil) {
			t.Fatal("invalid/unavailable metadata accepted")
		}
	}
	if read(`[{"title":"ok","observed_at":1000}]`, errors.New("unavailable")) {
		t.Fatal("failed read accepted")
	}
	if !read(`[{"title":"ok","description":null,"observed_at":1000}]`, nil) {
		t.Fatal("title-only metadata rejected")
	}
	clean := cleanOpenCodeContent(" \x00hello\n\u202eworld\t"+strings.Repeat("界", 700), 600)
	if utf8.RuneCountInString(clean) != 600 || strings.ContainsAny(clean, "\x00\n\u202e\t") {
		t.Fatal("text not bounded/cleaned")
	}
	var buffer openCodeContentBuffer
	if _, err := buffer.Write(make([]byte, openCodeContentLimit)); err != nil {
		t.Fatal(err)
	}
	if _, err := buffer.Write([]byte{1}); err == nil || buffer.Len() != openCodeContentLimit {
		t.Fatal("stdout limit not enforced")
	}
}

func TestOpenCodeContentReadOnlyFixture(t *testing.T) {
	sqlite, err := exec.LookPath("sqlite3")
	if err != nil {
		t.Skip("sqlite3 not installed; pure adapter tests still run")
	}
	path := filepath.Join(t.TempDir(), "fixture.db")
	fixture := `CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER);
CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT);
INSERT INTO session VALUES('ses_target','Synthetic title',1000),('ses_other','Unrelated title',1900);
INSERT INTO message VALUES
('m1','ses_target',1000,'{"role":"assistant","finish":"stop","time":{"completed":1100}}'),
('m2','ses_target',1200,'{"role":"assistant","finish":"stop","summary":true,"time":{"completed":1300}}'),
('m3','ses_target',1400,'{"role":"assistant","finish":"stop","error":{"name":"failed"},"time":{"completed":1500}}'),
('m4','ses_target',1600,'{"role":"assistant","finish":"tool-calls","time":{"completed":1700}}'),
('m5','ses_target',1800,'{"role":"assistant","finish":"stop","time":{}}'),
('m6','ses_other',1900,'{"role":"assistant","finish":"stop","time":{"completed":1950}}');
INSERT INTO part VALUES
('p1','m1','ses_target','{"type":"text","text":"Completed synthetic excerpt."}'),
('p2','m1','ses_target','{"type":"reasoning","text":"Excluded reasoning"}'),
('p3','m1','ses_target','{"type":"tool","text":"Excluded tool"}'),
('p4','m1','ses_target','{"type":"text","synthetic":true,"text":"Excluded synthetic"}'),
('p5','m2','ses_target','{"type":"text","text":"Excluded summary"}'),
('p6','m6','ses_other','{"type":"text","text":"Excluded other session"}');`
	if output, err := exec.Command(sqlite, "-init", os.DevNull, path, fixture).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v: %s", err, output)
	}
	result, err := readOpenCodeSessionContentFrom(context.Background(), []string{"opencode", "-s", "ses_target"}, time.UnixMilli(2000), path, executeOpenCodeContent)
	if err != nil || result == nil {
		t.Fatalf("read failed: %v", err)
	}
	if result.Version != 1 || result.Source != "opencode-launch" || result.ObservedAt != 1100 || result.SuggestedTitle != "Synthetic title" || result.Description != "Completed synthetic excerpt." {
		t.Fatalf("unexpected synthetic result: %+v", result)
	}
	if _, err := executeOpenCodeContent(context.Background(), path, "DELETE FROM session;"); err == nil {
		t.Fatal("database writer was allowed")
	}
	missing, err := readOpenCodeSessionContentFrom(context.Background(), []string{"opencode", "-s", "ses_missing"}, time.UnixMilli(2000), path, executeOpenCodeContent)
	if err != nil || missing != nil {
		t.Fatal("missing session must not fall back to another conversation")
	}
	missingPath := filepath.Join(t.TempDir(), "absent.db")
	if _, err := executeOpenCodeContent(context.Background(), missingPath, "SELECT 1;"); err == nil {
		t.Fatal("missing database should fail without creating it")
	}
	if _, err := os.Stat(missingPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("read-only adapter created a database")
	}
}
