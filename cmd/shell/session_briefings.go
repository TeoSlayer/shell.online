package main

import (
	"context"
	"time"

	"shell.online/internal/account"
)

// briefingPrompt asks the bound conversation for a title and a one-line summary.
// It is only ever submitted through the adapter's safe, idle-only path.
const briefingPrompt = "In at most two short sentences, give a title and a one-line summary of what this conversation is about so far. Do not take any other action."

// StartBriefings only schedules adapters with a safe idle-only submission
// contract. No installed OpenCode adapter currently meets that contract;
// --port alone must never activate automatic prompting or a background poller.
func (link *sessionLink) StartBriefings(ctx context.Context, argv []string) {
	if link == nil {
		return
	}
	if _, ok := openCodeContentSessionID(argv); !ok {
		return
	}
	adapter := newOpenCodeBriefingAdapter()
	if !adapter.supportsIdleOnlySubmit() {
		return
	}
	command := append([]string(nil), argv...)
	go func() {
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			link.briefingTick(ctx, command, adapter)
			timer.Reset(time.Minute)
		}
	}()
}

// briefingTick runs one coordinator pass under the link lock, refreshing stale
// credentials first (the same best-effort renewal as the content path).
func (link *sessionLink) briefingTick(ctx context.Context, argv []string, adapter BriefingAdapter) {
	link.mu.Lock()
	defer link.mu.Unlock()
	if ctx.Err() != nil || link.sessionID == "" || link.contentClosed {
		return
	}
	if link.credentials.Expired(time.Now()) {
		bounded, cancel := context.WithTimeout(ctx, linkTimeout)
		refreshed, err := link.client.Refresh(bounded, link.credentials)
		cancel()
		if err != nil || account.Save(link.path, refreshed) != nil {
			return
		}
		link.credentials = refreshed
		link.accessToken = refreshed.AccessToken
	}
	coordinator := &BriefingCoordinator{
		adapter:   adapter,
		client:    link.client,
		sessionID: link.sessionID,
		statePath: briefingStatePath(link.sessionID),
		prompt:    briefingPrompt,
		now:       time.Now,
	}
	coordinator.Tick(ctx, argv, link.accessToken, link.credentials)
}
