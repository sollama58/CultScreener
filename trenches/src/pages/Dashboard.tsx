import { useCallback, useEffect, useRef, useState } from "react";
import { listFilters, listMatches, openMatchesStream } from "../api/client";
import { prefetchedMatchesIncludeCurated, takePrefetched } from "../api/bootPrefetch";

import type { Match } from "../api/types";
import { TokenCard } from "../components/TokenCard";
import { TokenGridSkeleton } from "../components/TokenCardSkeleton";
import { FeedFilterBar } from "../components/FeedFilterBar";
import { DEFAULT_FEED_FILTER, isDefaultFilter, passesFeedFilter, type FeedFilter } from "../utils/feedFilter";
import { usePreferences } from "../context/PreferencesContext";
import { useFeedStatus } from "../context/FeedStatusContext";
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

/**
 * How many alerts one page shows - the server's own fixed page size (see MatchesPage.pageSize).
 * Filtered browsing paginates over this many PASSING alerts, not raw ones - see the backfill
 * logic below.
 */
const DISPLAY_PAGE_SIZE = 12;

/**
 * Backfill cap for a filtered view: how many raw server pages one "ensure enough for page N"
 * pass will pull before giving up, even if the filter is narrow enough to never fill a page. A
 * generous, bounded backstop (~300 raw alerts) rather than "keep going forever" - a filter that
 * genuinely matches almost nothing should end in "that's everything," not an unbounded fetch
 * loop the moment someone pages deep enough.
 */
const MAX_FILTER_LOOKAHEAD_PAGES = 25;

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
  const filterActive = !isDefaultFilter(filter);

  // ── Filtered-view pagination ────────────────────────────────────────
  // Raw "page N" from the server rarely lines up with "page N" of what a tight filter actually
  // lets through - a narrow filter can leave a raw page nearly empty, which reads as a broken
  // filter (a couple of cards, then Next/Next/Next through mostly-blank pages to see more).
  // Filtered browsing keeps its own page counter over the PASSING alerts instead, and backfills
  // by pulling more raw pages from the server until it has enough to fill the requested page (or
  // has genuinely run out) - see ensureFilteredPage. Untouched by any of this when the filter is
  // at its default (isDefaultFilter), which is the common case and keeps the plain single-page
  // fetch below exactly as it was.
  const [filteredPage, setFilteredPage] = useState(1);
  const [filteredRaw, setFilteredRaw] = useState<Match[]>([]);
  const [filteredServerTotal, setFilteredServerTotal] = useState(0);
  const [filteredLoading, setFilteredLoading] = useState(false);
  const filteredRequestIdRef = useRef(0);

  // A different range means a different "page 1" - the previously accumulated buffer may not
  // have enough (or the right) alerts for it. Adjusted directly during render (a recognized React
  // pattern for "derive state from a changed prop/value") rather than in an effect, so it's
  // already correct by the time the fetch effect below reads `filteredPage` in the same commit -
  // an effect-based reset here would let one stale fetch slip through first.
  const lastFilterRef = useRef(filter);
  if (lastFilterRef.current !== filter) {
    lastFilterRef.current = filter;
    if (filteredPage !== 1) setFilteredPage(1);
  }

  // Checked once on mount, not on every poll tick - a brand new user creating their first filter
  // just needs the welcome message to go away next time they load the page, not live mid-session.
  useEffect(() => {
    void (async () => {
      try {
        const filters = (await takePrefetched("filters")) ?? (await listFilters());
        setHasFilters(filters.length > 0);
      } catch {
        setHasFilters(true); // fail open - never block the feed on this check
      }
    })();
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

  // The bar renders this - see FeedStatusContext. Cleared on unmount so switching tabs doesn't
  // leave a frozen "Updated 4:43:57 PM" from a feed that is no longer running.
  const { setStatus: setFeedStatus } = useFeedStatus();
  useEffect(() => {
    setFeedStatus({ streamConnected: streamLive, lastUpdated, nextRefreshAt });
  }, [setFeedStatus, streamLive, lastUpdated, nextRefreshAt]);
  useEffect(() => () => setFeedStatus(null), [setFeedStatus]);
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

  /**
   * Refreshes whatever list is actually on screen. The filtered view renders from its own buffer
   * (see ensureFilteredPage), which the plain `refetch` below does not touch - so with a feed
   * filter on, a live alert used to chime immediately and then not appear until the 45-second
   * poll caught up. Held in a ref, and reassigned every render, so the stream effect can call the
   * current one without listing filter state as a dependency and tearing the SSE connection down
   * on every keystroke in the filter bar.
   */
  const refreshVisibleRef = useRef<() => void>(() => {});

  const refetch = useCallback(async (opts: { showPending?: boolean } = {}) => {
    const id = ++requestIdRef.current;
    // Only a move the reader made - first load, or turning a page - blanks the grid for
    // skeletons. The 45-second background poll deliberately does not: replacing a readable page
    // with placeholders every poll would be worse than showing nothing at all.
    if (opts.showPending) setLoading(true);
    try {
      // The very first page-1 load can be answered by the boot prefetch, which asked for it in
      // parallel with the session and subscription checks instead of waiting behind them. It is
      // only offered once, and only while fresh, so every poll and page turn is a real request.
      const prefetched =
        pageRef.current === 1 &&
        prefsRef.current.includeCuratedInFeed === prefetchedMatchesIncludeCurated
          ? await takePrefetched("matches")
          : null;
      const result = prefetched ?? (await listMatches(pageRef.current, prefsRef.current.includeCuratedInFeed));
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
    void refetch({ showPending: true });
    return () => {
      if (refreshTimerRef.current !== undefined) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = undefined;
    };
    // includeCuratedInFeed changes what the server returns, so it has to re-run this - the
    // fetchers read it through prefsRef precisely so they DON'T re-run on every volume nudge,
    // which means nothing else would notice the toggle. Listed here, not in refetch's deps.
  }, [page, refetch, prefs.includeCuratedInFeed]);

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
      refreshVisibleRef.current();
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

  /**
   * Ensures the filtered buffer has enough PASSING alerts to fill `targetPage`, pulling
   * additional raw server pages (starting fresh from page 1 each time) until it does, or until
   * it has genuinely run out.
   *
   * Restarts from page 1 rather than appending onto whatever was already buffered: a live update
   * can insert a brand new alert ahead of everything else, which would otherwise shift every
   * later alert's page by one and risk showing a duplicate or dropping one at a page boundary.
   * Raw pages are cheap (12 rows of JSON), so redoing the walk from the top on every call trades
   * a handful of small requests for a model with no bookkeeping to get subtly wrong.
   */
  const ensureFilteredPage = useCallback(async (targetPage: number, activeFilter: FeedFilter) => {
    const id = ++filteredRequestIdRef.current;
    setFilteredLoading(true);
    const nowMs = Date.now();
    let raw: Match[] = [];
    let serverTotal = 0;
    let rawPage = 1;
    try {
      for (;;) {
        const result = await listMatches(rawPage, prefsRef.current.includeCuratedInFeed);
        if (id !== filteredRequestIdRef.current) return; // superseded by a newer request
        serverTotal = result.totalCount;
        raw = raw.concat(result.matches);
        const passingCount = raw.filter((m) => passesFeedFilter(m, activeFilter, nowMs)).length;
        const haveEnough = passingCount >= targetPage * DISPLAY_PAGE_SIZE;
        const exhausted = result.matches.length === 0 || raw.length >= serverTotal;
        if (haveEnough || exhausted || rawPage >= MAX_FILTER_LOOKAHEAD_PAGES) break;
        rawPage += 1;
      }
    } catch {
      // A failed page mid-backfill keeps whatever was already fetched successfully - a partial,
      // honestly-labelled result beats discarding it all and showing nothing.
    } finally {
      if (id === filteredRequestIdRef.current) {
        setFilteredRaw(raw);
        setFilteredServerTotal(serverTotal);
        setFilteredLoading(false);
      }
    }
  }, []);

  // Debounced trigger for the filtered backfill: dragging a slider fires many rapid filter
  // updates, and only the value it settles on is worth a round trip. A page-navigation click
  // doesn't touch `filter` at all, so it falls through with no artificial delay.
  const prevFilterForFetchRef = useRef(filter);
  useEffect(() => {
    if (!filterActive) return;
    const filterJustChanged = prevFilterForFetchRef.current !== filter;
    prevFilterForFetchRef.current = filter;
    const delay = filterJustChanged ? 300 : 0;
    const t = setTimeout(() => void ensureFilteredPage(filteredPage, filter), delay);
    return () => clearTimeout(t);
    // Same reason as the unfiltered effect above: the toggle changes the server's answer, and
    // the filtered walk re-runs from page 1 anyway.
  }, [filterActive, filter, filteredPage, ensureFilteredPage, prefs.includeCuratedInFeed]);

  // Keeps the filtered view "live" the same way the unfiltered one is: a fresh alert or a stale
  // market cap shouldn't sit unnoticed just because a filter happens to be on.
  useEffect(() => {
    if (!filterActive) return;
    const interval = setInterval(() => void ensureFilteredPage(filteredPage, filter), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [filterActive, filteredPage, filter, ensureFilteredPage]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  // Ticks with the shared clock (the same one the cards' own timers use), so a card ages out of
  // a "last 5 minutes" filter on its own rather than at the next poll.
  const now = useNow();
  const visibleMatches = matches.filter((m) => passesFeedFilter(m, filter, now));

  const filteredMatches = filteredRaw.filter((m) => passesFeedFilter(m, filter, now));
  // Known-exhausted only once the buffer has genuinely caught up to the server's own count - a
  // buffer that's merely paused mid-backfill (haveEnough tripped first) must not read as "that's
  // everything," or Next would wrongly disable itself one page early.
  const filteredExhausted = filteredRaw.length > 0 && filteredRaw.length >= filteredServerTotal;
  const filteredSlice = filteredMatches.slice(
    (filteredPage - 1) * DISPLAY_PAGE_SIZE,
    filteredPage * DISPLAY_PAGE_SIZE,
  );
  // Optimistic when not yet confirmed exhausted: ensureFilteredPage stops the instant it has
  // enough for the CURRENT page, so it may not yet know whether a full next page exists. Clicking
  // Next either reveals one or (once that resolves) confirms there isn't - either way this alone
  // never has to guess wrong for longer than one backfill.
  const filteredHasNext = filteredExhausted
    ? filteredMatches.length > filteredPage * DISPLAY_PAGE_SIZE
    : true;

  // A live update can shrink the passing set out from under a page the user was already on
  // (a token's price moved back inside a filter's exclusion range, say) - once the buffer is
  // confirmed exhausted, land back on the last page that actually has something rather than
  // stranding them on a blank one.
  useEffect(() => {
    if (!filterActive || filteredLoading || !filteredExhausted) return;
    const lastValidPage = Math.max(1, Math.ceil(filteredMatches.length / DISPLAY_PAGE_SIZE));
    if (filteredPage > lastValidPage) setFilteredPage(lastValidPage);
  }, [filterActive, filteredLoading, filteredExhausted, filteredMatches.length, filteredPage]);

  // Assigned every render so the SSE handler always calls the current one - see the ref's own
  // comment. Mirrors exactly what the page renders: the filtered buffer when a filter is on,
  // the plain feed otherwise.
  refreshVisibleRef.current = () => {
    if (filterActive) void ensureFilteredPage(filteredPage, filter);
    else void refetch();
  };

  const displayedMatches = filterActive ? filteredSlice : visibleMatches;

  /**
   * Whether the grid should show placeholders rather than cards.
   *
   * `loading` is only ever set for something the reader did - the first load, or turning a page.
   * The 45-second background poll deliberately leaves it alone, because swapping a readable page
   * for placeholders on every poll would be worse than showing nothing at all.
   */
  const showSkeleton =
    loading || (filterActive && filteredLoading && displayedMatches.length === 0);

  return (
    <div className="dashboard">
      {hasFilters === false ? (
        <div className="welcome-card">
          <h3>Welcome to TrenchScanner 👋</h3>
          <p>
            This feed shows tokens matched to <strong>your own filters</strong> - and you don't have any set
            up yet, so it's empty. The <strong>Curated</strong> tab has picks to read in the meantime: the
            pipeline's own highest-conviction calls, the same for everyone. You can also mix those into this
            feed from Settings.
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
          shown={filterActive ? filteredMatches.length : visibleMatches.length}
          total={filterActive ? filteredRaw.length : matches.length}
        />
      )}

      {!filterActive && matches.length > 0 && visibleMatches.length === 0 && (
        <p className="empty-state">
          All {matches.length} alerts on this page are outside the filter above - widen it or reset to see
          them again.
        </p>
      )}

      {filterActive && !filteredLoading && filteredExhausted && filteredMatches.length === 0 && (
        <p className="empty-state">
          Nothing matches this filter yet - widen it or reset to see alerts again.
        </p>
      )}

      {/* One decision covers every way the grid can be waiting - first load, a page turn, and a
          filtered fetch with nothing to show yet. Written as separate conditions these could all
          be true at once and render two placeholder grids stacked on top of each other. */}
      {showSkeleton ? (
        <>
          {/* Announced once, for readers who cannot see the placeholders. */}
          <p className="sr-only" role="status">
            Loading matches…
          </p>
          <TokenGridSkeleton count={Math.max(1, displayedMatches.length || pageSize)} />
        </>
      ) : (
        <div className="token-grid">
          {displayedMatches.map((match, i) => (
            // The stagger is capped: past the eighth card the delay stops reading as sequence and
            // starts reading as lag, and a reader scrolling straight down should not overtake it.
            <TokenCard key={match.id} match={match} index={Math.min(i, 8)} />
          ))}
        </div>
      )}

      {filterActive ? (
        (filteredPage > 1 || filteredHasNext) && (
          <div className="pagination">
            <button
              className="btn"
              disabled={filteredPage <= 1}
              onClick={() => setFilteredPage((p) => Math.max(1, p - 1))}
            >
              ← Prev
            </button>
            <span className="pagination__label">
              {filteredLoading ? "Loading more…" : `Page ${filteredPage}`}
            </span>
            <button
              className="btn"
              disabled={!filteredHasNext || filteredLoading}
              onClick={() => setFilteredPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        )
      ) : (
        totalCount > pageSize && (
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
        )
      )}
    </div>
  );
}

