import { Suspense, lazy, useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { PreferencesProvider } from "./context/PreferencesContext";
import { FeedStatusProvider } from "./context/FeedStatusContext";
import { SubscriptionProvider, useSubscription } from "./context/SubscriptionContext";
import { Navbar, type Tab } from "./components/Navbar";
import { Dashboard } from "./pages/Dashboard";
import { PumpTok } from "./pages/PumpTok";
import { Curated } from "./pages/Curated";
import { Filters } from "./pages/Filters";
import { Leaderboard } from "./pages/Leaderboard";
import { Settings } from "./pages/Settings";
import { Admin } from "./pages/Admin";

/**
 * The wallet adapter and web3.js, behind a dynamic import.
 *
 * They are 131KB gzipped - 57% of this app's boot JavaScript - and nothing on the reading path
 * needs them: a returning reader arrives with a valid session cookie and wants their feed, not a
 * signature. Only two screens do, and both are moments where the reader is already braced for a
 * wallet popup, so fetching the chunk then is invisible.
 *
 * Loading it must never be a blank screen: the fallback keeps the shell in place while it
 * arrives.
 */
const WalletGate = lazy(() => import("./wallet/WalletGate"));

/**
 * Lazy for the same reason, and it has to be: Paywall imports web3.js directly for the burn
 * transaction, so a static import here would drag the whole wallet stack back onto the boot path
 * however carefully the provider tree was arranged. Verified by watching the build manifest -
 * moving the providers alone left vendor-solana and vendor-wallet still preloaded.
 */
const Paywall = lazy(() => import("./pages/Paywall").then((m) => ({ default: m.Paywall })));

/**
 * Lazy for the same reason as Paywall: Login reaches the wallet through useWalletSignIn and the
 * bridge, so a static import here keeps the adapter on the boot path. It only ever renders for
 * someone who has no session, which is exactly when fetching it is free - they are about to be
 * asked for a signature anyway.
 */
const Login = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));

function WithWallet({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<p className="empty-state">Loading wallet…</p>}>
      <WalletGate>{children}</WalletGate>
    </Suspense>
  );
}

function AppShell() {
  const { user, loading } = useAuth();
  const { status, loading: accessLoading } = useSubscription();
  const [tab, setTab] = useState<Tab>("dashboard");

  if (loading) {
    return (
      <div className="app-loading">
        <span>Loading TrenchScanner…</span>
      </div>
    );
  }

  if (!user) {
    // Signing in is the one read-path moment that genuinely needs a wallet.
    return (
      <WithWallet>
        <Login />
      </WithWallet>
    );
  }

  // The three product tabs are what the subscription buys; Settings and Admin are not. That split
  // deliberately matches what the API enforces - Settings still has to reach Telegram linking and
  // the buy flow's own status, and locking someone out of those because their month lapsed would
  // be punitive rather than protective.
  //
  // Nothing here is a security boundary: every gated route checks access itself. This only decides
  // whether someone sees a paywall or a wall of failed requests.
  const gated =
    tab === "dashboard" ||
    // PumpTok plays the same paid feeds the Live Feed and Curated tab do, so it gates with them -
    // an ungated PumpTok tab would fire /matches and the SSE stream and collect a 402 on each,
    // which is precisely the wall of red the note above exists to prevent.
    tab === "pumptok" ||
    tab === "curated" ||
    tab === "filters" ||
    tab === "leaderboard";
  // Deliberately three states, not two. Mounting a gated tab before the answer is known meant the
  // feed fired /matches, /filters and the SSE stream on first paint, collected a 402 on each, and
  // only then got replaced by the paywall - so someone who simply hasn't subscribed opened their
  // console to a wall of red and reasonably concluded the page was broken. Waiting costs one
  // request's worth of latency and makes the normal unsubscribed path silent.
  const accessKnown = !accessLoading && status !== null;
  const blocked = gated && accessKnown && !status.hasAccess;
  const waiting = gated && !accessKnown;

  return (
    <div className="app-shell">
      <Navbar tab={tab} onTabChange={setTab} />
      <main className="app-content">
        {waiting && <p className="empty-state">Checking your access…</p>}
        {blocked && (
          // The burn flow signs a transaction, so the paywall brings the wallet with it.
          <WithWallet>
            <Paywall />
          </WithWallet>
        )}
        {gated && accessKnown && status.hasAccess && (
          <>
            {tab === "dashboard" && <Dashboard onGoToFilters={() => setTab("filters")} />}
            {tab === "pumptok" && <PumpTok onGoToSettings={() => setTab("settings")} />}
            {tab === "curated" && <Curated />}
            {tab === "filters" && <Filters />}
            {tab === "leaderboard" && <Leaderboard />}
          </>
        )}
        {tab === "settings" && <Settings />}
        {tab === "admin" && user.isAdmin && <Admin />}
      </main>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <PreferencesProvider>
        {/* Above the shell: the Live Feed publishes its freshness here and the app bar renders
            it, so the two are siblings rather than one reaching into the other. */}
        <FeedStatusProvider>
          <SubscriptionProvider>
            <AppShell />
          </SubscriptionProvider>
        </FeedStatusProvider>
      </PreferencesProvider>
    </AuthProvider>
  );
}
