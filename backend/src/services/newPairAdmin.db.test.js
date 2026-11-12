/**
 * New Pairs admin side against a real Postgres: the preview shows what the public list
 * hides, hiding a token takes it off the public list and the holder shortlist, promote
 * runs the curated add once for a known token, and settings are stored and bounded.
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;

if (!DB_URL) {
  test('new pairs admin DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.REDIS_URL;

  const db = require('./database');
  const store = require('./newPairStore');
  const list = require('./newPairList');
  const admin = require('./newPairAdmin');
  const settings = require('./newPairSettings');
  const { cache } = require('./cache');
  const { SETTINGS_KEY } = require('./newPairMarket');

  const HOUR = 3_600_000;
  // Far in the future, and apart from the other New Pairs DB tests' windows
  const NOW = Date.UTC(2035, 2, 10, 12);
  const mint = (c) => `NpAdm${c}`.padEnd(43, '1');
  const [GOOD, HIDE, RUG, BELOW] = ['A', 'B', 'C', 'D'].map(mint);
  const ALL = [GOOD, HIDE, RUG, BELOW];
  const ENV = { NEWPAIRS_HELIUS_DAILY_CREDITS: '8000', NEWPAIRS_PUBLIC: 'false' };

  const clean = async () => {
    await store.ensureSchema();
    await db.pool.query('DELETE FROM newpair_tokens WHERE mint_address = ANY($1)', [ALL]);
    await db.pool.query('DELETE FROM newpair_credit_days WHERE day >= $1', ['2035-03-01']);
    await db.setSetting(SETTINGS_KEY, null);
  };
  async function seed(m, { score, status = 'active', rugged = false }) {
    await store.insertGraduations('pumpfun', 'Pump.fun', [{ mint: m, graduatedAt: NOW - 20 * HOUR, signature: `adm${m.slice(5, 6)}`, slot: 9 }]);
    await db.pool.query(
      `UPDATE newpair_tokens SET status = $2, name = $3, score = $4, rugged = $5, mcap = 100000, liquidity = 20000, holder_count = 900,
         market_at = to_timestamp($6 / 1000.0), scored_at = to_timestamp($6 / 1000.0), score_parts = $7 WHERE mint_address = $1`,
      [m, status, `Adm ${m.slice(5, 6)}`, score, rugged, NOW - 5 * 60_000, JSON.stringify({ quality: 0.7, confidence: 0.9, risk: 1, terms: { growth: 0.7 }, riskParts: {} })]);
  }
  const publicMints = async () => (await list.buildList('14d', { now: NOW })).tokens.map(t => t.mint).filter(m => ALL.includes(m));

  describe('newPairAdmin', () => {
    before(async () => {
      await db.getInitializationPromise();
      await clean();
      await seed(GOOD, { score: 70 });
      await seed(HIDE, { score: 65 });
      await seed(RUG, { score: 9, rugged: true });
      await seed(BELOW, { score: 50, status: 'below_floor' });
      await store.addCredits('newpairs:holders', 1200, NOW);
      await store.addCredits('newpairs:discover', 300, NOW);
      await store.addCredits('newpairs:holders', 900, NOW - 24 * HOUR);
    });
    after(async () => { await clean(); await db.pool.end(); });

    test('preview: tokens by score, counts, credits against the cap, every detector', async () => {
      const p = await admin.preview({ now: NOW, env: ENV });
      const mine = p.tokens.filter(t => ALL.includes(t.mint));
      assert.deepStrictEqual(mine.map(t => t.mint), [GOOD, HIDE, RUG], 'active tokens only, best first, rugged included');
      assert.strictEqual(mine[0].quality, 0.7);
      assert.strictEqual(mine[0].hidden, false);
      assert.strictEqual(p.public, false);
      assert.ok(p.counts.active >= 3 && p.counts.belowFloor >= 1 && p.counts.rugged >= 1);
      assert.strictEqual(p.credits.today, '2035-03-10');
      assert.strictEqual(p.credits.spentToday, 1500);
      assert.strictEqual(p.credits.cap, 8000);
      assert.strictEqual(p.credits.left, 6500);
      assert.deepStrictEqual(p.credits.days.map(d => [d.day, d.total]), [['2035-03-10', 1500], ['2035-03-09', 900]]);
      assert.deepStrictEqual(p.credits.days[0].sources, { 'newpairs:discover': 300, 'newpairs:holders': 1200 });
      assert.deepStrictEqual(p.detectors.map(d => d.id).sort(), ['launchlab', 'meteora-dbc', 'pumpfun']);
      for (const d of p.detectors) assert.ok('lastError' in d && 'missRate' in d && 'cursorTime' in d);
    });

    test('hiding a token takes it off the public list, the lite page and the holder shortlist; showing brings it back', async () => {
      assert.deepStrictEqual(await publicMints(), [GOOD, HIDE, RUG]);
      // A cached public answer must not outlive the change
      await cache.set('newpairs:list:14d', { stale: true }, 60_000);
      await cache.set(`newpairs:token:${HIDE}`, { stale: true }, 60_000);

      assert.strictEqual(await admin.setHidden(HIDE, true), true);
      assert.deepStrictEqual(await publicMints(), [GOOD, RUG]);
      assert.strictEqual(await list.buildToken(HIDE, { now: NOW }), null);
      assert.ok(!(await cache.get('newpairs:list:14d')));
      assert.ok(!(await cache.get(`newpairs:token:${HIDE}`)));
      const shortlisted = await db.pool.query(
        `SELECT mint_address FROM newpair_tokens t WHERE t.status = 'active' AND NOT t.rugged AND NOT t.hidden AND t.unlisted_reason IS NULL AND t.score IS NOT NULL AND mint_address = ANY($1)`, [ALL]);
      assert.deepStrictEqual(shortlisted.rows.map(r => r.mint_address), [GOOD]);

      const p = await admin.preview({ now: NOW, env: ENV });
      const row = p.tokens.find(t => t.mint === HIDE);
      assert.strictEqual(row.hidden, true, 'the preview still shows it, marked');
      assert.ok(row.hiddenAt);
      assert.ok(p.counts.hidden >= 1);

      assert.strictEqual(await admin.setHidden(HIDE, false), true);
      assert.deepStrictEqual(await publicMints(), [GOOD, HIDE, RUG]);
      assert.strictEqual(await admin.setHidden(mint('Z'), true), false, 'unknown mint');
    });

    test('promote runs the curated add for a finder token and refuses a mint the finder does not have', async () => {
      const added = [];
      const addCurated = async (m) => { added.push(m); return { token: { mintAddress: m }, alreadyCurated: false }; };
      assert.deepStrictEqual(await admin.promote(GOOD, { addCurated }), { token: { mintAddress: GOOD }, alreadyCurated: false });
      assert.strictEqual(await admin.promote(mint('Z'), { addCurated }), null);
      assert.deepStrictEqual(added, [GOOD]);
    });

    test('settings: stored, read back, and the daily credits cannot go above the env ceiling', async () => {
      assert.deepStrictEqual(await settings.get(ENV), { minMcap: 25000, minLiquidity: 5000, shortlistSize: 50, dailyCredits: 8000, maxDailyCredits: 8000 });
      const saved = await settings.save({ minMcap: 40000, shortlistSize: 30, dailyCredits: 5000 }, ENV);
      assert.deepStrictEqual(saved, { minMcap: 40000, minLiquidity: 5000, shortlistSize: 30, dailyCredits: 5000, maxDailyCredits: 8000 });
      assert.strictEqual(await settings.dailyCap(ENV), 5000);
      assert.deepStrictEqual(await require('./newPairMarket').getFloors(), { minMcap: 40000, minLiquidity: 5000 }, 'the market job reads the same floors');
      await assert.rejects(settings.save({ dailyCredits: 8001 }, ENV), e => e.status === 400 && /cannot be above 8000/.test(e.message));
      assert.strictEqual(await settings.dailyCap(ENV), 5000, 'a refused change stores nothing');
      // The ceiling lowered in the environment wins over a stored figure
      assert.strictEqual(await settings.dailyCap({ NEWPAIRS_HELIUS_DAILY_CREDITS: '3000' }), 3000);
      // The holder tier's budget follows the setting: 5000, less the discovery reserve, less today's 1500
      const holders = require('./newPairHolders').createHolders({ now: () => NOW, env: ENV });
      assert.strictEqual(await holders.creditsLeft(), 5000 - 600 - 1500);
    });
  });
}
