import { useAuth } from "../context/AuthContext";

export type Tab = "dashboard" | "curated" | "filters" | "leaderboard" | "settings" | "admin";

const BASE_TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Live Feed" },
  { id: "curated", label: "Curated" },
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
      {/* Scanner status deliberately does NOT live here. It used to sit beside the wallet while
          the Live Feed header showed its own "Live" pill for the push connection - two different
          facts wearing the same word, a few hundred pixels apart. There is now one status
          element, in the Live Feed header, and it carries both. */}
      <div className="navbar__account">
        {user && (
          <span className="wallet-chip" title={user.walletAddress}>
            {/* Colour derived from the address, so a wallet is recognisable at a glance and two
                accounts are visibly different without showing the full key. */}
            <span className="wallet-chip__avatar" style={avatarStyle(user.walletAddress)} aria-hidden="true" />
            <span className="wallet-chip__address">{shortWallet(user.walletAddress)}</span>
          </span>
        )}
        <button className="btn btn--signout" onClick={() => void signOut()} title="Sign out">
          <span className="btn__icon" aria-hidden="true">
            ⏻
          </span>
          <span className="btn__label">Sign out</span>
        </button>
      </div>
    </header>
  );
}

function shortWallet(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * A stable two-tone gradient per wallet. Purely decorative - a cheap way to make an account
 * recognisable without rendering the full key, and to make "am I signed in as the right wallet?"
 * answerable at a glance. Not a hash anyone should rely on: it only needs to be stable and
 * well-spread, not collision-free.
 */
function avatarStyle(address: string): { background: string } {
  let hash = 0;
  for (let i = 0; i < address.length; i += 1) hash = (hash * 31 + address.charCodeAt(i)) % 360;
  return { background: `linear-gradient(135deg, hsl(${hash} 70% 55%), hsl(${(hash + 60) % 360} 70% 45%))` };
}
