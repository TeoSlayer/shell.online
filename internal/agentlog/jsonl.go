package agentlog

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
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
func newestStartedIn(pattern, dir string, since time.Time, statesDir func(path, dir string) bool) (string, error) {
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
		if !statesDir(path, dir) {
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

// headStates reads the first lines of a record looking for the directory it
// was started in. A whole file is not worth reading for something stated at
// the top of it.
func headStates(path, dir string, field func(line []byte) (string, bool)) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for line := 0; line < 40 && scanner.Scan(); line++ {
		stated, ok := field(scanner.Bytes())
		if !ok || stated == "" {
			continue
		}
		return filepath.Clean(stated) == filepath.Clean(dir)
	}
	return false
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
