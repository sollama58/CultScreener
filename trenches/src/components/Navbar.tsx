import { useAuth } from "../context/AuthContext";
import { HealthBadge } from "./HealthBadge";

export type Tab = "dashboard" | "filters" | "leaderboard" | "settings" | "admin";

const BASE_TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Live Feed" },
  { id: "filters", label: "Filters" },
  { id: "leaderboard", label: "Leaderboard" },
  { id: "settings", label: "Settings" },
];

export function Navbar({ tab, onTabChange }: { tab: Tab; onTabChange: (tab: Tab) => void }) {
  const { user, signOut } = useAuth();
  // Admin is the only tab gated on anything - everyone else always sees the same three. The
  // server enforces this independently (every /admin/* route 403s a non-admin), so hiding the
  // link is purely so a non-admin never sees a dead end, not the actual security boundary.
  const tabs = user?.isAdmin ? [...BASE_TABS, { id: "admin" as const, label: "Admin" }] : BASE_TABS;

  return (
    <header className="navbar">
      {/* "Trenches" rather than "TrenchScanner": this bar sits directly under the HolDEX site
          header, so it names the section of the site you're in, matching the top-nav tab. */}
      <div className="navbar__brand">
        <span className="navbar__logo">🎯</span> Trenches
      </div>
      <nav className="navbar__tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`navbar__tab ${tab === t.id ? "navbar__tab--active" : ""}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="navbar__account">
        <HealthBadge />
        <span className="navbar__wallet">{user ? shortWallet(user.walletAddress) : ""}</span>
        <button className="btn btn--ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </header>
  );
}

function shortWallet(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
