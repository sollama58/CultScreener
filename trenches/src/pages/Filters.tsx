import { useEffect, useState } from "react";
import { createFilter, deleteFilter, getConfig, listFilters, updateFilter } from "../api/client";
import type { FilterInput, PublicConfig, UserFilter } from "../api/types";
import { FilterForm } from "../components/FilterForm";

// Mirrors the server's own defaults (packages/core/src/config/env.ts + scanBand()) - used only if
// GET /config is unreachable, so the filter form still has sane bounds instead of being unusable.
const FALLBACK_CONFIG: PublicConfig = {
  mcapFilterMin: 10_000,
  mcapFilterMax: 1_000_000,
  scanBandMin: 5_000,
  scanBandMax: 1_500_000,
};

export function Filters() {
  const [filters, setFilters] = useState<UserFilter[]>([]);
  const [config, setConfig] = useState<PublicConfig>(FALLBACK_CONFIG);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);

  const refresh = () => listFilters().then(setFilters);

  useEffect(() => {
    Promise.all([
      refresh(),
      getConfig()
        .then(setConfig)
        .catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const handleCreate = async (input: Partial<FilterInput>) => {
    await createFilter(input);
    setEditingId(null);
    await refresh();
  };

  const handleUpdate = async (id: string, input: Partial<FilterInput>) => {
    await updateFilter(id, input);
    setEditingId(null);
    await refresh();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this filter? You'll stop getting matches for it.")) return;
    await deleteFilter(id);
    await refresh();
  };

  const handleToggleActive = async (filter: UserFilter) => {
    await updateFilter(filter.id, { isActive: !filter.isActive });
    await refresh();
  };

  if (loading) return <p className="empty-state">Loading filters…</p>;

  return (
    <div className="filters-page">
      <div className="dashboard__header">
        <h2>Filters</h2>
        {editingId === null && (
          <button className="btn btn--primary" onClick={() => setEditingId("new")}>
            + New filter
          </button>
        )}
      </div>

      <div className="info-callout">
        <h3>Two checks run automatically, before your filters below ever come into play</h3>
        <ul>
          <li>
            <strong>Safety screen (always on - you can't turn this off):</strong> a token is rejected outright
            if its creator can still mint new supply or freeze holders' wallets, or if its liquidity hasn't
            been locked or burned. This applies to every token, for every user, no exceptions.
          </li>
          <li>
            <strong>Market cap range:</strong> TrenchScanner only ever tracks tokens roughly between{" "}
            <strong>${config.scanBandMin.toLocaleString()}</strong> and{" "}
            <strong>${config.scanBandMax.toLocaleString()}</strong> market cap (we target $
            {config.mcapFilterMin.toLocaleString()}–${config.mcapFilterMax.toLocaleString()}, with some buffer
            on each side so a token isn't dropped the instant it dips just below or pops just above). A token
            outside that wider range never shows up here, so your own market cap filter below can't be set
            beyond it either.
          </li>
        </ul>
        <p className="info-callout__note">
          Everything below this is entirely optional. Leaving a field blank means it just isn't checked - it's
          never treated as a strike against a token.
        </p>
      </div>

      {editingId === "new" && (
        <div className="filter-card filter-card--editing">
          <FilterForm config={config} onSave={handleCreate} onCancel={() => setEditingId(null)} />
        </div>
      )}

      {filters.length === 0 && editingId === null && (
        <p className="empty-state">No filters yet - create one above to start matching tokens.</p>
      )}

      <div className="filter-list">
        {filters.map((filter) =>
          editingId === filter.id ? (
            <div key={filter.id} className="filter-card filter-card--editing">
              <FilterForm
                initial={filter}
                config={config}
                onSave={(input) => handleUpdate(filter.id, input)}
                onCancel={() => setEditingId(null)}
              />
            </div>
          ) : (
            <div key={filter.id} className="filter-card">
              <div className="filter-card__header">
                <h3>{filter.name}</h3>
                <span className={`badge ${filter.isActive ? "badge--on" : "badge--off"}`}>
                  {filter.isActive ? "Active" : "Paused"}
                </span>
              </div>
              <p className="filter-card__summary">
                ${filter.mcapMin.toLocaleString()} – ${filter.mcapMax.toLocaleString()} mcap
                {filter.minScore != null && ` · min score ${filter.minScore}`}
                {filter.narrativeKeywords.length > 0 && ` · keywords: ${filter.narrativeKeywords.join(", ")}`}
              </p>
              <div className="filter-card__actions">
                <button className="btn" onClick={() => setEditingId(filter.id)}>
                  Edit
                </button>
                <button className="btn" onClick={() => void handleToggleActive(filter)}>
                  {filter.isActive ? "Pause" : "Resume"}
                </button>
                <button className="btn btn--danger" onClick={() => void handleDelete(filter.id)}>
                  Delete
                </button>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
