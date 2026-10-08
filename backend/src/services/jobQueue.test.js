/**
 * View-count buffering in jobQueue.js. No REDIS_URL, so flushes take the direct-DB
 * path; ./database is replaced with a stub before jobQueue loads it.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

delete process.env.REDIS_URL;
process.env.VIEW_FLUSH_INTERVAL_MS = '30';

const writes = [];
const fakeDb = {
  ready: false,
  isReady() { return this.ready; },
  pool: { query: async (sql, [mints, counts]) => { writes.push(...mints.map((m, i) => [m, counts[i]])); } },
};
const dbPath = path.join(__dirname, 'database.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const jobQueue = require('./jobQueue');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('views kept in the buffer after a failed flush are flushed without waiting for another view (audit #47)', async () => {
  await jobQueue.incrementViewCount('MintA');
  await jobQueue.incrementViewCount('MintA');
  await wait(80);
  // DB was not ready: the counts are retained.
  assert.deepStrictEqual(jobQueue.getBufferedViewCounts(['MintA']), { MintA: 2 });
  assert.strictEqual(writes.length, 0);

  // No further views arrive. Once the DB is back the retained counts still get written.
  fakeDb.ready = true;
  await wait(120);
  assert.deepStrictEqual(writes, [['MintA', 2]]);
  assert.deepStrictEqual(jobQueue.getBufferedViewCounts(['MintA']), {});
});
