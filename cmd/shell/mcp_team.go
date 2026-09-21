package main

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"shell.online/internal/account"
	"shell.online/internal/api"
)

// Host-side team MCP grant service.
//
// A teammate (their own account) asks for an observe-only grant on a session
// whose owner opted into team MCP. This session's machine is the only one that
// may answer: it polls the accounts service, mints a grant through the existing
// host-token path -- marked for the teammate, so the DO re-authorizes every use
// of it against the accounts service, live and fail-closed -- reports the opaque
// bearer back, and revokes + acks whatever the service tells it to.
//
// A request is minted at most once: the service keeps the grant it minted in
// memory and re-reports it if the first report was lost, rather than minting a
// second grant for the same request. A request the service no longer lists
// (answered, expired, acked) is forgotten.
//
// Every step is best effort, like the flow reporter: a full poll, a failed mint,
// an unreachable service or a refused token costs a slow answer, never a terminal.
// The grant's own expiry is the backstop for anything the service and the host
// fail to line up.

const (
	// One poll every few seconds: a request waits up to five minutes, so this is
	// comfortably fast enough without hammering the service.
	mcpTeamPollInterval = 5 * time.Second
	// Bounds one poll; a hung service must not hold the poller forever.
	mcpTeamPollTimeout = 10 * time.Second
	// The observe preset's default lifetime; the DO clamps it to the run's life.
	mcpTeamGrantTTL = 0
)

// mintedTeamGrant is the grant the service minted for one request, kept so a lost
// report is re-reported rather than re-minted.
type mintedTeamGrant struct {
	grantID   string
	expiresAt int64
	bearer    string
}

// mcpTeamService answers a session's team grant requests.
type mcpTeamService struct {
	link   *sessionLink
	grant  func(label string, scopes []string, ttl int, requesterUID string) (api.McpGrantCreated, error)
	revoke func(grantID string) error
	// The accounts-service calls, injected so a test can stand in for the
	// network. Only the poller's own goroutine calls them.
	listWork func(ctx context.Context, token, sessionID string) (account.McpTeamWorkList, error)
	report   func(ctx context.Context, token, sessionID, requestID string, report account.McpTeamGrantReport) error
	ack      func(ctx context.Context, token, sessionID, requestID string) error
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	once     sync.Once
	// True once the poller goroutine is running; stop waits on it only then.
	running  atomic.Bool
	interval time.Duration
	// minted maps a request id to the grant minted for it. Only the poller's own
	// goroutine reads or writes it.
	minted map[string]mintedTeamGrant
}

// newMcpTeamService builds a service around a link and the session's MCP
// closures. A nil link, or a session without MCP control, yields a service whose
// poll is a no-op: team MCP is optional, and a machine that is not signed in
// simply has nowhere to answer from.
func newMcpTeamService(
	link *sessionLink,
	grant func(label string, scopes []string, ttl int, requesterUID string) (api.McpGrantCreated, error),
	revoke func(grantID string) error,
) *mcpTeamService {
	pollContext, cancel := context.WithCancel(context.Background())
	service := &mcpTeamService{
		link:     link,
		grant:    grant,
		revoke:   revoke,
		ctx:      pollContext,
		cancel:   cancel,
		done:     make(chan struct{}),
		interval: mcpTeamPollInterval,
		minted:   make(map[string]mintedTeamGrant),
	}
	if link != nil {
		service.listWork = link.client.ListMcpTeamRequests
		service.report = link.client.ReportMcpTeamGrant
		service.ack = link.client.AckMcpTeamRevocation
	}
	return service
}

// startMcpTeamService starts the poller. Call on a link that exists; a nil link
// returns a service with nothing running.
func startMcpTeamService(
	link *sessionLink,
	grant func(label string, scopes []string, ttl int, requesterUID string) (api.McpGrantCreated, error),
	revoke func(grantID string) error,
) *mcpTeamService {
	service := newMcpTeamService(link, grant, revoke)
	if link != nil && grant != nil && revoke != nil {
		service.running.Store(true)
		go service.run()
	}
	return service
}

// startMcpTeamServiceFor wires the team service to a live session's MCP
// closures and starts it. A nil control (local session management unavailable)
// or a session without MCP control yields a service with nothing running.
func startMcpTeamServiceFor(control localSessionControl, link *sessionLink) *mcpTeamService {
	var grant func(label string, scopes []string, ttl int, requesterUID string) (api.McpGrantCreated, error)
	var revoke func(grantID string) error
	if unixSession, ok := control.(*managedLocalSession); ok {
		grant = unixSession.mcpTeamGrant
		revoke = unixSession.mcpRevoke
	}
	return startMcpTeamService(link, grant, revoke)
}

func (service *mcpTeamService) run() {
	defer close(service.done)
	ticker := time.NewTicker(service.interval)
	defer ticker.Stop()
	for {
		select {
		case <-service.ctx.Done():
			return
		case <-ticker.C:
			service.poll()
		}
	}
}

// poll answers one round of work. It never blocks the caller and never fails the
// session: every error is dropped and retried on the next tick.
func (service *mcpTeamService) poll() {
	if service.link == nil || service.grant == nil || service.revoke == nil ||
		service.listWork == nil || service.report == nil || service.ack == nil {
		return
	}
	token, sessionID := service.link.reportCredential(service.ctx, false)
	if token == "" || sessionID == "" {
		/* The session was never published; there is nowhere to answer from. */
		return
	}
	ctx, cancel := context.WithTimeout(service.ctx, mcpTeamPollTimeout)
	defer cancel()
	work, err := service.listWork(ctx, token, sessionID)
	if err != nil {
		return
	}
	// Forget grants whose request is no longer listed (answered, expired, acked).
	listed := make(map[string]bool, len(work.Issues)+len(work.Revocations))
	for _, item := range work.Issues {
		listed[item.RequestID] = true
	}
	for _, item := range work.Revocations {
		listed[item.RequestID] = true
	}
	for requestID := range service.minted {
		if !listed[requestID] {
			delete(service.minted, requestID)
		}
	}
	for _, item := range work.Issues {
		service.issue(ctx, token, sessionID, item)
	}
	for _, item := range work.Revocations {
		service.revokeGrant(ctx, token, sessionID, item)
	}
}

// issue answers one pending request: mint an observe-only grant for the requester
// (once) and report the bearer. A request already minted is re-reported, not
// re-minted, so a lost report cannot cost the owner a second grant.
func (service *mcpTeamService) issue(ctx context.Context, token, sessionID string, item account.McpTeamHostRequest) {
	report := account.McpTeamGrantReport{}
	if existing, ok := service.minted[item.RequestID]; ok {
		report = account.McpTeamGrantReport{
			GrantID:   existing.grantID,
			ExpiresAt: existing.expiresAt,
			Bearer:    existing.bearer,
		}
	} else {
		created, err := service.grant("team:"+item.RequesterUID, []string{"observe"}, mcpTeamGrantTTL, item.RequesterUID)
		if err != nil {
			return
		}
		report = account.McpTeamGrantReport{
			GrantID:   created.GrantID,
			ExpiresAt: created.ExpiresAt.UnixMilli(),
			Bearer:    created.Bearer,
		}
		service.minted[item.RequestID] = mintedTeamGrant{
			grantID:   created.GrantID,
			expiresAt: created.ExpiresAt.UnixMilli(),
			bearer:    created.Bearer,
		}
	}
	_ = service.report(ctx, token, sessionID, item.RequestID, report)
}

// revokeGrant revokes a grant the service told it to, then acks. The revoke comes
// first: the ack deletes the service's row, so it must follow a grant that is
// actually dead. A failed revoke is left for the next tick; the grant's own
// expiry is the backstop, and the DO's live use-time check denies it in the
// meantime.
func (service *mcpTeamService) revokeGrant(ctx context.Context, token, sessionID string, item account.McpTeamHostRequest) {
	if item.GrantID == "" {
		return
	}
	if err := service.revoke(item.GrantID); err != nil {
		return
	}
	_ = service.ack(ctx, token, sessionID, item.RequestID)
}

// stop ends the service. Idempotent and bounded: it cancels any in-flight poll
// and signals the goroutine. It waits for the poller to exit only when one is
// running, so a service that never started stops without blocking.
func (service *mcpTeamService) stop() {
	if service == nil {
		return
	}
	service.once.Do(func() {
		service.cancel()
		if service.running.Load() {
			<-service.done
		}
	})
}
