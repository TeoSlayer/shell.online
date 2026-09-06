import { auth } from "./firebase";

const BASE = (import.meta.env.VITE_ACCOUNTS_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

export interface SessionRecord {
  id: string;
  shareUrl: string;
  command: string;
  readOnly: boolean;
  encrypted: boolean;
  persistent: boolean;
  host: string;
  startedAt: number;
  closedAt?: number;
  exitCode?: number;
}

class ApiError extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new ApiError("You are signed out. Sign in and try again.");

  /*
   * getIdToken refreshes when the cached token is close to expiry, so every
   * call carries a token the accounts service will still accept.
   */
  const token = await user.getIdToken();
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new ApiError(
      `Could not reach the accounts service at ${BASE}. Is it running?`,
    );
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new ApiError(String(body.error ?? `Request failed with ${response.status}`));
  }
  return body as T;
}

export interface AuthorizeInput {
  redirectUri: string;
  codeChallenge: string;
}

export function approveCliLogin(input: AuthorizeInput) {
  return request<{ code: string }>("/api/cli/authorize", {
    method: "POST",
    body: JSON.stringify({
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }),
  });
}

export interface Device {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
}

export function fetchDevices() {
  return request<{ devices: Device[] }>("/api/devices");
}

export function revokeDevice(id: string) {
  return request<{ revoked: boolean }>(`/api/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function fetchSessions() {
  return request<{ sessions: SessionRecord[] }>("/api/sessions");
}

export const accountsBaseUrl = BASE;
