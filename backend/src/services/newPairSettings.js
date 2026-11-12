/**
 * New Pairs settings the admin panel can change, kept in app_settings under one key
 * (the floors have lived there since the cheap tier; see newPairMarket.getFloors).
 *
 *   minMcap, minLiquidity   floors a token must clear to be listed
 *   shortlistSize           how many of the best-scoring tokens get top-50 holder checks
 *   dailyCredits            Helius credits a day for the whole feature
 *
 * The daily credits can only be lowered here. NEWPAIRS_HELIUS_DAILY_CREDITS in the
 * environment is the ceiling: raising spend is a deliberate change to render.yaml,
 * not a number typed into a form. A stored value above the ceiling is read as the
 * ceiling, so lowering the env var later takes effect at once.
 */
const db = require('./database');
const { SETTINGS_KEY, parseFloors } = require('./newPairMarket');

const DEFAULT_ENV_CREDITS = 10_000;
const DEFAULT_SHORTLIST = 50;
const BOUNDS = {
  minMcap: [0, 1e9],
  minLiquidity: [0, 1e9],
  shortlistSize: [10, 200],
};

const int = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/** The ceiling from the environment (default 10,000). */
function envDailyCredits(env = process.env) {
  const n = parseInt(env.NEWPAIRS_HELIUS_DAILY_CREDITS, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ENV_CREDITS;
}

/** Stored JSON → effective settings. Anything missing or out of range falls back to its default. */
function parse(raw, env = process.env) {
  let stored = {};
  try { stored = raw ? JSON.parse(raw) : {}; } catch (_) { /* bad JSON: defaults */ }
  if (!stored || typeof stored !== 'object') stored = {};
  const ceiling = envDailyCredits(env);
  const size = int(stored.shortlistSize);
  const credits = int(stored.dailyCredits);
  return {
    ...parseFloors(raw),
    shortlistSize: size != null && size >= BOUNDS.shortlistSize[0] && size <= BOUNDS.shortlistSize[1] ? size : DEFAULT_SHORTLIST,
    dailyCredits: credits != null && credits >= 0 ? Math.min(credits, ceiling) : ceiling,
    maxDailyCredits: ceiling,
  };
}

async function get(env = process.env) {
  return parse(await db.getSetting(SETTINGS_KEY).catch(() => null), env);
}

/** Helius credits the feature may spend today: the stored figure, never above the env ceiling. */
async function dailyCap(env = process.env) {
  return (await get(env)).dailyCredits;
}

/**
 * Validate a change and store it. Only the keys given change.
 * @throws {Error} with status 400 and the reason, when a value is out of range
 */
async function save(input, env = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Settings must be an object');
  const current = await get(env);
  const next = { minMcap: current.minMcap, minLiquidity: current.minLiquidity, shortlistSize: current.shortlistSize, dailyCredits: current.dailyCredits };
  for (const key of ['minMcap', 'minLiquidity']) {
    if (input[key] === undefined) continue;
    const v = input[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < BOUNDS[key][0] || v > BOUNDS[key][1]) throw bad(`${key} must be a number from ${BOUNDS[key][0]} to ${BOUNDS[key][1]}`);
    next[key] = v;
  }
  if (input.shortlistSize !== undefined) {
    const v = int(input.shortlistSize);
    if (v == null || v < BOUNDS.shortlistSize[0] || v > BOUNDS.shortlistSize[1]) throw bad(`shortlistSize must be a whole number from ${BOUNDS.shortlistSize[0]} to ${BOUNDS.shortlistSize[1]}`);
    next.shortlistSize = v;
  }
  if (input.dailyCredits !== undefined) {
    const v = int(input.dailyCredits);
    const ceiling = envDailyCredits(env);
    if (v == null || v < 0) throw bad('dailyCredits must be a whole number, 0 or more');
    if (v > ceiling) throw bad(`dailyCredits cannot be above ${ceiling}, the limit set by NEWPAIRS_HELIUS_DAILY_CREDITS`);
    next.dailyCredits = v;
  }
  await db.setSetting(SETTINGS_KEY, JSON.stringify(next));
  return get(env);
}

function bad(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

module.exports = { get, save, parse, dailyCap, envDailyCredits, BOUNDS, DEFAULT_SHORTLIST };
