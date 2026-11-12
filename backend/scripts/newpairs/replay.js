#!/usr/bin/env node
/**
 * New Pairs replay on real data. Run it in the HolDEX-worker shell on Render once the
 * finder has been on for at least 8 days (a token needs a day-1 and a day-7 mark):
 *
 *   node scripts/newpairs/replay.js            # the table
 *   node scripts/newpairs/replay.js --json     # the same as JSON
 *   node scripts/newpairs/replay.js --top 10   # top 10 a week instead of 20
 *
 * Read-only: it reads newpair_archive and the marks on tokens still listed, re-scores
 * each token's day-1 and day-3 features under every weight set, and prints how many of
 * the top picks were alive and still gaining holders at day 7 and day 14, next to the
 * same figure for all tokens. No upstream call, nothing written.
 */
const { Pool } = require('pg');
const { replay } = require('../../src/services/newPairReplay');

const JSON_OUT = process.argv.includes('--json');
const topArg = process.argv.indexOf('--top');
const TOP_N = topArg > -1 ? Math.max(1, parseInt(process.argv[topArg + 1], 10) || 20) : 20;
const pct = (v) => (v == null ? '   n/a' : `${(v * 100).toFixed(1).padStart(5)}%`);
const lift = (v) => (v == null ? '  n/a' : `${v.toFixed(2).padStart(5)}x`);

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
  // Its own one-connection pool, not services/database.js (requiring that runs the schema
  // setup). Same SSL rule as database.js.
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL, max: 1,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' } : false,
  });
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT mint_address, graduated_at, marks FROM newpair_archive WHERE marks <> '{}'::jsonb
       UNION ALL
       SELECT t.mint_address, t.graduated_at, t.marks FROM newpair_tokens t
       WHERE t.marks <> '{}'::jsonb AND NOT EXISTS (SELECT 1 FROM newpair_archive a WHERE a.mint_address = t.mint_address)`));
  } finally {
    await pool.end();
  }
  const result = replay(rows.map(r => ({ mint: r.mint_address, graduatedAt: new Date(r.graduated_at).getTime(), marks: r.marks })), { topN: TOP_N });
  if (JSON_OUT) { console.log(JSON.stringify(result, null, 2)); return; }

  console.log(`New Pairs replay: ${result.tokens} tokens with at least one mark. "Good" = not rugged and more holders than at the entry mark.`);
  for (const p of result.pairs) {
    console.log(`\nTop ${result.topN} per bonding week by day-${p.entryDay} score, judged at day ${p.outcomeDay}: ${p.eligible} tokens over ${p.weeks} weeks, ${pct(p.baseRate).trim()} of all were good`);
    if (p.eligible < 100) console.log('  Fewer than 100 tokens: treat every figure below as noise.');
    console.log('  Weight set               picked   good    rate    vs all');
    for (const s of p.sets) console.log(`  ${s.label.padEnd(24)} ${String(s.picked).padStart(6)} ${String(s.hits).padStart(6)}  ${pct(s.rate)}  ${lift(s.lift)}`);
  }
  console.log('\nEach term alone: the top fifth by that term at day 1, judged at day 7');
  console.log('  Term        with data   all good   top fifth good   vs all');
  for (const t of result.terms) console.log(`  ${t.term.padEnd(10)} ${String(t.withData).padStart(10)}   ${pct(t.baseRate)}       ${pct(t.topRate)}      ${lift(t.lift)}`);
}

if (require.main === module) main().catch((error) => { console.error(`replay failed: ${error.message}`); process.exit(1); });
