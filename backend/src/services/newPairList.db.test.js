/**
 * New Pairs read side against a real Postgres: what is listed, the order, the window,
 * each row's state and ages, and the lite-page payload with holder changes.
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;

if (!DB_URL) {
  test('new pairs list DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.REDIS_URL;

  const db = require('./database');
  const store = require('./newPairStore');
  const list = require('./newPairList');

  const HOUR = 3_600_000; const DAY = 24 * HOUR;
  // Far in the future so no other test's rows fall inside these windows
  const NOW = Date.UTC(2033, 5, 15, 12);
  const mint = (c) => `NpLst${c}`.padEnd(43, '1');
  const [TOP, PENDING, RUGGED, OLD, BELOW, AUTH, CUR] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(mint);
  const ALL = [TOP, PENDING, RUGGED, OLD, BELOW, AUTH, CUR];
  const w = (i) => `LstWallet${String(i).padStart(3, '0')}`.padEnd(43, 'x');

  const clean = async () => {
    await store.ensureSchema();
    await db.pool.query('DELETE FROM newpair_tokens WHERE mint_address = ANY($1)', [ALL]);
    await db.pool.query('DELETE FROM curated_tokens WHERE mint_address = ANY($1)', [ALL]);
    await db.pool.query('DELETE FROM tokens WHERE mint_address = ANY($1)', [ALL]);
  };
  async function seed(m, { ageH, score, status = 'active', rugged = false, pending = true, unlisted = null, mcap = 100000, peak = 125000 }) {
    await store.insertGraduations('pumpfun', 'Pump.fun', [{ mint: m, graduatedAt: NOW - ageH * HOUR, signature: `sig${m.slice(5, 6)}`, slot: 7 }]);
    await db.pool.query(
      `UPDATE newpair_tokens SET status = $2, name = $3, symbol = 'SYM', logo_uri = 'https://img.example/x.png', score = $4, rugged = $5,
         holders_pending = $6, unlisted_reason = $7, price_usd = 0.0001, mcap = $8, peak_mcap = $9, liquidity = 20000, holder_count = 1500,
         market = $10, market_at = to_timestamp($11 / 1000.0), holders_at = to_timestamp($11 / 1000.0), scored_at = to_timestamp($12 / 1000.0),
         score_parts = $13
       WHERE mint_address = $1`,
      [m, status, `Token ${m.slice(5, 6)}`, score, rugged, pending, unlisted, mcap, peak,
       JSON.stringify({ stats: { '24h': { buyVolume: 6000, sellVolume: 4000, priceChange: 12 } } }), NOW - 4 * 60_000, NOW - 3 * 60_000,
       JSON.stringify({ confidence: 0.9, risk: rugged ? 0.25 : 0.8, coverage: 0.65, growth24: 14.2, terms: { growth: 0.7 }, riskParts: { wash: 0.8, sybil: 1, whale: 1, bundle: 1, rug: rugged ? 0.25 : 1 } })]);
    return (await db.pool.query('SELECT id FROM newpair_tokens WHERE mint_address = $1', [m])).rows[0].id;
  }
  async function sample(tokenId, at, amounts, extra = {}) {
    const { rows } = await db.pool.query(
      `INSERT INTO newpair_holder_samples (token_id, taken_at, holder_count, dust_count, complete, top1_pct, top10_pct, top50_pct, dev_pct, retention12, new_in, exits)
       VALUES ($1, to_timestamp($2 / 1000.0), 1400, 300, TRUE, 4, 20, 40, 0.5, $3, 1, 1) RETURNING id`, [tokenId, at, extra.retention ?? null]);
    for (const [i, [wallet, amount]] of amounts.entries()) {
      await db.pool.query('INSERT INTO newpair_holder_entries (sample_id, rank, wallet, amount) VALUES ($1, $2, $3, $4)', [rows[0].id, i + 1, wallet, amount]);
    }
  }

  describe('newPairList', () => {
    let topId;
    before(async () => {
      await db.getInitializationPromise();   // curated_tokens comes from database.js
      await clean();
      topId = await seed(TOP, { ageH: 30, score: 71.5, pending: false });
      await seed(PENDING, { ageH: 5, score: 55.4 });
      await seed(RUGGED, { ageH: 40, score: 5.7, rugged: true, mcap: 10000, peak: 100000 });
      await seed(OLD, { ageH: 10 * 24, score: 90 });
      await seed(BELOW, { ageH: 10, score: 99, status: 'below_floor' });
      await seed(AUTH, { ageH: 10, score: 99, unlisted: 'authority_enabled' });
      await seed(CUR, { ageH: 20, score: 60 });
      await db.pool.query(`INSERT INTO tokens (mint_address, name, symbol) VALUES ($1, 'Cur', 'CUR') ON CONFLICT DO NOTHING`, [CUR]);
      await db.pool.query(`INSERT INTO curated_tokens (mint_address, is_emerging_cult) VALUES ($1, TRUE) ON CONFLICT DO NOTHING`, [CUR]);
      // Two samples for TOP: wallet 1 halved, wallet 2 left, wallet 9 is new
      await sample(topId, NOW - 8 * HOUR, [[w(1), '4000'], [w(2), '3000'], [w(3), '2000']]);
      await sample(topId, NOW - 2 * HOUR, [[w(3), '2500'], [w(1), '2000'], [w(9), '500']], { retention: 0.82 });
      await db.pool.query(
        `INSERT INTO newpair_points (token_id, at, price_usd, mcap, liquidity, holder_count, source)
         VALUES ($1, to_timestamp($2 / 1000.0), 0.0001, 90000, 20000, 1300, 'jupiter'), ($1, to_timestamp($3 / 1000.0), 0.0001, 100000, 20000, 1500, 'jupiter')`,
        [topId, NOW - 5 * HOUR, NOW - HOUR]);
    });
    after(async () => { await clean(); await db.pool.end(); });

    test('7d list: only listed tokens inside the window, best score first, with states and ages', async () => {
      const r = await list.buildList('7d', { now: NOW });
      const mine = r.tokens.filter(t => ALL.includes(t.mint));
      assert.deepStrictEqual(mine.map(t => t.mint), [TOP, CUR, PENDING, RUGGED]);
      assert.deepStrictEqual(r.floors, { marketCap: 25000, liquidity: 5000 });
      assert.strictEqual(r.window, '7d');
      assert.ok(r.total >= 4 && r.rugged >= 1);
      assert.strictEqual(r.scoredAt, new Date(NOW - 3 * 60_000).toISOString());
      assert.deepStrictEqual(r.tokens.map(t => t.rank), r.tokens.map((_, i) => i + 1));

      const top = mine[0];
      assert.strictEqual(top.score, 71.5);
      assert.strictEqual(top.scoreState, 'full');
      assert.strictEqual(top.name, 'Token A');
      assert.strictEqual(top.launchpad, 'Pump.fun');
      assert.strictEqual(top.graduatedSource, 'onchain:pumpfun');
      assert.strictEqual(top.volume24h, 10000);
      assert.strictEqual(top.priceChange24h, 12);
      assert.strictEqual(top.drawdown, 0.2);
      assert.strictEqual(top.holders, 1500);
      assert.strictEqual(top.holdersChange24h, 14.2);
      assert.strictEqual(top.holdersExact, 1400);
      assert.strictEqual(top.top10Pct, 20);
      assert.ok(Math.abs(top.retention12h - 0.82) < 1e-6);
      assert.deepStrictEqual(top.flags, ['wash']);
      assert.deepStrictEqual(top.at, {
        market: new Date(NOW - 4 * 60_000).toISOString(), holders: new Date(NOW - 4 * 60_000).toISOString(),
        top50: new Date(NOW - 2 * HOUR).toISOString(), scored: new Date(NOW - 3 * 60_000).toISOString(),
      });

      const pending = mine.find(t => t.mint === PENDING);
      assert.strictEqual(pending.scoreState, 'holders_pending');
      assert.strictEqual(pending.top10Pct, null);
      assert.strictEqual(pending.at.top50, null);
      const rugged = mine.find(t => t.mint === RUGGED);
      assert.strictEqual(rugged.rugged, true);
      assert.deepStrictEqual(rugged.flags, ['rugged', 'wash']);
      assert.strictEqual(rugged.drawdown, 0.9);
      const cur = mine.find(t => t.mint === CUR);
      assert.strictEqual(cur.curated, true);
      assert.strictEqual(cur.emergingCult, true);
    });

    test('windows: 3d and 14d cut by graduation time; an unknown window throws', async () => {
      const three = (await list.buildList('3d', { now: NOW })).tokens.map(t => t.mint);
      assert.ok(three.includes(TOP) && !three.includes(OLD));
      const fourteen = (await list.buildList('14d', { now: NOW })).tokens.filter(t => ALL.includes(t.mint)).map(t => t.mint);
      assert.strictEqual(fourteen[0], OLD);
      await assert.rejects(() => list.buildList('30d', { now: NOW }), /Unknown window/);
    });

    test('a sample goes stale at 14h and stops counting at 36h', async () => {
      const at = (h) => list.buildList('14d', { now: NOW + h * HOUR }).then(r => r.tokens.find(t => t.mint === TOP));
      assert.strictEqual((await at(13)).scoreState, 'holders_stale');     // sample is 15h old
      const gone = await at(35);                                         // 37h old
      assert.strictEqual(gone.scoreState, 'holders_pending');
      assert.strictEqual(gone.top10Pct, 20, 'the last sample is still shown, with its age');
    });

    test('lite page: rank, top holders with change and new marks, exits, sample history and series', async () => {
      const p = await list.buildToken(TOP, { now: NOW });
      assert.strictEqual(p.curated, false);
      assert.strictEqual(p.token.mint, TOP);
      assert.strictEqual(p.token.rank, 2);                 // OLD (90) outranks it in the 14d window
      assert.strictEqual(p.weights.growth, 0.2);
      assert.strictEqual(p.topHolders.sampledAt, new Date(NOW - 2 * HOUR).toISOString());
      assert.strictEqual(p.topHolders.previousSampledAt, new Date(NOW - 8 * HOUR).toISOString());
      assert.deepStrictEqual(p.topHolders.holders.map(h => [h.wallet, h.changePct, h.isNew]), [[w(3), 25, false], [w(1), -50, false], [w(9), null, true]]);
      // Shares add up to the sample's top-50 share
      assert.ok(Math.abs(p.topHolders.holders.reduce((s, h) => s + h.pct, 0) - 40) < 0.01);
      assert.deepStrictEqual(p.topHolders.exited, [w(2)]);
      assert.strictEqual(p.samples.length, 2);
      assert.strictEqual(p.samples[0].at, new Date(NOW - 2 * HOUR).toISOString());
      assert.deepStrictEqual(p.series.map(s => s.holders), [1300, 1500]);
    });

    test('lite page: curated tokens point to the full page; unlisted, below-floor and unknown mints are null', async () => {
      assert.deepStrictEqual(await list.buildToken(CUR, { now: NOW }), { curated: true, mint: CUR });
      assert.strictEqual(await list.buildToken(AUTH, { now: NOW }), null);
      assert.strictEqual(await list.buildToken(BELOW, { now: NOW }), null);
      assert.strictEqual(await list.buildToken(mint('Z'), { now: NOW }), null);
      const pending = await list.buildToken(PENDING, { now: NOW });
      assert.deepStrictEqual(pending.topHolders, { sampledAt: null, previousSampledAt: null, holders: [], exited: [] });
    });
  });
}
