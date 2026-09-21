package main

import (
	"context"
	"errors"
	"testing"
)

func TestOpenCodeBriefingAdapterBind(t *testing.T) {
	adapter := newOpenCodeBriefingAdapter()
	if adapter.Name() != "opencode" {
		t.Fatalf("name = %q", adapter.Name())
	}
	id, ok := adapter.Bind([]string{"opencode", "--pure", "-s", "ses_synthetic"})
	if !ok || id != "ses_synthetic" {
		t.Fatalf("bind = (%q, %v); want (ses_synthetic, true)", id, ok)
	}
	if _, ok := adapter.Bind([]string{"opencode", "run"}); ok {
		t.Fatal("bound a conversation with no explicit -s id")
	}
}

func TestOpenCodeBriefingAdapterFailsClosed(t *testing.T) {
	adapter := newOpenCodeBriefingAdapter()
	ctx := context.Background()

	// A status snapshot cannot provide a lease for atomic idle-only submission.
	idle, ok, err := adapter.Idle(ctx, "ses_synthetic")
	if err != nil || ok || idle {
		t.Fatalf("Idle = (%v, %v, %v); want (false, false, nil)", idle, ok, err)
	}

	// Even a direct call cannot bypass the missing atomic runtime operation.
	if _, err := adapter.Submit(ctx, "ses_synthetic", "prompt"); !errors.Is(err, errBriefingNotSafe) {
		t.Fatalf("Submit err = %v; want errBriefingNotSafe", err)
	}
}
