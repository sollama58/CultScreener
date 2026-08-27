import { useCallback, useEffect, useRef, useState } from "react";
import { listFilters, listMatches, openMatchesStream } from "../api/client";
import type { Match } from "../api/types";
import { TokenCard } from "../components/TokenCard";

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

interface DashboardProps {
  /** Jumps to the Filters tab - wired to the same tab state the Navbar uses (see App.tsx). */
  onGoToFilters: () => void;
}

export function Dashboard({ onGoToFilters }: DashboardProps) {
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

  const refetch = useCallback(async () => {
    const id = ++requestIdRef.current;
    try {
      const result = await listMatches(pageRef.current);
      if (id !== requestIdRef.current) return; // superseded by a later request
      setMatches(result.matches);
      setTotalCount(result.totalCount);
      setPageSize(result.pageSize);
      setLastUpdated(new Date());
    } catch {
      // A single failed fetch isn't worth surfacing - the next tick or nudge will retry.
    } finally {
      if (id === requestIdRef.current) setLoading(false);
    }
  }, []);

  // Each fetch only ever asks for the 12 matches on the current page, and the API only stamps
  // those 12 tokens' lastViewedAt - nothing off-page gets refreshed just because it's still
  // technically in the feed.
  useEffect(() => {
    void refetch();
    const interval = setInterval(() => void refetch(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [page, refetch]);

  // Live alerts. A 'match' event means the server just created a match for this user; it
  // carries only an id, so the render still comes from a refetch - the event just removes the
  // wait. This is why the poll above can be slow without alerts being slow.
  useEffect(() => {
    const es = openMatchesStream();
    if (!es) return;

    const handleOpen = () => setStreamLive(true);
    const handleMatch = () => void refetch();
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
  }, [refetch]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <div className="dashboard">
      <div className="dashboard__header">
        <h2>Live Feed</h2>
        <span className="dashboard__updated">
          {streamLive && (
            <span className="dashboard__live" title="Connected - new alerts appear the moment they happen.">
              <span className="dashboard__live-dot" />
              Live
            </span>
          )}
          {lastUpdated && <>Updated {lastUpdated.toLocaleTimeString()}</>}
        </span>
      </div>

      {hasFilters === false ? (
        <div className="welcome-card">
          <h3>Welcome to TrenchScanner 👋</h3>
          <p>
            This feed shows tokens matched to <strong>your own filters</strong> - and you don't have any set
            up yet, so there's nothing here for now.
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
              No matches yet. Once a token in the trenches passes the screen and matches one of your filters,
              it'll show up here within seconds.
            </p>
          )}
        </>
      )}

      <div className="token-grid">
        {matches.map((match) => (
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
