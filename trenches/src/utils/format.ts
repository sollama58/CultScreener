// Shared display formatters - originally lived only in TokenCard.tsx, extracted once the admin
// pages needed the exact same mcap/percentage/age formatting for a second table.

export function fmtUsd(n: number | null | undefined): string {
  // `undefined` as well as null: this app's types.ts is hand-written, so a field the API stops
  // sending (or never sent) arrives as undefined and would otherwise throw on .toFixed here —
  // taking the whole card down rather than rendering one dash.
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

export function fmtPct(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}%`;
}

export function fmtAge(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
