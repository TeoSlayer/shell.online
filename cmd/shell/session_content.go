package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"time"

	"shell.online/internal/account"
)

// Existing completed material only: never invokes an agent or writes to its PTY.
// The explicit launch conversation is the binding; unsupported launch forms
// do not silently fall back to another conversation in the same directory.
func (link *sessionLink) StartContent(ctx context.Context, argv []string) {
	if link == nil {
		return
	}
	if _, ok := openCodeContentSessionID(argv); !ok {
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
			link.publishExistingContent(ctx, command)
			timer.Reset(time.Minute)
		}
	}()
}

func (link *sessionLink) publishExistingContent(ctx context.Context, argv []string) {
	link.publishExistingContentWith(ctx, argv, readOpenCodeSessionContent)
}

func (link *sessionLink) publishExistingContentWith(ctx context.Context, argv []string,
	readContent func(context.Context, []string, time.Time) (*account.SessionContent, error)) {
	link.mu.Lock()
	defer link.mu.Unlock()
	if ctx.Err() != nil || link.sessionID == "" || link.contentClosed {
		return
	}
	bounded, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	// Never log provider content or server bodies on this best-effort path.
	if link.credentials.Expired(time.Now()) {
		next, err := link.client.Refresh(bounded, link.credentials)
		if err != nil {
			return
		}
		if account.Save(link.path, next) != nil {
			return
		}
		link.credentials = next
		link.accessToken = next.AccessToken
	}
	policy, err := link.client.SessionContentPolicy(bounded, link.accessToken, link.sessionID)
	if err != nil || !policy.Enabled || policy.Generation == "" || policy.OwnerUID != link.credentials.UID {
		return
	}
	if policy.NextPublishAt > time.Now().UnixMilli() {
		return
	}
	// The vault key must match the key already trusted during registration.
	key, ok, err := link.client.AccountKey(bounded, link.accessToken)
	if err != nil || !ok || key == "" || key != link.credentials.AccountKey {
		return
	}
	content, err := readContent(bounded, argv, time.Now())
	if err != nil || content == nil {
		return
	}
	// Do not consume the daily slot on a title alone while a response is pending.
	if content.Description == "" {
		return
	}
	encoded, err := json.Marshal(content)
	if err != nil {
		return
	}
	fingerprint := sha256.Sum256(encoded)
	if link.contentGeneration == policy.Generation && link.contentFingerprint == fingerprint {
		return
	}
	sender, sealed, err := account.SealSessionContent(key, link.sessionID, policy.OwnerUID, policy.Generation, *content)
	if err != nil || bounded.Err() != nil {
		return
	}
	if link.client.PublishSessionContent(bounded, link.accessToken, link.sessionID, account.SessionContentUpload{
		Generation: policy.Generation, ObservedAt: content.ObservedAt, SenderPublicKey: sender, Sealed: sealed,
	}) == nil {
		link.contentGeneration = policy.Generation
		link.contentFingerprint = fingerprint
	}
}
