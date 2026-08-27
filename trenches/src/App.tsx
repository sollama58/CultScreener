import { useState } from "react";
import { SolanaWalletProvider } from "./wallet/SolanaWalletProvider";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { PreferencesProvider } from "./context/PreferencesContext";
import { SubscriptionProvider, useSubscription } from "./context/SubscriptionContext";
import { WalletBridgeProvider } from "./bridge/WalletBridgeContext";
import { Paywall } from "./pages/Paywall";
import { Navbar, type Tab } from "./components/Navbar";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Curated } from "./pages/Curated";
import { Filters } from "./pages/Filters";
import { Leaderboard } from "./pages/Leaderboard";
import { Settings } from "./pages/Settings";
import { Admin } from "./pages/Admin";

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
    return <Login />;
  }

  // The three product tabs are what the subscription buys; Settings and Admin are not. That split
  // deliberately matches what the API enforces - Settings still has to reach Telegram linking and
  // the buy flow's own status, and locking someone out of those because their month lapsed would
  // be punitive rather than protective.
  //
  // Nothing here is a security boundary: every gated route checks access itself. This only decides
  // whether someone sees a paywall or a wall of failed requests.
  const gated = tab === "dashboard" || tab === "curated" || tab === "filters" || tab === "leaderboard";
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
        {blocked && <Paywall />}
        {gated && accessKnown && status.hasAccess && (
          <>
            {tab === "dashboard" && <Dashboard onGoToFilters={() => setTab("filters")} />}
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
    <SolanaWalletProvider>
      {/* Outside AuthProvider: the bridge has to keep running whether or not there's a session,
          because a signed-in user with a disconnected wallet still needs it to sign a burn. */}
      <WalletBridgeProvider>
        <AuthProvider>
          <PreferencesProvider>
            <SubscriptionProvider>
              <AppShell />
            </SubscriptionProvider>
          </PreferencesProvider>
        </AuthProvider>
      </WalletBridgeProvider>
    </SolanaWalletProvider>
  );
}
