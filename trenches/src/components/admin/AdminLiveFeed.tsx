import { useEffect, useState } from "react";
import { getAdminLiveFeed } from "../../api/client";
import type { AdminFeedSnapshot } from "../../api/types";
import { fmtUsd, fmtPct, fmtAge } from "../../utils/format";

const POLL_INTERVAL_MS = 30_000;
const FEED_LIMIT = 150;

/**
 * Every tracked token's latest snapshot, unfiltered - upstream of both the rug screen and
 * per-user filter matching, so a token can show up here even if it failed the rug screen or
 * never matched anyone's filter. That's the point: this is the one place those are visible at
 * all, since scanJob.ts never creates a Match row for either case.
 */
export function AdminLiveFeed() {
  const [snapshots, setSnapshots] = useState<AdminFeedSnapshot[]>([]);
  const [watchlistOnlyCount, setWatchlistOnlyCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastPolled, setLastPolled] = useState<Date | null>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        const feed = await getAdminLiveFeed(FEED_LIMIT);
        setSnapshots(feed.snapshots);
        setWatchlistOnlyCount(feed.watchlistOnlyCount);
        setError(null);
        setLastPolled(new Date());
      } catch {
        setError("Failed to load the live feed.");
      } finally {
        setLoading(false);
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div className="dashboard__header">
        <h3>Live feed - all detected tokens</h3>
        {lastPolled && <span className="dashboard__updated">Updated {lastPolled.toLocaleTimeString()}</span>}
      </div>

      <p className="admin-live-feed__note">
        Every tracked token's latest snapshot, most recent first - before the rug screen and before matching
        against any user's filters.{" "}
        {watchlistOnlyCount > 0 && (
          <>
            {watchlistOnlyCount.toLocaleString()} more mint{watchlistOnlyCount === 1 ? "" : "s"} on the
            watchlist {watchlistOnlyCount === 1 ? "hasn't" : "haven't"} had a snapshot yet (outside the mcap
            band, or not yet re-checked this cycle).
          </>
        )}
      </p>

      {loading && <p className="empty-state">Loading…</p>}
      {error && <p className="empty-state">{error}</p>}
      {!loading && !error && snapshots.length === 0 && (
        <p className="empty-state">
          No snapshots yet - the scanner hasn't completed a cycle with anything in band.
        </p>
      )}

      {snapshots.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Mcap</th>
                <th>Score</th>
                <th>Rug screen</th>
                <th>Top 10</th>
                <th>Risk</th>
                <th>Bonded</th>
                <th>Age</th>
                <th>Taken at</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a
                      href={`https://dexscreener.com/solana/${s.token.pairAddress ?? s.token.mintAddress}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {s.token.name ?? s.token.symbol ?? s.token.mintAddress.slice(0, 8)}
                      {s.token.symbol && ` ($${s.token.symbol})`}
                    </a>
                  </td>
                  <td>{fmtUsd(s.marketCapUsd)}</td>
                  <td>{s.score !== null ? s.score.toFixed(0) : "—"}</td>
                  <td>
                    <span className={`badge ${s.rugScreenPassed ? "badge--on" : "badge--off"}`}>
                      {s.rugScreenPassed ? "Passed" : "Failed"}
                    </span>
                    {!s.rugScreenPassed && s.rugScreenReasons.length > 0 && (
                      <span className="admin-table__reasons" title={s.rugScreenReasons.join("; ")}>
                        {" "}
                        ({s.rugScreenReasons.length})
                      </span>
                    )}
                  </td>
                  <td>{fmtPct(s.top10HolderPct)}</td>
                  <td>
                    {s.riskScore ?? "—"}
                    {hasCriticalRiskFlag(s.riskFlags) && (
                      <span className="admin-table__reasons" title={s.riskFlags.join("; ")}>
                        {" "}
                        ⚠
                      </span>
                    )}
                  </td>
                  <td>{s.graduated === null ? "—" : s.graduated ? "Graduated" : "Bonding"}</td>
                  <td>{fmtAge(s.ageMinutes)}</td>
                  <td>{new Date(s.takenAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Mirrors rugScreen.ts's CRITICAL_RISK_FLAGS - can't import it directly, the web app doesn't
// depend on @trenchscanner/core (a backend-only package built around Prisma).
const CRITICAL_RISK_FLAGS = new Set(["Creator history of rugged tokens", "Creator identity unknown"]);

function hasCriticalRiskFlag(flags: string[]): boolean {
  return flags.some((f) => CRITICAL_RISK_FLAGS.has(f));
}
