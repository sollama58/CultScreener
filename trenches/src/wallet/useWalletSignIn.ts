import { useCallback, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { useAuth } from "../context/AuthContext";
import {
  getNonce,
  verifySignMessage,
  verifyWalletSignIn,
  ApiError,
} from "../api/client";
import type { User } from "../api/types";

/**
 * The wallet half of signing in, lifted out of AuthContext.
 *
 * It lives here, and only ever renders inside WalletGate, because calling useWallet() puts the
 * wallet adapter and web3.js on the boot path - 131KB gzipped that a returning reader who is
 * already signed in never needs. AuthContext keeps the session; this keeps the signature.
 *
 * The flow itself is unchanged: nonce, sign, verify, adopt.
 */
export function useWalletSignIn() {
  const { publicKey, signMessage, signIn: walletSignIn } = useWallet();
  const { adoptSession } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async () => {
    setError(null);
    if (!publicKey) {
      setError("Connect a wallet first.");
      return;
    }
    if (!walletSignIn && !signMessage) {
      setError("This wallet doesn't support message signing. Try Phantom or Solflare.");
      return;
    }

    setSigningIn(true);
    try {
      const wallet = publicKey.toBase58();
      const { nonce, message, signInInput } = await getNonce(wallet);

      let signedInUser: User;
      if (walletSignIn) {
        // Preferred: the Wallet Standard's dedicated sign-in feature. The wallet itself checks
        // signInInput.domain against the page's real origin before signing - a phishing site
        // cannot get a valid signature for our domain no matter what it shows the user.
        const output = await walletSignIn(signInInput);
        signedInUser = await verifyWalletSignIn(wallet, nonce, {
          publicKey: bs58.encode(Uint8Array.from(output.account.publicKey)),
          signedMessage: bs58.encode(output.signedMessage),
          signature: bs58.encode(output.signature),
        });
      } else {
        // Fallback for wallets that don't implement solana:signIn yet. Not domain-bound - the
        // wallet has no way to verify which site is actually asking, only what the message text
        // claims. Kept only for compatibility; every wallet worth using supports signIn.
        const signatureBytes = await signMessage!(new TextEncoder().encode(message));
        signedInUser = await verifySignMessage(wallet, nonce, bs58.encode(signatureBytes));
      }
      adoptSession(signedInUser);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error && err.message.toLowerCase().includes("reject")) {
        setError("Signature request was rejected.");
      } else if (err instanceof TypeError) {
        // fetch() rejects with a TypeError only when the request never reached the server:
        // blocked by a browser extension, offline, or DNS/TLS failure. Worth naming, because
        // content blockers do block this API's domain and the generic "try again" below sends
        // the user round the same loop forever with no idea what to change.
        // Host is named so the user knows what to allowlist; keep it in step with
        // VITE_API_URL in trenches/.env.production.
        setError(
          "Couldn't reach the Trenches server. If you use an ad blocker or privacy extension, " +
            "allow api.holdex.live and try again.",
        );
      } else {
        setError("Sign-in failed. Please try again.");
      }
    } finally {
      setSigningIn(false);
    }
  }, [publicKey, signMessage, walletSignIn, adoptSession]);

  return { signIn, signingIn, error };
}
