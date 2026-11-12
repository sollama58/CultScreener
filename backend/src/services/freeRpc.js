/**
 * Free public Solana RPC client, used only by New Pairs discovery.
 *
 * Everything else in this codebase talks to Helius through solana.rpcCall, and that
 * chain must never fail over to a public RPC (see the note above RPC_ENDPOINTS in
 * solana.js). This client is the other side of that wall:
 *   - its own endpoint list (NEWPAIRS_RPC_URLS), never shared with rpcCall;
 *   - a Helius URL is refused, so a paid key can't end up here by mistake and spend
 *     credits that nothing counts;
 *   - only the three read methods discovery needs are allowed;
 *   - its own rate limiter queue and circuit breaker ('freeRpc').
 *
 * Public endpoints throttle and truncate history differently (measured 2026-11-11:
 * publicnode answers getTransaction quickly but keeps about a day and a half of
 * history; api.mainnet-beta 429s getTransaction after roughly 60 calls). A call that
 * is throttled, refused or times out moves to the next endpoint, and the throttled
 * one rests for a while. A JSON-RPC error body is an answer, not a dead endpoint,
 * and is thrown to the caller with .rpcCode.
 */

const axios = require('axios');
const { httpsAgent } = require('./httpAgent');
const { rateLimitedRequest } = require('./rateLimiter');
const { circuitBreakers } = require('./circuitBreaker');

const DEFAULT_URLS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
const ALLOWED_METHODS = new Set(['getSignaturesForAddress', 'getTransaction', 'getMultipleAccounts']);
const REST_AFTER_THROTTLE_MS = 60_000;
const REST_AFTER_ERROR_MS = 20_000;

/** Parse NEWPAIRS_RPC_URLS: https only, never Helius, no duplicates. */
function parseUrls(value) {
  const urls = [];
  for (const raw of String(value || '').split(',').map(s => s.trim()).filter(Boolean)) {
    let u;
    try { u = new URL(raw); } catch (_) { continue; }
    if (u.protocol !== 'https:') continue;
    if (/helius/i.test(raw)) continue;
    if (!urls.includes(u.toString())) urls.push(u.toString());
  }
  return urls;
}

/** Host only: a configured URL may carry a key in its path or query. */
function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return 'invalid-url'; }
}

function createClient({
  urls = parseUrls(process.env.NEWPAIRS_RPC_URLS),
  post = (url, body, timeout) => axios.post(url, body, { timeout, httpsAgent }),
  limit = (fn) => rateLimitedRequest('freeRpc', fn),
  breaker = circuitBreakers.freeRpc,
  now = () => Date.now(),
} = {}) {
  const endpoints = (urls.length ? urls : DEFAULT_URLS).map(url => ({ url, host: hostOf(url), restUntil: 0, ok: 0, throttled: 0, failed: 0 }));

  /** Endpoints in configured order, the resting ones last (still tried: all may be resting). */
  function order() {
    const t = now();
    return [...endpoints.filter(e => e.restUntil <= t), ...endpoints.filter(e => e.restUntil > t)];
  }

  async function attempt(endpoint, method, params, timeout) {
    const response = await limit(() => post(endpoint.url, { jsonrpc: '2.0', id: 1, method, params }, timeout));
    const data = response && response.data;
    if (!data || typeof data !== 'object') throw new Error('Empty or malformed RPC response');
    if (data.error) {
      const err = new Error(String(data.error.message || data.error.code || 'RPC error').slice(0, 200));
      err.rpcCode = data.error.code ?? -1;
      throw err;
    }
    return data.result;
  }

  // -32005 (node behind / rate limited) and -32429-style bodies are throttling, not answers
  const isThrottleCode = (code) => code === -32005 || code === 429 || code === -32429;

  async function call(method, params = [], { timeout = 12000 } = {}) {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`freeRpc: method ${method} is not allowed`);
    return breaker.execute(async () => {
      let lastError;
      for (const endpoint of order()) {
        try {
          const result = await attempt(endpoint, method, params, timeout);
          endpoint.ok++;
          return result;
        } catch (error) {
          if (error.isOverloaded) throw error; // our own queue is full: stop, don't pile on
          if (error.rpcCode != null && !isThrottleCode(error.rpcCode)) throw error;
          const status = error.response?.status;
          const throttled = status === 429 || status === 403 || isThrottleCode(error.rpcCode);
          if (throttled) endpoint.throttled++; else endpoint.failed++;
          endpoint.restUntil = now() + (throttled ? REST_AFTER_THROTTLE_MS : REST_AFTER_ERROR_MS);
          // Never the URL or the axios error itself: both can carry a key
          lastError = new Error(`freeRpc ${method} failed on ${endpoint.host}: ${status || error.code || String(error.message || '').slice(0, 80)}`);
          lastError.status = status;
        }
      }
      throw lastError || new Error('freeRpc: no endpoints configured');
    });
  }

  return {
    call,
    hosts: () => endpoints.map(e => e.host),
    stats: () => endpoints.map(({ host, ok, throttled, failed, restUntil }) => ({ host, ok, throttled, failed, resting: restUntil > now() })),
  };
}

let shared = null;
/** The process-wide client (built on first use so tests can set the env first). */
function client() {
  if (!shared) shared = createClient();
  return shared;
}

module.exports = {
  call: (...args) => client().call(...args),
  stats: () => client().stats(),
  createClient,
  parseUrls,
  ALLOWED_METHODS,
  DEFAULT_URLS,
};
