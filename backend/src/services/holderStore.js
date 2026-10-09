/**
 * Postgres access for holder snapshots and positions. Schema lives in
 * database.js (holder_snapshots, holder_snapshot_entries, holder_positions).
 */

const db = require('./database');

const UPSERT_CHUNK = 5000;
const KEEP_ENTRY_SNAPSHOTS = 3;        // per mint, the newest snapshots keep their ranked entries
const SNAPSHOT_RETENTION_DAYS = 30;    // headers older than this are pruned (only the newest keeps its sample)

function pool() {
  if (!db.pool) throw new Error('Database not available');
  return db.pool;
}

/** Latest snapshot header for a mint, or null. */
async function getLatestSnapshot(mint) {
  const { rows } = await pool().query(
    `SELECT id, mint_address, taken_at, verified_at, checked_at, complete, pages, account_count, holder_count,
            decimals, supply, sample, sample_meta
       FROM holder_snapshots WHERE mint_address = $1
      ORDER BY taken_at DESC LIMIT 1`,
    [mint]
  );
  return rows[0] || null;
}

/**
 * mint → when the latest snapshot was last known current (ms): its taken_at, or a
 * later verified_at or pre-check (checked_at). Snapshots without a supply (written before supply/decimals
 * were required) don't count, so the schedulers replace them on their next run.
 */
async function getLatestSnapshotTimes(mints) {
  if (!mints || mints.length === 0) return {};
  const { rows } = await pool().query(
    `SELECT DISTINCT ON (mint_address) mint_address, GREATEST(taken_at, verified_at, checked_at) AS fresh_at, supply
       FROM holder_snapshots WHERE mint_address = ANY($1)
      ORDER BY mint_address, taken_at DESC`,
    [mints]
  );
  const out = {};
  for (const r of rows) if (r.supply != null) out[r.mint_address] = new Date(r.fresh_at).getTime();
  return out;
}

/**
 * A pre-check found the snapshot unchanged at `at` (checked_at). When it read every
 * account (`all`), the snapshot is also known exact then (verified_at).
 */
async function markVerified(snapshotId, at, { all = true } = {}) {
  await pool().query(
    `UPDATE holder_snapshots SET checked_at = $2${all ? ', verified_at = $2' : ''} WHERE id = $1`,
    [snapshotId, new Date(at)]);
}

/** Top ranked entries of a snapshot. */
async function getSnapshotEntries(snapshotId, limit = 100) {
  const { rows } = await pool().query(
    `SELECT rank, wallet, token_account, amount
       FROM holder_snapshot_entries WHERE snapshot_id = $1
      ORDER BY rank LIMIT $2`,
    [snapshotId, limit]
  );
  return rows;
}

/**
 * Write one snapshot: header, top-N entries, and the positions upsert, in one
 * transaction. New wallets get `newAcquisition` (from newWalletAcquisition);
 * existing wallets keep their streak. When the snapshot is complete, wallets
 * that weren't seen are deleted (they left).
 *
 * Only rows whose balance or token account changed are rewritten: every holder
 * used to get a new row version per snapshot (rank and last_seen_at changed for
 * all of them), which on a 50k-holder token was 50k dead tuples every few hours.
 * Departures are found against the current wallet list instead of last_seen_at.
 *
 * Wallets whose backfill found the account already empty ('left') and that are
 * holding again are dated like newcomers; 'failed' rows older than a day get
 * another go (up to FAILED_RETRY_MAX_ATTEMPTS attempts in total).
 *
 * @returns {number} the snapshot id
 */
const FAILED_RETRY_AFTER_HOURS = 24;
const FAILED_RETRY_MAX_ATTEMPTS = 10;
// $1 mint, $2 FAILED_RETRY_AFTER_HOURS, $3 FAILED_RETRY_MAX_ATTEMPTS, $4 now
const REQUEUE_FAILED_SQL = `
  UPDATE holder_positions p SET
    acquired_source = 'pending',
    backfill_cursor = NULL, backfill_balance = NULL, backfill_oldest_at = NULL, backfill_pages = 0
  WHERE p.mint_address = $1 AND p.acquired_source = 'failed'
    AND p.backfill_attempts < $3
    AND (p.backfill_updated_at IS NULL OR p.backfill_updated_at < $4::timestamptz - make_interval(hours => $2))`;

async function writeSnapshot({ mint, takenAt, complete, pages, accountCount, holders, decimals, supply,
  sample, sampleMeta, topN, newAcquisition }) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const takenAtDate = new Date(takenAt);
    const { rows } = await client.query(
      `INSERT INTO holder_snapshots
         (mint_address, taken_at, complete, pages, account_count, holder_count, decimals, supply, sample, sample_meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [mint, takenAtDate, complete, pages, accountCount, holders.length, decimals,
        supply != null ? String(supply) : null, JSON.stringify(sample), JSON.stringify(sampleMeta)]
    );
    const snapshotId = rows[0].id;

    const top = holders.slice(0, topN);
    if (top.length > 0) {
      await client.query(
        `INSERT INTO holder_snapshot_entries (snapshot_id, rank, wallet, token_account, amount)
         SELECT $1, * FROM unnest($2::int[], $3::varchar[], $4::varchar[], $5::numeric[])`,
        [snapshotId, top.map(h => h.rank), top.map(h => h.wallet), top.map(h => h.tokenAccount),
          top.map(h => h.amount.toString())]
      );
    }

    const acqAt = newAcquisition.acquiredAt != null ? new Date(newAcquisition.acquiredAt) : null;
    await client.query('CREATE TEMP TABLE snapshot_wallets (wallet VARCHAR(44) PRIMARY KEY) ON COMMIT DROP');
    for (let i = 0; i < holders.length; i += UPSERT_CHUNK) {
      const chunk = holders.slice(i, i + UPSERT_CHUNK);
      const wallets = chunk.map(h => h.wallet);
      await client.query('INSERT INTO snapshot_wallets SELECT * FROM unnest($1::varchar[])', [wallets]);
      await client.query(
        `INSERT INTO holder_positions
           (mint_address, wallet, token_account, amount, rank, first_seen_at, last_seen_at, acquired_at, acquired_source)
         SELECT $1, w, ta, amt, rk, $6, $6, $7, $8
           FROM unnest($2::varchar[], $3::varchar[], $4::numeric[], $5::int[]) AS t(w, ta, amt, rk)
         ON CONFLICT (mint_address, wallet) DO UPDATE SET
           token_account = EXCLUDED.token_account,
           amount = EXCLUDED.amount,
           last_seen_at = EXCLUDED.last_seen_at
         WHERE holder_positions.amount IS DISTINCT FROM EXCLUDED.amount
            OR holder_positions.token_account IS DISTINCT FROM EXCLUDED.token_account`,
        [mint, wallets, chunk.map(h => h.tokenAccount), chunk.map(h => h.amount.toString()),
          chunk.map(h => h.rank), takenAtDate, acqAt, newAcquisition.source]
      );
    }

    // Back after leaving: a new streak, dated by the same rule as any newcomer
    await client.query(
      `UPDATE holder_positions p SET
         acquired_at = $2, acquired_source = $3, first_seen_at = $4, last_seen_at = $4,
         backfill_cursor = NULL, backfill_balance = NULL, backfill_oldest_at = NULL, backfill_pages = 0, backfill_attempts = 0
       WHERE p.mint_address = $1 AND p.acquired_source = 'left'
         AND EXISTS (SELECT 1 FROM snapshot_wallets s WHERE s.wallet = p.wallet)`,
      [mint, acqAt, newAcquisition.source, takenAtDate]
    );
    // Gave up a while ago: try again
    await client.query(
      `${REQUEUE_FAILED_SQL}
         AND EXISTS (SELECT 1 FROM snapshot_wallets s WHERE s.wallet = p.wallet)`,
      [mint, FAILED_RETRY_AFTER_HOURS, FAILED_RETRY_MAX_ATTEMPTS, takenAtDate]
    );

    if (complete) {
      await client.query(
        `DELETE FROM holder_positions p WHERE p.mint_address = $1
            AND NOT EXISTS (SELECT 1 FROM snapshot_wallets s WHERE s.wallet = p.wallet)`,
        [mint]
      );
    }

    await client.query('COMMIT');
    return snapshotId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Drop old snapshot entries and headers for a mint; keeps storage bounded. */
async function pruneSnapshots(mint) {
  await pool().query(
    `DELETE FROM holder_snapshot_entries WHERE snapshot_id IN (
       SELECT id FROM holder_snapshots WHERE mint_address = $1
        ORDER BY taken_at DESC OFFSET $2)`,
    [mint, KEEP_ENTRY_SNAPSHOTS]
  );
  await pool().query(
    `DELETE FROM holder_snapshots WHERE mint_address = $1
        AND taken_at < NOW() - make_interval(days => $2)
        AND id <> (SELECT id FROM holder_snapshots WHERE mint_address = $1 ORDER BY taken_at DESC LIMIT 1)`,
    [mint, SNAPSHOT_RETENTION_DAYS]
  );
  // Only the newest header's sample is ever read (getLatestSnapshot); older headers
  // keep sample_meta (counts, strata, fingerprint, lpWallets) but drop the ~30 KB sample.
  await pool().query(
    `UPDATE holder_snapshots SET sample = NULL
      WHERE mint_address = $1 AND sample IS NOT NULL
        AND id <> (SELECT id FROM holder_snapshots WHERE mint_address = $1 ORDER BY taken_at DESC LIMIT 1)`,
    [mint]
  );
}

/**
 * Positions for specific wallets of a mint.
 * @returns {Map<string, row>}
 */
async function getPositions(mint, wallets) {
  const out = new Map();
  if (!wallets || wallets.length === 0) return out;
  const { rows } = await pool().query(
    `SELECT wallet, token_account, amount, rank, first_seen_at, last_seen_at, acquired_at, acquired_source,
            backfill_cursor, backfill_balance, backfill_oldest_at, backfill_pages, backfill_attempts
       FROM holder_positions WHERE mint_address = $1 AND wallet = ANY($2)`,
    [mint, wallets]
  );
  for (const r of rows) out.set(r.wallet, r);
  return out;
}

/** Every stored position of a mint: wallet and its token account. */
async function getPositionAccounts(mint) {
  const { rows } = await pool().query(
    'SELECT wallet, token_account FROM holder_positions WHERE mint_address = $1',
    [mint]
  );
  return rows;
}

/** Save backfill progress or the result for one wallet. */
async function saveBackfill(mint, wallet, { acquiredAt = null, source = null, cursor = null, balance = null,
  oldestAt = null, pagesAdded = 0, attempted = false }) {
  await pool().query(
    `UPDATE holder_positions SET
       acquired_at = COALESCE($3, acquired_at),
       acquired_source = COALESCE($4, acquired_source),
       backfill_cursor = $5,
       backfill_balance = $6,
       backfill_oldest_at = $9,
       backfill_pages = backfill_pages + $7,
       backfill_attempts = backfill_attempts + $8,
       backfill_updated_at = NOW()
     WHERE mint_address = $1 AND wallet = $2`,
    [mint, wallet, acquiredAt != null ? new Date(acquiredAt) : null, source, cursor,
      balance != null ? balance.toString() : null, pagesAdded, attempted ? 1 : 0,
      oldestAt != null ? new Date(oldestAt) : null]
  );
}

/**
 * Forget snapshots/positions for mints nobody has snapshotted in a month (e.g.
 * one-off Cultify runs). A snapshot the pre-check keeps confirming (verified_at)
 * is current however old its taken_at, so it counts as recent.
 */
async function pruneAbandonedMints() {
  const { rowCount } = await pool().query(
    `DELETE FROM holder_positions p
      WHERE NOT EXISTS (
        SELECT 1 FROM holder_snapshots s
         WHERE s.mint_address = p.mint_address
           AND GREATEST(s.taken_at, s.verified_at) > NOW() - make_interval(days => $1))`,
    [SNAPSHOT_RETENTION_DAYS]
  );
  await pool().query(
    `DELETE FROM holder_snapshots WHERE GREATEST(taken_at, verified_at) < NOW() - make_interval(days => $1)`,
    [SNAPSHOT_RETENTION_DAYS]
  );
  // Holder count history is kept for good while a token is still snapshotted
  // (curated tokens every few hours); one-off mints lose theirs after 90 days.
  await pool().query(
    `DELETE FROM holder_count_points p
      WHERE p.mint_address IN (
        SELECT mint_address FROM holder_count_points GROUP BY mint_address
        HAVING MAX(taken_at) < NOW() - INTERVAL '90 days')`
  );
  return rowCount;
}

/**
 * The same day-later retry as writeSnapshot's, for the backfill run. A token whose pre-check
 * keeps finding it unchanged never writes a snapshot, so its 'failed' wallets otherwise
 * stayed failed until an admin flush. No snapshot check here: on a complete token positions
 * only hold current holders. On a capped token a wallet that has since left can be requeued
 * until the attempt cap, which costs little since runBackfill only works walletsOfInterest.
 */
async function requeueFailedBackfills(mint, at = Date.now()) {
  const { rowCount } = await pool().query(REQUEUE_FAILED_SQL,
    [mint, FAILED_RETRY_AFTER_HOURS, FAILED_RETRY_MAX_ATTEMPTS, new Date(at)]);
  return rowCount;
}

/** Put wallets whose backfill gave up back in the queue (admin action). */
async function resetFailedBackfills() {
  const { rowCount } = await pool().query(
    `UPDATE holder_positions SET acquired_source = 'pending', backfill_attempts = 0,
            backfill_cursor = NULL, backfill_balance = NULL, backfill_oldest_at = NULL, backfill_pages = 0
      WHERE acquired_source = 'failed'`
  );
  return rowCount;
}

module.exports = {
  FAILED_RETRY_AFTER_HOURS,
  resetFailedBackfills,
  requeueFailedBackfills,
  getLatestSnapshot,
  getLatestSnapshotTimes,
  markVerified,
  getSnapshotEntries,
  writeSnapshot,
  pruneSnapshots,
  getPositions,
  getPositionAccounts,
  saveBackfill,
  pruneAbandonedMints,
};
