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
});
