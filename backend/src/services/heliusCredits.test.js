/**
 * Helius credit tracking: counts by method, by source (async context) and by
 * hour, flushed to the in-memory cache and read back for the admin view.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');

delete process.env.REDIS_URL;

const credits = require('./heliusCredits');
const { rateLimitedRequest } = require('./rateLimiter');

describe('heliusCredits', () => {
  test('normalizePath collapses mints, signatures and numbers', () => {
    assert.strictEqual(
      credits.normalizePath('/api/tokens/Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk/holders?fresh=true'),
      '/api/tokens/:id/holders'
    );
    assert.strictEqual(credits.normalizePath('/api/admin/bugs/42'), '/api/admin/bugs/:n');
  });

  test('counts calls and credits by method and by source, and reads them back', async () => {
    credits.count('getBalance', 1);
    await credits.withSource('job:snapshot-holders', async () => {
      credits.count('getTokenAccounts', 10);
      credits.count('getTokenAccounts', 10);
      // A queued request runs in its caller's context, not the queue loop's
      await rateLimitedRequest('helius', async () => credits.count('getTransactionsForAddress', 10));
      credits.count('getTransactionsForAddress', 20, 0); // extra credits on the same call
    });

    const u = await credits.getUsage({ fresh: true });
    const today = u.today;
    assert.strictEqual(today.credits, 51);
    assert.strictEqual(today.calls, 4);

    const das = today.byMethod.find(r => r.name === 'getTokenAccounts');
    assert.deepStrictEqual({ credits: das.credits, calls: das.calls }, { credits: 20, calls: 2 });
    const gtfa = today.byMethod.find(r => r.name === 'getTransactionsForAddress');
    assert.deepStrictEqual({ credits: gtfa.credits, calls: gtfa.calls }, { credits: 30, calls: 1 });
    assert.strictEqual(today.byMethod[0].name, 'getTransactionsForAddress'); // sorted by credits

    const job = today.bySource.find(r => r.name === 'job:snapshot-holders');
    assert.deepStrictEqual({ credits: job.credits, calls: job.calls }, { credits: 50, calls: 3 });
    assert.ok(today.bySource.find(r => r.name === 'api:background' && r.credits === 1));

    assert.strictEqual(u.hours.length, 48);
    assert.strictEqual(u.hours[u.hours.length - 1].credits, 51);
    assert.strictEqual(u.days.length, 31);
    assert.strictEqual(u.month.toDate, 51);
    assert.ok(u.month.budget > 0);
    assert.strictEqual(u.thisProcess.credits, 51);
  });

  test('summary for /health/detailed keeps the old shape', async () => {
    const s = await credits.getSummary();
    assert.strictEqual(typeof s.today.credits, 'number');
    assert.strictEqual(typeof s.today.byMethod, 'object');
    assert.strictEqual(typeof s.yesterday.credits, 'number');
  });
});
