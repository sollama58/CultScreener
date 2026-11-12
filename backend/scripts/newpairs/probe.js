#!/usr/bin/env node
/**
 * New Pairs probe: answers, from wherever it runs, the questions the plan could not
 * settle from a laptop. Run it in the HolDEX-worker shell on Render:
 *
 *   node scripts/newpairs/probe.js            # everything (about 2 minutes)
 *   node scripts/newpairs/probe.js --quick    # skip the recall check
 *
 * Read-only. It calls the public RPCs, Jupiter and GeckoTerminal, and reads (never
 * writes) the database when DATABASE_URL is set. It makes no Helius call and prints
 * hosts only, never a URL.
 *
 *   1. Free RPCs     can this machine reach each one, how far back does its history
 *                    go, how soon does getTransaction throttle
 *   2. Detectors     transactions a day on each marker, and what a sample decodes to
 *   3. Jupiter       which host answers without a key, the launchpad labels it gives
 *                    our graduates, and the share still above the floors
 *   4. Recall        of the pools GeckoTerminal lists as new on the graduation DEXes
 *                    that Jupiter confirms as a graduation, how many are in
 *                    newpair_tokens (needs the discover job to have run for a while)
 *   5. Database      size, New Pairs row counts, detector health, credits today
 */

const axios = require('axios');
const { createClient, parseUrls, DEFAULT_URLS } = require('../../src/services/freeRpc');
const { DETECTORS, LAUNCHPAD_LABELS, enabledDetectors } = require('../../src/services/newPairLaunchpads');
const { matchGraduation } = require('../../src/services/newPairDetectors');

const QUICK = process.argv.includes('--quick');
const SAMPLE_TX = 30;
const FLOOR_MCAP = 25_000;
const FLOOR_LIQUIDITY = 5_000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');
const hours = (ms) => `${(ms / 3_600_000).toFixed(1)}h`;
const head = (title) => console.log(`\n=== ${title} ===`);

/** One endpoint, no rate limiter or breaker: the probe wants to see the raw behaviour. */
function rawClient(url) {
  return createClient({ urls: [url], limit: (fn) => fn(), breaker: { execute: (fn) => fn() } });
}

async function getTx(client, signature) {
  try {
    return await client.call('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
  } catch (error) {
    if (error.rpcCode !== -32015) throw error;
    return client.call('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 1 }]);
  }
}

async function probeEndpoints(urls) {
  head('1. Free RPCs');
  const usable = [];
  for (const url of urls) {
    const client = rawClient(url);
    const host = client.hosts()[0];
    const marker = DETECTORS.pumpfun.marker;
    try {
      // History depth: page back until the endpoint runs out (or 5 pages)
      let before; let oldest = null; let pages = 0; let first = null;
      const t0 = Date.now();
      for (; pages < 5; pages++) {
        const opts = { limit: 1000 };
        if (before) opts.before = before;
        const sigs = await client.call('getSignaturesForAddress', [marker, opts]);
        if (!first) first = sigs;
        if (!sigs.length) break;
        oldest = sigs[sigs.length - 1];
        before = oldest.signature;
        if (sigs.length < 1000) { pages++; break; }
        await sleep(300);
      }
      const sigMs = Math.round((Date.now() - t0) / Math.max(1, pages));
      const depth = oldest?.blockTime ? Date.now() - oldest.blockTime * 1000 : null;
      // getTransaction: 30 in a row, 4 per second
      const ok = (first || []).filter(s => !s.err).slice(0, SAMPLE_TX);
      const lat = []; let throttled = 0; let missing = 0; let failed = 0;
      for (const s of ok) {
        const t = Date.now();
        try {
          const tx = await getTx(client, s.signature);
          if (tx) lat.push(Date.now() - t); else missing++;
        } catch (error) {
          if (error.status === 429 || error.status === 403) throttled++; else failed++;
        }
        await sleep(250);
      }
      console.log(`${host}: signatures ok (${sigMs} ms/page, history ${depth ? hours(depth) : 'unknown'}${pages >= 5 ? ' or more' : ''}); ` +
        `getTransaction ${lat.length}/${ok.length} ok, ${throttled} throttled, ${missing} missing, ${failed} failed, median ${median(lat) ?? 'n/a'} ms`);
      if (lat.length >= ok.length * 0.8 && ok.length) usable.push(url);
    } catch (error) {
      console.log(`${host}: NOT USABLE (${error.message})`);
    }
  }
  console.log(usable.length
    ? `Usable for discovery: ${usable.length} of ${urls.length}.`
    : 'No free RPC is usable from here: discovery will run on the paced Helius fallback (about 500 credits a day).');
  return usable;
}

async function probeDetectors(urls) {
  head('2. Detectors');
  const client = createClient({ urls, limit: async (fn) => { await sleep(250); return fn(); }, breaker: { execute: (fn) => fn() } });
  const mints = [];
  for (const detector of enabledDetectors()) {
    try {
      const sigs = await client.call('getSignaturesForAddress', [detector.marker, { limit: 1000 }]);
      const ok = sigs.filter(s => !s.err);
      const span = ok.length > 1 ? (ok[0].blockTime - ok[ok.length - 1].blockTime) * 1000 : 0;
      const perDay = span > 0 ? Math.round(ok.length / (span / 86_400_000)) : null;
      let found = 0; let unhandled = 0; let other = 0; let errors = 0;
      for (const s of ok.slice(0, SAMPLE_TX)) {
        try {
          const tx = await getTx(client, s.signature);
          const hit = tx && matchGraduation(detector, tx);
          if (!hit) other++;
          else if (hit.unhandled) { unhandled++; console.log(`  unhandled ${hit.unhandled}: ${s.signature}`); }
          else { found++; mints.push({ mint: hit.mint, detector: detector.id }); }
        } catch (_) { errors++; }
      }
      const sampled = Math.min(SAMPLE_TX, ok.length);
      const gradsPerDay = perDay != null && sampled ? Math.round(perDay * (found / sampled)) : null;
      console.log(`${detector.id}: ${perDay ?? 'n/a'} ok tx/day on the marker (registry says ${detector.txPerDay}); ` +
        `sample of ${sampled}: ${found} graduations, ${other} not a graduation, ${unhandled} unhandled, ${errors} unread; about ${gradsPerDay ?? 'n/a'} graduations/day`);
    } catch (error) {
      console.log(`${detector.id}: could not read the marker (${error.message})`);
    }
  }
  return mints;
}

async function jupiterSearch(host, mints) {
  const headers = host === 'api.jup.ag' && process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {};
  const { data } = await axios.get(`https://${host}/tokens/v2/search`, { params: { query: mints.join(',') }, headers, timeout: 15000 });
  return Array.isArray(data) ? data : [];
}

async function probeJupiter(found) {
  head('3. Jupiter');
  const mints = [...new Set(found.map(f => f.mint))].slice(0, 100);
  if (mints.length === 0) { console.log('No graduations sampled, nothing to look up.'); return null; }
  let working = null; let tokens = [];
  for (const host of ['lite-api.jup.ag', 'api.jup.ag']) {
    try {
      const t = Date.now();
      const rows = await jupiterSearch(host, mints);
      console.log(`${host}: ok, ${rows.length} of ${mints.length} mints in ${Date.now() - t} ms${host === 'api.jup.ag' ? ` (key ${process.env.JUPITER_API_KEY ? 'set' : 'not set'})` : ''}`);
      if (!working) { working = host; tokens = rows; }
    } catch (error) {
      console.log(`${host}: ${error.response?.status || error.code || 'failed'}`);
    }
    await sleep(1100);
  }
  if (!working) { console.log('Neither Jupiter host answered: the cheap tier (PR 2) needs a JUPITER_API_KEY or another source.'); return null; }
  const labels = {};
  for (const t of tokens) labels[t.launchpad || '(none)'] = (labels[t.launchpad || '(none)'] || 0) + 1;
  console.log('Launchpad labels:', Object.entries(labels).map(([k, n]) => `${k}${LAUNCHPAD_LABELS[k] ? '' : ' [not in registry]'}=${n}`).join(', '));
  const above = tokens.filter(t => (t.mcap || 0) >= FLOOR_MCAP && (t.liquidity || 0) >= FLOOR_LIQUIDITY).length;
  console.log(`Above the floors ($${FLOOR_MCAP} market cap, $${FLOOR_LIQUIDITY} liquidity) minutes after graduating: ${above} of ${tokens.length} (${pct(above, tokens.length)})`);
  console.log(`With holderCount: ${tokens.filter(t => t.holderCount != null).length}, with graduatedPool: ${tokens.filter(t => t.graduatedPool).length}`);
  return working;
}

function dbPool() {
  if (!process.env.DATABASE_URL) return null;
  // Its own small pool, not services/database.js: requiring that runs the schema setup,
  // and this script only reads. Same SSL rule as database.js.
  const { Pool } = require('pg');
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' } : false,
    max: 2,
  });
}

async function probeRecall(jupiterHost, pool) {
  head('4. Recall against GeckoTerminal');
  if (!jupiterHost) { console.log('Skipped: no Jupiter host to confirm graduations with.'); return; }
  const dexIds = new Set(Object.values(DETECTORS).flatMap(d => d.dexIds));
  const pools = new Map(); // pool address -> { mint, dex, createdAt }
  for (let page = 1; page <= 5; page++) {
    try {
      const { data } = await axios.get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools', { params: { page }, timeout: 15000 });
      for (const p of data?.data || []) {
        const dex = p.relationships?.dex?.data?.id;
        const mint = String(p.relationships?.base_token?.data?.id || '').replace(/^solana_/, '');
        if (dexIds.has(dex) && mint) pools.set(p.attributes?.address, { mint, dex, createdAt: Date.parse(p.attributes?.pool_created_at) });
      }
    } catch (error) {
      console.log(`GeckoTerminal page ${page}: ${error.response?.status || error.code || 'failed'}`);
      break;
    }
    await sleep(2200); // free tier: 30 a minute
  }
  if (!pool) { console.log(`New pools on the graduation DEXes: ${pools.size}. No DATABASE_URL: cannot compare with newpair_tokens.`); return; }
  // Only pools created before the point their detector has read through can be judged
  const readThrough = await pool.query('SELECT id, cursor_time, caught_up_at FROM newpair_detectors')
    .then(r => new Map(r.rows.map(x => [x.id, Math.max(new Date(x.cursor_time || 0).getTime(), new Date(x.caught_up_at || 0).getTime())]))).catch(() => null);
  if (!readThrough || readThrough.size === 0) { console.log('The discover job has not run yet: run this again after it has been on for an hour.'); return; }
  const detectorOf = (dex) => Object.values(DETECTORS).find(d => d.dexIds.includes(dex))?.id;
  const settled = [...pools.entries()].filter(([, p]) => p.createdAt <= (readThrough.get(detectorOf(p.dex)) || 0));
  if (settled.length === 0) { console.log(`None of the ${pools.size} new pools GeckoTerminal lists is older than what discovery has read through.`); return; }
  const info = new Map();
  const mints = [...new Set(settled.map(([, p]) => p.mint))];
  for (let i = 0; i < mints.length; i += 100) {
    try { for (const t of await jupiterSearch(jupiterHost, mints.slice(i, i + 100))) info.set(t.id, t); } catch (_) { /* counted as unconfirmed */ }
    await sleep(1100);
  }
  // Anyone can open a pool for any token: only a pool Jupiter names as the token's graduation pool counts
  const graduations = settled.filter(([address, p]) => info.get(p.mint)?.graduatedPool === address);
  console.log(`New pools on ${[...dexIds].join(', ')}: ${settled.length}; confirmed graduations: ${graduations.length}`);
  const have = await pool.query('SELECT mint_address FROM newpair_tokens WHERE mint_address = ANY($1)', [graduations.map(([, p]) => p.mint)])
    .then(r => new Set(r.rows.map(x => x.mint_address))).catch(() => null);
  if (!have) { console.log('Could not read newpair_tokens.'); return; }
  const byDex = {};
  for (const [, p] of graduations) {
    byDex[p.dex] = byDex[p.dex] || { total: 0, found: 0, missed: [] };
    byDex[p.dex].total++;
    if (have.has(p.mint)) byDex[p.dex].found++; else byDex[p.dex].missed.push(p.mint);
  }
  for (const [dex, r] of Object.entries(byDex)) {
    console.log(`${dex}: found ${r.found} of ${r.total} (${pct(r.found, r.total)})${r.missed.length ? `; missed e.g. ${r.missed.slice(0, 3).join(', ')}` : ''}`);
  }
  console.log('A dex well under 100% means its marker does not see every migration (see newPairLaunchpads.js).');
}

async function probeDatabase(pool) {
  head('5. Database');
  if (!pool) { console.log('No DATABASE_URL.'); return; }
  const one = (sql) => pool.query(sql).then(r => r.rows).catch(() => null);
  const size = await one('SELECT pg_size_pretty(pg_database_size(current_database())) AS size');
  console.log(`Database size: ${size?.[0]?.size ?? 'unknown'}`);
  const tokens = await one(`SELECT detector, COUNT(*) AS n, MIN(graduated_at) AS oldest, MAX(graduated_at) AS newest FROM newpair_tokens GROUP BY detector ORDER BY detector`);
  if (!tokens) { console.log('newpair_tokens does not exist yet (the discover job has not run).'); return; }
  for (const r of tokens) console.log(`newpair_tokens ${r.detector}: ${r.n} rows, ${new Date(r.oldest).toISOString()} to ${new Date(r.newest).toISOString()}`);
  if (tokens.length === 0) console.log('newpair_tokens is empty.');
  const tableSize = await one(`SELECT pg_size_pretty(pg_total_relation_size('newpair_tokens')) AS size`);
  console.log(`newpair_tokens size: ${tableSize?.[0]?.size ?? 'unknown'}`);
  for (const r of (await one('SELECT * FROM newpair_detectors ORDER BY id')) || []) {
    console.log(`detector ${r.id}: last run ${r.last_run_at ? new Date(r.last_run_at).toISOString() : 'never'} via ${r.last_source}, ` +
      `read through ${r.cursor_time ? new Date(r.cursor_time).toISOString() : 'n/a'}, found ${r.found_total}, unhandled ${r.unhandled_total}${r.last_error ? `, last error: ${r.last_error}` : ''}`);
  }
  for (const r of (await one('SELECT day, source, credits FROM newpair_credit_days ORDER BY day DESC, source LIMIT 14')) || []) {
    console.log(`credits ${new Date(r.day).toISOString().slice(0, 10)} ${r.source}: ${r.credits}`);
  }
}

async function main() {
  const configured = parseUrls(process.env.NEWPAIRS_RPC_URLS);
  const urls = configured.length ? configured : DEFAULT_URLS;
  console.log(`New Pairs probe, ${new Date().toISOString()}${QUICK ? ' (quick)' : ''}`);
  const usable = await probeEndpoints(urls);
  const found = usable.length ? await probeDetectors(usable) : [];
  const jupiterHost = await probeJupiter(found);
  const pool = dbPool();
  if (!QUICK) await probeRecall(jupiterHost, pool).catch(e => console.log(`Recall check failed: ${e.message}`));
  await probeDatabase(pool).catch(e => console.log(`Database check failed: ${e.message}`));
}

main().then(() => process.exit(0), (error) => { console.error('Probe failed:', error.message); process.exit(1); });
