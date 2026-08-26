import { useEffect, useState } from "react";
import { getAdminUsers, unlinkUserTelegram } from "../../api/client";
import type { AdminUser } from "../../api/types";

export function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () =>
    getAdminUsers()
      .then(setUsers)
      .catch(() => setError("Failed to load users."));

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  const handleUnlink = async (user: AdminUser) => {
    if (!confirm(`Unlink Telegram for ${shortWallet(user.walletAddress)}?`)) return;
    setBusyId(user.id);
    try {
      await unlinkUserTelegram(user.id);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <p className="empty-state">Loading…</p>;
  if (error) return <p className="empty-state">{error}</p>;
  if (users.length === 0) return <p className="empty-state">No users yet.</p>;

  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Wallet</th>
            <th>Joined</th>
            <th>Filters</th>
            <th>Matches</th>
            <th>Telegram</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td className="admin-table__mono">{shortWallet(user.walletAddress)}</td>
              <td>{new Date(user.createdAt).toLocaleDateString()}</td>
              <td>{user.filterCount}</td>
              <td>{user.matchCount}</td>
              <td>
                {user.telegramLinked ? (
                  <span className="badge badge--on">Linked · {user.alertMode}</span>
                ) : (
                  <span className="badge badge--off">Not linked</span>
                )}
              </td>
              <td>
                {user.telegramLinked && (
                  <button
                    className="btn btn--danger"
                    disabled={busyId === user.id}
                    onClick={() => void handleUnlink(user)}
                  >
                    Unlink Telegram
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function shortWallet(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
