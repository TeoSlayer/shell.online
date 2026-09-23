package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
)

// A reservation owns a bound control listener and an unpublished session
// record. It is taken before any relay or account mutation, so a launch that
// cannot own the session locally never mutates the remote session. Finalization
// transfers ownership to a managedLocalSession; Close releases only the
// resources this attempt created.
type localSessionReservation struct {
	id          string
	directory   string
	listener    net.Listener
	socketPath  string
	socketInfo  os.FileInfo
	staged      *os.File
	stagedInfo  os.FileInfo
	transferred bool
}

// reserveLocalSession claims the local control path and stages an unpublished
// record. It performs no network or account mutation. The bound listener is the
// atomic claim: two launches cannot both reserve the same id.
func reserveLocalSession(id string) (*localSessionReservation, error) {
	if !localSessionIDPattern.MatchString(id) {
		return nil, fmt.Errorf("invalid session id")
	}
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		return nil, fmt.Errorf("local runtime directory is unavailable")
	}
	path := localSessionRecordPath(directory, id)
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		return nil, fmt.Errorf("session is already running locally or has a retained record; recovery is needed before replacement")
	}
	listener, err := listenLocalControl(id)
	if err != nil {
		return nil, fmt.Errorf("local control channel is occupied or unavailable; recovery may be needed")
	}
	reservation := &localSessionReservation{id: id, directory: directory, listener: listener}
	reservation.socketPath, reservation.socketInfo = localControlSocketInfo(directory, id)
	// A record can appear while binding. No network mutation has happened yet.
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		reservation.Close()
		return nil, fmt.Errorf("local session record appeared during reservation; recovery may be needed")
	}
	reservation.staged, err = os.CreateTemp(directory, ".session-*.json")
	if err == nil {
		reservation.stagedInfo, err = reservation.staged.Stat()
	}
	if err == nil {
		err = reservation.staged.Chmod(0o600)
	}
	if err == nil {
		err = securePrivateStateFile(reservation.staged.Name())
	}
	if err != nil {
		reservation.Close()
		return nil, fmt.Errorf("cannot stage local session record")
	}
	return reservation, nil
}

// Close releases the listener and staged record, but only if this attempt still
// owns them (finalization transfers ownership to the live session).
func (reservation *localSessionReservation) Close() {
	if reservation == nil || reservation.transferred {
		return
	}
	if reservation.listener != nil {
		_ = reservation.listener.Close()
		reservation.listener = nil
	}
	// Remove the control path only if it is still the exact socket this attempt
	// bound; a replacement from a cooperating launch is never unlinked.
	removeOwnedLocalFile(reservation.socketPath, reservation.socketInfo)
	if reservation.staged != nil {
		_ = reservation.staged.Close()
		removeOwnedLocalFile(reservation.staged.Name(), reservation.stagedInfo)
		reservation.staged = nil
	}
}

// check reports whether the directory, staged file, and absence of a published
// record are still exactly as they were at reservation time.
func (reservation *localSessionReservation) check() error {
	if reservation == nil || reservation.transferred || reservation.listener == nil || reservation.staged == nil {
		return fmt.Errorf("local session reservation is unavailable")
	}
	if _, err := os.Lstat(reservation.directory); err != nil {
		return fmt.Errorf("local runtime directory changed during startup")
	}
	staged, err := os.Lstat(reservation.staged.Name())
	if err != nil || !os.SameFile(staged, reservation.stagedInfo) {
		return fmt.Errorf("local session staging file changed during startup")
	}
	if _, err := os.Lstat(localSessionRecordPath(reservation.directory, reservation.id)); !os.IsNotExist(err) {
		return fmt.Errorf("local session record appeared during startup; recovery is needed")
	}
	if !localSocketOwnershipHolds(reservation.socketPath, reservation.socketInfo) {
		return fmt.Errorf("local control socket was replaced during startup; refusing to resume")
	}
	return nil
}

// finalize writes the record to the staged file and publishes it by hard link,
// which cannot replace a record published during a slow relay request. It then
// hands the bound listener to a live session.
func (reservation *localSessionReservation) finalize(record localSessionRecord) (localSessionControl, error) {
	if reservation == nil || reservation.transferred || reservation.staged == nil || record.ID != reservation.id {
		return nil, fmt.Errorf("invalid local session reservation")
	}
	if err := reservation.check(); err != nil {
		return nil, err
	}
	if err := json.NewEncoder(reservation.staged).Encode(record); err != nil {
		return nil, fmt.Errorf("cannot write local session record")
	}
	if err := reservation.staged.Sync(); err != nil {
		return nil, fmt.Errorf("cannot sync local session record")
	}
	if err := reservation.staged.Close(); err != nil {
		return nil, fmt.Errorf("cannot close local session record")
	}
	path := localSessionRecordPath(reservation.directory, record.ID)
	if err := os.Link(reservation.staged.Name(), path); err != nil {
		return nil, fmt.Errorf("cannot exclusively publish local session record; recovery may be needed")
	}
	session := &managedLocalSession{
		record:     record,
		listener:   reservation.listener,
		recordPath: path,
		recordInfo: reservation.stagedInfo,
		socketPath: reservation.socketPath,
		socketInfo: reservation.socketInfo,
		stop:       make(chan struct{}),
	}
	removeOwnedLocalFile(reservation.staged.Name(), reservation.stagedInfo)
	reservation.transferred = true
	go session.serve()
	return session, nil
}

// removeOwnedLocalFile removes a path only when it is still the exact file this
// attempt created, so a replacement left by another launch is never unlinked.
func removeOwnedLocalFile(path string, owned os.FileInfo) {
	if owned == nil {
		return
	}
	current, err := os.Lstat(path)
	if err == nil && os.SameFile(current, owned) {
		_ = os.Remove(path)
	}
}
