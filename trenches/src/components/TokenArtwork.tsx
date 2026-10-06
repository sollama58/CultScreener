import { useEffect, useRef, useState } from "react";
import { acquireImageSlot } from "../utils/imageQueue";

/**
 * A token's artwork, or its initials.
 *
 * Every view that shows token art needs the same three things, and getting any of them wrong looks
 * like a broken site rather than a missing picture:
 *
 *  1. A fallback that covers BOTH "this token has no artwork" (common - most of this band never
 *     gets any) and "it has a URL that did not load". Those are indistinguishable to a user and
 *     must render identically. PumpTok previously had neither on its thumbnail, so a failed
 *     load left the browser's broken-image glyph in the middle of a full-screen card.
 *  2. A queue, so a screenful of cards does not fire a dozen simultaneous requests.
 *  3. The slot released the moment the image settles - not when the component unmounts - or only
 *     MAX_CONCURRENT images ever appear and the rest sit until their timeout.
 *
 * Shared rather than copied because the failure modes above were found one view at a time.
 */
export function TokenArtwork({
  src,
  label,
  className,
  fallbackClassName,
}: {
  src?: string | null;
  label: string;
  className: string;
  /** Applied alongside `className` on the initials tile, for per-view styling of the fallback. */
  fallbackClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(false);
  // 0: first load. "waiting": the first load failed and a retry is scheduled (initials shown
  // meanwhile). 1: the retry is loading. See onError below.
  const [attempt, setAttempt] = useState<0 | "waiting" | 1>(0);
  const releaseRef = useRef<(() => void) | undefined>(undefined);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!src) return;
    setStarted(false);
    setFailed(false);
    setAttempt(0);
    let cancelled = false;

    void acquireImageSlot().then((release) => {
      // Unmounted, or re-rendered onto a different token, while queued: give the slot straight
      // back rather than letting a load nobody is waiting for hold it.
      if (cancelled) {
        release();
        return;
      }
      releaseRef.current = release;
      setStarted(true);
    });

    return () => {
      cancelled = true;
      releaseRef.current?.();
      releaseRef.current = undefined;
      clearTimeout(retryTimerRef.current);
    };
  }, [src]);

  const settle = () => {
    releaseRef.current?.();
    releaseRef.current = undefined;
  };

  if (!src || failed || attempt === "waiting") {
    return (
      <span className={`${className} ${fallbackClassName ?? ""}`.trim()} aria-hidden="true">
        {label.slice(0, 2).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      className={className}
      // Rendered from the start so the box reserves its space, but with no src until the queue
      // releases it - an <img> with no src requests nothing.
      src={started ? (attempt === 1 ? `${src}&retry=1` : src) : undefined}
      alt=""
      decoding="async"
      onLoad={settle}
      onError={() => {
        settle();
        // A proxied image usually fails for a passing reason (a 429 while a page loads many at
        // once, or the proxy's upstream timing out on a cold cache), so it gets one jittered
        // retry before the initials become final. retry=1 also makes the proxy skip a remembered
        // transient failure, and keeps the browser from replaying the failed response.
        if (attempt === 0 && src.includes("/api/image-proxy")) {
          setAttempt("waiting");
          retryTimerRef.current = setTimeout(() => setAttempt(1), 1500 + Math.random() * 2500);
          return;
        }
        setFailed(true);
      }}
    />
  );
}
