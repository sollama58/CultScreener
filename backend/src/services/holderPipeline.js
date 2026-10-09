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

const crypto = require('crypto');
const solanaService = require('./solana');
const store = require('./holderStore');
const { cache, TTL } = require('./cache');
const { BURN_WALLETS, LP_PROGRAMS, LP_AUTHORITIES, SYSTEM_PROGRAM_ID, DIAMOND_HANDS_BUCKETS } = require('../constants');
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
  // Waits before re-trying a failed LP-check batch. The check runs after every DAS
  // page is paid for, so a failure there used to throw the whole read away and the
  // job retry bought every page again; two 1-credit calls are worth waiting for.
  lpCheckRetryMs: [2000, 5000, 10000],
  // Curated tokens are re-snapshotted this often (the hourly job checks staleness).
  // Under 6h, new holders are still dated from consecutive snapshots.
  refreshMs: envInt('HOLDER_SNAPSHOT_REFRESH_HOURS', 4) * 3_600_000,
  // A backfill job keeps going until every wallet is settled or this much time has
  // passed, then re-queues itself. Re-queueing after every few dozen wallets put
  // each token back at the end of the shared job queue, behind every other job.
  backfillRunMs: envInt('HOLDER_BACKFILL_RUN_SECONDS', 240) * 1000,
  backfillConcurrency: envInt('HOLDER_BACKFILL_CONCURRENCY', 12), // wallets read at once per mint
  // Tokens backfilling at the same time, across the worker. Three tokens at 12
  // wallets each fill the 24 Helius slots; ten tokens sharing them would each
  // crawl. The rest wait a few seconds and try again.
  backfillMaxTokens: envInt('HOLDER_BACKFILL_MAX_TOKENS', 3),
  // A token waiting for a slot comes back after this (plus up to a third more, so
  // waiters spread out); a slot is held for minutes, so polling faster only churns
  // the job queue and the database
  backfillSlotWaitMs: 15000,
  // Helius pushing back (429, full queue, open breaker) pauses the run this long,
  // doubling each time it happens again straight away; after pushbackMaxPauses in
  // a row the run ends and comes back later.
  pushbackPauseMs: 3000,
  pushbackMaxPauses: 3,
  // Timeouts and 5xx answers this many times in a row (no success between) look like
  // an outage, not the wallets: from then on the run pauses and retries them like a
  // pushback. A run in which that many wallets failed this way and nothing got an
  // answer counts no attempt at all and comes back after outageRetryMs, so a few
  // minutes of Helius 502s do not use up every pending wallet's attempts.
  transientBurst: 3,
  outageRetryMs: 60 * 1000,
  // ...but only for this many such runs in a row (within outageWindowMs): wallets
  // that fail every time on their own (huge histories timing out) look the same,
  // and past this their attempts count again so they are given up in the end.
  outageMaxRuns: 10,
  outageWindowMs: 60 * 60 * 1000,
  // While the backfill is still running, a partial distribution is shown only once
  // every stratum has this many resolved wallets (or all of its sampled ones), so
  // the first numbers the page shows are not the whales alone.
  partialMinResolved: 10,
  backfillPagesPerWallet: 5,                                 // per run; progress is saved between runs
  // Transactions read per wallet before accepting a lower bound.
  backfillMaxTxs: envInt('HOLDER_BACKFILL_MAX_TXS', 2000),
  // getTransactionsForAddress bills 10 credits per 100 transactions returned, so
  // page size sets round trips, not cost. Most holders' token accounts settle on a
  // small first page; the busy ones continue in larger pages (2000 txs = 5 calls).
  backfillFirstPageSize: envInt('HOLDER_BACKFILL_FIRST_PAGE_SIZE', 100),
  // 500, not 1000: a page of 1000 full transactions is several MB to download
  // and parse, and with a dozen in flight it risked timeouts and memory spikes.
  backfillPageSize: envInt('HOLDER_BACKFILL_PAGE_SIZE', 500),
  backfillMaxAttempts: 3,
  // Rate limits, timeouts and an open circuit say nothing about the wallet, so
  // they get more tries before the wallet is given up.
  backfillMaxTransientAttempts: 8,
  resultTtl: 15 * 60 * 1000,                                 // hold times grow; recompute often (cheap, DB only)
  snapshotLockTtl: 10 * 60 * 1000,
  snapshotFailCooldown: 5 * 60 * 1000,
  backfillLockTtl: 10 * 60 * 1000,                           // > backfillRunMs plus the slowest wallet
  backfillFailCooldown: 60 * 1000,                           // > BullMQ's retry backoff
  staleSnapshotMs: 24 * 3_600_000,                           // routes ask for a fresh one past this
};

const keys = {
  result: mint => `diamond-hands:${mint}`,
  // computed hold times cached by GET /:mint/holders/hold-times (routes/tokens.js)
  holdTimes: mint => `hold-times:${mint}`,
  snapshotPending: mint => `holder-snapshot-pending:${mint}`,
  backfillPending: mint => `holder-backfill-pending:${mint}`,
  // when a cheap pre-check last found the previous snapshot still accurate
  snapshotVerified: mint => `holder-snapshot-verified:${mint}`,
  backfillSlot: i => `holder-backfill-slot:${i}`,
  // set when a run found wallets pending but no free slot
  backfillWaiting: mint => `holder-backfill-waiting:${mint}`,
  // backfill runs in a row that looked like a Helius outage
  backfillOutageRuns: mint => `holder-backfill-outage-runs:${mint}`,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mints with a snapshot or backfill running in this process. The Redis locks are the
// dispatch dedupe, but they vanish with a Redis restart or eviction while the run
// carries on; a second job for the same mint must not then read the same pages again.
const running = { snapshot: new Set(), backfill: new Set(), slots: new Set(), outageRuns: new Map() };

// Count one more outage run for the mint (Redis, or this process when Redis is down)
async function countOutageRun(mint) {
  const n = await cache.incrBy(keys.backfillOutageRuns(mint), 1, CONFIG.outageWindowMs).catch(() => null);
  if (n != null) return n;
  const local = (running.outageRuns.get(mint) || 0) + 1;
  running.outageRuns.set(mint, local);
  return local;
}

async function clearOutageRuns(mint) {
  running.outageRuns.delete(mint);
  await cache.delete(keys.backfillOutageRuns(mint)).catch(() => {});
}

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

/**
 * When one snapshot was last known current (ms): taken, or confirmed by a later
 * pre-check, from Postgres or the Redis key (whichever is newer).
 */
async function snapshotFreshAt(mint, snap) {
  const t = v => (v ? new Date(v).getTime() : 0);
  const verified = Number(await cache.get(keys.snapshotVerified(mint)).catch(() => 0)) || 0;
  return Math.max(t(snap.taken_at), t(snap.verified_at), t(snap.checked_at), verified);
}

/**
 * Whether a mint is due for its periodic refresh. Each mint has its own fixed
 * refreshMs-aligned schedule (offset by a hash of the mint), so curated tokens
 * come due spread across the hourly ticks instead of all in the same one.
 *
 * @param {string} mint
 * @param {number|undefined} freshAt when its data was last known current (ms)
 */
function refreshOffset(mint) {
  return parseInt(crypto.createHash('sha256').update(mint).digest('hex').slice(0, 12), 16) % CONFIG.refreshMs;
}

function isRefreshDue(mint, freshAt, now = Date.now()) {
  if (!freshAt) return true;
  const off = refreshOffset(mint);
  return Math.floor((now - off) / CONFIG.refreshMs) > Math.floor((freshAt - off) / CONFIG.refreshMs);
}

// ── Job dispatch (deduped with short-lived locks) ────────────────────────────

async function ensureSnapshot(mint) {
  const acquired = await cache.setNX(keys.snapshotPending(mint), Date.now(), CONFIG.snapshotLockTtl).catch(() => false);
  if (!acquired) return false;
  const jobQueue = require('./jobQueue');
  // One snapshot job per mint: a job that waited in the queue past the lock's TTL is
  // found again by its id instead of a second full DAS read being queued beside it.
  // Removed once done, so the id never hides a later request. (BullMQ rejects ids
  // with a single ':', hence the '-'.)
  const job = await jobQueue.addAnalyticsJob('snapshot-holders', { mint },
    { jobId: `snapshot-${mint}`, removeOnComplete: true, removeOnFail: true });
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

// Wallets among the largest holders that are not people: LP vaults, and any
// other program-derived account (lockers, staking and vesting vaults, exchange
// programs). A keypair wallet's account is owned by the System Program; anything
// else holding the token is a contract, and contracts hold forever.
function isProgramOwned(acct) {
  return !!acct && !!acct.owner && acct.owner !== SYSTEM_PROGRAM_ID;
}

async function detectLpWallets(holders) {
  const lp = new Set();
  const candidates = holders.slice(0, CONFIG.lpCheckN).map(h => h.wallet).filter(w => !BURN_WALLETS.has(w));
  for (const w of candidates) if (LP_AUTHORITIES.has(w) || LP_PROGRAMS.has(w)) lp.add(w);
  // The batches (100 wallets each) are independent: read them at once
  const starts = [];
  for (let i = 0; i < candidates.length; i += 100) starts.push(i);
  await Promise.all(starts.map(async i => {
    const batch = candidates.slice(i, i + 100);
    // No answer means vaults would go unflagged: into the sample and the holder
    // count. Retry here first (an open breaker is waited out); only then fail the
    // snapshot (the job retries) rather than write it that way.
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await solanaService.getMultipleAccounts(batch);
        break;
      } catch (err) {
        const wait = CONFIG.lpCheckRetryMs[attempt];
        if (wait == null) throw new Error(`LP wallet check failed: ${err.message}`);
        const delay = err.isCircuitBreakerError ? Math.max(wait, Number(err.retryAfter) || 0) : wait;
        console.warn(`[Holders] LP wallet check batch failed (${err.message}); retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
    (res?.value || []).forEach((acct, j) => {
      if (isProgramOwned(acct)) lp.add(batch[j]);
    });
  }));
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

// DAS pages are offset windows over a live account list. An account closed between two page
// reads shifts the later pages down by one, so the account at the boundary is on neither
// page; a complete snapshot then deleted its holder's position as departed, and the wallet
// came back next time as a newcomer with its streak reset. Before that, re-read the stored
// accounts of wallets that vanished and put back the ones still holding (one call per 100
// wallets, capped so a mass exit can't run up credits). A failed read changes nothing:
// those wallets count as departed, as before.
const MAX_DEPARTURE_CHECKS = 2000;

async function restoreMissedHolders(mint, accounts) {
  const present = new Set(accounts.map(a => a.owner));
  const gone = (await store.getPositionAccounts(mint))
    .filter(p => p.token_account && !present.has(p.wallet))
    .slice(0, MAX_DEPARTURE_CHECKS);
  let restored = 0;
  for (let i = 0; i < gone.length; i += 100) {
    const batch = gone.slice(i, i + 100);
    const res = await solanaService.getMultipleAccounts(batch.map(p => p.token_account)).catch(() => null);
    (res?.value || []).forEach((acct, j) => {
      const info = acct?.data?.parsed?.info;
      if (!info || info.mint !== mint || info.owner !== batch[j].wallet) return;
      const amount = info.tokenAmount?.amount;
      if (!/^\d+$/.test(amount || '') || BigInt(amount) <= 0n) return;
      accounts.push({ owner: info.owner, address: batch[j].token_account, amount });
      restored++;
    });
  }
  if (restored > 0) {
    console.log(`[Holders] ${mint.slice(0, 8)}: ${restored} holder(s) missing from the page read still hold; kept`);
  }
  return restored;
}

// ── Holder count history ─────────────────────────────────────────────────────

/**
 * Record the snapshot's holder count (services/holderCounts.js). A complete
 * snapshot's count is exact; a capped one is stored as a lower bound. Either
 * becomes the displayed count: a capped snapshot has read CONFIG.maxPages pages,
 * far closer than the 100-page DAS count that would otherwise be shown (and paid
 * for again every day). Never fails the snapshot.
 */
async function recordSnapshotPoint(mint, { takenAt, complete, holders, exclude, decimals, supply, accountCount }) {
  try {
    const token = await require('./database').getToken(mint).catch(() => null);
    const dustRaw = holderCounts.dustThresholdRaw({ priceUsd: token?.price, decimals, supplyRaw: supply });
    const counts = holderCounts.countHolders(holders, { exclude, dustRaw });
    await holderCounts.recordPoint(mint, {
      takenAt, holders: counts.holders, dust: counts.dust, legacyCount: accountCount, complete, source: 'snapshot',
    });
    if (counts.holders > 0) {
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
    if (!latest) return;
    // (a capped snapshot's lower bound too: see recordSnapshotPoint)
    if (latest.holders > 0) {
      await cache.set(`holder-total:${mint}`, latest.holders, TTL.HOLDER_COUNT).catch(() => {});
    }
    if (!latest.complete || !checkedAll || !prev.complete) return;
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
  if (running.snapshot.has(mint)) {
    console.log(`[Holders] Snapshot for ${mint.slice(0, 8)} already running here; skipped`);
    return { status: 'busy' };
  }
  running.snapshot.add(mint);
  try {
    return await takeSnapshotRun(mint);
  } finally {
    running.snapshot.delete(mint);
  }
}

async function takeSnapshotRun(mint) {
  const startedAt = Date.now();
  try {
    // Hold the dedupe lock for the whole run, also when the job waited in the queue
    // longer than the lock lived (as runBackfill does)
    await cache.set(keys.snapshotPending(mint), Date.now(), CONFIG.snapshotLockTtl).catch(() => {});
    const prev = await store.getLatestSnapshot(mint);
    // Supply and decimals are required. Balances are stored raw and every UI amount
    // and percentage is derived from these two; a snapshot written with decimals
    // defaulted to 0 and no supply showed raw balances as tokens and holder shares
    // in the millions of percent.
    // Supply and the pre-check's first DAS page (below) are independent: read both at once
    const [supplyRes, first] = await Promise.all([
      solanaService.getTokenSupply(mint),
      solanaService.getAllTokenAccounts(mint, { maxPages: 1 }),
    ]);
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
    const fingerprint = holderFingerprint(supply, first.accounts);
    const prevUsable = prev && prev.supply != null && prev.decimals === decimals
      && (first.complete || Date.now() - new Date(prev.taken_at).getTime() < CONFIG.staleSnapshotMs);
    if (prevUsable && prevFingerprint && fingerprint === prevFingerprint) {
      const now = Date.now();
      await cache.set(keys.snapshotVerified(mint), now, CONFIG.refreshMs * 2).catch(() => {});
      // One page was the whole list, so every account is known unchanged as of
      // now: newcomers at the next snapshot are dated from here, not from the
      // old taken_at, which kept them out of the 6h window and sent them to
      // the paid backfill. Either way the check is stored with the snapshot, so
      // it is not lost with the Redis key (restart or eviction).
      await store.markVerified(prev.id, now, { all: first.complete }).catch(() => {});
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
    // Only a complete snapshot deletes departed positions
    else if (prev) await restoreMissedHolders(mint, accounts);
    const takenAt = Date.now();
    const holders = aggregateHolders(accounts);
    // The raw account list (one object per token account, tens of MB for a big
    // token) isn't needed past aggregation; let it go before the LP check and the DB write
    const accountCount = accounts.length;
    accounts = null;
    first.accounts = null;
    if (holders.length === 0) {
      await cache.delete(keys.snapshotPending(mint)).catch(() => {});
      return { status: 'empty' };
    }

    const lpWallets = await detectLpWallets(holders);
    const exclude = new Set([...BURN_WALLETS, ...LP_PROGRAMS, ...LP_AUTHORITIES, ...lpWallets]);
    const { sample, meta } = selectSample(mint, holders, { exclude });
    meta.lpWallets = [...lpWallets];
    // holder_count is every wallet; the count shown elsewhere leaves out burn,
    // LP and program-owned wallets (recordSnapshotPoint), and so does this one
    meta.holderCount = holderCounts.countHolders(holders, { exclude }).holders;
    meta.complete = complete;
    meta.fingerprint = fingerprint;

    const newAcquisition = newWalletAcquisition(
      prev ? {
        takenAt: Math.max(new Date(prev.taken_at).getTime(), prev.verified_at ? new Date(prev.verified_at).getTime() : 0),
        complete: prev.complete,
      } : null,
      takenAt
    );

    const snapshotId = await store.writeSnapshot({
      mint, takenAt, complete, pages, accountCount, holders, decimals, supply,
      sample, sampleMeta: meta, topN: CONFIG.topN, newAcquisition,
    });
    await store.pruneSnapshots(mint).catch(err => console.warn(`[Holders] Prune failed for ${mint.slice(0, 8)}:`, err.message));

    await recordSnapshotPoint(mint, { takenAt, complete, holders, exclude, decimals, supply, accountCount });
    await cache.delete(keys.result(mint)).catch(() => {});
    await cache.delete(keys.holdTimes(mint)).catch(() => {});
    await cache.delete(keys.snapshotVerified(mint)).catch(() => {});

    console.log(`[Holders] Snapshot ${snapshotId} for ${mint.slice(0, 8)}: ${holders.length} wallets from ${accountCount} accounts, ` +
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

// Wallets whose hold time we need: the conviction sample, then the listed top
// holders. The sample's strata are interleaved (top, mid, tail, top, ...) so a
// partial result during the backfill describes every stratum, not the top 50
// first and the rest later.
function walletsOfInterest(snap, entries) {
  const excluded = new Set(snap.sample_meta?.lpWallets || []);
  const ordered = [];
  const seen = new Set();
  const add = w => { if (w && !seen.has(w) && !excluded.has(w) && !BURN_WALLETS.has(w)) { seen.add(w); ordered.push(w); } };
  const byStratum = new Map();
  for (const s of snap.sample || []) {
    const k = s.stratum || 'top';
    if (!byStratum.has(k)) byStratum.set(k, []);
    byStratum.get(k).push(s.wallet);
  }
  const lists = [...byStratum.values()];
  for (let i = 0; lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length) add(l[i]);
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
async function backfillWallet(mint, pos, decimals, { boundBeforeMs = null } = {}) {
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
    // Only a real answer counts: a closed account (RPC "could not find account")
    // or a zero balance. Rate limiting, timeouts and an open breaker go to the
    // caller's retry and pushback handling instead of marking a holder 'left'.
    const bal = await solanaService.getTokenAccountBalance(tokenAccount).catch(err => {
      if (isAccountMissing(err)) return null;
      throw err;
    });
    balance = toBigInt(bal?.value?.amount);
    if (balance <= 0n) {
      // Account emptied or closed since the snapshot: the wallet left. The next
      // complete snapshot drops the row; if it is holding again by then, the
      // snapshot write dates it like a newcomer (a new streak).
      await store.saveBackfill(mint, pos.wallet, { source: 'left', attempted: true });
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

    // Once the history read reaches back past boundBeforeMs (the oldest diamond
    // hands bucket), more pages can't change which bucket the wallet lands in.
    const pastBound = boundBeforeMs != null && oldestAt != null && oldestAt <= boundBeforeMs;
    if (pastBound || txsBefore + txsRead >= CONFIG.backfillMaxTxs) {
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

// The JSON-RPC answer for a token account that no longer exists (closed)
function isAccountMissing(err) {
  return err?.rpcCode === -32602 || /could not find account/i.test(String(err?.message || ''));
}

// A failure that says nothing about the wallet itself: Helius rate limiting or
// erroring, our own queue or circuit breaker refusing, or the request timing out.
// Helius or our own queue pushing back (as opposed to one slow request).
function isPushback(err) {
  return err?.response?.status === 429 || !!err?.isOverloaded || !!err?.isCircuitBreakerError || err?.name === 'CircuitBreakerError';
}

function isTransientError(err) {
  if (!err) return false;
  const status = err.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (err.isOverloaded || err.isCircuitBreakerError || err.name === 'CircuitBreakerError') return true;
  if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err.code)) return true;
  return /timeout|timed out|socket hang up/i.test(String(err.message || ''));
}

/**
 * Backfill pass for a mint. Worker only. Works the pending wallets with a small
 * pool until all are settled or CONFIG.backfillRunMs has passed, then re-queues
 * itself while work remains; when everything is settled, recomputes and stores
 * diamond hands.
 */
async function acquireBackfillSlot(mint) {
  // Also counted in-process, so lost slot keys (Redis restart) don't let every token in
  if (running.slots.size >= CONFIG.backfillMaxTokens) return null;
  for (let i = 0; i < CONFIG.backfillMaxTokens; i++) {
    const key = keys.backfillSlot(i);
    if (await cache.setNX(key, mint, CONFIG.backfillLockTtl).catch(() => true)) {
      running.slots.add(mint);
      return key;
    }
  }
  return null;
}

async function releaseBackfillSlot(key, mint) {
  if (!key) return;
  running.slots.delete(mint);
  // Only our own slot: the TTL could have let another token take it over
  const holder = await cache.get(key).catch(() => null);
  if (holder == null || holder === mint) await cache.delete(key).catch(() => {});
}

async function runBackfill(mint) {
  if (running.backfill.has(mint)) {
    console.log(`[Holders] Backfill for ${mint.slice(0, 8)} already running here; skipped`);
    return { status: 'busy' };
  }
  running.backfill.add(mint);
  try {
    return await runBackfillPass(mint);
  } finally {
    running.backfill.delete(mint);
  }
}

async function runBackfillPass(mint) {
  let remaining = 0;
  let retryDelay = 2000;
  let slot = null;
  let failed = false;
  const startedAt = Date.now();
  try {
    // Hold the dedupe lock for this run, also when this is BullMQ retrying a
    // failed run whose lock was kept only as a short cooldown
    await cache.set(keys.backfillPending(mint), Date.now(), CONFIG.backfillLockTtl).catch(() => {});
    const waitForSlot = async () => {
      // Other tokens hold every slot: wait rather than share the Helius
      // concurrency so thinly that every token slows down
      await cache.set(keys.backfillWaiting(mint), Date.now(), 2 * 60 * 1000).catch(() => {});
      remaining = 1;
      retryDelay = CONFIG.backfillSlotWaitMs + Math.floor(Math.random() * CONFIG.backfillSlotWaitMs / 3);
      return { status: 'waiting' };
    };
    // Try for a slot first: a token that was already waiting with wallets pending
    // and still finds none goes back to waiting without the database reads below
    slot = await acquireBackfillSlot(mint);
    if (!slot && await cache.get(keys.backfillWaiting(mint)).catch(() => null)) return await waitForSlot();
    const snap = await store.getLatestSnapshot(mint);
    if (!snap) return { status: 'no-snapshot' };
    // Gave up a day or more ago: try again (writeSnapshot does this too, but an unchanged
    // token never writes one)
    await store.requeueFailedBackfills(mint, Date.now());
    const entries = await store.getSnapshotEntries(snap.id, CONFIG.listN);
    const wallets = walletsOfInterest(snap, entries);
    const positions = await store.getPositions(mint, wallets);
    const pendingAtStart = wallets.filter(w => positions.get(w)?.acquired_source === 'pending');
    // A slot only for runs that read history: with nothing pending the run just
    // re-stores diamond hands (database only) and must not wait behind real backfills
    if (pendingAtStart.length > 0) {
      if (!slot) return await waitForSlot();
      await cache.delete(keys.backfillWaiting(mint)).catch(() => {});
    } else {
      await cache.delete(keys.backfillWaiting(mint)).catch(() => {});
      if (slot) { await releaseBackfillSlot(slot, mint); slot = null; }
    }

    // Listed top holders show their exact hold time, so only sample-only wallets
    // stop reading once their history is older than the oldest bucket.
    const listed = new Set(entries.map(e => e.wallet));
    const oldestBucketMs = Math.max(...DIAMOND_HANDS_BUCKETS.map(b => b.ms));

    const stats = { settled: 0, answered: 0, errors: 0, transient: 0, pushbacks: 0, slowestMs: 0, slowestWallet: null };
    // Start each run at a different wallet, so the attempts an outage costs before
    // the run backs off do not land on the same leading wallets run after run
    const startAt = Math.floor(Math.random() * pendingAtStart.length);
    const queue = pendingAtStart.slice(startAt).concat(pendingAtStart.slice(0, startAt));
    const outOfTime = () => Date.now() - startedAt >= CONFIG.backfillRunMs;
    // Helius pushing back pauses the whole run (every slot waits), with the pause
    // doubling while it keeps happening; after pushbackMaxPauses pauses in a row
    // the run ends and comes back later. Pushbacks that land during a pause are
    // the same burst and start no new pause.
    // (monotonic clock: the pause is wall time, independent of Date.now)
    let pausedUntil = 0;
    let pausesInARow = 0;
    let transientInARow = 0;
    // answers since the last burst of timeouts/5xx: answers from before an outage
    // began say nothing about the wallets that failed in it
    let answeredSinceBurst = 0;
    // wallet → position, for timeouts/5xx whose attempt is settled when the run ends
    const deferred = new Map();
    const pushedBack = () => {
      stats.pushbacks++;
      if (performance.now() < pausedUntil) return;
      pausesInARow++;
      if (pausesInARow > CONFIG.pushbackMaxPauses) { stats.backoff = true; return; }
      pausedUntil = performance.now() + CONFIG.pushbackPauseMs * Math.pow(2, pausesInARow - 1);
    };

    const runOne = async wallet => {
      // Re-read the row: an earlier pass in this run may have saved a cursor for it.
      // A failed read must not reject the pool and leave its other slots running
      // on after this run has released its lock.
      let pos;
      try {
        pos = (await store.getPositions(mint, [wallet])).get(wallet);
      } catch (err) {
        stats.errors++;
        console.warn(`[Holders] Backfill ${wallet.slice(0, 8)} on ${mint.slice(0, 8)} could not read its position:`, err.message);
        return null;
      }
      if (!pos || pos.acquired_source !== 'pending') return true;
      const t0 = Date.now();
      try {
        const done = await backfillWallet(mint, pos, snap.decimals || 0, {
          boundBeforeMs: listed.has(wallet) ? null : Date.now() - oldestBucketMs,
        });
        const ms = Date.now() - t0;
        pausesInARow = 0;
        transientInARow = 0;
        stats.answered++;
        answeredSinceBurst++;
        deferred.delete(wallet);
        if (ms > stats.slowestMs) { stats.slowestMs = ms; stats.slowestWallet = wallet; }
        if (ms > 15000) console.log(`[Holders] Backfill ${wallet.slice(0, 8)} on ${mint.slice(0, 8)} took ${ms}ms${done ? '' : ' (more history to read)'}`);
        return done;
      } catch (err) {
        const transient = isTransientError(err);
        const pushback = isPushback(err);
        stats.errors++;
        if (transient) stats.transient++;
        if (transient && !pushback) {
          // A timeout or 5xx may be this wallet or Helius as a whole: its attempt is
          // counted when the run ends, unless the run turns out to be an outage
          transientInARow++;
          deferred.set(wallet, pos);
          if (transientInARow === CONFIG.transientBurst) answeredSinceBurst = 0;
          if (transientInARow < CONFIG.transientBurst) return null; // try again on a later run
          // Several in a row: pause and retry, as for a pushback
          pushedBack();
          return stats.backoff ? null : false;
        }
        if (!transient) { stats.answered++; answeredSinceBurst++; }
        if (pushback) pushedBack();
        // A pushback says nothing about the wallet: it counts as one attempt per
        // run (when the run gives up on the burst), not one per retry
        const countsAttempt = !pushback || !!stats.backoff;
        const limit = transient ? CONFIG.backfillMaxTransientAttempts : CONFIG.backfillMaxAttempts;
        const giveUp = countsAttempt && (pos.backfill_attempts || 0) + 1 >= limit;
        if (!pushback || stats.backoff) {
          console.warn(`[Holders] Backfill ${wallet.slice(0, 8)} on ${mint.slice(0, 8)} failed${transient ? ' (transient)' : ''}${giveUp ? ' (giving up)' : ''}:`, err.message);
        }
        await store.saveBackfill(mint, wallet, {
          source: giveUp ? 'failed' : null,
          cursor: pos.backfill_cursor,
          balance: pos.backfill_balance != null ? toBigInt(pos.backfill_balance) : null,
          oldestAt: pos.backfill_oldest_at ? new Date(pos.backfill_oldest_at).getTime() : null,
          attempted: countsAttempt,
        }).catch(() => {});
        if (giveUp) return true;
        // Pushed back: the run pauses, then this wallet goes back in line
        if (pushback) return false;
        return null; // try again on a later run
      }
    };

    // A pool: each slot takes the next wallet as soon as its last one is done, so
    // one slow account doesn't hold the others back. A wallet with more history
    // to read goes to the back of the line and continues from its saved cursor.
    await Promise.all(Array.from({ length: Math.min(CONFIG.backfillConcurrency, queue.length) }, async () => {
      while (queue.length > 0 && !outOfTime() && !stats.backoff) {
        while (pausedUntil > performance.now() && !stats.backoff) await sleep(Math.max(1, Math.min(500, pausedUntil - performance.now())));
        if (stats.backoff) break;
        const wallet = queue.shift();
        const done = await runOne(wallet);
        if (done === true) stats.settled++;
        else if (done === false && !stats.backoff) queue.push(wallet);
      }
    }));

    if (stats.backoff) retryDelay = 15000;

    // Timeouts/5xx: several wallets failing with no answer for any wallet is Helius
    // being down, which says nothing about them; otherwise each counts one attempt.
    // Past outageMaxRuns such runs in a row the wallets are more likely the cause
    // than Helius, and their attempts count again.
    let outage = deferred.size >= CONFIG.transientBurst && answeredSinceBurst === 0;
    if (outage) {
      const outageRuns = await countOutageRun(mint);
      if (outageRuns > CONFIG.outageMaxRuns) {
        outage = false;
        console.warn(`[Holders] Backfill ${mint.slice(0, 8)}: ${outageRuns} erroring runs in a row; counting attempts again`);
      }
    } else if (stats.answered > 0) {
      await clearOutageRuns(mint);
    }
    if (outage) {
      retryDelay = CONFIG.outageRetryMs;
    } else {
      for (const [wallet, pos] of deferred) {
        const giveUp = (pos.backfill_attempts || 0) + 1 >= CONFIG.backfillMaxTransientAttempts;
        if (giveUp) console.warn(`[Holders] Backfill ${wallet.slice(0, 8)} on ${mint.slice(0, 8)}: giving up after ${CONFIG.backfillMaxTransientAttempts} failed runs`);
        await store.saveBackfill(mint, wallet, {
          source: giveUp ? 'failed' : null,
          cursor: pos.backfill_cursor,
          balance: pos.backfill_balance != null ? toBigInt(pos.backfill_balance) : null,
          oldestAt: pos.backfill_oldest_at ? new Date(pos.backfill_oldest_at).getTime() : null,
          attempted: true,
        }).catch(() => {});
      }
    }

    const after = await store.getPositions(mint, wallets);
    remaining = wallets.filter(w => after.get(w)?.acquired_source === 'pending').length;
    const elapsed = Date.now() - startedAt;
    console.log(`[Holders] Backfill ${mint.slice(0, 8)}: ${stats.settled}/${pendingAtStart.length} settled in ${elapsed}ms, ` +
      `${remaining} pending, slowest wallet ${stats.slowestMs}ms${stats.slowestWallet ? ` (${stats.slowestWallet.slice(0, 8)})` : ''}` +
      `${stats.errors ? `, ${stats.errors} errors (${stats.transient} transient)` : ''}${stats.pushbacks ? `, ${stats.pushbacks} pushbacks` : ''}${stats.backoff ? ', backing off' : ''}${outage ? ', Helius erroring (no attempts counted)' : ''}`);
    if (remaining === 0) {
      await cache.delete(keys.result(mint)).catch(() => {});
      await cache.delete(keys.holdTimes(mint)).catch(() => {});
      const dh = await getDiamondHands(mint, { dispatch: false });
      if (dh.computed && pendingAtStart.length > 0) {
        const sinceSnapshot = Date.now() - new Date(snap.taken_at).getTime();
        console.log(`[Holders] Diamond hands ready for ${mint.slice(0, 8)}: ${Math.round(sinceSnapshot / 1000)}s after its snapshot`);
      }
      // A snapshot taken while this run was going brings its own pending wallets,
      // and its backfill request was refused because this run held the lock.
      // Go round again on the new snapshot.
      if (!dh.computed) {
        const latest = await store.getLatestSnapshot(mint).catch(() => null);
        if (latest && latest.id !== snap.id) remaining = dh.sampleSize - dh.analyzed;
      }
    }
    return { status: 'ok', settled: stats.settled, remaining, ms: elapsed };
  } catch (err) {
    // BullMQ retries the job: keep the lock as a cooldown so an API poll does
    // not queue a second run alongside the retry
    failed = true;
    await cache.set(keys.backfillPending(mint), Date.now(), CONFIG.backfillFailCooldown).catch(() => {});
    throw err;
  } finally {
    await releaseBackfillSlot(slot, mint);
    if (!failed) await cache.delete(keys.backfillPending(mint)).catch(() => {});
    if (remaining > 0) await ensureBackfill(mint, { delay: retryDelay }).catch(() => {});
  }
}

// ── Reads (API routes) ───────────────────────────────────────────────────────

// Every stratum with sampled wallets has at least partialMinResolved of them
// resolved (or all of them, when it has fewer).
function partialReady(strata, resolvedByStratum) {
  for (const [k, st] of Object.entries(strata || {})) {
    if (!(st && st.population > 0 && st.sampled > 0)) continue;
    if ((resolvedByStratum[k] || 0) < Math.min(CONFIG.partialMinResolved, st.sampled)) return false;
  }
  return true;
}

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
  let { distribution, supplyDistribution, resolved, resolvedByStratum } = buildStratifiedDiamondHands(sample, holdTimes, meta.strata);
  if (pending > 0 && distribution && !partialReady(meta.strata, resolvedByStratum)) {
    // Too early to show: with only one stratum in, the number would be that
    // stratum's alone and then jump as the others arrive
    distribution = null;
    supplyDistribution = null;
  }
  const snapshotAt = new Date(snap.taken_at).getTime();
  const result = {
    distribution,
    supplyDistribution,
    sampleSize: sample.length,
    // Wallets the backfill has finished with, including those it could not
    // date ('failed'/'left'); `resolved` is the number the distribution rests on
    analyzed: sample.length - pending,
    resolved,
    computed: pending === 0,
    sampleMethod: meta.method || null,
    // Same meaning as the holder count shown elsewhere (burn, LP and program-owned
    // wallets left out); snapshots written before that was stored fall back to all
    holderCount: meta.holderCount ?? snap.holder_count,
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
      method: meta.method, snapshotId: snap.id, snapshotAt, holderCount: result.holderCount,
      eligible: meta.eligible, strata: meta.strata, supplyDistribution,
      analyzed: result.analyzed, resolved,
    };
    // The stored sample size (the leaderboard's sampleSize and its minSample filter)
    // is the number of wallets the distribution rests on, not those merely settled
    await require('./database').upsertConviction(mint, distribution, sample.length, resolved, convictionMeta)
      .catch(err => console.error(`[Holders] Conviction persist failed for ${mint.slice(0, 8)}:`, err.message));
  }
  if (dispatch && now - snapshotAt > CONFIG.staleSnapshotMs) {
    // A snapshot the pre-check recently confirmed is not stale, however old its rows
    if (now - await snapshotFreshAt(mint, snap) > CONFIG.staleSnapshotMs) await ensureSnapshot(mint);
  }
  return result;
}

/**
 * Hold times (ms) for specific wallets. computed=false while any of them is still
 * waiting for its backfill, or before the first snapshot exists.
 */
async function getHoldTimes(mint, wallets) {
  const holdTimes = {};
  const floors = [];
  if (!wallets || wallets.length === 0) return { holdTimes, floors, computed: true };
  const snap = await store.getLatestSnapshot(mint);
  if (!snap) {
    await ensureSnapshot(mint);
    return { holdTimes, floors, computed: false };
  }
  const now = Date.now();
  const positions = await store.getPositions(mint, wallets);
  // LP wallets are never backfilled (walletsOfInterest), so never wait on them
  const lp = new Set(snap.sample_meta?.lpWallets || []);
  // Wallets with no position row yet: the holder list came from RPC before the
  // first snapshot, or the snapshot in progress will carry them. Wait for it.
  const snapshotInFlight = !!(await cache.get(keys.snapshotPending(mint)).catch(() => null));
  let pending = 0;
  for (const w of wallets) {
    const pos = positions.get(w);
    if (!pos) { if (snapshotInFlight && !lp.has(w)) pending++; continue; }
    if (pos.acquired_source === 'pending') { if (!lp.has(w)) pending++; continue; }
    const ms = holdTimeOf(pos, now);
    if (ms != null) {
      holdTimes[w] = ms;
      // History read stopped before the streak start: the wallet has held at least this long
      if (pos.acquired_source === 'backfill_capped') floors.push(w);
    }
  }
  if (pending > 0) await ensureBackfill(mint);
  return { holdTimes, floors, computed: pending === 0 };
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
  if (Date.now() - await snapshotFreshAt(mint, snap) > maxAgeMs) return null;
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
  isRefreshDue,
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
  partialReady,
  isProgramOwned,
};
