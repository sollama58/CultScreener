import { useCallback, useEffect, useRef, useState } from "react";
import { useWalletSignIn } from "../wallet/useWalletSignIn";
import { useWalletBridge } from "../bridge/WalletBridgeContext";
import { requestSiteWalletConnect } from "../bridge/holdexWallet";

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function Login() {
  const { signIn, signingIn, error } = useWalletSignIn();
  const { state, siteAddress, refresh } = useWalletBridge();
  const autoTriggered = useRef(false);
  const [noHeaderButton, setNoHeaderButton] = useState(false);

  // Once the bridge has adopted the site's wallet, go straight to the signature step rather
  // than making the user press another button to get there. Guarded by a ref so a re-render
  // (or a failed attempt leaving `error` set) can't re-prompt: after the first try the button
  // below is the only way to ask again.
  useEffect(() => {
    if (state !== "ready" || autoTriggered.current || signingIn || error) return;
    autoTriggered.current = true;
    void signIn();
  }, [state, signingIn, error, signIn]);

  // Delegates to the site header's own button (see requestSiteWalletConnect) and re-reads, so
  // the screen recovers even if wallet.js's events were missed entirely.
  const connectAndRetry = useCallback(() => {
    const opened = requestSiteWalletConnect();
    setNoHeaderButton(!opened);
    refresh();
  }, [refresh]);

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__logo">🎯</div>
        <h1>Trenches</h1>
        <p className="login__tagline">
          Scan the Solana memecoin trenches for tokens with breakout potential. Set up filters and get
          alerts.
        </p>

        <div className="login__actions">
          {state === "checking" && <p className="login__status">Checking your wallet…</p>}

          {state === "no-site-wallet" && (
            <>
              <p className="login__status">
                Connect your wallet to get started — use the <strong>Connect Wallet</strong> button in
                the header above, or:
              </p>
              <button className="btn btn--primary" onClick={connectAndRetry}>
                Connect Wallet
              </button>
              <button className="btn" onClick={refresh}>
                Try again
              </button>
            </>
          )}

          {state === "unavailable" && (
            <>
              <p className="form-error">
                {siteAddress ? `${shortAddress(siteAddress)} is connected` : "A wallet is connected"} on
                HolDEX, but we couldn&apos;t reach that wallet in this browser. Make sure the extension
                is unlocked, then try again.
              </p>
              <button className="btn btn--primary" onClick={connectAndRetry}>
                Try again
              </button>
            </>
          )}

          {state === "ready" && (
            <>
              {siteAddress && (
                <p className="login__status">
                  Signing in as <code>{shortAddress(siteAddress)}</code>
                </p>
              )}
              <button className="btn btn--primary" onClick={() => void signIn()} disabled={signingIn}>
                {signingIn ? "Waiting for signature…" : error ? "Try again" : "Sign in"}
              </button>
            </>
          )}

          {noHeaderButton && (
            <p className="form-error">
              Couldn&apos;t open the wallet picker. Please reload the page and try again.
            </p>
          )}
        </div>

        {error && <p className="form-error">{error}</p>}

        <p className="login__note">
          Trenches keeps its own sign-in, so it needs one signature to prove you own this wallet. It never
          submits a transaction and costs no fees.
        </p>
      </div>
    </div>
  );
}
