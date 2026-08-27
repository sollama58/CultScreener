/**
 * Hands out permission to start loading an image, a few at a time.
 *
 * A page of twelve cards would otherwise fire twelve image requests the instant it renders, and
 * these are not one host: Pump.fun's image_uri points at whichever IPFS gateway the token was
 * minted through (ipfs.io, pinata, filebase, ...). Public gateways are exactly the kind of thing
 * that answers a burst with a 429 or a dropped connection, and a dropped image is invisible - the
 * card just falls back to initials, so it reads as "some images don't work" rather than as
 * throttling.
 *
 * Deliberately a browser-side queue rather than anything routed through the API. The images are
 * fetched over the viewer's own connection, straight from the gateway, which keeps them off the
 * backend entirely and means one busy viewer cannot slow anyone else down.
 */

/** Small enough to look polite to a public gateway, large enough that a page fills promptly. */
const MAX_CONCURRENT = 3;

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
