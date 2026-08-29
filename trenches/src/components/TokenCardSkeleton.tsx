/**
 * A placeholder in the shape of a TokenCard.
 *
 * The point is layout, not decoration. The feed used to render a single line of text - "Loading
 * matches…" - where a grid of cards was about to appear, so the whole page jumped the moment data
 * landed and everything below it moved.
 *
 * Two rules keep it honest, both learned by measuring rather than by eye:
 *
 *  1. It reuses TokenCard's own container classes - the same `token-card__stats` grid, the same
 *     `token-card__links` row, the same `token-card__mint`. A skeleton with its own geometry looks
 *     right the day it is written and drifts the first time a card gains a stat.
 *  2. The placeholder blocks contain real, representative TEXT, hidden with `color: transparent`
 *     rather than sized with a fixed height. That way every box is exactly as tall as the line it
 *     stands in for, at whatever font size the card happens to use. Hand-set heights were 126px
 *     per card short on the first attempt and 63px short on the second.
 *
 * Marked aria-hidden: the loading state is announced once by the feed's live region, and twelve
 * sets of placeholder text being read out would be worse than silence.
 */
export function TokenCardSkeleton() {
  return (
    <article className="token-card token-card--skeleton" aria-hidden="true">
      <div className="token-card__header">
        <span className="skeleton skeleton--avatar" />
        {/* Name and ticker sit on one line in the real card, not stacked - stacking them made the
            header 12px taller than the card it stands in for. */}
        <span className="skeleton-title">
          <span className="skeleton">Token name</span>
          <span className="skeleton skeleton--sm">$TICK</span>
        </span>
        <span className="skeleton skeleton--score" />
      </div>

      {/* Present, with one badge. The row carries a 12px bottom margin whether or not it holds
          anything, so omitting it made every skeleton that much too short - and nearly every real
          card does have a badge here, because `graduated` is known for almost every token. One is
          the common case: cards with none are 22px shorter, cards with narrative tags on top are
          taller, and no fixed placeholder can be right for both. */}
      <div className="token-card__tags">
        <span className="tag skeleton">Graduated</span>
      </div>

      {/* Mirrors the real grid: two hero stats, four ordinary, one full-width. */}
      <dl className="token-card__stats">
        <SkeletonStat className="token-card__stat--hero" label="Alerted at" value="$000.0k" />
        <SkeletonStat className="token-card__stat--hero" label="Now" value="$000.0k (0%)" />
        <SkeletonStat label="24h volume" value="$000.0k" />
        <SkeletonStat label="Age" value="00m" />
        <SkeletonStat label="Fresh wallets" value="00%" />
        <SkeletonStat label="Empty wallets" value="00%" />
        <SkeletonStat className="token-card__stat--wide" label="Alerted" value="00:00:00" />
      </dl>

      <div className="token-card__links">
        <span className="token-card__links-label skeleton">Quick links</span>
        <span className="token-card__links-row">
          {["PumpFun", "Terminal", "FOMO", "Axiom"].map((label) => (
            <span key={label} className="token-card__link skeleton">
              {label}
            </span>
          ))}
        </span>
      </div>

      <div className="token-card__mint">
        <span className="token-card__mint-text skeleton">
          00000000000000000000000000000000000000000000
        </span>
        <span className="skeleton skeleton--chip skeleton--chip-sm" />
      </div>
    </article>
  );
}

/** One stat cell, using the real dt/dd so it inherits the real line heights and spacing. */
function SkeletonStat({
  className,
  label,
  value,
}: {
  className?: string;
  label: string;
  value: string;
}) {
  return (
    <div className={className}>
      <dt>
        <span className="skeleton">{label}</span>
      </dt>
      <dd>
        <span className="skeleton">{value}</span>
      </dd>
    </div>
  );
}

/**
 * A grid of them. `count` matches the page size so the placeholder grid stands the same height as
 * the page it replaces - a shorter one still makes the page jump, just later.
 */
export function TokenGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="token-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <TokenCardSkeleton key={i} />
      ))}
    </div>
  );
}
