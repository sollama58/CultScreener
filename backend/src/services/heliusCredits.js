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

async function flush() {
  if (!buffer.day) return;
  const { methods, sources, hours, day } = buffer;
  buffer = { methods: new Map(), sources: new Map(), hours: new Map(), day: null };
  const ops = [];
  let total = 0;
  for (const [method, { credits, calls }] of methods) {
    total += credits;
    if (credits) ops.push(cache.incrBy(`helius-credits:${day}:${method}`, credits, DAY_KEY_TTL));
    if (calls) ops.push(cache.incrBy(`helius-calls:${day}:${method}`, calls, DAY_KEY_TTL));
  }
  for (const [source, { credits, calls }] of sources) {
    if (credits) ops.push(cache.incrBy(`helius-src-credits:${day}:${source}`, credits, DAY_KEY_TTL));
    if (calls) ops.push(cache.incrBy(`helius-src-calls:${day}:${source}`, calls, DAY_KEY_TTL));
  }
  for (const [hour, credits] of hours) {
    if (credits) ops.push(cache.incrBy(`helius-credits-hour:${hour}`, credits, HOUR_KEY_TTL));
  }
  if (total) ops.push(cache.incrBy(`helius-credits:${day}`, total, DAY_KEY_TTL));
  await Promise.all(ops.map(p => Promise.resolve(p).catch(() => {})));
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
  const [methodCredits, methodCalls, srcCredits, srcCalls] = await Promise.all([
    readGrouped('helius-credits'),
    readGrouped('helius-calls'),
    readGrouped('helius-src-credits'),
    readGrouped('helius-src-calls'),
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
      // larger in case one write was lost
      credits: Math.max(total, byMethod.reduce((s, r) => s + r.credits, 0)),
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

  // Month to date and a projection: full days so far at the 7-day average (or
  // today's pace when there is no history yet)
  const month = today.date.slice(0, 7);
  const monthToDate = days.filter(d => d.date.startsWith(month)).reduce((s, d) => s + d.credits, 0);
  const d = new Date(now);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const dayFraction = (now - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86400000;
  const perDay = avg7d ?? (dayFraction > 0.05 ? today.credits / dayFraction : null);
  const remainingDays = daysInMonth - (d.getUTCDate() - 1) - dayFraction;
  const projected = perDay != null ? Math.round(monthToDate + perDay * remainingDays) : null;

  const value = {
    generatedAt: new Date(now).toISOString(),
    today,
    yesterday: days[days.length - 2],
    avg7d,
    month: {
      month,
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
  MONTHLY_BUDGET,
};
