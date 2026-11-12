/**
 * New Pairs, as the admin panel sees it: the ranked preview (hidden tokens included,
 * whether or not NEWPAIRS_PUBLIC is on), today's Helius spend against the cap, each
 * detector's health, and the two things an admin can do to a token: hide it, or
 * promote it to the curated list.
 *
 * Reads are Postgres only. Promote is the one call that reaches upstreams: it runs the
 * same add flow as the Curated Tokens tab (services/curatedTokens.js), which spends
 * from the curated pipeline's budget, not from the finder's daily cap.
 */
const db = require('./database');
const store = require('./newPairStore');
const settings = require('./newPairSettings');
const { cache } = require('./cache');
const { shapeRow, SELECT, WINDOWS } = require('./newPairList');
const { DETECTORS } = require('./newPairLaunchpads');

const PREVIEW_CAP = 500;
const CREDIT_DAYS = 7;

const pool = () => { if (!db.pool) throw new Error('Database not available'); return db.pool; };
const iso = (v) => (v ? new Date(v).toISOString() : null);

/** Drop the cached public answers so a change shows on the next request, not in a minute. */
async function clearPublicCache(mint) {
  const keys = Object.keys(WINDOWS).map(w => `newpairs:list:${w}`);
  if (mint) keys.push(`newpairs:token:${mint}`);
  await Promise.all(keys.map(k => cache.delete(k).catch(() => {})));
}

/** Everything the admin tab shows, in one read. */
async function preview({ now = Date.now(), env = process.env } = {}) {
  await store.ensureSchema();
  const since = now - WINDOWS['14d'];
  const [tokens, counts, credits, detectors, current] = await Promise.all([
    pool().query(`${SELECT} WHERE t.status = 'active' AND t.graduated_at >= to_timestamp($1 / 1000.0)
      ORDER BY t.score DESC NULLS LAST, t.id LIMIT $2`, [since, PREVIEW_CAP]),
    pool().query(`SELECT
        COUNT(*) FILTER (WHERE status = 'new')::int AS waiting,
        COUNT(*) FILTER (WHERE status = 'below_floor')::int AS below_floor,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE status = 'active' AND hidden)::int AS hidden,
        COUNT(*) FILTER (WHERE status = 'active' AND rugged)::int AS rugged,
        COUNT(*) FILTER (WHERE status = 'active' AND unlisted_reason IS NOT NULL)::int AS unlisted,
        COUNT(*) FILTER (WHERE status = 'active' AND NOT holders_pending)::int AS holders_checked,
        MAX(scored_at) AS scored_at, MAX(market_at) AS market_at
      FROM newpair_tokens WHERE graduated_at >= to_timestamp($1 / 1000.0)`, [since]),
    pool().query(`SELECT day::text AS day, source, credits::int AS credits FROM newpair_credit_days
      WHERE day >= $1::date - $2::int ORDER BY day DESC, source`, [store.utcDay(now), CREDIT_DAYS - 1]),
    pool().query('SELECT * FROM newpair_detectors ORDER BY id'),
    settings.get(env),
  ]);

  const today = store.utcDay(now);
  const days = new Map();
  for (const r of credits.rows) {
    if (!days.has(r.day)) days.set(r.day, { day: r.day, total: 0, sources: {} });
    const d = days.get(r.day);
    d.total += r.credits;
    d.sources[r.source] = r.credits;
  }
  const spentToday = days.get(today)?.total || 0;
  const c = counts.rows[0];
  const state = new Map(detectors.rows.map(r => [r.id, r]));

  return {
    generatedAt: new Date(now).toISOString(),
    public: env.NEWPAIRS_PUBLIC === 'true',
    counts: {
      waiting: c.waiting, belowFloor: c.below_floor, active: c.active, hidden: c.hidden, rugged: c.rugged,
      unlisted: c.unlisted, holdersChecked: c.holders_checked, scoredAt: iso(c.scored_at), marketAt: iso(c.market_at),
    },
    credits: {
      today, spentToday, cap: current.dailyCredits, maxCap: current.maxDailyCredits,
      left: Math.max(0, current.dailyCredits - spentToday),
      days: [...days.values()],
    },
    // Every detector the code knows, so one that has never run shows as such
    detectors: Object.keys(DETECTORS).map(id => {
      const r = state.get(id) || {};
      const found = Number(r.found_total || 0);
      const unhandled = Number(r.unhandled_total || 0);
      return {
        id, cursorTime: iso(r.cursor_time), caughtUpAt: iso(r.caught_up_at), lastRunAt: iso(r.last_run_at), lastOkAt: iso(r.last_ok_at),
        lastHeliusAt: iso(r.last_helius_at), lastSource: r.last_source || null, lastError: r.last_error || null,
        found, unhandled,
        // Migration instructions seen that the detector could not read, out of all it saw
        missRate: found + unhandled > 0 ? Math.round((unhandled / (found + unhandled)) * 1000) / 1000 : null,
      };
    }),
    settings: current,
    tokens: tokens.rows.map((r, i) => ({
      rank: i + 1, ...shapeRow(r, now),
      hidden: !!r.hidden, hiddenAt: iso(r.hidden_at), unlistedReason: r.unlisted_reason || null,
      quality: r.score_parts?.quality ?? null,
    })),
  };
}

/** Hide or show a token. @returns {Promise<boolean>} false when the finder has no such token */
async function setHidden(mint, hidden) {
  await store.ensureSchema();
  const { rowCount } = await pool().query(
    'UPDATE newpair_tokens SET hidden = $2, hidden_at = CASE WHEN $2 THEN NOW() END WHERE mint_address = $1', [mint, !!hidden]);
  if (rowCount) await clearPublicCache(mint);
  return rowCount > 0;
}

/**
 * Add a finder token to the curated list.
 * @returns {Promise<null | {token, alreadyCurated}>} null when the finder has no such token
 */
async function promote(mint, { addCurated = (m) => require('./curatedTokens').addCuratedTokenFully(m) } = {}) {
  await store.ensureSchema();
  const { rows } = await pool().query('SELECT 1 FROM newpair_tokens WHERE mint_address = $1', [mint]);
  if (!rows.length) return null;
  const { token, alreadyCurated } = await addCurated(mint);
  // The home table lists curated tokens only: show the new one now, as the Curated tab's add does
  await cache.clearPattern('leaderboard:conviction:*').catch(() => {});
  await clearPublicCache(mint);
  return { token, alreadyCurated: !!alreadyCurated };
}

module.exports = { preview, setHidden, promote, clearPublicCache, PREVIEW_CAP };
