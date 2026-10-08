/**
 * Holder snapshot math: pure functions with no I/O, unit tested in
 * holderSnapshot.test.js. The I/O around them lives in holderPipeline.js.
 *
 * The pipeline in one paragraph: the worker pages through every token account
 * for a mint (DAS getTokenAccounts) and folds them into one row per owner
 * wallet. Each run is stored as a snapshot. A wallet's holding streak starts
 * when it first shows up with a positive balance; for wallets that appear
 * between two close, complete snapshots that moment is known from the
 * snapshots alone. Everyone else (wallets present in the very first snapshot,
 * or after a long gap) gets their streak start once, from their token account's
 * transfer history, by rewinding the balance until it reaches zero.
 */

const crypto = require('crypto');

// ── Holder aggregation ───────────────────────────────────────────────────────

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (value == null || value === '') return 0n;
  try {
    // DAS returns raw u64 amounts as numbers or strings; numbers above 2^53 have
    // already lost precision, but BigInt of a float string throws, so truncate.
    return BigInt(typeof value === 'number' ? Math.trunc(value) : String(value).split('.')[0]);
  } catch {
    return 0n;
  }
}

/**
 * Fold DAS token accounts into one entry per owner wallet, largest first.
 * The wallet's tokenAccount is its largest account (usually the ATA), which is
 * the account the transfer-history backfill reads.
 *
 * @param {Array<{owner, address, amount}>} accounts raw DAS token_accounts
 * @returns {Array<{wallet, tokenAccount, amount: bigint, rank}>}
 */
function aggregateHolders(accounts) {
  const byOwner = new Map();
  // Pages are numbered and read several at a time while accounts are being
  // created and closed, so an account can turn up on two pages. Count each once.
  const seenAccounts = new Set();
  for (const a of accounts || []) {
    if (!a || !a.owner) continue;
    if (a.address) {
      if (seenAccounts.has(a.address)) continue;
      seenAccounts.add(a.address);
    }
    const amount = toBigInt(a.amount);
    if (amount <= 0n) continue;
    const cur = byOwner.get(a.owner);
    if (!cur) {
      byOwner.set(a.owner, { wallet: a.owner, tokenAccount: a.address || null, amount, largest: amount });
    } else {
      cur.amount += amount;
      if (amount > cur.largest) { cur.largest = amount; cur.tokenAccount = a.address || cur.tokenAccount; }
    }
  }
  const holders = [...byOwner.values()]
    .sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : (x.wallet < y.wallet ? -1 : 1)));
  return holders.map((h, i) => ({ wallet: h.wallet, tokenAccount: h.tokenAccount, amount: h.amount, rank: i + 1 }));
}

// ── Acquisition from consecutive snapshots ───────────────────────────────────

// A wallet that first shows up in a snapshot bought somewhere between the previous
// snapshot and this one. We record this snapshot's time (a slight undercount of hold
// time, never an overcount) as long as the window is narrow compared with the
// smallest diamond-hands bucket (6h). Wider windows fall back to the backfill.
const MAX_SNAPSHOT_GAP_MS = 6 * 3_600_000;

/**
 * Decide what a wallet that is new in this snapshot gets as its acquisition time.
 * This is the same for every new wallet in a snapshot, so it is decided once.
 *
 * "New" means "not in holder_positions", and positions mirror the previous snapshot
 * only when that snapshot was complete. After a capped (incomplete) snapshot a
 * wallet can be missing simply because it sat beyond the page cap.
 *
 * @param {{takenAt: number, complete: boolean}|null} prev the previous snapshot
 * @param {number} takenAt this snapshot's time (ms)
 * @returns {{acquiredAt: number|null, source: 'snapshot'|'pending'}}
 */
function newWalletAcquisition(prev, takenAt, maxGapMs = MAX_SNAPSHOT_GAP_MS) {
  if (prev && prev.complete && takenAt - prev.takenAt <= maxGapMs && takenAt >= prev.takenAt) {
    return { acquiredAt: takenAt, source: 'snapshot' };
  }
  return { acquiredAt: null, source: 'pending' };
}

// ── Representative sampling ──────────────────────────────────────────────────

const SAMPLE_METHOD = 'stratified-v1';

const DEFAULT_SAMPLE_OPTS = {
  size: 250,        // total wallets to measure
  topCount: 50,     // largest holders, always measured (they hold most of the supply)
  midShare: 0.10,   // the "mid" stratum runs from rank topCount+1 to the top 10% of holders
  dustShare: 1e-7,  // balances below 0.00001% of held supply are dust, not holders
};

// Stable pseudo-random key per (mint, wallet). Taking the k lowest keys from a
// population is a uniform random sample of it ("bottom-k" sampling), and because
// the key never changes, a wallet that stays in the population stays in the sample.
// That keeps the sample representative while avoiding re-measuring new wallets
// every run.
function sampleKey(mint, wallet) {
  return crypto.createHash('sha256').update(`${mint}:${wallet}`).digest('hex').slice(0, 13);
}

function bottomK(mint, holders, k) {
  if (k >= holders.length) return holders.slice();
  return holders
    .map(h => ({ h, key: sampleKey(mint, h.wallet) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, k)
    .map(x => x.h);
}

/**
 * Draw the conviction sample from a full holder list.
 *
 * Three strata by balance rank among eligible holders (LP, burn and dust removed):
 *   top  – the largest `topCount` holders, all measured;
 *   mid  – the rest of the top `midShare` of holders, random sample;
 *   tail – everyone else, random sample.
 * The random budget (size - top) is split evenly between mid and tail, and any
 * share a stratum can't use goes to the other. Each wallet carries its stratum, so
 * the distribution can be weighted back to the whole population.
 *
 * @param {string} mint
 * @param {Array<{wallet, amount: bigint, rank, tokenAccount}>} holders sorted desc
 * @param {{exclude?: Set<string>}} opts plus any DEFAULT_SAMPLE_OPTS override
 */
function selectSample(mint, holders, opts = {}) {
  const { size, topCount, midShare, dustShare } = { ...DEFAULT_SAMPLE_OPTS, ...opts };
  const exclude = opts.exclude || new Set();

  const candidates = (holders || []).filter(h => !exclude.has(h.wallet) && h.amount > 0n);
  const heldTotal = candidates.reduce((s, h) => s + h.amount, 0n);
  // amount < heldTotal * dustShare, in integer math: amount * 1e7 < heldTotal for 1e-7
  const dustDen = BigInt(Math.round(1 / dustShare));
  const eligible = candidates.filter(h => h.amount * dustDen >= heldTotal);

  const top = eligible.slice(0, topCount);
  const midEnd = Math.max(top.length, Math.ceil(eligible.length * midShare));
  const midPop = eligible.slice(top.length, midEnd);
  const tailPop = eligible.slice(midEnd);

  const budget = Math.max(0, size - top.length);
  let midK = Math.min(midPop.length, Math.ceil(budget / 2));
  let tailK = Math.min(tailPop.length, budget - midK);
  midK = Math.min(midPop.length, budget - tailK); // hand tail's unused share back to mid

  const sumAmount = list => list.reduce((s, h) => s + h.amount, 0n);
  const strata = {
    top:  { population: top.length,     amount: sumAmount(top).toString(),     sampled: top.length },
    mid:  { population: midPop.length,  amount: sumAmount(midPop).toString(),  sampled: midK },
    tail: { population: tailPop.length, amount: sumAmount(tailPop).toString(), sampled: tailK },
  };

  const pick = (list, stratum) => list.map(h => ({
    wallet: h.wallet, tokenAccount: h.tokenAccount || null, rank: h.rank, amount: h.amount.toString(), stratum,
  }));
  const sample = [
    ...pick(top, 'top'),
    ...pick(bottomK(mint, midPop, midK), 'mid'),
    ...pick(bottomK(mint, tailPop, tailK), 'tail'),
  ];

  return {
    sample,
    meta: {
      method: SAMPLE_METHOD,
      size: sample.length,
      eligible: eligible.length,
      excluded: (holders || []).length - candidates.length,
      dust: candidates.length - eligible.length,
      strata,
    },
  };
}

// ── Transfer-history backfill ────────────────────────────────────────────────

// Parse a decimal UI amount ("12.5", 12.5, 1e-6) into raw units without float drift.
function uiToRaw(value, decimals) {
  if (value == null) return 0n;
  let s = typeof value === 'number' ? value.toFixed(Math.min(decimals, 20)) : String(value).trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '-') return 0n;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [whole, frac = ''] = s.split('.');
  const raw = BigInt((whole || '0') + frac.padEnd(decimals, '0').slice(0, decimals));
  return neg ? -raw : raw;
}

/**
 * Net change in raw units to one token account in one Helius-parsed transaction.
 * Prefers accountData[].tokenBalanceChanges (exact raw amounts); falls back to
 * tokenTransfers (UI amounts). Failed transactions move nothing.
 */
function tokenAccountDelta(tx, tokenAccount, mint, decimals) {
  if (!tx || tx.transactionError) return 0n;
  let found = false;
  let delta = 0n;
  for (const ad of tx.accountData || []) {
    for (const c of ad.tokenBalanceChanges || []) {
      if (c.tokenAccount !== tokenAccount || (c.mint && c.mint !== mint)) continue;
      found = true;
      delta += toBigIntSigned(c.rawTokenAmount?.tokenAmount);
    }
  }
  if (found) return delta;
  for (const t of tx.tokenTransfers || []) {
    if (t.mint && t.mint !== mint) continue;
    const raw = uiToRaw(t.tokenAmount, decimals);
    if (t.toTokenAccount === tokenAccount) delta += raw;
    if (t.fromTokenAccount === tokenAccount) delta -= raw;
  }
  return delta;
}

/**
 * Net change in raw units to one token account in a standard-RPC-shaped
 * transaction (getTransaction / getTransactionsForAddress "full"): the
 * difference between meta.postTokenBalances and meta.preTokenBalances for the
 * account's index. Failed transactions move nothing. Works for "json" (string
 * keys plus meta.loadedAddresses) and "jsonParsed" ({pubkey} keys) encodings.
 */
function metaTokenAccountDelta(tx, tokenAccount, mint) {
  const meta = tx?.meta;
  if (!tx || !meta || meta.err) return 0n;
  const keys = (tx.transaction?.message?.accountKeys || []).map(k => (typeof k === 'string' ? k : k?.pubkey || ''));
  const loaded = meta.loadedAddresses;
  if (loaded) keys.push(...(loaded.writable || []), ...(loaded.readonly || []));
  const idx = keys.indexOf(tokenAccount);
  if (idx < 0) return 0n;
  const pick = list => {
    for (const b of list || []) {
      if (b && b.accountIndex === idx && (!b.mint || !mint || b.mint === mint)) return toBigIntSigned(b.uiTokenAmount?.amount);
    }
    return null;
  };
  const pre = pick(meta.preTokenBalances);
  const post = pick(meta.postTokenBalances);
  if (pre == null && post == null) return 0n;
  // A missing side means the account was created (pre) or closed (post) in this transaction.
  return (post ?? 0n) - (pre ?? 0n);
}

/**
 * A cheap fingerprint of a holder list: supply plus every (account, amount)
 * pair, order-independent. Two snapshots with the same fingerprint over the
 * same accounts saw no balance change among them.
 */
function holderFingerprint(supply, accounts) {
  const h = crypto.createHash('sha256');
  h.update(String(supply ?? ''));
  const pairs = (accounts || []).map(a => `${a.address || a.owner}:${toBigInt(a.amount)}`).sort();
  for (const p of pairs) h.update(p).update('\n');
  return `${pairs.length}:${h.digest('hex').slice(0, 32)}`;
}

function toBigIntSigned(v) {
  if (v == null) return 0n;
  try { return BigInt(String(v).split('.')[0]); } catch { return 0n; }
}

/**
 * Rewind a token account's balance through its history (newest first) to find
 * when the current holding streak began: the transaction that took the balance
 * from zero (or below) to positive.
 *
 * Resumable: pass the returned `balance` back in with the next, older page.
 *
 * @param {bigint} balance balance after the newest transaction in `txs`
 * @param {Array<{timestamp: number, delta: bigint}>} txs newest first, timestamp in seconds
 * @param {{exhausted: boolean}} opts exhausted = no older history exists
 * @returns {{done: boolean, acquiredAt: number|null, balance: bigint, oldestAt: number|null}}
 *   acquiredAt in ms. When the history runs out without the balance reaching zero
 *   (transfers we couldn't see), the oldest transaction is the best estimate.
 */
function rewindToStreakStart(balance, txs, { exhausted = false } = {}) {
  let bal = balance;
  let oldestAt = null;
  for (const tx of txs) {
    if (!tx) continue;
    // A transaction with no block time still moved the balance; only the
    // timestamp bookkeeping is skipped for it.
    const at = tx.timestamp ? tx.timestamp * 1000 : null;
    if (at) oldestAt = at;
    const before = bal - (tx.delta || 0n);
    if (before <= 0n && (tx.delta || 0n) > 0n) {
      // The streak started here. Without a block time, the newest timed
      // transaction after it is the closest date (null: the caller falls back
      // to one from a newer page, or gives up); reading on would reach into
      // the previous streak.
      return { done: true, acquiredAt: at || oldestAt, balance: before, oldestAt };
    }
    bal = before;
  }
  if (exhausted) return { done: true, acquiredAt: oldestAt, balance: bal, oldestAt };
  return { done: false, acquiredAt: null, balance: bal, oldestAt };
}

module.exports = {
  MAX_SNAPSHOT_GAP_MS,
  SAMPLE_METHOD,
  DEFAULT_SAMPLE_OPTS,
  toBigInt,
  aggregateHolders,
  newWalletAcquisition,
  sampleKey,
  selectSample,
  uiToRaw,
  tokenAccountDelta,
  metaTokenAccountDelta,
  holderFingerprint,
  rewindToStreakStart,
};
