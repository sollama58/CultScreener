/**
 * Holder count history.
 *
 * Every full holder snapshot (services/holderPipeline.js) records one point in
 * holder_count_points, so the count history is exactly as fine as the snapshots
 * we already pay for (curated tokens: every HOLDER_SNAPSHOT_REFRESH_HOURS) and
 * costs no extra Helius calls.
 *
 * What a point counts:
 *   holders       unique owner wallets with a balance; burn and LP wallets excluded
 *   dust          of those, wallets holding less than HOLDER_DUST_USD (default $1)
 *                 at the token's price when the snapshot was taken
 *   legacy_count  the count under the pre-2026-10-07 definition (token accounts with
 *                 a balance). Older rows imported from holder_history, and CoinGecko
 *                 imports, only have this column.
 *
 * Charts use `holders` (or holders - dust). Rows that only have legacy_count are
 * drawn as an estimate before the first real point, scaled by the ratio the first
 * real point shows between the two definitions, so the line stays continuous.
 *
 * The pure functions (dustThresholdRaw, countHolders, buildHolderSeries) are unit
 * tested in holderCounts.test.js; the SQL is at the bottom.
 */

const { toBigInt } = require('./holderSnapshot');

const envNum = (name, fallback) => {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

const DUST_USD = envNum('HOLDER_DUST_USD', 1);
// Without a price, a wallet holding under a millionth of supply counts as dust
// ($1 at a $1M market cap).
const DUST_SUPPLY_DIVISOR = 1_000_000n;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RANGES = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, all: Infinity };
const CHANGE_WINDOWS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const MAX_CHART_POINTS = 500;
const METRICS = ['holders', 'real'];

// ── Pure math ────────────────────────────────────────────────────────────────

/**
 * Raw token amount under which a wallet counts as dust.
 * @returns {bigint|null} null when nothing is known to base it on
 */
function dustThresholdRaw({ priceUsd, decimals, supplyRaw, dustUsd = DUST_USD } = {}) {
  if (!(dustUsd > 0)) return null;
  const price = Number(priceUsd);
  if (price > 0 && Number.isInteger(decimals) && decimals >= 0) {
    const raw = Math.ceil((dustUsd / price) * Math.pow(10, decimals));
    if (Number.isFinite(raw) && raw > 0) return BigInt(raw);
  }
  const supply = toBigInt(supplyRaw);
  if (supply > 0n) return supply / DUST_SUPPLY_DIVISOR || 1n;
  return null;
}

/**
 * Count holders in an aggregated holder list (one row per wallet, from
 * aggregateHolders) and how many of them are dust.
 *
 * @param {Array<{wallet, amount: bigint}>} holders
 * @param {{exclude?: Set<string>, dustRaw?: bigint|null}} opts
 * @returns {{holders: number, dust: number|null}}
 */
function countHolders(holders, { exclude = new Set(), dustRaw = null } = {}) {
  let count = 0;
  let dust = 0;
  for (const h of holders || []) {
    if (!h || exclude.has(h.wallet)) continue;
    const amount = toBigInt(h.amount);
    if (amount <= 0n) continue;
    count++;
    if (dustRaw != null && amount < dustRaw) dust++;
  }
  return { holders: count, dust: dustRaw != null ? dust : null };
}

const toMs = t => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : new Date(t).getTime());
const numOrNull = v => (v == null ? null : Number(v));

function valueOf(p, metric) {
  if (p.holders == null) return null;
  if (metric === 'holders') return p.holders;
  return p.dust == null ? null : p.holders - p.dust;
}

/**
 * One metric's measured points plus estimates for the time before them.
 * @returns {{actual: Array<{t, v, complete}>, est: Array<{t, v}>}}
 */
function seriesFor(points, metric) {
  const actual = [];
  for (const p of points) {
    const v = valueOf(p, metric);
    if (v != null) actual.push({ t: p.t, v, complete: p.complete !== false });
  }
  const est = [];
  const anchor = points.find(p => valueOf(p, metric) != null && p.legacy > 0);
  const firstT = actual.length ? actual[0].t : Infinity;
  if (anchor || actual.length === 0) {
    const ratio = anchor ? valueOf(anchor, metric) / anchor.legacy : null;
    for (const p of points) {
      if (p.t >= firstT) break;
      if (!(p.legacy > 0)) continue;
      // With no real point at all there is nothing to scale by; show the legacy
      // count itself, which is what the chart used to show.
      const v = ratio != null ? Math.round(p.legacy * ratio) : (metric === 'holders' ? p.legacy : null);
      if (v != null) est.push({ t: p.t, v });
    }
  }
  return { actual, est };
}

// Latest value at or before time t across estimates then actuals (both sorted).
function valueAt(list, t) {
  let lo = 0, hi = list.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= t) { found = list[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function changesFor({ actual, est }) {
  const latest = actual[actual.length - 1] || null;
  const out = {};
  for (const [key, win] of Object.entries(CHANGE_WINDOWS)) {
    if (!latest) { out[key] = null; continue; }
    const target = latest.t - win;
    // A baseline must be near the target: after a gap in snapshots, the point
    // before the gap would describe a different (longer) window.
    // Estimates come from daily rows, so they get at least a day and a half.
    let base = valueAt(actual, target);
    let approx = false;
    if (!base) {
      base = valueAt(est, target);
      approx = !!base;
    }
    const tolerance = Math.max(approx ? 36 * HOUR : 6 * HOUR, win * 0.25);
    if (!base || target - base.t > tolerance) { out[key] = null; continue; }
    const delta = latest.v - base.v;
    out[key] = {
      delta,
      pct: base.v > 0 ? Math.round((delta / base.v) * 10000) / 100 : null,
      from: Math.floor(base.t / 1000),
      approx,
    };
  }
  return out;
}

// Holder velocity for the home table: how fast the holder count moved over the last day,
// from two snapshot points about 24h apart. Levels -2..2 map to ↓↓ ↓ – ↑ ↑↑.
// A move is only "fast" at 2% a day, and smaller than 0.25% (or 3 wallets) counts as flat,
// which keeps snapshot-to-snapshot noise on big holder bases from reading as a trend.
const VELOCITY = {
  WINDOW: DAY,
  // Baseline must be within this of 24h before the latest point
  TOLERANCE: 6 * HOUR,
  // Latest point older than this says nothing about now
  MAX_AGE: 36 * HOUR,
  FAST_PCT: 2,
  MOVE_PCT: 0.25,
  MIN_DELTA: 3,
};

/**
 * @param {{holders, takenAt, baseHolders, baseAt}} p latest and ~24h-earlier counts
 * @returns {{level: number|null, delta?: number, pct?: number, hours?: number}}
 *   level null: too little history to say
 */
function holderVelocity(p, now = Date.now()) {
  if (!p || !(p.holders > 0) || !Number.isFinite(p.takenAt)) return { level: null };
  if (now - p.takenAt > VELOCITY.MAX_AGE) return { level: null };
  if (!(p.baseHolders > 0) || !Number.isFinite(p.baseAt)) return { level: null };
  const span = p.takenAt - p.baseAt;
  if (span < VELOCITY.WINDOW || span - VELOCITY.WINDOW > VELOCITY.TOLERANCE) return { level: null };
  const delta = p.holders - p.baseHolders;
  const pct = (delta / p.baseHolders) * 100;
  let level = 0;
  if (Math.abs(delta) >= VELOCITY.MIN_DELTA && Math.abs(pct) >= VELOCITY.MOVE_PCT) {
    level = (Math.abs(pct) >= VELOCITY.FAST_PCT ? 2 : 1) * Math.sign(delta);
  }
  return { level, delta, pct: Math.round(pct * 100) / 100, hours: Math.round(span / HOUR) };
}

// Keep at most `max` points: the last point of each equal-width time bucket.
function downsample(list, max = MAX_CHART_POINTS) {
  if (list.length <= max) return list;
  const t0 = list[0].t;
  const width = (list[list.length - 1].t - t0) / max || 1;
  const out = [];
  let bucket = -1;
  for (const p of list) {
    const b = Math.min(max - 1, Math.floor((p.t - t0) / width));
    if (b === bucket) out[out.length - 1] = p;
    else { out.push(p); bucket = b; }
  }
  return out;
}

/**
 * Turn stored points into the chart payload. Pure.
 *
 * @param {Array} rows holder_count_points rows (any order)
 * @param {{range?: string, now?: number}} opts
 */
function buildHolderSeries(rows, { range = '30d', now = Date.now() } = {}) {
  const points = (rows || [])
    .map(r => ({
      t: toMs(r.taken_at ?? r.t),
      holders: numOrNull(r.holders),
      dust: numOrNull(r.dust),
      legacy: numOrNull(r.legacy_count ?? r.legacy),
      complete: r.complete !== false,
      source: r.source || null,
    }))
    .filter(p => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);

  const span = RANGES[range] ?? RANGES['30d'];
  const since = span === Infinity ? -Infinity : now - span;
  const inRange = p => p.t >= since;
  const sec = t => Math.floor(t / 1000);

  const series = {};
  for (const metric of METRICS) {
    const s = seriesFor(points, metric);
    series[metric] = {
      // [time (unix seconds), value, complete (0 = capped snapshot, a lower bound)]
      actual: downsample(s.actual.filter(inRange)).map(p => [sec(p.t), p.v, p.complete ? 1 : 0]),
      est: downsample(s.est.filter(inRange)).map(p => [sec(p.t), p.v]),
      changes: changesFor(s),
    };
  }

  let current = null;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p.holders != null) {
      current = {
        holders: p.holders,
        real: p.dust != null ? p.holders - p.dust : null,
        dust: p.dust,
        at: sec(p.t),
        complete: p.complete,
        source: p.source,
      };
      break;
    }
  }

  return { range: RANGES[range] != null ? range : '30d', current, series };
}

// ── Storage ──────────────────────────────────────────────────────────────────

function db() {
  return require('./database');
}

function pool() {
  const { pool } = db();
  if (!pool) throw new Error('Database not available');
  return pool;
}

/** Insert or replace the point at (mint, takenAt). */
async function recordPoint(mint, { takenAt, holders = null, dust = null, legacyCount = null, complete = true, source }) {
  await pool().query(
    `INSERT INTO holder_count_points (mint_address, taken_at, holders, dust, legacy_count, complete, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (mint_address, taken_at) DO UPDATE SET
       holders = EXCLUDED.holders, dust = EXCLUDED.dust, legacy_count = EXCLUDED.legacy_count,
       complete = EXCLUDED.complete, source = EXCLUDED.source`,
    [mint, new Date(takenAt), holders, dust, legacyCount, complete, source]
  );
  await clearSeriesCache(mint);
}

/**
 * Legacy-only points (CoinGecko imports) never replace anything already stored,
 * and are only kept for times before our own first measured point.
 * @param {Array<{takenAt: number, count: number}>} list
 * @returns {number} rows inserted
 */
async function importLegacyPoints(mint, list, source) {
  const { rows } = await pool().query(
    `SELECT MIN(taken_at) AS first FROM holder_count_points WHERE mint_address = $1 AND holders IS NOT NULL`,
    [mint]
  );
  const first = rows[0]?.first ? new Date(rows[0].first).getTime() : Infinity;
  const keep = (list || []).filter(p => Number.isFinite(p.takenAt) && p.takenAt < first && p.count > 0);
  if (keep.length === 0) return 0;
  const res = await pool().query(
    `INSERT INTO holder_count_points (mint_address, taken_at, legacy_count, complete, source)
     SELECT $1, t, c, TRUE, $4 FROM unnest($2::timestamptz[], $3::int[]) AS x(t, c)
     ON CONFLICT (mint_address, taken_at) DO NOTHING`,
    [mint, keep.map(p => new Date(p.takenAt)), keep.map(p => Math.round(p.count)), source]
  );
  await clearSeriesCache(mint);
  return res.rowCount;
}

async function getPoints(mint) {
  const { rows } = await pool().query(
    `SELECT taken_at, holders, dust, legacy_count, complete, source
       FROM holder_count_points WHERE mint_address = $1
      ORDER BY taken_at DESC LIMIT 20000`,
    [mint]
  );
  return rows.reverse();
}

/** Latest measured point per mint: mint → {holders, dust, takenAt, complete}. */
async function getLatestPoints(mints) {
  if (!mints || mints.length === 0) return {};
  const { rows } = await pool().query(
    `SELECT DISTINCT ON (mint_address) mint_address, taken_at, holders, dust, complete
       FROM holder_count_points
      WHERE mint_address = ANY($1) AND holders IS NOT NULL
      ORDER BY mint_address, taken_at DESC`,
    [mints]
  );
  const out = {};
  for (const r of rows) {
    out[r.mint_address] = { holders: r.holders, dust: r.dust, takenAt: new Date(r.taken_at).getTime(), complete: r.complete };
  }
  return out;
}

/**
 * Holder counts for display (home tables, token hero): the Redis value when warm,
 * else the latest stored point, which also re-warms Redis. A capped snapshot's
 * point is a lower bound, but still far closer than the 100-page DAS count the
 * callers would otherwise fetch and show.
 * Mints Postgres could not resolve are remembered for MISS_TTL_MS so a table that
 * keeps asking (the home page's holder retry) does not query Postgres every time;
 * the Redis read is still made each call, so a count the worker writes shows at once.
 * @returns {Object<string, number>} mint → holders
 */
const MISS_TTL_MS = 60 * 1000;
async function getDisplayCounts(mints) {
  const { cache, TTL } = require('./cache');
  const out = {};
  const missing = [];
  const list = mints || [];
  if (list.length === 0) return out;
  // One MGET for the warm counts plus the negative-cache markers
  const values = await cache.mget([
    ...list.map(mint => `holder-total:${mint}`),
    ...list.map(mint => `holder-total-miss:${mint}`),
  ]).catch(() => []);
  list.forEach((mint, i) => {
    const v = values[i];
    if (typeof v === 'number' && v > 0) out[mint] = v;
    else if (!values[list.length + i]) missing.push(mint);
  });
  if (missing.length > 0 && db().pool) {
    const latest = await getLatestPoints(missing).catch(() => null);
    if (latest) {
      for (const mint of missing) {
        const p = latest[mint];
        if (!p || !(p.holders > 0)) {
          await cache.set(`holder-total-miss:${mint}`, 1, MISS_TTL_MS).catch(() => {});
          continue;
        }
        out[mint] = p.holders;
        await cache.set(`holder-total:${mint}`, p.holders, TTL.HOLDER_COUNT).catch(() => {});
      }
    }
  }
  return out;
}

/**
 * Holder velocity per mint for the home table (see holderVelocity): the latest complete
 * point and the latest complete point at least 24h before it. One query for the page.
 * @returns {Object<string, {level, delta?, pct?, hours?}>} only mints with a latest point
 */
async function getHolderVelocity(mints, now = Date.now()) {
  if (!mints || mints.length === 0) return {};
  const { rows } = await pool().query(
    `WITH latest AS (
       SELECT DISTINCT ON (mint_address) mint_address, taken_at, holders
         FROM holder_count_points
        WHERE mint_address = ANY($1) AND holders IS NOT NULL AND complete
        ORDER BY mint_address, taken_at DESC
     )
     SELECT l.mint_address, l.taken_at, l.holders, b.taken_at AS base_at, b.holders AS base_holders
       FROM latest l
       LEFT JOIN LATERAL (
         SELECT taken_at, holders FROM holder_count_points p
          WHERE p.mint_address = l.mint_address AND p.holders IS NOT NULL AND p.complete
            AND p.taken_at <= l.taken_at - INTERVAL '24 hours'
          ORDER BY p.taken_at DESC LIMIT 1
       ) b ON TRUE`,
    [mints]
  );
  const out = {};
  for (const r of rows) {
    out[r.mint_address] = holderVelocity({
      holders: r.holders,
      takenAt: new Date(r.taken_at).getTime(),
      baseHolders: r.base_holders,
      baseAt: r.base_at ? new Date(r.base_at).getTime() : NaN,
    }, now);
  }
  return out;
}

async function clearSeriesCache(mint) {
  const { cache } = require('./cache');
  await Promise.all(Object.keys(RANGES).map(r => cache.delete(`holder-count:${mint}:${r}`).catch(() => {})));
  for (const days of [7, 30, 31, 90]) await cache.delete(`holder-history:${mint}:${days}`).catch(() => {});
}

/**
 * Daily rows in the old /holder-history shape ({recorded_date, holder_count},
 * newest first): the last point of each UTC day, real counts where we have them.
 */
async function getDailyHistory(mint, days = 30) {
  const { rows } = await pool().query(
    `SELECT DISTINCT ON (d) to_char(d, 'YYYY-MM-DD') AS recorded_date, COALESCE(holders, legacy_count) AS holder_count
       FROM (SELECT (taken_at AT TIME ZONE 'UTC')::date AS d, taken_at, holders, legacy_count
               FROM holder_count_points
              WHERE mint_address = $1 AND (holders IS NOT NULL OR legacy_count IS NOT NULL)) x
      ORDER BY d DESC, (holders IS NOT NULL) DESC, taken_at DESC
      LIMIT $2`,
    [mint, Math.min(Math.max(days, 1), 365)]
  );
  return rows;
}

module.exports = {
  DUST_USD,
  RANGES,
  dustThresholdRaw,
  countHolders,
  buildHolderSeries,
  recordPoint,
  importLegacyPoints,
  getPoints,
  getLatestPoints,
  getDisplayCounts,
  getDailyHistory,
  getHolderVelocity,
  holderVelocity,
  VELOCITY,
  clearSeriesCache,
  _test: { seriesFor, changesFor, downsample },
};
