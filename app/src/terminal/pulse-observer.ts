import { SessionPulseTracker, type SessionPulse } from "./session-pulse";

/** Per-viewer memory only. This observer neither opens nor reads a connection. */
export class PulseObserver {
  private tracker = new SessionPulseTracker();
  private connected = false;
  private available = true;
  private allowed = true;
  private visible = false;
  private disposed = false;
  private observed = false;
  private last = "null";

  constructor(private emit: (value: SessionPulse | null) => void) {}

  connection(connected: boolean): void {
    if (this.disposed) return;
    this.connected = connected;
    if (!connected) this.clear();
  }

  host(available: boolean): void {
    if (this.disposed) return;
    this.available = available;
    if (!available) this.clear();
  }

  authorization(allowed: boolean): void {
    if (this.disposed) return;
    this.allowed = allowed;
    if (!allowed) this.clear();
  }

  visibility(visible: boolean): void {
    this.visible = visible;
    if (visible) this.tracker.viewed();
  }

  feed(bytes: Uint8Array, snapshot: boolean, now: number): void {
    if (this.disposed || !this.allowed || !this.connected || !this.available || (!snapshot && bytes.byteLength === 0)) return;
    if (bytes.byteLength > 0) this.observed = true;
    this.tracker.feed(bytes, now, { snapshot, active: this.visible });
  }

  /** Called at most once per second, not once per output frame. */
  tick(now: number): void {
    if (this.disposed) return;
    this.publish(this.allowed && this.connected && this.available && this.observed ? this.tracker.value(now) : null);
  }

  private publish(value: SessionPulse | null): void {
    const key = JSON.stringify(value);
    if (key === this.last) return;
    this.last = key;
    this.emit(value);
  }

  private clear(): void {
    this.tracker.reset();
    this.observed = false;
    this.publish(null);
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }
}
