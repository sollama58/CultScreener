/**
 * Helius credit tracking.
 *
 * Every Helius call site calls count(method, credits). Counts are buffered in
 * memory and flushed to the shared cache every few seconds, so the API and
 * worker processes add up to one total:
 *
 *   helius-credits:<day>              credits, all methods (UTC day)
 *   helius-credits:<day>:<method>     credits per method
 *   helius-calls:<day>:<method>       calls per method
 *   helius-src-credits:<day>:<source> credits per source (job or API route)
 *   helius-src-calls:<day>:<source>   calls per source
 *   helius-credits-hour:<hour>        credits per UTC hour (YYYY-MM-DDTHH)
 *
 * Each day's totals are also added to Postgres (helius_credit_days), so the month
 * line survives a Redis restart or the eviction of past days' keys.
 *
 * The source is whatever withSource() set for the async context the call runs
 * in: "job:<name>" in the worker, "api:<METHOD> <path>" in the API (mints and
 * ids in the path collapsed), "<role>:background" otherwise.
 *
 * Helius pricing (helius.dev/docs/billing/credits): 1 credit for standard RPC,
 * 10 for DAS and getProgramAccounts, 10 per 100 transactions returned for
 * getTransactionsForAddress (full), 100 for the legacy Enhanced Transactions API.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { cache } = require('./cache');

const DAY_KEY_TTL = 40 * 24 * 3600000;
const HOUR_KEY_TTL = 3 * 24 * 3600000;
const FLUSH_MS = 10000;
const HISTORY_DAYS = 31;              // covers a whole month for the month-to-date line
const HOURS_SHOWN = 48;
// Distinct sources one process records per day; the rest are counted as "<role>:other"
const MAX_SOURCES_PER_DAY = 200;
// Monthly credits on the Helius plan, for the budget line (Developer plan: 10M)
const MONTHLY_BUDGET = (() => {
  const v = parseInt(process.env.HELIUS_MONTHLY_CREDITS, 10);
  return Number.isFinite(v) && v > 0 ? v : 10_000_000;
})();
const USAGE_CACHE_MS = 30000;
// Day of the month the Helius plan's credits reset (the subscription's billing date,
// UTC). The "month" line runs from the last such day; 1 = calendar month.
const BILLING_DAY = (() => {
  const v = parseInt(process.env.HELIUS_BILLING_DAY, 10);
  return Number.isFinite(v) && v >= 1 && v <= 31 ? v : 1;
})();
// Increments a failed flush keeps for the next one (exact keys), at most
const MAX_RETRY_KEYS = 5000;

const context = new AsyncLocalStorage();
let role = 'api';

// method → {credits, calls}; source → {credits, calls}; hour → credits (not yet flushed)
let buffer = { methods: new Map(), sources: new Map(), hours: new Map(), day: null };
const processTotals = { credits: 0, calls: 0, methods: new Map(), since: Date.now() };
const sourcesSeen = { day: null, set: new Set() };

function utcDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcHour(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 13);
}

/** Name this process ('api' or 'worker'); used for sources with no context. */
function setProcessRole(name) {
  role = String(name || 'api');
}

/** Run fn with every Helius call inside it attributed to `source`. */
function withSource(source, fn) {
  return context.run({ source: cleanSource(source) }, fn);
}

function currentSource() {
  return context.getStore()?.source || `${role}:background`;
}

// Keys are scanned with glob patterns, so keep sources to plain characters
function cleanSource(source) {
  return String(source || '').replace(/[^A-Za-z0-9_:/ .-]/g, '').slice(0, 80) || `${role}:unknown`;
}

const BASE58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

/** "/api/tokens/<mint>/holders" → "/api/tokens/:id/holders"; numbers → ":n". */
function normalizePath(path) {
  return String(path || '/').split('?')[0].split('/')
    .map(seg => (BASE58_ID.test(seg) ? ':id' : /^\d+$/.test(seg) ? ':n' : seg))
    .join('/')
    .slice(0, 60);
}

/** Express middleware: attribute Helius calls made while serving a request to its route. */
function requestMiddleware(req, res, next) {
  withSource(`api:${req.method} ${normalizePath(req.originalUrl || req.url)}`, next);
}

function bump(map, key, credits, calls) {
  const e = map.get(key) || { credits: 0, calls: 0 };
  e.credits += credits;
  e.calls += calls;
  map.set(key, e);
}

/**
 * Record a Helius call. `calls` is 0 for extra credits billed on a call already
 * counted (getTransactionsForAddress pages over 100 transactions).
 */
function count(method, credits, calls = 1) {
  if (!(credits > 0) && !(calls > 0)) return;
  const now = Date.now();
  const day = utcDay(now);
  if (buffer.day && buffer.day !== day) flush().catch(() => {});
  buffer.day = day;

  let source = currentSource();
  if (sourcesSeen.day !== day) { sourcesSeen.day = day; sourcesSeen.set.clear(); }
  if (!sourcesSeen.set.has(source)) {
    if (sourcesSeen.set.size >= MAX_SOURCES_PER_DAY) source = `${role}:other`;
    else sourcesSeen.set.add(source);
  }

  bump(buffer.methods, method, credits, calls);
  bump(buffer.sources, source, credits, calls);
  const hour = utcHour(now);
  buffer.hours.set(hour, (buffer.hours.get(hour) || 0) + credits);

  processTotals.credits += credits;
  processTotals.calls += calls;
  bump(processTotals.methods, method, credits, calls);
}

// Increments whose write failed (Redis disconnected: incrBy answers null), by exact
// key, retried on the next flush instead of being lost
const retry = new Map(); // key → { by, ttl }
// Day totals not yet added to Postgres: day → { credits, calls }
const pgPending = new Map();

function addRetry(key, by, ttl) {
  const e = retry.get(key);
  if (e) e.by += by;
  else if (retry.size < MAX_RETRY_KEYS) retry.set(key, { by, ttl });
}

async function flush() {
  const ops = [...retry].map(([key, { by, ttl }]) => [key, by, ttl]);
  retry.clear();
  if (buffer.day) {
    const { methods, sources, hours, day } = buffer;
    buffer = { methods: new Map(), sources: new Map(), hours: new Map(), day: null };
    let total = 0;
    let calls = 0;
    for (const [method, m] of methods) {
      total += m.credits;
      calls += m.calls;
      if (m.credits) ops.push([`helius-credits:${day}:${method}`, m.credits, DAY_KEY_TTL]);
      if (m.calls) ops.push([`helius-calls:${day}:${method}`, m.calls, DAY_KEY_TTL]);
    }
    for (const [source, src] of sources) {
      if (src.credits) ops.push([`helius-src-credits:${day}:${source}`, src.credits, DAY_KEY_TTL]);
      if (src.calls) ops.push([`helius-src-calls:${day}:${source}`, src.calls, DAY_KEY_TTL]);
    }
    for (const [hour, credits] of hours) {
      if (credits) ops.push([`helius-credits-hour:${hour}`, credits, HOUR_KEY_TTL]);
    }
    if (total) ops.push([`helius-credits:${day}`, total, DAY_KEY_TTL]);
    if (total || calls) {
      const p = pgPending.get(day) || { credits: 0, calls: 0 };
      p.credits += total;
      p.calls += calls;
      pgPending.set(day, p);
    }
  }
  await Promise.all(ops.map(([key, by, ttl]) => Promise.resolve(cache.incrBy(key, by, ttl))
    .then(v => { if (v == null) addRetry(key, by, ttl); }, () => addRetry(key, by, ttl))));
  await flushToPostgres();
}

// Add the buffered day totals to Postgres; kept for the next flush if that fails
async function flushToPostgres() {
  if (pgPending.size === 0) return;
  const pool = require('./database').pool;
  if (!pool) return;
  for (const [day, { credits, calls }] of [...pgPending]) {
    try {
      await pool.query(
        `INSERT INTO helius_credit_days (day, credits, calls, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (day) DO UPDATE SET credits = helius_credit_days.credits + EXCLUDED.credits,
           calls = helius_credit_days.calls + EXCLUDED.calls, updated_at = NOW()`,
        [day, credits, calls]);
      pgPending.delete(day);
    } catch (_) {
      // Postgres unreachable: keep the totals for the next flush (bounded by days)
      if (pgPending.size > HISTORY_DAYS + 9) pgPending.delete(pgPending.keys().next().value);
      return;
    }
  }
}

// day → credits stored in Postgres, for the last `days` days
async function readPostgresDays(days) {
  const pool = require('./database').pool;
  if (!pool) return {};
  try {
    const { rows } = await pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, credits FROM helius_credit_days
        WHERE day >= ((NOW() AT TIME ZONE 'UTC')::date - $1::int)`, [days]);
    return Object.fromEntries(rows.map(r => [r.day, Number(r.credits) || 0]));
  } catch (_) {
    return {};
  }
}

/**
 * The billing cycle containing `now`: from the last BILLING_DAY (clamped to the
 * month's length) to the next one, as UTC day starts in ms.
 */
function billingCycle(now = Date.now(), billingDay = BILLING_DAY) {
  const d = new Date(now);
  const startOf = (y, m) => {
    const len = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(billingDay, len));
  };
  let start = startOf(d.getUTCFullYear(), d.getUTCMonth());
  if (start > now) start = startOf(d.getUTCFullYear(), d.getUTCMonth() - 1);
  const s = new Date(start);
  const end = startOf(s.getUTCFullYear(), s.getUTCMonth() + 1);
  return { start, end };
}

const flushTimer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
if (flushTimer.unref) flushTimer.unref();

// ── Reading ──────────────────────────────────────────────────────────────────

// All keys under a prefix as { "<day>": { "<name>": value } }
async function readGrouped(prefix) {
  const out = {};
  const keys = await cache.scanKeys(`${prefix}:*`).catch(() => []);
  const values = await Promise.all(keys.map(k => cache.get(k).catch(() => 0)));
  keys.forEach((key, i) => {
    const rest = key.slice(prefix.length + 1);
    const sep = rest.indexOf(':');
    if (sep < 0) return;
    const day = rest.slice(0, sep);
    const name = rest.slice(sep + 1);
    if (!out[day]) out[day] = {};
    out[day][name] = Number(values[i]) || 0;
  });
  return out;
}

function mergeRows(credits = {}, calls = {}) {
  const names = new Set([...Object.keys(credits), ...Object.keys(calls)]);
  return [...names]
    .map(name => ({ name, credits: credits[name] || 0, calls: calls[name] || 0 }))
    .sort((a, b) => b.credits - a.credits || b.calls - a.calls);
}

let usageCache = null;

/**
 * Credit usage for the admin view: the last HISTORY_DAYS days (oldest first) with
 * per-method and per-source breakdowns, the last HOURS_SHOWN hours, and the month
 * so far with a projection against the plan's monthly credits.
 */
async function getUsage({ fresh = false } = {}) {
  if (!fresh && usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.value;
  await flush().catch(() => {});

  const now = Date.now();
  const [methodCredits, methodCalls, srcCredits, srcCalls, pgDays] = await Promise.all([
    readGrouped('helius-credits'),
    readGrouped('helius-calls'),
    readGrouped('helius-src-credits'),
    readGrouped('helius-src-calls'),
    readPostgresDays(HISTORY_DAYS),
  ]);

  const days = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const date = utcDay(now - i * 86400000);
    const total = Number(await cache.get(`helius-credits:${date}`).catch(() => 0)) || 0;
    const byMethod = mergeRows(methodCredits[date], methodCalls[date]);
    const bySource = mergeRows(srcCredits[date], srcCalls[date]);
    days.push({
      date,
      // The per-method keys and the day total are written together; take the
      // larger in case one write was lost. Postgres keeps the total when Redis
      // has lost the day (restart, eviction).
      credits: Math.max(total, byMethod.reduce((s, r) => s + r.credits, 0), pgDays[date] || 0),
      calls: byMethod.reduce((s, r) => s + r.calls, 0),
      byMethod,
      bySource,
    });
  }

  const hours = [];
  for (let i = HOURS_SHOWN - 1; i >= 0; i--) {
    const hour = utcHour(now - i * 3600000);
    hours.push({ hour, credits: Number(await cache.get(`helius-credits-hour:${hour}`).catch(() => 0)) || 0 });
  }

  const today = days[days.length - 1];
  const fullDays = days.slice(0, -1).filter(d => d.credits > 0).slice(-7);
  const avg7d = fullDays.length ? Math.round(fullDays.reduce((s, d) => s + d.credits, 0) / fullDays.length) : null;

  // Billing cycle to date and a projection: full days so far at the 7-day average
  // (or today's pace when there is no history yet). The cycle starts on the plan's
  // billing day (HELIUS_BILLING_DAY), which is when Helius resets the credits.
  const cycle = billingCycle(now);
  const cycleStartDay = utcDay(cycle.start);
  const month = cycleStartDay.slice(0, 7);
  const monthToDate = days.filter(d => d.date >= cycleStartDay).reduce((s, d) => s + d.credits, 0);
  const d = new Date(now);
  const dayFraction = (now - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86400000;
  const perDay = avg7d ?? (dayFraction > 0.05 ? today.credits / dayFraction : null);
  const remainingDays = (cycle.end - now) / 86400000;
  const projected = perDay != null ? Math.round(monthToDate + perDay * remainingDays) : null;

  const value = {
    generatedAt: new Date(now).toISOString(),
    today,
    yesterday: days[days.length - 2],
    avg7d,
    month: {
      month,
      billingDay: BILLING_DAY,
      cycleStart: cycleStartDay,
      cycleEnd: utcDay(cycle.end),
      toDate: monthToDate,
      projected,
      budget: MONTHLY_BUDGET,
      budgetPct: projected != null ? Math.round((projected / MONTHLY_BUDGET) * 1000) / 10 : null,
      toDatePct: Math.round((monthToDate / MONTHLY_BUDGET) * 1000) / 10,
    },
    days,
    hours,
    thisProcess: {
      role,
      since: new Date(processTotals.since).toISOString(),
      credits: processTotals.credits,
      calls: processTotals.calls,
      byMethod: mergeRows(
        Object.fromEntries([...processTotals.methods].map(([k, v]) => [k, v.credits])),
        Object.fromEntries([...processTotals.methods].map(([k, v]) => [k, v.calls])),
      ),
    },
  };
  usageCache = { at: Date.now(), value };
  return value;
}

/** Short form for /health/detailed: today and yesterday totals plus today's methods. */
async function getSummary() {
  const u = await getUsage();
  return {
    today: { date: u.today.date, credits: u.today.credits, calls: u.today.calls,
      byMethod: Object.fromEntries(u.today.byMethod.map(r => [r.name, r.credits])) },
    yesterday: { date: u.yesterday.date, credits: u.yesterday.credits },
    thisProcess: { credits: u.thisProcess.credits, byMethod: Object.fromEntries(u.thisProcess.byMethod.map(r => [r.name, r.credits])) },
  };
}

module.exports = {
  count,
  flush,
  withSource,
  currentSource,
  setProcessRole,
  requestMiddleware,
  normalizePath,
  getUsage,
  getSummary,
  billingCycle,
  MONTHLY_BUDGET,
};
