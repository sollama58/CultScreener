/**
 * Bridge to the main site's wallet layer (frontend/js/wallet.js).
 *
 * The rest of HolDEX connects a wallet through its own header button and signs a fresh
 * message per privileged request. This app authenticates differently — Sign-In-With-Solana
 * against the TrenchScanner API, which returns a session cookie. Those models don't merge,
 * but the *connection* can be shared: if the user already picked a wallet on the main site,
 * we reuse that choice instead of asking again, so they see one Connect Wallet button (the
 * site header's, which is on this page too) and at most one additional signature prompt.
 *
 * Storage note: despite the key name, the site keeps this in **sessionStorage**, not
 * localStorage — wallet.js switched for privacy ("cleared on browser close") and now actively
 * deletes the legacy localStorage copies on every save/load. Reading localStorage here would
 * essentially always miss. We read sessionStorage first and fall back to localStorage only to
 * tolerate a stale tab still running a pre-migration wallet.js.
 *
 * sessionStorage is per-origin *and* per-tab. /trenches/ is same-origin with the rest of the
 * site, so a wallet connected in this tab carries over; one connected in a *different* tab
 * does not. That's the same behaviour the site's own pages already have between tabs.
 */

/** Shape written by wallet.js `saveConnection()`. */
interface HoldexConnection {
  connected: boolean;
  address: string;
  /** Site-internal wallet id, e.g. "phantom" — see WALLET_ID_TO_STANDARD_NAME. */
  wallet: string;
  timestamp: number;
}

export interface BridgedWallet {
  address: string;
  /** Wallet Standard name to hand to the adapter's `select()`, when we can map it. */
  standardName: string | null;
}

/** Mirrors config.js `storageKeys.walletConnection`. */
const STORAGE_KEY = "holdex_wallet_connection";

/**
 * wallet.js's internal ids -> the `name` each wallet registers with the Wallet Standard,
 * which is what @solana/wallet-adapter-react keys its wallet list by. Only used as a hint:
 * resolveWalletName() matches case-insensitively against what's actually registered in this
 * browser, so a wallet that renames itself degrades to "no pre-selection" rather than an error.
 */
const WALLET_ID_TO_STANDARD_NAME: Record<string, string> = {
  phantom: "Phantom",
  solflare: "Solflare",
  backpack: "Backpack",
  coinbase: "Coinbase Wallet",
  trust: "Trust",
  brave: "Brave Wallet",
  exodus: "Exodus",
};

/**
 * A connection older than this is ignored. wallet.js writes a timestamp but never expires the
 * entry itself; sessionStorage already dies with the tab, so this only guards the odd
 * long-lived tab where the user has since disconnected in the wallet extension. Re-selecting a
 * wallet the user no longer wants connected would surface as a surprise approval prompt.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function readRaw(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can throw outright when cookies/site data are blocked.
    return null;
  }
}

/** The wallet the user already connected on the main site, or null if there isn't one. */
export function readHoldexConnection(): BridgedWallet | null {
  const raw = readRaw();
  if (!raw) return null;

  let parsed: Partial<HoldexConnection>;
  try {
    parsed = JSON.parse(raw) as Partial<HoldexConnection>;
  } catch {
    return null;
  }

  if (!parsed || parsed.connected !== true) return null;
  if (typeof parsed.address !== "string" || parsed.address.length === 0) return null;
  if (typeof parsed.timestamp === "number" && Date.now() - parsed.timestamp > MAX_AGE_MS) return null;

  const id = typeof parsed.wallet === "string" ? parsed.wallet.toLowerCase() : "";
  return {
    address: parsed.address,
    standardName: WALLET_ID_TO_STANDARD_NAME[id] ?? null,
  };
}

/**
 * Resolves our hint to a wallet actually registered in this browser. Returns null when the
 * wallet isn't detectable here, in which case the caller must not call select() — passing an
 * unknown name makes the adapter throw rather than no-op.
 */
export function resolveWalletName(hint: string | null, available: readonly string[]): string | null {
  if (!hint) return null;
  const wanted = hint.toLowerCase();
  const exact = available.find((name) => name.toLowerCase() === wanted);
  if (exact) return exact;
  // "Trust" vs "Trust Wallet", "Coinbase Wallet" vs "Coinbase" — accept either direction.
  return (
    available.find(
      (name) => name.toLowerCase().startsWith(wanted) || wanted.startsWith(name.toLowerCase()),
    ) ?? null
  );
}
