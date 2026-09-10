import { useCallback, useEffect, useMemo, useState } from "react";
import { Desktop, MagnifyingGlass, X } from "@phosphor-icons/react";
import { AppShell, LinkHint } from "../components/AppShell";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { fetchDevices, revokeDevice, type Device } from "../lib/api";
import { machineOnline } from "../lib/agent";
import { usePageTitle } from "../lib/page-title";
import { ago } from "../lib/time";
import { SearchSelect } from "../components/SearchSelect";

const MACHINE_STATUS = [
  { value: "all", label: "All machines", detail: "Online and offline machines" },
  { value: "online", label: "Online", detail: "Listening for browser-started sessions" },
  { value: "offline", label: "Offline", detail: "Linked, but not listening right now" },
];

export function Machines() {
  usePageTitle("Machines");
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState("");
  const [unlinking, setUnlinking] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");

  const load = useCallback(async () => {
    try {
      const result = await fetchDevices();
      setDevices(result.devices);
      setError("");
    } catch (caught) {
      setDevices([]);
      setError(caught instanceof Error ? caught.message : "Could not load machines.");
    }
  }, []);

  useEffect(() => {
    void load();
    /* Refresh so the badge reflects a machine becoming reachable, or dropping. */
    const poll = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(poll);
  }, [load]);

  async function handleUnlink(device: Device) {
    setError("");
    setUnlinking(device.id);
    try {
      await revokeDevice(device.id);
    } catch (caught) {
      /*
       * A machine that is already gone is the outcome this was asking for, so
       * saying "no such machine" and leaving the row on screen is the one
       * answer that is wrong on both counts. It happened: the list refreshed
       * only on success, so any error left the unlinked machine sitting there
       * looking like the button had failed.
       */
      const message = caught instanceof Error ? caught.message : "Could not unlink.";
      if (!/no such machine/i.test(message)) setError(message);
    } finally {
      /* Reload either way, so the list shows the server's answer, not ours. */
      await load().catch(() => {});
      setUnlinking("");
    }
  }

  /* Ticks so an Online badge goes stale on its own rather than lying. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 3000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleDevices = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (devices ?? []).filter((device) => {
      const online = machineOnline(device, now);
      if (status === "online" && !online) return false;
      if (status === "offline" && online) return false;
      if (!needle) return true;
      return [device.label, device.id, ...(device.harnesses ?? [])]
        .some((part) => part.toLocaleLowerCase().includes(needle));
    });
  }, [devices, now, query, status]);

  return (
    <AppShell
      title="Machines"
      aside={
        devices && devices.length > 0 ? (
          <span className="topbar-count">
            {visibleDevices.length === devices.length
              ? `${devices.length} linked`
              : `${visibleDevices.length} of ${devices.length}`}
          </span>
        ) : null
      }
    >
      <p className="page-dek">
        Every machine that can publish sessions to this account. Unlinking
        revokes its token immediately.
      </p>

      {/*
       * The command that links a machine lives in the sidebar, and the
       * sidebar is a bar of five destinations on a phone. This is the
       * destination it would have been next to, so the phone gets it here
       * rather than not at all.
       */}
      <LinkHint className="machines-hint" />

      {error && (
        <div className="sessions-alert sessions-error">
          <Alert tone="error">
            <span>{error}</span>
            <button
              type="button"
              className="inline-retry"
              onClick={() => {
                setError("");
                setDevices(null);
                void load();
              }}
            >
              Retry
            </button>
          </Alert>
        </div>
      )}

      {devices && devices.length > 0 && (
        <div className="list-toolbar">
          <label className="sessions-search">
            <MagnifyingGlass size={15} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search machines"
              aria-label="Search machines by name, id, or capability"
            />
            {query && (
              <button type="button" className="search-clear" onClick={() => setQuery("")} aria-label="Clear machine search">
                <X size={12} weight="bold" />
              </button>
            )}
          </label>
          <SearchSelect
            label="Machine status"
            value={status}
            options={MACHINE_STATUS}
            onChange={setStatus}
            searchable={false}
            align="right"
          />
        </div>
      )}

      {devices === null ? (
        <div className="sessions-skeleton" aria-hidden="true">
          <span />
          <span />
        </div>
      ) : devices.length === 0 ? (
        <div className="sessions-empty">
          <p>No machines linked yet.</p>
          <ol>
            <li>
              Install shell on the machine you want to share from.
              <code className="empty-command">
                curl -fsSL https://shell.online/install | sh
              </code>
            </li>
            <li>
              Sign that machine in, then approve the request in this browser.
              <code className="empty-command">shell login</code>
            </li>
            <li>The machine appears in this list.</li>
          </ol>
        </div>
      ) : visibleDevices.length === 0 ? (
        <div className="sessions-empty compact-empty">
          <p>No machines match those filters.</p>
          <button type="button" className="session-action" onClick={() => { setQuery(""); setStatus("all"); }}>
            Clear filters
          </button>
        </div>
      ) : (
        <ul className="sessions-list">
          {visibleDevices.map((device) => (
            <li key={device.id} className="session">
              <div className="session-main">
                <span className="device-label">
                  <Desktop size={15} />
                  {device.label}
                </span>
                <span className="session-meta">
                  {machineOnline(device, now) ? (
                    <span className="status-badge status-badge-online">Online</span>
                  ) : (
                    <span className="status-badge status-badge-offline">Offline</span>
                  )}
                  {" · "}
                  linked {ago(device.createdAt, now)} · last used{" "}
                  {ago(device.lastSeenAt, now)}
                </span>
                {/*
                 * A machine only polls once it has agreed to browser-started
                 * sessions, and the default at that prompt is no. So the
                 * common reason for this badge is a deliberate answer rather
                 * than anything being wrong, and a bare "Offline" reads as a
                 * fault and gives nobody the one command that changes it.
                 */}
                {!machineOnline(device, now) && (
                  <span className="session-meta device-offline-hint">
                    Publish-only until it agrees to browser-started sessions.
                    Run <code>shell login --allow-remote-start</code> there.
                  </span>
                )}
              </div>
              <div className="session-actions">
                <Button
                  type="button"
                  variant="ghost"
                  className="device-unlink"
                  onClick={() => void handleUnlink(device)}
                  busy={unlinking === device.id}
                  busyLabel="Unlinking"
                  disabled={unlinking !== ""}
                >
                  Unlink
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {devices !== null && devices.length > 0 && (
        <p className="sessions-note">
          A machine can publish sessions whenever it is linked. It can be
          driven from this page only if someone allowed that at{" "}
          <code>shell login</code> there. Unlinking cuts the account link; a
          terminal already running keeps running.
        </p>
      )}
    </AppShell>
  );
}
