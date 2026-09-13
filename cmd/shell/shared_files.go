package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"shell.online/internal/protocol"
	"shell.online/internal/relay"
)

const (
	sharedFileRequestBytes  = 4 * 1024
	sharedFileChunkBytes    = 16 * 1024
	sharedFileListEntries   = 256
	sharedFilePreviewBytes  = 16 * 1024 * 1024
	sharedFileDownloadBytes = 128 * 1024 * 1024
	sharedFileChunkKind     = 2
)

type sharedFileRequest struct {
	ID      uint32 `json:"id"`
	Type    string `json:"type"`
	Path    string `json:"path,omitempty"`
	Purpose string `json:"purpose,omitempty"`
	Offset  int64  `json:"offset,omitempty"`
	Token   string `json:"token,omitempty"`
}

type sharedFileEntry struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	Size int64  `json:"size,omitempty"`
}

// sharedFileService is created only for --files. os.Root makes path traversal
// and symlink escapes fail at the filesystem boundary rather than relying on
// string-prefix checks. No path or byte is sent until a viewer asks for it.
type sharedFileService struct {
	root    *os.Root
	base    string
	display string
	work    chan struct{}
}

func openSharedFileService(enabled bool, requestedRoot string) (*sharedFileService, error) {
	if !enabled && requestedRoot == "" {
		return nil, nil
	}
	rootPath := requestedRoot
	if rootPath == "" {
		var err error
		rootPath, err = os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("find session directory: %w", err)
		}
	}
	absolute, err := filepath.Abs(rootPath)
	if err != nil {
		return nil, fmt.Errorf("resolve shared files root: %w", err)
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return nil, fmt.Errorf("open shared files root: %w", err)
	}
	display := filepath.Base(filepath.Clean(absolute))
	if display == "." || display == string(filepath.Separator) || display == "" {
		display = "files"
	}
	return &sharedFileService{root: root, base: absolute, display: display, work: make(chan struct{}, 8)}, nil
}

func (service *sharedFileService) Close() error {
	if service == nil || service.root == nil {
		return nil
	}
	return service.root.Close()
}

func (service *sharedFileService) handle(
	connection *relay.Connection,
	cipher *sessionCipher,
	frame []byte,
) {
	if service == nil || len(frame) < 6 || len(frame)-5 > sharedFileRequestBytes {
		return
	}
	viewerID := binary.BigEndian.Uint32(frame[1:5])
	var request sharedFileRequest
	if viewerID == 0 || json.Unmarshal(frame[5:], &request) != nil || request.ID == 0 {
		return
	}
	select {
	case service.work <- struct{}{}:
		go func() {
			defer func() { <-service.work }()
			service.respond(connection, cipher, viewerID, request)
		}()
	default:
		service.sendJSON(connection, cipher, viewerID, map[string]any{
			"id": request.ID, "type": "error", "code": "BUSY", "message": "Too many file requests.",
		})
	}
}

func (service *sharedFileService) respond(connection *relay.Connection, cipher *sessionCipher, viewerID uint32, request sharedFileRequest) {
	switch request.Type {
	case "capabilities":
		service.sendJSON(connection, cipher, viewerID, map[string]any{
			"id": request.ID, "type": "capabilities", "version": 1, "root": service.display,
			"previewLimit": sharedFilePreviewBytes, "downloadLimit": sharedFileDownloadBytes,
		})
	case "list":
		entries, err := service.list(request.Path)
		if err != nil {
			service.sendError(connection, cipher, viewerID, request.ID, err)
			return
		}
		service.sendJSON(connection, cipher, viewerID, map[string]any{
			"id": request.ID, "type": "list", "path": cleanSharedFilePath(request.Path), "entries": entries,
		})
	case "read":
		service.read(connection, cipher, viewerID, request)
	default:
		service.sendJSON(connection, cipher, viewerID, map[string]any{
			"id": request.ID, "type": "error", "code": "PROTOCOL", "message": "Unknown file request.",
		})
	}
}

func cleanSharedFilePath(value string) string {
	value = strings.ReplaceAll(value, "\\", "/")
	value = strings.TrimPrefix(value, "./")
	cleaned := path.Clean(value)
	if cleaned == "." {
		return ""
	}
	return cleaned
}

func (service *sharedFileService) validPath(value string) (string, error) {
	if len(value) > 1024 || strings.IndexByte(value, 0) >= 0 {
		return "", fs.ErrInvalid
	}
	if filepath.IsAbs(value) {
		relative, err := filepath.Rel(service.base, value)
		if err != nil {
			return "", fs.ErrPermission
		}
		value = relative
	}
	cleaned := cleanSharedFilePath(value)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") || path.IsAbs(cleaned) || filepath.IsAbs(value) {
		return "", fs.ErrPermission
	}
	return cleaned, nil
}

func (service *sharedFileService) list(value string) ([]sharedFileEntry, error) {
	directory, err := service.validPath(value)
	if err != nil {
		return nil, err
	}
	if directory == "" {
		directory = "."
	}
	handle, err := service.root.Open(directory)
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	result := make([]sharedFileEntry, 0, sharedFileListEntries)
	for len(result) < sharedFileListEntries {
		entries, readErr := handle.ReadDir(64)
		for _, entry := range entries {
			info, infoErr := entry.Info()
			if infoErr != nil || info.Mode()&fs.ModeSymlink != 0 {
				continue
			}
			kind := "file"
			if info.IsDir() {
				kind = "directory"
			} else if !info.Mode().IsRegular() {
				continue
			}
			reference := entry.Name()
			if directory != "." {
				reference = path.Join(directory, entry.Name())
			}
			result = append(result, sharedFileEntry{Path: reference, Name: entry.Name(), Kind: kind, Size: info.Size()})
			if len(result) == sharedFileListEntries {
				break
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, readErr
		}
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].Kind != result[right].Kind {
			return result[left].Kind == "directory"
		}
		return strings.ToLower(result[left].Name) < strings.ToLower(result[right].Name)
	})
	return result, nil
}

func (service *sharedFileService) read(connection *relay.Connection, cipher *sessionCipher, viewerID uint32, request sharedFileRequest) {
	reference, err := service.validPath(request.Path)
	if err != nil || reference == "" {
		service.sendError(connection, cipher, viewerID, request.ID, fs.ErrPermission)
		return
	}
	limit := int64(sharedFilePreviewBytes)
	if request.Purpose == "download" {
		limit = sharedFileDownloadBytes
	} else if request.Purpose != "preview" {
		service.sendError(connection, cipher, viewerID, request.ID, fs.ErrInvalid)
		return
	}
	if request.Offset < 0 || request.Offset > limit {
		service.sendError(connection, cipher, viewerID, request.ID, fs.ErrInvalid)
		return
	}
	file, err := service.root.Open(reference)
	if err != nil {
		service.sendError(connection, cipher, viewerID, request.ID, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		if err == nil {
			err = fs.ErrPermission
		}
		service.sendError(connection, cipher, viewerID, request.ID, err)
		return
	}
	token := sharedFileToken(reference, info)
	if request.Token != "" && request.Token != token {
		service.sendJSON(connection, cipher, viewerID, map[string]any{
			"id": request.ID, "type": "error", "code": "CHANGED", "message": "The file changed during transfer.",
		})
		return
	}
	if request.Offset > info.Size() {
		service.sendError(connection, cipher, viewerID, request.ID, fs.ErrInvalid)
		return
	}
	if request.Offset == 0 {
		mediaType := sharedFileMediaType(file, info.Name())
		service.sendJSON(connection, cipher, viewerID, map[string]any{
			"id": request.ID, "type": "meta", "name": info.Name(), "mimeType": mediaType,
			"size": info.Size(), "token": token,
		})
	}
	chunk := make([]byte, min(sharedFileChunkBytes, int(info.Size()-request.Offset)))
	count, readErr := file.ReadAt(chunk, request.Offset)
	if readErr != nil && readErr != io.EOF {
		service.sendError(connection, cipher, viewerID, request.ID, readErr)
		return
	}
	chunk = chunk[:count]
	payload := make([]byte, 1+4+8+1+len(chunk))
	payload[0] = sharedFileChunkKind
	binary.BigEndian.PutUint32(payload[1:5], request.ID)
	binary.BigEndian.PutUint64(payload[5:13], uint64(request.Offset))
	if request.Offset+int64(count) >= info.Size() {
		payload[13] = 1
	}
	copy(payload[14:], chunk)
	service.send(connection, cipher, viewerID, payload)
}

func sharedFileMediaType(file *os.File, name string) string {
	mediaType := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	if mediaType == "" {
		sample := make([]byte, 512)
		count, err := file.ReadAt(sample, 0)
		if err == nil || err == io.EOF {
			mediaType = http.DetectContentType(sample[:count])
		}
	}
	if parsed, _, err := mime.ParseMediaType(mediaType); err == nil {
		mediaType = parsed
	}
	if mediaType == "" {
		return "application/octet-stream"
	}
	return mediaType
}

func sharedFileToken(reference string, info fs.FileInfo) string {
	value := fmt.Sprintf("%s\x00%d\x00%d\x00%d", reference, info.Size(), info.ModTime().UnixNano(), info.Mode())
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:16])
}

func (service *sharedFileService) sendError(connection *relay.Connection, cipher *sessionCipher, viewerID, requestID uint32, err error) {
	code := "UNAVAILABLE"
	message := "File unavailable."
	if os.IsPermission(err) || errors.Is(err, fs.ErrInvalid) || errors.Is(err, fs.ErrPermission) {
		code, message = "DENIED", "File access denied."
	}
	service.sendJSON(connection, cipher, viewerID, map[string]any{
		"id": requestID, "type": "error", "code": code, "message": message,
	})
}

func (service *sharedFileService) sendJSON(connection *relay.Connection, cipher *sessionCipher, viewerID uint32, value any) {
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) > 24*1024 {
		return
	}
	payload := append([]byte{1}, encoded...)
	service.send(connection, cipher, viewerID, payload)
}

func (service *sharedFileService) send(connection *relay.Connection, cipher *sessionCipher, viewerID uint32, payload []byte) {
	frame := make([]byte, 5+len(payload))
	frame[0] = protocol.FileResponse
	binary.BigEndian.PutUint32(frame[1:5], viewerID)
	copy(frame[5:], payload)
	sealed, err := sealFrame(cipher, frame)
	if err == nil {
		_ = connection.Send(relay.BinaryMessage, sealed)
	}
}
