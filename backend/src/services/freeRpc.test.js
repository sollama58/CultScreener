/**
 * The free RPC client is the only code allowed to talk to a public RPC. These pin the
 * wall around it: no Helius URL, three read methods, rotation on throttling, and a
 * JSON-RPC error treated as an answer.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { createClient, parseUrls, ALLOWED_METHODS } = require('./freeRpc');

const passThrough = { execute: (fn) => fn() };
const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

function client(handlers, extra = {}) {
  const calls = [];
  const urls = Object.keys(handlers);
  const c = createClient({
    urls,
    post: async (url, body) => { calls.push({ url, method: body.method }); return handlers[url](body); },
    limit: (fn) => fn(),
    breaker: passThrough,
    ...extra,
  });
  return { c, calls };
}

test('parseUrls drops Helius, non-https and malformed URLs', () => {
  assert.deepStrictEqual(
    parseUrls('https://a.example/rpc, https://mainnet.helius-rpc.com/?api-key=secret, http://plain.example, nonsense, https://a.example/rpc'),
    ['https://a.example/rpc']
  );
  assert.deepStrictEqual(parseUrls(''), []);
  assert.deepStrictEqual(parseUrls('https://rpc.HELIUS.xyz'), []);
});

test('only the read methods discovery needs are allowed', async () => {
  const { c, calls } = client({ 'https://a.example/': async () => ({ data: { result: 1 } }) });
  for (const method of ['getProgramAccounts', 'getTokenLargestAccounts', 'sendTransaction', 'getTransactionsForAddress']) {
    await assert.rejects(() => c.call(method, []), /not allowed/);
  }
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual([...ALLOWED_METHODS].sort(), ['getMultipleAccounts', 'getSignaturesForAddress', 'getTransaction']);
});

test('a throttled endpoint is skipped and rests; the next one answers', async () => {
  let t = 1_000_000;
  const { c, calls } = client({
    'https://a.example/': async () => { throw httpError(429); },
    'https://b.example/': async () => ({ data: { result: 'ok' } }),
  }, { now: () => t });
  assert.strictEqual(await c.call('getTransaction', ['sig']), 'ok');
  assert.deepStrictEqual(calls.map(x => x.url), ['https://a.example/', 'https://b.example/']);
  // While a rests, b is tried first
  assert.strictEqual(await c.call('getTransaction', ['sig']), 'ok');
  assert.strictEqual(calls[2].url, 'https://b.example/');
  assert.strictEqual(calls.length, 3);
  // After the rest, a is first again
  t += 61_000;
  await c.call('getTransaction', ['sig']);
  assert.strictEqual(calls[3].url, 'https://a.example/');
  assert.deepStrictEqual(c.stats().map(s => [s.host, s.ok, s.throttled]), [['a.example', 0, 2], ['b.example', 3, 0]]);
});

test('a JSON-RPC error body is an answer: thrown with rpcCode, no rotation', async () => {
  const { c, calls } = client({
    'https://a.example/': async () => ({ data: { error: { code: -32015, message: 'Transaction version (1) is not supported' } } }),
    'https://b.example/': async () => ({ data: { result: 'never' } }),
  });
  await assert.rejects(() => c.call('getTransaction', ['sig']), (e) => e.rpcCode === -32015);
  assert.strictEqual(calls.length, 1);
});

test('when every endpoint fails the error names the host and status, never the URL', async () => {
  const { c } = client({
    'https://a.example/secret-key-path': async () => { throw httpError(403); },
    'https://b.example/?api-key=hunter2': async () => { throw Object.assign(new Error('timeout of 12000ms exceeded https://b.example/?api-key=hunter2'), { code: 'ECONNABORTED' }); },
  });
  await assert.rejects(() => c.call('getSignaturesForAddress', ['addr']), (e) => {
    assert.match(e.message, /b\.example: ECONNABORTED/);
    assert.doesNotMatch(e.message, /hunter2|secret-key-path/);
    assert.strictEqual(e.rpcCode, undefined);
    return true;
  });
});

test('a full local queue stops the rotation instead of trying every endpoint', async () => {
  const overloaded = Object.assign(new Error('queue full'), { isOverloaded: true });
  const calls = [];
  const c = createClient({
    urls: ['https://a.example/', 'https://b.example/'],
    post: async (url) => { calls.push(url); return { data: { result: 1 } }; },
    limit: async () => { throw overloaded; },
    breaker: passThrough,
  });
  await assert.rejects(() => c.call('getTransaction', ['sig']), (e) => e.isOverloaded === true);
  assert.strictEqual(calls.length, 0);
});

test('the real breaker does not count JSON-RPC answers or local backpressure as failures', () => {
  const { circuitBreakers } = require('./circuitBreaker');
  const isFailure = circuitBreakers.freeRpc.isFailure || circuitBreakers.freeRpc.options?.isFailure;
  assert.strictEqual(typeof isFailure, 'function');
  assert.strictEqual(isFailure(Object.assign(new Error('x'), { rpcCode: -32015 })), false);
  assert.strictEqual(isFailure(Object.assign(new Error('x'), { isOverloaded: true })), false);
  assert.strictEqual(isFailure(new Error('freeRpc getTransaction failed on a.example: 429')), true);
});
