import { useEffect, useState, type ReactNode } from "react";
import { getAdminConfig } from "../../api/client";
import type { AdminConfig as AdminConfigData } from "../../api/types";

/** Read-only snapshot of the non-secret half of the shared env schema - what's actually running,
 *  without needing to open the Render dashboard. */
export function AdminConfig() {
  const [config, setConfig] = useState<AdminConfigData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdminConfig()
      .then(setConfig)
      .catch(() => setError("Failed to load config."));
  }, []);

  if (error) return <p className="empty-state">{error}</p>;
  if (!config) return <p className="empty-state">Loading…</p>;

  return (
    <dl className="admin-config">
      <Row label="Mcap band">
        ${config.mcapFilterMin.toLocaleString()} – ${config.mcapFilterMax.toLocaleString()}
      </Row>
      <Row label="Scan interval">every {config.scanIntervalMinutes} min</Row>
      <Row label="Daily digest">{config.digestHourUtc}:00 UTC</Row>
      <Row label="Watchlist TTL">{config.watchlistTtlHours}h</Row>
      <Row label="Watchlist cap">{config.watchlistMaxTracked.toLocaleString()} tokens</Row>
      <Row label="Daily cleanup">{config.cleanupHourUtc}:00 UTC</Row>
      <Row label="Snapshot retention">{config.snapshotRetentionDays}d</Row>
      <Row label="Stale token retention">{config.staleTokenRetentionDays}d</Row>
      <Row label="Outcome tracking">{config.outcomeTrackingHourUtc}:00 UTC</Row>
      <Row label="Telegram">
        <span className={`badge ${config.telegramConfigured ? "badge--on" : "badge--off"}`}>
          {config.telegramConfigured ? "Configured" : "Not configured"}
        </span>
      </Row>
    </dl>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="admin-config__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
