/**
 * New Pairs read side: the ranked list and one token's lite-page payload, built from
 * Postgres only. Nothing here calls an upstream; the worker jobs (newPairDiscover,
 * newPairMarket, newPairHolders) are the only writers.
 *
 * Every row carries the time each family of data was read (`at.market`, `at.holders`,
 * `at.top50`, `at.scored`) so the page can show its age and keep it ticking without
 * asking again.
 *
 * Names, symbols and logo URLs are creator-written text: passed through as data, and
 * escaped by the page that renders them.
 */

const db = require('./database');
const store = require('./newPairStore');
const { getFloors } = require('./newPairMarket');
const { PARAMS } = require('./newPairScore');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOWS = { '3d': 3 * DAY, '7d': 7 * DAY, '14d': 14 * DAY };
const DEFAULT_WINDOW = '7d';
const LIST_CAP = 300;
// A top-50 sample older than this is shown as stale (it stops counting at 36h)
const TOP50_STALE_MS = 14 * HOUR;
const HISTORY_ROWS = 30;

const pool = () => { if (!db.pool) throw new Error('Database not available'); return db.pool; };
const iso = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => (v == null ? null : Number(v));

// What a listed token is: found, above the floors at some point, scored, authorities off
const LISTED = `t.status = 'active' AND t.unlisted_reason IS NULL AND NOT t.hidden AND t.score IS NOT NULL`;
const SELECT = `
  SELECT t.*, c.mint_address IS NOT NULL AS curated, COALESCE(c.is_emerging_cult, FALSE) AS emerging_cult,
    s.id AS sample_id, s.taken_at AS sample_at, s.holder_count AS sample_holders, s.dust_count AS sample_dust,
    s.top1_pct, s.top10_pct, s.top50_pct, s.dev_pct, s.retention12, s.new_in, s.exits
  FROM newpair_tokens t
  LEFT JOIN curated_tokens c ON c.mint_address = t.mint_address
  LEFT JOIN LATERAL (
    SELECT * FROM newpair_holder_samples h WHERE h.token_id = t.id AND h.complete ORDER BY h.taken_at DESC LIMIT 1
  ) s ON TRUE`;

/** One stored row → the public shape. */
function shapeRow(r, now) {
  const parts = r.score_parts || {};
  const s24 = r.market?.stats?.['24h'] || {};
  const sampleAt = r.sample_at ? new Date(r.sample_at).getTime() : null;
  const sampleCounts = sampleAt != null && now - sampleAt <= PARAMS.sampleMaxAgeMs;
  const volume = s24.buyVolume != null || s24.sellVolume != null ? (s24.buyVolume || 0) + (s24.sellVolume || 0) : null;
  const flags = [];
  if (r.rugged) flags.push('rugged');
  for (const [k, v] of Object.entries(parts.riskParts || {})) if (k !== 'rug' && v < 1) flags.push(k);
  return {
    mint: r.mint_address,
    name: r.name, symbol: r.symbol, logo: r.logo_uri,
    launchpad: r.launchpad, graduatedAt: iso(r.graduated_at), graduatedSource: r.graduated_source,
    score: num(r.score),
    scoreState: r.holders_pending || !sampleCounts ? 'holders_pending' : now - sampleAt > TOP50_STALE_MS ? 'holders_stale' : 'full',
    confidence: parts.confidence ?? null, risk: parts.risk ?? null, coverage: parts.coverage ?? null,
    terms: parts.terms || {}, riskParts: parts.riskParts || {},
    price: r.price_usd, marketCap: r.mcap, liquidity: r.liquidity, volume24h: volume,
    priceChange24h: s24.priceChange ?? null,
    drawdown: r.peak_mcap > 0 && r.mcap != null ? Math.max(0, Math.round((1 - r.mcap / r.peak_mcap) * 1000) / 1000) : null,
    holders: r.holder_count, holdersChange24h: parts.growth24 ?? null, holdersSource: 'jupiter',
    holdersExact: sampleAt != null ? r.sample_holders : null,
    top10Pct: sampleAt != null ? num(r.top10_pct) : null,
    top50Pct: sampleAt != null ? num(r.top50_pct) : null,
    devPct: sampleAt != null ? num(r.dev_pct) : null,
    retention12h: sampleAt != null ? num(r.retention12) : null,
    flags, rugged: !!r.rugged, curated: !!r.curated, emergingCult: !!r.emerging_cult,
    at: { market: iso(r.market_at), holders: iso(r.holders_at), top50: iso(r.sample_at), scored: iso(r.scored_at) },
  };
}

/** The ranked list for a window ('3d' | '7d' | '14d'): best score first, at most 300. */
async function buildList(windowKey = DEFAULT_WINDOW, { now = Date.now() } = {}) {
  const span = WINDOWS[windowKey];
  if (!span) throw new Error(`Unknown window ${windowKey}`);
  await store.ensureSchema();
  const since = now - span;
  const [{ rows }, count, floors] = await Promise.all([
    pool().query(`${SELECT} WHERE ${LISTED} AND t.graduated_at >= to_timestamp($1 / 1000.0)
      ORDER BY t.score DESC, t.id LIMIT $2`, [since, LIST_CAP]),
    pool().query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.rugged)::int AS rugged, MAX(t.scored_at) AS scored_at
      FROM newpair_tokens t WHERE ${LISTED} AND t.graduated_at >= to_timestamp($1 / 1000.0)`, [since]),
    getFloors(),
  ]);
  return {
    window: windowKey,
    scoredAt: iso(count.rows[0].scored_at),
    generatedAt: new Date(now).toISOString(),
    total: count.rows[0].total, rugged: count.rows[0].rugged, shown: rows.length,
    floors: { marketCap: floors.minMcap, liquidity: floors.minLiquidity },
    // For the score breakdown the tab draws from each row's terms
    weights: PARAMS.weights,
    tokens: rows.map((r, i) => ({ rank: i + 1, ...shapeRow(r, now) })),
  };
}

/**
 * One token for the lite page.
 * @returns {Promise<null | {curated: true, mint} | Object>} null when the finder does not list the mint
 */
async function buildToken(mint, { now = Date.now() } = {}) {
  await store.ensureSchema();
  const { rows } = await pool().query(`${SELECT} WHERE t.mint_address = $1`, [mint]);
  const r = rows[0];
  // A curated token has its own full page, whether or not the finder also lists it
  if (r?.curated || (!r && await db.isTokenAllowed(mint).catch(() => false))) return { curated: true, mint };
  if (!r || r.status !== 'active' || r.unlisted_reason || r.hidden || r.score == null) return null;

  const [history, entries, prevEntries, series, rank] = await Promise.all([
    pool().query(`SELECT taken_at, holder_count, dust_count, top1_pct, top10_pct, top50_pct, dev_pct, retention12, new_in, exits, complete
      FROM newpair_holder_samples WHERE token_id = $1 ORDER BY taken_at DESC LIMIT $2`, [r.id, HISTORY_ROWS]),
    r.sample_id ? pool().query('SELECT rank, wallet, amount FROM newpair_holder_entries WHERE sample_id = $1 ORDER BY rank', [r.sample_id]) : { rows: [] },
    r.sample_id ? pool().query(
      `SELECT e.wallet, e.amount, s.taken_at FROM newpair_holder_entries e JOIN newpair_holder_samples s ON s.id = e.sample_id
       WHERE s.id = (SELECT id FROM newpair_holder_samples WHERE token_id = $1 AND complete AND id <> $2 ORDER BY taken_at DESC LIMIT 1)`,
      [r.id, r.sample_id]) : { rows: [] },
    pool().query('SELECT at, holder_count, mcap, price_usd FROM newpair_points WHERE token_id = $1 ORDER BY at', [r.id]),
    pool().query(`SELECT COUNT(*)::int + 1 AS rank FROM newpair_tokens t
      WHERE ${LISTED} AND t.graduated_at >= to_timestamp($1 / 1000.0) AND (t.score > $2 OR (t.score = $2 AND t.id < $3))`,
      [now - WINDOWS['14d'], r.score, r.id]),
  ]);

  // Shares: the sample stores the top 50's share of supply, so each wallet's share
  // follows from its part of the top 50's total
  const top = entries.rows.slice(0, 50);
  const topTotal = top.reduce((s, e) => s + Number(e.amount), 0);
  const share = (amount) => (topTotal > 0 && r.top50_pct != null ? Math.round((Number(amount) / topTotal) * Number(r.top50_pct) * 1000) / 1000 : null);
  const prev = new Map(prevEntries.rows.map(e => [e.wallet, Number(e.amount)]));
  const hasPrev = prevEntries.rows.length > 0;
  const holders = top.map(e => {
    const before = prev.get(e.wallet);
    const amount = Number(e.amount);
    return {
      rank: e.rank, wallet: e.wallet, pct: share(e.amount),
      // Change in balance since the previous sample; null when there is none to compare
      changePct: hasPrev && before > 0 ? Math.round((amount / before - 1) * 1000) / 10 : null,
      isNew: hasPrev && !(before * 10 >= amount),
    };
  });
  const current = new Set(top.map(e => e.wallet));
  const exited = hasPrev ? prevEntries.rows
    .map(e => ({ wallet: e.wallet, amount: Number(e.amount) })).sort((a, b) => b.amount - a.amount).slice(0, 10)
    .filter(e => !current.has(e.wallet)).map(e => e.wallet) : [];

  return {
    curated: false,
    token: { rank: rank.rows[0].rank, ...shapeRow(r, now) },
    generatedAt: new Date(now).toISOString(),
    weights: PARAMS.weights,
    topHolders: {
      sampledAt: iso(r.sample_at),
      previousSampledAt: hasPrev ? iso(prevEntries.rows[0].taken_at) : null,
      holders, exited,
    },
    samples: history.rows.map(h => ({
      at: iso(h.taken_at), holders: h.holder_count, dust: h.dust_count, top1Pct: num(h.top1_pct), top10Pct: num(h.top10_pct),
      top50Pct: num(h.top50_pct), devPct: num(h.dev_pct), retention12h: num(h.retention12), newIn: h.new_in, exits: h.exits, complete: h.complete,
    })),
    series: series.rows.map(p => ({ t: new Date(p.at).getTime(), holders: p.holder_count, marketCap: p.mcap, price: p.price_usd })),
  };
}

module.exports = { buildList, buildToken, shapeRow, SELECT, WINDOWS, DEFAULT_WINDOW, LIST_CAP };
