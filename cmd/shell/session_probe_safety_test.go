//go:build !windows

package main

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestSessionProbeFailureNeverDiscardsLiveOrUnknownHost(t *testing.T) {
	for _, probeErr := range []error{syscall.EPERM, syscall.EACCES, os.ErrDeadlineExceeded, errors.New("invalid response")} {
		t.Run(probeErr.Error(), func(t *testing.T) {
			isolatedRuntime(t)
			directory, err := ensureLocalSessionDirectory()
			if err != nil {
				t.Fatal(err)
			}
			record := localSessionRecord{ID: strings.Repeat("p", 32), PID: os.Getpid(), StartedAt: time.Now(), Password: "synthetic-password"}
			control, err := startLocalSession(record)
			if err != nil {
				t.Fatal(err)
			}
			defer control.Close()
			path := localSessionRecordPath(directory, record.ID)
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			socketBefore, err := os.Lstat(localSessionSocketPath(directory, record.ID))
			if err != nil {
				t.Fatal(err)
			}
			active, abandoned, err := scanLocalSessionsWithProbe(func(string, string) (localControlResponse, error) {
				return localControlResponse{}, probeErr
			}, func(int) bool { return false })
			if err != nil || len(active) != 0 || len(abandoned) != 0 {
				t.Fatalf("probe must remain unknown: active=%d abandoned=%d err=%v", len(active), len(abandoned), err)
			}
			after, err := os.ReadFile(path)
			if err != nil || string(before) != string(after) {
				t.Fatal("a denied probe changed the live record")
			}
			socketAfter, err := os.Lstat(localSessionSocketPath(directory, record.ID))
			if err != nil || !os.SameFile(socketBefore, socketAfter) {
				t.Fatal("a denied probe removed or replaced the control socket")
			}
			response, err := sendLocalControl(record.ID, "ping")
			if err != nil || !response.OK || response.ID != record.ID {
				t.Fatal("live host is no longer reachable")
			}
		})
	}
}

func TestDiscoveryPreservesAnsweringReplacementHost(t *testing.T) {
	isolatedRuntime(t)
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	current := localSessionRecord{ID: strings.Repeat("x", 32), PID: os.Getpid(), StartedAt: time.Now(), Password: "synthetic-current"}
	host, err := startLocalSession(current)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	stale := current
	stale.PID = 999999
	stale.StartedAt = time.Now().Add(-time.Hour)
	stale.Password = "synthetic-stale"
	if err := writeLocalSessionRecord(directory, stale); err != nil {
		t.Fatal(err)
	}
	path := localSessionRecordPath(directory, stale.ID)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	_, abandoned, err := scanLocalSessionsWithProbe(sendLocalControl, func(int) bool {
		t.Fatal("an answering identity mismatch must not trigger process reclamation")
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil || len(abandoned) != 0 || string(before) != string(after) {
		t.Fatal("answering replacement host was marked reclaimable or its record changed")
	}
	ping, err := sendLocalControl(current.ID, "ping")
	if err != nil || !ping.OK || ping.PID != current.PID {
		t.Fatal("replacement host became unreachable")
	}
}

func TestDiscoveryNeverOverwritesAReplacementDuringProbe(t *testing.T) {
	isolatedRuntime(t)
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	stale := localSessionRecord{ID: strings.Repeat("y", 32), PID: 999999, StartedAt: time.Now().Add(-time.Hour), Password: "synthetic-stale"}
	if err := writeLocalSessionRecord(directory, stale); err != nil {
		t.Fatal(err)
	}
	fresh := stale
	fresh.PID, fresh.StartedAt, fresh.Password = os.Getpid(), time.Now(), "synthetic-new"
	var expected []byte
	_, abandoned, err := scanLocalSessionsWithProbe(func(string, string) (localControlResponse, error) {
		if err := writeLocalSessionRecord(directory, fresh); err != nil {
			t.Fatal(err)
		}
		expected, err = os.ReadFile(localSessionRecordPath(directory, fresh.ID))
		if err != nil {
			t.Fatal(err)
		}
		return localControlResponse{}, os.ErrNotExist
	}, func(int) bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(localSessionRecordPath(directory, fresh.ID))
	if err != nil || len(abandoned) != 0 || string(after) != string(expected) {
		t.Fatal("replacement record was changed or marked reclaimable by a stale scan")
	}
}

func TestDiscoveryPreservesMalformedAndWriterTemporaryRecords(t *testing.T) {
	isolatedRuntime(t)
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{
		filepath.Join(directory, ".session-review.json"),
		localSessionRecordPath(directory, strings.Repeat("z", 32)),
		filepath.Join(directory, "unrelated.json"),
	}
	before := []byte(`{"incomplete":`)
	for _, path := range paths {
		if err := os.WriteFile(path, before, 0600); err != nil {
			t.Fatal(err)
		}
	}
	_, _, err = scanLocalSessionsWithProbe(func(string, string) (localControlResponse, error) {
		t.Fatal("invalid and temporary records must not be probed")
		return localControlResponse{}, nil
	}, func(int) bool { t.Fatal("invalid records supply no process proof"); return false })
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		after, err := os.ReadFile(path)
		if err != nil || string(after) != string(before) {
			t.Fatal("discovery changed an invalid or temporary record")
		}
	}
}

func TestDiscoveryNeverFollowsSymlinksOrCreatesState(t *testing.T) {
	isolatedRuntime(t)
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "record.json")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	link := localSessionRecordPath(directory, strings.Repeat("l", 32))
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if _, _, err := scanLocalSessions(); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("record symlink changed")
	}
	if contents, err := os.ReadFile(outside); err != nil || string(contents) != "outside" {
		t.Fatal("outside state changed")
	}
	directoryLink := filepath.Join(t.TempDir(), "runtime-link")
	if err := os.Symlink(directory, directoryLink); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL_ONLINE_RUNTIME_DIR", directoryLink)
	if _, _, err := scanLocalSessions(); err == nil {
		t.Fatal("discovery followed a directory symlink")
	}
	if _, err := ensureLocalSessionDirectory(); err == nil {
		t.Fatal("startup accepted a directory symlink")
	}
	missing := filepath.Join(t.TempDir(), "missing-runtime")
	t.Setenv("SHELL_ONLINE_RUNTIME_DIR", missing)
	if _, _, err := scanLocalSessions(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("discovery created missing state")
	}
}

func TestStartRefusesLiveOrMalformedRecordWithoutSocket(t *testing.T) {
	for _, malformed := range []bool{false, true} {
		t.Run(map[bool]string{false: "live", true: "malformed"}[malformed], func(t *testing.T) {
			isolatedRuntime(t)
			directory, err := ensureLocalSessionDirectory()
			if err != nil {
				t.Fatal(err)
			}
			record := localSessionRecord{ID: strings.Repeat("s", 32), PID: os.Getpid(), StartedAt: time.Now(), Password: "synthetic-preserved"}
			if err := writeLocalSessionRecord(directory, record); err != nil {
				t.Fatal(err)
			}
			path := localSessionRecordPath(directory, record.ID)
			if malformed {
				if err := os.WriteFile(path, []byte(`{"invalid":`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if control, err := startLocalSession(record); err == nil {
				control.Close()
				t.Fatal("startup replaced live or undecodable session evidence")
			}
			after, err := os.ReadFile(path)
			if err != nil || string(before) != string(after) {
				t.Fatal("refused startup changed existing credentials/state")
			}
			if _, err := os.Lstat(localSessionSocketPath(directory, record.ID)); !os.IsNotExist(err) {
				t.Fatal("refused startup created a socket")
			}
		})
	}
}

func TestListenNeverUnlinksExistingLiveOrStaleSocket(t *testing.T) {
	for _, stale := range []bool{false, true} {
		t.Run(map[bool]string{false: "live", true: "stale"}[stale], func(t *testing.T) {
			isolatedRuntime(t)
			directory, err := ensureLocalSessionDirectory()
			if err != nil {
				t.Fatal(err)
			}
			id := strings.Repeat("u", 32)
			path := localSessionSocketPath(directory, id)
			listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			listener.SetUnlinkOnClose(false)
			defer listener.Close()
			if stale {
				if err := listener.Close(); err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			if replacement, err := listenLocalControl(id); err == nil {
				replacement.Close()
				t.Fatal("startup replaced an existing control socket")
			}
			after, err := os.Lstat(path)
			if err != nil || !os.SameFile(before, after) {
				t.Fatal("startup unlinked or replaced the original socket")
			}
			if !stale {
				connection, err := net.DialTimeout("unix", path, time.Second)
				if err != nil {
					t.Fatal("original listener is unreachable")
				}
				connection.Close()
			}
		})
	}
}

func TestPreviouslyAbandonedLiveHostIsNotReclaimedOrAgedOut(t *testing.T) {
	isolatedRuntime(t)
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * abandonedRecordTTL)
	record := localSessionRecord{ID: strings.Repeat("q", 32), PID: os.Getpid(), StartedAt: old, AbandonedAt: &old}
	if err := writeLocalSessionRecord(directory, record); err != nil {
		t.Fatal(err)
	}
	_, abandoned, err := scanLocalSessions()
	if err != nil || len(abandoned) != 0 {
		t.Fatal("live host must not be reclaimed")
	}
	if _, err := os.Stat(localSessionRecordPath(directory, record.ID)); err != nil {
		t.Fatal("live record was aged out")
	}
}

func TestPreviouslyAbandonedHealthyHostIsStillActive(t *testing.T) {
	isolatedRuntime(t)
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	record := localSessionRecord{ID: strings.Repeat("h", 32), PID: os.Getpid(), StartedAt: time.Now(), Password: "synthetic-active"}
	host, err := startLocalSession(record)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	// An older client left a 48h-old abandonment note on a host that is still
	// running and answering with its exact ID+PID.
	note := record
	old := time.Now().Add(-48 * time.Hour)
	note.AbandonedAt = &old
	if err := writeLocalSessionRecord(directory, note); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(localSessionRecordPath(directory, record.ID))
	if err != nil {
		t.Fatal(err)
	}
	active, abandoned, err := scanLocalSessions()
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 1 || active[0].ID != record.ID || active[0].PID != record.PID {
		t.Fatalf("healthy host with a stale note was hidden from active: active=%+v", active)
	}
	if len(abandoned) != 0 {
		t.Fatalf("healthy host was also reclaimed: abandoned=%+v", abandoned)
	}
	after, err := os.ReadFile(localSessionRecordPath(directory, record.ID))
	if err != nil || string(before) != string(after) {
		t.Fatal("discovery mutated the record on disk")
	}
}

func TestDiscoveryPreservesInvalidAndMissingPIDRecords(t *testing.T) {
	isolatedRuntime(t)
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		id   string
		pid  int
	}{
		{"missing_pid", strings.Repeat("m", 32), 0},
		{"negative_pid", strings.Repeat("n", 32), -1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			record := localSessionRecord{ID: tc.id, PID: tc.pid, StartedAt: time.Now(), Password: "synthetic-pid"}
			if err := writeLocalSessionRecord(directory, record); err != nil {
				t.Fatal(err)
			}
			path := localSessionRecordPath(directory, tc.id)
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			probed := false
			_, abandoned, err := scanLocalSessionsWithProbe(func(string, string) (localControlResponse, error) {
				probed = true
				return localControlResponse{}, nil
			}, func(int) bool { return false })
			if err != nil {
				t.Fatal(err)
			}
			if probed {
				t.Fatal("an invalid/missing PID record was probed")
			}
			if len(abandoned) != 0 {
				t.Fatalf("an invalid/missing PID record was reclaimed: %+v", abandoned)
			}
			after, err := os.ReadFile(path)
			if err != nil || string(before) != string(after) {
				t.Fatal("discovery changed an invalid/missing PID record")
			}
		})
	}
}
