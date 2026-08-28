import { HealthBadge } from "./HealthBadge";
import { useFeedStatus } from "../context/FeedStatusContext";
import { useNow } from "../utils/useNow";

/**
 * The Live Feed's freshness, rendered in the app bar rather than on the page.
 *
 * It sits here because it answers a question about the app as a whole - is data still arriving? -
 * which the page heading it used to live under did not. Pinned to the bar it also stops moving:
 * previously it sat below the tab strip, repeating the tab's own name beside it.
 *
 * Nothing renders when no feed is reporting, so every other tab gets its space back.
 */
export function FeedStatus() {
  const { status } = useFeedStatus();
  if (!status) return null;

  return (
    <div className="feed-status">
      <HealthBadge streamConnected={status.streamConnected} />
      {/* Detail is dropped progressively as the bar narrows - see the CSS. The timestamp is the
          first to go, because the countdown answers "is this current?" in fewer characters. */}
      <span className="feed-status__detail">
        {status.lastUpdated && (
          <span className="feed-status__updated">Updated {status.lastUpdated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        )}
        <RefreshCountdown at={status.nextRefreshAt} />
      </span>
    </div>
  );
}

/**
 * How long until the feed next refreshes its figures.
 *
 * Worth showing because "Live" answers a different question than people read into it: the badge
 * is about the scanner still running, while the market caps on the cards move on this timer.
 * Without it a number that hasn't changed for half a minute is ambiguous between "nothing
 * happened" and "nothing has been fetched".
 *
 * Alerts are not on this clock - they arrive over the push stream the moment they exist, which is
 * what the badge's pulsing dot indicates. This is only about the periodic refresh of the figures.
 */
function RefreshCountdown({ at }: { at: number | null }) {
  const now = useNow();
  if (at === null) return null;

  const secondsLeft = Math.max(0, Math.ceil((at - now) / 1000));
  return (
    <span
      className="feed-status__countdown"
      title="Market caps and other figures refresh on this timer. New alerts don't wait for it - they're pushed as soon as they happen."
    >
      {secondsLeft === 0 ? "refreshing…" : `next in ${secondsLeft}s`}
    </span>
  );
}
