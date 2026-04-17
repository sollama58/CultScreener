/**
 * Shared constants used across routes and worker jobs.
 * Centralised here to keep definitions in sync and prevent drift.
 */

// ── Burn / dead wallets ─────────────────────────────────────────────────────
// Accounts that permanently remove tokens from circulation.
// Used during holder classification to flag and exclude burnt supply.
const BURN_WALLETS = new Set([
  '1nc1nerator11111111111111111111111111111111',  // Solana incinerator (most common)
  '1111111111111111111111111111111111111111111',   // Null address (44 ones)
  'burnedFi11111111111111111111111111111111111',   // burnedFi vanity address
]);

// ── LP program IDs ───────────────────────────────────────────────────────────
// On-chain programs that own AMM liquidity pool accounts.
// Token accounts owned by these programs are LP positions, not personal holdings.
const LP_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',  // Raydium CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',  // Meteora Pools
  '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',  // Lifinity v2
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',  // Orca Token Swap v2
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun AMM (bonding curve)
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // PumpSwap AMM
]);

// ── Diamond hands distribution buckets ──────────────────────────────────────
// Time thresholds used to categorise holders by how long they have held.
// Percentages are computed as: (wallets with holdTime >= bucket.ms) / total wallets.
// Shared between the API routes, the BullMQ worker, and the cultify routes so
// all three always agree on bucket boundaries and keys.
const DIAMOND_HANDS_BUCKETS = [
  { key: '6h',  label: '>6h',  ms: 6   * 3_600_000 },
  { key: '24h', label: '>24h', ms: 24  * 3_600_000 },
  { key: '3d',  label: '>3d',  ms: 3   * 86_400_000 },
  { key: '1w',  label: '>1w',  ms: 7   * 86_400_000 },
  { key: '1m',  label: '>1m',  ms: 30  * 86_400_000 },
  { key: '3m',  label: '>3m',  ms: 90  * 86_400_000 },
  { key: '6m',  label: '>6m',  ms: 180 * 86_400_000 },
  { key: '9m',  label: '>9m',  ms: 270 * 86_400_000 },
];

module.exports = { BURN_WALLETS, LP_PROGRAMS, DIAMOND_HANDS_BUCKETS };
