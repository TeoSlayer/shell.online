package main

// OpenCode v1.18.30's HTTP interface cannot safely generate an automatic
// briefing. POST /session/:id/prompt_async persists a user message before
// joining the per-session runner; it does not reject a concurrently busy
// session. A preceding GET /session/status cannot close that race. The global
// TUI kv.json also cannot attest which running TUI owns a conversation.
//
// Keep this boundary fail-closed even when a port and a plugin marker exist.
// Supporting it requires a runtime operation that atomically validates the
// current TUI/run, consent attempt and idle revision, rejects human activity,
// and returns a durable message identity for correlated completion. A 204
// response or the latest completed assistant message is not that receipt.
func newOpenCodeHTTPAdapter(serverURL, kvPath, dbPath string) *openCodeBriefingAdapter {
	return newOpenCodeBriefingAdapter()
}
