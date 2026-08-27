import { useState } from "react";
import { DualRangeSlider } from "./DualRangeSlider";
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
  /** Cards currently on screen vs. everything the active filter is drawing from. */
  shown: number;
  total: number;
}

/**
 * The Live Feed's display filter: a collapsible panel holding two range sliders over what has
 * already arrived.
 *
 * Closed by default - it sits above a feed people watch all day, so it stays out of the way until
 * asked for. The toggle row itself never disappears, and always reports what the filter (if any)
 * is doing, so a collapsed panel never hides the fact that it's quietly narrowing the feed.
 */
export function FeedFilterBar({ filter, onChange, shown, total }: FeedFilterBarProps) {
  const [open, setOpen] = useState(false);
  const active = !isDefaultFilter(filter);
  const hidden = total - shown;

  return (
    <section className={`feed-filter ${active ? "feed-filter--active" : ""}`}>
      <button
        type="button"
        className="feed-filter__toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="feed-filter__toggle-label">
          <svg
            className={`feed-filter__chevron ${open ? "feed-filter__chevron--open" : ""}`}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          Filters
          {active && <span className="feed-filter__dot" aria-hidden="true" />}
        </span>
        <span
          className="feed-filter__count"
          title="This only changes what's displayed - nothing is discarded, and alerts keep arriving as normal."
        >
          {active ? `${shown} of ${total} shown` : `${total} shown`}
          {active && hidden > 0 && <span className="feed-filter__hidden"> · {hidden} hidden</span>}
        </span>
      </button>

      {open && (
        <div className="feed-filter__panel">
          <div className="feed-filter__group">
            <span className="feed-filter__label">
              Time since alert
              <span className="feed-filter__value">
                {formatAgeBound(filter.minAgeMinutes, false)} – {formatAgeBound(filter.maxAgeMinutes, true)}
              </span>
            </span>
            <DualRangeSlider
              min={AGE_MIN_MINUTES}
              max={AGE_MAX_MINUTES}
              step={1}
              valueMin={filter.minAgeMinutes}
              valueMax={filter.maxAgeMinutes}
              onChange={({ min, max }) => onChange({ ...filter, minAgeMinutes: min, maxAgeMinutes: max })}
              labelMin="Minimum time since alert"
              labelMax="Maximum time since alert"
              formatValue={formatAgeBound}
            />
          </div>

          <div className="feed-filter__group">
            <span className="feed-filter__label">
              Change since alert
              <span className="feed-filter__value">
                {formatChangeBound(filter.minChangePct, false)} – {formatChangeBound(filter.maxChangePct, true)}
              </span>
            </span>
            <DualRangeSlider
              min={CHANGE_MIN_PCT}
              max={CHANGE_MAX_PCT}
              step={5}
              valueMin={filter.minChangePct}
              valueMax={filter.maxChangePct}
              onChange={({ min, max }) => onChange({ ...filter, minChangePct: min, maxChangePct: max })}
              labelMin="Minimum change since alert"
              labelMax="Maximum change since alert"
              formatValue={formatChangeBound}
            />
          </div>

          <button className="btn feed-filter__reset" onClick={() => onChange(DEFAULT_FEED_FILTER)} disabled={!active}>
            Reset
          </button>
        </div>
      )}
    </section>
  );
}
