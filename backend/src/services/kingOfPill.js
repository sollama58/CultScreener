/**
 * King of the Pill: the daily Diamond Hands score for every curated token and the
 * reign it decides. The math is in kotpScore.js (pure); this file is the I/O.
 *
 *   crown-king-of-pill (worker job, 00:20 UTC)
 *     scores every curated token from the stored diamond hands buckets, the holder
 *     count history and the token's age → diamond_hands_scores (one row per token
 *     per day) → applies the crowning rule → kotp_reigns
 *   getCurrentKing (API route)
 *     the open reign plus today's top contenders; never computes anything
 *
 * Reads only what the pipeline already stores: tokens.conviction_data (holder
 * buckets), conviction_meta (supply buckets, holder count, snapshot time),
 * tokens.pair_created_at and holder_count_points. No RPC.
 *
 * X's manual pick (app_settings.king_of_pill_mint) is handled by the routes as an
 * override; this module only knows the automatic King.
 */

const db = require('./database');
const { cache } = require('./cache');
const { DAY, PARAMS, scoreToken, pickKing } = require('./kotpScore');

const FEATURED_CACHE_KEY = 'king-of-pill:featured';
const MAX_CONTENDERS = 3;

function pool() {
  if (!db.pool) throw new Error('Database not available');
  return db.pool;
}

let schemaReady = null;
/** Create the two tables on first use. Self-contained so database.js stays untouched. */
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool().query(`
      CREATE TABLE IF NOT EXISTS diamond_hands_scores (
        mint_address VARCHAR(44) NOT NULL,
        score_date DATE NOT NULL,
        score NUMERIC(6,2),
        core NUMERIC(6,4),
        eligible BOOLEAN NOT NULL DEFAULT TRUE,
        components JSONB,
        computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        PRIMARY KEY (mint_address, score_date)
      );
      CREATE INDEX IF NOT EXISTS idx_diamond_hands_scores_date
        ON diamond_hands_scores(score_date DESC, score DESC NULLS LAST);
      CREATE TABLE IF NOT EXISTS kotp_reigns (
        id SERIAL PRIMARY KEY,
        mint_address VARCHAR(44) NOT NULL,
        crowned_on DATE NOT NULL,
        ended_on DATE,
        score NUMERIC(6,2),
        reason VARCHAR(32),
        UNIQUE (mint_address, crowned_on)
      );
      CREATE INDEX IF NOT EXISTS idx_kotp_reigns_open ON kotp_reigns(crowned_on DESC) WHERE ended_on IS NULL;
    `).catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

const dayIndex = d => Math.floor(new Date(d).getTime() / DAY);
const isoDate  = d => new Date(d).toISOString().slice(0, 10);
const num = v => (v == null ? null : Number(v));

// ── Inputs ──────────────────────────────────────────────────────────────────

/**
 * Holder count now and about 30 days ago for each mint, from holder_count_points.
 * Both ends use the same column (holders when the older point has one, else the
 * legacy token-account count) so a definition change can't read as churn. The
 * older point is the one nearest 30 days back, and at least 7 days back.
 */
async function getHolderTrend(mints, now) {
  if (!mints.length) return {};
  const { rows } = await pool().query(
    `WITH latest AS (
       SELECT DISTINCT ON (mint_address) mint_address, holders, legacy_count
         FROM holder_count_points WHERE mint_address = ANY($1) AND complete
        ORDER BY mint_address, taken_at DESC),
     past AS (
       SELECT DISTINCT ON (mint_address) mint_address, holders, legacy_count, taken_at
         FROM holder_count_points
        WHERE mint_address = ANY($1) AND complete AND taken_at <= $2::timestamptz - INTERVAL '7 days'
        ORDER BY mint_address, ABS(EXTRACT(EPOCH FROM (taken_at - ($2::timestamptz - INTERVAL '30 days'))))),
     first AS (
       SELECT mint_address, MIN(taken_at) AS first_at FROM holder_count_points
        WHERE mint_address = ANY($1) GROUP BY mint_address)
     SELECT l.mint_address, l.holders AS now_holders, l.legacy_count AS now_legacy,
            p.holders AS past_holders, p.legacy_count AS past_legacy, f.first_at
       FROM latest l LEFT JOIN past p USING (mint_address) LEFT JOIN first f USING (mint_address)`,
    [mints, new Date(now)]
  );
  const out = {};
  for (const r of rows) {
    let holdersNow = null, holdersMonthAgo = null;
    if (r.now_holders != null && r.past_holders != null) { holdersNow = num(r.now_holders); holdersMonthAgo = num(r.past_holders); }
    else if (r.now_legacy != null && r.past_legacy != null) { holdersNow = num(r.now_legacy); holdersMonthAgo = num(r.past_legacy); }
    out[r.mint_address] = { holdersNow, holdersMonthAgo, firstPointAt: r.first_at ? new Date(r.first_at).getTime() : null };
  }
  return out;
}

/** Core index stored about 7 days ago (6 to 8 days back, nearest 7), per mint. */
async function getCoreWeekAgo(mints, today) {
  if (!mints.length) return {};
  const { rows } = await pool().query(
    `SELECT DISTINCT ON (mint_address) mint_address, core
       FROM diamond_hands_scores
      WHERE mint_address = ANY($1) AND core IS NOT NULL
        AND score_date BETWEEN $2::date - 8 AND $2::date - 6
      ORDER BY mint_address, ABS(score_date - ($2::date - 7))`,
    [mints, today]
  );
  const out = {};
  for (const r of rows) out[r.mint_address] = num(r.core);
  return out;
}

/**
 * Everything scoreToken needs for one curated token, from the rows we already hold.
 * Age is measured from the pair creation when known, else from the earliest the
 * site has seen the token (first holder count point or curated added_at).
 */
function buildInput(curated, row, trend, coreWeekAgo, now) {
  const meta = row?.conviction_meta || {};
  const candidates = [row?.pair_created_at, trend?.firstPointAt, curated.addedAt]
    .map(v => (v ? new Date(v).getTime() : NaN)).filter(Number.isFinite);
  const bornAt = candidates.length ? Math.min(...candidates) : null;
  // Freshness is the later of the snapshot and the last full recompute: a snapshot the
  // pre-check verified as unchanged keeps its taken_at, but its diamond hands are
  // re-stored every hour while it is current.
  const snapshotAt = Math.max(
    meta.snapshotAt ? Number(meta.snapshotAt) : 0,
    row?.conviction_computed_at ? new Date(row.conviction_computed_at).getTime() : 0) || null;
  const holders = meta.holderCount != null ? Number(meta.holderCount) : trend?.holdersNow ?? null;
  return {
    distribution: row?.conviction_data || null,
    supplyDistribution: meta.supplyDistribution || null,
    ageMs: bornAt != null ? now - bornAt : 0,
    holders,
    snapshotAgeMs: snapshotAt != null ? now - snapshotAt : Infinity,
    coreWeekAgo: coreWeekAgo ?? null,
    holdersMonthAgo: trend?.holdersMonthAgo ?? null,
    volume24h: row?.volume_24h != null ? Number(row.volume_24h) : null,
    marketCap: row?.market_cap != null ? Number(row.market_cap) : null,
    bornAt, snapshotAt,
  };
}

// ── The daily job ───────────────────────────────────────────────────────────

/**
 * Score every curated token for `now`'s UTC date and settle the crown. Idempotent
 * within a day: scores are upserted, and the crown is only decided once per date.
 */
async function runDailyCrowning({ now = Date.now(), params = PARAMS } = {}) {
  await ensureSchema();
  const today = isoDate(now);
  const todayIdx = dayIndex(now);

  const curated = await db.getCuratedTokens();
  const mints = curated.map(t => t.mintAddress).filter(Boolean);
  const [rows, trends, coresWeekAgo] = await Promise.all([
    db.getTokensBatch(mints), getHolderTrend(mints, now), getCoreWeekAgo(mints, today),
  ]);
  const rowMap = {};
  for (const r of rows) rowMap[r.mint_address] = r;

  const scored = [];
  const skipped = {};
  for (const t of curated) {
    const mint = t.mintAddress;
    if (!mint) continue;
    const input = buildInput(t, rowMap[mint], trends[mint], coresWeekAgo[mint], now);
    const res = scoreToken(input, params);
    const components = res.eligible
      ? { headcount: res.headcount, supply: res.supply, confidence: res.confidence, momentum: res.momentum, retention: res.retention,
          activity: res.activity, volume24h: input.volume24h, marketCap: input.marketCap,
          holders: input.holders, holdersMonthAgo: input.holdersMonthAgo, ageDays: Math.round(input.ageMs / DAY), snapshotAt: input.snapshotAt }
      : { reason: res.reason, holders: input.holders, ageDays: Math.round(input.ageMs / DAY), snapshotAt: input.snapshotAt };
    await pool().query(
      `INSERT INTO diamond_hands_scores (mint_address, score_date, score, core, eligible, components, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (mint_address, score_date) DO UPDATE
         SET score = EXCLUDED.score, core = EXCLUDED.core, eligible = EXCLUDED.eligible,
             components = EXCLUDED.components, computed_at = NOW()`,
      [mint, today, res.score, res.core, res.eligible, JSON.stringify(components)]
    );
    if (res.eligible) scored.push({ mint, score: res.score });
    else skipped[res.reason] = (skipped[res.reason] || 0) + 1;
  }

  // Reign state
  const { rows: reigns } = await pool().query(
    `SELECT mint_address, crowned_on, ended_on FROM kotp_reigns ORDER BY crowned_on DESC, id DESC`
  );
  const open = reigns.find(r => !r.ended_on) || null;
  const king = open ? { mint: open.mint_address, crownedOn: dayIndex(open.crowned_on) } : null;
  const lastReignEnd = {}, reignEnds = {};
  for (const r of reigns) {
    if (!r.ended_on) continue;
    const e = dayIndex(r.ended_on);
    if (lastReignEnd[r.mint_address] == null || e > lastReignEnd[r.mint_address]) lastReignEnd[r.mint_address] = e;
    (reignEnds[r.mint_address] = reignEnds[r.mint_address] || []).push(e);
  }

  let pick = null;
  if (king && king.crownedOn === todayIdx) {
    pick = { mint: king.mint, changed: false, reason: 'already_decided', reignDays: 0 };
  } else {
    pick = pickKing(scored, king, lastReignEnd, todayIdx, params, reignEnds);
    if (pick.changed) {
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        if (king) await client.query(`UPDATE kotp_reigns SET ended_on = $1 WHERE ended_on IS NULL`, [today]);
        await client.query(
          `INSERT INTO kotp_reigns (mint_address, crowned_on, score, reason) VALUES ($1, $2, $3, $4)
           ON CONFLICT (mint_address, crowned_on) DO UPDATE SET ended_on = NULL, score = EXCLUDED.score, reason = EXCLUDED.reason`,
          [pick.mint, today, pick.score, pick.reason]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  }
  await cache.delete(FEATURED_CACHE_KEY).catch(() => {});

  const summary = { date: today, scored: scored.length, skipped, king: pick.mint, changed: !!pick.changed, reason: pick.reason };
  console.log(`[KotP] ${today}: ${scored.length} scored, ${Object.entries(skipped).map(([k, v]) => `${v} ${k}`).join(', ') || 'none skipped'}; ` +
    `king ${pick.mint ? pick.mint.slice(0, 8) : 'none'} (${pick.reason}${pick.changed ? ', new' : ''})`);
  return summary;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The automatic King as of now: the open reign, its score for the latest scored
 * day, which day of the reign it is, and the top contenders. null without a reign.
 */
async function getCurrentKing({ now = Date.now() } = {}) {
  await ensureSchema();
  const { rows: open } = await pool().query(
    `SELECT mint_address, crowned_on, score, reason FROM kotp_reigns WHERE ended_on IS NULL ORDER BY crowned_on DESC, id DESC LIMIT 1`
  );
  if (!open.length) return null;
  const reign = open[0];
  const { rows: latest } = await pool().query(
    `SELECT score_date FROM diamond_hands_scores WHERE eligible ORDER BY score_date DESC LIMIT 1`
  );
  const scoreDate = latest[0]?.score_date || null;
  let score = num(reign.score), contenders = [];
  if (scoreDate) {
    const { rows } = await pool().query(
      `SELECT s.mint_address, s.score, t.name, t.symbol
         FROM diamond_hands_scores s LEFT JOIN tokens t ON t.mint_address = s.mint_address
        WHERE s.score_date = $1 AND s.eligible AND s.score IS NOT NULL
        ORDER BY s.score DESC LIMIT $2`,
      [scoreDate, MAX_CONTENDERS + 1]
    );
    const own = await pool().query(
      `SELECT score FROM diamond_hands_scores WHERE mint_address = $1 AND score_date = $2`, [reign.mint_address, scoreDate]);
    if (own.rows[0]?.score != null) score = num(own.rows[0].score);
    contenders = rows.filter(r => r.mint_address !== reign.mint_address).slice(0, MAX_CONTENDERS)
      .map(r => ({ mintAddress: r.mint_address, name: r.name || null, symbol: r.symbol || null, score: num(r.score) }));
  }
  return {
    mint: reign.mint_address,
    crownedOn: isoDate(reign.crowned_on),
    reignDay: Math.max(1, dayIndex(now) - dayIndex(reign.crowned_on) + 1),
    score,
    scoreDate: scoreDate ? isoDate(scoreDate) : null,
    reason: reign.reason || null,
    contenders,
  };
}

/** Past and present reigns, newest first. */
async function getReigns(limit = 20) {
  await ensureSchema();
  const { rows } = await pool().query(
    `SELECT r.mint_address, r.crowned_on, r.ended_on, r.score, r.reason, t.name, t.symbol
       FROM kotp_reigns r LEFT JOIN tokens t ON t.mint_address = r.mint_address
      ORDER BY r.crowned_on DESC, r.id DESC LIMIT $1`, [limit]);
  return rows.map(r => ({
    mintAddress: r.mint_address, name: r.name || null, symbol: r.symbol || null,
    crownedOn: isoDate(r.crowned_on), endedOn: r.ended_on ? isoDate(r.ended_on) : null,
    score: num(r.score), reason: r.reason || null,
  }));
}

/**
 * Each mint's most recent Diamond Hands score (null while ineligible), for ranking the
 * home table: mint → { score, date }. Empty without a database or before the first run.
 */
async function getLatestScores(mints) {
  if (!mints || !mints.length) return {};
  await ensureSchema();
  const { rows } = await pool().query(
    `SELECT DISTINCT ON (mint_address) mint_address, score, score_date, eligible
       FROM diamond_hands_scores WHERE mint_address = ANY($1)
      ORDER BY mint_address, score_date DESC`, [mints]);
  const out = {};
  for (const r of rows) out[r.mint_address] = { score: r.eligible ? num(r.score) : null, date: isoDate(r.score_date) };
  return out;
}

module.exports = {
  FEATURED_CACHE_KEY,
  ensureSchema,
  runDailyCrowning,
  getCurrentKing,
  getLatestScores,
  getReigns,
  // for tests
  buildInput,
  getHolderTrend,
};
