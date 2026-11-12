/**
 * New Pairs cheap tier: identity, market data and holder counts for discovered tokens,
 * from Jupiter's Tokens v2 batch search (100 mints a call, no key needed, no Helius).
 *
 *   fileNewTokens   (end of newpairs-discover, every 5 min) reads each newly found
 *                   token once and files it `active` (above both floors) or
 *                   `below_floor`.
 *   recheck         (newpairs-recheck, every 30 min) re-reads below-floor tokens at
 *                   +1h, +6h, +24h and +3d after graduation to catch late bloomers;
 *                   one still below the floors after the last look is deleted.
 *   refreshMarket   (newpairs-market, every 10 min) re-reads every active token,
 *                   updates its row and appends to its stored series (newpair_points:
 *                   hourly for the first 3 days, then every 3 hours).
 *   scoreActive     (same job, after the refresh) scores every token whose data
 *                   changed, with newPairScore.js.
 *
 * Status of a token: new → active | below_floor → active | (deleted).
 * An active token stays listed for its whole 14 days even if it later falls under the
 * floors (it is shown as rugged, see the plan's decisions); it is then re-read hourly
 * instead of every 10 minutes, which is what keeps a run to a few dozen calls.
 *
 * If Jupiter fails, refreshMarket falls back to DexScreener for price, market cap and
 * liquidity. DexScreener has no holder data, so holder_count and holders_at keep their
 * last values and the UI's age label shows them going stale.
 *
 * Names, symbols and logo URLs are whatever the token's creator wrote: stored trimmed,
 * never interpreted, and escaped where they are rendered.
 */

const axios = require('axios');
const db = require('./database');
const { httpsAgent } = require('./httpAgent');
const { rateLimitedRequest, sleep } = require('./rateLimiter');
const store = require('./newPairStore');
const { LAUNCHPAD_LABELS } = require('./newPairLaunchpads');
const { buildFeatures, scoreToken, authoritiesOpen } = require('./newPairScore');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const SETTINGS_KEY = 'newpairs_settings';
const DEFAULT_FLOORS = { minMcap: 25_000, minLiquidity: 5_000 };
// After graduation: when a below-floor token gets another look
const RECHECK_AT_MS = [HOUR, 6 * HOUR, DAY, 3 * DAY];
// A token Jupiter has never heard of an hour after graduating is filed below the floor
const UNKNOWN_GRACE_MS = HOUR;
const ACTIVE_REFRESH_MS = 9 * MIN;       // just under the job's 10 minutes
const RUGGED_REFRESH_MS = 55 * MIN;
const POINT_EARLY_MS = 3 * DAY;
const POINT_EARLY_EVERY_MS = 55 * MIN;   // hourly, with slack for job timing
const POINT_LATE_EVERY_MS = 175 * MIN;   // every 3 hours
const BATCH = 100;
const DEX_BATCH = 30;
const STAT_WINDOWS = ['5m', '1h', '6h', '24h'];
const STAT_FIELDS = ['priceChange', 'holderChange', 'liquidityChange', 'volumeChange', 'buyVolume', 'sellVolume',
  'buyOrganicVolume', 'sellOrganicVolume', 'numBuys', 'numSells', 'numTraders', 'numNetBuyers', 'numOrganicBuyers'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nonNeg = (v) => { const n = num(v); return n != null && n >= 0 ? n : null; };
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const address = (v) => (typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : null);
const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\/[^\s"'<>]{1,500}$/.test(v) ? v : null);

/** Floors from app_settings (admin-editable later), falling back to the defaults. */
function parseFloors(raw) {
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { /* bad JSON: defaults */ }
  const pick = (v, fallback) => { const n = num(v); return n != null && n >= 0 && n <= 1e9 ? n : fallback; };
  return { minMcap: pick(parsed.minMcap, DEFAULT_FLOORS.minMcap), minLiquidity: pick(parsed.minLiquidity, DEFAULT_FLOORS.minLiquidity) };
}

async function getFloors() {
  return parseFloors(await db.getSetting(SETTINGS_KEY).catch(() => null));
}

function aboveFloors(row, floors) {
  return (row.mcap ?? 0) >= floors.minMcap && (row.liquidity ?? 0) >= floors.minLiquidity;
}

/** One Jupiter Tokens v2 row → the columns we store. Unknown or malformed fields become null. */
function mapJupiter(token) {
  const stats = {};
  for (const w of STAT_WINDOWS) {
    const src = token[`stats${w}`];
    if (!src || typeof src !== 'object') continue;
    const out = {};
    for (const f of STAT_FIELDS) { const n = num(src[f]); if (n != null) out[f] = n; }
    if (Object.keys(out).length) stats[w] = out;
  }
  const a = token.audit && typeof token.audit === 'object' ? token.audit : {};
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  return {
    mint: address(token.id),
    name: text(token.name, 100),
    symbol: text(token.symbol, 32),
    logoUri: httpsUrl(token.icon),
    decimals: Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 18 ? token.decimals : null,
    jupLaunchpad: text(token.launchpad, 32),
    devWallet: address(token.dev),
    tokenProgram: address(token.tokenProgram),
    graduatedPool: address(token.graduatedPool),
    price: nonNeg(token.usdPrice),
    mcap: nonNeg(token.mcap) ?? nonNeg(token.fdv),
    liquidity: nonNeg(token.liquidity),
    holderCount: Number.isInteger(token.holderCount) && token.holderCount >= 0 ? token.holderCount : null,
    market: {
      stats,
      audit: {
        mintAuthorityDisabled: bool(a.mintAuthorityDisabled),
        freezeAuthorityDisabled: bool(a.freezeAuthorityDisabled),
        topHoldersPercentage: num(a.topHoldersPercentage),
        devBalancePercentage: num(a.devBalancePercentage),
        devMigrations: num(a.devMigrations),
        devMints: num(a.devMints),
      },
      organicScore: num(token.organicScore),
      circSupply: nonNeg(token.circSupply),
      totalSupply: nonNeg(token.totalSupply),
    },
  };
}

/**
 * DexScreener pairs → { mint: { price, mcap, liquidity, market } }, taking each mint's
 * deepest pool. No holder data.
 */
function mapDexScreener(pairs) {
  const best = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const mint = address(p?.baseToken?.address);
    if (!mint) continue;
    const liquidity = nonNeg(p.liquidity?.usd);
    const prev = best.get(mint);
    if (prev && (prev.liquidity ?? -1) >= (liquidity ?? -1)) continue;
    const stats = {};
    for (const [w, key] of [['5m', 'm5'], ['1h', 'h1'], ['6h', 'h6'], ['24h', 'h24']]) {
      const out = {};
      const change = num(p.priceChange?.[key]); if (change != null) out.priceChange = change;
      const volume = nonNeg(p.volume?.[key]); if (volume != null) out.volume = volume;
      const buys = nonNeg(p.txns?.[key]?.buys); if (buys != null) out.numBuys = buys;
      const sells = nonNeg(p.txns?.[key]?.sells); if (sells != null) out.numSells = sells;
      if (Object.keys(out).length) stats[w] = out;
    }
    const price = nonNeg(Number(p.priceUsd));
    best.set(mint, { mint, price, mcap: nonNeg(p.marketCap) ?? nonNeg(p.fdv), liquidity, market: { stats } });
  }
  return best;
}

/** When a below-floor token is next looked at, or null when its last look has passed. */
function nextRecheck(graduatedAt, now) {
  for (let step = 0; step < RECHECK_AT_MS.length; step++) {
    if (graduatedAt + RECHECK_AT_MS[step] > now) return { step, at: graduatedAt + RECHECK_AT_MS[step] };
  }
  return null;
}

function createMarket({
  jupiter = require('./jupiter'),
  fetchDexScreener = (mints) => rateLimitedRequest('dexScreener', () =>
    axios.get(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`, { timeout: 10000, httpsAgent })).then(r => r.data),
  now = () => Date.now(),
  // The keyless Jupiter tier was documented at 60 requests a minute: stay under it
  pauseMs = process.env.JUPITER_API_KEY ? 150 : 1100,
  pause = sleep,
  log = console,
} = {}) {
  const pool = () => { if (!db.pool) throw new Error('Database not available'); return db.pool; };

  async function readJupiter(mints) {
    return new Map((await jupiter.getTokensBatch(mints)).map(mapJupiter).filter(r => r.mint).map(r => [r.mint, r]));
  }

  /** Write Jupiter rows: identity, market, holders, peak. Returns nothing; rows are matched by mint. */
  async function writeJupiter(rows, at) {
    if (rows.length === 0) return;
    await pool().query(
      `UPDATE newpair_tokens t SET
         name = COALESCE(r.name, t.name), symbol = COALESCE(r.symbol, t.symbol), logo_uri = COALESCE(r."logoUri", t.logo_uri),
         decimals = COALESCE(r.decimals, t.decimals), jup_launchpad = COALESCE(r."jupLaunchpad", t.jup_launchpad),
         launchpad = COALESCE(r.label, t.launchpad),
         dev_wallet = COALESCE(r."devWallet", t.dev_wallet), token_program = COALESCE(r."tokenProgram", t.token_program),
         graduated_pool = COALESCE(r."graduatedPool", t.graduated_pool),
         price_usd = r.price, mcap = r.mcap, liquidity = r.liquidity,
         holder_count = COALESCE(r."holderCount", t.holder_count),
         holders_at = CASE WHEN r."holderCount" IS NOT NULL THEN to_timestamp($2 / 1000.0) ELSE t.holders_at END,
         peak_mcap = GREATEST(COALESCE(t.peak_mcap, 0), COALESCE(r.mcap, 0)),
         peak_mcap_at = CASE WHEN COALESCE(r.mcap, 0) > COALESCE(t.peak_mcap, 0) THEN to_timestamp($2 / 1000.0) ELSE t.peak_mcap_at END,
         market = r.market, market_at = to_timestamp($2 / 1000.0), market_source = 'jupiter'
       FROM jsonb_to_recordset($1::jsonb) AS r(mint text, name text, symbol text, "logoUri" text, decimals smallint,
         "jupLaunchpad" text, label text, "devWallet" text, "tokenProgram" text, "graduatedPool" text,
         price double precision, mcap double precision, liquidity double precision, "holderCount" integer, market jsonb)
       WHERE t.mint_address = r.mint`,
      [JSON.stringify(rows.map(r => ({ ...r, label: LAUNCHPAD_LABELS[r.jupLaunchpad]?.label || null }))), at]
    );
  }

  async function setStatus(mints, status, { at, nextRecheckOf } = {}) {
    if (mints.length === 0) return;
    if (status === 'active') {
      await pool().query(
        `UPDATE newpair_tokens SET status = 'active', active_at = COALESCE(active_at, to_timestamp($2 / 1000.0)),
           next_market_at = to_timestamp($3 / 1000.0), next_recheck_at = NULL
         WHERE mint_address = ANY($1)`, [mints, at, at + ACTIVE_REFRESH_MS]);
      return;
    }
    // below_floor: each token's own next look, by its graduation time
    const steps = mints.map(m => nextRecheckOf(m));
    const keep = mints.filter((m, i) => steps[i]);
    const drop = mints.filter((m, i) => !steps[i]);
    if (keep.length) {
      await pool().query(
        `UPDATE newpair_tokens t SET status = 'below_floor', recheck_step = r.step, next_recheck_at = to_timestamp(r.at / 1000.0)
         FROM unnest($1::text[], $2::smallint[], $3::double precision[]) AS r(mint, step, at) WHERE t.mint_address = r.mint`,
        [keep, keep.map(m => nextRecheckOf(m).step), keep.map(m => nextRecheckOf(m).at)]);
    }
    if (drop.length) await pool().query(`DELETE FROM newpair_tokens WHERE mint_address = ANY($1) AND status <> 'active'`, [drop]);
    return drop.length;
  }

  /** Read candidates (status new or below_floor) once and file them. */
  async function fileBatch(tokens, floors, tally) {
    const at = now();
    const seen = await readJupiter(tokens.map(t => t.mint_address));
    tally.calls++;
    await writeJupiter([...seen.values()], at);
    const graduated = new Map(tokens.map(t => [t.mint_address, new Date(t.graduated_at).getTime()]));
    const active = []; const below = [];
    for (const t of tokens) {
      const row = seen.get(t.mint_address);
      if (row && aboveFloors(row, floors)) active.push(t.mint_address);
      // Jupiter indexes a new token within minutes; until the grace passes, ask again next run
      else if (row || at - graduated.get(t.mint_address) > UNKNOWN_GRACE_MS || t.status === 'below_floor') below.push(t.mint_address);
      else tally.waiting++;
    }
    await setStatus(active, 'active', { at });
    tally.deleted += (await setStatus(below, 'below_floor', { nextRecheckOf: (m) => nextRecheck(graduated.get(m), at) })) || 0;
    tally.active += active.length;
    tally.below += below.length;
  }

  async function fileFrom(sql, params, { maxBatches }) {
    await store.ensureSchema();
    const tally = { calls: 0, active: 0, below: 0, deleted: 0, waiting: 0, error: null };
    const floors = await getFloors();
    const { rows } = await pool().query(sql, [...params, maxBatches * BATCH]);
    for (let i = 0; i < rows.length; i += BATCH) {
      if (i > 0) await pause(pauseMs);
      try {
        await fileBatch(rows.slice(i, i + BATCH), floors, tally);
      } catch (error) {
        // Jupiter down or throttling: stop, the same tokens are due again next run
        tally.error = String(error.response?.status || error.message).slice(0, 120);
        break;
      }
    }
    tally.below -= tally.deleted;
    return tally;
  }

  /** Newly discovered tokens: oldest graduations first so a backfill drains in order. */
  function fileNewTokens({ maxBatches = 20 } = {}) {
    return fileFrom(`SELECT mint_address, graduated_at, status FROM newpair_tokens WHERE status = 'new' ORDER BY graduated_at LIMIT $1`, [], { maxBatches });
  }

  /** Below-floor tokens whose next look is due. */
  function recheck({ maxBatches = 30 } = {}) {
    return fileFrom(
      `SELECT mint_address, graduated_at, status FROM newpair_tokens
       WHERE status = 'below_floor' AND next_recheck_at <= to_timestamp($1 / 1000.0) ORDER BY next_recheck_at LIMIT $2`,
      [now()], { maxBatches });
  }

  /** Append a point for the refreshed tokens whose series is due one. */
  async function appendPoints(mints, at) {
    const { rowCount } = await pool().query(
      `WITH due AS (
         UPDATE newpair_tokens SET last_point_at = to_timestamp($2 / 1000.0)
         WHERE mint_address = ANY($1) AND status = 'active' AND market_at = to_timestamp($2 / 1000.0)
           AND (last_point_at IS NULL OR last_point_at <= to_timestamp($2 / 1000.0) -
             CASE WHEN to_timestamp($2 / 1000.0) - graduated_at < $3 * INTERVAL '1 millisecond'
                  THEN $4 * INTERVAL '1 millisecond' ELSE $5 * INTERVAL '1 millisecond' END)
         RETURNING id, price_usd, mcap, liquidity, market_source,
           CASE WHEN market_source = 'jupiter' THEN holder_count END AS holder_count
       )
       INSERT INTO newpair_points (token_id, at, price_usd, mcap, liquidity, holder_count, source)
       SELECT id, to_timestamp($2 / 1000.0), price_usd, mcap, liquidity, holder_count, market_source FROM due
       ON CONFLICT (token_id, at) DO NOTHING`,
      [mints, at, POINT_EARLY_MS, POINT_EARLY_EVERY_MS, POINT_LATE_EVERY_MS]);
    return rowCount;
  }

  /** Price, market cap and liquidity only (DexScreener): holders are left as they were. */
  async function writeDexScreener(rows, at) {
    if (rows.length === 0) return;
    await pool().query(
      `UPDATE newpair_tokens t SET price_usd = r.price, mcap = r.mcap, liquidity = r.liquidity,
         peak_mcap = GREATEST(COALESCE(t.peak_mcap, 0), COALESCE(r.mcap, 0)),
         peak_mcap_at = CASE WHEN COALESCE(r.mcap, 0) > COALESCE(t.peak_mcap, 0) THEN to_timestamp($2 / 1000.0) ELSE t.peak_mcap_at END,
         market = COALESCE(t.market, '{}'::jsonb) || jsonb_build_object('dexStats', r.market->'stats'),
         market_at = to_timestamp($2 / 1000.0), market_source = 'dexscreener'
       FROM jsonb_to_recordset($1::jsonb) AS r(mint text, price double precision, mcap double precision, liquidity double precision, market jsonb)
       WHERE t.mint_address = r.mint`,
      [JSON.stringify(rows), at]);
  }

  async function schedule(rows, floors, at) {
    const live = rows.filter(r => aboveFloors(r, floors)).map(r => r.mint);
    const rugged = rows.filter(r => !aboveFloors(r, floors)).map(r => r.mint);
    for (const [mints, wait] of [[live, ACTIVE_REFRESH_MS], [rugged, RUGGED_REFRESH_MS]]) {
      if (mints.length) await pool().query(`UPDATE newpair_tokens SET next_market_at = to_timestamp($2 / 1000.0) WHERE mint_address = ANY($1)`, [mints, at + wait]);
    }
    return { live: live.length, rugged: rugged.length };
  }

  /** Re-read every active token that is due. */
  async function refreshMarket({ maxBatches = 80, deadline = Infinity } = {}) {
    await store.ensureSchema();
    const tally = { due: 0, refreshed: 0, live: 0, underFloor: 0, missing: 0, points: 0, jupiterCalls: 0, dexScreenerCalls: 0, source: 'jupiter', error: null };
    const floors = await getFloors();
    const { rows: due } = await pool().query(
      `SELECT mint_address FROM newpair_tokens WHERE status = 'active' AND (next_market_at IS NULL OR next_market_at <= to_timestamp($1 / 1000.0))
       ORDER BY next_market_at NULLS FIRST LIMIT $2`, [now(), maxBatches * BATCH]);
    tally.due = due.length;
    const mints = due.map(r => r.mint_address);
    let jupiterDown = false;
    for (let i = 0; i < mints.length; i += BATCH) {
      if (now() > deadline) { tally.error = 'time budget reached'; break; }
      if (i > 0) await pause(jupiterDown ? 0 : pauseMs);
      const batch = mints.slice(i, i + BATCH);
      const at = now();
      let rows = null;
      if (!jupiterDown) {
        try {
          rows = [...(await readJupiter(batch)).values()];
          tally.jupiterCalls++;
          await writeJupiter(rows, at);
        } catch (error) {
          jupiterDown = true;
          tally.source = 'dexscreener';
          log.warn(`[NewPairs] Jupiter batch failed (${error.response?.status || error.message}); using DexScreener for this run`);
        }
      }
      if (jupiterDown) {
        try {
          rows = [];
          for (let j = 0; j < batch.length; j += DEX_BATCH) {
            rows.push(...mapDexScreener(await fetchDexScreener(batch.slice(j, j + DEX_BATCH))).values());
            tally.dexScreenerCalls++;
          }
          await writeDexScreener(rows, at);
        } catch (error) {
          tally.error = `both sources failed: ${String(error.response?.status || error.message).slice(0, 80)}`;
          break;
        }
      }
      // A token neither source returned (delisted, not indexed): look again in an hour
      // instead of leaving it at the front of every run
      const got = new Set(rows.map(r => r.mint));
      const missing = batch.filter(m => !got.has(m));
      if (missing.length) await pool().query(`UPDATE newpair_tokens SET next_market_at = to_timestamp($2 / 1000.0) WHERE mint_address = ANY($1)`, [missing, at + RUGGED_REFRESH_MS]);
      tally.missing += missing.length;
      const counts = await schedule(rows, floors, at);
      tally.live += counts.live;
      tally.underFloor += counts.rugged;
      tally.refreshed += rows.length;
      tally.points += await appendPoints(rows.map(r => r.mint), at);
    }
    return tally;
  }

  /**
   * Score every active token whose data changed since it was last scored (the ones
   * this run refreshed). Pure math over stored rows: no upstream call.
   * `loadSamples(ids)` → Map<tokenId, sample> supplies the latest top-50 sample per
   * token once the holder tier exists; without it every token is "holders pending".
   */
  async function scoreActive({ loadSamples = async () => new Map(), limit = 10_000 } = {}) {
    await store.ensureSchema();
    const at = now();
    const floors = await getFloors();
    const { rows: tokens } = await pool().query(
      `SELECT id, graduated_at, holder_count, mcap, liquidity, peak_mcap, market FROM newpair_tokens
       WHERE status = 'active' AND market_at IS NOT NULL AND (scored_at IS NULL OR scored_at < market_at)
       ORDER BY scored_at NULLS FIRST LIMIT $1`, [limit]);
    if (tokens.length === 0) return { scored: 0, rugged: 0, pending: 0, unlisted: 0 };
    const ids = tokens.map(t => t.id);
    // 8 six-hour windows plus the 24h look-back, with slack for point timing
    const { rows: pointRows } = await pool().query(
      `SELECT token_id, at, holder_count FROM newpair_points
       WHERE token_id = ANY($1) AND holder_count IS NOT NULL AND at >= to_timestamp($2 / 1000.0) ORDER BY token_id, at`,
      [ids, at - 52 * HOUR]);
    const series = new Map();
    for (const p of pointRows) {
      if (!series.has(p.token_id)) series.set(p.token_id, []);
      series.get(p.token_id).push({ at: new Date(p.at).getTime(), holders: p.holder_count });
    }
    const samples = await loadSamples(ids);
    const out = [];
    const tally = { scored: 0, rugged: 0, pending: 0, unlisted: 0 };
    for (const t of tokens) {
      const token = { graduatedAt: new Date(t.graduated_at).getTime(), holders: t.holder_count, mcap: t.mcap, liquidity: t.liquidity, peakMcap: t.peak_mcap, market: t.market };
      const features = buildFeatures(token, series.get(t.id) || [], samples.get(t.id) || null, { now: at, minLiquidity: floors.minLiquidity });
      const r = scoreToken(features);
      const unlisted = authoritiesOpen(token) ? 'authority_enabled' : null;
      out.push({
        id: t.id, score: r.score, rugged: r.rugged, pending: r.pending, unlisted,
        parts: { quality: r.quality, confidence: r.confidence, risk: r.risk, coverage: r.coverage, terms: r.terms, riskParts: r.riskParts },
      });
      tally.scored++;
      if (r.rugged) tally.rugged++;
      if (r.pending) tally.pending++;
      if (unlisted) tally.unlisted++;
    }
    await pool().query(
      `UPDATE newpair_tokens t SET score = r.score, score_parts = r.parts, rugged = r.rugged, holders_pending = r.pending,
         unlisted_reason = r.unlisted, scored_at = to_timestamp($2 / 1000.0)
       FROM jsonb_to_recordset($1::jsonb) AS r(id bigint, score numeric, rugged boolean, pending boolean, unlisted text, parts jsonb)
       WHERE t.id = r.id`, [JSON.stringify(out), at]);
    return tally;
  }

  return { fileNewTokens, recheck, refreshMarket, scoreActive };
}

let shared = null;
const instance = () => (shared || (shared = createMarket()));

module.exports = {
  fileNewTokens: (o) => instance().fileNewTokens(o),
  recheck: (o) => instance().recheck(o),
  refreshMarket: (o) => instance().refreshMarket(o),
  scoreActive: (o) => instance().scoreActive(o),
  createMarket, mapJupiter, mapDexScreener, parseFloors, aboveFloors, nextRecheck, getFloors,
  DEFAULT_FLOORS, RECHECK_AT_MS, SETTINGS_KEY,
};
