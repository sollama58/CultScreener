import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getSubscription, PAYMENT_REQUIRED_EVENT } from "../api/client";
import type { SubscriptionStatus } from "../api/types";
import { useAuth } from "./AuthContext";

interface SubscriptionValue {
  status: SubscriptionStatus | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const SubscriptionContext = createContext<SubscriptionValue>({
  status: null,
  loading: true,
  refresh: async () => {},
});

/**
 * Whether this wallet may use the dashboard, and what it would cost if not.
 *
 * The server is the authority - every gated route enforces this independently, so nothing here is
 * load-bearing for security. This exists so the app can show a paywall instead of a wall of failed
 * requests, which is the difference between "buy a month" and "everything is broken".
 */
export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setStatus(null);
      setLoading(false);
      return;
    }
    try {
      setStatus(await getSubscription());
    } catch {
      // Leave the previous answer in place rather than guessing. Guessing "no access" on a network
      // blip would throw a paying user onto the paywall; guessing "access" would show them a feed
      // that then 402s on every call. The server decides, and it will answer on the next try.
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // A 402 from anywhere in the app means the answer has changed underneath us - most likely a
  // subscription that lapsed while the tab was open. Re-ask rather than assuming: an admin may
  // have just granted access, in which case the right response is to carry on.
  useEffect(() => {
    const onPaymentRequired = () => void refresh();
    window.addEventListener(PAYMENT_REQUIRED_EVENT, onPaymentRequired);
    return () => window.removeEventListener(PAYMENT_REQUIRED_EVENT, onPaymentRequired);
  }, [refresh]);

  return (
    <SubscriptionContext.Provider value={{ status, loading, refresh }}>{children}</SubscriptionContext.Provider>
  );
}

export function useSubscription(): SubscriptionValue {
  return useContext(SubscriptionContext);
}
