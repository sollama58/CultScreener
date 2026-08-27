import {
  AGE_MAX_MINUTES,
  AGE_MIN_MINUTES,
  CHANGE_MAX_PCT,
  CHANGE_MIN_PCT,
  DEFAULT_FEED_FILTER,
  formatAgeBound,
  formatChangeBound,
  isDefaultFilter,
  type FeedFilter,
} from "../utils/feedFilter";

interface FeedFilterBarProps {
  filter: FeedFilter;
  onChange: (filter: FeedFilter) => void;
  /** Cards currently on screen vs. cards this page holds - the filter's own receipt. */
  shown: number;
  total: number;
}

/**
 * The Live Feed's display filter: two range sliders over what is already on screen.
 *
 * Collapsed to a single row on purpose - it sits above a feed people are watching, so it has to
 * stay out of the way. The count on the right is the important part: a filter that silently
 * empties a feed is indistinguishable from a broken feed, so it always says what it is hiding
 * and offers one click to stop.
 */
export function FeedFilterBar({ filter, onChange, shown, total }: FeedFilterBarProps) {
  const active = !isDefaultFilter(filter);
  const hidden = total - shown;

  // Handles cannot cross: dragging one past the other pushes it, which is what a range control
  // is expected to do and avoids an inverted range that matches nothing.
  const set = (patch: Partial<FeedFilter>) => {
    const next = { ...filter, ...patch };
    if (patch.minAgeMinutes !== undefined) next.maxAgeMinutes = Math.max(next.maxAgeMinutes, next.minAgeMinutes);
    if (patch.maxAgeMinutes !== undefined) next.minAgeMinutes = Math.min(next.minAgeMinutes, next.maxAgeMinutes);
    if (patch.minChangePct !== undefined) next.maxChangePct = Math.max(next.maxChangePct, next.minChangePct);
    if (patch.maxChangePct !== undefined) next.minChangePct = Math.min(next.minChangePct, next.maxChangePct);
    onChange(next);
  };

  return (
    <section className={`feed-filter ${active ? "feed-filter--active" : ""}`}>
      <div className="feed-filter__group">
        <span className="feed-filter__label">
          Time since alert
          <span className="feed-filter__value">
            {formatAgeBound(filter.minAgeMinutes, false)} – {formatAgeBound(filter.maxAgeMinutes, true)}
          </span>
        </span>
        <div className="feed-filter__sliders">
          <input
            type="range"
            aria-label="Minimum time since alert, in minutes"
            min={AGE_MIN_MINUTES}
            max={AGE_MAX_MINUTES}
            step={1}
            value={filter.minAgeMinutes}
            onChange={(e) => set({ minAgeMinutes: Number(e.target.value) })}
          />
          <input
            type="range"
            aria-label="Maximum time since alert, in minutes"
            min={AGE_MIN_MINUTES}
            max={AGE_MAX_MINUTES}
            step={1}
            value={filter.maxAgeMinutes}
            onChange={(e) => set({ maxAgeMinutes: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="feed-filter__group">
        <span className="feed-filter__label">
          Change since alert
          <span className="feed-filter__value">
            {formatChangeBound(filter.minChangePct, false)} – {formatChangeBound(filter.maxChangePct, true)}
          </span>
        </span>
        <div className="feed-filter__sliders">
          <input
            type="range"
            aria-label="Minimum change since alert, in percent"
            min={CHANGE_MIN_PCT}
            max={CHANGE_MAX_PCT}
            step={5}
            value={filter.minChangePct}
            onChange={(e) => set({ minChangePct: Number(e.target.value) })}
          />
          <input
            type="range"
            aria-label="Maximum change since alert, in percent"
            min={CHANGE_MIN_PCT}
            max={CHANGE_MAX_PCT}
            step={5}
            value={filter.maxChangePct}
            onChange={(e) => set({ maxChangePct: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="feed-filter__status">
        <span
          className="feed-filter__count"
          title="This only changes what's displayed - nothing is discarded, and alerts keep arriving as normal."
        >
          {active ? `${shown} of ${total} shown` : `${total} shown`}
          {active && hidden > 0 && <span className="feed-filter__hidden"> · {hidden} hidden</span>}
        </span>
        <button
          className="btn feed-filter__reset"
          onClick={() => onChange(DEFAULT_FEED_FILTER)}
          disabled={!active}
        >
          Reset
        </button>
      </div>
    </section>
  );
}
