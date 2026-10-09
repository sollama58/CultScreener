/**
 * The batch-view-counts job must outlast a DB blip (audit #48). bullmq is replaced
 * with an in-process stub so nothing touches a real Redis.
 */
const { test } = require('node:test');
const assert = require('node:assert');

process.env.REDIS_URL = 'redis://stub.invalid:6379';
process.env.VIEW_FLUSH_INTERVAL_MS = '60000';

const added = [];
const schedulers = new Map(); // id -> opts (shared by every queue; ids are unique)
class FakeQueue {
  constructor(name, opts) { this.name = name; this.opts = opts; }
  async add(name, data, opts) { added.push({ queue: this.name, name, data, opts }); return { id: String(added.length) }; }
  async getRepeatableJobs() { return []; }
  async removeJobScheduler(id) { schedulers.delete(id); }
  async getJobScheduler(id) { return schedulers.get(id); }
  async upsertJobScheduler(id, opts) { schedulers.set(id, opts); }
  async close() {}
}
const bullmqPath = require.resolve('bullmq');
require.cache[bullmqPath] = { id: bullmqPath, filename: bullmqPath, loaded: true, exports: { Queue: FakeQueue } };

const jobQueue = require('./jobQueue');

test('queued view counts get enough retries to survive the DB recovery window (audit #48)', async () => {
  assert.strictEqual(jobQueue.initialize(), true);
  await jobQueue.incrementViewCount('MintA');
  await jobQueue.flushViewCounts();

  const job = added.find((j) => j.name === 'batch-view-counts');
  assert.ok(job, 'a batch-view-counts job is queued');
  assert.deepStrictEqual(job.data.updates, [{ tokenMint: 'MintA', count: 1 }]);
  assert.ok(job.opts.attempts >= 10, `attempts=${job.opts.attempts}`);
  // Retries must span well beyond the 30s database recovery interval.
  const { delay } = job.opts.backoff;
  let span = 0;
  for (let i = 0; i < job.opts.attempts - 1; i++) span += delay * 2 ** i;
  assert.ok(span > 10 * 60 * 1000, `retry span ${span}ms`);
});

test('each view batch carries an id that is also its job id, so a resent add or re-run is applied once (audit #179)', async () => {
  await jobQueue.incrementViewCount('MintB');
  await jobQueue.flushViewCounts();
  const jobs = added.filter((j) => j.name === 'batch-view-counts');
  const job = jobs[jobs.length - 1];
  assert.match(job.data.batchId, /^views-[0-9a-f-]{36}$/);
  assert.strictEqual(job.opts.jobId, job.data.batchId);
  assert.notStrictEqual(jobs[0].data.batchId, job.data.batchId, 'every flush gets a new id');
});

test('a daily schedule re-created after its run time gets one catch-up run for today (audit #128)', async () => {
  schedulers.clear();
  const at = (hhmm) => Date.parse(`2026-10-09T${hhmm}:00Z`);
  const catchUps = () => added.filter((j) => j.data && j.data.catchUp).map((j) => `${j.name}@${j.opts.jobId}`);

  // Redis came back at 00:03: nothing has been missed yet
  await jobQueue.ensureRecurringJobs({ now: at('00:03') });
  assert.deepStrictEqual(catchUps(), []);

  // Redis lost everything again; the next check is at 00:21, past both daily slots
  schedulers.clear();
  await jobQueue.ensureRecurringJobs({ now: at('00:21') });
  assert.deepStrictEqual(catchUps().sort(), [
    'crown-king-of-pill@crown-king-of-pill-catchup-2026-10-09',
    'record-holder-counts@record-holder-counts-catchup-2026-10-09',
  ]);

  // With the schedules in place, later checks queue nothing more
  await jobQueue.ensureRecurringJobs({ now: at('00:26') });
  assert.strictEqual(catchUps().length, 2);
});

test('dailySlotPassed reads the UTC minute and hour of a daily pattern', () => {
  assert.strictEqual(jobQueue.dailySlotPassed('20 0 * * *', Date.parse('2026-10-09T00:19:59Z')), false);
  assert.strictEqual(jobQueue.dailySlotPassed('20 0 * * *', Date.parse('2026-10-09T00:20:00Z')), true);
  assert.strictEqual(jobQueue.dailySlotPassed('0,30 * * * *', Date.parse('2026-10-09T12:00:00Z')), false);
});
