/**
 * New Pairs top-50 holder tier: the only part of the finder that spends Helius
 * credits on purpose. It checks who holds the tokens at the top of the list (the
 * shortlist, 50 by default) and nothing else.
 *
 * One check (about 4 credits for a token with under 10,000 token accounts):
 *   1. solana.getHolderBalances: every wallet's balance, 1 credit per 10,000 accounts
 *      plus 1 for the mint account. Capped at 30 pages; past that the sample is
 *      stored as incomplete and not used for the score.
 *   2. getTokenSupply (1 credit).
 *   3. The largest 100 wallets, minus burn wallets, LP programs and authorities
 *      (constants.js) and the launchpads' own vault authorities (newPairLaunchpads.js).
 *   4. One getMultipleAccounts over those wallets (1 credit): every program-owned
 *      one is dropped. That removes bonding curves, pools, lockers and
 *      vesting vaults without a list of them.
 *   5. The top 50 that remain give the shares; compared with the previous sample they
 *      give retention, new entrants and whale exits.
 *
 * Budget: every credit goes to newpair_credit_days under 'newpairs:holders', and a
 * check only starts while the day's total is under NEWPAIRS_HELIUS_DAILY_CREDITS minus
 * a reserve kept for discovery's fallback. Calls run one token at a time through the
 * shared 'helius' limiter, so the curated pipeline sees at most a handful of extra
 * single-credit requests a minute. Nothing here is reachable from a visitor's request.
 *
 * Separate tables from holder_snapshots on purpose: that pipeline upserts every holder
 * and queues the paid hold-time backfill for any mint it sees.
 */

const db = require('./database');
const store = require('./newPairStore');
const holderCounts = require('./holderCounts');
const { BURN_WALLETS, LP_PROGRAMS, LP_AUTHORITIES, SYSTEM_PROGRAM_ID } = require('../constants');
const { VAULT_AUTHORITIES } = require('./newPairLaunchpads');
const settings = require('./newPairSettings');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CREDIT_SOURCE = 'newpairs:holders';
const TOP_N = 50;
const KEEP_N = 100;                 // wallets stored per sample: the top 50 plus the ranks just below
const CANDIDATES = 100;             // largest wallets looked at before exclusions (one owner lookup)
const MAX_PAGES = 30;               // 300,000 token accounts
const FIXED_CREDITS = 3;            // mint account + supply + one owner lookup
const DISCOVERY_RESERVE = 600;      // credits a day left for newpairs:discover's fallback
const EARLY_MS = 3 * DAY;
const EARLY_EVERY_MS = 6 * HOUR;    // a token's first 3 days
const LATE_EVERY_MS = 12 * HOUR;
const RETENTION_GAP_MS = [3 * HOUR, 48 * HOUR];
const EQUAL_BAG_SPREAD = 1.02;      // five of the top ten within 2% of each other
const EQUAL_BAG_COUNT = 5;

const STATIC_EXCLUDE = new Set([...BURN_WALLETS, ...LP_PROGRAMS, ...LP_AUTHORITIES, ...VAULT_AUTHORITIES]);
const pct = (part, whole) => (whole > 0n ? Number((part * 1_000_000n) / whole) / 10_000 : null);
const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));

/** The largest `n` wallets of a balance map, biggest first. */
function largest(balances, n) {
  const all = [];
  for (const [wallet, amount] of balances) all.push({ wallet, amount });
  all.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : a.wallet < b.wallet ? -1 : 1));
  return all.slice(0, n);
}

/** Five or more of the top ten holding near-identical bags: the v1 sign of a bundled launch. */
function hasEqualBags(top) {
  const amounts = top.slice(0, 10).map(h => Number(h.amount)).filter(a => a > 0).sort((a, b) => a - b);
  for (let i = 0; i + EQUAL_BAG_COUNT <= amounts.length; i++) {
    if (amounts[i + EQUAL_BAG_COUNT - 1] <= amounts[i] * EQUAL_BAG_SPREAD) return true;
  }
  return false;
}

/**
 * What changed since the previous sample.
 * retention12: of the previous top 50, the share still holding at least half of what
 * they held, averaged by headcount and by balance, then expressed per 12 hours so
 * samples 6 and 12 hours apart compare. null when the gap is under 3h or over 48h.
 */
function compareSamples({ top, balances, prev, takenAt }) {
  if (!prev || !prev.entries?.length) return { retention12: null, newIn: null, exits: null };
  const prevTop = prev.entries.slice(0, TOP_N);
  const prevAll = new Map(prev.entries.map(e => [e.wallet, big(e.amount)]));
  let kept = 0; let keptBalance = 0n; let total = 0n;
  for (const e of prevTop) {
    const before = big(e.amount);
    total += before;
    if ((balances.get(e.wallet) || 0n) * 2n >= before) { kept++; keptBalance += before; }
  }
  const raw = (kept / prevTop.length + (total > 0n ? Number((keptBalance * 1_000_000n) / total) / 1_000_000 : 0)) / 2;
  const gap = takenAt - prev.takenAt;
  const retention12 = gap >= RETENTION_GAP_MS[0] && gap <= RETENTION_GAP_MS[1] ? Math.pow(raw, (12 * HOUR) / gap) : null;
  // New: in the top 50 now, and last time absent from the stored ranks or under a tenth of today's bag
  const newIn = top.filter(h => (prevAll.get(h.wallet) || 0n) * 10n < h.amount).length;
  // Exit: a previous top-10 wallet that no longer holds enough to be in the top 50
  const floor = top.length >= TOP_N ? top[top.length - 1].amount : 0n;
  const exits = prevTop.slice(0, 10).filter(e => { const now = balances.get(e.wallet) || 0n; return now === 0n || now < floor; }).length;
  return { retention12, newIn, exits };
}

/**
 * Turn one full balance map into a sample. Pure.
 * @param {Map<string,bigint>} balances   every wallet's balance
 * @param {Set<string>} programOwned      wallets found to be program-owned accounts
 */
function summarize({ balances, supplyRaw, decimals, priceUsd, devWallet, programOwned = new Set(), prev = null, takenAt }) {
  const exclude = new Set([...STATIC_EXCLUDE, ...programOwned]);
  let burned = 0n;
  for (const w of BURN_WALLETS) burned += balances.get(w) || 0n;
  // Shares are of supply less burned. Pool and vault balances stay in the denominator:
  // they are real supply, just not a holder.
  const supply = big(supplyRaw) - burned;
  const kept = largest(balances, CANDIDATES).filter(h => !exclude.has(h.wallet)).slice(0, KEEP_N);
  const top = kept.slice(0, TOP_N);
  const sum = (list) => list.reduce((s, h) => s + h.amount, 0n);
  const dustRaw = holderCounts.dustThresholdRaw({ priceUsd, decimals, supplyRaw: supply });
  const holders = (function* () { for (const [wallet, amount] of balances) yield { wallet, amount }; })();
  const counts = holderCounts.countHolders(holders, { exclude, dustRaw });
  const devBalance = devWallet && !exclude.has(devWallet) ? balances.get(devWallet) || 0n : null;
  return {
    takenAt,
    holderCount: counts.holders,
    dustCount: counts.dust,
    top1: top.length ? pct(top[0].amount, supply) : null,
    top10: top.length ? pct(sum(top.slice(0, 10)), supply) : null,
    top50: top.length ? pct(sum(top), supply) : null,
    devPct: devBalance == null ? null : pct(devBalance, supply),
    equalBags: hasEqualBags(top),
    ...compareSamples({ top, balances, prev, takenAt }),
    entries: kept.map((h, i) => ({ rank: i + 1, wallet: h.wallet, amount: h.amount })),
  };
}

/** The sample as newPairScore.buildFeatures wants it. */
function toScoreSample(row) {
  const n = (v) => (v == null ? null : Number(v));
  return {
    takenAt: new Date(row.taken_at).getTime(),
    top1: n(row.top1_pct), top10: n(row.top10_pct), top50: n(row.top50_pct), devPct: n(row.dev_pct),
    dustShare: row.holder_count > 0 && row.dust_count != null ? row.dust_count / row.holder_count : null,
    retention12: n(row.retention12), equalBags: !!row.equal_bags,
  };
}

/** Whether a shortlisted token is due a check. */
function isDue({ graduatedAt, lastSampleAt }, now) {
  if (lastSampleAt == null) return true;
  return now - lastSampleAt >= (now - graduatedAt < EARLY_MS ? EARLY_EVERY_MS : LATE_EVERY_MS);
}

/** Never-checked tokens first (best score first), then the longest-waiting. */
function prioritize(tokens, now) {
  return tokens.filter(t => isDue(t, now)).sort((a, b) => {
    if ((a.lastSampleAt == null) !== (b.lastSampleAt == null)) return a.lastSampleAt == null ? -1 : 1;
    if (a.lastSampleAt == null) return b.score - a.score;
    return a.lastSampleAt - b.lastSampleAt;
  });
}

const pool = () => { if (!db.pool) throw new Error('Database not available'); return db.pool; };

/** Latest complete sample per token, for scoring. @returns {Promise<Map<tokenId, sample>>} */
async function loadLatestSamples(tokenIds) {
  if (!tokenIds.length) return new Map();
  await store.ensureSchema();
  const { rows } = await pool().query(
    `SELECT DISTINCT ON (token_id) * FROM newpair_holder_samples
     WHERE token_id = ANY($1) AND complete ORDER BY token_id, taken_at DESC`, [tokenIds]);
  return new Map(rows.map(r => [r.token_id, toScoreSample(r)]));
}

async function loadPrevious(tokenId) {
  const { rows } = await pool().query(
    `SELECT id, taken_at FROM newpair_holder_samples WHERE token_id = $1 AND complete ORDER BY taken_at DESC LIMIT 1`, [tokenId]);
  if (!rows[0]) return null;
  const entries = await pool().query('SELECT wallet, amount FROM newpair_holder_entries WHERE sample_id = $1 ORDER BY rank', [rows[0].id]);
  return { takenAt: new Date(rows[0].taken_at).getTime(), entries: entries.rows };
}

async function saveSample(tokenId, s, { accounts, pages, complete, credits }) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO newpair_holder_samples (token_id, taken_at, holder_count, dust_count, accounts, pages, complete,
         top1_pct, top10_pct, top50_pct, dev_pct, retention12, new_in, exits, equal_bags, credits)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [tokenId, s.takenAt, s.holderCount, s.dustCount, accounts, pages, complete, s.top1, s.top10, s.top50, s.devPct,
       s.retention12, s.newIn, s.exits, s.equalBags, credits]);
    await client.query(
      `INSERT INTO newpair_holder_entries (sample_id, rank, wallet, amount)
       SELECT $1, * FROM unnest($2::smallint[], $3::text[], $4::numeric[])`,
      [rows[0].id, s.entries.map(e => e.rank), s.entries.map(e => e.wallet), s.entries.map(e => e.amount.toString())]);
    // Wallet rows only for the newest two samples; older samples keep their header
    await client.query(
      `DELETE FROM newpair_holder_entries WHERE sample_id IN (
         SELECT id FROM newpair_holder_samples WHERE token_id = $1 ORDER BY taken_at DESC OFFSET 2)`, [tokenId]);
    // Score it again with the new sample on the next scoring pass
    await client.query('UPDATE newpair_tokens SET scored_at = NULL WHERE id = $1', [tokenId]);
    await client.query('COMMIT');
    return rows[0].id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function createHolders({
  solana = require('./solana'),
  heliusCredits = require('./heliusCredits'),
  now = () => Date.now(),
  env = process.env,
  log = console,
} = {}) {
  /** Credits the holder tier may still spend today. */
  async function creditsLeft() {
    // The admin panel can lower the day's figure; the env var is the ceiling (newPairSettings)
    const cap = await settings.dailyCap(env);
    return Math.max(0, cap - DISCOVERY_RESERVE) - await store.creditsSpentToday(now());
  }

  /** One token's check. Returns the stored sample's summary. Throws on a failed read. */
  async function checkToken(token) {
    let credits = 0;
    const spend = async (n) => { credits += n; await store.addCredits(CREDIT_SOURCE, n, now()); };
    return heliusCredits.withSource(CREDIT_SOURCE, async () => {
      // Recorded before each call: a call that fails may still have been billed
      await spend(2);
      const { balances, accounts, pages, complete } = await solana.getHolderBalances(token.mint, { maxPages: MAX_PAGES });
      if (pages > 1) await spend(pages - 1);
      await spend(1);
      const supplyInfo = await solana.getTokenSupply(token.mint);
      const supplyRaw = supplyInfo?.value?.amount;
      const decimals = supplyInfo?.value?.decimals;
      if (!supplyRaw || !/^\d+$/.test(String(supplyRaw))) throw new Error('getTokenSupply returned no amount');

      const candidates = largest(balances, CANDIDATES).map(h => h.wallet).filter(w => !STATIC_EXCLUDE.has(w));
      const programOwned = new Set();
      for (let i = 0; i < candidates.length; i += 100) {
        const batch = candidates.slice(i, i + 100);
        await spend(1);
        const res = await solana.getMultipleAccounts(batch);
        (res?.value || []).forEach((acct, j) => { if (acct && acct.owner && acct.owner !== SYSTEM_PROGRAM_ID) programOwned.add(batch[j]); });
      }
      const takenAt = now();
      const prev = await loadPrevious(token.id);
      const sample = summarize({ balances, supplyRaw, decimals, priceUsd: token.priceUsd, devWallet: token.devWallet, programOwned, prev, takenAt });
      await saveSample(token.id, sample, { accounts, pages, complete, credits });
      return { mint: token.mint, credits, complete, holderCount: sample.holderCount, top10: sample.top10, retention12: sample.retention12 };
    }).catch((error) => { error.credits = credits; throw error; });
  }

  /** The shortlist: the best-scoring listed tokens, with when each was last checked. */
  async function loadShortlist(size) {
    const { rows } = await pool().query(
      `SELECT t.id, t.mint_address, t.graduated_at, t.score, t.price_usd, t.dev_wallet,
         (SELECT MAX(taken_at) FROM newpair_holder_samples s WHERE s.token_id = t.id) AS last_sample_at
       FROM newpair_tokens t
       WHERE t.status = 'active' AND NOT t.rugged AND NOT t.hidden AND t.unlisted_reason IS NULL AND t.score IS NOT NULL
       ORDER BY t.score DESC, t.id LIMIT $1`, [size]);
    return rows.map(r => ({
      id: r.id, mint: r.mint_address, graduatedAt: new Date(r.graduated_at).getTime(), score: Number(r.score),
      priceUsd: r.price_usd, devWallet: r.dev_wallet, lastSampleAt: r.last_sample_at ? new Date(r.last_sample_at).getTime() : null,
    }));
  }

  /**
   * Check the shortlisted tokens that are due, best first, until the run's limits or
   * the day's budget stop it. Never throws.
   */
  async function run({ shortlistSize, maxChecks = 20, deadline = Infinity, dryRun = env.NEWPAIRS_HOLDERS_DRY_RUN === 'true' } = {}) {
    await store.ensureSchema();
    const tally = { shortlist: 0, due: 0, checked: 0, failed: 0, credits: 0, stopped: null, dryRun };
    if (shortlistSize == null) shortlistSize = (await settings.get(env)).shortlistSize;
    const shortlist = await loadShortlist(shortlistSize);
    const due = prioritize(shortlist, now());
    tally.shortlist = shortlist.length;
    tally.due = due.length;
    if (dryRun) {
      const left = await creditsLeft();
      log.log(`[NewPairs] holders dry run: would check ${Math.min(due.length, maxChecks)} of ${due.length} due (about ${FIXED_CREDITS + 1} credits each, ${left} left today): ${due.slice(0, maxChecks).map(t => t.mint.slice(0, 6)).join(' ')}`);
      return tally;
    }
    let failuresInARow = 0;
    for (const token of due.slice(0, maxChecks)) {
      if (now() > deadline) { tally.stopped = 'time budget'; break; }
      // Room for a 30-page token, so a check never starts that could cross the cap
      if (await creditsLeft() < FIXED_CREDITS + MAX_PAGES) { tally.stopped = 'daily credit budget'; break; }
      try {
        const r = await checkToken(token);
        tally.checked++;
        tally.credits += r.credits;
        failuresInARow = 0;
      } catch (error) {
        tally.failed++;
        tally.credits += error.credits || 0;
        log.warn(`[NewPairs] holder check failed for ${token.mint.slice(0, 8)}: ${String(error.message).slice(0, 120)}`);
        // Helius is having trouble: stop instead of burning credits on failures
        if (++failuresInARow >= 3) { tally.stopped = 'three failures in a row'; break; }
      }
    }
    return tally;
  }

  return { run, checkToken, creditsLeft };
}

let shared = null;
module.exports = {
  run: (o) => (shared || (shared = createHolders())).run(o),
  createHolders, summarize, compareSamples, hasEqualBags, largest, isDue, prioritize, toScoreSample, loadLatestSamples,
  CREDIT_SOURCE, DISCOVERY_RESERVE, TOP_N, KEEP_N,
};
