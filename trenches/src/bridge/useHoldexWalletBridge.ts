import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { readHoldexConnection, resolveWalletName } from "./holdexWallet";

export type BridgeState =
  | "checking" // still looking for a site connection / waiting for the adapter to reconnect
  | "no-site-wallet" // nothing connected on the main site — user must use the header button
  | "unavailable" // site says connected, but that wallet isn't detectable in this browser
  | "ready"; // wallet connected here and ready to sign in

/**
 * Adopts the wallet the user already connected via the main site's header button.
 *
 * Flow: read the site's stored connection -> match it against the wallets actually registered
 * in this browser -> `select()` it -> the provider's autoConnect reconnects silently (the
 * origin is already authorised, so no popup) -> caller triggers SIWS, the single extra prompt.
 *
 * Deliberately one-directional and one-shot. It never calls connect() or disconnect() itself:
 * the header button owns the connection, and a second component racing it for control is how
 * you end up with duplicate approval prompts.
 */
export function useHoldexWalletBridge(): {
  state: BridgeState;
  /** Address the main site has connected, for messaging before the adapter catches up. */
  siteAddress: string | null;
} {
  const { wallets, wallet, select, connected, connecting } = useWallet();
  const [attempted, setAttempted] = useState(false);
  // Wallet Standard registration is async and unbounded: a browser with no wallet extension at
  // all never fires it, so "wait for a non-empty list" alone would leave the UI on "Checking
  // your wallet…" forever. This bounds that wait.
  const [waitedForWallets, setWaitedForWallets] = useState(false);
  // select() identity is not stable across renders in the adapter; keeping it in a ref means
  // the effect below depends only on things that should actually retrigger it.
  const selectRef = useRef(select);
  selectRef.current = select;

  // Read once on mount: re-reading on every render would let a mid-session change on another
  // page yank the wallet out from under an in-progress sign-in.
  const site = useMemo(() => readHoldexConnection(), []);

  const availableNames = useMemo(() => wallets.map((w) => w.adapter.name), [wallets]);
  const target = useMemo(
    () => resolveWalletName(site?.standardName ?? null, availableNames),
    [site, availableNames],
  );

  useEffect(() => {
    if (!site) return;
    const timer = setTimeout(() => setWaitedForWallets(true), 1500);
    return () => clearTimeout(timer);
  }, [site]);

  useEffect(() => {
    if (!site || attempted) return;
    // Wallets can register a tick after mount, so prefer waiting for a non-empty list — but
    // give up once the grace period above has elapsed, otherwise a browser with no wallet
    // installed never resolves.
    if (availableNames.length === 0 && !waitedForWallets) return;
    setAttempted(true);
    if (target && wallet?.adapter.name !== target) {
      selectRef.current(target as Parameters<typeof select>[0]);
    }
  }, [site, attempted, availableNames, target, wallet, waitedForWallets]);

  let state: BridgeState;
  if (!site) {
    state = "no-site-wallet";
  } else if (connected) {
    state = "ready";
  } else if (!attempted) {
    state = "checking";
  } else if (!target) {
    state = "unavailable";
  } else if (connecting || !waitedForWallets) {
    // Selected and not yet connected: autoConnect is still settling.
    state = "checking";
  } else {
    // Selected, grace period elapsed, still not connected — autoConnect didn't take (the user
    // revoked this origin in the wallet, or dismissed the prompt). The header button is the
    // way back, same as the no-wallet case.
    state = "unavailable";
  }

  return { state, siteAddress: site?.address ?? null };
}
