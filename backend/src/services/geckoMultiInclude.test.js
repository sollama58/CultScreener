/**
 * getMultiTokenInfo only stops sending include=top_pools when GeckoTerminal rejects the
 * parameter (400/422). A transient failure falls back for that one call and the next call
 * asks for top_pools again. GeckoTerminal is stubbed at axios.create; nothing here reaches
 * the live API.
 */
const { test, before } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const TOKEN = 'Foo1111111111111111111111111111111111111111';
const calls = [];
let failNextInclude = null;
let gecko;

before(() => {
  const realCreate = axios.create;
  axios.create = (cfg) => {
    const inst = realCreate.call(axios, cfg);
    inst.get = async (url, opts = {}) => {
      const include = opts.params?.include;
      calls.push({ url, include });
      if (include && failNextInclude) {
        const status = failNextInclude;
        failNextInclude = null;
        throw Object.assign(new Error(`status ${status}`), { response: { status } });
      }
      return { data: { data: [{ id: `solana_${TOKEN}`, type: 'token', attributes: { address: TOKEN, price_usd: '1.5' } }] } };
    };
    return inst;
  };
  gecko = require('./geckoTerminal');
  // No COINGECKO_API_KEY here, so the limiter is paced for the free API; requests are stubbed
  Object.assign(require('./rateLimiter').RATE_LIMITS.geckoTerminal, { minInterval: 0, maxJitter: 0, burstLimit: 1000 });
});

test('a 5xx on the include request falls back once and keeps include for later calls', async () => {
  failNextInclude = 503;
  calls.length = 0;
  const first = await gecko.getMultiTokenInfo([TOKEN]);
  assert.strictEqual(first[TOKEN].price, 1.5);
  assert.deepStrictEqual(calls.map(c => c.include), ['top_pools', undefined]);

  calls.length = 0;
  await gecko.getMultiTokenInfo([TOKEN]);
  assert.deepStrictEqual(calls.map(c => c.include), ['top_pools']);
});

test('a 400 on the include request disables include for the session', async () => {
  failNextInclude = 400;
  calls.length = 0;
  await gecko.getMultiTokenInfo([TOKEN]);
  assert.deepStrictEqual(calls.map(c => c.include), ['top_pools', undefined]);

  calls.length = 0;
  await gecko.getMultiTokenInfo([TOKEN]);
  assert.deepStrictEqual(calls.map(c => c.include), [undefined]);
});
