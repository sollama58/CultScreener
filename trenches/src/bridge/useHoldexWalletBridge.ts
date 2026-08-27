import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { readHoldexConnection, resolveWalletName } from "./holdexWallet";

export type BridgeState =
  | "checking" // still looking for a site connection / waiting for the adapter to reconnect
  | "no-site-wallet" // nothing connected on the main site — user must use the header button
  | "unavailable" // site says connected, but that wallet isn't detectable in this browser
  | "ready"; // wallet connected here and ready to sign in

/**
 * Events wallet.js fires on the window. It writes sessionStorage *before* dispatching (see
 * saveConnection() in frontend/js/wallet.js), so re-reading on any of these is safe.
 * `walletReady` covers the startup race: wallet.js's init() awaits an autoConnect() that can
 * still be in flight when React mounts, so the very first read can legitimately come back empty.
 */
const SITE_WALLET_EVENTS = ["walletConnected", "walletDisconnected", "walletReady"] as const;

/**
 * Adopts the wallet the user connected via the main site's header button.
 *
 * Flow: read the site's stored connection -> match it against the wallets actually registered
 * in this browser -> `select()` it -> the provider's autoConnect reconnects silently (the
 * origin is already authorised, so no popup) -> caller triggers SIWS, the single extra prompt.
 *
 * Re-reads whenever the site's wallet state changes, rather than once at mount. Reading once
 * meant a user who arrived at /trenches/ *before* connecting — the common case for anyone who
 * lands here first — stayed on "use the header button" even after they used it, because
 * nothing told React the connection now existed. `refresh()` exposes the same re-read for a
 * manual retry.
 *
 * Deliberately one-directional: it never calls connect() or disconnect() on the adapter. The
 * header button owns the connection; a second component racing it for control is how you end
 * up with duplicate approval prompts.
 */
export function useHoldexWalletBridge(): {
  state: BridgeState;
  /** Address the main site has connected, for messaging before the adapter catches up. */
  siteAddress: string | null;
  /** Re-read the site's wallet state now (manual retry). */
  refresh: () => void;
} {
  const { wallets, wallet, select, connected, connecting } = useWallet();
  // Bumped to force a re-read of the site's storage; see refresh() and the event listener.
  const [readCount, setReadCount] = useState(0);
  const refresh = useCallback(() => setReadCount((n) => n + 1), []);

  // select() identity is not stable across renders in the adapter; keeping it in a ref means
  // the effect below depends only on things that should actually retrigger it.
  const selectRef = useRef(select);
  selectRef.current = select;

  const site = useMemo(() => readHoldexConnection(), [readCount]);

  // Keyed by address rather than a boolean so a *different* wallet connecting later re-runs
  // selection, while repeat renders for the same wallet don't.
  const [attemptedFor, setAttemptedFor] = useState<string | null>(null);
  const attempted = site !== null && attemptedFor === site.address;

  // Wallet Standard registration is async and unbounded: a browser with no wallet extension at
  // all never fires it, so "wait for a non-empty list" alone would leave the UI on "Checking
  // your wallet…" forever. This bounds that wait, and re-arms per connection attempt.
  const [waitedForWallets, setWaitedForWallets] = useState(false);

  const availableNames = useMemo(() => wallets.map((w) => w.adapter.name), [wallets]);
  const target = useMemo(
    () => resolveWalletName(site?.standardName ?? null, availableNames),
    [site, availableNames],
  );

  // Re-read when the site's wallet changes underneath us.
  useEffect(() => {
    const onChange = () => refresh();
    for (const name of SITE_WALLET_EVENTS) window.addEventListener(name, onChange);
    return () => {
      for (const name of SITE_WALLET_EVENTS) window.removeEventListener(name, onChange);
    };
  }, [refresh]);

  useEffect(() => {
    if (!site) return;
    setWaitedForWallets(false);
    const timer = setTimeout(() => setWaitedForWallets(true), 1500);
    return () => clearTimeout(timer);
  }, [site]);

  useEffect(() => {
    if (!site || attempted) return;
    // Wallets can register a tick after mount, so prefer waiting for a non-empty list — but
    // give up once the grace period above has elapsed, otherwise a browser with no wallet
    // installed never resolves.
    if (availableNames.length === 0 && !waitedForWallets) return;
    setAttemptedFor(site.address);
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
    // revoked this origin in the wallet, or dismissed the prompt). Retry is offered in the UI.
    state = "unavailable";
  }

  return { state, siteAddress: site?.address ?? null, refresh };
}
