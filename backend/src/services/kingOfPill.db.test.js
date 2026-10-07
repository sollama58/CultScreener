/**
 * King of the Pill daily job against a real Postgres: scores from stored diamond
 * hands rows, reign bookkeeping over several days, idempotency within a day, and
 * the manual override staying out of the automatic reign.
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;

if (!DB_URL) {
  test('king of the pill DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.REDIS_URL;

  const db = require('./database');
  const kotp = require('./kingOfPill');
  const { DAY, PARAMS } = require('./kotpScore');

  const MINTS = ['KotpA111111111111111111111111111111111111111', 'KotpB111111111111111111111111111111111111111',
                 'KotpC111111111111111111111111111111111111111', 'KotpD111111111111111111111111111111111111111'];
  const [A, B, C, D] = MINTS;
  const T0 = Date.UTC(2026, 9, 1, 12);  // noon so the UTC date is unambiguous
  const dist = (m3) => ({ '6h': 98, '24h': 95, '3d': 90, '1w': 80, '1m': 60, '3m': m3, '6m': m3 * 0.6, '9m': m3 * 0.4, '1yr': m3 * 0.2 });

  async function seedToken(mint, { name, m3, ageDays, holders, holdersMonthAgo, snapshotAt, curated = true }) {
    await db.pool.query(
      `INSERT INTO tokens (mint_address, name, symbol, pair_created_at, conviction_data, conviction_meta, conviction_computed_at)
       VALUES ($1, $2, $2, $3, $4, $5, $6)
       ON CONFLICT (mint_address) DO UPDATE SET pair_created_at = EXCLUDED.pair_created_at, conviction_data = EXCLUDED.conviction_data,
         conviction_meta = EXCLUDED.conviction_meta, conviction_computed_at = EXCLUDED.conviction_computed_at`,
      [mint, name, new Date(T0 - ageDays * DAY), JSON.stringify(dist(m3)),
       JSON.stringify({ supplyDistribution: dist(m3), holderCount: holders, snapshotAt }), new Date(snapshotAt)]
    );
    if (curated) await db.pool.query(`INSERT INTO curated_tokens (mint_address) VALUES ($1) ON CONFLICT DO NOTHING`, [mint]);
    if (holdersMonthAgo != null) {
      await db.pool.query(
        `INSERT INTO holder_count_points (mint_address, taken_at, holders, complete, source) VALUES ($1, $2, $3, TRUE, 'snapshot'), ($1, $4, $5, TRUE, 'snapshot')
         ON CONFLICT DO NOTHING`,
        [mint, new Date(T0 - 30 * DAY), holdersMonthAgo, new Date(T0 - 3600_000), holders]
      );
    }
  }

  async function cleanup() {
    for (const t of ['diamond_hands_scores', 'kotp_reigns']) {
      await db.pool.query(`DROP TABLE IF EXISTS ${t}`);
    }
    await db.pool.query(`DELETE FROM holder_count_points WHERE mint_address = ANY($1)`, [MINTS]);
    await db.pool.query(`DELETE FROM curated_tokens WHERE mint_address = ANY($1)`, [MINTS]);
    await db.pool.query(`DELETE FROM tokens WHERE mint_address = ANY($1)`, [MINTS]);
    await db.pool.query(`DELETE FROM app_settings WHERE key = 'king_of_pill_mint'`);
  }

  before(async () => {
    await db.getInitializationPromise();
    // Production runs db/migrate.js on install, which adds the curated_tokens columns
    // getCuratedTokens reads; a bare test database has only what database.js creates.
    require('child_process').execFileSync(process.execPath, [require('path').join(__dirname, '../../db/migrate.js')],
      { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'ignore' });
    await cleanup();
    await seedToken(A, { name: 'ALPHA', m3: 60, ageDays: 400, holders: 5000, holdersMonthAgo: 4800, snapshotAt: T0 - 3600_000 });
    await seedToken(B, { name: 'BETA',  m3: 38, ageDays: 300, holders: 3000, holdersMonthAgo: 3000, snapshotAt: T0 - 3600_000 });
    await seedToken(C, { name: 'GAMMA', m3: 30, ageDays: 200, holders: 2000, holdersMonthAgo: 2500, snapshotAt: T0 - 3600_000 });
    await seedToken(D, { name: 'DELTA', m3: 90, ageDays: 3,   holders: 900,  holdersMonthAgo: null, snapshotAt: T0 - 3600_000 });
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  describe('runDailyCrowning', () => {
    test('day 1: scores every curated token, skips the young one, crowns the top score', async () => {
      const r = await kotp.runDailyCrowning({ now: T0 });
      assert.strictEqual(r.date, '2026-10-01');
      assert.strictEqual(r.king, A);
      assert.strictEqual(r.changed, true);
      assert.strictEqual(r.reason, 'first_king');
      assert.strictEqual(r.skipped.too_young, 1);

      const { rows } = await db.pool.query(
        `SELECT mint_address, score, core, eligible, components FROM diamond_hands_scores WHERE score_date = '2026-10-01' AND mint_address = ANY($1) ORDER BY score DESC NULLS LAST`, [MINTS]);
      assert.strictEqual(rows.length, 4);
      assert.deepStrictEqual(rows.map(x => x.mint_address), [A, B, C, D]);
      assert.strictEqual(rows[3].eligible, false);
      assert.strictEqual(rows[3].components.reason, 'too_young');
      // Retention: ALPHA grew 4800 → 5000, GAMMA shrank 2500 → 2000
      assert.ok(rows[0].components.retention > 0);
      assert.ok(rows[2].components.retention < 0);
      assert.strictEqual(rows[0].components.holdersMonthAgo, 4800);

      const king = await kotp.getCurrentKing({ now: T0 });
      assert.strictEqual(king.mint, A);
      assert.strictEqual(king.reignDay, 1);
      assert.strictEqual(king.crownedOn, '2026-10-01');
      assert.strictEqual(king.scoreDate, '2026-10-01');
      assert.ok(Math.abs(king.score - Number(rows[0].score)) < 1e-9);
      assert.deepStrictEqual(king.contenders.map(c => c.symbol), ['BETA', 'GAMMA']);
    });

    test('re-running the same day recomputes scores but leaves the crown alone', async () => {
      const r = await kotp.runDailyCrowning({ now: T0 + 3600_000 });
      assert.strictEqual(r.reason, 'already_decided');
      assert.strictEqual(r.changed, false);
      const { rows } = await db.pool.query(`SELECT COUNT(*)::int AS n FROM kotp_reigns`);
      assert.strictEqual(rows[0].n, 1);
    });

    test('minimum reign holds, then the fading king is overtaken', async () => {
      // ALPHA (≈48.1) leads BETA (≈46.9) by about a point. Days 2 and 3 are inside the
      // minimum reign; on day 4 ALPHA counts 0.94 × 48.1 + 2 = 47.2 and defends; on day 5
      // it counts 0.88 × 48.1 + 2 = 44.3 and BETA takes the crown.
      // The snapshot ages past 48h with a frozen DB, so refresh it each simulated day.
      const bump = async (now) => {
        await db.pool.query(`UPDATE tokens SET conviction_meta = conviction_meta || jsonb_build_object('snapshotAt', $2::bigint), conviction_computed_at = $3 WHERE mint_address = ANY($1)`,
          [MINTS, now - 3600_000, new Date(now - 3600_000)]);
      };
      const expected = { 1: 'min_reign', 2: 'min_reign', 3: 'defended' };
      let r;
      for (let d = 1; d <= 3; d++) {
        await bump(T0 + d * DAY);
        r = await kotp.runDailyCrowning({ now: T0 + d * DAY });
        assert.strictEqual(r.king, A, `day ${d + 1}`);
        assert.strictEqual(r.changed, false);
        assert.strictEqual(r.reason, expected[d], `day ${d + 1}`);
      }
      await bump(T0 + 4 * DAY);
      r = await kotp.runDailyCrowning({ now: T0 + 4 * DAY });
      assert.strictEqual(r.changed, true);
      assert.strictEqual(r.reason, 'overtaken');
      assert.strictEqual(r.king, B);

      const reigns = await kotp.getReigns();
      assert.strictEqual(reigns.length, 2);
      assert.strictEqual(reigns[0].mintAddress, B);
      assert.strictEqual(reigns[0].endedOn, null);
      assert.strictEqual(reigns[0].crownedOn, '2026-10-05');
      assert.strictEqual(reigns[1].mintAddress, A);
      assert.strictEqual(reigns[1].endedOn, '2026-10-05');

      const king = await kotp.getCurrentKing({ now: T0 + 4 * DAY });
      assert.strictEqual(king.mint, B);
      assert.strictEqual(king.reignDay, 1);
      assert.strictEqual(king.contenders[0].symbol, 'ALPHA');
    });

    test('a king that loses eligibility is replaced at once', async () => {
      const now = T0 + (PARAMS.maxReignDays + 1) * DAY;
      await db.pool.query(`UPDATE tokens SET conviction_meta = conviction_meta || jsonb_build_object('snapshotAt', $2::bigint) WHERE mint_address = ANY($1)`,
        [[A, C, D], now - 3600_000]);
      // BETA's snapshot goes stale
      await db.pool.query(`UPDATE tokens SET conviction_meta = conviction_meta || jsonb_build_object('snapshotAt', $2::bigint) WHERE mint_address = $1`,
        [B, now - 3 * DAY]);
      const r = await kotp.runDailyCrowning({ now });
      assert.strictEqual(r.skipped.stale_snapshot, 1);
      assert.strictEqual(r.changed, true);
      assert.strictEqual(r.reason, 'king_ineligible');
      // ALPHA is in cooldown (its reign ended four days ago), so GAMMA gets it
      assert.strictEqual(r.king, C);

      // Momentum now has a week of stored scores behind it
      const { rows } = await db.pool.query(`SELECT components FROM diamond_hands_scores WHERE mint_address = $1 AND score_date = '2026-10-09'`, [A]);
      assert.ok(Number.isFinite(rows[0].components.momentum));
      assert.strictEqual(rows[0].components.retention > 0, true);
    });
  });
}
