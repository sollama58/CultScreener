import { useCallback, useEffect, useRef, useState } from "react";
import { listFilters, listMatches, openMatchesStream } from "../api/client";
import { HealthBadge } from "../components/HealthBadge";
import type { Match } from "../api/types";
import { TokenCard } from "../components/TokenCard";
import { FeedFilterBar } from "../components/FeedFilterBar";
import { DEFAULT_FEED_FILTER, passesFeedFilter, type FeedFilter } from "../utils/feedFilter";
import { usePreferences } from "../context/PreferencesContext";
import { playAlertSound } from "../utils/alertSound";
import { useNow } from "../utils/useNow";

/**
 * Alerts do NOT wait for this. New matches arrive over the SSE stream the instant the server
 * has them (see the stream effect below), which is what keeps alert latency at ~0 rather than
 * at whatever this interval happens to be.
 *
 * This poll has two other jobs, and neither needs to be fast:
 *  - It is the required fallback for when the stream is down or a nudge is missed; the stream
 *    is explicitly not reliable delivery.
 *  - Fetching a page has a deliberate server-side side effect: it stamps those tokens as being
 *    looked at, which is what makes the backend keep refreshing their market caps. The server
 *    refreshes viewed tokens about once a minute, so polling faster than that buys no fresher
 *    numbers — it just adds requests.
 *
 * So market-cap figures refresh on this cadence while alerts arrive immediately. The two are
 * deliberately decoupled.
 */
const POLL_INTERVAL_MS = 45_000;

/**
 * The shortest gap between two alert chimes.
 *
 * The scanner creates matches in batches, so five tokens can qualify in the same cycle - and both
 * paths below (the stream nudge and the poll's own detection) can notice the same batch. One
 * sound per burst is the useful signal; five overlapping chimes is just noise.
 */
const SOUND_COOLDOWN_MS = 2_000;

interface DashboardProps {
  /** Jumps to the Filters tab - wired to the same tab state the Navbar uses (see App.tsx). */
  onGoToFilters: () => void;
}

export function Dashboard({ onGoToFilters }: DashboardProps) {
  const { prefs } = usePreferences();
  const [page, setPage] = useState(1);
  const [matches, setMatches] = useState<Match[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [pageSize, setPageSize] = useState(12);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // null while we haven't checked yet - distinct from `false` so the welcome message can't
  // flash-and-disappear before the first /filters response comes back.
  const [hasFilters, setHasFilters] = useState<boolean | null>(null);
  // Whether live push is currently connected - shown in the header so it's visible when the
  // feed has silently fallen back to polling.
  const [streamLive, setStreamLive] = useState(false);
  // Display-only: narrows what's on screen, never what's fetched or alerted. Component state
  // rather than saved preferences, so it can't outlive the session and leave someone staring at
  // a feed they filtered empty yesterday.
  const [filter, setFilter] = useState<FeedFilter>(DEFAULT_FEED_FILTER);

  // Checked once on mount, not on every poll tick - a brand new user creating their first filter
  // just needs the welcome message to go away next time they load the page, not live mid-session.
  useEffect(() => {
    listFilters()
      .then((filters) => setHasFilters(filters.length > 0))
      .catch(() => setHasFilters(true)); // fail open - never block the feed on this check
  }, []);

  // Both the poll and the live stream call this, so responses are sequenced by request id
  // rather than a per-effect `cancelled` flag: whichever request was issued last is the only
  // one allowed to write state. That keeps a slow in-flight poll from clobbering the fresher
  // result a stream nudge just fetched, and keeps a stale page's response from landing after
  // the user has flipped pages.
  const pageRef = useRef(page);
  pageRef.current = page;
  const requestIdRef = useRef(0);

  // When the next refresh is actually due, in epoch ms - what the countdown in the header reads
  // from. Null until the first fetch has landed and set a real deadline.
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Lets the timer below call the current refetch without either one having to be declared first.
  const refetchRef = useRef<(() => Promise<void>) | undefined>(undefined);

  /**
   * Arm the next refresh, `POLL_INTERVAL_MS` from now.
   *
   * A rescheduling timeout rather than a fixed interval, because a live push also refetches: with
   * an interval anchored at mount, a stream nudge at second 10 would still leave a poll firing at
   * second 45, and the countdown on screen would be describing a schedule the feed wasn't
   * actually keeping. Re-arming from the fetch that just landed makes the number honest, and
   * saves the redundant request into the bargain.
   */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== undefined) clearTimeout(refreshTimerRef.current);
    setNextRefreshAt(Date.now() + POLL_INTERVAL_MS);
    refreshTimerRef.current = setTimeout(() => void refetchRef.current?.(), POLL_INTERVAL_MS);
  }, []);

  // Preferences are read through a ref rather than closed over, so `refetch` and
  // `announceNewAlert` stay referentially stable. Both are dependencies of the stream effect
  // below; rebuilding them every time the volume slider moves would tear down and reopen the SSE
  // connection mid-drag.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // The newest matchedAt this tab has seen, in epoch ms. Null until the first response lands.
  const newestSeenRef = useRef<number | null>(null);
  const lastSoundAtRef = useRef(0);
  // Ids already chimed for, so the two detection paths can't both announce the same match.
  const announcedIdsRef = useRef(new Set<string>());

  const announceNewAlert = useCallback(() => {
    const { alertSoundEnabled, alertSound, alertVolume } = prefsRef.current;
    if (!alertSoundEnabled) return;
    const now = Date.now();
    // A burst of matches from one scan cycle is one event worth hearing, not five.
    if (now - lastSoundAtRef.current < SOUND_COOLDOWN_MS) return;
    lastSoundAtRef.current = now;
    void playAlertSound(alertSound, alertVolume);
  }, []);

  const rememberAnnounced = useCallback((matchId: string) => {
    const seen = announcedIdsRef.current;
    // Bounded: a tab left open for a week would otherwise accumulate every id it ever saw. Losing
    // the oldest entries is harmless - they are long past the high-water mark that gates them.
    if (seen.size > 500) seen.clear();
    seen.add(matchId);
  }, []);

  const refetch = useCallback(async () => {
    const id = ++requestIdRef.current;
    try {
      const result = await listMatches(pageRef.current);
      if (id !== requestIdRef.current) return; // superseded by a later request
      setMatches(result.matches);
      setTotalCount(result.totalCount);
      setPageSize(result.pageSize);
      setLastUpdated(new Date());

      // Which of these count as *new* is tracked as a high-water mark on matchedAt, not as a set
      // of ids already seen. Paging backwards hands us twelve matches this tab has never seen and
      // not one of them is a new alert; comparing timestamps gets that right for free, and also
      // means a refetch that returns the same page unchanged stays silent.
      const previous = newestSeenRef.current;
      const arrived = result.matches.filter((m) => {
        const at = new Date(m.matchedAt).getTime();
        return Number.isFinite(at) && previous !== null && at > previous;
      });
      const newest = result.matches.reduce((max, m) => Math.max(max, new Date(m.matchedAt).getTime() || 0), 0);
      if (newest > 0) newestSeenRef.current = previous === null ? newest : Math.max(previous, newest);

      // A null previous is the first load of this tab: everything on screen is new to us, but
      // none of it just happened, so it must not chime. Beyond that, anything the stream already
      // chimed for is skipped - otherwise someone reading page 3 when an alert lands hears it
      // once from the stream and again the moment they navigate back to page 1, where the
      // high-water mark finally sees it.
      if (arrived.length > 0 && arrived.some((m) => !announcedIdsRef.current.has(m.id))) {
        for (const m of arrived) rememberAnnounced(m.id);
        announceNewAlert();
      }
    } catch {
      // A single failed fetch isn't worth surfacing - the next tick or nudge will retry.
    } finally {
      // Only the winning request re-arms the timer. A superseded one landing late would otherwise
      // push the deadline out and make the countdown jump backwards.
      if (id === requestIdRef.current) {
        setLoading(false);
        scheduleRefresh();
      }
    }
  }, [announceNewAlert, rememberAnnounced, scheduleRefresh]);

  refetchRef.current = refetch;

  // Each fetch only ever asks for the 12 matches on the current page, and the API only stamps
  // those 12 tokens' lastViewedAt - nothing off-page gets refreshed just because it's still
  // technically in the feed.
  useEffect(() => {
    // No interval here: each fetch arms the next one itself (see scheduleRefresh).
    void refetch();
    return () => {
      if (refreshTimerRef.current !== undefined) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = undefined;
    };
  }, [page, refetch]);

  // Live alerts. A 'match' event means the server just created a match for this user; it
  // carries only an id, so the render still comes from a refetch - the event just removes the
  // wait. This is why the poll above can be slow without alerts being slow.
  useEffect(() => {
    const es = openMatchesStream();
    if (!es) return;

    const handleOpen = () => setStreamLive(true);
    const handleMatch = (event: Event) => {
      // The event itself is the new-alert signal, and unlike the refetch below it is not scoped
      // to a page - so the chime still fires for someone reading page 3, where the refetched
      // matches will contain nothing newer than before.
      //
      // The id is recorded, not used to render: the payload is a nudge, and the card still comes
      // from the refetch. Recording it is what stops the refetch path chiming for it a second
      // time. A payload that doesn't parse costs only that de-duplication, so it still chimes.
      try {
        const data: unknown = JSON.parse((event as MessageEvent<string>).data);
        const matchId = (data as { matchId?: unknown })?.matchId;
        if (typeof matchId === "string") rememberAnnounced(matchId);
      } catch {
        // Malformed or absent payload - announce anyway, that part doesn't depend on the id.
      }
      announceNewAlert();
      void refetch();
    };
    const handleError = () => {
      setStreamLive(false);
      // Deliberately no reconnect here. EventSource retries transient drops by itself (the
      // server sends `retry: 5000`); a non-200 - notably the 503 when the server is at stream
      // capacity - closes it for good, and the correct response to that is to let the fallback
      // poll carry the feed, not to hammer the endpoint.
    };

    es.addEventListener("open", handleOpen);
    es.addEventListener("ready", handleOpen);
    es.addEventListener("match", handleMatch);
    es.addEventListener("error", handleError);

    return () => {
      es.removeEventListener("open", handleOpen);
      es.removeEventListener("ready", handleOpen);
      es.removeEventListener("match", handleMatch);
      es.removeEventListener("error", handleError);
      es.close();
    };
  }, [refetch, announceNewAlert, rememberAnnounced]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  // Ticks with the shared clock (the same one the cards' own timers use), so a card ages out of
  // a "last 5 minutes" filter on its own rather than at the next poll.
  const now = useNow();
  const visibleMatches = matches.filter((m) => passesFeedFilter(m, filter, now));

  return (
    <div className="dashboard">
      <div className="dashboard__header">
        <h2>Live Feed</h2>
        <div className="dashboard__status">
          <HealthBadge streamConnected={streamLive} />
          <span className="dashboard__updated">
            {lastUpdated && <span>Updated {lastUpdated.toLocaleTimeString()}</span>}
            <RefreshCountdown at={nextRefreshAt} />
          </span>
        </div>
      </div>

      {hasFilters === false ? (
        <div className="welcome-card">
          <h3>Welcome to TrenchScanner 👋</h3>
          <p>
            This feed shows tokens matched to <strong>your own filters</strong> - and you don't have any set
            up yet. Until you do, it shows the ★ Curated picks: the pipeline's own highest-conviction calls,
            the same for everyone.
          </p>
          <p>
            Every token is already screened for basic safety before it ever reaches you (see the Filters page
            for what that covers), but you decide the rest: market cap range, how much of the supply insiders
            hold, how new the token is, and more.
          </p>
          <button className="btn btn--primary" onClick={onGoToFilters}>
            Create your first filter →
          </button>
        </div>
      ) : (
        <>
          {loading && matches.length === 0 && <p className="empty-state">Loading matches…</p>}

          {!loading && matches.length === 0 && (
            <p className="empty-state">
              Nothing here yet. Once a token in the trenches passes the screen and matches one of your
              filters - or the curator picks one - it'll show up within a few minutes.
            </p>
          )}
        </>
      )}

      {matches.length > 0 && (
        <FeedFilterBar
          filter={filter}
          onChange={setFilter}
          shown={visibleMatches.length}
          total={matches.length}
        />
      )}

      {matches.length > 0 && visibleMatches.length === 0 && (
        <p className="empty-state">
          All {matches.length} alerts on this page are outside the filter above - widen it or reset to see
          them again.
        </p>
      )}

      <div className="token-grid">
        {visibleMatches.map((match) => (
          <TokenCard key={match.id} match={match} />
        ))}
      </div>

      {totalCount > pageSize && (
        <div className="pagination">
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            ← Prev
          </button>
          <span className="pagination__label">
            Page {page} of {totalPages}
          </span>
          <button
            className="btn"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * How long until the feed next refreshes its figures.
 *
 * Worth showing because "Live" answers a different question than people read into it: the badge
 * is about the scanner still running, while the market caps on the cards move on this timer.
 * Without it a number that hasn't changed for half a minute is ambiguous between "nothing
 * happened" and "nothing has been fetched".
 *
 * Alerts are not on this clock - they arrive over the push stream the moment they exist, which is
 * what the badge's pulsing dot indicates. This is only about the periodic refresh of the figures.
 */
function RefreshCountdown({ at }: { at: number | null }) {
  const now = useNow();
  if (at === null) return null;

  const secondsLeft = Math.max(0, Math.ceil((at - now) / 1000));
  return (
    <span
      className="dashboard__countdown"
      title="Market caps and other figures refresh on this timer. New alerts don't wait for it - they're pushed as soon as they happen."
    >
      {secondsLeft === 0 ? "refreshing…" : `next in ${secondsLeft}s`}
    </span>
  );
}
