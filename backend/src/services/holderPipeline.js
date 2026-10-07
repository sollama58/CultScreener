/**
 * Holder pipeline: full holder snapshots, the conviction sample, and hold times.
 *
 *   snapshot-holders (worker job)
 *     pages every token account → one row per wallet → snapshot + positions in
 *     Postgres → draws the stratified sample → queues the backfill
 *   backfill-holder-acquisitions (worker job, resumable, re-queues itself)
 *     for sampled and top-listed wallets whose streak start is unknown, rewinds
 *     their token account's history to the moment the balance left zero
 *   getDiamondHands / getHoldTimes (API routes)
 *     read the latest snapshot and positions from Postgres; never call RPC
 *
 * The math is in holderSnapshot.js and holderMetrics.js; SQL in holderStore.js.
 */

const solanaService = require('./solana');
const store = require('./holderStore');
const { cache, TTL } = require('./cache');
const { BURN_WALLETS, LP_PROGRAMS, LP_AUTHORITIES } = require('../constants');
const {
  aggregateHolders, newWalletAcquisition, selectSample, tokenAccountDelta, metaTokenAccountDelta,
  holderFingerprint, rewindToStreakStart, toBigInt,
} = require('./holderSnapshot');
const { buildStratifiedDiamondHands } = require('./holderMetrics');
const holderCounts = require('./holderCounts');

const envInt = (name, fallback) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const CONFIG = {
  maxPages: envInt('HOLDER_SNAPSHOT_MAX_PAGES', 250),       // 250 pages = 250k token accounts (10 credits each)
  topN: envInt('HOLDER_SNAPSHOT_TOP_N', 1000),               // ranked entries kept per snapshot
  listN: 100,                                                // holders served by /holders
  lpCheckN: 200,                                             // largest wallets checked for LP ownership
  // Curated tokens are re-snapshotted this often (the hourly job checks staleness).
  // Under 6h, new holders are still dated from consecutive snapshots.
  refreshMs: envInt('HOLDER_SNAPSHOT_REFRESH_HOURS', 4) * 3_600_000,
  backfillWalletsPerRun: envInt('HOLDER_BACKFILL_WALLETS_PER_RUN', 48),
  backfillConcurrency: envInt('HOLDER_BACKFILL_CONCURRENCY', 8), // wallets read at once per mint
  backfillPagesPerWallet: 5,                                 // per run; progress is saved between runs
  // Transactions read per wallet before accepting a lower bound.
  backfillMaxTxs: envInt('HOLDER_BACKFILL_MAX_TXS', 2000),
  // getTransactionsForAddress bills 10 credits per 100 transactions returned, so
  // page size sets round trips, not cost. Most holders' token accounts settle on a
  // small first page; the busy ones continue in large pages (2000 txs = 3 calls).
  backfillFirstPageSize: envInt('HOLDER_BACKFILL_FIRST_PAGE_SIZE', 100),
  backfillPageSize: envInt('HOLDER_BACKFILL_PAGE_SIZE', 1000),
  backfillMaxAttempts: 3,
  resultTtl: 15 * 60 * 1000,                                 // hold times grow; recompute often (cheap, DB only)
  snapshotLockTtl: 10 * 60 * 1000,
  snapshotFailCooldown: 5 * 60 * 1000,
  backfillLockTtl: 10 * 60 * 1000,
  staleSnapshotMs: 24 * 3_600_000,                           // routes ask for a fresh one past this
};

const keys = {
  result: mint => `diamond-hands:${mint}`,
  snapshotPending: mint => `holder-snapshot-pending:${mint}`,
  backfillPending: mint => `holder-backfill-pending:${mint}`,
  // when a cheap pre-check last found the previous snapshot still accurate
  snapshotVerified: mint => `holder-snapshot-verified:${mint}`,
};

/**
 * When each mint's holder data was last known to be current: the latest
 * snapshot, or a later pre-check that found nothing changed. The schedulers
 * compare this against CONFIG.refreshMs.
 */
async function getFreshnessTimes(mints) {
  const times = await store.getLatestSnapshotTimes(mints);
  for (const mint of mints) {
    const verified = Number(await cache.get(keys.snapshotVerified(mint)).catch(() => 0)) || 0;
    if (verified > (times[mint] || 0)) times[mint] = verified;
  }
  return times;
}

// ── Job dispatch (deduped with short-lived locks) ────────────────────────────

async function ensureSnapshot(mint, { priority } = {}) {
  const acquired = await cache.setNX(keys.snapshotPending(mint), Date.now(), CONFIG.snapshotLockTtl).catch(() => false);
  if (!acquired) return false;
  const jobQueue = require('./jobQueue');
  const job = await jobQueue.addAnalyticsJob('snapshot-holders', { mint }, priority ? { priority } : {});
  if (!job) await cache.delete(keys.snapshotPending(mint)).catch(() => {});
  return !!job;
}

async function ensureBackfill(mint, { delay } = {}) {
  const acquired = await cache.setNX(keys.backfillPending(mint), Date.now(), CONFIG.backfillLockTtl).catch(() => false);
  if (!acquired) return false;
  const jobQueue = require('./jobQueue');
  const job = await jobQueue.addAnalyticsJob('backfill-holder-acquisitions', { mint }, delay ? { delay } : {});
  if (!job) await cache.delete(keys.backfillPending(mint)).catch(() => {});
  return !!job;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

// Wallets among the largest holders that are LP vault owners.
async function detectLpWallets(holders) {
  const lp = new Set();
  const candidates = holders.slice(0, CONFIG.lpCheckN).map(h => h.wallet).filter(w => !BURN_WALLETS.has(w));
  for (const w of candidates) if (LP_AUTHORITIES.has(w) || LP_PROGRAMS.has(w)) lp.add(w);
  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100);
    const res = await solanaService.getMultipleAccounts(batch).catch(() => null);
    (res?.value || []).forEach((acct, j) => {
      if (acct && LP_PROGRAMS.has(acct.owner)) lp.add(batch[j]);
    });
  }
  return lp;
}

// DAS returns accounts in no particular order, so a capped read can miss the very
// largest holders. Add the 20 largest accounts from standard RPC (2 calls).
async function mergeLargestAccounts(mint, accounts) {
  const largest = await solanaService.getTokenLargestAccounts(mint).catch(() => null);
  if (!largest || largest.length === 0) return;
  const have = new Set(accounts.map(a => a.address));
  const missing = largest.filter(a => a.address && !have.has(a.address));
  if (missing.length === 0) return;
  const infos = await solanaService.getMultipleAccounts(missing.map(a => a.address)).catch(() => null);
  (infos?.value || []).forEach((acct, i) => {
    const owner = acct?.data?.parsed?.info?.owner;
    if (owner) accounts.push({ owner, address: missing[i].address, amount: missing[i].amount });
  });
}

// ── Holder count history ─────────────────────────────────────────────────────

/**
 * Record the snapshot's holder count (services/holderCounts.js). A complete
 * snapshot's count is exact and becomes the displayed count; a capped one is
 * stored as a lower bound. Never fails the snapshot.
 */
async function recordSnapshotPoint(mint, { takenAt, complete, holders, exclude, decimals, supply, accountCount }) {
  try {
    const token = await require('./database').getToken(mint).catch(() => null);
    const dustRaw = holderCounts.dustThresholdRaw({ priceUsd: token?.price, decimals, supplyRaw: supply });
    const counts = holderCounts.countHolders(holders, { exclude, dustRaw });
    await holderCounts.recordPoint(mint, {
      takenAt, holders: counts.holders, dust: counts.dust, legacyCount: accountCount, complete, source: 'snapshot',
    });
    if (complete && counts.holders > 0) {
      await cache.set(`holder-total:${mint}`, counts.holders, TTL.HOLDER_COUNT).catch(() => {});
    }
  } catch (err) {
    console.warn(`[Holders] Count point failed for ${mint.slice(0, 8)}:`, err.message);
  }
}

/**
 * The pre-check found the previous snapshot still accurate. When that check read
 * every account (one page), the count is confirmed for now too, so the history
 * gets a point; otherwise only the first page is known and nothing is recorded.
 */
async function recordUnchangedPoint(mint, prev, now, checkedAll) {
  try {
    const latest = (await holderCounts.getLatestPoints([mint]))[mint];
    if (!latest || !latest.complete) return;
    if (latest.holders > 0) {
      await cache.set(`holder-total:${mint}`, latest.holders, TTL.HOLDER_COUNT).catch(() => {});
    }
    if (!checkedAll || !prev.complete) return;
    await holderCounts.recordPoint(mint, {
      takenAt: now, holders: latest.holders, dust: latest.dust, legacyCount: prev.account_count,
      complete: true, source: 'verified',
    });
  } catch (err) {
    console.warn(`[Holders] Count point failed for ${mint.slice(0, 8)}:`, err.message);
  }
}

/**
 * Take a full holder snapshot for a mint and store it. Worker only.
 */
async function takeSnapshot(mint) {
  const startedAt = Date.now();
  try {
    const prev = await store.getLatestSnapshot(mint);
    // Supply and decimals are required. Balances are stored raw and every UI amount
    // and percentage is derived from these two; a snapshot written with decimals
    // defaulted to 0 and no supply showed raw balances as tokens and holder shares
    // in the millions of percent.
    const supplyRes = await solanaService.getTokenSupply(mint);
    const decimals = supplyRes?.value?.decimals;
    const supply = supplyRes?.value?.amount ?? null;
    if (!Number.isInteger(decimals) || supply == null) {
      throw new Error(`getTokenSupply returned no supply/decimals for ${mint.slice(0, 8)}`);
    }

    // Cheap pre-check (one DAS page): if supply and the first page of accounts are
    // exactly as the previous snapshot saw them, nothing among those accounts moved,
    // so keep that snapshot instead of re-paging the whole holder list. With more
    // than one page that only proves the first page is unchanged, so a multi-page
    // token still gets a full snapshot at least once a day.
    const prevFingerprint = prev?.sample_meta?.fingerprint;
    const first = await solanaService.getAllTokenAccounts(mint, { maxPages: 1 });
    const fingerprint = holderFingerprint(supply, first.accounts);
    const prevUsable = prev && prev.supply != null && prev.decimals === decimals
      && (first.complete || Date.now() - new Date(prev.taken_at).getTime() < CONFIG.staleSnapshotMs);
    if (prevUsable && prevFingerprint && fingerprint === prevFingerprint) {
      const now = Date.now();
      await cache.set(keys.snapshotVerified(mint), now, CONFIG.refreshMs * 2).catch(() => {});
      await recordUnchangedPoint(mint, prev, now, first.complete);
      await cache.delete(keys.snapshotPending(mint)).catch(() => {});
      console.log(`[Holders] Snapshot ${prev.id} for ${mint.slice(0, 8)} unchanged (${first.accounts.length} accounts checked); kept`);
      await ensureBackfill(mint);
      return { status: 'unchanged', snapshotId: prev.id };
    }

    let { accounts, pages, complete } = first;
    if (!complete) {
      ({ accounts, pages, complete } = await solanaService.getAllTokenAccounts(mint, {
        maxPages: CONFIG.maxPages, startPage: 2, accounts,
      }));
    }
    if (!complete) await mergeLargestAccounts(mint, accounts);
    const takenAt = Date.now();
    const holders = aggregateHolders(accounts);
    if (holders.length === 0) {
      await cache.delete(keys.snapshotPending(mint)).catch(() => {});
      return { status: 'empty' };
    }

    const lpWallets = await detectLpWallets(holders);
    const exclude = new Set([...BURN_WALLETS, ...LP_PROGRAMS, ...LP_AUTHORITIES, ...lpWallets]);
    const { sample, meta } = selectSample(mint, holders, { exclude });
    meta.lpWallets = [...lpWallets];
    meta.complete = complete;
    meta.fingerprint = fingerprint;

    const newAcquisition = newWalletAcquisition(
      prev ? { takenAt: new Date(prev.taken_at).getTime(), complete: prev.complete } : null,
      takenAt
    );

    const snapshotId = await store.writeSnapshot({
      mint, takenAt, complete, pages, accountCount: accounts.length, holders, decimals, supply,
      sample, sampleMeta: meta, topN: CONFIG.topN, newAcquisition,
    });
    await store.pruneSnapshots(mint).catch(err => console.warn(`[Holders] Prune failed for ${mint.slice(0, 8)}:`, err.message));

    await recordSnapshotPoint(mint, { takenAt, complete, holders, exclude, decimals, supply, accountCount: accounts.length });
    await cache.delete(keys.result(mint)).catch(() => {});
    await cache.delete(keys.snapshotVerified(mint)).catch(() => {});

    console.log(`[Holders] Snapshot ${snapshotId} for ${mint.slice(0, 8)}: ${holders.length} wallets from ${accounts.length} accounts, ` +
      `${pages} page(s)${complete ? '' : ' (capped)'}, sample ${sample.length} (${meta.method}), new wallets: ${newAcquisition.source}, ${Date.now() - startedAt}ms`);

    await ensureBackfill(mint);
    await cache.delete(keys.snapshotPending(mint)).catch(() => {});
    return { status: 'ok', snapshotId, holders: holders.length, complete, sample: sample.length };
  } catch (err) {
    // Keep the lock as a cooldown so API polls don't re-queue a snapshot against
    // a failing Helius on every request. BullMQ's own retries still run.
    await cache.set(keys.snapshotPending(mint), Date.now(), CONFIG.snapshotFailCooldown).catch(() => {});
    throw err;
  }
}

// ── Backfill ─────────────────────────────────────────────────────────────────

// Wallets whose hold time we need: the conviction sample, then the listed top holders.
function walletsOfInterest(snap, entries) {
  const excluded = new Set(snap.sample_meta?.lpWallets || []);
  const ordered = [];
  const seen = new Set();
  const add = w => { if (w && !seen.has(w) && !excluded.has(w) && !BURN_WALLETS.has(w)) { seen.add(w); ordered.push(w); } };
  for (const s of snap.sample || []) add(s.wallet);
  for (const e of entries || []) add(e.wallet);
  return ordered;
}

// One page of a token account's history as {timestamp, delta} newest first, via
// getTransactionsForAddress. nextCursor is the pagination token for the next page.
async function readHistoryPage(tokenAccount, mint, cursor, pageSize) {
  const { txs, paginationToken } = await solanaService.getAccountTransactionsPage(tokenAccount, {
    limit: pageSize, paginationToken: cursor || undefined,
  });
  const list = Array.isArray(txs) ? txs : [];
  return {
    txs: list.map(tx => ({ timestamp: tx?.blockTime || 0, delta: metaTokenAccountDelta(tx, tokenAccount, mint) })),
    count: list.length,
    exhausted: list.length < pageSize || !paginationToken,
    nextCursor: paginationToken || null,
  };
}

// The same page via getSignaturesForAddress + the Enhanced Transactions API
// (legacy, 100 credits per parse call). nextCursor is the oldest signature read.
async function readLegacyPage(tokenAccount, mint, decimals, cursor) {
  const sigs = await solanaService.getSignaturesPage(tokenAccount, { limit: 100, before: cursor || undefined });
  const list = Array.isArray(sigs) ? sigs : [];
  const ok = list.filter(s => !s.err);
  const parsed = ok.length > 0 ? await solanaService.parseTransactions(ok.map(s => s.signature)) : [];
  const bySig = new Map(parsed.map(t => [t.signature, t]));
  return {
    txs: ok.map(s => {
      const tx = bySig.get(s.signature);
      return { timestamp: tx?.timestamp || s.blockTime, delta: tx ? tokenAccountDelta(tx, tokenAccount, mint, decimals) : 0n };
    }),
    count: list.length,
    exhausted: list.length < 100,
    nextCursor: list.length > 0 ? list[list.length - 1].signature : null,
  };
}

/**
 * Find one wallet's streak start from its token account's history. Resumes from
 * the saved cursor. Returns true when the wallet is settled (resolved or given up).
 */
async function backfillWallet(mint, pos, decimals) {
  const tokenAccount = pos.token_account;
  if (!tokenAccount) {
    await store.saveBackfill(mint, pos.wallet, { source: 'failed', attempted: true });
    return true;
  }

  // The history source: getTransactionsForAddress (10 credits per 100 full
  // transactions returned) when Helius serves it, else signatures + the Enhanced
  // API (101 credits per 100). A saved cursor only resumes the path that wrote it:
  // getTransactionsForAddress tokens are "slot:position", signatures are base58.
  const useHistory = solanaService.isTransactionHistoryAvailable();
  const savedCursor = pos.backfill_cursor || null;
  const cursorMatches = savedCursor ? (savedCursor.includes(':') === useHistory) : true;
  let cursor = cursorMatches ? savedCursor : null;
  const readPage = c => (useHistory
    ? readHistoryPage(tokenAccount, mint, c, c ? CONFIG.backfillPageSize : CONFIG.backfillFirstPageSize)
    : readLegacyPage(tokenAccount, mint, decimals, c));

  let balance;
  let firstPage = null;
  if (cursor && pos.backfill_balance != null) {
    balance = toBigInt(pos.backfill_balance);
  } else {
    // Starting over: read the current balance and the newest history page together
    // (one round trip instead of two; the page is only wasted if the wallet left).
    cursor = null;
    const pagePromise = readPage(null);
    pagePromise.catch(() => {});
    const bal = await solanaService.getTokenAccountBalance(tokenAccount).catch(() => null);
    balance = toBigInt(bal?.value?.amount);
    if (balance <= 0n) {
      // Account emptied or closed since the snapshot: the wallet left. The next
      // complete snapshot drops the row; if it comes back it starts a new streak.
      await store.saveBackfill(mint, pos.wallet, { source: 'failed', attempted: true });
      return true;
    }
    firstPage = await pagePromise;
  }

  let pagesUsed = 0;
  let txsRead = 0;
  // Oldest transaction read so far, across runs: the fallback answer when the
  // history runs out exactly on a page boundary.
  let oldestAt = cursor && pos.backfill_oldest_at ? new Date(pos.backfill_oldest_at).getTime() : null;
  // backfill_pages counts units of 100 transactions, whatever the page size
  const txsBefore = cursor ? (pos.backfill_pages || 0) * 100 : 0;
  const units = () => Math.max(pagesUsed, Math.ceil(txsRead / 100));

  while (pagesUsed < CONFIG.backfillPagesPerWallet) {
    const page = firstPage || await readPage(cursor);
    firstPage = null;
    pagesUsed++;
    txsRead += page.count;

    const r = rewindToStreakStart(balance, page.txs, { exhausted: page.exhausted });
    if (r.oldestAt) oldestAt = r.oldestAt;
    if (r.done) {
      if (r.acquiredAt == null && oldestAt != null) r.acquiredAt = oldestAt;
      if (r.acquiredAt == null) {
        await store.saveBackfill(mint, pos.wallet, { source: 'failed', pagesAdded: units(), attempted: true });
      } else {
        await store.saveBackfill(mint, pos.wallet, { acquiredAt: r.acquiredAt, source: 'backfill', pagesAdded: units() });
      }
      return true;
    }
    balance = r.balance;
    cursor = page.nextCursor;

    if (txsBefore + txsRead >= CONFIG.backfillMaxTxs) {
      // Very active account. The streak began before the oldest transaction we read,
      // so this is a lower bound on the hold time; good enough for the buckets.
      await store.saveBackfill(mint, pos.wallet, {
        acquiredAt: oldestAt, source: oldestAt ? 'backfill_capped' : 'failed', pagesAdded: units(),
      });
      return true;
    }
  }

  await store.saveBackfill(mint, pos.wallet, { cursor, balance, oldestAt, pagesAdded: units() });
  return false;
}

/**
 * One bounded backfill pass for a mint. Worker only. Re-queues itself while work
 * remains; when everything is settled, recomputes and stores diamond hands.
 */
async function runBackfill(mint) {
  let remaining = 0;
  try {
    const snap = await store.getLatestSnapshot(mint);
    if (!snap) return { status: 'no-snapshot' };
    const entries = await store.getSnapshotEntries(snap.id, CONFIG.listN);
    const wallets = walletsOfInterest(snap, entries);
    const positions = await store.getPositions(mint, wallets);
    const pending = wallets.map(w => positions.get(w)).filter(p => p && p.acquired_source === 'pending');

    const batch = pending.slice(0, CONFIG.backfillWalletsPerRun);
    // A small pool: each slot takes the next wallet as soon as its last one is done,
    // so one slow account doesn't hold the others back.
    let settled = 0;
    let next = 0;
    const runOne = async pos => {
      try {
        return await backfillWallet(mint, pos, snap.decimals || 0);
      } catch (err) {
        const giveUp = (pos.backfill_attempts || 0) + 1 >= CONFIG.backfillMaxAttempts;
        console.warn(`[Holders] Backfill ${pos.wallet.slice(0, 8)} on ${mint.slice(0, 8)} failed${giveUp ? ' (giving up)' : ''}:`, err.message);
        await store.saveBackfill(mint, pos.wallet, {
          source: giveUp ? 'failed' : null,
          cursor: pos.backfill_cursor,
          balance: pos.backfill_balance != null ? toBigInt(pos.backfill_balance) : null,
          oldestAt: pos.backfill_oldest_at ? new Date(pos.backfill_oldest_at).getTime() : null,
          attempted: true,
        }).catch(() => {});
        return giveUp;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONFIG.backfillConcurrency, batch.length) }, async () => {
      while (next < batch.length) {
        if (await runOne(batch[next++])) settled++;
      }
    }));

    remaining = pending.length - settled;
    console.log(`[Holders] Backfill ${mint.slice(0, 8)}: ${settled}/${batch.length} settled this run, ${remaining} pending`);
    if (remaining === 0) {
      await cache.delete(keys.result(mint)).catch(() => {});
      const dh = await getDiamondHands(mint, { dispatch: false });
      // A snapshot taken while this run was going brings its own pending wallets,
      // and its backfill request was refused because this run held the lock.
      // Go round again on the new snapshot.
      if (!dh.computed) {
        const latest = await store.getLatestSnapshot(mint).catch(() => null);
        if (latest && latest.id !== snap.id) remaining = dh.sampleSize - dh.analyzed;
      }
    }
    return { status: 'ok', settled, remaining };
  } finally {
    await cache.delete(keys.backfillPending(mint)).catch(() => {});
    if (remaining > 0) await ensureBackfill(mint, { delay: 2000 }).catch(() => {});
  }
}

// ── Reads (API routes) ───────────────────────────────────────────────────────

function holdTimeOf(pos, now) {
  if (!pos || !pos.acquired_at) return null;
  const ms = now - new Date(pos.acquired_at).getTime();
  return ms > 0 ? ms : null;
}

/**
 * Diamond hands for a mint from the latest snapshot. Queues a snapshot or backfill
 * when needed (dispatch=true) and returns computed:false until the sample is settled.
 */
async function getDiamondHands(mint, { dispatch = true } = {}) {
  const cached = await cache.get(keys.result(mint));
  if (cached) return cached;

  const snap = await store.getLatestSnapshot(mint);
  if (!snap || !Array.isArray(snap.sample)) {
    if (dispatch) await ensureSnapshot(mint);
    return { distribution: null, sampleSize: 0, analyzed: 0, computed: false };
  }

  const now = Date.now();
  const sample = snap.sample;
  const positions = await store.getPositions(mint, sample.map(s => s.wallet));
  const holdTimes = {};
  let pending = 0;
  for (const s of sample) {
    const pos = positions.get(s.wallet);
    if (pos && pos.acquired_source === 'pending') { pending++; continue; }
    const ms = holdTimeOf(pos, now);
    if (ms != null) holdTimes[s.wallet] = ms;
  }

  const meta = snap.sample_meta || {};
  const { distribution, supplyDistribution } = buildStratifiedDiamondHands(sample, holdTimes, meta.strata);
  const snapshotAt = new Date(snap.taken_at).getTime();
  const result = {
    distribution,
    supplyDistribution,
    sampleSize: sample.length,
    analyzed: sample.length - pending,
    computed: pending === 0,
    sampleMethod: meta.method || null,
    // Same meaning as the holder count shown elsewhere (token accounts with a balance)
    holderCount: snap.holder_count,
    snapshotAt,
  };

  if (!result.computed) {
    result.totalCount = sample.length;
    if (dispatch) await ensureBackfill(mint);
    return result;
  }

  await cache.set(keys.result(mint), result, CONFIG.resultTtl).catch(() => {});
  if (distribution) {
    const convictionMeta = {
      method: meta.method, snapshotId: snap.id, snapshotAt, holderCount: snap.holder_count,
      eligible: meta.eligible, strata: meta.strata, supplyDistribution,
    };
    await require('./database').upsertConviction(mint, distribution, sample.length, result.analyzed, convictionMeta)
      .catch(err => console.error(`[Holders] Conviction persist failed for ${mint.slice(0, 8)}:`, err.message));
  }
  if (dispatch && now - snapshotAt > CONFIG.staleSnapshotMs) {
    // A snapshot the pre-check recently confirmed is not stale, however old its rows
    const verified = Number(await cache.get(keys.snapshotVerified(mint)).catch(() => 0)) || 0;
    if (now - Math.max(snapshotAt, verified) > CONFIG.staleSnapshotMs) await ensureSnapshot(mint);
  }
  return result;
}

/**
 * Hold times (ms) for specific wallets. computed=false while any of them is still
 * waiting for its backfill, or before the first snapshot exists.
 */
async function getHoldTimes(mint, wallets) {
  const holdTimes = {};
  if (!wallets || wallets.length === 0) return { holdTimes, computed: true };
  const snap = await store.getLatestSnapshot(mint);
  if (!snap) {
    await ensureSnapshot(mint);
    return { holdTimes, computed: false };
  }
  const now = Date.now();
  const positions = await store.getPositions(mint, wallets);
  // LP wallets are never backfilled (walletsOfInterest), so never wait on them
  const lp = new Set(snap.sample_meta?.lpWallets || []);
  let pending = 0;
  for (const w of wallets) {
    const pos = positions.get(w);
    if (pos && pos.acquired_source === 'pending') { if (!lp.has(w)) pending++; continue; }
    const ms = holdTimeOf(pos, now);
    if (ms != null) holdTimes[w] = ms;
  }
  if (pending > 0) await ensureBackfill(mint);
  return { holdTimes, computed: pending === 0 };
}

/**
 * Top holders from the latest snapshot, shaped like the rawAccounts the
 * compute-holder-analytics job takes. Null when there is no recent snapshot.
 */
async function getSnapshotHolderList(mint, { maxAgeMs = Math.max(6 * 3_600_000, 2 * CONFIG.refreshMs), limit = CONFIG.listN } = {}) {
  const snap = await store.getLatestSnapshot(mint);
  // A snapshot without a supply was written before supply/decimals were required;
  // its decimals can't be trusted, so callers fall back and a new one is taken.
  if (!snap || snap.supply == null) return null;
  // A snapshot the pre-check recently confirmed unchanged is as good as a new one
  const verified = Number(await cache.get(keys.snapshotVerified(mint)).catch(() => 0)) || 0;
  const freshAt = Math.max(new Date(snap.taken_at).getTime(), verified);
  if (Date.now() - freshAt > maxAgeMs) return null;
  const entries = await store.getSnapshotEntries(snap.id, limit);
  if (entries.length === 0) return null;
  const div = Math.pow(10, snap.decimals || 0);
  return {
    snapshot: snap,
    rawAccounts: entries.map(e => ({ address: e.token_account, wallet: e.wallet, uiAmount: Number(e.amount) / div })),
    totalSupply: snap.supply != null ? Number(snap.supply) / div : null,
    decimals: snap.decimals || 0,
  };
}

module.exports = {
  CONFIG,
  ensureSnapshot,
  ensureBackfill,
  getFreshnessTimes,
  takeSnapshot,
  runBackfill,
  getDiamondHands,
  getHoldTimes,
  getSnapshotHolderList,
  // exported for tests
  walletsOfInterest,
  backfillWallet,
};
