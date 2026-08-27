import { useCallback, useEffect, useRef, useState } from "react";
import { listCurated, getCuratedStats, openCuratedStream } from "../api/client";
import type { CuratedAlert, CuratedOutcome, CuratedStats } from "../api/types";
import { fmtUsd } from "../utils/format";

/** Fallback poll. The SSE stream delivers new alerts instantly; this catches missed nudges. */
const POLL_INTERVAL_MS = 30_000;
/** Stats move slowly (labels close hourly, training runs nightly) - no reason to hammer them. */
const STATS_INTERVAL_MS = 60_000;

/**
 * The Curated Alerts tab: one global feed of high-conviction calls - the same list for every
 * subscriber - where every card publicly grades itself, plus the learning panel showing how the
 * self-learning pipeline behind it is coming along. See TrenchScanner's
 * packages/core/src/curation/ for what "curated" actually means mechanically.
 */
export function Curated() {
  const [alerts, setAlerts] = useState<CuratedAlert[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [stats, setStats] = useState<CuratedStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamLive, setStreamLive] = useState(false);

  // Sequenced by request id so a stale page's response can't land after a newer one - the same
  // discipline the Live Feed uses, for the same reason.
  const requestSeq = useRef(0);
  // The stream effect must not depend on `page` (that would tear down and reopen the SSE
  // connection on every page turn), so it reads the current page through this ref instead.
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  const load = useCallback(async (targetPage: number) => {
    const seq = ++requestSeq.current;
    try {
      const result = await listCurated(targetPage);
      if (seq !== requestSeq.current) return;
      setAlerts(result.alerts);
      setTotalCount(result.totalCount);
      setPageSize(result.pageSize);
      setError(null);
    } catch {
      if (seq === requestSeq.current) setError("Failed to load curated alerts.");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(page);
    const interval = setInterval(() => void load(page), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load, page]);

  useEffect(() => {
    const loadStats = async () => {
      try {
        setStats(await getCuratedStats());
      } catch {
        // The panel is contextual, never load-bearing - the feed renders without it.
      }
    };
    void loadStats();
    const interval = setInterval(() => void loadStats(), STATS_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const source = openCuratedStream();
    if (!source) return;
    source.addEventListener("ready", () => setStreamLive(true));
    // Nudge-only contract: refetch rather than trusting a payload - one definition of an alert
    // (the list route), not two that could drift. Refetches the page actually being read: a
    // reader parked on page 2 gets their view refreshed in place, not yanked to page 1's
    // content while the pagination still says otherwise.
    source.addEventListener("curated", () => void load(pageRef.current));
    source.onerror = () => setStreamLive(false);
    return () => source.close();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <div>
      <div className="dashboard__header">
        <h2>Curated Alerts</h2>
        <span
          className={`stream-pill ${streamLive ? "stream-pill--live" : ""}`}
          title={streamLive ? "New curated alerts appear instantly" : "Updating every 30s"}
        >
          {streamLive ? "Live" : "Polling"}
        </span>
      </div>

      <p className="leaderboard__note">
        <strong>One feed, curated for everyone.</strong> These are the pipeline&apos;s highest-conviction
        calls, picked by{" "}
        {stats?.curator.phase === "model-live" ? "a model trained on" : "a strict quality gate over"} every
        outcome this platform has ever recorded. A win means the price doubled within an hour of the
        alert without first dropping 50% - and every card below grades itself against that bar, publicly,
        including the misses. Quality floor, not a quota: a dead hour emits nothing.
      </p>

      {stats && <LearningPanel stats={stats} />}

      {loading && <p className="empty-state">Loading curated alerts…</p>}
      {error && <p className="empty-state">{error}</p>}
      {!loading && !error && alerts.length === 0 && (
        <p className="empty-state">
          Nothing has cleared the bar yet. The curator only emits when a candidate genuinely qualifies -
          check back soon.
        </p>
      )}

      {alerts.length > 0 && (
        <div className="curated-list">
          {alerts.map((alert) => (
            <CuratedCard key={alert.id} alert={alert} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="pagination">
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Newer
          </button>
          <span className="pagination__label">
            Page {page} of {totalPages}
          </span>
          <button className="btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Older
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The self-learning pipeline, in public: how much it has learned from, the base rate it has to
 * beat, how its own picks are scoring, and who is currently doing the picking. Transparency is
 * the feature - "the model takes over when it beats the gate" is a promise subscribers watch
 * happen here.
 */
function LearningPanel({ stats }: { stats: CuratedStats }) {
  const { curator, training, feed } = stats;
  const modelLive = curator.phase === "model-live";
  return (
    <section className="learning-panel">
      <div className="learning-panel__header">
        <h3>Self-learning curator</h3>
        <span className={`learning-panel__phase ${modelLive ? "learning-panel__phase--live" : ""}`}>
          {modelLive ? "Model live" : "Learning mode"}
        </span>
      </div>
      <p className="learning-panel__explain">
        {modelLive ? (
          <>
            The trained model is curating this feed - it earned the job by beating the hand-tuned gate on a
            walk-forward backtest, and it retrains nightly on everything new.
          </>
        ) : (
          <>
            The hand-tuned gate is curating while the pipeline banks training data. Every candidate the
            scanner scores gets its outcome recorded; a model trains on those nightly and takes over the
            moment it beats this gate on held-out history.
          </>
        )}
        {curator.latestEvaluation?.verdict && (
          <em className="learning-panel__verdict"> Latest evaluation: {curator.latestEvaluation.verdict.reason}.</em>
        )}
      </p>
      <div className="learning-panel__stats">
        <PanelStat
          label="Outcomes graded"
          value={training.finalizedSamples.toLocaleString()}
          hint="Candidates whose 1-hour label window has closed - the rows the model actually trains on."
        />
        <PanelStat
          label="Samples banked (7d)"
          value={`+${training.samples7d.toLocaleString()}`}
          hint="New training samples recorded this week; each grades itself an hour after capture."
        />
        <PanelStat
          label="Base win rate"
          value={training.baseWinRatePct !== null ? `${training.baseWinRatePct.toFixed(1)}%` : "—"}
          hint="How often ANY scanned candidate 2xs cleanly within an hour - the bar the curator has to beat."
        />
        <PanelStat
          label="Feed hit rate"
          value={feed.hitRatePct !== null ? `${feed.hitRatePct.toFixed(1)}%` : "—"}
          hint={`Of ${feed.graded} graded alert${feed.graded === 1 ? "" : "s"} so far.`}
        />
        <PanelStat
          label="Best call"
          value={
            feed.bestPeak24hReturnPct !== null ? `+${feed.bestPeak24hReturnPct.toFixed(0)}%` : "—"
          }
          hint="Highest 24h peak of any curated alert."
        />
      </div>
    </section>
  );
}

function PanelStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="learning-panel__stat" title={hint}>
      <span className="learning-panel__stat-value">{value}</span>
      <span className="learning-panel__stat-label">{label}</span>
    </div>
  );
}

function CuratedCard({ alert }: { alert: CuratedAlert }) {
  const { token, outcome } = alert;
  const name = token.name ?? token.symbol ?? `${token.mintAddress.slice(0, 8)}…`;
  const dexUrl = `https://dexscreener.com/solana/${token.pairAddress ?? token.mintAddress}`;

  return (
    <article className={`curated-card curated-card--${outcome.status}`}>
      <div className="curated-card__head">
        {token.imageUrl ? (
          <img className="curated-card__logo" src={token.imageUrl} alt="" loading="lazy" />
        ) : (
          <span className="curated-card__logo curated-card__logo--placeholder" aria-hidden="true">
            ◎
          </span>
        )}
        <div className="curated-card__title">
          <a href={dexUrl} target="_blank" rel="noreferrer">
            {name}
            {token.symbol && <span className="curated-card__symbol"> ${token.symbol}</span>}
          </a>
          <span className="curated-card__meta">
            Alerted {timeAgo(alert.createdAt)} at {fmtUsd(alert.anchorMcapUsd)} mcap · conviction{" "}
            {Math.round(alert.confidence)}
          </span>
        </div>
        <OutcomeBadge outcome={outcome} createdAt={alert.createdAt} />
      </div>

      {alert.reasons.length > 0 && (
        <ul className="curated-card__reasons">
          {alert.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      <div className="curated-card__outcomes">
        <OutcomeStat label="1h peak" value={pct(outcome.peak1hReturnPct)} />
        <OutcomeStat label="Worst drawdown" value={pct(outcome.maxDrawdown1hPct)} />
        <OutcomeStat label="24h peak" value={pct(outcome.peak24hReturnPct)} />
        <span className="curated-card__source" title="Which curator emitted this alert">
          {alert.source === "heuristic-v1" ? "quality gate" : "model"}
        </span>
      </div>
    </article>
  );
}

function OutcomeBadge({ outcome, createdAt }: { outcome: CuratedOutcome; createdAt: string }) {
  // A 2x observed mid-window flips the badge immediately - subscribers should not wait out the
  // hour to learn their alert already doubled.
  if (outcome.status === "watching") {
    if (outcome.hit2x) return <span className="outcome-badge outcome-badge--won">2x ✓</span>;
    const minutesLeft = Math.max(0, 60 - Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000));
    return <span className="outcome-badge outcome-badge--watching">watching · {minutesLeft}m</span>;
  }
  if (outcome.status === "won") return <span className="outcome-badge outcome-badge--won">2x ✓</span>;
  if (outcome.status === "missed") return <span className="outcome-badge outcome-badge--missed">missed</span>;
  if (outcome.status === "disqualified")
    return (
      <span
        className="outcome-badge outcome-badge--missed"
        title="It did 2x - but only after first dropping 50%+, which would have stopped out anyone who bought the alert. Counted as a loss on purpose."
      >
        stopped out
      </span>
    );
  return <span className="outcome-badge">—</span>;
}

function OutcomeStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="curated-card__stat">
      <span className="curated-card__stat-label">{label}</span> {value}
    </span>
  );
}

function pct(n: number | null): string {
  if (n === null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(n > 100 || n < -100 ? 0 : 1)}%`;
}

function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
