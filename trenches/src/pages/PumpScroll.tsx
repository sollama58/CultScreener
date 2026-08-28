import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listCurated, listMatches, openCuratedStream, openMatchesStream } from "../api/client";
import { usePreferences, type ScrollSource } from "../context/PreferencesContext";
import { proxiedImageUrl } from "../api/images";
import type { Match } from "../api/types";

/**
 * PumpScroll - the alert feed as a deck instead of a page.
 *
 * The Live Feed answers "what has fired lately"; this answers "what should I look at RIGHT NOW".
 * One alert fills the screen, newest first, and everything older than the staleness window is
 * simply not in the deck - a token that first alerted twenty minutes ago is a different trade
 * from the one the alert described, and showing it anyway is how a scroll feed turns into a
 * backlog.
 *
 * Vertical paging is native CSS scroll-snap rather than a JS carousel: the browser's own
 * momentum, rubber-banding and accessibility behaviour are better than anything reimplemented on
 * top of pointer events, and it keeps the deck usable with a trackpad, a scrollbar or a screen
 * reader. Only the HORIZONTAL gesture is handled here, because nothing native does it.
 */

/** Where a swipe takes you. Both take the raw mint, same as the card's quick links. */
const VENUES = {
  right: {
    id: "pumpfun" as const,
    label: "PumpFun",
    href: (mint: string) => `https://pump.fun/coin/${mint}`,
  },
  left: {
    id: "fomo" as const,
    label: "FOMO",
    href: (mint: string) => `https://fomo.family/tokens/solana/${mint}`,
  },
};

/**
 * How far a horizontal drag must travel before it counts. Deliberately generous - a swipe here
 * both opens a venue and advances the deck, so an accidental one costs you the alert you were
 * reading. Paired with the undo affordance for when it happens anyway.
 */
const SWIPE_COMMIT_PX = 96;
/** Below this, a horizontal drag is treated as an intent to scroll vertically instead. */
const SWIPE_DIRECTION_LOCK_PX = 12;

interface DeckCard {
  match: Match;
  key: string;
  /** Past the staleness window, but retained because it is the card being read - see `deck`. */
  expired: boolean;
}

export function PumpScroll({ onGoToSettings }: { onGoToSettings: () => void }) {
  const { prefs, update } = usePreferences();
  const [source, setSource] = useState<ScrollSource>(prefs.scrollSource);
  const [alerts, setAlerts] = useState<Match[]>([]);
  const [queued, setQueued] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Re-rendered on a ticker so the staleness cutoff and the age readouts stay live. */
  const [now, setNow] = useState(() => Date.now());

  const staleMs = prefs.scrollStaleMinutes * 60_000;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const fetchAlerts = useCallback(async (which: ScrollSource): Promise<Match[]> => {
    // "both" is exactly what the Live Feed's own interleave returns, so it is one request; the
    // curated-only case has its own endpoint. Page 1 only - anything past the first page is
    // older than any sane staleness window.
    if (which === "curated") return (await listCurated(1)).alerts;
    return (await listMatches(1, which === "both")).matches;
  }, []);

  /** The deck as it currently stands, for the stream and poll callbacks to compare against
   *  without reaching into a state updater to do it. */
  const alertsRef = useRef<Match[]>([]);
  alertsRef.current = alerts;

  const load = useCallback(
    async (which: ScrollSource, opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setLoading(true);
      try {
        const next = await fetchAlerts(which);
        // A reload is a deliberate act (opening the tab, switching source, tapping the pill), so
        // it replaces the deck outright and clears anything queued behind it.
        setAlerts(next);
        setQueued([]);
        setError(null);
      } catch {
        setError("Could not load alerts. Retrying on the next one.");
      } finally {
        if (!opts.silent) setLoading(false);
      }
    },
    [fetchAlerts],
  );

  useEffect(() => {
    void load(source);
  }, [load, source]);

  // The staleness cutoff is a function of wall-clock time, so the deck has to re-evaluate itself
  // even when nothing arrives. Ten seconds is fine enough for a minute-resolution readout and
  // cheap enough to leave running.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  /**
   * New alerts land in a queue rather than in the deck. Injecting them live would move the deck
   * under the reader's thumb mid-swipe - the one thing a full-screen gesture surface must never
   * do - so they wait behind a pill the reader taps when they're ready.
   */
  useEffect(() => {
    const streams: EventSource[] = [];
    const onNudge = async () => {
      try {
        const fresh = await fetchAlerts(sourceRef.current);
        const known = new Set(alertsRef.current.map((m) => m.id));
        if (fresh.some((m) => !known.has(m.id))) setQueued(fresh);
      } catch {
        // A missed nudge is a non-event: the poll below picks the same alerts up shortly.
      }
    };

    if (source !== "curated") {
      const s = openMatchesStream();
      if (s) {
        s.addEventListener("match", () => void onNudge());
        streams.push(s);
      }
    }
    if (source !== "matches") {
      const s = openCuratedStream();
      if (s) {
        s.addEventListener("curated", () => void onNudge());
        streams.push(s);
      }
    }
    return () => streams.forEach((s) => s.close());
  }, [fetchAlerts, source]);

  // The fallback the streams are explicitly not trusted to replace - same contract as the Live
  // Feed's. Silent, so it never flashes the loading state over a deck someone is reading.
  useEffect(() => {
    const id = window.setInterval(() => {
      void (async () => {
        try {
          const fresh = await fetchAlerts(sourceRef.current);
          const known = new Set(alertsRef.current.map((m) => m.id));
          if (fresh.some((m) => !known.has(m.id))) setQueued(fresh);
        } catch {
          /* handled on the next tick */
        }
      })();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [fetchAlerts]);

  /**
   * Which card is centred. Owned here rather than in the deck because the deck's own membership
   * depends on it - see the retention below.
   */
  const [activeKey, setActiveKey] = useState("");

  /**
   * The deck: newest first, nothing past the staleness window - with one exception. The card the
   * reader is currently on is KEPT even once it ages out, marked expired, and drops away only
   * once they have moved off it.
   *
   * Without that exception the ticker deletes whatever you are reading the moment it turns
   * eleven minutes old, and scroll-snap jumps you somewhere else mid-sentence - the exact
   * under-the-thumb movement that queueing new arrivals exists to prevent. Stale cards sit at the
   * BOTTOM of a newest-first deck, so retaining one never shifts anything above it.
   */
  const deck = useMemo<DeckCard[]>(() => {
    const isFresh = (m: Match) => now - new Date(m.matchedAt).getTime() <= staleMs;
    const fresh = alerts.filter(isFresh);
    const retained =
      activeKey && !fresh.some((m) => m.id === activeKey)
        ? alerts.find((m) => m.id === activeKey)
        : undefined;
    return [...fresh, ...(retained ? [retained] : [])]
      .sort((a, b) => new Date(b.matchedAt).getTime() - new Date(a.matchedAt).getTime())
      .map((m) => ({ match: m, key: m.id, expired: !isFresh(m) }));
  }, [alerts, now, staleMs, activeKey]);

  const queuedCount = useMemo(() => {
    if (queued.length === 0) return 0;
    const known = new Set(alerts.map((m) => m.id));
    return queued.filter((m) => !known.has(m.id) && now - new Date(m.matchedAt).getTime() <= staleMs)
      .length;
  }, [queued, alerts, now, staleMs]);

  const changeSource = (next: ScrollSource) => {
    setSource(next);
    update({ scrollSource: next }); // remembered, so the tab opens where you left it
  };

  /**
   * The deck fills whatever the shell leaves below it, measured rather than assumed. A constant
   * here is wrong on every viewport but the one it was written on: this app is embedded under a
   * site header whose height varies with breakpoint, wrapping and the nav's own state, and being
   * a few pixels out pushes the action buttons off a phone screen entirely.
   */
  const pageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top;
      // A small breathing gap under the deck so it never sits flush against the viewport edge.
      const height = Math.max(420, window.innerHeight - top - 16);
      el.style.height = `${height}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    // The header above can reflow without the window resizing (wallet pill, nav wrap), which
    // moves our top edge - so watch the document too.
    const observer = new ResizeObserver(fit);
    observer.observe(document.body);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="scroll-page" ref={pageRef}>
      <header className="scroll-page__bar">
        <div className="scroll-source" role="group" aria-label="Which alerts to play">
          {(
            [
              ["matches", "My Filters"],
              ["curated", "Curated"],
              ["both", "Both"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`scroll-source__btn ${source === id ? "scroll-source__btn--on" : ""}`}
              aria-pressed={source === id}
              onClick={() => changeSource(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="scroll-page__stale" onClick={onGoToSettings}>
          last {prefs.scrollStaleMinutes}m
        </button>
      </header>

      {queuedCount > 0 && (
        <button type="button" className="scroll-new-pill" onClick={() => void load(source, { silent: true })}>
          ↑ {queuedCount} new
        </button>
      )}

      {loading && deck.length === 0 && <DeckMessage title="Loading…" />}
      {!loading && error && deck.length === 0 && <DeckMessage title={error} />}
      {!loading && !error && deck.length === 0 && (
        <DeckMessage
          title="Nothing in the last few minutes"
          body={`The deck only holds alerts from the last ${prefs.scrollStaleMinutes} ${prefs.scrollStaleMinutes === 1 ? "minute" : "minutes"}, so it empties out on quiet stretches. New ones appear here the moment they fire.`}
          action={{ label: "Change the window", onClick: onGoToSettings }}
        />
      )}

      {deck.length > 0 && <Deck cards={deck} now={now} activeKey={activeKey} onActiveChange={setActiveKey} />}
    </div>
  );
}

function DeckMessage({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="scroll-empty">
      <p className="scroll-empty__title">{title}</p>
      {body && <p className="scroll-empty__body">{body}</p>}
      {action && (
        <button type="button" className="btn" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * The paging surface. Vertical movement is the browser's (scroll-snap); this only tracks which
 * card is centred, so the keyboard shortcuts and the action bar act on what you're actually
 * looking at.
 */
function Deck({
  cards,
  now,
  activeKey,
  onActiveChange,
}: {
  cards: DeckCard[];
  now: number;
  activeKey: string;
  onActiveChange: (key: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  /** The last swipe, so a mis-swipe can be walked back rather than losing the alert. */
  const [undo, setUndo] = useState<{ key: string; venue: string } | null>(null);

  // Auto-dismissed: it is a safety net for a mis-swipe, not a status bar. Left up it would sit
  // over the next alert's action buttons.
  useEffect(() => {
    if (!undo) return;
    const id = window.setTimeout(() => setUndo(null), 6_000);
    return () => window.clearTimeout(id);
  }, [undo]);

  // Which card is centred, via IntersectionObserver rather than scroll math: it survives
  // momentum, rubber-banding and a resized viewport without a single magic number.
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            const key = (entry.target as HTMLElement).dataset.key;
            if (key) onActiveChange(key);
          }
        }
      },
      { root, threshold: [0.6] },
    );
    for (const el of cardRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [cards, onActiveChange]);

  useEffect(() => {
    if (!activeKey && cards[0]) onActiveChange(cards[0].key);
  }, [activeKey, cards, onActiveChange]);

  const goTo = useCallback((key: string) => {
    // Someone who has asked their OS for less motion should not be given a smooth-scrolling
    // carousel; jumping straight there is the honest reading of that preference.
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    cardRefs.current
      .get(key)
      ?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, []);

  const advance = useCallback(
    (fromKey: string) => {
      const index = cards.findIndex((c) => c.key === fromKey);
      const next = cards[index + 1];
      if (next) goTo(next.key);
    },
    [cards, goTo],
  );

  /**
   * Acting on an alert opens the venue and moves the deck on - the triage rhythm this view is
   * for. window.open is called synchronously inside the gesture/key handler so it counts as a user
   * activation and isn't swallowed by the popup blocker.
   */
  const act = useCallback(
    (card: DeckCard, direction: "left" | "right") => {
      const venue = VENUES[direction];
      window.open(venue.href(card.match.token.mintAddress), "_blank", "noopener,noreferrer");
      setUndo({ key: card.key, venue: venue.label });
      advance(card.key);
    },
    [advance],
  );

  // Desktop parity: the whole view is a gesture surface on a phone, and a keyboard everywhere
  // else. Arrow up/down page the deck, left/right act on the centred card.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The source switcher and the staleness button live in the bar above the deck. Arrow keys
      // there belong to whoever is tabbing through them, not to the deck.
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, select, textarea, .scroll-page__bar")) return;
      const card = cards.find((c) => c.key === activeKey);
      if (!card) return;
      const index = cards.indexOf(card);
      if (event.key === "ArrowRight") {
        event.preventDefault();
        act(card, "right");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        act(card, "left");
      } else if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        if (cards[index + 1]) goTo(cards[index + 1]!.key);
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        if (cards[index - 1]) goTo(cards[index - 1]!.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, activeKey, cards, goTo]);

  return (
    <>
      <div className="scroll-deck" ref={scrollerRef}>
        {cards.map((card) => (
          <ScrollCard
            key={card.key}
            card={card}
            now={now}
            isFirst={card.key === cards[0]?.key}
            onAct={(direction) => act(card, direction)}
            register={(el) => {
              if (el) cardRefs.current.set(card.key, el);
              else cardRefs.current.delete(card.key);
            }}
          />
        ))}
      </div>

      {undo && (
        <div className="scroll-undo" role="status">
          <span>Opened on {undo.venue}</span>
          <button
            type="button"
            onClick={() => {
              goTo(undo.key);
              setUndo(null);
            }}
          >
            Back to it
          </button>
          <button type="button" aria-label="Dismiss" onClick={() => setUndo(null)}>
            ✕
          </button>
        </div>
      )}
    </>
  );
}

/** Compact money, because a full-bleed card has room for one number, not eleven digits. */
function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return `$${value.toFixed(0)}`;
}

function ageLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

/**
 * One full-screen alert, and the only place the horizontal gesture lives.
 *
 * Direction is locked on the first meaningful movement: past SWIPE_DIRECTION_LOCK_PX horizontally
 * the card takes the gesture and suppresses the browser's own panning (touch-action is set in
 * CSS); otherwise the finger belongs to the scroller and this never interferes. Without that
 * lock, every attempt to scroll the deck would drag the card sideways a little, which reads as
 * broken even when nothing commits.
 */
function ScrollCard({
  card,
  now,
  isFirst,
  onAct,
  register,
}: {
  card: DeckCard;
  now: number;
  isFirst: boolean;
  onAct: (direction: "left" | "right") => void;
  register: (el: HTMLElement | null) => void;
}) {
  const { match } = card;
  const [dragX, setDragX] = useState(0);
  /** The same value as dragX, but readable synchronously. The pointerup handler closes over the
   *  LAST RENDER's dragX, so a gesture whose final move and release land in the same frame would
   *  otherwise be judged on a stale offset - and silently not commit. */
  const dragRef = useRef(0);
  const gesture = useRef<{ id: number; startX: number; startY: number; locked: boolean } | null>(null);

  const commit = Math.abs(dragX) >= SWIPE_COMMIT_PX;
  const direction: "left" | "right" | null = dragX === 0 ? null : dragX > 0 ? "right" : "left";

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    // Mouse wheels and trackpads scroll; only a real press starts a swipe.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    gesture.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, locked: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;

    if (!g.locked) {
      // Vertical intent wins ties: this is a scroll feed first and a gesture surface second.
      if (Math.abs(dy) > Math.abs(dx)) {
        gesture.current = null;
        return;
      }
      if (Math.abs(dx) < SWIPE_DIRECTION_LOCK_PX) return;
      g.locked = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    // Resisted past the commit point so the card cannot be flung off-screen, and so the gesture
    // keeps telling you it has already done its job.
    const overshoot = Math.max(0, Math.abs(dx) - SWIPE_COMMIT_PX);
    const eased = Math.sign(dx) * (Math.min(Math.abs(dx), SWIPE_COMMIT_PX) + overshoot * 0.25);
    dragRef.current = eased;
    setDragX(eased);
  };

  const endGesture = (event: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const committed = Math.abs(dragRef.current) >= SWIPE_COMMIT_PX;
    const dir: "left" | "right" = dragRef.current > 0 ? "right" : "left";
    dragRef.current = 0;
    setDragX(0);
    if (committed) onAct(dir);
  };

  const ageMs = now - new Date(match.matchedAt).getTime();
  const mcapNow = match.currentMarketCapUsd ?? match.latestSnapshot?.marketCapUsd ?? null;
  const mcapAlert = match.snapshot.marketCapUsd;
  const changePct = mcapNow !== null && mcapAlert > 0 ? ((mcapNow - mcapAlert) / mcapAlert) * 100 : null;
  const isCurated = match.kind === "curated";
  // Both the backdrop and the thumbnail come from the same proxied URL, so the browser fetches
  // the bytes once and reuses them for the second element.
  const artUrl = proxiedImageUrl(match.token.imageUrl);
  const symbol = match.token.symbol ?? match.token.mintAddress.slice(0, 4);

  return (
    <article
      className={`scroll-card ${card.expired ? "scroll-card--expired" : ""}`}
      data-key={card.key}
      ref={register}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      style={{ ["--drag-x" as string]: `${dragX}px`, ["--drag-progress" as string]: Math.min(1, Math.abs(dragX) / SWIPE_COMMIT_PX) }}
    >
      {/* The two venues, revealed by the drag itself rather than sitting on top of the art. */}
      <div className={`scroll-card__venue scroll-card__venue--left ${direction === "left" ? "is-shown" : ""} ${commit && direction === "left" ? "is-armed" : ""}`}>
        <span className="scroll-card__venue-name">{VENUES.left.label}</span>
        <span className="scroll-card__venue-hint">{commit ? "release to open" : "keep swiping"}</span>
      </div>
      <div className={`scroll-card__venue scroll-card__venue--right ${direction === "right" ? "is-shown" : ""} ${commit && direction === "right" ? "is-armed" : ""}`}>
        <span className="scroll-card__venue-name">{VENUES.right.label}</span>
        <span className="scroll-card__venue-hint">{commit ? "release to open" : "keep swiping"}</span>
      </div>

      <div className="scroll-card__body">
        {/* The token's own art, as the card's backdrop. An <img> rather than a CSS
            background-image on purpose: the URL is third-party data from the token's metadata,
            and an element attribute cannot escape into the stylesheet the way an interpolated
            url() can. Heavily blurred and scrimmed below - the art sets the mood, the numbers
            still have to be readable at a glance. A token with no artwork (most of this band)
            simply falls back to the flat surface. */}
        {artUrl && (
          <>
            <img
              className="scroll-card__bg"
              src={artUrl}
              alt=""
              aria-hidden="true"
              loading="lazy"
              /* A dead image URL would otherwise leave the alt box and a broken-image glyph
                 sitting behind the text. */
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
            <span className="scroll-card__scrim" aria-hidden="true" />
          </>
        )}
        <div className="scroll-card__head">
          <span className={`scroll-card__badge ${isCurated ? "scroll-card__badge--curated" : ""}`}>
            {isCurated ? "★ Curated" : (match.filter?.name ?? "My filter")}
          </span>
          <span className="scroll-card__age">
            {card.expired ? "expired" : ageLabel(ageMs)}
          </span>
        </div>

        <div className="scroll-card__main">
        <div className="scroll-card__identity">
          {artUrl ? (
            <img className="scroll-card__art" src={artUrl} alt="" loading="lazy" />
          ) : (
            <span className="scroll-card__art scroll-card__art--blank" aria-hidden="true">
              {symbol.slice(0, 2).toUpperCase()}
            </span>
          )}
          <div className="scroll-card__names">
            <h2 className="scroll-card__symbol">{symbol}</h2>
            {match.token.name && <p className="scroll-card__name">{match.token.name}</p>}
          </div>
        </div>

        <div className="scroll-card__mcap">
          <span className="scroll-card__mcap-value">{money(mcapNow ?? mcapAlert)}</span>
          {changePct !== null && (
            <span className={`scroll-card__delta ${changePct >= 0 ? "is-up" : "is-down"}`}>
              {changePct >= 0 ? "+" : ""}
              {changePct.toFixed(0)}% since alert
            </span>
          )}
        </div>

        <dl className="scroll-card__stats">
          <Stat label="At alert" value={money(mcapAlert)} />
          <Stat label="Liquidity" value={money(match.snapshot.liquidityUsd)} />
          <Stat label="24h vol" value={money(match.snapshot.volume24hUsd)} />
          <Stat
            label="Age"
            value={
              match.snapshot.ageMinutes === null || match.snapshot.ageMinutes === undefined
                ? "—"
                : match.snapshot.ageMinutes < 60
                  ? `${Math.round(match.snapshot.ageMinutes)}m`
                  : `${(match.snapshot.ageMinutes / 60).toFixed(1)}h`
            }
          />
        </dl>

        {isCurated && match.curated?.reasons?.length ? (
          <ul className="scroll-card__reasons">
            {match.curated.reasons.slice(0, 3).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
        </div>

        {/* Shown once, on the very first card: the action buttons already teach left and right
            (their labels carry the arrows), but nothing otherwise says the deck goes vertically. */}
        {isFirst && (
          <p className="scroll-card__hint" aria-hidden="true">
            Swipe up for the next alert
          </p>
        )}
      </div>

      {/* Real buttons, not just a gesture: this is the whole interaction on a desktop, and it is
          the accessible path everywhere. */}
      <div className="scroll-card__actions">
        <button type="button" className="scroll-action scroll-action--left" onClick={() => onAct("left")}>
          <span aria-hidden="true">←</span> {VENUES.left.label}
        </button>
        <button type="button" className="scroll-action scroll-action--right" onClick={() => onAct("right")}>
          {VENUES.right.label} <span aria-hidden="true">→</span>
        </button>
      </div>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="scroll-card__stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
