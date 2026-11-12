/**
 * New Pairs cheap tier against a real Postgres, with Jupiter and DexScreener faked:
 * filing by the floors, the recheck ladder ending in a delete, the market refresh with
 * its stored series, and the DexScreener fallback leaving holder data alone.
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;

if (!DB_URL) {
  test('new pairs market DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.REDIS_URL;

  const db = require('./database');
  const store = require('./newPairStore');
  const { createMarket } = require('./newPairMarket');

  const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
  const T0 = Date.UTC(2026, 10, 12, 12);
  const mint = (c) => `NpMkt${c}`.padEnd(43, '1');
  const [BIG, SMALL, UNKNOWN, OLD, LATE] = ['A', 'B', 'C', 'D', 'E'].map(mint);
  const ALL = [BIG, SMALL, UNKNOWN, OLD, LATE];

  let clock = T0;
  let jupRows = {};        // mint -> partial Jupiter row
  let jupFails = false;
  let dexPairs = [];
  const jupCalls = []; const dexCalls = [];
  const jupiter = {
    async getTokensBatch(mints) {
      jupCalls.push(mints);
      if (jupFails) throw Object.assign(new Error('Request failed'), { response: { status: 503 } });
      return mints.filter(m => jupRows[m]).map(m => ({ id: m, name: `Token ${m.slice(5, 6)}`, symbol: 'T', launchpad: 'bags.fun', ...jupRows[m] }));
    },
  };
  const market = createMarket({
    jupiter, now: () => clock, pauseMs: 0, pause: async () => {}, log: { warn() {} },
    fetchDexScreener: async (mints) => { dexCalls.push(mints); return dexPairs.filter(p => mints.includes(p.baseToken.address)); },
  });

  const row = async (m) => (await db.pool.query('SELECT * FROM newpair_tokens WHERE mint_address = $1', [m])).rows[0];
  const points = async (m) => (await db.pool.query(
    'SELECT p.* FROM newpair_points p JOIN newpair_tokens t ON t.id = p.token_id WHERE t.mint_address = $1 ORDER BY p.at', [m])).rows;
  const clean = async () => { await store.ensureSchema(); await db.pool.query('DELETE FROM newpair_tokens WHERE mint_address = ANY($1)', [ALL]); };
  const grad = (m, at) => ({ mint: m, quoteMint: null, graduatedAt: at, signature: `sig-${m.slice(5, 6)}`, slot: 1 });

  describe('newPairMarket', () => {
    before(async () => {
      await clean();
      await store.insertGraduations('meteora-dbc', 'Meteora DBC', [
        grad(BIG, T0 - 5 * MIN), grad(SMALL, T0 - 5 * MIN), grad(UNKNOWN, T0 - 5 * MIN), grad(OLD, T0 - 4 * DAY), grad(LATE, T0 - 2 * HOUR),
      ]);
    });
    after(async () => { await clean(); await db.pool.end(); });

    test('fileNewTokens: above the floors is active, below gets a recheck, unknown waits, too old is deleted', async () => {
      jupRows = {
        [BIG]: { mcap: 90000, liquidity: 20000, usdPrice: 0.00009, holderCount: 800 },
        [SMALL]: { mcap: 9000, liquidity: 20000, holderCount: 40 },
        [OLD]: { mcap: 100, liquidity: 50 },
        [LATE]: { mcap: 30000, liquidity: 1000 },
      };
      const tally = await market.fileNewTokens();
      assert.deepStrictEqual({ ...tally }, { calls: 1, active: 1, below: 2, deleted: 1, waiting: 1, error: null });

      const big = await row(BIG);
      assert.strictEqual(big.status, 'active');
      assert.strictEqual(big.name, 'Token A');
      assert.strictEqual(big.launchpad, 'Bags');          // Jupiter's label refines the detector's
      assert.strictEqual(big.jup_launchpad, 'bags.fun');
      assert.strictEqual(big.holder_count, 800);
      assert.strictEqual(new Date(big.holders_at).getTime(), T0);
      assert.strictEqual(big.peak_mcap, 90000);
      assert.strictEqual(big.market_source, 'jupiter');
      assert.strictEqual(new Date(big.active_at).getTime(), T0);

      const small = await row(SMALL);
      assert.strictEqual(small.status, 'below_floor');
      assert.strictEqual(new Date(small.next_recheck_at).getTime(), T0 - 5 * MIN + HOUR);
      const late = await row(LATE);
      assert.strictEqual(late.recheck_step, 1);
      assert.strictEqual(new Date(late.next_recheck_at).getTime(), T0 - 2 * HOUR + 6 * HOUR);
      assert.strictEqual((await row(UNKNOWN)).status, 'new');
      assert.strictEqual(await row(OLD), undefined);
    });

    test('a token Jupiter still does not know an hour after graduating is filed below the floor', async () => {
      clock = T0 + HOUR;
      const tally = await market.fileNewTokens();
      assert.strictEqual(tally.below, 1);
      assert.strictEqual((await row(UNKNOWN)).status, 'below_floor');
      assert.strictEqual((await row(UNKNOWN)).recheck_step, 1);
    });

    test('recheck: only due tokens are read; a late bloomer becomes active, the rest move up the ladder', async () => {
      clock = T0 + HOUR;
      jupCalls.length = 0;
      jupRows[SMALL] = { mcap: 60000, liquidity: 8000, holderCount: 300 };
      const tally = await market.recheck();
      assert.deepStrictEqual(jupCalls, [[SMALL]]);       // UNKNOWN and LATE are not due yet
      assert.strictEqual(tally.active, 1);
      assert.strictEqual((await row(SMALL)).status, 'active');
      assert.strictEqual((await row(SMALL)).next_recheck_at, null);

      // LATE's last look (+3d) passes while it is still below: deleted
      clock = T0 - 2 * HOUR + 3 * DAY + MIN;
      await db.pool.query(`UPDATE newpair_tokens SET next_recheck_at = to_timestamp($2 / 1000.0) WHERE mint_address = $1`, [LATE, clock - MIN]);
      const last = await market.recheck();
      assert.ok(last.deleted >= 1);
      assert.strictEqual(await row(LATE), undefined);
      clock = T0 + HOUR;
    });

    test('refreshMarket: updates rows, tracks the peak, thins the series and slows down under the floors', async () => {
      clock = T0 + HOUR + 10 * MIN;
      jupRows[BIG] = { mcap: 150000, liquidity: 30000, usdPrice: 0.00015, holderCount: 1200 };
      jupRows[SMALL] = { mcap: 2000, liquidity: 100, holderCount: 280 };   // rugged after listing
      let tally = await market.refreshMarket();
      assert.strictEqual(tally.due, 2);
      assert.strictEqual(tally.refreshed, 2);
      assert.strictEqual(tally.live, 1);
      assert.strictEqual(tally.underFloor, 1);
      assert.strictEqual(tally.points, 2);
      assert.strictEqual(tally.source, 'jupiter');
      let big = await row(BIG);
      assert.strictEqual(big.peak_mcap, 150000);
      assert.strictEqual(new Date(big.next_market_at).getTime(), clock + 9 * MIN);
      const small = await row(SMALL);
      assert.strictEqual(small.status, 'active');         // stays listed, shown as rugged
      assert.strictEqual(small.peak_mcap, 60000);
      assert.strictEqual(new Date(small.next_market_at).getTime(), clock + 55 * MIN);

      // 10 minutes later: only the live token is due, and no new point yet (hourly)
      clock += 10 * MIN;
      jupRows[BIG] = { mcap: 120000, liquidity: 30000, holderCount: 1250 };
      tally = await market.refreshMarket();
      assert.strictEqual(tally.due, 1);
      assert.strictEqual(tally.points, 0);
      big = await row(BIG);
      assert.strictEqual(big.mcap, 120000);
      assert.strictEqual(big.peak_mcap, 150000);          // the peak does not come down
      assert.strictEqual((await points(BIG)).length, 1);

      // An hour after the first point: a second one
      clock += 50 * MIN;
      tally = await market.refreshMarket();
      assert.strictEqual(tally.points, 2);
      const series = await points(BIG);
      assert.deepStrictEqual(series.map(p => p.holder_count), [1200, 1250]);
      assert.deepStrictEqual(series.map(p => p.mcap), [150000, 120000]);
    });

    test('Jupiter down: DexScreener updates price, market cap and liquidity; holders keep their age', async () => {
      clock += 10 * MIN;
      const before = await row(BIG);
      jupFails = true;
      dexCalls.length = 0;
      dexPairs = [{ baseToken: { address: BIG }, priceUsd: '0.0002', marketCap: 200000, liquidity: { usd: 41000 }, volume: { h1: 5000 } }];
      const tally = await market.refreshMarket();
      assert.strictEqual(tally.source, 'dexscreener');
      assert.strictEqual(tally.error, null);
      assert.deepStrictEqual(dexCalls, [[BIG]]);
      const big = await row(BIG);
      assert.strictEqual(big.mcap, 200000);
      assert.strictEqual(big.liquidity, 41000);
      assert.strictEqual(big.peak_mcap, 200000);
      assert.strictEqual(big.market_source, 'dexscreener');
      assert.strictEqual(big.holder_count, 1250);
      assert.strictEqual(new Date(big.holders_at).getTime(), new Date(before.holders_at).getTime());
      assert.strictEqual(big.name, 'Token A');
      assert.deepStrictEqual(big.market.dexStats, { '1h': { volume: 5000 } });
      assert.ok(big.market.audit, 'Jupiter audit data is kept');
      jupFails = false;
    });

    test('a token no source returns is pushed back an hour, not re-read every run', async () => {
      clock += 10 * MIN;
      delete jupRows[BIG];
      const tally = await market.refreshMarket();
      assert.strictEqual(tally.missing, 1);
      assert.strictEqual(new Date((await row(BIG)).next_market_at).getTime(), clock + 55 * MIN);
    });

    test('both sources down: the run reports it and nothing is rescheduled', async () => {
      clock += 2 * HOUR;
      jupFails = true;
      const failing = createMarket({
        jupiter, now: () => clock, pauseMs: 0, pause: async () => {}, log: { warn() {} },
        fetchDexScreener: async () => { throw Object.assign(new Error('x'), { response: { status: 429 } }); },
      });
      const before = await row(BIG);
      const tally = await failing.refreshMarket();
      assert.match(tally.error, /both sources failed: 429/);
      assert.strictEqual(new Date((await row(BIG)).next_market_at).getTime(), new Date(before.next_market_at).getTime());
      jupFails = false;
    });
  });
}
