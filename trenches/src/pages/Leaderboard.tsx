import { useEffect, useState } from "react";
import { getLeaderboard } from "../api/client";
import type { LeaderboardEntry } from "../api/types";
import { fmtUsd } from "../utils/format";

const POLL_INTERVAL_MS = 60_000;

/**
 * The best-performing alerts this platform has ever surfaced, globally across every user - see
 * apps/api/src/routes/leaderboard.ts for exactly what qualifies (reached at least +100%/2x above
 * its alert-time market cap; one entry per token, its single best-returning alert). The
 * underlying figures only change once a day (apps/worker/src/jobs/outcomeTrackingJob.ts), so
 * polling here is just to catch that daily update, not a live feed.
 */
export function Leaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const result = await getLeaderboard();
        if (cancelled) return;
        setEntries(result.entries);
        setError(null);
      } catch {
        if (!cancelled) setError("Failed to load the leaderboard.");
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
  }, []);

  return (
    <div>
      <div className="dashboard__header">
        <h2>Leaderboard</h2>
      </div>

      <p className="leaderboard__note">
        The best calls TrenchScanner has ever surfaced - every alert that went on to at least double (+100%)
        from its market cap at alert time, ranked by how far it ran. One entry per token, and it only shows up
        here once it's actually crossed that bar - most alerts never will, and that's expected.
      </p>

      {loading && <p className="empty-state">Loading leaderboard…</p>}
      {error && <p className="empty-state">{error}</p>}
      {!loading && !error && entries.length === 0 && (
        <p className="empty-state">
          No alerts have hit +100% yet. Check back later - the outcome-tracking job rechecks recent alerts
          daily, and it takes real time for a token to run.
        </p>
      )}

      {entries.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Token</th>
                <th>Alerted at</th>
                <th>All-time high</th>
                <th>Return</th>
                <th>Alerted on</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={entry.matchId}>
                  <td>{i + 1}</td>
                  <td>
                    <a
                      href={`https://dexscreener.com/solana/${entry.token.pairAddress ?? entry.token.mintAddress}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {entry.token.name ?? entry.token.symbol ?? entry.token.mintAddress.slice(0, 8)}
                      {entry.token.symbol && ` ($${entry.token.symbol})`}
                    </a>
                  </td>
                  <td>{fmtUsd(entry.alertMcapUsd)}</td>
                  <td>{fmtUsd(entry.peakMcapUsd)}</td>
                  <td className="leaderboard__return">
                    {entry.returnPct !== null ? `+${entry.returnPct.toFixed(0)}%` : "—"}
                  </td>
                  <td>{new Date(entry.matchedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
