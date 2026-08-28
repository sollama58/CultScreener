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
 *     must render identically. PumpScroll previously had neither on its thumbnail, so a failed
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
  const releaseRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (!src) return;
    setStarted(false);
    setFailed(false);
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
    };
  }, [src]);

  const settle = () => {
    releaseRef.current?.();
    releaseRef.current = undefined;
  };

  if (!src || failed) {
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
      src={started ? src : undefined}
      alt=""
      decoding="async"
      onLoad={settle}
      onError={() => {
        settle();
        setFailed(true);
      }}
    />
  );
}
