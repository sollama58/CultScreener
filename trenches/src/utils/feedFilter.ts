import type { Match } from "../api/types";

/**
 * The Live Feed's display filter.
 *
 * Purely a view over what has already arrived: it never changes what the scanner alerts on, what
 * the server sends, or what gets fetched. Turning it off restores the full feed instantly,
 * because nothing was ever discarded - which is also why it lives in component state rather than
 * in the saved filters, and why the header always says how many cards it is hiding.
 */

/** Slider bounds. The extreme ends mean "no limit" rather than a hard cut - see FeedFilter. */
export const AGE_MIN_MINUTES = 0;
export const AGE_MAX_MINUTES = 60;
export const CHANGE_MIN_PCT = -100;
export const CHANGE_MAX_PCT = 500;

export interface FeedFilter {
  /** Hide anything alerted less than this many minutes ago. 0 = no lower bound. */
  minAgeMinutes: number;
  /** Hide anything alerted more than this many minutes ago. AGE_MAX_MINUTES = no upper bound. */
  maxAgeMinutes: number;
  /** Hide anything that has moved less than this since the alert. -100 = no lower bound. */
  minChangePct: number;
  /** Hide anything that has moved more than this. CHANGE_MAX_PCT = no upper bound. */
  maxChangePct: number;
}

export const DEFAULT_FEED_FILTER: FeedFilter = {
  minAgeMinutes: AGE_MIN_MINUTES,
  maxAgeMinutes: AGE_MAX_MINUTES,
  minChangePct: CHANGE_MIN_PCT,
  maxChangePct: CHANGE_MAX_PCT,
};

/** Whether the filter is currently letting everything through. */
export function isDefaultFilter(f: FeedFilter): boolean {
  return (
    f.minAgeMinutes === AGE_MIN_MINUTES &&
    f.maxAgeMinutes === AGE_MAX_MINUTES &&
    f.minChangePct === CHANGE_MIN_PCT &&
    f.maxChangePct === CHANGE_MAX_PCT
  );
}

/**
 * How far a token has moved since it was alerted, as a percentage of its alert-time market cap.
 *
 * Lives here rather than in TokenCard because the filter and the card must agree exactly: a card
 * reading "+38%" that a "+40% and up" filter kept would be its own bug report. Null when there is
 * nothing newer than the alert-time snapshot to compare against.
 */
export function changeSinceAlertPct(match: Match): number | null {
  const alertMcap = match.snapshot.marketCapUsd;
  const nowMcap =
    match.currentMarketCapUsd !== undefined
      ? match.currentMarketCapUsd
      : (match.latestSnapshot?.marketCapUsd ?? null);
  if (nowMcap === null || !Number.isFinite(nowMcap) || alertMcap <= 0) return null;
  return ((nowMcap - alertMcap) / alertMcap) * 100;
}

/** Minutes since the alert fired, floored at zero against clock skew. */
export function minutesSinceAlert(match: Match, now: number): number {
  return Math.max(0, (now - new Date(match.matchedAt).getTime()) / 60_000);
}

/**
 * Whether one card survives the filter.
 *
 * A card whose change is unknown (nothing fresher than the alert-time snapshot yet) passes while
 * the change filter is untouched, and is hidden once it has been narrowed: "show me the ones up
 * 40%+" should not quietly include the ones we cannot price. Age is always known, so it needs no
 * such rule.
 */
export function passesFeedFilter(match: Match, filter: FeedFilter, now: number): boolean {
  const age = minutesSinceAlert(match, now);
  if (age < filter.minAgeMinutes) return false;
  if (filter.maxAgeMinutes < AGE_MAX_MINUTES && age > filter.maxAgeMinutes) return false;

  const changeUnfiltered =
    filter.minChangePct === CHANGE_MIN_PCT && filter.maxChangePct === CHANGE_MAX_PCT;
  if (changeUnfiltered) return true;

  const change = changeSinceAlertPct(match);
  if (change === null) return false;
  if (change < filter.minChangePct) return false;
  if (filter.maxChangePct < CHANGE_MAX_PCT && change > filter.maxChangePct) return false;
  return true;
}

/** Slider label: the top of each scale reads as open-ended, because that is what it means. */
export function formatAgeBound(minutes: number, isUpper: boolean): string {
  if (isUpper && minutes >= AGE_MAX_MINUTES) return "1h+";
  if (minutes === 0) return "0m";
  return minutes >= 60 ? "1h" : `${minutes}m`;
}

export function formatChangeBound(pct: number, isUpper: boolean): string {
  if (isUpper && pct >= CHANGE_MAX_PCT) return `+${CHANGE_MAX_PCT}%+`;
  if (!isUpper && pct <= CHANGE_MIN_PCT) return "-100%";
  return `${pct > 0 ? "+" : ""}${pct}%`;
}
