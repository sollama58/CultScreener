import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { forgetSignedIn, rememberSignedIn, takePrefetched } from "../api/bootPrefetch";
import { getMe, logout as apiLogout, UNAUTHORIZED_EVENT } from "../api/client";
import type { User } from "../api/types";

/**
 * Deliberately knows nothing about wallets.
 *
 * Signing in needs @solana/wallet-adapter-react and web3.js - 131KB gzipped, 57% of this app's
 * boot JavaScript - and this provider used to call useWallet(), which put all of it in front of
 * every page load including a returning reader who is already signed in and only wants to read
 * their feed. The session lives in an httpOnly cookie; reading it, and signing out, need no
 * wallet at all.
 *
 * The sign-in *action* therefore lives in useWalletSignIn, inside the lazily-loaded WalletGate,
 * and hands the result back through adoptSession.
 */
interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
  /** Called by the sign-in flow once the server has issued a session. */
  adoptSession: (user: User) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // The boot prefetch already asked, in parallel with everything else this load needs - see
    // bootPrefetch.ts. Null means it failed or was too old to trust, so ask properly.
    void (async () => {
      const prefetched = await takePrefetched("me");
      if (prefetched) {
        setUser(prefetched);
        rememberSignedIn();
        setLoading(false);
        return;
      }
      try {
        setUser(await getMe());
        rememberSignedIn();
      } catch {
        setUser(null);
        forgetSignedIn();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Any 401 anywhere means the session is gone — drop straight back to the sign-in screen
  // rather than leaving the user on a page that looks signed in but can no longer load
  // anything. The bridge will re-adopt their wallet, so signing back in is one signature.
  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null);
      // Stop prefetching the gated endpoints on the next load - the session is gone.
      forgetSignedIn();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const adoptSession = useCallback((signedInUser: User) => {
    setUser(signedInUser);
    // From here on this device may prefetch the gated endpoints on load - see bootPrefetch.
    rememberSignedIn();
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout().catch(() => undefined);
    setUser(null);
    forgetSignedIn();
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signOut, adoptSession }}>
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
