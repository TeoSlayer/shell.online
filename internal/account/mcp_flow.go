package account

import (
	"context"
	"net/http"
	"net/url"
)

// MCP flow observations, the host half of shared/mcp-flow.ts.
//
// A flow event is metadata about one MCP tool call: who did what, when it
// started and how it actually settled. It never carries terminal content, tool
// arguments, patterns, tokens or credentials. The allowlists below mirror the
// TypeScript unions (shared/mcp-audit.ts, shared/mcp-flow.ts); a test parses
// those files and fails when the two sides drift.

// McpFlowTools is the set of tools that may be observed.
var McpFlowTools = []string{"shell_status", "shell_screen", "shell_output", "shell_wait", "shell_send"}

// McpAuditOutcomes is the set of settled outcomes, mirroring McpAuditOutcome.
var McpAuditOutcomes = []string{
	"ok", "busy", "denied", "too_large", "revoked", "error",
	"matched", "timeout", "cancelled", "reset", "limit", "disconnected",
	"delivered", "delivery_uncertain", "in_flight", "conflict",
}

var mcpFlowToolSet = func() map[string]bool {
	set := make(map[string]bool, len(McpFlowTools))
	for _, tool := range McpFlowTools {
		set[tool] = true
	}
	return set
}()

var mcpAuditOutcomeSet = func() map[string]bool {
	set := make(map[string]bool, len(McpAuditOutcomes))
	for _, outcome := range McpAuditOutcomes {
		set[outcome] = true
	}
	return set
}()

// ValidMcpFlowTool reports whether tool is one of the observed tools.
func ValidMcpFlowTool(tool string) bool { return mcpFlowToolSet[tool] }

// ValidMcpAuditOutcome reports whether outcome is an approved settled outcome.
func ValidMcpAuditOutcome(outcome string) bool { return mcpAuditOutcomeSet[outcome] }

// McpFlowEvent is one observation of one tool call.
type McpFlowEvent struct {
	ID   string `json:"id"`
	Tool string `json:"tool"`
	// "started" or "settled".
	Phase string `json:"phase"`
	// Unix milliseconds.
	At int64 `json:"at"`
	// Required when phase is "settled"; never present on "started".
	Outcome string `json:"outcome,omitempty"`
}

// IsUUIDV4 reports whether id is a canonical UUID version 4, the only id shape
// the relay issues. The service is deliberately more permissive; the host is
// strict about what it will even hand over.
func IsUUIDV4(id string) bool {
	if len(id) != 36 {
		return false
	}
	for index, character := range id {
		switch index {
		case 8, 13, 18, 23:
			if character != '-' {
				return false
			}
		case 14:
			if character != '4' {
				return false
			}
		case 19:
			switch character {
			case '8', '9', 'a', 'b', 'A', 'B':
			default:
				return false
			}
		default:
			if !isHexDigit(character) {
				return false
			}
		}
	}
	return true
}

func isHexDigit(character rune) bool {
	switch {
	case character >= '0' && character <= '9':
		return true
	case character >= 'a' && character <= 'f':
		return true
	case character >= 'A' && character <= 'F':
		return true
	default:
		return false
	}
}

// ReportMcpFlows hands one bounded batch of observations to the session's
// account. The events are the only thing in the body; the call is the caller's
// to bound and to drop.
func (client *Client) ReportMcpFlows(
	ctx context.Context, accessToken, sessionID string, events []McpFlowEvent,
) error {
	if len(events) == 0 {
		return nil
	}
	path := "/api/cli/sessions/" + url.PathEscape(sessionID) + "/mcp-flows"
	_, err := client.do(ctx, http.MethodPost, path, accessToken, map[string]any{"events": events})
	return err
}
