import { createContext, useContext, type ReactNode } from "react";
import { useHoldexWalletBridge, type BridgeState } from "./useHoldexWalletBridge";

interface WalletBridgeValue {
  state: BridgeState;
  siteAddress: string | null;
  refresh: () => void;
}

const WalletBridgeContext = createContext<WalletBridgeValue>({
  state: "checking",
  siteAddress: null,
  refresh: () => {},
});

/**
 * Runs the site-wallet bridge for the whole app, not just the sign-in screen.
 *
 * It used to live inside Login, which meant it only ran while signed OUT. The session is a
 * cookie and outlives the wallet connection, so a returning user - the common case - mounted
 * straight into the app with Login never rendered, the bridge never running, select() never
 * called, and the adapter therefore never connected. Everything that needs to *sign* rather than
 * merely identify the user was then permanently stuck: the burn button sat disabled with the
 * wallet apparently unconnected, and pressing Connect Wallet in the site header did nothing
 * visible, because nothing inside the app was listening for the event it fires.
 *
 * Mounted once here so there is exactly one instance driving select(); consumers read its state
 * rather than each running their own copy, which would have several components racing to adopt
 * the same wallet.
 */
export function WalletBridgeProvider({ children }: { children: ReactNode }) {
  const bridge = useHoldexWalletBridge();
  return <WalletBridgeContext.Provider value={bridge}>{children}</WalletBridgeContext.Provider>;
}

export function useWalletBridge(): WalletBridgeValue {
  return useContext(WalletBridgeContext);
}
