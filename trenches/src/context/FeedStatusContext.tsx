import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * The Live Feed's freshness readout - is the push stream connected, when did the figures last
 * refresh, and when do they refresh next.
 *
 * It lives in a context because it is PRODUCED by the Live Feed but DISPLAYED in the app bar.
 * The feed used to carry its own heading and status row, which repeated the tab name directly
 * under the tab strip and spent a line of every page on it; the status is more useful pinned
 * beside the navigation, where it stays in one place instead of moving with the page.
 *
 * Null means "nothing is reporting" - any tab other than the Live Feed - and the bar simply
 * renders nothing rather than showing a stale timestamp from a page that is no longer open.
 */
export interface FeedStatus {
  streamConnected: boolean;
  lastUpdated: Date | null;
  /** Epoch ms of the next scheduled refresh, for the countdown. */
  nextRefreshAt: number | null;
}

interface FeedStatusValue {
  status: FeedStatus | null;
  setStatus: (status: FeedStatus | null) => void;
}

const FeedStatusContext = createContext<FeedStatusValue>({ status: null, setStatus: () => {} });

export function FeedStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const value = useMemo(() => ({ status, setStatus }), [status]);
  return <FeedStatusContext.Provider value={value}>{children}</FeedStatusContext.Provider>;
}

export function useFeedStatus(): FeedStatusValue {
  return useContext(FeedStatusContext);
}
