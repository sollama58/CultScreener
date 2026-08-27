import type { SolanaSignInInput } from "@solana/wallet-standard-features";
import type {
  AdminConfig,
  AdminLiveFeed,
  AdminStats,
  AdminUser,
  AlertMode,
  FilterInput,
  LeaderboardResponse,
  MatchesPage,
  PublicConfig,
  StreamHealth,
  TelegramLinkResponse,
  TelegramStatus,
  Token,
  User,
  UserFilter,
  WorkerHealth,
} from "./types";

const BASE_URL = import.meta.env.VITE_API_URL;

/**
 * Fired on any 401 from this API. AuthContext listens and clears the user; nothing else should
 * need to care. Deliberately a DOM event rather than a callback so client.ts stays free of
 * imports from the React tree.
 */
export const UNAUTHORIZED_EVENT = "trenches:unauthorized";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    // The session is httpOnly and server-owned, so the only way this app learns it has expired
    // (or was revoked, or the server restarted) is a 401 on some later call. Without this every
    // caller just swallows the failure into its own catch: the feed silently stops updating and
    // the user sits looking at a frozen page that still says they're signed in. Broadcasting it
    // once here lets AuthContext drop back to the sign-in screen from anywhere.
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    let message = `Request failed with status ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // response wasn't JSON - keep the generic message
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── Auth ─────────────────────────────────────────────────────────────────
export function getNonce(wallet: string) {
  return request<{ nonce: string; message: string; signInInput: SolanaSignInInput; expiresAt: string }>(
    `/auth/nonce?wallet=${encodeURIComponent(wallet)}`,
  );
}

/** Preferred: verifies a wallet.signIn() result (domain-bound, see the wallet's own SolanaSignInOutput). */
export function verifyWalletSignIn(
  walletAddress: string,
  nonce: string,
  output: { publicKey: string; signedMessage: string; signature: string },
) {
  return request<User>("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ method: "signIn", walletAddress, nonce, output }),
  });
}

/** Fallback for wallets that don't implement solana:signIn - not domain-bound, see AuthContext. */
export function verifySignMessage(walletAddress: string, nonce: string, signature: string) {
  return request<User>("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ method: "signMessage", walletAddress, nonce, signature }),
  });
}

export function getMe() {
  return request<User>("/auth/me");
}

export function logout() {
  return request<{ ok: true }>("/auth/logout", { method: "POST" });
}

// ── Config ───────────────────────────────────────────────────────────────
export function getConfig() {
  return request<PublicConfig>("/config");
}

// ── Filters ──────────────────────────────────────────────────────────────
export function listFilters() {
  return request<UserFilter[]>("/filters");
}

export function createFilter(input: Partial<FilterInput>) {
  return request<UserFilter>("/filters", { method: "POST", body: JSON.stringify(input) });
}

export function updateFilter(id: string, input: Partial<FilterInput>) {
  return request<UserFilter>(`/filters/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteFilter(id: string) {
  return request<void>(`/filters/${id}`, { method: "DELETE" });
}

// ── Matches ──────────────────────────────────────────────────────────────
export function listMatches(page = 1) {
  return request<MatchesPage>(`/matches?page=${page}`);
}

// ── Tokens ───────────────────────────────────────────────────────────────
export function getToken(mintAddress: string) {
  return request<Token & { snapshots: unknown[] }>(`/tokens/${mintAddress}`);
}

// ── Leaderboard ──────────────────────────────────────────────────────────
export function getLeaderboard() {
  return request<LeaderboardResponse>("/leaderboard");
}

// ── Health ───────────────────────────────────────────────────────────────
export function getWorkerHealth() {
  return request<WorkerHealth>("/health/worker");
}

/** Whether this API instance's live-match push channel is actually up - see StreamHealth. */
export function getStreamHealth() {
  return request<StreamHealth>("/health/stream");
}

// ── Telegram ─────────────────────────────────────────────────────────────
export function getTelegramStatus() {
  return request<TelegramStatus>("/telegram/status");
}

export function linkTelegram() {
  return request<TelegramLinkResponse>("/telegram/link", { method: "POST" });
}

export function setAlertMode(alertMode: AlertMode) {
  return request<{ alertMode: AlertMode }>("/telegram/alert-mode", {
    method: "PATCH",
    body: JSON.stringify({ alertMode }),
  });
}

export function unlinkTelegram() {
  return request<{ ok: true }>("/telegram/unlink", { method: "POST" });
}

// ── Admin ────────────────────────────────────────────────────────────────
export function getAdminStats() {
  return request<AdminStats>("/admin/stats");
}

export function getAdminLiveFeed(limit = 100) {
  return request<AdminLiveFeed>(`/admin/live-feed?limit=${limit}`);
}

export function getAdminUsers() {
  return request<AdminUser[]>("/admin/users");
}

export function unlinkUserTelegram(userId: string) {
  return request<{ ok: true; unlinked: boolean }>(`/admin/users/${userId}/unlink-telegram`, {
    method: "POST",
  });
}

export function getAdminConfig() {
  return request<AdminConfig>("/admin/config");
}

// ── Live match stream ────────────────────────────────────────────────────
/**
 * Opens the server-sent events stream that fires the moment a match is created for the
 * signed-in user.
 *
 * The worker scans once a minute, so without this the feed's latency is however long the
 * fallback poll happens to be. With it, an alert lands as soon as the server has it.
 *
 * Two things the caller must respect:
 *  - Events carry only `{ matchId }`. They are a nudge, not the record — refetch /matches to
 *    render. Nothing here should try to build a match out of the event payload.
 *  - This is NOT reliable delivery. The underlying Postgres NOTIFY isn't durable, so a client
 *    that happens to be disconnected at the instant of publication misses that event outright,
 *    and some proxies kill long-lived responses. A fallback poll is required, not optional.
 *
 * EventSource reconnects by itself (the server sends `retry: 5000`), so callers must not layer
 * their own reconnect loop on top. A non-200 — notably the 503 the server returns when it is at
 * stream capacity — closes it permanently instead, which is the signal to rely on polling.
 *
 * withCredentials is what carries the session cookie; without it the stream just 401s.
 */
export function openMatchesStream(): EventSource | null {
  if (typeof EventSource === "undefined") return null;
  return new EventSource(`${BASE_URL}/matches/stream`, { withCredentials: true });
}
