const { test } = require('node:test');
const assert = require('node:assert');

const { CircuitBreaker, STATES } = require('./circuitBreaker');

function makeBreaker() {
  return new CircuitBreaker({
    name: 'test',
    failureThreshold: 1,
    resetTimeout: 10,
    isFailure: (err) => err.status !== 429
  });
}

const rateLimited = () => Promise.reject(Object.assign(new Error('429'), { status: 429 }));
const ok = () => Promise.resolve('ok');

test('HALF_OPEN trials that end in non-failure errors give their slot back (audit #2)', async () => {
  const cb = makeBreaker();
  cb.trip();
  cb.lastFailureTime = Date.now() - 1000;

  for (let i = 0; i < 10; i++) {
    await assert.rejects(cb.execute(rateLimited), /429/);
  }
  assert.strictEqual(cb.state, STATES.HALF_OPEN);

  // The service is healthy again: the breaker must let trials through and close.
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(await cb.execute(ok), 'ok');
  }
  assert.strictEqual(cb.state, STATES.CLOSED);
});

test('HALF_OPEN still caps concurrent trials', async () => {
  const cb = makeBreaker();
  cb.trip();
  cb.lastFailureTime = Date.now() - 1000;

  let release;
  const gate = new Promise(r => { release = r; });
  const inFlight = [];
  for (let i = 0; i < cb.halfOpenMaxAttempts; i++) inFlight.push(cb.execute(() => gate));
  await assert.rejects(cb.execute(ok), { name: 'CircuitBreakerError' });
  release('ok');
  await Promise.all(inFlight);
  assert.strictEqual(cb.state, STATES.CLOSED);
});

test('a failure in HALF_OPEN reopens the breaker', async () => {
  const cb = makeBreaker();
  cb.trip();
  cb.lastFailureTime = Date.now() - 1000;
  await assert.rejects(cb.execute(() => Promise.reject(new Error('boom'))), /boom/);
  assert.strictEqual(cb.state, STATES.OPEN);
});

test('Helius breakers ignore our own queue overload and open-breaker errors (audit #94)', () => {
  const { circuitBreakers, CircuitBreakerError } = require('./circuitBreaker');
  const queueFull = Object.assign(new Error('API queue full - server overloaded. Try again later.'), { isOverloaded: true });
  const queueTimeout = Object.assign(new Error('Request timed out waiting in queue'), { isOverloaded: true });
  const open = new CircuitBreakerError('open', 'solanaRpc', STATES.OPEN, 1000);
  for (const name of ['helius', 'heliusDas']) {
    const cb = circuitBreakers[name];
    assert.strictEqual(cb.isFailure(queueFull), false, `${name}: queue full`);
    assert.strictEqual(cb.isFailure(queueTimeout), false, `${name}: queue timeout`);
    assert.strictEqual(cb.isFailure(open), false, `${name}: open breaker`);
    assert.strictEqual(cb.isFailure({ response: { status: 429 } }), false, `${name}: 429`);
    assert.strictEqual(cb.isFailure({ response: { status: 502 } }), true, `${name}: 5xx`);
    assert.strictEqual(cb.isFailure(Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' })), true, `${name}: timeout`);
    assert.strictEqual(cb.isFailure({ response: { status: 400 } }), false, `${name}: 4xx`);
  }
});
