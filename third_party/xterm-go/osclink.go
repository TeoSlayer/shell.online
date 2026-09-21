package xterm

// Ported from xterm.js src/common/services/OscLinkService.ts.

import "fmt"

// OscLinkData holds the data for an OSC hyperlink.
type OscLinkData struct {
	URI string
	ID  string // optional; links with the same ID+URI share an entry
}

// oscLinkEntry is an internal entry tracking a registered link.
type oscLinkEntry struct {
	id    int
	key   string // non-empty only for entries with an OscLinkData.ID
	data  OscLinkData
	lines []*Marker
}

// OscLinkService tracks active hyperlinks in the terminal buffer.
type OscLinkService struct {
	nextID int

	// entriesWithID maps "id;;uri" keys to entries (for links that have an ID).
	entriesWithID map[string]*oscLinkEntry

	// dataByLinkID maps numeric link IDs to entries.
	dataByLinkID map[int]*oscLinkEntry

	bufferService *BufferService
}

// NewOscLinkService creates an OscLinkService backed by the given BufferService.
func NewOscLinkService(bs *BufferService) *OscLinkService {
	return &OscLinkService{
		nextID:        1,
		entriesWithID: make(map[string]*oscLinkEntry),
		dataByLinkID:  make(map[int]*oscLinkEntry),
		bufferService: bs,
	}
}

// RegisterLink registers a hyperlink and returns its numeric link ID.
// Links without an ID are always created as new entries.
// Links with an ID reuse an existing entry if the key matches.
func (s *OscLinkService) RegisterLink(data OscLinkData) int {
	buffer := s.bufferService.Buffer()

	if data.ID == "" {
		marker := buffer.AddMarker(buffer.YBase + buffer.Y)
		entry := &oscLinkEntry{
			id:    s.nextID,
			data:  data,
			lines: []*Marker{marker},
		}
		s.nextID++
		marker.Register(marker.OnDispose(func(struct{}) {
			s.removeMarkerFromLink(entry, marker)
		}))
		s.dataByLinkID[entry.id] = entry
		return entry.id
	}

	key := s.entryIDKey(data)
	if match, ok := s.entriesWithID[key]; ok {
		s.AddLineToLink(match.id, buffer.YBase+buffer.Y)
		return match.id
	}

	marker := buffer.AddMarker(buffer.YBase + buffer.Y)
	entry := &oscLinkEntry{
		id:    s.nextID,
		key:   key,
		data:  data,
		lines: []*Marker{marker},
	}
	s.nextID++
	marker.Register(marker.OnDispose(func(struct{}) {
		s.removeMarkerFromLink(entry, marker)
	}))
	s.entriesWithID[key] = entry
	s.dataByLinkID[entry.id] = entry
	return entry.id
}

// AddLineToLink adds a line reference to an existing link.
func (s *OscLinkService) AddLineToLink(linkID, y int) {
	entry, ok := s.dataByLinkID[linkID]
	if !ok {
		return
	}
	// Don't add duplicate line references
	for _, m := range entry.lines {
		if m.Line == y {
			return
		}
	}
	marker := s.bufferService.Buffer().AddMarker(y)
	entry.lines = append(entry.lines, marker)
	marker.Register(marker.OnDispose(func(struct{}) {
		s.removeMarkerFromLink(entry, marker)
	}))
}

// GetLinkData returns the link data for a given link ID, or nil if not found.
func (s *OscLinkService) GetLinkData(linkID int) *OscLinkData {
	entry, ok := s.dataByLinkID[linkID]
	if !ok {
		return nil
	}
	return &entry.data
}

func (s *OscLinkService) entryIDKey(data OscLinkData) string {
	return fmt.Sprintf("%s;;%s", data.ID, data.URI)
}

func (s *OscLinkService) removeMarkerFromLink(entry *oscLinkEntry, marker *Marker) {
	idx := -1
	for i, m := range entry.lines {
		if m == marker {
			idx = i
			break
		}
	}
	if idx == -1 {
		return
	}
	entry.lines = append(entry.lines[:idx], entry.lines[idx+1:]...)

	// If no more lines reference this link, clean up the entry
	if len(entry.lines) == 0 {
		if entry.data.ID != "" {
			delete(s.entriesWithID, entry.key)
		}
		delete(s.dataByLinkID, entry.id)
	}
}
