/**
 * Regression tests for solana.js helpers. axios is stubbed; nothing leaves the process.
 * Runs in its own process (node --test isolates files), so module-level latches start fresh.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'test-key';
delete process.env.HELIUS_RPC_URL;
delete process.env.REDIS_URL;

const axios = require('axios');
const solana = require('./solana');
const { cache } = require('./cache');

describe('solana', () => {
  const realPost = axios.post;
  let answer;
  before(() => { axios.post = async (url, body) => answer(body); });
  after(() => { axios.post = realPost; });

  test('a DAS error on a middle page does not return or cache an undercount (audit #16)', async () => {
    const mint = 'MidPageErrorMint1111111111111111111111111111';
    answer = (body) => {
      const page = body.params.page;
      if (page <= 3) {
        return { data: { result: { token_accounts: Array.from({ length: 1000 }, (_, i) => ({ owner: `w${page}-${i}`, amount: '1' })) } } };
      }
      return { data: { error: { code: -32603, message: 'Internal error' } } };
    };
    const count = await solana.getTokenHolderCount(mint, { skipCache: true });
    assert.strictEqual(count, null);
    assert.strictEqual(await cache.get(`holder-total:${mint}`), undefined);
  });

  test('a complete DAS scan is returned and cached', async () => {
    const mint = 'CompleteScanMint111111111111111111111111111';
    answer = (body) => body.params.page === 1
      ? { data: { result: { token_accounts: [{ owner: 'a', amount: '1' }, { owner: 'b', amount: '2' }] } } }
      : { data: { result: { token_accounts: [] } } };
    assert.strictEqual(await solana.getTokenHolderCount(mint, { skipCache: true }), 2);
    assert.strictEqual(await cache.get(`holder-total:${mint}`), 2);
  });
});
