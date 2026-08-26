import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import {
  getMe,
  getNonce,
  logout as apiLogout,
  verifySignMessage,
  verifyWalletSignIn,
  ApiError,
} from "../api/client";
import type { User } from "../api/types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signingIn: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage, signIn: walletSignIn } = useWallet();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

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
      setUser(signedInUser);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error && err.message.toLowerCase().includes("reject")) {
        setError("Signature request was rejected.");
      } else {
        setError("Sign-in failed. Please try again.");
      }
    } finally {
      setSigningIn(false);
    }
  }, [publicKey, signMessage, walletSignIn]);

  const signOut = useCallback(async () => {
    await apiLogout().catch(() => undefined);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signingIn, error, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// The provider + its hook are meant to live together; this only affects hot-reload state
// preservation, not correctness.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
