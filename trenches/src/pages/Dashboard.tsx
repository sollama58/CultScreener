import { useEffect, useState } from "react";
import { listFilters, listMatches } from "../api/client";
import type { Match } from "../api/types";
import { TokenCard } from "../components/TokenCard";

const POLL_INTERVAL_MS = 20_000;

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

  // Checked once on mount, not on every poll tick - a brand new user creating their first filter
  // just needs the welcome message to go away next time they load the page, not live mid-session.
  useEffect(() => {
    listFilters()
      .then((filters) => setHasFilters(filters.length > 0))
      .catch(() => setHasFilters(true)); // fail open - never block the feed on this check
  }, []);

  // Re-runs whenever `page` changes, and the cleanup's `cancelled` flag is what keeps this scoped
  // to "actively displayed" tokens: if the user flips pages while a request for the old page is
  // still in flight, that response is discarded instead of briefly overwriting the new page's
  // content. Each poll only ever asks the API for the 12 matches on the current page, and the API
  // itself only stamps those 12 tokens' lastViewedAt (see apps/api/src/routes/matches.ts) -
  // nothing off-page gets refreshed just because it's technically still in the feed.
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const result = await listMatches(page);
        if (cancelled) return;
        setMatches(result.matches);
        setTotalCount(result.totalCount);
        setPageSize(result.pageSize);
        setLastUpdated(new Date());
      } catch {
        // A single failed poll isn't worth surfacing to the user - the next tick will retry.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <div className="dashboard">
      <div className="dashboard__header">
        <h2>Live Feed</h2>
        {lastUpdated && (
          <span className="dashboard__updated">Updated {lastUpdated.toLocaleTimeString()}</span>
        )}
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
              it'll show up here within a few minutes.
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
