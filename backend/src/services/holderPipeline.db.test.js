/**
 * Holder pipeline end to end against a real Postgres, with Solana/Helius mocked:
 * snapshot → positions → sample → backfill → diamond hands, then follow-up
 * snapshots (new, departed and re-bought wallets), capped snapshots, and the
 * resumable backfill.
 *
 * Runs only when TEST_DATABASE_URL is set (CI provides a Postgres service).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;

if (!DB_URL) {
  test('holder pipeline DB tests (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.REDIS_URL;

  const db = require('./database');
  const solana = require('./solana');
  const jobQueue = require('./jobQueue');
  const { cache } = require('./cache');
  const store = require('./holderStore');
  const pipeline = require('./holderPipeline');

  const MINT = 'TestMint1111111111111111111111111111111111';
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  // Recent, so the 30-day retention (measured with the DB's NOW()) keeps these snapshots
  const T0 = Math.floor(Date.now() / DAY) * DAY - DAY;
  const realNow = Date.now;
  let now = T0;

  // ── Mocks ──────────────────────────────────────────────────────────────────
  // Chain state the mocks serve: wallet → { amount (raw), history: [{sig, ts(sec), delta}] newest first }
  let chain = {};
  let capped = false;
  const queued = [];
  const ata = w => `ata_${w}`;
  const walletOfAta = a => a.slice(4);

  function setHolder(wallet, amount, history) {
    chain[wallet] = { amount: BigInt(amount), history: history || [] };
  }

  before(async () => {
    Date.now = () => now;
    await db.getInitializationPromise();
    await db.pool.query('DELETE FROM holder_snapshots WHERE mint_address = $1', [MINT]);
    await db.pool.query('DELETE FROM holder_positions WHERE mint_address = $1', [MINT]);
    await db.pool.query('DELETE FROM holder_count_points WHERE mint_address = $1', [MINT]);

    solana.getTokenSupply = async () => ({ value: { amount: '1000000000000', decimals: 6 } });
    solana.getAllTokenAccounts = async () => {
      const accounts = Object.entries(chain)
        .filter(([, h]) => h.amount > 0n)
        .map(([w, h]) => ({ owner: w, address: ata(w), amount: h.amount.toString() }));
      return capped
        ? { accounts: accounts.slice(0, Math.floor(accounts.length / 2)), pages: 1, complete: false }
        : { accounts, pages: 1, complete: true };
    };
    // POOL's account is owned by an LP program
    solana.getMultipleAccounts = async addrs => ({
      value: addrs.map(a => (a === 'POOL' ? { owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' }
        : a === 'ata_WHALE' ? { data: { parsed: { info: { owner: 'WHALE' } } } } : null)),
    });
    // standard RPC's 20 largest: a whale that a capped DAS read happens to miss
    solana.getTokenLargestAccounts = async () => [{ address: 'ata_WHALE', amount: '800000000000' }];
    solana.getTokenAccountBalance = async a => ({ value: { amount: (chain[walletOfAta(a)]?.amount ?? 0n).toString() } });
    solana.getSignaturesPage = async (a, { limit = 100, before } = {}) => {
      const hist = chain[walletOfAta(a)]?.history || [];
      const start = before ? hist.findIndex(t => t.sig === before) + 1 : 0;
      return hist.slice(start, start + limit).map(t => ({ signature: t.sig, blockTime: t.ts, err: null }));
    };
    solana.parseTransactions = async sigs => sigs.map(sig => {
      for (const [w, h] of Object.entries(chain)) {
        const t = h.history.find(x => x.sig === sig);
        if (t) {
          return {
            signature: sig, timestamp: t.ts,
            accountData: [{ tokenBalanceChanges: [{ tokenAccount: ata(w), mint: MINT, rawTokenAmount: { tokenAmount: t.delta.toString(), decimals: 6 } }] }],
          };
        }
      }
      return null;
    }).filter(Boolean);
    jobQueue.addAnalyticsJob = async (name, data) => { queued.push({ name, data }); return { id: queued.length }; };
  });

  after(async () => {
    Date.now = realNow;
    await db.pool.query('DELETE FROM holder_snapshots WHERE mint_address = $1', [MINT]).catch(() => {});
    await db.pool.query('DELETE FROM holder_positions WHERE mint_address = $1', [MINT]).catch(() => {});
    await db.pool.query('DELETE FROM holder_count_points WHERE mint_address = $1', [MINT]).catch(() => {});
    await db.pool.end();
  });

  async function drainBackfill() {
    for (let i = 0; i < 50; i++) {
      const r = await pipeline.runBackfill(MINT);
      if (!r.remaining) return r;
    }
    throw new Error('backfill did not finish');
  }

  async function position(wallet) {
    return (await store.getPositions(MINT, [wallet])).get(wallet);
  }

  describe('holder pipeline (Postgres)', () => {
    test('first snapshot stores every holder as pending and draws a sample without LP wallets', async () => {
      chain = {};
      setHolder('POOL', 400_000_000_000);
      // 300 wallets, each bought once; wallet i bought i days before T0
      for (let i = 0; i < 300; i++) {
        const w = `W${String(i).padStart(3, '0')}`;
        const amount = 1_000_000_000 - i * 1_000_000;
        setHolder(w, amount, [{ sig: `buy_${w}`, ts: (T0 - i * DAY) / 1000, delta: BigInt(amount) }]);
      }

      const r = await pipeline.takeSnapshot(MINT);
      assert.strictEqual(r.status, 'ok');
      assert.strictEqual(r.holders, 301);
      assert.strictEqual(r.complete, true);

      const snap = await store.getLatestSnapshot(MINT);
      assert.strictEqual(snap.holder_count, 301);
      assert.strictEqual(snap.sample_meta.method, 'stratified-v1');
      assert.deepStrictEqual(snap.sample_meta.lpWallets, ['POOL']);
      assert.ok(!snap.sample.some(s => s.wallet === 'POOL'));
      assert.strictEqual(snap.sample.length, 250);

      const entries = await store.getSnapshotEntries(snap.id, 3);
      assert.deepStrictEqual(entries.map(e => e.wallet), ['POOL', 'W000', 'W001']);

      const p = await position('W010');
      assert.strictEqual(p.acquired_source, 'pending');
      assert.strictEqual(p.acquired_at, null);
      assert.ok(queued.some(q => q.name === 'backfill-holder-acquisitions'));
      // displayed count: unique wallets with a balance, LP wallet (POOL) excluded
      assert.strictEqual(await cache.get(`holder-total:${MINT}`), 300);
    });

    test('diamond hands waits for the backfill, then settles from transfer history', async () => {
      const partial = await pipeline.getDiamondHands(MINT, { dispatch: false });
      assert.strictEqual(partial.computed, false);
      assert.strictEqual(partial.analyzed, 0);
      assert.strictEqual(partial.sampleSize, 250);

      await drainBackfill();
      const p = await position('W010');
      assert.strictEqual(p.acquired_source, 'backfill');
      assert.strictEqual(new Date(p.acquired_at).getTime(), T0 - 10 * DAY);

      await cache.delete(`diamond-hands:${MINT}`);
      const dh = await pipeline.getDiamondHands(MINT, { dispatch: false });
      assert.strictEqual(dh.computed, true);
      assert.strictEqual(dh.analyzed, 250);
      // W000 bought at T0 (hold 0 → unresolved), everyone else 1..299 days
      assert.ok(dh.distribution['1w'] > 90, JSON.stringify(dh.distribution));
      assert.ok(dh.distribution['1yr'] === 0);
      assert.ok(dh.supplyDistribution['24h'] > 0);
    });

    test('hold times read straight from positions', async () => {
      const { holdTimes, computed } = await pipeline.getHoldTimes(MINT, ['W005', 'W006', 'POOL']);
      assert.strictEqual(computed, true); // POOL is an LP wallet: never backfilled, never waited on
      assert.strictEqual(holdTimes.POOL, undefined);
      assert.strictEqual(holdTimes.W005, 5 * DAY);
      assert.strictEqual(holdTimes.W006, 6 * DAY);
    });

    test('next snapshot: departed wallets go, newcomers are dated by the snapshot, holders keep their streak', async () => {
      now = T0 + HOUR;
      chain.W001.amount = 0n;                       // sold out
      chain.W002.amount = chain.W002.amount / 2n;   // partial sell
      setHolder('NEWBIE', 5_000_000_000);
      await pipeline.takeSnapshot(MINT);

      assert.strictEqual(await position('W001'), undefined);
      const w2 = await position('W002');
      assert.strictEqual(w2.acquired_source, 'backfill');
      assert.strictEqual(new Date(w2.acquired_at).getTime(), T0 - 2 * DAY);
      assert.strictEqual(w2.amount, String(chain.W002.amount));
      const nb = await position('NEWBIE');
      assert.strictEqual(nb.acquired_source, 'snapshot');
      assert.strictEqual(new Date(nb.acquired_at).getTime(), T0 + HOUR);
    });

    test('a wallet that sold out and came back starts a new streak', async () => {
      now = T0 + 2 * HOUR;
      chain.W001.amount = 7_000_000n;
      await pipeline.takeSnapshot(MINT);
      const w1 = await position('W001');
      assert.strictEqual(w1.acquired_source, 'snapshot');
      assert.strictEqual(new Date(w1.acquired_at).getTime(), T0 + 2 * HOUR);
    });

    test('after a long gap, newcomers need a backfill instead', async () => {
      now = T0 + 12 * HOUR;
      setHolder('LATE', 3_000_000_000, [{ sig: 'buy_LATE', ts: (T0 + 5 * HOUR) / 1000, delta: 3_000_000_000n }]);
      await pipeline.takeSnapshot(MINT);
      assert.strictEqual((await position('LATE')).acquired_source, 'pending');
    });

    test('a snapshot whose pre-check finds nothing changed is kept, and counts as fresh', async () => {
      now = T0 + 12.5 * HOUR;
      const before = await store.getLatestSnapshot(MINT);
      const r = await pipeline.takeSnapshot(MINT);
      assert.strictEqual(r.status, 'unchanged');
      assert.strictEqual(r.snapshotId, before.id);
      assert.strictEqual((await store.getLatestSnapshot(MINT)).id, before.id);
      const fresh = await pipeline.getFreshnessTimes([MINT]);
      assert.strictEqual(fresh[MINT], now);
      assert.ok(await pipeline.getSnapshotHolderList(MINT, { maxAgeMs: HOUR }), 'served as recent');
      assert.ok(await cache.get(`holder-snapshot-verified:${MINT}`));
      assert.strictEqual(new Date((await store.getLatestSnapshot(MINT)).verified_at).getTime(), now, 'verified_at recorded');
      // one page read in full: the count is confirmed now, so the history gets a point
      const pts = await require('./holderCounts').getPoints(MINT);
      const last = pts[pts.length - 1];
      assert.strictEqual(last.source, 'verified');
      assert.strictEqual(new Date(last.taken_at).getTime(), now);
      assert.strictEqual(last.holders, pts[pts.length - 2].holders);

      setHolder('CHANGED', 1_000_000, [{ sig: 'buy_CHANGED', ts: now / 1000, delta: 1_000_000n }]);
      assert.strictEqual((await pipeline.takeSnapshot(MINT)).status, 'ok');
      assert.strictEqual(await cache.get(`holder-snapshot-verified:${MINT}`), undefined);
    });

    test('no snapshot is written without supply and decimals, and an old one without supply is not served', async () => {
      now = T0 + 12.75 * HOUR;
      const before = await store.getLatestSnapshot(MINT);
      const realSupply = solana.getTokenSupply;
      solana.getTokenSupply = async () => { throw new Error('HTTP 403'); };
      try {
        await assert.rejects(pipeline.takeSnapshot(MINT));
        solana.getTokenSupply = async () => null;
        await assert.rejects(pipeline.takeSnapshot(MINT));
      } finally {
        solana.getTokenSupply = realSupply;
      }
      assert.strictEqual((await store.getLatestSnapshot(MINT)).id, before.id);
      await cache.delete(`holder-snapshot-pending:${MINT}`);

      // A snapshot left by the old code: decimals defaulted to 0, no supply
      await db.pool.query('UPDATE holder_snapshots SET supply = NULL, decimals = 0 WHERE id = $1', [before.id]);
      assert.strictEqual(await pipeline.getSnapshotHolderList(MINT, { maxAgeMs: DAY }), null);
      await cache.delete(`holder-snapshot-verified:${MINT}`);
      assert.strictEqual((await pipeline.getFreshnessTimes([MINT]))[MINT], undefined, 'schedulers see it as missing');
      // and the pre-check never keeps it, even though no holder moved
      const r = await pipeline.takeSnapshot(MINT);
      assert.strictEqual(r.status, 'ok');
      const fixed = await store.getLatestSnapshot(MINT);
      assert.strictEqual(fixed.decimals, 6);
      assert.strictEqual(fixed.supply, '1000000000000');
      const list = await pipeline.getSnapshotHolderList(MINT, { maxAgeMs: DAY });
      assert.strictEqual(list.decimals, 6);
      assert.strictEqual(list.totalSupply, 1_000_000);
    });

    test('a capped snapshot deletes nothing, and the snapshot after it trusts no newcomer', async () => {
      now = T0 + 13 * HOUR;
      capped = true;
      setHolder('CAPPEDNEW', 9_000_000_000);
      const before = (await db.pool.query('SELECT COUNT(*)::int AS n FROM holder_positions WHERE mint_address = $1', [MINT])).rows[0].n;
      await pipeline.takeSnapshot(MINT);
      const afterN = (await db.pool.query('SELECT COUNT(*)::int AS n FROM holder_positions WHERE mint_address = $1', [MINT])).rows[0].n;
      assert.ok(afterN >= before, `${afterN} < ${before}`);
      const snap = await store.getLatestSnapshot(MINT);
      assert.strictEqual(snap.complete, false);
      const [top] = await store.getSnapshotEntries(snap.id, 1);
      assert.strictEqual(top.wallet, 'WHALE', 'largest accounts merged into a capped snapshot');
      capped = false;

      now = T0 + 13.5 * HOUR;
      setHolder('AFTERCAP', 2_000_000_000);
      await pipeline.takeSnapshot(MINT);
      assert.strictEqual((await position('AFTERCAP')).acquired_source, 'pending');
    });

    test('backfill resumes across runs on a long history and finds the re-buy', async () => {
      // 250 txs newest first: 249 small top-ups, then a re-buy, preceded by a full sell and the first buy
      const w = 'BUSY';
      const hist = [];
      let ts = (T0 + 13 * HOUR) / 1000;
      for (let i = 0; i < 240; i++) hist.push({ sig: `busy_${i}`, ts: ts - i * 60, delta: 1000n });
      const rebuyTs = ts - 300 * 60;
      hist.push({ sig: 'busy_rebuy', ts: rebuyTs, delta: 10_000_000n });
      hist.push({ sig: 'busy_sellall', ts: rebuyTs - 3600, delta: -50_000_000n });
      hist.push({ sig: 'busy_firstbuy', ts: rebuyTs - 7200, delta: 50_000_000n });
      setHolder(w, 10_000_000n + 240_000n, hist);
      now = T0 + 14 * HOUR;
      await pipeline.takeSnapshot(MINT);
      // force the backfill path for this wallet
      await db.pool.query(`UPDATE holder_positions SET acquired_source = 'pending', acquired_at = NULL WHERE mint_address = $1 AND wallet = $2`, [MINT, w]);

      const prev = pipeline.CONFIG.backfillPagesPerWallet;
      pipeline.CONFIG.backfillPagesPerWallet = 1;
      try {
        let pos = await position(w);
        assert.strictEqual(await pipeline.backfillWallet(MINT, pos, 6), false);
        pos = await position(w);
        assert.ok(pos.backfill_cursor, 'cursor saved');
        assert.strictEqual(pos.backfill_pages, 1);
        assert.strictEqual(await pipeline.backfillWallet(MINT, pos, 6), false);
        pos = await position(w);
        assert.strictEqual(await pipeline.backfillWallet(MINT, pos, 6), true);
        pos = await position(w);
        assert.strictEqual(pos.acquired_source, 'backfill');
        assert.strictEqual(new Date(pos.acquired_at).getTime(), rebuyTs * 1000);
        assert.strictEqual(pos.backfill_pages, 3);
      } finally {
        pipeline.CONFIG.backfillPagesPerWallet = prev;
      }
    });

    test('backfill reads full transactions through getTransactionsForAddress when Helius serves it', async () => {
      // Same shape as the BUSY wallet above, served as getTransactionsForAddress pages
      const w = 'GTFA';
      const hist = [];
      let ts = (T0 + 14 * HOUR) / 1000;
      for (let i = 0; i < 1200; i++) hist.push({ sig: `gtfa_${i}`, ts: ts - i * 60, delta: 1000n });
      const rebuyTs = ts - 1300 * 60;
      hist.push({ sig: 'gtfa_rebuy', ts: rebuyTs, delta: 10_000_000n });
      hist.push({ sig: 'gtfa_sellall', ts: rebuyTs - 3600, delta: -50_000_000n });
      hist.push({ sig: 'gtfa_firstbuy', ts: rebuyTs - 7200, delta: 50_000_000n });
      setHolder(w, 10_000_000n + 1_200_000n, hist);
      now = T0 + 14.5 * HOUR;
      await pipeline.takeSnapshot(MINT);
      // a legacy-format cursor left by the old path must be ignored, not resumed
      await db.pool.query(`UPDATE holder_positions SET acquired_source = 'pending', acquired_at = NULL, backfill_cursor = 'oldSignatureBase58', backfill_balance = 1 WHERE mint_address = $1 AND wallet = $2`, [MINT, w]);

      const calls = [];
      const realAvail = solana.isTransactionHistoryAvailable;
      solana.isTransactionHistoryAvailable = () => true;
      solana.getAccountTransactionsPage = async (account, { limit, paginationToken }) => {
        calls.push({ account, limit, paginationToken });
        const h = chain[walletOfAta(account)].history;
        const start = paginationToken ? Number(paginationToken.split(':')[1]) : 0;
        const slice = h.slice(start, start + limit);
        const txs = slice.map(t => ({
          blockTime: t.ts,
          transaction: { message: { accountKeys: ['payer', account] } },
          meta: {
            err: null,
            preTokenBalances: [{ accountIndex: 1, mint: MINT, uiTokenAmount: { amount: '1' } }],
            postTokenBalances: [{ accountIndex: 1, mint: MINT, uiTokenAmount: { amount: (1n + t.delta).toString() } }],
          },
        }));
        return { txs, paginationToken: start + limit < h.length ? `1:${start + limit}` : null };
      };
      const prevPages = pipeline.CONFIG.backfillPagesPerWallet;
      const prevSize = pipeline.CONFIG.backfillPageSize;
      assert.strictEqual(pipeline.CONFIG.backfillFirstPageSize, 100, 'small first page: most accounts settle on it');
      assert.strictEqual(prevSize, 500, 'then larger pages: Helius bills per 100 returned, so size only sets round trips');
      pipeline.CONFIG.backfillPagesPerWallet = 1;
      try {
        let pos = await position(w);
        assert.strictEqual(await pipeline.backfillWallet(MINT, pos, 6), false);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].paginationToken, undefined, 'legacy cursor discarded');
        assert.strictEqual(calls[0].limit, 100);
        pos = await position(w);
        assert.strictEqual(pos.backfill_cursor, '1:100');
        assert.strictEqual(pos.backfill_pages, 1);
        pipeline.CONFIG.backfillPagesPerWallet = prevPages;
        assert.strictEqual(await pipeline.backfillWallet(MINT, pos, 6), true);
        assert.deepStrictEqual(calls.slice(1).map(c => [c.limit, c.paginationToken]), [[500, '1:100'], [500, '1:600'], [500, '1:1100']],
          'resumed from the saved token in larger pages');
        pos = await position(w);
        assert.strictEqual(pos.acquired_source, 'backfill');
        assert.strictEqual(new Date(pos.acquired_at).getTime(), rebuyTs * 1000);
        assert.strictEqual(pos.backfill_pages, 13, 'pages counted in units of 100 transactions');
      } finally {
        pipeline.CONFIG.backfillPagesPerWallet = prevPages;
        pipeline.CONFIG.backfillPageSize = prevSize;
        solana.isTransactionHistoryAvailable = realAvail;
        delete solana.getAccountTransactionsPage;
      }
    });

    test('a wallet whose account is already empty is marked left, and dated afresh if it comes back', async () => {
      const w = 'GONE';
      setHolder(w, 1_000_000_000, [{ sig: 'buy_GONE', ts: T0 / 1000, delta: 1_000_000_000n }]);
      now = T0 + 15 * HOUR;
      await pipeline.takeSnapshot(MINT);
      chain[w].amount = 0n;
      const pos = await position(w);
      assert.strictEqual(await pipeline.backfillWallet(MINT, pos, 6), true);
      assert.strictEqual((await position(w)).acquired_source, 'left');
      // not resolved, not pending: diamond hands does not wait on it
      const dh = await pipeline.getDiamondHands(MINT, { dispatch: false });
      assert.ok(dh.resolved <= dh.analyzed);

      // Holding again before the next snapshot: a new streak, dated like a newcomer
      now = T0 + 15.5 * HOUR;
      chain[w].amount = 2_000_000n;
      await pipeline.takeSnapshot(MINT);
      const back = await position(w);
      assert.strictEqual(back.acquired_source, 'snapshot');
      assert.strictEqual(new Date(back.acquired_at).getTime(), now);
      assert.strictEqual(back.backfill_attempts, 0);
    });

    test('hold times flag lower bounds, and wait for wallets a snapshot in flight will bring', async () => {
      await db.pool.query(`UPDATE holder_positions SET acquired_source = 'backfill_capped' WHERE mint_address = $1 AND wallet = 'W007'`, [MINT]);
      try {
        const r = await pipeline.getHoldTimes(MINT, ['W007', 'W008']);
        assert.strictEqual(r.computed, true);
        assert.ok(r.holdTimes.W007 > 0 && r.holdTimes.W008 > 0);
        assert.deepStrictEqual(r.floors, ['W007']);
      } finally {
        await db.pool.query(`UPDATE holder_positions SET acquired_source = 'backfill' WHERE mint_address = $1 AND wallet = 'W007'`, [MINT]);
      }
      // A wallet with no position row: settled (not a holder we know) unless a
      // snapshot is being taken, which may be about to add it
      assert.strictEqual((await pipeline.getHoldTimes(MINT, ['UNKNOWN'])).computed, true);
      await cache.set(`holder-snapshot-pending:${MINT}`, Date.now(), 60_000);
      try {
        assert.strictEqual((await pipeline.getHoldTimes(MINT, ['UNKNOWN'])).computed, false);
      } finally {
        await cache.delete(`holder-snapshot-pending:${MINT}`);
        await cache.delete(`holder-backfill-pending:${MINT}`);
      }
    });

    test('failed wallets get another try a day later', async () => {
      await db.pool.query(`UPDATE holder_positions SET acquired_source = 'failed', backfill_attempts = 3,
        backfill_updated_at = $2 WHERE mint_address = $1 AND wallet = 'W009'`, [MINT, new Date(now - 25 * HOUR)]);
      await db.pool.query(`UPDATE holder_positions SET acquired_source = 'failed', backfill_attempts = 3,
        backfill_updated_at = $2 WHERE mint_address = $1 AND wallet = 'W011'`, [MINT, new Date(now - HOUR)]);
      now += 10 * 60 * 1000;
      chain.W009.amount += 1n; // so the pre-check sees a change
      await pipeline.takeSnapshot(MINT);
      assert.strictEqual((await position('W009')).acquired_source, 'pending', 'old failure retried');
      assert.strictEqual((await position('W011')).acquired_source, 'failed', 'recent failure left alone');
      await drainBackfill();
      assert.strictEqual((await position('W009')).acquired_source, 'backfill');
      await db.pool.query(`UPDATE holder_positions SET acquired_source = 'backfill', acquired_at = $2 WHERE mint_address = $1 AND wallet = 'W011'`,
        [MINT, new Date(T0 - 11 * DAY)]);
    });

    test('rate limiting keeps a wallet pending past the normal attempt limit, then it settles', async () => {
      const snap = await store.getLatestSnapshot(MINT);
      const lp = new Set(snap.sample_meta.lpWallets || []);
      const w = snap.sample.map(x => x.wallet).find(x => !lp.has(x) && chain[x] && chain[x].amount > 0n && chain[x].history.length > 0);
      assert.ok(w, 'a sampled wallet with history');
      await db.pool.query(`UPDATE holder_positions SET acquired_source = 'pending', acquired_at = NULL, backfill_cursor = NULL,
        backfill_balance = NULL, backfill_attempts = 0 WHERE mint_address = $1 AND wallet = $2`, [MINT, w]);
      const realSigs = solana.getSignaturesPage;
      const prevPause = pipeline.CONFIG.pushbackPauseMs;
      pipeline.CONFIG.pushbackPauseMs = 5;
      let calls = 0;
      solana.getSignaturesPage = async (a, opts) => {
        if (walletOfAta(a) === w) { calls++; const e = new Error('Request failed with status code 429'); e.response = { status: 429 }; throw e; }
        return realSigs(a, opts);
      };
      try {
        for (let i = 1; i <= pipeline.CONFIG.backfillMaxAttempts + 1; i++) {
          calls = 0;
          const r = await pipeline.runBackfill(MINT);
          assert.ok(r.remaining >= 1);
          // the run pauses and retries pushbackMaxPauses times before giving the run up
          assert.strictEqual(calls, pipeline.CONFIG.pushbackMaxPauses + 1, 'paused and retried within the run');
          const pos = await position(w);
          assert.strictEqual(pos.acquired_source, 'pending', `still pending after ${i} rate-limited runs`);
          assert.strictEqual(pos.backfill_attempts, i, 'one attempt per run, not per retry');
        }
      } finally {
        solana.getSignaturesPage = realSigs;
        pipeline.CONFIG.pushbackPauseMs = prevPause;
      }
      await drainBackfill();
      const pos = await position(w);
      assert.ok(['backfill', 'backfill_capped'].includes(pos.acquired_source), pos.acquired_source);
    });

    test('only a few tokens backfill at once; the rest wait and re-queue', async () => {
      const held = [];
      for (let i = 0; i < pipeline.CONFIG.backfillMaxTokens; i++) {
        const key = `holder-backfill-slot:${i}`;
        assert.ok(await cache.setNX(key, `OtherMint${i}`, 60_000));
        held.push(key);
      }
      const before = queued.length;
      try {
        const r = await pipeline.runBackfill(MINT);
        assert.strictEqual(r.status, 'waiting');
        const job = queued[queued.length - 1];
        assert.ok(queued.length > before && job.name === 'backfill-holder-acquisitions');
        // slots other tokens hold are left alone
        assert.strictEqual(await cache.get(held[0]), 'OtherMint0');
      } finally {
        for (const key of held) await cache.delete(key);
        await cache.delete(`holder-backfill-pending:${MINT}`);
      }
      // with a slot free the run proceeds and releases it afterwards
      const r = await pipeline.runBackfill(MINT);
      assert.notStrictEqual(r.status, 'waiting');
      assert.strictEqual(await cache.get('holder-backfill-slot:0'), undefined);
    });

    test('backfill order interleaves the strata so partial results cover all of them', () => {
      const snap = { sample: [
        { wallet: 't1', stratum: 'top' }, { wallet: 't2', stratum: 'top' },
        { wallet: 'm1', stratum: 'mid' }, { wallet: 'm2', stratum: 'mid' }, { wallet: 'm3', stratum: 'mid' },
        { wallet: 'l1', stratum: 'tail' },
      ], sample_meta: { lpWallets: ['m2'] } };
      const order = pipeline.walletsOfInterest(snap, [{ wallet: 'POOL' }, { wallet: 't1' }, { wallet: 'x1' }]);
      assert.deepStrictEqual(order, ['t1', 'm1', 'l1', 't2', 'm3', 'POOL', 'x1']);
    });

    test('a partial distribution waits until every stratum has some resolved wallets', () => {
      const strata = { top: { population: 50, sampled: 50 }, mid: { population: 900, sampled: 100 }, tail: { population: 9000, sampled: 100 } };
      assert.strictEqual(pipeline.partialReady(strata, { top: 50 }), false);
      assert.strictEqual(pipeline.partialReady(strata, { top: 10, mid: 10, tail: 9 }), false);
      assert.strictEqual(pipeline.partialReady(strata, { top: 10, mid: 10, tail: 10 }), true);
      // a stratum with fewer sampled wallets than the minimum only needs all of them
      assert.strictEqual(pipeline.partialReady({ top: { population: 3, sampled: 3 } }, { top: 3 }), true);
      assert.strictEqual(pipeline.partialReady({ top: { population: 3, sampled: 3 }, tail: { population: 0, sampled: 0 } }, { top: 2 }), false);
    });

    test('each mint comes due on its own refresh schedule', () => {
      const R = pipeline.CONFIG.refreshMs;
      const mints = Array.from({ length: 40 }, (_, i) => `Mint${i}`);
      const t = 1_800_000_000_000;
      // all snapshotted at t: at the next hourly tick only some are due, all are due within a cycle
      const dueAt = tick => mints.filter(m => pipeline.isRefreshDue(m, t, t + tick * HOUR)).length;
      assert.ok(dueAt(1) > 0 && dueAt(1) < mints.length, `${dueAt(1)} due after one hour`);
      assert.strictEqual(dueAt(R / HOUR), mints.length);
      assert.strictEqual(pipeline.isRefreshDue('Mint1', undefined, t), true);
      // once refreshed, not due again until its next boundary
      for (const m of mints) {
        if (!pipeline.isRefreshDue(m, t, t + HOUR)) continue;
        assert.strictEqual(pipeline.isRefreshDue(m, t + HOUR, t + 2 * HOUR), false);
        assert.strictEqual(pipeline.isRefreshDue(m, t + HOUR, t + HOUR + R), true);
      }
    });

    test('a program-owned account is not a person', () => {
      assert.strictEqual(pipeline.isProgramOwned({ owner: '11111111111111111111111111111111' }), false);
      assert.strictEqual(pipeline.isProgramOwned({ owner: 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m' }), true);
      assert.strictEqual(pipeline.isProgramOwned(null), false);
    });

    test('top holder list comes from the snapshot', async () => {
      const list = await pipeline.getSnapshotHolderList(MINT, { limit: 100 });
      assert.strictEqual(list.rawAccounts.length, 100);
      assert.strictEqual(list.rawAccounts[0].wallet, 'POOL');
      assert.strictEqual(list.rawAccounts[0].uiAmount, 400_000);
      assert.strictEqual(list.totalSupply, 1_000_000);
    });

    test('only the newest snapshots keep their ranked entries', async () => {
      const { rows } = await db.pool.query(
        `SELECT COUNT(DISTINCT e.snapshot_id)::int AS n FROM holder_snapshot_entries e
           JOIN holder_snapshots s ON s.id = e.snapshot_id WHERE s.mint_address = $1`, [MINT]);
      assert.strictEqual(rows[0].n, 3);
    });

    test('conviction is persisted with its sample method', async () => {
      await db.pool.query(
        `INSERT INTO tokens (mint_address, name, symbol) VALUES ($1, 'T', 'T') ON CONFLICT (mint_address) DO NOTHING`, [MINT]);
      await drainBackfill();
      await cache.delete(`diamond-hands:${MINT}`);
      const dh = await pipeline.getDiamondHands(MINT, { dispatch: false });
      assert.strictEqual(dh.computed, true);
      const { rows } = await db.pool.query('SELECT conviction_meta, conviction_sample_size FROM tokens WHERE mint_address = $1', [MINT]);
      assert.strictEqual(rows[0].conviction_meta.method, 'stratified-v1');
      assert.ok(rows[0].conviction_meta.supplyDistribution);

      // The hourly sweep runs a backfill pass even with nothing left to backfill:
      // it re-stores diamond hands without anyone opening the token page.
      await db.pool.query('UPDATE tokens SET conviction_computed_at = NULL WHERE mint_address = $1', [MINT]);
      const r = await pipeline.runBackfill(MINT);
      assert.strictEqual(r.remaining, 0);
      const stored = await db.pool.query('SELECT conviction_computed_at FROM tokens WHERE mint_address = $1', [MINT]);
      assert.ok(stored.rows[0].conviction_computed_at, 'conviction re-stored by the background pass');
      await db.pool.query('DELETE FROM tokens WHERE mint_address = $1', [MINT]);
    });

    test('a snapshot that lands during a backfill run sends the backfill round again', async () => {
      // A whale arrives after a long gap, so the next snapshot leaves it pending
      now = T0 + 22 * HOUR;
      setHolder('WHALE2', 900_000_000_000, [{ sig: 'buy_WHALE2', ts: (T0 + 20 * HOUR) / 1000, delta: 900_000_000_000n }]);
      await pipeline.takeSnapshot(MINT);
      assert.strictEqual((await position('WHALE2')).acquired_source, 'pending');

      // While this run backfills WHALE2, another whale arrives and a new snapshot lands
      const realBalance = solana.getTokenAccountBalance;
      let snapped = false;
      solana.getTokenAccountBalance = async a => {
        if (!snapped) {
          snapped = true;
          now = T0 + 30 * HOUR;
          setHolder('WHALE3', 950_000_000_000, [{ sig: 'buy_WHALE3', ts: (T0 + 29 * HOUR) / 1000, delta: 950_000_000_000n }]);
          await pipeline.takeSnapshot(MINT);
        }
        return realBalance(a);
      };
      try {
        const r = await pipeline.runBackfill(MINT);
        assert.ok(snapped);
        assert.strictEqual((await position('WHALE3')).acquired_source, 'pending');
        assert.ok(r.remaining > 0, 'the new snapshot\'s pending wallets keep the backfill going');
      } finally {
        solana.getTokenAccountBalance = realBalance;
      }
      await drainBackfill();
      assert.strictEqual((await position('WHALE3')).acquired_source, 'backfill');
    });

    test('newcomers after a verified-unchanged check are dated from the check, not the old snapshot', async () => {
      // latest snapshot at T0+30h; nothing changes, so the 34h check keeps it and marks it verified
      now = T0 + 34 * HOUR;
      const kept = await pipeline.takeSnapshot(MINT);
      assert.strictEqual(kept.status, 'unchanged');
      // 7h after the snapshot (too long for the 6h window) but 3h after the check
      now = T0 + 37 * HOUR;
      setHolder('VERIFIEDNEW', 4_000_000_000);
      await pipeline.takeSnapshot(MINT);
      const p = await position('VERIFIEDNEW');
      assert.strictEqual(p.acquired_source, 'snapshot');
      assert.strictEqual(new Date(p.acquired_at).getTime(), now);
    });
  });

  describe('holder count history (Postgres)', () => {
    const holderCounts = require('./holderCounts');

    test('every snapshot left a point with wallets, dust and the token-account count', async () => {
      const points = await holderCounts.getPoints(MINT);
      const snapshots = await db.pool.query(
        'SELECT taken_at, complete FROM holder_snapshots WHERE mint_address = $1 ORDER BY taken_at', [MINT]);
      const snapTimes = new Set(snapshots.rows.map(r => new Date(r.taken_at).getTime()));
      const fromSnapshots = points.filter(p => p.source === 'snapshot');
      assert.ok(fromSnapshots.length >= snapTimes.size);
      for (const t of snapTimes) assert.ok(fromSnapshots.some(p => new Date(p.taken_at).getTime() === t));

      const first = points[0];
      assert.strictEqual(new Date(first.taken_at).getTime(), T0);
      assert.strictEqual(first.holders, 300);            // POOL excluded
      assert.strictEqual(first.legacy_count, 301);       // token accounts
      assert.strictEqual(first.dust, 0);                 // nobody under a millionth of supply

      const capped = points.filter(p => p.complete === false);
      assert.ok(capped.length >= 1, 'capped snapshot stored as a lower bound');
    });

    test('series payload and displayed count agree with the latest exact point', async () => {
      const points = await holderCounts.getPoints(MINT);
      const r = holderCounts.buildHolderSeries(points, { range: 'all', now });
      const latest = points[points.length - 1];
      assert.strictEqual(r.current.holders, latest.holders);
      await cache.delete(`holder-total:${MINT}`);
      const counts = await holderCounts.getDisplayCounts([MINT]);
      const lastExact = [...points].reverse().find(p => p.holders != null && p.complete);
      assert.strictEqual(counts[MINT], lastExact.holders);
      assert.strictEqual(await cache.get(`holder-total:${MINT}`), lastExact.holders);
    });

    test('imported history only fills time before our first point and never overwrites', async () => {
      const inserted = await holderCounts.importLegacyPoints(MINT, [
        { takenAt: T0 - 2 * DAY, count: 280 },
        { takenAt: T0 - DAY, count: 290 },
        { takenAt: T0, count: 999 },           // same time as our first point
        { takenAt: T0 + 5 * HOUR, count: 999 }, // after it
      ], 'coingecko');
      assert.strictEqual(inserted, 2);
      const points = await holderCounts.getPoints(MINT);
      assert.strictEqual(points.find(p => new Date(p.taken_at).getTime() === T0).holders, 300);

      const r = holderCounts.buildHolderSeries(points, { range: 'all', now });
      assert.strictEqual(r.series.holders.est.length, 2);
      assert.strictEqual(r.series.holders.est[0][1], Math.round(280 * 300 / 301));
    });

    test('old daily endpoint shape: one row per day, newest first, real counts preferred', async () => {
      const rows = await holderCounts.getDailyHistory(MINT, 30);
      assert.ok(rows.length >= 3);
      assert.match(rows[0].recorded_date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(rows[0].recorded_date > rows[1].recorded_date);
      const t0Day = new Date(T0).toISOString().slice(0, 10);
      const day = rows.find(r => r.recorded_date === t0Day);
      assert.ok(day.holder_count >= 300 && day.holder_count < 999);
    });
  });
}
