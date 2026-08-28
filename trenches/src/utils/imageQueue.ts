/**
 * Hands out permission to start loading an image, a few at a time.
 *
 * A page of twelve cards would otherwise fire twelve image requests the instant it renders, and a
 * burst like that is what a browser answers by queueing anyway - just without any say in which
 * images win. Doing it here means the ones on screen go first.
 *
 * What this is NOT any more: protection from public IPFS gateways. Artwork used to be fetched
 * straight from whichever gateway a token was minted through, and this queue existed to keep a
 * burst from drawing a 429. Every image now goes through the site's own proxy instead, which
 * caches across all visitors and de-dupes concurrent requests for the same URL server-side, so
 * the gateway sees one fetch however many people are looking.
 */

/**
 * Sized for our own proxy rather than for a stranger's gateway - which is why it is no longer 3.
 * The endpoint's rate limit is 150/minute per IP and a warm cache answers immediately, so the
 * old value was leaving a deck filling one card at a time for no remaining reason.
 */
const MAX_CONCURRENT = 6;

/** Nothing is allowed to hold a slot forever - a gateway that accepts a connection and then goes
 *  quiet would otherwise stall every image behind it. */
const SLOT_TIMEOUT_MS = 10_000;

let active = 0;
const waiting: (() => void)[] = [];

function pump(): void {
  while (active < MAX_CONCURRENT && waiting.length > 0) {
    const next = waiting.shift()!;
    active += 1;
    next();
  }
}

/**
 * Resolves when it is this caller's turn to start loading. The returned function must be called
 * once the image has settled (loaded or failed) to release the slot; calling it more than once is
 * harmless.
 */
export function acquireImageSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const start = () => {
      let released = false;
      const timer = setTimeout(() => release(), SLOT_TIMEOUT_MS);
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        active -= 1;
        pump();
      };
      resolve(release);
    };

    waiting.push(start);
    pump();
  });
}

/** Test seam: how many loads are in flight and how many are queued behind them. */
export function imageQueueState(): { active: number; waiting: number } {
  return { active, waiting: waiting.length };
}
