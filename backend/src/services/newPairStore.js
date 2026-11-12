/**
 * New Pairs storage: the tokens discovery found, where each detector has read up to,
 * and the Helius credits the feature has spent per day.
 *
 *   newpair_tokens       one row per graduated mint (the first graduation seen wins),
 *                        with the identity and market columns the cheap tier fills
 *   newpair_points       the stored price / market cap / liquidity / holder series
 *   newpair_detectors    per detector: cursor (last transaction read), run health
 *   newpair_credit_days  credits per UTC day and source. The daily cap is checked
 *                        against this table, not Redis: the free Render Redis keeps
 *                        nothing across a restart, and a cap that forgets what it
 *                        spent is not a cap.
 *
 * Self-contained schema (created on first use) so database.js stays untouched, the
 * same way kingOfPill.js does it.
 */

const db = require('./database');

function pool() {
  if (!db.pool) throw new Error('Database not available');
  return db.pool;
}

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    // One multi-statement query is one implicit transaction, so the advisory lock is
    // held to its end: the API and the worker (or two test files) starting together
    // can't race each other's CREATE TABLE IF NOT EXISTS.
    schemaReady = pool().query(`
      SELECT pg_advisory_xact_lock(7426001);
      CREATE TABLE IF NOT EXISTS newpair_tokens (
        id BIGSERIAL PRIMARY KEY,
        mint_address VARCHAR(44) NOT NULL UNIQUE,
        detector VARCHAR(24) NOT NULL,
        launchpad VARCHAR(32),
        quote_mint VARCHAR(44),
        graduated_at TIMESTAMP WITH TIME ZONE NOT NULL,
        graduated_source VARCHAR(48) NOT NULL,
        graduation_sig VARCHAR(90),
        graduation_slot BIGINT,
        status VARCHAR(16) NOT NULL DEFAULT 'new',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_newpair_tokens_graduated ON newpair_tokens(graduated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_newpair_tokens_status ON newpair_tokens(status, graduated_at DESC);
      -- Cheap tier (newPairMarket.js): identity and market data from Jupiter
      ALTER TABLE newpair_tokens
        ADD COLUMN IF NOT EXISTS name VARCHAR(100),
        ADD COLUMN IF NOT EXISTS symbol VARCHAR(32),
        ADD COLUMN IF NOT EXISTS logo_uri TEXT,
        ADD COLUMN IF NOT EXISTS decimals SMALLINT,
        ADD COLUMN IF NOT EXISTS jup_launchpad VARCHAR(32),
        ADD COLUMN IF NOT EXISTS dev_wallet VARCHAR(44),
        ADD COLUMN IF NOT EXISTS token_program VARCHAR(44),
        ADD COLUMN IF NOT EXISTS graduated_pool VARCHAR(44),
        ADD COLUMN IF NOT EXISTS price_usd DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS mcap DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS liquidity DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS holder_count INTEGER,
        ADD COLUMN IF NOT EXISTS peak_mcap DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS peak_mcap_at TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS market JSONB,
        ADD COLUMN IF NOT EXISTS market_at TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS market_source VARCHAR(16),
        ADD COLUMN IF NOT EXISTS holders_at TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS active_at TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS next_market_at TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS recheck_step SMALLINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS next_recheck_at TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS last_point_at TIMESTAMP WITH TIME ZONE;
      CREATE INDEX IF NOT EXISTS idx_newpair_tokens_market_due ON newpair_tokens(next_market_at) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_newpair_tokens_recheck_due ON newpair_tokens(next_recheck_at) WHERE status = 'below_floor';
      -- The stored series growth and steadiness are computed from (hourly for a
      -- token's first 3 days, then every 3 hours)
      CREATE TABLE IF NOT EXISTS newpair_points (
        token_id BIGINT NOT NULL REFERENCES newpair_tokens(id) ON DELETE CASCADE,
        at TIMESTAMP WITH TIME ZONE NOT NULL,
        price_usd DOUBLE PRECISION,
        mcap DOUBLE PRECISION,
        liquidity DOUBLE PRECISION,
        holder_count INTEGER,
        source VARCHAR(16),
        PRIMARY KEY (token_id, at)
      );
      CREATE TABLE IF NOT EXISTS newpair_detectors (
        id VARCHAR(24) PRIMARY KEY,
        cursor_sig VARCHAR(90),
        cursor_slot BIGINT,
        cursor_time TIMESTAMP WITH TIME ZONE,
        caught_up_at TIMESTAMP WITH TIME ZONE,
        last_run_at TIMESTAMP WITH TIME ZONE,
        last_ok_at TIMESTAMP WITH TIME ZONE,
        last_helius_at TIMESTAMP WITH TIME ZONE,
        last_source VARCHAR(16),
        last_error VARCHAR(200),
        found_total BIGINT NOT NULL DEFAULT 0,
        unhandled_total BIGINT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS newpair_credit_days (
        day DATE NOT NULL,
        source VARCHAR(48) NOT NULL,
        credits BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (day, source)
      );
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const ms = (v) => (v ? new Date(v).getTime() : null);

/**
 * Store graduations. A mint already present keeps its first row (a token graduates
 * once; a second sighting is a duplicate read or another program touching it).
 * @returns {Promise<number>} rows actually inserted
 */
async function insertGraduations(detectorId, launchpadLabel, graduations) {
  const rows = graduations.filter(g => g && g.mint && g.graduatedAt);
  if (rows.length === 0) return 0;
  await ensureSchema();
  const result = await pool().query(
    `INSERT INTO newpair_tokens (mint_address, detector, launchpad, quote_mint, graduated_at, graduated_source, graduation_sig, graduation_slot)
     SELECT t.mint, $1, $2, t.quote, to_timestamp(t.at / 1000.0), $3, t.sig, t.slot
     FROM unnest($4::text[], $5::text[], $6::double precision[], $7::text[], $8::bigint[]) AS t(mint, quote, at, sig, slot)
     ON CONFLICT (mint_address) DO NOTHING`,
    [detectorId, launchpadLabel || null, `onchain:${detectorId}`,
     rows.map(g => g.mint), rows.map(g => g.quoteMint || null), rows.map(g => g.graduatedAt),
     rows.map(g => g.signature || null), rows.map(g => g.slot ?? null)]
  );
  return result.rowCount;
}

/** @returns {Promise<{cursorSig, cursorSlot, cursorTime, caughtUpAt, lastHeliusAt}>} times in ms */
async function getDetectorState(id) {
  await ensureSchema();
  const { rows } = await pool().query('SELECT * FROM newpair_detectors WHERE id = $1', [id]);
  const r = rows[0] || {};
  return {
    cursorSig: r.cursor_sig || null,
    cursorSlot: r.cursor_slot != null ? Number(r.cursor_slot) : null,
    cursorTime: ms(r.cursor_time),
    caughtUpAt: ms(r.caught_up_at),
    lastHeliusAt: ms(r.last_helius_at),
  };
}

/**
 * Record one run of a detector. Only the fields given change: a failed run reports
 * its error without touching the cursor.
 */
async function saveDetectorRun(id, { cursor, caughtUpAt, source, usedHelius, ok, error, found = 0, unhandled = 0, now = Date.now() }) {
  await ensureSchema();
  await pool().query(
    `INSERT INTO newpair_detectors (id, cursor_sig, cursor_slot, cursor_time, caught_up_at, last_run_at, last_ok_at, last_helius_at, last_source, last_error, found_total, unhandled_total)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0),
             CASE WHEN $7 THEN to_timestamp($6 / 1000.0) END, CASE WHEN $8 THEN to_timestamp($6 / 1000.0) END, $9, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       cursor_sig = CASE WHEN $13 THEN EXCLUDED.cursor_sig ELSE newpair_detectors.cursor_sig END,
       cursor_slot = CASE WHEN $13 THEN EXCLUDED.cursor_slot ELSE newpair_detectors.cursor_slot END,
       cursor_time = CASE WHEN $13 THEN EXCLUDED.cursor_time ELSE newpair_detectors.cursor_time END,
       caught_up_at = COALESCE(EXCLUDED.caught_up_at, newpair_detectors.caught_up_at),
       last_run_at = EXCLUDED.last_run_at,
       last_ok_at = COALESCE(EXCLUDED.last_ok_at, newpair_detectors.last_ok_at),
       last_helius_at = COALESCE(EXCLUDED.last_helius_at, newpair_detectors.last_helius_at),
       last_source = EXCLUDED.last_source,
       last_error = EXCLUDED.last_error,
       found_total = newpair_detectors.found_total + EXCLUDED.found_total,
       unhandled_total = newpair_detectors.unhandled_total + EXCLUDED.unhandled_total`,
    [id, cursor?.sig || null, cursor?.slot ?? null, cursor?.time ?? null, caughtUpAt ?? null, now,
     !!ok, !!usedHelius, source || null, error ? String(error).slice(0, 200) : null, found, unhandled, !!cursor]
  );
}

/** Add Helius credits spent by the feature today. */
async function addCredits(source, credits, now = Date.now()) {
  if (!(credits > 0)) return;
  await ensureSchema();
  await pool().query(
    `INSERT INTO newpair_credit_days (day, source, credits) VALUES ($1, $2, $3)
     ON CONFLICT (day, source) DO UPDATE SET credits = newpair_credit_days.credits + EXCLUDED.credits`,
    [utcDay(now), String(source).slice(0, 48), Math.round(credits)]
  );
}

/** Credits the whole feature (every source) has spent on the UTC day of `now`. */
async function creditsSpentToday(now = Date.now()) {
  await ensureSchema();
  const { rows } = await pool().query('SELECT COALESCE(SUM(credits), 0) AS n FROM newpair_credit_days WHERE day = $1', [utcDay(now)]);
  return Number(rows[0].n);
}

module.exports = { ensureSchema, insertGraduations, getDetectorState, saveDetectorRun, addCredits, creditsSpentToday, utcDay };
