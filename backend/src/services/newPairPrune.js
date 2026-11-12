/**
 * New Pairs pruning: once a day, tokens past the 14-day window leave.
 *
 * A token that was listed (active and scored) first gets one row in newpair_archive:
 * its marks at 1, 3, 7 and 14 days, its last score and market figures, its first and
 * peak market cap, and whether it rugged, was hidden or was promoted to the curated
 * list. Then the token row is deleted, and its points, holder samples and holder
 * entries go with it (ON DELETE CASCADE). Tokens that never made the list are only
 * deleted. Archive rows are kept 180 days, credit-ledger days the same.
 *
 * A promoted token is archived and deleted like any other: from the day it was
 * promoted the curated pipeline holds its data, and its token page is the full one.
 *
 * Postgres only. One transaction, so a token is never deleted without its archive row.
 */
const db = require('./database');
const store = require('./newPairStore');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW_MS = 14 * DAY;
// Past 14 days by this much before a token goes: the scoring run (every 10 minutes)
// has then stored its 14-day mark
const GRACE_MS = 2 * HOUR;
const ARCHIVE_KEEP_MS = 180 * DAY;

const pool = () => { if (!db.pool) throw new Error('Database not available'); return db.pool; };

/** @returns {Promise<{archived, deleted, archiveExpired, creditDaysExpired}>} */
async function run({ now = Date.now() } = {}) {
  await store.ensureSchema();
  const cutoff = now - WINDOW_MS - GRACE_MS;
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const archived = await client.query(
      `INSERT INTO newpair_archive (mint_address, detector, launchpad, name, symbol, graduated_at, archived_at, marks,
         final_score, final_holders, final_mcap, final_liquidity, first_mcap, peak_mcap, rugged, hidden, promoted)
       SELECT t.mint_address, t.detector, t.launchpad, t.name, t.symbol, t.graduated_at, to_timestamp($2 / 1000.0), t.marks,
         t.score, t.holder_count, t.mcap, t.liquidity,
         (SELECT p.mcap FROM newpair_points p WHERE p.token_id = t.id AND p.mcap IS NOT NULL ORDER BY p.at LIMIT 1),
         t.peak_mcap, t.rugged, t.hidden, c.mint_address IS NOT NULL
       FROM newpair_tokens t LEFT JOIN curated_tokens c ON c.mint_address = t.mint_address
       WHERE t.graduated_at < to_timestamp($1 / 1000.0) AND t.status = 'active' AND t.score IS NOT NULL
       ON CONFLICT (mint_address) DO UPDATE SET
         archived_at = EXCLUDED.archived_at, marks = EXCLUDED.marks, final_score = EXCLUDED.final_score,
         final_holders = EXCLUDED.final_holders, final_mcap = EXCLUDED.final_mcap, final_liquidity = EXCLUDED.final_liquidity,
         first_mcap = EXCLUDED.first_mcap, peak_mcap = EXCLUDED.peak_mcap, rugged = EXCLUDED.rugged,
         hidden = EXCLUDED.hidden, promoted = EXCLUDED.promoted`,
      [cutoff, now]);
    const deleted = await client.query('DELETE FROM newpair_tokens WHERE graduated_at < to_timestamp($1 / 1000.0)', [cutoff]);
    await client.query('COMMIT');
    const expired = await pool().query('DELETE FROM newpair_archive WHERE archived_at < to_timestamp($1 / 1000.0)', [now - ARCHIVE_KEEP_MS]);
    const credits = await pool().query('DELETE FROM newpair_credit_days WHERE day < $1', [store.utcDay(now - ARCHIVE_KEEP_MS)]);
    return { archived: archived.rowCount, deleted: deleted.rowCount, archiveExpired: expired.rowCount, creditDaysExpired: credits.rowCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { run, WINDOW_MS, GRACE_MS, ARCHIVE_KEEP_MS };
