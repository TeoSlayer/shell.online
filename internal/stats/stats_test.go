package stats

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Most of this file is about rule 1 at the top of stats.go: nothing read here
// leaves as text. The parsers all read lines that contain paths, messages and
// prompts, and all of them return integers. That is easy to write and easy to
// undo later by adding one convenient field, so it is asserted rather than
// trusted.

func TestParseNumstatCountsCommitsAndLines(t *testing.T) {
	output := strings.Join([]string{
		"a1b2c3",
		"10\t2\tsrc/game/world/scatter.ts",
		"4\t0\tsrc/game/pixi/scatter.ts",
		"d4e5f6",
		"1\t1\tREADME.md",
	}, "\n")

	commits, insertions, deletions := ParseNumstat(output)
	if commits != 2 {
		t.Fatalf("commits = %d, want 2", commits)
	}
	if insertions != 15 {
		t.Fatalf("insertions = %d, want 15", insertions)
	}
	if deletions != 3 {
		t.Fatalf("deletions = %d, want 3", deletions)
	}
}

func TestParseNumstatSkipsBinaryFiles(t *testing.T) {
	// Binary files print "-" for both counts, which is neither zero nor a
	// number. Reading it as either would quietly make every run with an image
	// in it wrong.
	commits, insertions, deletions := ParseNumstat("a1b2c3\n-\t-\tpublic/game/medieval-rts.png\n3\t1\tsrc/a.ts")
	if commits != 1 {
		t.Fatalf("commits = %d, want 1", commits)
	}
	if insertions != 3 || deletions != 1 {
		t.Fatalf("lines = +%d -%d, want +3 -1", insertions, deletions)
	}
}

func TestParseNumstatHandlesNothingAtAll(t *testing.T) {
	// A repository with no commits in the window is ordinary, not an error.
	commits, insertions, deletions := ParseNumstat("")
	if commits != 0 || insertions != 0 || deletions != 0 {
		t.Fatalf("empty output gave %d/%d/%d, want zeroes", commits, insertions, deletions)
	}
}

func TestParseNumstatHandlesWindowsLineEndings(t *testing.T) {
	commits, _, _ := ParseNumstat("a1b2c3\r\n1\t1\tfile.ts\r\n")
	if commits != 1 {
		t.Fatalf("commits = %d, want 1", commits)
	}
}

func TestParseGhCountCountsWithoutKeeping(t *testing.T) {
	count, err := ParseGhCount([]byte(`[{"number":1},{"number":7},{"number":12}]`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 3 {
		t.Fatalf("count = %d, want 3", count)
	}
}

func TestParseGhCountOnNoPullRequests(t *testing.T) {
	count, err := ParseGhCount([]byte(`[]`))
	if err != nil || count != 0 {
		t.Fatalf("count = %d, err = %v, want 0 and no error", count, err)
	}
}

func TestParseGhCountRefusesNonsense(t *testing.T) {
	if _, err := ParseGhCount([]byte("gh: not logged in")); err == nil {
		t.Fatal("expected an error from prose, got none")
	}
}

func TestSumTokensAddsEveryKind(t *testing.T) {
	history := strings.Join([]string{
		`{"usage":{"input_tokens":100,"output_tokens":50}}`,
		`{"message":{"usage":{"input_tokens":10,"output_tokens":5}}}`,
		`{"usage":{"cache_creation_input_tokens":200}}`,
	}, "\n")

	if total := SumTokens(strings.NewReader(history)); total != 365 {
		t.Fatalf("total = %d, want 365", total)
	}
}

func TestSumTokensLeavesCacheReadsOut(t *testing.T) {
	// Cache reads are the cheapest thing a model charges for and by far the
	// most numerous. Counted at full weight they were ninety-nine per cent of
	// the total: three days of ordinary work reported four and a half billion
	// tokens, which pins the vial at its maximum on the first run and never
	// says anything again.
	history := `{"usage":{"input_tokens":10,"cache_read_input_tokens":5000000}}`

	if total := SumTokens(strings.NewReader(history)); total != 10 {
		t.Fatalf("total = %d, want 10", total)
	}
}

func TestSumTokensIgnoresEverythingElseOnTheLine(t *testing.T) {
	// The line this test is really about. An agent's history holds prompts,
	// replies and file contents alongside the usage, and what comes back from
	// here is one integer with nowhere for any of that to travel.
	line := `{"usage":{"input_tokens":7},` +
		`"prompt":"the database password is hunter2",` +
		`"cwd":"/Users/someone/work/secret-project",` +
		`"content":"-----BEGIN PRIVATE KEY-----"}`

	if total := SumTokens(strings.NewReader(line)); total != 7 {
		t.Fatalf("total = %d, want 7", total)
	}
}

func TestSumTokensSkipsUnreadableLines(t *testing.T) {
	// These formats belong to other programs and change without telling
	// anybody. A history half in an older shape should still give up the half
	// that can be read.
	history := strings.Join([]string{
		`{"usage":{"input_tokens":5}}`,
		`not json at all`,
		``,
		`{"broken":`,
		`{"usage":{"input_tokens":6}}`,
	}, "\n")

	if total := SumTokens(strings.NewReader(history)); total != 11 {
		t.Fatalf("total = %d, want 11", total)
	}
}

func TestSumTokensReadsVeryLongLines(t *testing.T) {
	// Agent histories routinely carry lines far past bufio's 64 KB default,
	// and a scanner that stops at one silently loses the rest of the file.
	long := `{"usage":{"input_tokens":3},"content":"` + strings.Repeat("x", 300_000) + `"}`
	if total := SumTokens(strings.NewReader(long)); total != 3 {
		t.Fatalf("total = %d, want 3", total)
	}
}

func TestCollectReportsZeroesOnABareMachine(t *testing.T) {
	// A machine with no git, no gh and no agent history is not an error
	// condition. It reports nothing found, and says why, and the run still
	// counts as a run.
	run := Collect(context.Background(), Options{
		Home: t.TempDir(),
		Look: func(string) (string, error) { return "", errors.New("not found") },
		Run: func(context.Context, string, ...string) ([]byte, error) {
			t.Fatal("nothing should be executed when nothing is on PATH")
			return nil, nil
		},
	})

	if run.Commits != 0 || run.PullRequests != 0 || run.Tokens != 0 {
		t.Fatalf("expected zeroes, got %+v", run)
	}
	if run.Error == "" {
		t.Fatal("expected the run to say what was missing")
	}
}

func TestCollectKeepsGoingWhenOneSourceFails(t *testing.T) {
	// A run that found two of its three sources is worth reporting. The vial
	// showing a smaller number beats it showing nothing because gh is missing.
	run := Collect(context.Background(), Options{
		Home:  t.TempDir(),
		Since: time.Hour,
		Look: func(name string) (string, error) {
			if name == "git" {
				return "/usr/bin/git", nil
			}
			return "", errors.New("not found")
		},
		Run: func(_ context.Context, name string, _ ...string) ([]byte, error) {
			if name == "git" {
				return []byte("a1b2c3\n12\t4\tsrc/a.ts"), nil
			}
			return nil, errors.New("unexpected")
		},
	})

	if run.Commits != 1 || run.Insertions != 12 || run.Deletions != 4 {
		t.Fatalf("git counts lost: %+v", run)
	}
	if !strings.Contains(run.Error, "gh") {
		t.Fatalf("expected the missing tool named, got %q", run.Error)
	}
}

func TestCollectKeepsTheFailureShort(t *testing.T) {
	// An error from a command often quotes the directory it ran in, and a
	// directory is a path.
	run := Collect(context.Background(), Options{
		Home: t.TempDir(),
		Look: func(string) (string, error) { return "/usr/bin/git", nil },
		Run: func(context.Context, string, ...string) ([]byte, error) {
			return nil, errors.New(strings.Repeat("something went wrong. ", 60))
		},
	})
	if len(run.Error) > 200 {
		t.Fatalf("error is %d characters, want at most 200", len(run.Error))
	}
}

func TestCollectSumsAgentHistories(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "projects", "some-project")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	history := filepath.Join(dir, "session.jsonl")
	if err := os.WriteFile(history, []byte(`{"usage":{"input_tokens":400,"output_tokens":100}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	run := Collect(context.Background(), Options{
		Home: home,
		Look: func(string) (string, error) { return "", errors.New("not found") },
	})
	if run.Tokens != 500 {
		t.Fatalf("tokens = %d, want 500", run.Tokens)
	}
}

func TestCollectIgnoresHistoriesOlderThanTheWindow(t *testing.T) {
	// The run reports what was spent in the window, not everything ever spent.
	// Without this, every run reports the same growing lifetime total and the
	// service adds it to the last one.
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "projects", "old")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	history := filepath.Join(dir, "session.jsonl")
	if err := os.WriteFile(history, []byte(`{"usage":{"input_tokens":9999}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-90 * 24 * time.Hour)
	if err := os.Chtimes(history, old, old); err != nil {
		t.Fatal(err)
	}

	run := Collect(context.Background(), Options{
		Home:  home,
		Since: time.Hour,
		Look:  func(string) (string, error) { return "", errors.New("not found") },
	})
	if run.Tokens != 0 {
		t.Fatalf("tokens = %d, want 0 from a history outside the window", run.Tokens)
	}
}

func TestRunCarriesOnlyNumbers(t *testing.T) {
	// The shape itself, asserted. Everything a gathering reports is a count
	// except the failure sentence; a field for a branch, a message or a path
	// would be a way to carry those out of here, and this is where somebody
	// adding one has to argue for it.
	run := Collect(context.Background(), Options{
		Home: t.TempDir(),
		Look: func(string) (string, error) { return "", errors.New("not found") },
	})

	_ = run.Tokens
	_ = run.PullRequests
	_ = run.Commits
	_ = run.Insertions
	_ = run.Deletions
	_ = run.Error

	// Six fields, and the compiler has just checked their names and types. A
	// seventh would fail this line.
	if got := numberOfFields(run); got != 6 {
		t.Fatalf("Run has %d fields, want 6; a new one needs a reason", got)
	}
}

// numberOfFields reports how many fields a Run has, so the test above can hold
// the shape rather than merely reading it.
func numberOfFields(run Run) int {
	return reflect.TypeOf(run).NumField()
}
