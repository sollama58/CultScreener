/**
 * New Pairs replay: does the score, as weighted, pick tokens that turn out well?
 *
 * Two halves, both pure.
 *
 * Marks. As a listed token passes 1, 3, 7 and 14 days since bonding, the scoring run
 * stores what the scorer saw at that moment: the full feature set, the score, and the
 * holder count, market cap and liquidity (newPairMarket.scoreActive → newpair_tokens.marks,
 * copied to newpair_archive when the token ages out). The features are stored, not just
 * the score, so a different weight set can be scored against the same history later.
 *
 * Replay. For each weight set: rank every token by its re-scored day-1 (or day-3)
 * features inside its bonding week, take the top N, and count how many were still alive
 * and had more holders at day 7 and day 14. Next to it, the same count for all tokens
 * (the base rate): a weight set is only worth anything by how far it beats that.
 */
const { PARAMS, DAY, HOUR, scoreToken } = require('./newPairScore');

const MARK_DAYS = [1, 3, 7, 14];
// A token first scored long after a mark does not get that mark filled in with late data
const MARK_TOLERANCE_MS = 12 * HOUR;
const WEEK = 7 * DAY;

/** The marks a token of this age should get now: passed, not yet stored, and not too late. */
function dueMarks(ageMs, marks = {}) {
  return MARK_DAYS.filter(d => ageMs >= d * DAY && ageMs < d * DAY + MARK_TOLERANCE_MS && !(marks && marks[d]));
}

/** Features as stored: numbers to 4 significant digits, nothing null. Keeps a mark near 400 bytes. */
function compactFeatures(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) {
    if (typeof v === 'boolean') { if (v) out[k] = true; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[k] = v === 0 ? 0 : Number(v.toPrecision(4));
  }
  return out;
}

/** One mark, from what the scoring run has in hand. */
function buildMark({ at, ageMs, score, rugged, features, holders, mcap, liquidity }) {
  return {
    at, ageH: Math.round((ageMs / HOUR) * 10) / 10, score, rugged: !!rugged,
    holders: holders ?? null, mcap: mcap ?? null, liquidity: liquidity ?? null,
    f: compactFeatures(features),
  };
}

/** Alive and growing: not rugged at the later mark, and more holders than at the earlier one. */
function succeeded(entry, outcome) {
  return !outcome.rugged && outcome.holders != null && entry.holders != null && outcome.holders > entry.holders;
}

/** The weight sets compared: the current one, each weight up and down by half, and two structural ones. */
function paramSets(P = PARAMS) {
  const clone = () => JSON.parse(JSON.stringify(P));
  const sets = [{ label: 'current weights', params: P }];
  for (const key of Object.keys(P.weights)) {
    for (const [word, factor] of [['+50%', 1.5], ['-50%', 0.5]]) {
      const params = clone();
      params.weights[key] = P.weights[key] * factor;
      sets.push({ label: `${key} ${word}`, params });
    }
  }
  const holdersOnly = clone();
  for (const key of Object.keys(P.weights)) if (!P.holderTerms.includes(key)) holdersOnly.weights[key] = 0;
  sets.push({ label: 'holder terms only', params: holdersOnly });
  const noRisk = clone();
  noRisk.risk.wash.floor = 1; noRisk.risk.sybil.floor = 1; noRisk.risk.whale.floor = 1; noRisk.risk.bundle = 1; noRisk.risk.rug.factor = 1;
  sets.push({ label: 'no risk factors', params: noRisk });
  return sets;
}

/**
 * @param {Array<{mint, graduatedAt:number, marks:Object}>} rows
 * @returns {{tokens, pairs: Array<{entryDay, outcomeDay, eligible, baseRate, sets: Array<{label, picked, hits, rate, lift}>}>, terms: Array}}
 */
function replay(rows, { sets = paramSets(), topN = 20, entryDays = [1, 3], outcomeDays = [7, 14] } = {}) {
  const pairs = [];
  for (const entryDay of entryDays) {
    for (const outcomeDay of outcomeDays) {
      const eligible = rows.filter(r => r.marks?.[entryDay]?.f && r.marks?.[outcomeDay]);
      const wins = eligible.filter(r => succeeded(r.marks[entryDay], r.marks[outcomeDay])).length;
      const baseRate = eligible.length ? wins / eligible.length : null;
      const weeks = new Map();
      for (const r of eligible) {
        const w = Math.floor(r.graduatedAt / WEEK);
        if (!weeks.has(w)) weeks.set(w, []);
        weeks.get(w).push(r);
      }
      const results = sets.map(({ label, params }) => {
        let picked = 0; let hits = 0;
        for (const cohort of weeks.values()) {
          const ranked = cohort
            .map(r => ({ r, score: scoreToken(r.marks[entryDay].f, params).score }))
            .filter(x => x.score != null)
            .sort((a, b) => b.score - a.score || (a.r.mint < b.r.mint ? -1 : 1))
            .slice(0, topN);
          picked += ranked.length;
          hits += ranked.filter(x => succeeded(x.r.marks[entryDay], x.r.marks[outcomeDay])).length;
        }
        const rate = picked ? hits / picked : null;
        return { label, picked, hits, rate, lift: rate != null && baseRate ? rate / baseRate : null };
      });
      pairs.push({ entryDay, outcomeDay, eligible: eligible.length, weeks: weeks.size, baseRate, sets: results });
    }
  }
  return { tokens: rows.length, topN, pairs, terms: termTable(rows) };
}

/**
 * Does each term predict anything on its own? Tokens in the top fifth by a term at day 1,
 * and how often they were alive and growing at day 7, against everyone with that term.
 */
function termTable(rows, { entryDay = 1, outcomeDay = 7, P = PARAMS } = {}) {
  const eligible = rows.filter(r => r.marks?.[entryDay]?.f && r.marks?.[outcomeDay]);
  return Object.keys(P.weights).map(key => {
    const have = eligible
      .map(r => ({ r, v: scoreToken(r.marks[entryDay].f, P).terms[key] }))
      .filter(x => typeof x.v === 'number')
      .sort((a, b) => b.v - a.v);
    const ok = x => succeeded(x.r.marks[entryDay], x.r.marks[outcomeDay]);
    const top = have.slice(0, Math.max(1, Math.floor(have.length / 5)));
    const baseRate = have.length ? have.filter(ok).length / have.length : null;
    const topRate = have.length ? top.filter(ok).length / top.length : null;
    return { term: key, withData: have.length, baseRate, topRate, lift: topRate != null && baseRate ? topRate / baseRate : null };
  });
}

module.exports = { MARK_DAYS, MARK_TOLERANCE_MS, dueMarks, compactFeatures, buildMark, succeeded, paramSets, replay, termTable };
