import { getMe, getSubscription, listFilters, listMatches } from "./client";
import type { MatchesPage, SubscriptionStatus, User, UserFilter } from "./types";

/**
 * Fires the four requests a cold Trenches load needs, all at once, the moment this module is
 * imported.
 *
 * Without it they run one after another, because each lives behind the one before it:
 * AuthProvider asks who you are, SubscriptionProvider will not ask about access until it knows,
 * and the Dashboard does not mount until access is settled. Three sequential round trips before a
 * single card can be requested - measured at roughly 470ms on a 150ms link, for four responses
 * that together weigh a few kilobytes.
 *
 * None of them actually needs the one before it. All four authenticate from the same session
 * cookie the browser already holds, so the ordering was an artefact of where the code lived
 * rather than a real dependency. Firing them together collapses three round trips into one.
 *
 * Every request is `quiet`: they go out before the app knows whether anyone is signed in, so a
 * 401 is an expected answer rather than a session expiring, and a 402 is the paywall working
 * rather than a subscription lapsing. Broadcasting either would have the app react to something
 * that did not happen. Rejections are captured, not thrown - a consumer that gets one simply
 * falls back to asking properly.
 */

/** How long a prefetched answer may be used before it is treated as stale and re-fetched. */
const MAX_AGE_MS = 30_000;

/**
 * Set once a session has been seen on this device, and cleared on any 401.
 *
 * The session cookie is httpOnly, so this app cannot read it to find out whether anyone is signed
 * in. Without a hint, prefetching the three gated endpoints would fire three guaranteed 401s on
 * every anonymous page view - four requests where a signed-out visitor previously made one, and
 * the state every first-time visitor and every crawler is in. This marker is not authentication
 * and is never trusted for anything: worst case it is stale, three requests 401 exactly as they
 * would have anyway, and the app falls back to asking properly.
 */
const SIGNED_IN_HINT = "trenches.hasSession";

export function rememberSignedIn(): void {
  try {
    window.localStorage.setItem(SIGNED_IN_HINT, "1");
  } catch {
    // Storage blocked - the prefetch simply stays off for this visitor.
  }
}

export function forgetSignedIn(): void {
  try {
    window.localStorage.removeItem(SIGNED_IN_HINT);
  } catch {
    // Nothing to do: the hint is an optimisation, not state anything depends on.
  }
}

function probablySignedIn(): boolean {
  try {
    return window.localStorage.getItem(SIGNED_IN_HINT) === "1";
  } catch {
    return false;
  }
}

/** Read straight from storage rather than through PreferencesContext, which has not mounted yet. */
function includeCuratedInFeed(): boolean {
  try {
    const raw = window.localStorage.getItem("trenches.preferences");
    if (!raw) return false;
    return JSON.parse(raw)?.includeCuratedInFeed === true;
  } catch {
    // Private mode, blocked storage, corrupt JSON - the default is the safe answer.
    return false;
  }
}

type Slot<T> = { promise: Promise<T | null>; taken: boolean };

const startedAt = Date.now();

const slot = <T>(promise: Promise<T>): Slot<T> => ({
  promise: promise.catch(() => null),
  taken: false,
});

/**
 * What the prefetched page of matches was actually asked for.
 *
 * The preference is read from storage here, before PreferencesContext has mounted and applied its
 * own defaults, so the two can in principle disagree. Exposing it lets the Dashboard check before
 * accepting the answer - a page fetched with curated alerts folded in is the wrong answer for a
 * reader who has them switched off, and silently showing it would be worse than one round trip.
 */
export const prefetchedMatchesIncludeCurated = includeCuratedInFeed();

/** Never asked when nobody has signed in on this device - see SIGNED_IN_HINT. */
const gated = probablySignedIn();
const skip = <T>(): Slot<T> => ({ promise: Promise.resolve(null), taken: true });

const slots = {
  // Always asked: it is the one call that has to happen either way, and its answer is what tells
  // the app whether to show the feed or the sign-in screen.
  me: slot<User>(getMe({ quiet: true })),
  subscription: gated ? slot<SubscriptionStatus>(getSubscription({ quiet: true })) : skip<SubscriptionStatus>(),
  filters: gated ? slot<UserFilter[]>(listFilters({ quiet: true })) : skip<UserFilter[]>(),
  matches: gated
    ? slot<MatchesPage>(listMatches(1, prefetchedMatchesIncludeCurated, { quiet: true }))
    : skip<MatchesPage>(),
};

/**
 * The prefetched answer, once, if it is still fresh - otherwise null, meaning "ask properly".
 *
 * Once, because a second read would hand back a frozen answer to something that wanted a refresh.
 * Fresh, because a tab restored from the background hours later must not paint stale prices, and
 * the prefetch has no way to know how long it sat there.
 */
export async function takePrefetched<K extends keyof typeof slots>(
  key: K,
): Promise<Awaited<(typeof slots)[K]["promise"]> | null> {
  const entry = slots[key] as Slot<unknown>;
  if (entry.taken || Date.now() - startedAt > MAX_AGE_MS) return null;
  entry.taken = true;
  return (await entry.promise) as Awaited<(typeof slots)[K]["promise"]> | null;
}
