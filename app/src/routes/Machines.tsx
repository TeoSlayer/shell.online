import { useCallback, useEffect, useState } from "react";
import { Desktop } from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { fetchDevices, revokeDevice, type Device } from "../lib/api";
import { machineOnline } from "../lib/agent";
import { ago } from "../lib/time";

export function Machines() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState("");
  const [unlinking, setUnlinking] = useState("");

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
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not unlink.");
    } finally {
      setUnlinking("");
    }
  }

  /* Ticks so an Online badge goes stale on its own rather than lying. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 3000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <AppShell
      title="Machines"
      aside={
        devices && devices.length > 0 ? (
          <span className="topbar-count">
            {devices.length} linked
          </span>
        ) : null
      }
    >
      <p className="page-dek">
        Every machine that can publish sessions to this account. Unlinking
        revokes its token immediately.
      </p>

      {error && <div className="sessions-alert"><Alert tone="error">{error}</Alert></div>}

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
      ) : (
        <ul className="sessions-list">
          {devices.map((device) => (
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
