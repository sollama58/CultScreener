import { useCallback, useEffect, useState } from "react";
import {
  addToWhitelist,
  getAdminBurns,
  getAdminSubscribers,
  getAdminSubscriptionStats,
  getWhitelist,
  grantSubscription,
  removeFromWhitelist,
  revokeSubscription,
} from "../../api/client";
import type {
  AdminBurn,
  AdminSubscriber,
  AdminSubscriptionStats,
  WhitelistEntry,
} from "../../api/types";

const SOLSCAN_TX = "https://solscan.io/tx/";
const SOLSCAN_ACCOUNT = "https://solscan.io/account/";

/** Base units to whole tokens. The mint has 6 decimals; done as string maths, not via Number. */
function formatTokens(raw: string, decimals = 6): string {
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  return Number(whole).toLocaleString();
}

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

export function AdminSubscriptions() {
  const [stats, setStats] = useState<AdminSubscriptionStats | null>(null);
  const [subscribers, setSubscribers] = useState<AdminSubscriber[]>([]);
  const [burns, setBurns] = useState<AdminBurn[]>([]);
  const [whitelist, setWhitelist] = useState<WhitelistEntry[]>([]);
  const [unattributedOnly, setUnattributedOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, subs, b, wl] = await Promise.all([
        getAdminSubscriptionStats(),
        getAdminSubscribers(100),
        getAdminBurns(100, unattributedOnly),
        getWhitelist(),
      ]);
      setStats(s);
      setSubscribers(subs);
      setBurns(b);
      setWhitelist(wl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [unattributedOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Wraps a mutation so a failure is shown rather than swallowed, and the view always reloads. */
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleGrant = () => {
    const wallet = prompt("Wallet address to grant access to:")?.trim();
    if (!wallet) return;
    const days = Number(prompt("How many days?", "30")?.trim());
    if (!Number.isFinite(days) || days < 1) return;
    void run(() => grantSubscription(wallet, days));
  };

  const handleWhitelist = () => {
    const wallet = prompt("Wallet address to whitelist (free access):")?.trim();
    if (!wallet) return;
    const note = prompt("Note (optional):")?.trim();
    void run(() => addToWhitelist(wallet, note || undefined));
  };

  return (
    <div className="admin-subscriptions">
      {error && <p className="paywall__error">{error}</p>}

      {stats && (
        <div className="admin-stat-grid">
          <Stat label="Active" value={stats.activeSubscriptions} />
          <Stat label="Lapsed" value={stats.expiredSubscriptions} />
          <Stat label="Whitelisted" value={stats.whitelisted} />
          <Stat label="Burns" value={stats.totalBurns} />
          <Stat label="Months sold" value={stats.totalMonthsCredited} />
          <Stat label="Burned" value={`${formatTokens(stats.totalRawBurned)}`} />
          {/* Surfaced because burns with no account are money that arrived from someone who
              hasn't signed in - the one number here that may need a human to act on it. */}
          <Stat label="Unattributed" value={stats.unattributedBurns} warn={stats.unattributedBurns > 0} />
        </div>
      )}

      {stats && (
        <p className="admin-scan-cursor">
          Reconciler cursor:{" "}
          {stats.scanCursor ? (
            <a href={`${SOLSCAN_TX}${stats.scanCursor}`} target="_blank" rel="noreferrer">
              {short(stats.scanCursor)}
            </a>
          ) : (
            "not started"
          )}
          {stats.scanCursorUpdatedAt && ` · updated ${new Date(stats.scanCursorUpdatedAt).toLocaleString()}`}
        </p>
      )}

      <div className="admin-actions">
        <button className="btn" onClick={handleGrant} disabled={busy}>
          Grant access…
        </button>
        <button className="btn" onClick={handleWhitelist} disabled={busy}>
          Whitelist a wallet…
        </button>
        <button className="btn" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>

      <h4 className="admin-subheading">Subscribers</h4>
      <Table
        head={["Wallet", "Expires", "Source", "Burns", ""]}
        rows={subscribers.map((s) => {
          const live = new Date(s.expiresAt) > new Date();
          return [
            <a key="w" href={`${SOLSCAN_ACCOUNT}${s.walletAddress}`} target="_blank" rel="noreferrer">
              {short(s.walletAddress)}
            </a>,
            <span key="e" className={live ? "admin-live" : "admin-lapsed"}>
              {new Date(s.expiresAt).toLocaleDateString()}
            </span>,
            s.source === "ADMIN_GRANT" ? "granted" : "burn",
            s.burnCount,
            <button
              key="r"
              className="btn btn--danger btn--small"
              disabled={busy}
              onClick={() => {
                if (confirm(`Revoke access for ${s.walletAddress}?`)) {
                  void run(() => revokeSubscription(s.walletAddress));
                }
              }}
            >
              Revoke
            </button>,
          ];
        })}
        empty="No subscribers yet."
      />

      <h4 className="admin-subheading">
        Burn ledger
        <label className="admin-inline-toggle">
          <input
            type="checkbox"
            checked={unattributedOnly}
            onChange={(e) => setUnattributedOnly(e.target.checked)}
          />
          unattributed only
        </label>
      </h4>
      <Table
        head={["Tx", "Burner", "Amount", "Months", "When", "Found by", "Status"]}
        rows={burns.map((b) => [
          <a key="t" href={`${SOLSCAN_TX}${b.signature}`} target="_blank" rel="noreferrer">
            {short(b.signature)}
          </a>,
          <a key="b" href={`${SOLSCAN_ACCOUNT}${b.burnerWallet}`} target="_blank" rel="noreferrer">
            {short(b.burnerWallet)}
          </a>,
          formatTokens(b.rawAmount),
          b.monthsCredited,
          b.blockTime ? new Date(b.blockTime).toLocaleString() : "—",
          b.discoveredBy,
          b.creditedAt ? (
            <span key="s" className="admin-live">
              credited
            </span>
          ) : (
            <span key="s" className="admin-lapsed">
              awaiting sign-in
            </span>
          ),
        ])}
        empty="No burns recorded yet."
      />

      <h4 className="admin-subheading">Whitelist</h4>
      <Table
        head={["Wallet", "Expires", "Note", "Added by", ""]}
        rows={whitelist.map((w) => [
          <a key="w" href={`${SOLSCAN_ACCOUNT}${w.walletAddress}`} target="_blank" rel="noreferrer">
            {short(w.walletAddress)}
          </a>,
          w.expiresAt ? new Date(w.expiresAt).toLocaleDateString() : "never",
          w.note ?? "—",
          short(w.addedBy),
          <button
            key="r"
            className="btn btn--danger btn--small"
            disabled={busy}
            onClick={() => {
              if (confirm(`Remove ${w.walletAddress} from the whitelist?`)) {
                void run(() => removeFromWhitelist(w.walletAddress));
              }
            }}
          >
            Remove
          </button>,
        ])}
        empty="Nobody is whitelisted."
      />
    </div>
  );
}

/** Same markup as AdminOverview's tiles, so the two grids read as one thing rather than two. */
function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={`admin-stat-card${warn ? " admin-stat-card--warn" : ""}`}>
      <span className="admin-stat-card__value">{value}</span>
      <span className="admin-stat-card__label">{label}</span>
    </div>
  );
}

function Table({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  if (rows.length === 0) return <p className="empty-state">{empty}</p>;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
