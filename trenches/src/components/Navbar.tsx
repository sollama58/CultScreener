import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";

export type Tab = "dashboard" | "scroll" | "curated" | "filters" | "leaderboard" | "settings" | "admin";

const BASE_TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Live Feed" },
  { id: "scroll", label: "Scroll" },
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

  const activeLabel = tabs.find((t) => t.id === tab)?.label ?? "Menu";

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
      {/*
        The mobile face of this bar. Seven tabs, a brand and an account row cannot share a phone
        screen: stacked and wrapped they ran to roughly two hundred pixels of chrome before any
        content, which on a 844px-tall phone is a quarter of the viewport spent on navigation.
        Below the breakpoint the tabs and the account block are hidden and this replaces both.
        Rendered unconditionally and switched in CSS rather than by a JS media query, so there is
        no flash on first paint and no resize listener deciding what exists.
      */}
      <NavMenu
        tabs={tabs}
        tab={tab}
        activeLabel={activeLabel}
        onTabChange={onTabChange}
        wallet={user?.walletAddress}
        onSignOut={() => void signOut()}
      />

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

/**
 * The compact navigation for phones: a single button naming where you are, opening a menu of
 * everywhere you could go, with the account actions at its foot.
 *
 * The behaviours that make a dropdown usable rather than merely present, all of which this has:
 * it closes on choosing something, on a click anywhere outside, and on Escape; Escape returns
 * focus to the trigger it came from, so keyboard users are not dumped at the top of the
 * document; it is positioned absolutely, so opening it never pushes the page around; and it
 * carries the aria-expanded/aria-haspopup pair a screen reader needs to announce it as a menu
 * rather than as a button that mysteriously changes the page.
 */
function NavMenu({
  tabs,
  tab,
  activeLabel,
  onTabChange,
  wallet,
  onSignOut,
}: {
  tabs: { id: Tab; label: string }[];
  tab: Tab;
  activeLabel: string;
  onTabChange: (tab: Tab) => void;
  wallet?: string;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    };
    // pointerdown rather than click: a click listener fires after the press has already moved
    // focus, which on iOS leaves the menu visibly open for a frame under the new tap.
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  // Rotating to a width where this menu no longer exists would otherwise leave it "open" and
  // waiting to reappear on the way back.
  useEffect(() => {
    if (!open) return;
    const onResize = () => close();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [close, open]);

  return (
    <div className="navbar__menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="navbar__menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="navbar__menu-current">{activeLabel}</span>
        <span className={`navbar__menu-caret ${open ? "is-open" : ""}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="navbar__menu-panel" role="menu">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              className={`navbar__menu-item ${t.id === tab ? "navbar__menu-item--active" : ""}`}
              aria-current={t.id === tab ? "page" : undefined}
              onClick={() => {
                onTabChange(t.id);
                close();
              }}
            >
              {t.label}
            </button>
          ))}

          <div className="navbar__menu-account">
            {wallet && (
              <span className="wallet-chip" title={wallet}>
                <span className="wallet-chip__avatar" style={avatarStyle(wallet)} aria-hidden="true" />
                <span className="wallet-chip__address">{shortWallet(wallet)}</span>
              </span>
            )}
            <button
              type="button"
              role="menuitem"
              className="navbar__menu-item navbar__menu-item--signout"
              onClick={() => {
                close();
                onSignOut();
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
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
