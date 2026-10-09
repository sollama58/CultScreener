/**
 * /health/ready is public and unthrottled, so a failing database check must not echo the pg
 * driver's error text (DB host, address, user) to the caller (audit #52).
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const db = require('../services/database');
const saved = { isReady: db.isReady, checkHealth: db.checkHealth };
const savedUrl = process.env.DATABASE_URL;

const router = require('./health');
const app = express();
app.use('/health', router);
const server = app.listen(0);

after(() => {
  Object.assign(db, saved);
  if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  server.close();
});

test('/health/ready reports an unavailable database without the driver error', async () => {
  process.env.DATABASE_URL = 'postgres://example';
  db.isReady = () => false;
  db.checkHealth = async () => ({ healthy: false, error: 'getaddrinfo ENOTFOUND dpg-secret-host.oregon-postgres.render.com', isConnected: false });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/health/ready`);
  assert.strictEqual(res.status, 503);
  const text = await res.text();
  assert.ok(!text.includes('dpg-secret-host'), text);
  assert.deepStrictEqual(JSON.parse(text), { ready: false, reason: 'database_unavailable' });
});

test('/health/ready hides a thrown error message too', async () => {
  process.env.DATABASE_URL = 'postgres://example';
  db.isReady = () => false;
  db.checkHealth = async () => { throw new Error('password authentication failed for user "holdex_user"'); };
  const res = await fetch(`http://127.0.0.1:${server.address().port}/health/ready`);
  assert.strictEqual(res.status, 503);
  assert.ok(!(await res.text()).includes('holdex_user'));
});
