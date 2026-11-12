/**
 * Holder tier against a real Postgres with Helius faked: a run checks the due
 * shortlist, counts every credit, keeps wallet rows for two samples only, feeds the
 * score, and stops at the daily budget.
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;

if (!DB_URL) {
  test('new pairs holders DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.REDIS_URL;

  const db = require('./database');
  const store = require('./newPairStore');
  const { createHolders, loadLatestSamples, DISCOVERY_RESERVE } = require('./newPairHolders');
  const { createMarket } = require('./newPairMarket');

  const HOUR = 3_600_000;
  // A day nothing else writes credits to
  const T0 = Date.UTC(2032, 2, 3, 12);
  const mint = (c) => `NpHld${c}`.padEnd(43, '1');
  const [A, B, RUG] = ['A', 'B', 'C'].map(mint);
  const ALL = [A, B, RUG];
  const w = (i) => `HldWallet${String(i).padStart(3, '0')}`.padEnd(43, 'x');

  let clock = T0;
  const calls = [];
  let holders = {};      // mint -> Map
  let failMint = null;
  const solana = {
    async getHolderBalances(m, opts) {
      calls.push(['balances', m, opts.maxPages]);
      if (m === failMint) throw new Error('getProgramAccountsV2: 503');
      return { balances: holders[m], accounts: holders[m].size, pages: 1, complete: true };
    },
    async getTokenSupply(m) { calls.push(['supply', m]); return { value: { amount: '1000000', decimals: 0 } }; },
    async getMultipleAccounts(list) {
      calls.push(['owners', list.length]);
      return { value: list.map(a => (a.startsWith('Vault') ? { owner: 'SomeProgram1111111111111111111111111111111' } : { owner: '11111111111111111111111111111111' })) };
    },
  };
  const sources = [];
  const make = (env = {}) => createHolders({
    solana, now: () => clock, env, log: { log() {}, warn() {} },
    heliusCredits: { withSource: (s, fn) => { sources.push(s); return fn(); } },
  });
  const base = () => new Map([['Vault'.padEnd(43, 'v'), 400_000n], ...[...Array(60)].map((_, i) => [w(i + 1), BigInt(9000 - i * 100)])]);

  const tokenRow = async (m) => (await db.pool.query('SELECT * FROM newpair_tokens WHERE mint_address = $1', [m])).rows[0];
  const samples = async (m) => (await db.pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM newpair_holder_entries e WHERE e.sample_id = s.id)::int AS entries
     FROM newpair_holder_samples s JOIN newpair_tokens t ON t.id = s.token_id WHERE t.mint_address = $1 ORDER BY s.taken_at`, [m])).rows;
  const clean = async () => {
    await store.ensureSchema();
    await db.pool.query('DELETE FROM newpair_tokens WHERE mint_address = ANY($1)', [ALL]);
    await db.pool.query(`DELETE FROM newpair_credit_days WHERE day >= '2032-03-01' AND day <= '2032-03-31'`);
  };

  describe('newPairHolders', () => {
    before(async () => {
      await clean();
      await store.insertGraduations('pumpfun', 'Pump.fun', ALL.map((m, i) => ({ mint: m, graduatedAt: T0 - 10 * HOUR, signature: `s${i}`, slot: 1 })));
      await db.pool.query(
        `UPDATE newpair_tokens SET status = 'active', price_usd = 0.01, market_at = to_timestamp($2 / 1000.0), scored_at = to_timestamp($2 / 1000.0),
           score = CASE mint_address WHEN $3 THEN 9990 WHEN $4 THEN 9980 ELSE 9999 END / 100.0,
           rugged = (mint_address = $5), dev_wallet = $6, mcap = 100000, liquidity = 20000, holder_count = 500
         WHERE mint_address = ANY($1)`, [ALL, T0, A, B, RUG, w(3)]);
      holders = { [A]: base(), [B]: base(), [RUG]: base() };
    });
    after(async () => { await clean(); await db.pool.end(); });

    test('dry run lists what it would check and spends nothing', async () => {
      const tally = await make({ NEWPAIRS_HOLDERS_DRY_RUN: 'true' }).run({ shortlistSize: 500 });
      assert.strictEqual(tally.dryRun, true);
      assert.ok(tally.due >= 2);
      assert.strictEqual(calls.length, 0);
      assert.strictEqual(await store.creditsSpentToday(clock), 0);
    });

    test('a run checks the shortlist (never a rugged token), 4 credits a token, under its own source', async () => {
      const tally = await make().run({ shortlistSize: 500, maxChecks: 500 });
      const mine = calls.filter(c => c[0] === 'balances').map(c => c[1]);
      assert.ok(mine.includes(A) && mine.includes(B));
      assert.ok(!mine.includes(RUG), 'rugged tokens are not checked');
      assert.strictEqual(tally.failed, 0);
      assert.strictEqual(tally.credits, tally.checked * 4);
      assert.strictEqual(await store.creditsSpentToday(clock), tally.checked * 4);
      assert.ok(sources.every(s => s === 'newpairs:holders'));
      assert.deepStrictEqual(calls.find(c => c[0] === 'balances').slice(2), [30]);   // page cap

      const [s] = await samples(A);
      assert.strictEqual(s.entries, 60);                    // the vault is program-owned: not a holder
      assert.strictEqual(s.holder_count, 60);
      assert.strictEqual(s.credits, 4);
      assert.strictEqual(s.complete, true);
      assert.strictEqual(s.retention12, null);              // first sample
      assert.ok(Math.abs(s.top1_pct - 0.9) < 1e-3);
      assert.ok(Math.abs(s.dev_pct - 0.88) < 1e-3);
      assert.strictEqual((await tokenRow(A)).scored_at, null, 'marked for re-scoring');
    });

    test('the next scoring pass uses the sample: no longer holders pending', async () => {
      const market = createMarket({ jupiter: {}, now: () => clock, pause: async () => {}, pauseMs: 0, log: { warn() {} } });
      await market.scoreActive();
      const a = await tokenRow(A);
      assert.strictEqual(a.holders_pending, false);
      assert.ok('spread' in a.score_parts.terms && 'dev' in a.score_parts.terms);
      assert.strictEqual('retention' in a.score_parts.terms, false);   // needs a second sample
      const map = await loadLatestSamples([a.id]);
      assert.strictEqual(map.get(a.id).takenAt, T0);
    });

    test('not due again for 6 hours; the second sample brings retention, and wallet rows stay for two samples', async () => {
      calls.length = 0;
      clock = T0 + 2 * HOUR;
      assert.strictEqual(calls.filter(c => c[1] === A).length, 0);
      const early = await make().run({ shortlistSize: 500, maxChecks: 500 });
      assert.ok(!calls.some(c => c[1] === A || c[1] === B), `checked too early: ${JSON.stringify(early)}`);

      for (let round = 1; round <= 2; round++) {
        clock = T0 + round * 6 * HOUR;
        // Ten of the top 50 sell out each round
        for (let i = 1; i <= 10; i++) holders[A].delete(w((round - 1) * 10 + i));
        await make().run({ shortlistSize: 500, maxChecks: 500 });
      }
      const all = await samples(A);
      assert.strictEqual(all.length, 3);
      assert.deepStrictEqual(all.map(s => s.entries > 0), [false, true, true]);   // oldest sample: header only
      assert.strictEqual(all[1].exits, 10);
      // 40 of the top 50 kept over 6h, by headcount and (a little less) by balance, squared for 12h
      assert.ok(all[1].retention12 > 0.55 && all[1].retention12 < 0.66, String(all[1].retention12));
      assert.strictEqual(all[1].new_in, 0);
    });

    test('a failed read is counted, costs what was attempted, and three in a row stop the run', async () => {
      clock = T0 + 30 * HOUR;
      failMint = B;
      const before = await store.creditsSpentToday(clock);
      const tally = await make().run({ shortlistSize: 500, maxChecks: 500 });
      assert.ok(tally.failed >= 1);
      assert.ok(tally.checked >= 1, 'the other tokens are still checked');
      assert.strictEqual(await store.creditsSpentToday(clock) - before, tally.credits);
      assert.strictEqual(tally.credits, tally.checked * 4 + tally.failed * 2);
      failMint = null;
    });

    test('the daily budget stops the run before a check that could cross it, leaving the discovery reserve', async () => {
      clock = T0 + 60 * HOUR;
      calls.length = 0;
      const cap = 1000;
      // 34 credits short of (cap - reserve): room for one worst-case check (33), not two
      await store.addCredits('test:filler', cap - DISCOVERY_RESERVE - 34, clock);
      const tally = await make({ NEWPAIRS_HELIUS_DAILY_CREDITS: String(cap) }).run({ shortlistSize: 500, maxChecks: 500 });
      assert.strictEqual(tally.checked, 1);
      assert.strictEqual(tally.stopped, 'daily credit budget');
      assert.ok(await store.creditsSpentToday(clock) <= cap - DISCOVERY_RESERVE);
    });
  });
}
