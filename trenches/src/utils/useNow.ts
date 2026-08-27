import { useEffect, useState } from "react";

/**
 * A clock that ticks once a second, shared by every component that asks for it.
 *
 * One interval for the whole page rather than one per card: twelve cards each running their own
 * timer would drift apart, so the elapsed times on screen would visibly tick at different
 * moments. A single source also means one wakeup per second instead of twelve.
 *
 * The tick is suspended whenever the tab is hidden - a background tab has nothing to redraw, and
 * browsers throttle its timers unpredictably anyway. On becoming visible again the clock is set
 * immediately, so a tab returned to after ten minutes is correct on the first paint rather than
 * showing a stale value until the next tick.
 */
const subscribers = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function broadcast(): void {
  const now = Date.now();
  for (const fn of subscribers) fn(now);
}

function start(): void {
  if (timer !== undefined || document.visibilityState === "hidden") return;
  timer = setInterval(broadcast, 1000);
}

function stop(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}

function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    stop();
    return;
  }
  broadcast();
  start();
}

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    subscribers.add(setNow);
    if (subscribers.size === 1) {
      document.addEventListener("visibilitychange", onVisibilityChange);
      start();
    }
    return () => {
      subscribers.delete(setNow);
      if (subscribers.size === 0) {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        stop();
      }
    };
  }, []);

  return now;
}
