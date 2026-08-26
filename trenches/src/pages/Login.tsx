import { useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { useHoldexWalletBridge } from "../bridge/useHoldexWalletBridge";

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function Login() {
  const { signIn, signingIn, error } = useAuth();
  const { state, siteAddress } = useHoldexWalletBridge();
  const autoTriggered = useRef(false);

  // Once the bridge has adopted the site's wallet, go straight to the signature step rather
  // than making the user press another button to get there. Guarded by a ref so a re-render
  // (or a failed attempt leaving `error` set) can't re-prompt: after the first try the button
  // below is the only way to ask again.
  useEffect(() => {
    if (state !== "ready" || autoTriggered.current || signingIn || error) return;
    autoTriggered.current = true;
    void signIn();
  }, [state, signingIn, error, signIn]);

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
            <p className="login__status">
              Use the <strong>Connect Wallet</strong> button in the header above to get started.
            </p>
          )}

          {state === "unavailable" && (
            <p className="form-error">
              {siteAddress ? `${shortAddress(siteAddress)} is connected` : "A wallet is connected"} on
              HolDEX, but that wallet extension isn&apos;t available in this browser. Reconnect from the
              header above.
            </p>
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
