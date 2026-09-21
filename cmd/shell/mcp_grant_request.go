package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxMcpGrantEnvelope = 1536 // Leaves room inside the 2048-byte local control line.

type mcpGrantRequest struct {
	Label  string `json:"label"`
	Scopes string `json:"scopes"`
	TTL    int    `json:"ttl"`
}

func parseMcpGrantTTL(value string) (int, error) {
	if value == "" || strings.IndexFunc(value, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
		return 0, errors.New("ttl must be a non-negative whole number of seconds (0 uses the default)")
	}
	ttl, err := strconv.Atoi(value)
	if err != nil {
		return 0, errors.New("ttl is out of range")
	}
	return ttl, nil
}

func validateMcpGrantRequest(request mcpGrantRequest) error {
	if len(request.Label) > 256 || !utf8.ValidString(request.Label) || strings.IndexFunc(request.Label, unicode.IsControl) >= 0 {
		return errors.New("grant label must be valid UTF-8, at most 256 bytes, without control characters")
	}
	if request.TTL < 0 {
		return errors.New("ttl must be non-negative")
	}
	if len(request.Scopes) > 128 {
		return errors.New("invalid MCP scopes")
	}
	seen := map[string]bool{}
	for _, scope := range mcpGrantScopes(request.Scopes) {
		switch scope {
		case "observe", "input", "interrupt":
			seen[scope] = true
		default:
			return errors.New("invalid MCP scopes")
		}
	}
	if !seen["observe"] || (seen["interrupt"] && !seen["input"]) {
		return errors.New("invalid MCP scope combination")
	}
	return nil
}

// The distinct verb makes an old host refuse the request. Never fall back to
// whitespace-delimited labels: doing so can turn label data into grant authority.
func encodeMcpGrantCommand(request mcpGrantRequest) (string, error) {
	if err := validateMcpGrantRequest(request); err != nil {
		return "", err
	}
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(request); err != nil {
		return "", errors.New("cannot encode MCP grant request")
	}
	encoded := base64.RawURLEncoding.EncodeToString(bytes.TrimSuffix(body.Bytes(), []byte("\n")))
	if len(encoded) > maxMcpGrantEnvelope {
		return "", errors.New("MCP grant request is too large")
	}
	return "mcp grant-v2 " + encoded, nil
}

func decodeMcpGrantEnvelope(encoded string) (mcpGrantRequest, error) {
	var request mcpGrantRequest
	invalid := errors.New("invalid MCP grant envelope")
	if len(encoded) == 0 || len(encoded) > maxMcpGrantEnvelope {
		return request, invalid
	}
	body, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || !utf8.Valid(body) {
		return request, invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return request, invalid
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return request, invalid
		}
		seen[key] = true
		// Pointers distinguish null from an explicitly empty label or zero TTL.
		switch key {
		case "label", "scopes":
			var value *string
			if err := decoder.Decode(&value); err != nil || value == nil {
				return request, invalid
			}
			if key == "label" {
				request.Label = *value
			} else {
				request.Scopes = *value
			}
		case "ttl":
			var value *int
			if err := decoder.Decode(&value); err != nil || value == nil {
				return request, invalid
			}
			request.TTL = *value
		default:
			return request, invalid
		}
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') || len(seen) != 3 {
		return request, invalid
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return request, invalid
	}
	return request, validateMcpGrantRequest(request)
}

func parseMcpGrantCommand(args []string) (mcpGrantRequest, error) {
	var request mcpGrantRequest
	if len(args) == 2 && args[0] == "grant-v2" {
		return decodeMcpGrantEnvelope(args[1])
	}
	if (len(args) != 3 && len(args) != 4) || args[0] != "grant" {
		return request, errors.New("invalid MCP grant arguments")
	}
	request.Label, request.Scopes = args[1], args[2]
	if len(args) == 4 {
		var err error
		request.TTL, err = parseMcpGrantTTL(args[3])
		if err != nil {
			return request, err
		}
	}
	return request, validateMcpGrantRequest(request)
}
