/**
 * New Pairs: the launchpads whose graduations (bonding curve to a real pool) the finder
 * follows. Seven launchpads graduate through three programs, so there are three
 * detectors; the launchpad a token came from is a label on top (LAUNCHPAD_LABELS).
 *
 * Each detector watches one account that every migration of its program touches
 * (`marker`) and recognises the migration instruction by its Anchor discriminator
 * (the first 8 bytes of sha256("global:<name>")), reading the mints from fixed
 * positions in the instruction's account list. Programs, markers and positions were
 * read off live transactions on 2026-11-11/12 (fixtures/newPairGraduations.json):
 *
 *   pumpfun      14 of 14 sampled migrations had the mint at account 2
 *   meteora-dbc  14 of 14 had base mint 13, quote mint 14 (also when the migration is
 *                an inner instruction of a wrapper program)
 *   launchlab     6 of 6 had base mint 1, quote mint 2
 *
 * migrate_to_amm (LaunchLab to Raydium AMM v4) and migrate_meteora_damm (DBC to DAMM
 * v1) exist in the programs but none was seen, so their account positions are not
 * known: the detector counts them as `unhandled` instead of guessing.
 */

const crypto = require('crypto');

const WSOL = 'So11111111111111111111111111111111111111112';

/** Anchor instruction discriminator, hex. */
function discriminator(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');
}

const DETECTORS = {
  pumpfun: {
    id: 'pumpfun',
    label: 'Pump.fun',
    program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    // "withdraw authority": an account of every migrate instruction
    marker: '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
    // A migration that really moved the coin invokes the pool program; the duplicates
    // racing it (about one per graduation) succeed without doing anything.
    poolPrograms: ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'],
    dexIds: ['pumpswap'],
    instructions: {
      [discriminator('migrate_v2')]: { name: 'migrate_v2', mint: 2, quote: 3 },
      [discriminator('migrate')]: { name: 'migrate', mint: 2, quote: 14 },
    },
    unhandled: {},
    // Successful transactions a day on the marker (measured 2026-11-11); sets how often
    // the paid fallback polls, so each call returns close to a full 100-row page.
    txPerDay: 1650,
  },
  'meteora-dbc': {
    id: 'meteora-dbc',
    label: 'Meteora DBC',
    program: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
    // A DAMM v2 config account present in every sampled migration_damm_v2. Other
    // configs may exist: scripts/newpairs/probe.js measures what this one misses.
    marker: 'A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck',
    poolPrograms: ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'],
    dexIds: ['meteora-damm-v2'],
    instructions: {
      [discriminator('migration_damm_v2')]: { name: 'migration_damm_v2', mint: 13, quote: 14 },
    },
    unhandled: { [discriminator('migrate_meteora_damm')]: 'migrate_meteora_damm' },
    txPerDay: 1670,
  },
  launchlab: {
    id: 'launchlab',
    label: 'Raydium LaunchLab',
    program: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
    // The wallet that signed every sampled migrate_to_cpswap. It could be rotated:
    // the probe's miss rate is the check.
    marker: 'RAYpQbFNq9i3mu6cKpTKKRwwHFDeK5AuZz8xvxUrCgw',
    poolPrograms: ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'],
    dexIds: ['raydium'],
    instructions: {
      [discriminator('migrate_to_cpswap')]: { name: 'migrate_to_cpswap', mint: 1, quote: 2 },
    },
    unhandled: { [discriminator('migrate_to_amm')]: 'migrate_to_amm' },
    txPerDay: 80,
  },
};

// Jupiter's `launchpad` value for a token → what the UI calls it, and the detector
// that finds its graduations. Believe had no label of its own on 2026-11-11.
const LAUNCHPAD_LABELS = {
  'pump.fun': { label: 'Pump.fun', detector: 'pumpfun' },
  'met-dbc': { label: 'Meteora DBC', detector: 'meteora-dbc' },
  'bags.fun': { label: 'Bags', detector: 'meteora-dbc' },
  believe: { label: 'Believe', detector: 'meteora-dbc' },
  moonshot: { label: 'Moonshot', detector: 'meteora-dbc' },
  'raydium-launchlab': { label: 'Raydium LaunchLab', detector: 'launchlab' },
  'letsbonk.fun': { label: 'LetsBonk', detector: 'launchlab' },
};

/** Detectors named in NEWPAIRS_DETECTORS (comma-separated), or all of them. */
function enabledDetectors(value = process.env.NEWPAIRS_DETECTORS) {
  const wanted = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  if (wanted.length === 0) return Object.values(DETECTORS);
  return wanted.map(id => DETECTORS[id]).filter(Boolean);
}

module.exports = { DETECTORS, LAUNCHPAD_LABELS, WSOL, discriminator, enabledDetectors };
