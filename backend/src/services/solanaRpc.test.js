/**
 * rpcCall routing: every call goes to Helius, and a JSON-RPC error answer is
 * never re-sent to another endpoint. axios is stubbed; nothing leaves the process.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'test-key';
delete process.env.HELIUS_RPC_URL;
delete process.env.REDIS_URL;

const axios = require('axios');
const solana = require('./solana');

describe('rpcCall', () => {
  const realPost = axios.post;
  let calls;
  let answer;
  before(() => {
    axios.post = async (url, body) => { calls.push({ url, method: body.method, params: body.params }); return answer(body); };
  });
  after(() => { axios.post = realPost; });

  test('only Helius endpoints are configured', () => {
    const urls = solana._rpcChains.helius.endpoints;
    assert.ok(urls.length > 0);
    for (const u of urls) assert.match(new URL(u).hostname, /helius/);
  });

  test('a JSON-RPC error is returned once, not retried on another endpoint', async () => {
    calls = [];
    answer = () => ({ data: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } } });
    await assert.rejects(solana.rpcCall('getAccountInfo', ['x']), err => err.rpcCode === -32602);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].url, /helius/);
  });

  test('getTransactionsForAddress pages: small pages, and a method refusal switches to the legacy path', async () => {
    calls = [];
    answer = () => ({ data: { result: { data: [{ blockTime: 1 }], paginationToken: null } } });
    const page = await solana.getAccountTransactionsPage('Acct');
    assert.strictEqual(page.txs.length, 1);
    assert.strictEqual(calls[0].params[1].limit, 100);
    assert.strictEqual(calls[0].params[1].transactionDetails, 'full');
    assert.strictEqual(solana.isTransactionHistoryAvailable(), true);

    answer = () => ({ data: { error: { code: -32601, message: 'Method not found' } } });
    await assert.rejects(solana.getAccountTransactionsPage('Acct'));
    assert.strictEqual(solana.isTransactionHistoryAvailable(), false);
  });

  test('getAllTokenAccounts reads DAS pages several at a time and stops at the last one', async () => {
    calls = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const realPost2 = axios.post;
    axios.post = async (url, body) => {
      calls.push({ url, method: body.method, params: body.params });
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 150)); // longer than the queue's 25ms start spacing
      inFlight--;
      const page = body.params.page;
      const n = page <= 5 ? 1000 : page === 6 ? 10 : 0;
      return { data: { result: { token_accounts: Array.from({ length: n }, (_, i) => ({ owner: `o${page}_${i}`, address: `a${page}_${i}`, amount: '1' })) } } };
    };
    try {
      const r = await solana.getAllTokenAccounts('Mint', { maxPages: 250, concurrency: 4 });
      assert.strictEqual(r.complete, true);
      assert.strictEqual(r.pages, 6);
      assert.strictEqual(r.accounts.length, 5010);
      assert.strictEqual(r.accounts[0].owner, 'o1_0', 'pages kept in order');
      assert.strictEqual(r.accounts[5009].owner, 'o6_9');
      assert.deepStrictEqual(calls.map(c => c.params.page), [1, 2, 3, 4, 5, 6, 7, 8], 'two waves of 4');
      assert.ok(maxInFlight > 1, 'pages were read at the same time');

      calls = [];
      const capped = await solana.getAllTokenAccounts('Mint', { maxPages: 3, concurrency: 4 });
      assert.strictEqual(capped.complete, false);
      assert.strictEqual(capped.pages, 3);
      assert.deepStrictEqual(calls.map(c => c.params.page), [1, 2, 3], 'never past maxPages');
    } finally {
      axios.post = realPost2;
    }
  });
});
