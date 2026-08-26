import { useState } from "react";
import { SolanaWalletProvider } from "./wallet/SolanaWalletProvider";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { Navbar, type Tab } from "./components/Navbar";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Filters } from "./pages/Filters";
import { Leaderboard } from "./pages/Leaderboard";
import { Settings } from "./pages/Settings";
import { Admin } from "./pages/Admin";

function AppShell() {
  const { user, loading } = useAuth();
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

  return (
    <div className="app-shell">
      <Navbar tab={tab} onTabChange={setTab} />
      <main className="app-content">
        {tab === "dashboard" && <Dashboard onGoToFilters={() => setTab("filters")} />}
        {tab === "filters" && <Filters />}
        {tab === "leaderboard" && <Leaderboard />}
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
        <AppShell />
      </AuthProvider>
    </SolanaWalletProvider>
  );
}
