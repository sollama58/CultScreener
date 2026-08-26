import { useEffect, useState } from "react";
import { getAdminStats } from "../../api/client";
import type { AdminStats } from "../../api/types";

const STAT_LABELS: { key: keyof AdminStats; label: string }[] = [
  { key: "totalUsers", label: "Users" },
  { key: "totalActiveFilters", label: "Active filters" },
  { key: "totalTrackedTokens", label: "Tracked tokens" },
  { key: "totalMatches", label: "Matches (all time)" },
  { key: "matches24h", label: "Matches (24h)" },
  { key: "telegramLinkedUsers", label: "Telegram-linked users" },
];

export function AdminOverview() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdminStats()
      .then(setStats)
      .catch(() => setError("Failed to load stats."));
  }, []);

  if (error) return <p className="empty-state">{error}</p>;
  if (!stats) return <p className="empty-state">Loading…</p>;

  return (
    <div className="admin-stat-grid">
      {STAT_LABELS.map(({ key, label }) => (
        <div key={key} className="admin-stat-card">
          <span className="admin-stat-card__value">{stats[key].toLocaleString()}</span>
          <span className="admin-stat-card__label">{label}</span>
        </div>
      ))}
    </div>
  );
}
