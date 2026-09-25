package agentlog

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

/*
 * Two of the three harnesses keep a JSON-lines record, and following one is
 * the same problem both times: read forward from where the last read stopped,
 * never re-read, and leave a line that has no newline yet for the next pass.
 * Only the decoding differs, so only the decoding is written twice.
 */

// decoder turns one record into an event, or reports that it is not one.
type decoder func(line []byte) (Event, bool)

// jsonlReader follows an append-only JSON-lines file.
//
// The offset is the whole of the state. Nothing is held in memory, so a
// session that has run all day costs the same as one a minute old.
type jsonlReader struct {
	path   string
	decode decoder
	at     int64
	seq    int
}

func (r *jsonlReader) Read() ([]Event, error) {
	file, err := os.Open(r.path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if _, err := file.Seek(r.at, io.SeekStart); err != nil {
		return nil, err
	}
	reader := bufio.NewReaderSize(file, 128*1024)
	var events []Event
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			/* No newline yet: a record still being written. Leave it. */
			break
		}
		r.at += int64(len(line))
		event, ok := r.decode(line)
		if !ok {
			continue
		}
		r.seq++
		event.Seq = r.seq
		event.Text = clamp(event.Text)
		if event.Choice != nil {
			event.Choice.Question = clamp(event.Choice.Question)
			if len(event.Choice.Options) > maxOptions {
				event.Choice.Options = event.Choice.Options[:maxOptions]
			}
		}
		events = append(events, event)
	}
	return events, nil
}

/*
 * Which file belongs to this session.
 *
 * Never derived from the directory's name. A harness that names a directory
 * after a working directory does it by turning the separators into dashes --
 * and so does a dash already in the path, and a session started at `/` is a
 * directory called `-`. The record states where it was started; it is asked.
 */
/*
 * Whether a file has already been looked at, and what it said.
 *
 * Deciding which record belongs to a session means opening candidates and
 * reading the top of each, and a session that never runs an agent asks that
 * question for as long as it lives. A machine that has been used for a while
 * has hundreds of candidates, so asked every second it is real work for an
 * answer that cannot have changed: a record states the directory it was
 * started in once, at the top, and never restates it.
 *
 * So the answer is kept against the file's modification time. A file that has
 * not changed is not reopened; one that has is asked again.
 */
var scanned sync.Map // path -> scanResult

type scanResult struct {
	at time.Time
	// dir is what the record itself says it was started in, which is a fact
	// about the file and not about the question being asked of it. Caching the
	// answer to "does this belong to /x" instead would answer for /y too.
	dir string
}

// statedDir returns the directory a record says it was started in, reading the
// file only when it has changed since the last time it was asked.
func statedDir(path string, at time.Time, read func(path string) string) string {
	if cached, ok := scanned.Load(path); ok {
		if result, ok := cached.(scanResult); ok && result.at.Equal(at) {
			return result.dir
		}
	}
	stated := read(path)
	scanned.Store(path, scanResult{at: at, dir: stated})
	return stated
}

func newestStartedIn(pattern, dir string, since time.Time, read func(path string) string) (string, error) {
	entries, err := filepath.Glob(pattern)
	if err != nil || len(entries) == 0 {
		return "", ErrNoTranscript
	}
	type candidate struct {
		path string
		at   time.Time
	}
	var found []candidate
	for _, path := range entries {
		info, err := os.Stat(path)
		if err != nil || info.ModTime().Before(since) {
			continue
		}
		stated := statedDir(path, info.ModTime(), read)
		if stated == "" || filepath.Clean(stated) != filepath.Clean(dir) {
			continue
		}
		found = append(found, candidate{path: path, at: info.ModTime()})
	}
	if len(found) == 0 {
		return "", ErrNoTranscript
	}
	sort.Slice(found, func(a, b int) bool { return found[a].at.After(found[b].at) })
	return found[0].path, nil
}

// headStates reads the first lines of a record for the directory it says it
// was started in. A whole file is not worth reading for something stated at
// the top of it.
func headStates(path string, field func(line []byte) (string, bool)) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for line := 0; line < 40 && scanner.Scan(); line++ {
		stated, ok := field(scanner.Bytes())
		if !ok || stated == "" {
			continue
		}
		return stated
	}
	return ""
}

// jsonField pulls one top-level string from a record without decoding the rest.
func jsonField(line []byte, name string) (string, bool) {
	var record map[string]json.RawMessage
	if json.Unmarshal(line, &record) != nil {
		return "", false
	}
	raw, ok := record[name]
	if !ok {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}
