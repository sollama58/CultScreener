import { useCallback, useEffect, useRef, useState } from "react";
import { listCurated, getCuratedStats, openCuratedStream } from "../api/client";
import type { CuratedStats, Match } from "../api/types";
import { TokenCard } from "../components/TokenCard";

/** Fallback poll. The SSE stream delivers new alerts instantly; this catches missed nudges. */
const POLL_INTERVAL_MS = 30_000;
/** Stats move slowly (labels close hourly, training runs nightly) - no reason to hammer them. */
const STATS_INTERVAL_MS = 60_000;

/**
 * Graded alerts needed before a hit rate is worth printing.
 *
 * One alert that missed is not "a 0% hit rate", it is one alert - but rendered as a red 0% next
 * to the base rate it reads as a verdict on the product. Below this the tile says so instead.
 */
const MIN_GRADED_FOR_HIT_RATE = 10;

/**
 * The Curated Alerts tab: one global feed of the pipeline's highest-conviction calls, rendered
 * with the same card as the Live Feed (curated alerts also appear there, tinted) plus a compact
 * scoreboard for how the self-learning curator behind it is doing.
 */
export function Curated() {
  const [alerts, setAlerts] = useState<Match[]>([]);
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
  pageRef.current = page;

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
        // The scoreboard is contextual, never load-bearing - the feed renders without it.
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
    // (the list route), not two that could drift. Refetches the page actually being read.
    source.addEventListener("curated", () => void load(pageRef.current));
    source.onerror = () => setStreamLive(false);
    return () => source.close();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <div className="dashboard">
      <div className="dashboard__header">
        <h2>Curated Alerts</h2>
        <span
          className={`stream-pill ${streamLive ? "stream-pill--live" : ""}`}
          title={streamLive ? "New curated alerts appear instantly" : "Updating every 30s"}
        >
          {streamLive ? "Live" : "Polling"}
        </span>
      </div>

      {/* One line, because that is all anyone needs before the cards: what a card is, and what
          the badge on it means. Everything else lives in tooltips on the numbers themselves. */}
      <p className="curated-intro">
        The pipeline&apos;s highest-conviction calls, the same for everyone - each one graded in public
        against the same bar: <strong>2x within an hour, without first dropping 50%</strong>.
      </p>

      {stats && <CuratorScoreboard stats={stats} />}
      {stats && <TrainingExplainer stats={stats} />}

      {loading && alerts.length === 0 && <p className="empty-state">Loading curated alerts…</p>}
      {error && <p className="empty-state">{error}</p>}
      {!loading && !error && alerts.length === 0 && (
        <p className="empty-state">
          Nothing has cleared the bar yet - the curator only emits when a candidate genuinely qualifies.
        </p>
      )}

      <div className="token-grid">
        {alerts.map((alert) => (
          <TokenCard key={alert.id} match={alert} />
        ))}
      </div>

      {totalCount > pageSize && (
        <div className="pagination">
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            ← Newer
          </button>
          <span className="pagination__label">
            Page {page} of {totalPages}
          </span>
          <button
            className="btn"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Older →
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The curator's record, in one row.
 *
 * Deliberately four numbers and a status, not a paragraph: hit rate is the one people came for,
 * base rate is what makes it meaningful (it is what picking at random would get), and the phase
 * says who is currently picking - the hand-tuned gate, or the model once it has earned the job.
 */
function CuratorScoreboard({ stats }: { stats: CuratedStats }) {
  const { curator, training, feed } = stats;
  const modelLive = curator.phase === "model-live";
  return (
    <section className="scoreboard">
      <Stat
        label="Hit rate"
        value={
          feed.hitRatePct !== null && feed.graded >= MIN_GRADED_FOR_HIT_RATE
            ? `${feed.hitRatePct.toFixed(0)}%`
            : `${feed.graded}/${MIN_GRADED_FOR_HIT_RATE}`
        }
        hint={
          feed.graded >= MIN_GRADED_FOR_HIT_RATE
            ? `Of ${feed.graded} curated alerts whose hour has closed.`
            : `Too few graded alerts to quote a rate yet - ${feed.graded} of ${MIN_GRADED_FOR_HIT_RATE} so far. Each one settles an hour after it fires.`
        }
        tone={
          feed.hitRatePct !== null && training.baseWinRatePct !== null && feed.graded >= MIN_GRADED_FOR_HIT_RATE
            ? feed.hitRatePct > training.baseWinRatePct
              ? "good"
              : "bad"
            : undefined
        }
      />
      <Stat
        label="Random would get"
        value={training.baseWinRatePct !== null ? `${training.baseWinRatePct.toFixed(1)}%` : "—"}
        hint="How often any scanned token clears the same bar - the number the curator has to beat."
      />
      <Stat
        label="Best call"
        value={feed.bestPeak24hReturnPct !== null ? `+${feed.bestPeak24hReturnPct.toFixed(0)}%` : "—"}
        hint="Highest 24h peak of any curated alert."
      />
      <Stat
        label="Alerts (7d)"
        value={feed.alerts7d.toLocaleString()}
        hint={`${feed.alertsTotal.toLocaleString()} in total.`}
      />
      <span
        className={`scoreboard__phase ${modelLive ? "scoreboard__phase--live" : ""}`}
        title={
          modelLive
            ? "A model trained on this pipeline's own recorded outcomes is picking - it earned the job by beating the hand-tuned gate on held-out history, and retrains nightly."
            : `A hand-tuned quality gate is picking while the model learns. ${training.finalizedSamples.toLocaleString()} outcomes graded so far (+${training.samples7d.toLocaleString()} this week); it takes over automatically once it beats the gate on held-out history.${curator.latestEvaluation?.verdict ? ` Latest check: ${curator.latestEvaluation.verdict.reason}.` : ""}`
        }
      >
        {modelLive ? "Model picking" : "Learning"}
      </span>
    </section>
  );
}

/**
 * The fuller writeup behind the phase badge's tooltip - closed by default (a `<details>`, not a
 * hover), since a tooltip is easy to miss on mobile and this is worth reading once. Ends with an
 * explicit experimental warning: this whole self-learning half of the pipeline is new, trained on
 * a small and volatile market, and its backtest numbers describe the past, not a promise.
 */
function TrainingExplainer({ stats }: { stats: CuratedStats }) {
  const { curator, training, comparison30d } = stats;
  const modelLive = curator.phase === "model-live";
  const recordLine = (record: { graded: number; hitRatePct: number | null }) =>
    record.graded > 0 && record.hitRatePct !== null
      ? `${record.hitRatePct.toFixed(0)}% of ${record.graded.toLocaleString()} graded picks`
      : "no graded picks yet";
  const showComparison =
    comparison30d && (comparison30d.heuristic.graded > 0 || comparison30d.model.graded > 0);
  return (
    <details className="training-explainer">
      <summary className="training-explainer__summary">How does the model training work?</summary>
      <div className="training-explainer__body">
        <p>
          Every candidate that clears the rug screen - not just the ones that get curated - has its outcome
          quietly tracked: did it 2x within an hour without first dropping 50%. That record is the training
          set. Every 4 hours, a model retrains on it and is walk-forward tested against the hand-tuned gate
          currently picking - trained on the past, graded on a slice of history it never saw, the way a real
          deployment would be judged.
        </p>
        <p>
          The model only takes the job when it clearly beats the gate, including on the most recent slice of
          history - a model that used to win but has since stopped can&apos;t coast in on an old record. The
          same check runs again at every retrain, so the job can also hand back to the gate if the model
          stops winning. And whichever curator is <em>not</em> picking still runs silently on the same
          candidates, its would-be picks graded by the same bar - so both sides carry a live record, not
          just backtest numbers.{" "}
          {training.finalizedSamples > 0 && (
            <>
              {training.finalizedSamples.toLocaleString()} outcomes graded so far (+
              {training.samples7d.toLocaleString()} this week).
            </>
          )}
          {curator.latestEvaluation?.verdict && ` Latest check: ${curator.latestEvaluation.verdict.reason}.`}
        </p>
        {showComparison && (
          <p className="training-explainer__comparison">
            Last 30 days, graded in production - live picks and shadow picks together:{" "}
            <strong>hand-tuned gate</strong> {recordLine(comparison30d.heuristic)} ·{" "}
            <strong>model</strong> {recordLine(comparison30d.model)}.
          </p>
        )}
        <p className="training-explainer__warning">
          <strong>Experimental:</strong> this self-learning system is new and trained on a small, fast-moving
          market - {modelLive ? "the live model's" : "any future model's"} backtest numbers describe what
          already happened, not a guarantee of what happens next. Treat every curated alert, from either
          curator, as one input - not financial advice.
        </p>
      </div>
    </details>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="scoreboard__stat" title={hint}>
      <span className="scoreboard__value" data-tone={tone}>
        {value}
      </span>
      <span className="scoreboard__label">{label}</span>
    </div>
  );
}
