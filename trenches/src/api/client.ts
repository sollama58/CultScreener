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
  TelegramLinkResponse,
  TelegramStatus,
  Token,
  User,
  UserFilter,
  WorkerHealth,
} from "./types";

const BASE_URL = import.meta.env.VITE_API_URL;

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
