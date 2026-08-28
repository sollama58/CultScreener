export interface User {
  id: string;
  walletAddress: string;
  createdAt: string;
  /** True when this wallet is in the deployment's ADMIN_WALLET_ADDRESSES - gates the Admin nav link. */
  isAdmin: boolean;
}

export interface UserFilter {
  id: string;
  userId: string;
  name: string;
  mcapMin: number;
  mcapMax: number;
  minVolumeMcapRatio: number | null;
  minHolderGrowthPct: number | null;
  maxTop10HolderPct: number | null;
  maxDevWalletPct: number | null;
  maxRiskScore: number | null;
  excludeCriticalRiskFlags: boolean;
  minTokenAgeMinutes: number | null;
  maxTokenAgeMinutes: number | null;
  narrativeKeywords: string[];
  minScore: number | null;
  maxFreshTop10WalletPct: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type FilterInput = Omit<UserFilter, "id" | "userId" | "createdAt" | "updatedAt">;

/** Public, non-sensitive scan settings - lets the filter builder clamp mcapMin/mcapMax to what
 *  the platform actually scans instead of accepting a range that can never match anything. */
export interface PublicConfig {
  mcapFilterMin: number;
  mcapFilterMax: number;
  /** The true, padded range a token could ever be scanned/matched at - see scanBand() in packages/core. */
  scanBandMin: number;
  scanBandMax: number;
}

export interface Token {
  id: string;
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  pairAddress: string | null;
  /** DexScreener's hosted logo for this mint. Null means DexScreener has no artwork for it -
   *  common for very new tokens - not that the lookup failed. */
  imageUrl?: string | null;
  firstSeenAt: string;
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
  narrativeTags: string[];
  /** Latest cheap price/mcap ping for this token, independent of the full snapshot cycle.
   *  Prefer Match.currentMarketCapUsd over reading these directly - see the note there. */
  liveMarketCapUsd?: number | null;
  livePriceUsd?: number | null;
  liveDataAt?: string | null;
}

export interface TokenSnapshot {
  id: string;
  tokenId: string;
  takenAt: string;
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volumeToMcapRatio: number | null;
  buys24h: number | null;
  sells24h: number | null;
  holderCount: number | null;
  holderGrowthPct: number | null;
  top10HolderPct: number | null;
  devWalletPct: number | null;
  /** RugCheck's own composite risk score, 0-100 (higher = riskier). */
  riskScore: number | null;
  /** Named risk flags from RugCheck, e.g. "Creator history of rugged tokens". */
  riskFlags: string[];
  /** % of the top-10 holders whose wallet was funded <24h ago. Null if there was no holder list to check. */
  freshTop10WalletPct: number | null;
  /** Was the mint launched in Pump.fun's Mayhem Mode? An automatic, non-optional rejection: their
   *  own AI agents mint an extra 1B supply and trade it for the token's first 24h, which
   *  manufactures the volume and holder growth this app scores on. Null means the check never ran
   *  or failed, which the screen also rejects - so `!== false` is what "excluded" means here. */
  isMayhemMode: boolean | null;
  /** Has the mint graduated off a Pump.fun bonding curve to a real AMM? Null if unknown (no DexScreener pair). */
  graduated: boolean | null;
  mintAuthorityActive: boolean | null;
  freezeAuthorityActive: boolean | null;
  lpBurned: boolean | null;
  ageMinutes: number | null;
  score: number | null;
  scoreMomentum: number | null;
  scoreHolderHealth: number | null;
  scoreAge: number | null;
  scoreNarrative: number | null;
  rugScreenPassed: boolean;
  rugScreenReasons: string[];
}

export interface Match {
  id: string;
  userId: string;
  filterId: string;
  tokenId: string;
  snapshotId: string;
  matchedAt: string;
  score: number;
  deliveredDashboard: boolean;
  deliveredTelegram: boolean;
  digestSentAt: string | null;
  /** Backtesting data: highest mcap seen since this match, updated daily. Both null until the
   *  outcome-tracking job's first run after the match - see apps/worker/src/jobs/outcomeTrackingJob.ts. */
  peakMcapUsd: number | null;
  peakMcapAt: string | null;
  /** (peakMcapUsd - snapshot.marketCapUsd) / snapshot.marketCapUsd * 100 - null on the same terms as peakMcapUsd. */
  peakReturnPct: number | null;
  /** When the recorded peak first reached +100% over the alert mcap - set once and never moved,
   *  and dated to when that peak was actually seen rather than to the run that noticed. Non-null
   *  is exactly what makes this match eligible for the Leaderboard. */
  hitHundredPctAt: string | null;
  token: Token;
  /** The frozen snapshot from when this match was created - "alerted at," never updated. */
  snapshot: TokenSnapshot;
  /**
   * This token's most recent snapshot as of now, which may be the same row as `snapshot` above
   * if the worker hasn't re-scanned it since the match. Fetching this very page is what keeps it
   * fresh even once the token drops out of the mcap band - see the comment on
   * Token.lastViewedAt in schema.prisma. Lets the dashboard show a live-ish "now" mcap and %
   * change alongside the frozen alert-time one - see apps/api/src/routes/matches.ts.
   */
  latestSnapshot: TokenSnapshot | null;
  /**
   * The freshest market cap the server actually has for this token: it reconciles the live ping
   * against the latest snapshot and returns whichever is genuinely newer.
   *
   * Use this for "now" rather than deriving it from token.liveMarketCapUsd vs
   * latestSnapshot.marketCapUsd — that derivation gets it wrong once a token drops out of the
   * viewed set, which is exactly when the two sources disagree.
   *
   * Optional here only because this file is hand-written and can lag the API; treat `undefined`
   * as "this deployment didn't send it" and `null` as "the server has no figure".
   */
  currentMarketCapUsd?: number | null;
  currentMarketCapAt?: string | null;
  filter: { id: string; name: string };
  /**
   * Which feed this card came from. The Live Feed interleaves curated alerts with the user's own
   * matches (see apps/api/src/routes/matches.ts), and a curated entry is deliberately serialized
   * into this same Match shape - so `kind` is how a card knows which it is. Optional because an
   * API deployed before that change sends neither field.
   */
  kind?: "match" | "curated";
  /**
   * Present when the curator picked this token: on a "curated" card always, and on a "match"
   * card when the user's own filter caught the same token around the same time (one card, both
   * facts). Null on an ordinary match.
   */
  curated?: CuratedMeta | null;
}

export interface MatchesPage {
  matches: Match[];
  page: number;
  pageSize: number;
  totalCount: number;
}

/** One row on the public Leaderboard - the best-ever alert for a single token, only ever present
 *  once it's reached +100% above its alert-time market cap. See apps/api/src/routes/leaderboard.ts. */
export interface LeaderboardEntry {
  matchId: string;
  token: Token;
  alertMcapUsd: number;
  peakMcapUsd: number | null;
  peakMcapAt: string | null;
  returnPct: number | null;
  matchedAt: string;
  hitHundredPctAt: string | null;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
}

export type AlertMode = "REALTIME" | "DIGEST" | "BOTH" | "OFF";

export interface TelegramStatus {
  /** False when this deployment has no TELEGRAM_BOT_TOKEN configured yet - Settings hides the link flow entirely rather than offering a code nothing will ever consume. */
  enabled: boolean;
  linked: boolean;
  alertMode: AlertMode;
  pendingLinkCode: string | null;
  botUsername: string | null;
}

export interface TelegramLinkResponse {
  linkCode: string;
  expiresAt: string;
  deepLink: string | null;
}

export interface WorkerHeartbeat {
  job: string;
  lastRunAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  stale: boolean;
}

export interface WorkerHealth {
  jobs: WorkerHeartbeat[];
}

/**
 * State of the API instance's push channel (GET /health/stream).
 *
 * Worth surfacing because a broken listener is completely silent from the outside: no request
 * fails, clients just quietly stop receiving live alerts and fall back to their poll. Counts are
 * per-instance, so behind several API instances this reports whichever one answered.
 */
export interface StreamHealth {
  connected: boolean;
  subscribers: number;
}

// ── Admin ────────────────────────────────────────────────────────────────
export interface AdminStats {
  totalUsers: number;
  totalActiveFilters: number;
  totalTrackedTokens: number;
  totalMatches: number;
  matches24h: number;
  telegramLinkedUsers: number;
}

export interface AdminUser {
  id: string;
  walletAddress: string;
  createdAt: string;
  filterCount: number;
  matchCount: number;
  telegramLinked: boolean;
  alertMode: AlertMode | null;
}

/** A tracked token's most recent snapshot - upstream of both the rug screen and per-user filter
 *  matching, so this is what "before any filtering" actually means in this codebase. */
export interface AdminFeedSnapshot extends TokenSnapshot {
  token: Token;
}

export interface AdminLiveFeed {
  snapshots: AdminFeedSnapshot[];
  /** Watchlisted mints with zero snapshots yet (outside the mcap band, or not yet re-checked). */
  watchlistOnlyCount: number;
}

export interface AdminConfig {
  scanIntervalMinutes: number;
  /** How often the market cap is refreshed for tokens someone currently has open, and the cap on
   *  how many one pass will touch. Far faster than the scan cycle because it is market data only. */
  livePriceIntervalMinutes: number;
  livePriceMaxTracked: number;
  /** How long after last being viewed a token keeps getting tracked, even out of the mcap band. */
  activeViewWindowMinutes: number;
  /** How long a RugCheck report is reused. This is what lets the scan run every minute without
   *  multiplying RugCheck traffic one-for-one - the two are only sound in combination. */
  rugCheckCacheTtlMinutes: number;
  /** The wall-clock span holderGrowthPct is measured over. Worth reading before setting a
   *  minHolderGrowthPct threshold: "+5%" means nothing without knowing over how long. */
  holderGrowthWindowMinutes: number;
  /** The dashboard's own domain as the API has it. Decides both the Sign-In With Solana domain
   *  binding and the session cookie's SameSite, so it is the first thing to check when sign-in
   *  works in one browser and not another. */
  publicAppDomain: string;
  digestHourUtc: number;
  mcapFilterMin: number;
  mcapFilterMax: number;
  watchlistTtlHours: number;
  watchlistMaxTracked: number;
  cleanupHourUtc: number;
  snapshotRetentionDays: number;
  staleTokenRetentionDays: number;
  outcomeTrackingHourUtc: number;
  telegramConfigured: boolean;
}

// ── Subscription ─────────────────────────────────────────────────────────
/** Why a wallet has (or hasn't) access to the dashboard. */
export type AccessReason = "admin" | "whitelist" | "subscription" | "none";

export interface SubscriptionStatus {
  hasAccess: boolean;
  reason: AccessReason;
  /** Null for admins and indefinite whitelist entries. May be in the past, which is how the
   *  paywall can say "expired three days ago" rather than "you have no access". */
  expiresAt: string | null;
  price: {
    mint: string;
    decimals: number;
    tokensPerMonth: number;
    daysPerMonth: number;
  };
  burnCount: number;
  lastBurn: {
    signature: string;
    createdAt: string;
    monthsCredited: number;
    creditedAt: string | null;
  } | null;
}

/** Outcome of POST /subscription/claim. `pending` and `held` both come back as 202. */
export interface ClaimResult {
  status: "credited" | "already_credited" | "pending" | "held" | "rejected";
  hasAccess?: boolean;
  expiresAt?: string | null;
  message?: string;
  error?: string;
}

export interface AdminSubscriptionStats {
  activeSubscriptions: number;
  expiredSubscriptions: number;
  whitelisted: number;
  totalBurns: number;
  unattributedBurns: number;
  totalMonthsCredited: number;
  /** Base units, as a decimal string - too large for a JS number once the ledger grows. */
  totalRawBurned: string;
  scanCursor: string | null;
  scanCursorUpdatedAt: string | null;
}

export interface AdminSubscriber {
  walletAddress: string;
  expiresAt: string;
  source: "BURN" | "ADMIN_GRANT";
  burnCount: number;
  updatedAt: string;
}

export interface AdminBurn {
  signature: string;
  burnerWallet: string;
  rawAmount: string;
  monthsCredited: number;
  blockTime: string | null;
  creditedAt: string | null;
  discoveredBy: string;
  linkedWallet: string | null;
  slot: string;
}

export interface WhitelistEntry {
  walletAddress: string;
  expiresAt: string | null;
  note: string | null;
  addedBy: string;
  createdAt: string;
}

// ── Curated Alerts ───────────────────────────────────────────────────────

/** How one curated call is going / went - see resolveOutcome in apps/api/src/curatedFeed.ts. */
export interface CuratedOutcome {
  status: "watching" | "won" | "missed" | "disqualified" | "unknown";
  /** Doubled inside the 15-minute win window - the bar. */
  hit2x: boolean;
  /** Went on to 4x within the hour - the goal. Null while that's still an open question. */
  hitGoal?: boolean | null;
  peak1hReturnPct: number | null;
  maxDrawdown1hPct: number | null;
  peak24hReturnPct: number | null;
  finalized: boolean;
  /** Minutes left in the 15-minute win window; null once the verdict has landed. */
  minutesLeft: number | null;
}

/** Who picked this token, why, and how the call is going. Attached to a feed card. */
export interface CuratedMeta {
  alertId: string;
  /** "heuristic-v1", or the id of the trained model that emitted it. */
  source: string;
  confidence: number;
  reasons: string[];
  alertedAt: string;
  outcome: CuratedOutcome;
}

/** The Curated tab's page - the same card shape the Live Feed renders. */
export interface CuratedPage {
  alerts: Match[];
  page: number;
  pageSize: number;
  totalCount: number;
}

export interface CuratedStats {
  curator: {
    active: string;
    phase: "collecting-training-data" | "model-live";
    modelTrainedAt: string | null;
    latestEvaluation: {
      at: string;
      trainingRows: number;
      status: string;
      verdict: { promote: boolean; reason: string } | null;
    } | null;
  };
  training: {
    finalizedSamples: number;
    samples7d: number;
    winners: number;
    baseWinRatePct: number | null;
  };
  feed: {
    alertsTotal: number;
    alerts7d: number;
    graded: number;
    wins: number;
    hitRatePct: number | null;
    /** How many graded alerts went on to 4x within the hour - the goal behind the 15-minute bar.
     *  Optional so the tab keeps rendering against an API that predates the goal tracking. */
    goalHits?: number;
    goalRatePct?: number | null;
    bestPeak24hReturnPct: number | null;
  };
  /**
   * Each curator's last-30-days production record across both ledgers: its real curated alerts
   * from any time it held the job, plus its shadow picks from the bench (whichever curator
   * isn't picking runs silently on the same scan moments, graded by the same bar). Optional so
   * the tab keeps rendering against an API that predates it.
   */
  comparison30d?: {
    heuristic: CuratorRecord30d;
    model: CuratorRecord30d;
  };
}

export interface CuratorRecord30d {
  emitted: number;
  graded: number;
  wins: number;
  hitRatePct: number | null;
}
