/**
 * New Pairs discovery: find every token that graduated from a launchpad's bonding
 * curve to a real pool, by reading the transactions of one marker account per
 * detector (newPairLaunchpads.js) and matching the migration instruction
 * (newPairDetectors.js). Runs in the worker every 5 minutes (newpairs-discover).
 *
 * Two ways to read a marker's transactions:
 *
 *   free    getSignaturesForAddress + getTransaction on public RPCs (freeRpc.js).
 *           No credits. The normal path once a detector is caught up.
 *   helius  getTransactionsForAddress, oldest first from the cursor. 10 credits per
 *           100 transactions and never less than 10 per call. Used for the first
 *           14-day backfill (about 4,700 credits, once), to catch up after the worker
 *           was down longer than public RPCs reliably keep history, and as the
 *           fallback when the free path fails.
 *
 * Because a Helius call costs 10 credits even when it returns one transaction, the
 * fallback does not poll every run: each detector waits until about 80 transactions
 * are due (fallbackIntervalMs), which keeps a whole day of fallback near 500 credits
 * instead of the 8,600 that polling three markers every 5 minutes would cost.
 *
 * Every credit is written to newpair_credit_days under 'newpairs:discover' and the
 * feature's daily cap (NEWPAIRS_HELIUS_DAILY_CREDITS, default 10,000, shared with the
 * later holder tier) is checked before each Helius page. Helius calls go through
 * solana.rpcCall, so they share the 'helius' limiter with the curated pipeline and
 * never bypass it; at most one page is in flight.
 *
 * The cursor is the newest transaction read with nothing unread before it. A run that
 * stops early (time, budget, an RPC error) resumes from there; re-reading the cursor's
 * own slot is harmless because inserts ignore a mint already stored.
 */

const { matchGraduation } = require('./newPairDetectors');
const { enabledDetectors } = require('./newPairLaunchpads');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const CREDIT_SOURCE = 'newpairs:discover';
const BACKFILL_MS = 14 * DAY;
// Public RPCs kept about 36h of history when measured (publicnode, 2026-11-11). Past
// 20h behind, a free run could silently start after a gap, so Helius catches up.
const FREE_MAX_LAG_MS = 20 * HOUR;
const FREE_FIRST_RUN_MS = 12 * HOUR;
const FREE_MAX_SIG_PAGES = 4;
const FREE_MAX_TX_PER_RUN = 400;
const FREE_TX_CONCURRENCY = 4;
const HELIUS_MAX_TX_PER_RUN = 3000;
const HELIUS_PAGE = 100;
const GTFA_MIN_CREDITS = 10;
const FALLBACK_TARGET_TXS = 80;

const intEnv = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Credits one getTransactionsForAddress page of `returned` full transactions costs. */
function gtfaCredits(returned) {
  return Math.max(GTFA_MIN_CREDITS, Math.ceil(returned / 100) * 10);
}

/** How long the paid fallback waits between calls for a detector (see the header). */
function fallbackIntervalMs(detector) {
  const perDay = Math.max(1, detector.txPerDay || 1);
  return Math.min(6 * HOUR, Math.max(15 * MIN, Math.round((FALLBACK_TARGET_TXS / perDay) * DAY)));
}

/**
 * Which path a detector's run starts on.
 * @returns {'free'|'helius'}
 */
function chooseSource({ mode = 'auto', state, now }) {
  if (mode === 'free' || mode === 'helius') return mode;
  if (state.cursorSlot == null) return 'helius'; // first run: 14-day backfill
  const readThrough = Math.max(state.cursorTime || 0, state.caughtUpAt || 0);
  return now - readThrough > FREE_MAX_LAG_MS ? 'helius' : 'free';
}

const cursorOf = (tx) => ({
  sig: tx.transaction?.signatures?.[0] || null,
  slot: tx.slot,
  time: tx.blockTime ? tx.blockTime * 1000 : null,
});

function createDiscovery({
  store = require('./newPairStore'),
  freeRpc = require('./freeRpc'),
  solana = require('./solana'),
  heliusCredits = require('./heliusCredits'),
  now = () => Date.now(),
  env = process.env,
  log = console,
} = {}) {
  // The admin panel can lower the day's figure; the env var is the ceiling (newPairSettings)
  const dailyCap = () => require('./newPairSettings').dailyCap(env);
  const mode = () => (['free', 'helius'].includes(env.NEWPAIRS_DISCOVERY_SOURCE) ? env.NEWPAIRS_DISCOVERY_SOURCE : 'auto');
  // Some transactions are version 1 and a page containing one is refused when the
  // caller supports only 0. Start at 1; drop to 0 for good if the endpoint rejects it.
  let heliusMaxVersion = 1;

  /** Match transactions (oldest first) and store what graduated. */
  async function absorb(detector, txs, tally) {
    const found = [];
    for (const tx of txs) {
      if (!tx || tx.meta?.err) continue;
      const hit = matchGraduation(detector, tx);
      if (!hit) continue;
      if (hit.unhandled) { tally.unhandled++; continue; }
      found.push(hit);
    }
    if (found.length) tally.found += await store.insertGraduations(detector.id, detector.label, found);
  }

  async function fetchFreeTransaction(signature) {
    const get = (version) => freeRpc.call('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: version }]);
    let tx;
    try {
      tx = await get(0);
    } catch (error) {
      if (error.rpcCode !== -32015) throw error; // -32015: transaction version not supported
      tx = await get(1);
    }
    // null = this endpoint no longer has (or never had) the transaction: not a result
    if (!tx) throw new Error('transaction not available on the free RPC');
    return tx;
  }

  async function runFree(detector, state, deadline, tally) {
    // Newest first, back to the cursor
    const pending = [];
    let before;
    let reachedCursor = false;
    for (let page = 0; page < FREE_MAX_SIG_PAGES && !reachedCursor; page++) {
      const opts = { limit: 1000 };
      if (before) opts.before = before;
      if (state.cursorSig) opts.until = state.cursorSig;
      const sigs = await freeRpc.call('getSignaturesForAddress', [detector.marker, opts]);
      if (!Array.isArray(sigs)) throw new Error('unexpected getSignaturesForAddress response');
      for (const s of sigs) {
        // `until` is ignored by an endpoint that has pruned the cursor signature, so
        // the slot is the real stop
        if (s.signature === state.cursorSig || (state.cursorSlot != null && s.slot < state.cursorSlot)) { reachedCursor = true; break; }
        // No cursor (free-only mode, first run): no backfill, only what a public RPC
        // certainly still has
        if (state.cursorSlot == null && (!s.blockTime || s.blockTime * 1000 < now() - FREE_FIRST_RUN_MS)) { reachedCursor = true; break; }
        pending.push(s);
      }
      if (sigs.length < 1000) reachedCursor = true;
      else before = sigs[sigs.length - 1].signature;
    }
    if (!reachedCursor) throw new Error(`more than ${FREE_MAX_SIG_PAGES * 1000} transactions behind`);

    pending.reverse(); // oldest first
    const todo = pending.slice(0, FREE_MAX_TX_PER_RUN);
    let cursor = null;
    let stopped = todo.length < pending.length;
    for (let i = 0; i < todo.length; i += FREE_TX_CONCURRENCY) {
      if (now() > deadline) { stopped = true; break; }
      const batch = todo.slice(i, i + FREE_TX_CONCURRENCY);
      // Failed transactions touch the marker too; they can't be a graduation
      const results = await Promise.allSettled(batch.map(s => (s.err ? null : fetchFreeTransaction(s.signature))));
      const txs = [];
      let failure = null;
      for (let j = 0; j < batch.length; j++) {
        if (results[j].status === 'rejected') { failure = results[j].reason; break; }
        if (results[j].value) txs.push(results[j].value);
        cursor = { sig: batch[j].signature, slot: batch[j].slot, time: batch[j].blockTime ? batch[j].blockTime * 1000 : null };
      }
      await absorb(detector, txs, tally);
      tally.read += txs.length;
      if (failure) {
        // Keep what was read in order before the failure, then report it
        if (cursor) tally.cursor = cursor;
        throw failure;
      }
    }
    if (cursor) tally.cursor = cursor;
    if (!stopped) tally.caughtUpAt = now();
  }

  async function heliusPage(detector, filters, paginationToken) {
    const call = (version) => solana.getAccountTransactionsPage(detector.marker, {
      limit: HELIUS_PAGE, sortOrder: 'asc', filters, paginationToken, maxSupportedTransactionVersion: version,
    });
    try {
      return await call(heliusMaxVersion);
    } catch (error) {
      if (heliusMaxVersion === 0 || error.rpcCode !== -32602) throw error; // -32602: invalid params
      heliusMaxVersion = 0;
      return call(0);
    }
  }

  async function runHelius(detector, state, deadline, tally) {
    if (!solana.isTransactionHistoryAvailable()) throw new Error('Helius transaction history not available');
    tally.usedHelius = true;
    const filters = state.cursorSlot != null
      ? { slot: { gte: state.cursorSlot } }
      : { blockTime: { gte: Math.floor((now() - BACKFILL_MS) / 1000) } };
    let token;
    let read = 0;
    for (;;) {
      if (now() > deadline || read >= HELIUS_MAX_TX_PER_RUN) return;
      const spent = await store.creditsSpentToday(now());
      const cap = await dailyCap();
      if (spent + GTFA_MIN_CREDITS > cap) {
        tally.capped = true;
        throw new Error(`daily Helius cap reached (${spent} of ${cap} credits)`);
      }
      let page;
      try {
        page = await heliusCredits.withSource(CREDIT_SOURCE, () => heliusPage(detector, filters, token));
      } catch (error) {
        // A refused or failed call may still have been billed: count the minimum
        await store.addCredits(CREDIT_SOURCE, GTFA_MIN_CREDITS, now());
        tally.credits += GTFA_MIN_CREDITS;
        throw error;
      }
      const credits = gtfaCredits(page.txs.length);
      await store.addCredits(CREDIT_SOURCE, credits, now());
      tally.credits += credits;
      await absorb(detector, page.txs, tally);
      read += page.txs.length;
      tally.read += page.txs.length;
      const last = page.txs[page.txs.length - 1];
      if (last && Number.isFinite(last.slot)) tally.cursor = cursorOf(last);
      token = page.paginationToken;
      if (!token || page.txs.length === 0) { tally.caughtUpAt = now(); return; }
    }
  }

  async function runDetector(detector, deadline) {
    const state = await store.getDetectorState(detector.id);
    const tally = { detector: detector.id, source: null, read: 0, found: 0, unhandled: 0, credits: 0, usedHelius: false, cursor: null, caughtUpAt: null, error: null };
    const fallbackDue = () => now() - (state.lastHeliusAt || 0) >= fallbackIntervalMs(detector);
    try {
      tally.source = chooseSource({ mode: mode(), state, now: now() });
      if (tally.source === 'free') {
        try {
          await runFree(detector, state, deadline, tally);
        } catch (error) {
          if (mode() !== 'auto' || !fallbackDue()) throw error;
          log.warn(`[NewPairs] ${detector.id}: free RPC failed (${error.message}); reading from Helius`);
          tally.source = 'helius';
          // Continue from wherever the free path got to
          const resume = tally.cursor ? { ...state, cursorSlot: tally.cursor.slot, cursorSig: tally.cursor.sig } : state;
          await runHelius(detector, resume, deadline, tally);
        }
      } else {
        await runHelius(detector, state, deadline, tally);
      }
    } catch (error) {
      tally.error = String(error?.message || error).slice(0, 200);
    }
    await store.saveDetectorRun(detector.id, {
      cursor: tally.cursor, caughtUpAt: tally.caughtUpAt, source: tally.source, usedHelius: tally.usedHelius,
      ok: !tally.error, error: tally.error, found: tally.found, unhandled: tally.unhandled, now: now(),
    });
    return tally;
  }

  /**
   * One discovery pass over every enabled detector. Never throws: each detector
   * reports its own error and the others still run.
   */
  async function run({ timeBudgetMs = 200_000 } = {}) {
    const detectors = enabledDetectors(env.NEWPAIRS_DETECTORS);
    if (detectors.length === 0) return { detectors: [] };
    const started = now();
    // Rotate who goes first so a slow detector can't starve the last one every run
    const offset = Math.floor(started / (5 * MIN)) % detectors.length;
    const ordered = [...detectors.slice(offset), ...detectors.slice(0, offset)];
    const results = [];
    for (let i = 0; i < ordered.length; i++) {
      // Each detector gets an equal share of what is left
      const deadline = now() + Math.max(0, started + timeBudgetMs - now()) / (ordered.length - i);
      try {
        results.push(await runDetector(ordered[i], deadline));
      } catch (error) {
        results.push({ detector: ordered[i].id, error: String(error?.message || error).slice(0, 200) });
      }
    }
    return { detectors: results, ms: now() - started };
  }

  return { run, runDetector };
}

let shared = null;
function run(options) {
  if (!shared) shared = createDiscovery();
  return shared.run(options);
}

module.exports = {
  run, createDiscovery, chooseSource, fallbackIntervalMs, gtfaCredits,
  CREDIT_SOURCE, FREE_MAX_LAG_MS, BACKFILL_MS,
};
