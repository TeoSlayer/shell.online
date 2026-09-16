// Package stats gathers, on this machine, the few numbers the game's elixir
// vial is made of.
//
// It exists because of encryption rather than in spite of it. Sessions are
// sealed end to end: the accounts service derives no key and holds no password,
// so it cannot read terminal output and never will. Anything richer than
// counting rows -- pull requests open, lines changed, tokens spent -- exists
// only where the plaintext already is, which is here. So the reading happens
// here and what leaves is counts.
//
// Three rules this package is written to, in order of how much they matter:
//
//  1. Nothing read here ever leaves as text. Not a branch name, not a commit
//     message, not a path, not a diff, not a line of output. The Run struct has
//     nowhere to put any of it, which is the point: a shape that cannot carry
//     something cannot leak it because somebody later found it convenient.
//
//  2. Every source is optional and failing is normal. A machine with no git, no
//     GitHub CLI and no agent history is not an error condition; it reports
//     zeroes. One source failing never stops the others.
//
//  3. It runs only when asked. Nothing here polls, watches or schedules.
package stats

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Run is everything one gathering reports. Counts, and a failure to explain.
//
// There are no strings here except Error, and Error is a sentence for a person
// to read rather than anything gathered. See rule 1 above.
type Run struct {
	Tokens       int64  `json:"tokens"`
	PullRequests int64  `json:"pull_requests"`
	Commits      int64  `json:"commits"`
	Insertions   int64  `json:"insertions"`
	Deletions    int64  `json:"deletions"`
	Error        string `json:"error,omitempty"`
}

// Options says where to look and how far back. Zero values are sensible.
type Options struct {
	// Dir is the repository to read. Empty means the working directory.
	Dir string
	// Since bounds every count. Zero means the last seven days.
	Since time.Duration
	// Home is the account's home directory; empty asks the operating system.
	// A parameter so a test can describe a machine rather than depend on one.
	Home string
	// Look finds a program on PATH. Nil means exec.LookPath.
	Look func(string) (string, error)
	// Run executes a command and returns its standard output. Nil means really
	// running it, which is the only part of this package a test cannot drive.
	Run func(ctx context.Context, name string, args ...string) ([]byte, error)
}

const defaultSince = 7 * 24 * time.Hour

func (options Options) since() time.Duration {
	if options.Since > 0 {
		return options.Since
	}
	return defaultSince
}

func (options Options) look() func(string) (string, error) {
	if options.Look != nil {
		return options.Look
	}
	return exec.LookPath
}

func (options Options) run() func(context.Context, string, ...string) ([]byte, error) {
	if options.Run != nil {
		return options.Run
	}
	return func(ctx context.Context, name string, args ...string) ([]byte, error) {
		// Output, not CombinedOutput: standard error from these tools is prose
		// about what went wrong, and prose is what must not be parsed into a
		// count or carried anywhere.
		return exec.CommandContext(ctx, name, args...).Output()
	}
}

func (options Options) home() string {
	if options.Home != "" {
		return options.Home
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// Collect gathers what it can and reports zeroes for what it cannot.
//
// Failures are collected rather than returned: a machine without git is a
// perfectly ordinary machine, and a run that found two of its three sources is
// worth reporting. The vial showing a smaller number is better than the vial
// showing nothing because one tool was missing.
func Collect(ctx context.Context, options Options) Run {
	var run Run
	var trouble []string

	commits, insertions, deletions, err := gitWork(ctx, options)
	if err != nil {
		trouble = append(trouble, "git: "+short(err))
	}
	run.Commits = commits
	run.Insertions = insertions
	run.Deletions = deletions

	prs, err := openPullRequests(ctx, options)
	if err != nil {
		trouble = append(trouble, "gh: "+short(err))
	}
	run.PullRequests = prs

	tokens, err := agentTokens(options)
	if err != nil {
		trouble = append(trouble, "agents: "+short(err))
	}
	run.Tokens = tokens

	run.Error = strings.Join(trouble, "; ")
	if len(run.Error) > 200 {
		run.Error = run.Error[:200]
	}
	return run
}

// short keeps a failure to a sentence, and keeps paths out of it.
//
// An error from a command often quotes the directory it ran in, and a
// directory is a path, and paths are what rule 1 is about.
func short(err error) string {
	text := err.Error()
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		text = text[:index]
	}
	if len(text) > 60 {
		text = text[:60]
	}
	return text
}

/* ---- git ---------------------------------------------------------------- */

// gitWork counts commits and lines changed in the window.
//
// `--numstat` with an empty format prints one line per file, tab separated:
// added, deleted, path. The path is read and discarded here and never leaves
// this function.
func gitWork(ctx context.Context, options Options) (commits, insertions, deletions int64, err error) {
	if _, lookErr := options.look()("git"); lookErr != nil {
		return 0, 0, 0, lookErr
	}

	since := time.Now().Add(-options.since()).Format(time.RFC3339)
	args := []string{}
	if options.Dir != "" {
		args = append(args, "-C", options.Dir)
	}
	args = append(args, "log", "--since="+since, "--no-merges", "--pretty=tformat:%H", "--numstat")

	output, err := options.run()(ctx, "git", args...)
	if err != nil {
		return 0, 0, 0, err
	}
	commits, insertions, deletions = ParseNumstat(string(output))
	return commits, insertions, deletions, nil
}

// ParseNumstat reads `git log --pretty=tformat:%H --numstat` output.
//
// A commit is a line that is one field; a changed file is a line of three,
// where the first two are counts and the third is a path this ignores. Binary
// files print "-" for both counts, which is not zero and not a number, and is
// skipped rather than being read as either.
func ParseNumstat(output string) (commits, insertions, deletions int64) {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) == 1 {
			commits++
			continue
		}
		if len(fields) < 3 {
			continue
		}
		added, addErr := strconv.ParseInt(fields[0], 10, 64)
		removed, removeErr := strconv.ParseInt(fields[1], 10, 64)
		if addErr != nil || removeErr != nil {
			continue
		}
		insertions += added
		deletions += removed
	}
	return commits, insertions, deletions
}

/* ---- pull requests ------------------------------------------------------ */

// openPullRequests counts the caller's open pull requests, if `gh` is here.
//
// Only the count. `--json number` is the narrowest thing gh will print that
// still says how many there are: asking for titles or branches would be asking
// for text this package has promised not to carry.
func openPullRequests(ctx context.Context, options Options) (int64, error) {
	if _, err := options.look()("gh"); err != nil {
		return 0, err
	}
	output, err := options.run()(ctx, "gh", "pr", "list",
		"--author", "@me", "--state", "open", "--limit", "100", "--json", "number")
	if err != nil {
		return 0, err
	}
	return ParseGhCount(output)
}

// ParseGhCount counts the entries in gh's JSON array without keeping them.
func ParseGhCount(output []byte) (int64, error) {
	var entries []struct{}
	if err := json.Unmarshal(output, &entries); err != nil {
		return 0, err
	}
	return int64(len(entries)), nil
}

/* ---- tokens ------------------------------------------------------------- */

// agentHistories are the places coding agents keep their own session records.
//
// Read only for the token counts inside. These files also contain prompts and
// replies, which is exactly why what this returns is a single integer: there is
// no path out of this function for anything else.
var agentHistories = []string{
	filepath.Join(".claude", "projects"),
	filepath.Join(".codex", "sessions"),
}

// agentTokens sums what the local agents have spent inside the window.
func agentTokens(options Options) (int64, error) {
	home := options.home()
	if home == "" {
		return 0, os.ErrNotExist
	}

	cutoff := time.Now().Add(-options.since())
	var total int64
	var lastErr error

	for _, relative := range agentHistories {
		root := filepath.Join(home, relative)
		if _, err := os.Stat(root); err != nil {
			continue
		}
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				// A directory this account cannot read is not a reason to stop
				// walking the ones it can.
				return nil //nolint:nilerr
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".jsonl") {
				return nil
			}
			info, err := entry.Info()
			if err != nil || info.ModTime().Before(cutoff) {
				return nil
			}
			file, err := os.Open(path)
			if err != nil {
				return nil //nolint:nilerr
			}
			defer file.Close()
			total += SumTokens(file)
			return nil
		})
		if err != nil {
			lastErr = err
		}
	}
	return total, lastErr
}

// usage is the only part of an agent's record this package will look at.
//
// Declared as its own type, with only number fields, so that decoding a line
// cannot bring anything else along with it. The rest of the line -- the prompt,
// the reply, the file contents an agent was shown -- is not described here and
// is therefore discarded by the decoder rather than by a later decision.
type usage struct {
	Usage struct {
		InputTokens              int64 `json:"input_tokens"`
		OutputTokens             int64 `json:"output_tokens"`
		CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
		CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	} `json:"usage"`
	Message struct {
		Usage struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

// SumTokens adds up the usage reported across one JSONL history.
//
// Cache reads are read and deliberately not counted. They are the cheapest
// thing a model charges for and by far the most numerous -- counted at full
// weight they were ninety-nine per cent of the total, so three days of ordinary
// work reported four and a half billion tokens, which pins the vial at its
// maximum on the first run and never says anything again. What is counted is
// what is written: prompt, reply, and the cache entries the run created.
//
// Lines that do not parse are skipped rather than failing the file: these
// formats belong to other programs and change without telling anybody, and a
// history half in an older shape should still yield the half that is readable.
func SumTokens(reader io.Reader) int64 {
	var total int64
	scanner := bufio.NewScanner(reader)
	// Agent histories routinely carry lines far past the default 64 KB.
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var entry usage
		if err := json.Unmarshal(line, &entry); err != nil {
			continue
		}
		total += entry.Usage.InputTokens + entry.Usage.OutputTokens +
			entry.Usage.CacheCreationInputTokens
		total += entry.Message.Usage.InputTokens + entry.Message.Usage.OutputTokens +
			entry.Message.Usage.CacheCreationInputTokens
	}
	return total
}
