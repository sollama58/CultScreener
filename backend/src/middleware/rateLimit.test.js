/**
 * defaultLimiter mounted twice on one request (globally in app.js and again on a route)
 * must count once; viewLimiter answers 200 without a views field once over its budget.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.RATE_LIMIT_MAX_REQUESTS = '3';
const { defaultLimiter, viewLimiter, adminLoginLimiter, clientKey } = require('./rateLimit');

async function serve(app, fn) {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('defaultLimiter counts a request once even when mounted twice', async () => {
  const app = express();
  app.use('/api/', defaultLimiter);
  app.get('/api/thing', defaultLimiter, (req, res) => res.json({ ok: true }));
  await serve(app, async (base) => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${base}/api/thing`)).status);
    // Budget of 3: three succeed (not just one or two), the fourth is limited
    assert.deepStrictEqual(statuses, [200, 200, 200, 429]);
  });
});

test('viewLimiter: per IP and token, over budget answers 200 without views', async () => {
  const app = express();
  app.post('/api/tokens/:mint/view', viewLimiter, (req, res) => res.json({ views: 7 }));
  await serve(app, async (base) => {
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${base}/api/tokens/MintA/view`, { method: 'POST' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await r.json()).views, 7);
    }
    const over = await fetch(`${base}/api/tokens/MintA/view`, { method: 'POST' });
    assert.strictEqual(over.status, 200);
    assert.deepStrictEqual(await over.json(), { recorded: false });
    // Another token has its own budget
    const other = await fetch(`${base}/api/tokens/MintB/view`, { method: 'POST' });
    assert.strictEqual((await other.json()).views, 7);
  });
});

test('clientKey: IPv4 as is, IPv6 cut to its /64, IPv4-mapped IPv6 as the IPv4 address', () => {
  assert.strictEqual(clientKey({ ip: '203.0.113.7' }), '203.0.113.7');
  assert.strictEqual(clientKey({ ip: '::ffff:203.0.113.7' }), '203.0.113.7');
  // Every address inside one /64 shares a key, so rotating through it buys no extra budget
  const a = clientKey({ ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' });
  assert.strictEqual(a, '2001:db8:1:2::/64');
  assert.strictEqual(clientKey({ ip: '2001:db8:1:2::1' }), a);
  assert.strictEqual(clientKey({ ip: '2001:0db8:0001:0002:0:0:0:ffff' }), a);
  assert.notStrictEqual(clientKey({ ip: '2001:db8:1:3::1' }), a);
  assert.strictEqual(clientKey({ ip: '2001:db8::1' }), '2001:db8:0:0::/64');
});

test('adminLoginLimiter counts failed logins only', async () => {
  const app = express();
  app.use(express.json());
  app.post('/login', adminLoginLimiter, (req, res) => (
    req.body.password === 'right' ? res.json({ success: true }) : res.status(401).json({ error: 'Invalid password' })
  ));
  const login = (base, password) => fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
  }).then(r => r.status);
  await serve(app, async (base) => {
    // Many successful logins (one per new admin tab) never use up the budget
    for (let i = 0; i < 8; i++) assert.strictEqual(await login(base, 'right'), 200);
    // Five failures do, and then even the right password waits
    for (let i = 0; i < 5; i++) assert.strictEqual(await login(base, 'wrong'), 401);
    assert.strictEqual(await login(base, 'wrong'), 429);
    assert.strictEqual(await login(base, 'right'), 429);
  });
});
