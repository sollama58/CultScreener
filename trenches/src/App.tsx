import { useState } from "react";
import { SolanaWalletProvider } from "./wallet/SolanaWalletProvider";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { PreferencesProvider } from "./context/PreferencesContext";
import { SubscriptionProvider, useSubscription } from "./context/SubscriptionContext";
import { Paywall } from "./pages/Paywall";
import { Navbar, type Tab } from "./components/Navbar";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
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
  const gated = tab === "dashboard" || tab === "filters" || tab === "leaderboard";
  const blocked = gated && !accessLoading && status !== null && !status.hasAccess;

  return (
    <div className="app-shell">
      <Navbar tab={tab} onTabChange={setTab} />
      <main className="app-content">
        {blocked ? (
          <Paywall />
        ) : (
          <>
            {tab === "dashboard" && <Dashboard onGoToFilters={() => setTab("filters")} />}
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
      <AuthProvider>
        <PreferencesProvider>
          <SubscriptionProvider>
            <AppShell />
          </SubscriptionProvider>
        </PreferencesProvider>
      </AuthProvider>
    </SolanaWalletProvider>
  );
}
