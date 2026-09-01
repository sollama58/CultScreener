import { useCallback, useEffect, useRef, useState } from "react";
import { listCurated, getCuratedStats, openCuratedStream } from "../api/client";
import type { CuratedStats, Match } from "../api/types";
import { TokenCard } from "../components/TokenCard";
import { TokenGridSkeleton } from "../components/TokenCardSkeleton";
import { usePreferences } from "../context/PreferencesContext";
import { playAlertSound } from "../utils/alertSound";

/** Fallback poll. The SSE stream delivers new alerts instantly; this catches missed nudges. */
const POLL_INTERVAL_MS = 30_000;
/** Stats move slowly (labels close hourly, training runs nightly) - no reason to hammer them. */
const STATS_INTERVAL_MS = 60_000;

/** Minimum gap between two focus-triggered catch-ups - same guard the Live Feed uses. */
const VISIBILITY_REFETCH_GRACE_MS = 10_000;

/** One chime per burst - the same cooldown the Live Feed applies, for the same reason. */
const SOUND_COOLDOWN_MS = 2_000;

/**
 * The server reuses one page of curated rows for up to this long across readers (see pageCache in
 * TrenchScanner's apps/api/src/routes/curated.ts). An SSE nudge that lands inside that window
 * refetches the pre-alert page, so the follow-up below re-asks just past it.
 */
const SERVER_PAGE_CACHE_MS = 3_000;

/**
 * How many newest pages an outcome-filtered view walks.
 *
 * Deliberately equal to the server's own MAX_CACHED_PAGES: every page this walk asks for is one
 * the API holds in its shared 3-second cache, so a filtered reader costs the database nothing a
 * plain reader didn't already. Eight pages is ~a day of alerts at the governor's default pace -
 * the horizon someone filtering "what won today" actually means - and the honesty line under the
 * grid says exactly what was searched.
 */
const FILTER_WALK_PAGES = 8;

/**
 * Graded alerts needed before a hit rate is worth printing.
 *
 * One alert that missed is not "a 0% hit rate", it is one alert - but rendered as a red 0% next
 * to the base rate it reads as a verdict on the product. Below this the tile says so instead.
 */
const MIN_GRADED_FOR_HIT_RATE = 10;

/**
 * The last page-1 answer this session rendered, kept across unmounts - the same treatment the
 * Live Feed gives its feed, for the same reason: App.tsx renders one tab at a time, so every
 * return to this tab used to remount it into skeletons and a full round trip to re-show the
 * cards that were on screen moments ago. A seeded mount paints those immediately and refreshes
 * quietly behind them. Trusted for a few poll intervals, then it is a cold start again.
 */
let lastCuratedPage: { alerts: Match[]; totalCount: number; pageSize: number; at: number } | null = null;

const LAST_PAGE_MAX_AGE_MS = 3 * POLL_INTERVAL_MS;

function takeLastCuratedPage() {
  if (!lastCuratedPage) return null;
  if (Date.now() - lastCuratedPage.at > LAST_PAGE_MAX_AGE_MS) return null;
  return lastCuratedPage;
}

// ── Outcome filtering ────────────────────────────────────────────────────

type OutcomeChip = "all" | "watching" | "won" | "goal" | "missed" | "stopped";

/**
 * The feed's own vocabulary, as filters. Each chip is a question people actually ask of a
 * self-grading feed - "what's live right now", "show me the wins", "how does a miss look" - and
 * the predicates mirror OutcomeBadge exactly, so a chip never shows a card whose badge disagrees
 * with it. In particular: disqualified alerts have hit2x=true by construction, so the win chips
 * must exclude them the same way the badge does.
 */
const OUTCOME_CHIPS: { id: OutcomeChip; label: string; hint: string }[] = [
  { id: "all", label: "All", hint: "Every curated alert, newest first." },
  { id: "watching", label: "Watching", hint: "Still inside the 15-minute win window." },
  { id: "won", label: "2x wins", hint: "Doubled within 15 minutes of the alert, without first dropping 50%." },
  { id: "goal", label: "4x", hint: "Wins that went on to 4x within the hour - the goal behind the bar." },
  { id: "missed", label: "Missed", hint: "Did not double within 15 minutes of the alert." },
  { id: "stopped", label: "Stopped out", hint: "Doubled, but only after first dropping 50%+ - counted as a loss on purpose." },
];

function passesOutcome(alert: Match, chip: OutcomeChip): boolean {
  if (chip === "all") return true;
  const outcome = alert.curated?.outcome;
  if (!outcome) return false;
  switch (chip) {
    case "watching":
      return outcome.status === "watching";
    case "won":
      return outcome.hit2x && outcome.status !== "disqualified";
    case "goal":
      return outcome.hitGoal === true && outcome.status !== "disqualified";
    case "missed":
      return outcome.status === "missed";
    case "stopped":
      return outcome.status === "disqualified";
  }
}

/**
 * The Curated Alerts tab: one global feed of the pipeline's highest-conviction calls, rendered
 * with the same card as the Live Feed (curated alerts also appear there, tinted) plus a compact
 * scoreboard for how the self-learning curator behind it is doing.
 */
export function Curated() {
  const { prefs } = usePreferences();
  const [seed] = useState(() => takeLastCuratedPage());
  const [alerts, setAlerts] = useState<Match[]>(seed?.alerts ?? []);
  const [totalCount, setTotalCount] = useState(seed?.totalCount ?? 0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(seed?.pageSize ?? 12);
  const [stats, setStats] = useState<CuratedStats | null>(null);
  const [loading, setLoading] = useState(seed === null);
  const [error, setError] = useState<string | null>(null);
  const [streamLive, setStreamLive] = useState(false);
  // Clicking the scoreboard's phase badge opens the full writeup below it - the writeup IS the
  // badge's explanation, and on touch there is no hover to find it with.
  const [explainerOpen, setExplainerOpen] = useState(false);

  // ── Outcome-filtered view ───────────────────────────────────────────
  // Renders from its own buffer, walked FILTER_WALK_PAGES deep, because a single 12-card page
  // filtered down to its two wins reads as a broken feed. Same shape as the Live Feed's display
  // filter, scaled down: the walk is bounded, the pager runs over what passed, and the line
  // under the toolbar says what was searched.
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeChip>("all");
  const filterActive = outcomeFilter !== "all";
  const [filteredRaw, setFilteredRaw] = useState<Match[]>([]);
  const [filteredWindow, setFilteredWindow] = useState(0);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [filteredPage, setFilteredPage] = useState(1);
  const [filteredLoading, setFilteredLoading] = useState(false);
  const filteredSeq = useRef(0);

  // A different chip means a different "page 1". Adjusted during render, not in an effect, so
  // the fetch below never sees the stale page number - same pattern the Live Feed uses.
  const lastChipRef = useRef(outcomeFilter);
  if (lastChipRef.current !== outcomeFilter) {
    lastChipRef.current = outcomeFilter;
    if (filteredPage !== 1) setFilteredPage(1);
  }

  // Sequenced by request id so a stale page's response can't land after a newer one - the same
  // discipline the Live Feed uses, for the same reason.
  const requestSeq = useRef(0);
  // The stream effect must not depend on `page` (that would tear down and reopen the SSE
  // connection on every page turn), so it reads the current page through this ref instead.
  const pageRef = useRef(page);
  pageRef.current = page;

  // Preferences through a ref so the chime helper stays referentially stable - rebuilding it
  // on a volume nudge would tear down and reopen the SSE connection. Same as the Live Feed.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const lastSoundAtRef = useRef(0);

  /** The same chime the Live Feed plays, honouring the same Settings switches. */
  const announceNewAlert = useCallback(() => {
    const { alertSoundEnabled, alertSound, alertVolume } = prefsRef.current;
    if (!alertSoundEnabled) return;
    const now = Date.now();
    if (now - lastSoundAtRef.current < SOUND_COOLDOWN_MS) return;
    lastSoundAtRef.current = now;
    void playAlertSound(alertSound, alertVolume);
  }, []);

  const load = useCallback(async (targetPage: number) => {
    const seq = ++requestSeq.current;
    try {
      const result = await listCurated(targetPage);
      if (seq !== requestSeq.current) return;
      setAlerts(result.alerts);
      setTotalCount(result.totalCount);
      setPageSize(result.pageSize);
      setError(null);
      // What the next mount of this tab paints first. Page 2+ is not kept - a remount lands on 1.
      if (targetPage === 1) {
        lastCuratedPage = { alerts: result.alerts, totalCount: result.totalCount, pageSize: result.pageSize, at: Date.now() };
      }
    } catch {
      if (seq === requestSeq.current) setError("Failed to load curated alerts.");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  /**
   * Walks the newest FILTER_WALK_PAGES pages in one parallel burst and keeps everything, letting
   * the render filter it. Page 1 is fetched first alone - it carries the count that says how many
   * of the other pages exist at all. De-duplicated by id because a new alert landing mid-walk
   * shifts every later page by one, which would otherwise show one card twice.
   */
  const loadFiltered = useCallback(async () => {
    const seq = ++filteredSeq.current;
    setFilteredLoading(true);
    try {
      const first = await listCurated(1);
      if (seq !== filteredSeq.current) return;
      const pagesAvailable = Math.max(1, Math.ceil(first.totalCount / first.pageSize));
      const walkPages = Math.min(FILTER_WALK_PAGES, pagesAvailable);
      const rest =
        walkPages > 1
          ? await Promise.all(Array.from({ length: walkPages - 1 }, (_, i) => listCurated(i + 2)))
          : [];
      if (seq !== filteredSeq.current) return;
      const seen = new Set<string>();
      const merged: Match[] = [];
      for (const alert of [first, ...rest].flatMap((p) => p.alerts)) {
        if (seen.has(alert.id)) continue;
        seen.add(alert.id);
        merged.push(alert);
      }
      setFilteredRaw(merged);
      setFilteredWindow(merged.length);
      setFilteredTotal(first.totalCount);
      setError(null);
    } catch {
      if (seq === filteredSeq.current) setError("Failed to load curated alerts.");
    } finally {
      if (seq === filteredSeq.current) setFilteredLoading(false);
    }
  }, []);

  /**
   * Refreshes whatever list is actually on screen - the filtered buffer when a chip is active,
   * the plain page otherwise. A ref, reassigned every render, so the SSE and visibility handlers
   * always call the current one without listing filter state as an effect dependency.
   */
  const refreshVisibleRef = useRef<() => void>(() => {});
  refreshVisibleRef.current = () => {
    if (filterActive) void loadFiltered();
    else void load(pageRef.current);
  };

  useEffect(() => {
    if (filterActive) return; // the filtered walk below is the active fetcher
    void load(page);
    const interval = setInterval(() => void load(page), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load, page, filterActive]);

  useEffect(() => {
    if (!filterActive) return;
    void loadFiltered();
    const interval = setInterval(() => void loadFiltered(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadFiltered, filterActive]);

  const loadStats = useCallback(async () => {
    try {
      setStats(await getCuratedStats());
    } catch {
      // The scoreboard is contextual, never load-bearing - the feed renders without it.
    }
  }, []);

  useEffect(() => {
    void loadStats();
    const interval = setInterval(() => void loadStats(), STATS_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadStats]);

  // Catch up the moment the tab comes back to the foreground - browsers throttle a hidden tab's
  // timers to a crawl, so the feed someone returns to can be minutes stale though nothing failed.
  // Same guard against alt-tab bursts as the Live Feed.
  const lastVisibleFetchRef = useRef(0);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastVisibleFetchRef.current < VISIBILITY_REFETCH_GRACE_MS) return;
      lastVisibleFetchRef.current = Date.now();
      refreshVisibleRef.current();
      void loadStats();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [loadStats]);

  useEffect(() => {
    const source = openCuratedStream();
    if (!source) return;
    let recheck: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("ready", () => setStreamLive(true));
    // Nudge-only contract: refetch rather than trusting a payload - one definition of an alert
    // (the list route), not two that could drift. Refetches the view actually being read.
    source.addEventListener("curated", () => {
      announceNewAlert();
      refreshVisibleRef.current();
      // The server reuses a page for up to SERVER_PAGE_CACHE_MS across readers, so a refetch
      // racing the nudge can be answered from the pre-alert cache - the card would then wait out
      // the full poll. One quiet follow-up just past the TTL closes that gap.
      if (recheck !== undefined) clearTimeout(recheck);
      recheck = setTimeout(() => refreshVisibleRef.current(), SERVER_PAGE_CACHE_MS + 500);
    });
    source.onerror = () => setStreamLive(false);
    return () => {
      if (recheck !== undefined) clearTimeout(recheck);
      source.close();
    };
  }, [announceNewAlert]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const passing = filterActive ? filteredRaw.filter((a) => passesOutcome(a, outcomeFilter)) : [];
  const filteredTotalPages = Math.max(1, Math.ceil(passing.length / pageSize));
  const filteredSlice = passing.slice((filteredPage - 1) * pageSize, filteredPage * pageSize);
  const displayed = filterActive ? filteredSlice : alerts;
  const activeChip = OUTCOME_CHIPS.find((c) => c.id === outcomeFilter);

  const showSkeleton =
    (!filterActive && loading && alerts.length === 0) ||
    (filterActive && filteredLoading && filteredRaw.length === 0);

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
        {/* A dropped poll over healthy cards is "up to 30s stale", not "broken" - said quietly
            here rather than as an error banner shoving the grid down. */}
        {error && displayed.length > 0 && (
          <span className="curated-retry" title={error}>
            retrying…
          </span>
        )}
      </div>

      {/* One line, because that is all anyone needs before the cards: what a card is, and what
          the badge on it means. Everything else lives in the scoreboard's own explanations. */}
      <p className="curated-intro">
        The pipeline&apos;s highest-conviction calls, the same for everyone - each one graded in public
        against the same bar: <strong>2x within 15 minutes, without first dropping 50%</strong> - and then
        tracked for the hour to see if it reaches <strong>4x</strong>.
      </p>

      {stats && <CuratorScoreboard stats={stats} onPhaseClick={() => setExplainerOpen(true)} />}
      {stats && <TrainingExplainer stats={stats} open={explainerOpen} onToggle={setExplainerOpen} />}

      {(totalCount > 0 || filterActive) && (
        <div className="outcome-chips" role="group" aria-label="Filter alerts by outcome">
          {OUTCOME_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={`outcome-chip${outcomeFilter === chip.id ? " outcome-chip--active" : ""}`}
              aria-pressed={outcomeFilter === chip.id}
              title={chip.hint}
              onClick={() => setOutcomeFilter(chip.id)}
            >
              {chip.label}
            </button>
          ))}
          {filterActive && !filteredLoading && (
            <span
              className="outcome-chips__count"
              title={
                filteredTotal > filteredWindow
                  ? `The ${OUTCOME_CHIPS.length - 1} filters search the newest ${filteredWindow} alerts; the full history (${filteredTotal.toLocaleString()} alerts) is under All.`
                  : undefined
              }
            >
              {passing.length} of the newest {filteredWindow}
            </span>
          )}
        </div>
      )}

      {error && displayed.length === 0 && (
        <p className="empty-state">
          {error}{" "}
          <button className="btn" onClick={() => refreshVisibleRef.current()}>
            Retry
          </button>
        </p>
      )}
      {!filterActive && !loading && !error && alerts.length === 0 && (
        <p className="empty-state">
          Nothing has cleared the bar yet - the curator only emits when a candidate genuinely qualifies.
        </p>
      )}
      {filterActive && !filteredLoading && !error && passing.length === 0 && (
        <p className="empty-state">
          No “{activeChip?.label}” alerts in the newest {filteredWindow}
          {filteredTotal > filteredWindow ? " - older history is under All" : ""}.
        </p>
      )}

      {showSkeleton ? (
        <>
          {/* Announced once, for readers who cannot see the placeholders. */}
          <p className="sr-only" role="status">
            Loading curated alerts…
          </p>
          <TokenGridSkeleton count={Math.max(1, displayed.length || pageSize)} />
        </>
      ) : (
        <div className="token-grid">
          {displayed.map((alert, i) => (
            // Stagger capped as on the Live Feed: past the eighth card sequence reads as lag.
            <TokenCard key={alert.id} match={alert} index={Math.min(i, 8)} />
          ))}
        </div>
      )}

      {!filterActive && totalCount > pageSize && (
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
      {filterActive && passing.length > pageSize && (
        <div className="pagination">
          <button
            className="btn"
            disabled={filteredPage <= 1}
            onClick={() => setFilteredPage((p) => Math.max(1, p - 1))}
          >
            ← Newer
          </button>
          <span className="pagination__label">
            Page {filteredPage} of {filteredTotalPages}
          </span>
          <button
            className="btn"
            disabled={filteredPage >= filteredTotalPages}
            onClick={() => setFilteredPage((p) => Math.min(filteredTotalPages, p + 1))}
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
 * Deliberately a handful of numbers and a status, not a paragraph: hit rate is the one people
 * came for, base rate is what makes it meaningful (it is what picking at random would get), and
 * the phase says who is currently picking - the hand-tuned gate, or the model once it has earned
 * the job. Each tile now carries its raw counts in a visible sub-line and explains itself on
 * tap/click as well as hover - a title tooltip alone is unreachable on touch, and this scoreboard
 * is precisely the thing a sceptical reader on a phone should be able to interrogate.
 */
function CuratorScoreboard({ stats, onPhaseClick }: { stats: CuratedStats; onPhaseClick: () => void }) {
  const { curator, training, feed } = stats;
  const modelLive = curator.phase === "model-live";
  const rateable = feed.hitRatePct !== null && feed.graded >= MIN_GRADED_FOR_HIT_RATE;
  // How many times better (or worse) than chance the curator is picking - the one number that
  // turns "31%" from trivia into a verdict. Only quoted once the rate itself is quotable.
  const edge =
    rateable && training.baseWinRatePct !== null && training.baseWinRatePct > 0
      ? feed.hitRatePct! / training.baseWinRatePct
      : null;
  return (
    <section className="scoreboard">
      <Stat
        label="Hit rate"
        // Never a slash-fraction before the threshold: a big "3/10" under "Hit rate" reads
        // universally as three wins out of ten graded - a losing record - when it means "three
        // graded, ten needed". A dash plus the visible count says exactly what is known.
        value={rateable ? `${feed.hitRatePct!.toFixed(0)}%` : "—"}
        sub={
          rateable
            ? `${feed.wins} of ${feed.graded} graded${edge !== null ? ` · ${edge.toFixed(1)}× random` : ""}`
            : `${feed.graded} of ${MIN_GRADED_FOR_HIT_RATE} graded`
        }
        hint={
          rateable
            ? `Of ${feed.graded} curated alerts that have been graded: doubled within 15 minutes, without first dropping 50%.`
            : `Too few graded alerts to quote a rate yet - ${feed.graded} of ${MIN_GRADED_FOR_HIT_RATE} so far. Each one settles 15 minutes after it fires.`
        }
        tone={
          rateable && training.baseWinRatePct !== null
            ? feed.hitRatePct! > training.baseWinRatePct
              ? "good"
              : "bad"
            : undefined
        }
      />
      <Stat
        label="Random would get"
        value={training.baseWinRatePct !== null ? `${training.baseWinRatePct.toFixed(1)}%` : "—"}
        sub={
          training.finalizedSamples > 0
            ? `${training.winners.toLocaleString()} of ${training.finalizedSamples.toLocaleString()} tracked`
            : undefined
        }
        hint="How often any scanned token clears the same bar - the number the curator has to beat."
      />
      {feed.goalRatePct !== undefined && (
        <Stat
          label="Reached 4x"
          value={feed.goalRatePct !== null && rateable ? `${feed.goalRatePct.toFixed(0)}%` : "—"}
          sub={rateable && feed.goalHits !== undefined ? `${feed.goalHits} of ${feed.graded}` : undefined}
          hint="How often a curated alert went on to 4x within the hour - the goal behind the 15-minute bar."
        />
      )}
      <Stat
        label="Best call"
        value={feed.bestPeak24hReturnPct !== null ? `+${feed.bestPeak24hReturnPct.toFixed(0)}%` : "—"}
        hint="Highest 24h peak of any curated alert."
      />
      {feed.pace ? (
        <Stat
          label="Pace (24h)"
          value={`${feed.pace.actualPerHour24h.toFixed(1)}/hr`}
          sub={`ceiling ${feed.pace.targetPerHour}/hr`}
          hint={`${feed.pace.alerts24h.toLocaleString()} alerts in the last day against a ceiling of ${feed.pace.targetPerHour}/hr - about one every ${Math.round(60 / feed.pace.targetPerHour)} minutes. A pace, not a quota: only the strongest of what qualifies is emitted, and a dead hour emits nothing. ${feed.alerts7d.toLocaleString()} this week, ${feed.alertsTotal.toLocaleString()} in total.`}
        />
      ) : (
        <Stat
          label="Alerts (7d)"
          value={feed.alerts7d.toLocaleString()}
          hint={`${feed.alertsTotal.toLocaleString()} in total.`}
        />
      )}
      <button
        type="button"
        className={`scoreboard__phase ${modelLive ? "scoreboard__phase--live" : ""}`}
        onClick={onPhaseClick}
        title={
          modelLive
            ? `A model trained on this pipeline's own recorded outcomes is picking - it earned the job by beating the hand-tuned gate on held-out history, and retrains every 4 hours.${curator.modelTrainedAt ? ` Trained on data through ${new Date(curator.modelTrainedAt).toLocaleDateString()}.` : ""} Tap for the full story.`
            : `A hand-tuned quality gate is picking while the model learns. ${training.finalizedSamples.toLocaleString()} outcomes graded so far (+${training.samples7d.toLocaleString()} this week); it takes over automatically once it beats the gate on held-out history.${curator.latestEvaluation?.verdict ? ` Latest check: ${curator.latestEvaluation.verdict.reason}.` : ""} Tap for the full story.`
        }
      >
        {modelLive ? "Model picking" : "Learning"}
      </button>
    </section>
  );
}

/**
 * The fuller writeup behind the phase badge - openable from the badge itself (see explainerOpen),
 * since a tooltip is easy to miss on mobile and this is worth reading once. Ends with an
 * explicit experimental warning: this whole self-learning half of the pipeline is new, trained on
 * a small and volatile market, and its backtest numbers describe the past, not a promise.
 */
function TrainingExplainer({
  stats,
  open,
  onToggle,
}: {
  stats: CuratedStats;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const { curator, training, comparison30d } = stats;
  const modelLive = curator.phase === "model-live";
  const showComparison =
    comparison30d && (comparison30d.heuristic.graded > 0 || comparison30d.model.graded > 0);
  return (
    <details
      className="training-explainer"
      open={open}
      onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}
    >
      <summary className="training-explainer__summary">How does the model training work?</summary>
      <div className="training-explainer__body">
        <p>
          Every candidate that clears the rug screen - not just the ones that get curated - has its outcome
          quietly tracked: did it 2x within 15 minutes without first dropping 50%, and how far did it run by
          the hour. That record is the training set, and both halves count. A call is only a win if it doubled
          <em> fast</em> - a token that took 40 minutes to double trains as a miss, because a slow grind is the
          hardest thing to actually trade - and a win is then worth more the closer it came to 4x. So the model
          is pulled toward one specific shape: doubles quickly, keeps running. Every 4 hours it retrains on
          that record and is walk-forward tested against the hand-tuned gate currently picking - trained on the
          past, graded on a slice of history it never saw, the way a real deployment would be judged.
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
          <div className="training-explainer__comparison">
            {/* A table, not a sentence: this is the product's most checkable claim - two curators
                graded live on the same bar - and Picks vs Graded is what makes the rate honest
                (a 60% rate on 8 graded picks out of 300 emitted is a different fact entirely). */}
            <table className="curator-compare">
              <thead>
                <tr>
                  <th scope="col">Last 30 days</th>
                  <th scope="col">Picks</th>
                  <th scope="col">Graded</th>
                  <th scope="col">Hit rate</th>
                </tr>
              </thead>
              <tbody>
                <tr className={!modelLive ? "curator-compare__live" : undefined}>
                  <th scope="row">
                    Hand-tuned gate
                    {!modelLive && <span className="curator-compare__badge">picking now</span>}
                  </th>
                  <td>{comparison30d.heuristic.emitted.toLocaleString()}</td>
                  <td>{comparison30d.heuristic.graded.toLocaleString()}</td>
                  <td>
                    {comparison30d.heuristic.hitRatePct !== null
                      ? `${comparison30d.heuristic.hitRatePct.toFixed(0)}%`
                      : "—"}
                  </td>
                </tr>
                <tr className={modelLive ? "curator-compare__live" : undefined}>
                  <th scope="row">
                    Model
                    {modelLive && <span className="curator-compare__badge">picking now</span>}
                  </th>
                  <td>{comparison30d.model.emitted.toLocaleString()}</td>
                  <td>{comparison30d.model.graded.toLocaleString()}</td>
                  <td>
                    {comparison30d.model.hitRatePct !== null
                      ? `${comparison30d.model.hitRatePct.toFixed(0)}%`
                      : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="curator-compare__note">
              Graded in production - live picks and shadow picks together, against the same bar.
            </p>
          </div>
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

/**
 * One scoreboard tile. A button, because the explanation has to be reachable by tap: the title
 * attribute serves desktop hover, and clicking toggles the same text as a popover for everyone
 * else. Blur closes it, so tapping elsewhere never leaves a stray bubble open.
 */
function Stat({
  label,
  value,
  sub,
  hint,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  hint: string;
  tone?: "good" | "bad";
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="scoreboard__stat">
      <button
        type="button"
        className="scoreboard__stat-button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        aria-expanded={open}
        title={hint}
      >
        <span className="scoreboard__value" data-tone={tone}>
          {value}
        </span>
        <span className="scoreboard__label">{label}</span>
        {sub && <span className="scoreboard__sub">{sub}</span>}
      </button>
      {open && (
        <span className="scoreboard__popover" role="note">
          {hint}
        </span>
      )}
    </div>
  );
}
