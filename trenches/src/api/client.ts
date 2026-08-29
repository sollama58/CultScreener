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
  SubscriptionStatus,
  ClaimResult,
  AdminSubscriptionStats,
  AdminSubscriber,
  AdminBurn,
  WhitelistEntry,
  CuratedPage,
  CuratedStats,
  LinkedDevicesResponse,
} from "./types";

const BASE_URL = import.meta.env.VITE_API_URL;

/**
 * Fired on any 401 from this API. AuthContext listens and clears the user; nothing else should
 * need to care. Deliberately a DOM event rather than a callback so client.ts stays free of
 * imports from the React tree.
 */
export const UNAUTHORIZED_EVENT = "trenches:unauthorized";

/** Fired on any 402 - the subscription lapsed or was never there. SubscriptionContext listens. */
export const PAYMENT_REQUIRED_EVENT = "trenches:payment-required";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * `quiet` suppresses the global 401/402 broadcasts for this one call.
 *
 * Only the boot prefetch uses it. Those requests are fired speculatively before the app knows
 * whether anyone is signed in, so a 401 from them is an expected answer rather than a session
 * that just expired - and a 402 is the paywall doing its job, not a subscription lapsing
 * mid-session. Broadcasting either would make the app react to something that has not happened.
 * The real call that follows is not quiet and will broadcast properly if it needs to.
 */
/**
 * How long any one call may take before it is given up on.
 *
 * There was no bound at all, and `fetch` does not impose one: a connection that dies without
 * closing - a keep-alive the far end forgot about overnight, a laptop that slept, a server
 * restarted underneath an open tab - leaves the promise pending forever. Every caller here awaits
 * in a try/finally, so a promise that never settles means the finally never runs: the Live Feed
 * stayed on its loading placeholders AND never re-armed its poll, so the page was stuck until
 * someone reloaded it by hand. Reproduced, and fixed by making sure every request ends somehow.
 *
 * Generous rather than tight. This is a stuck-forever guard, not a latency budget - the API
 * answers a feed page in about ten milliseconds, and a slow mobile connection should be allowed
 * to finish rather than be cut off and retried into the same congestion.
 */
const REQUEST_TIMEOUT_MS = 20_000;

async function request<T>(path: string, init: RequestInit & { quiet?: boolean } = {}): Promise<T> {
  const { quiet, ...rest } = init;
  const res = await fetch(`${BASE_URL}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...rest,
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
    if (res.status === 401 && !quiet) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    // Same reasoning as the 401 above, one step along: the subscription can lapse mid-session, or
    // be revoked, and the only way this app finds out is a 402 on some later call. Broadcasting it
    // once here means the feed drops to the paywall from wherever it happened, rather than each
    // caller swallowing it and leaving a page that quietly stops updating.
    if (res.status === 402 && !quiet) {
      window.dispatchEvent(new CustomEvent(PAYMENT_REQUIRED_EVENT));
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

export function getMe(opts: { quiet?: boolean } = {}) {
  return request<User>("/auth/me", opts);
}

export function logout() {
  return request<{ ok: true }>("/auth/logout", { method: "POST" });
}

// ── Config ───────────────────────────────────────────────────────────────
export function getConfig() {
  return request<PublicConfig>("/config");
}

// ── Filters ──────────────────────────────────────────────────────────────
export function listFilters(opts: { quiet?: boolean } = {}) {
  return request<UserFilter[]>("/filters", opts);
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
/**
 * The Live Feed. `includeCurated` mixes the global curated feed in alongside this user's own
 * matches - opt-in, and sent as a query param rather than filtered here, so pagination counts
 * stay exact rather than a page of twelve arriving with some of it dropped client-side.
 */
export function listMatches(page = 1, includeCurated = false, opts: { quiet?: boolean } = {}) {
  const query = new URLSearchParams({ page: String(page) });
  if (includeCurated) query.set("includeCurated", "true");
  return request<MatchesPage>(`/matches?${query.toString()}`, opts);
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
/**
 * Mobile Connect. The desktop mints a code here and renders it as a QR; the phone redeems it on
 * the main site's /link page, which is why nothing in this app calls /auth/link/redeem - by the
 * time the phone has a session, it is an ordinary signed-in client.
 */
export function getLinkedDevices() {
  return request<LinkedDevicesResponse>("/auth/devices");
}

export function revokeLinkedDevice(deviceId: string) {
  return request<{ ok: boolean }>(`/auth/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
}

export function revokeAllLinkedDevices() {
  return request<{ ok: boolean; revoked: number }>("/auth/devices", { method: "DELETE" });
}

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

// ── Curated Alerts ───────────────────────────────────────────────────────

export function listCurated(page = 1) {
  return request<CuratedPage>(`/curated?page=${page}`);
}

export function getCuratedStats() {
  return request<CuratedStats>("/curated/stats");
}

/** Same contract and caveats as openMatchesStream - a nudge channel, never the only path. */
export function openCuratedStream(): EventSource | null {
  if (typeof EventSource === "undefined") return null;
  return new EventSource(`${BASE_URL}/curated/stream`, { withCredentials: true });
}

// ── Subscription ─────────────────────────────────────────────────────────
export function getSubscription(opts: { quiet?: boolean } = {}) {
  return request<SubscriptionStatus>("/subscription", opts);
}

/**
 * A recent blockhash - and, by succeeding at all, proof the API is reachable.
 *
 * Called immediately before asking the wallet to sign. That ordering is the point: a burn cannot
 * be undone, so finding out the backend is unreachable AFTER the tokens are gone is the one
 * outcome worth going out of the way to avoid.
 */
export function getBlockhash() {
  return request<{ blockhash: string; lastValidBlockHeight: number }>("/subscription/blockhash");
}

/**
 * Hand a signed burn to the API to broadcast.
 *
 * Sent through the server rather than straight to an RPC so the signature is recorded server-side
 * the instant it exists. If this tab dies immediately afterwards, the burn is still credited -
 * either by the claim below when the user returns, or by the reconciler without them doing
 * anything at all.
 */
export function sendBurnTransaction(base64Transaction: string) {
  return request<{ signature: string }>("/subscription/send", {
    method: "POST",
    body: JSON.stringify({ transaction: base64Transaction }),
  });
}

/** Ask the API to verify a burn and grant the months it bought. Safe to call repeatedly. */
export function claimBurn(signature: string) {
  return request<ClaimResult>("/subscription/claim", {
    method: "POST",
    body: JSON.stringify({ signature }),
  });
}

// ── Admin: subscriptions ─────────────────────────────────────────────────
export function getAdminSubscriptionStats() {
  return request<AdminSubscriptionStats>("/admin/subscriptions/stats");
}

export function getAdminSubscribers(limit = 50) {
  return request<AdminSubscriber[]>(`/admin/subscriptions?limit=${limit}`);
}

export function getAdminBurns(limit = 50, unattributedOnly = false) {
  return request<AdminBurn[]>(
    `/admin/subscriptions/burns?limit=${limit}${unattributedOnly ? "&unattributed=true" : ""}`,
  );
}

export function getWhitelist() {
  return request<WhitelistEntry[]>("/admin/whitelist");
}

export function addToWhitelist(walletAddress: string, note?: string, expiresAt?: string) {
  return request<WhitelistEntry>("/admin/whitelist", {
    method: "POST",
    body: JSON.stringify({ walletAddress, note: note || undefined, expiresAt: expiresAt || undefined }),
  });
}

export function removeFromWhitelist(walletAddress: string) {
  return request<{ ok: boolean; removed: boolean }>(`/admin/whitelist/${encodeURIComponent(walletAddress)}`, {
    method: "DELETE",
  });
}

export function grantSubscription(walletAddress: string, days: number) {
  return request<{ walletAddress: string; expiresAt: string }>("/admin/subscriptions/grant", {
    method: "POST",
    body: JSON.stringify({ walletAddress, days }),
  });
}

export function revokeSubscription(walletAddress: string) {
  return request<{ ok: boolean; revoked: boolean }>(
    `/admin/subscriptions/${encodeURIComponent(walletAddress)}`,
    { method: "DELETE" },
  );
}
