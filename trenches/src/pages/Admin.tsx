import { useState } from "react";
import { AdminOverview } from "../components/admin/AdminOverview";
import { AdminMonitoring } from "../components/admin/AdminMonitoring";
import { AdminLiveFeed } from "../components/admin/AdminLiveFeed";
import { AdminUsers } from "../components/admin/AdminUsers";
import { AdminConfig } from "../components/admin/AdminConfig";

type AdminSection = "overview" | "monitoring" | "live-feed" | "users" | "config";

const SECTIONS: { id: AdminSection; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "monitoring", label: "Monitoring" },
  { id: "live-feed", label: "Live Feed" },
  { id: "users", label: "Users" },
  { id: "config", label: "Config" },
];

/**
 * Everything here is served from /admin/* on the API, which 403s anyone not in
 * ADMIN_WALLET_ADDRESSES (see apps/api/src/routes/admin.ts) - this page is only reachable in the
 * UI at all because Navbar hides its nav link from non-admins, but the real enforcement is
 * server-side, not this check.
 */
export function Admin() {
  const [section, setSection] = useState<AdminSection>("overview");

  return (
    <div className="admin-page">
      <div className="dashboard__header">
        <h2>Admin Panel</h2>
      </div>

      <nav className="admin-subtabs">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`admin-subtab ${section === s.id ? "admin-subtab--active" : ""}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="admin-section">
        {section === "overview" && <AdminOverview />}
        {section === "monitoring" && <AdminMonitoring />}
        {section === "live-feed" && <AdminLiveFeed />}
        {section === "users" && <AdminUsers />}
        {section === "config" && <AdminConfig />}
      </div>
    </div>
  );
}
