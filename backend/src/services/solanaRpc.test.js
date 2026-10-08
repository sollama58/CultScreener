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

  // (before the method-refusal test below, which turns getTransactionsForAddress off)
  test('large getTransactionsForAddress pages are capped in flight; small ones are not', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const realPost2 = axios.post;
    axios.post = async (url, body) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 300)); // well past the limiter's 25ms start spacing
      inFlight--;
      return { data: { result: { data: [{ blockTime: 1 }], paginationToken: null } } };
    };
    try {
      const big = await Promise.all(Array.from({ length: 10 }, (_, i) => solana.getAccountTransactionsPage(`Acct${i}`, { limit: 500 })));
      assert.strictEqual(big.length, 10);
      assert.ok(maxInFlight <= 4, `at most 4 large pages at once (saw ${maxInFlight})`);
      maxInFlight = 0;
      await Promise.all(Array.from({ length: 8 }, (_, i) => solana.getAccountTransactionsPage(`Acct${i}`, { limit: 100 })));
      assert.ok(maxInFlight > 4, 'small pages are not held back');
    } finally {
      axios.post = realPost2;
    }
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
      const read = calls.map(c => c.params.page).sort((a, b) => a - b);
      assert.deepStrictEqual(read.slice(0, 6), [1, 2, 3, 4, 5, 6], 'every page up to the last one');
      assert.strictEqual(new Set(read).size, read.length, 'no page read twice');
      assert.ok(read[read.length - 1] <= 6 + 3, 'at most concurrency-1 pages past the last one');
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

  test('getAllTokenAccounts keeps the other slots busy while one page is slow', async () => {
    const startedWhileSlow = [];
    let page1Done = false;
    const realPost2 = axios.post;
    axios.post = async (url, body) => {
      const page = body.params.page;
      if (!page1Done) startedWhileSlow.push(page);
      // page 1 is slow; the others answer quickly
      await new Promise(r => setTimeout(r, page === 1 ? 400 : 30));
      if (page === 1) page1Done = true;
      const n = page <= 7 ? 1000 : 0;
      return { data: { result: { token_accounts: Array.from({ length: n }, (_, i) => ({ owner: `o${page}_${i}`, address: `a${page}_${i}`, amount: '1' })) } } };
    };
    try {
      const r = await solana.getAllTokenAccounts('Mint', { maxPages: 250, concurrency: 4 });
      assert.strictEqual(r.complete, true);
      assert.strictEqual(r.pages, 8);
      assert.strictEqual(r.accounts.length, 7000);
      assert.strictEqual(r.accounts[0].owner, 'o1_0', 'pages kept in order');
      assert.strictEqual(r.accounts[6999].owner, 'o7_999');
      // pages past the first wave started before slow page 1 came back
      assert.ok(startedWhileSlow.includes(8), 'read on past the first 4 pages while page 1 was slow');
    } finally {
      axios.post = realPost2;
    }
  });

  test('getAllTokenAccounts with partial=true returns the pages before one that keeps failing', async () => {
    const realPost2 = axios.post;
    axios.post = async (url, body) => {
      const page = body.params.page;
      if (page === 3) return { data: { error: { code: -32602, message: 'Invalid params' } } };
      return { data: { result: { token_accounts: Array.from({ length: 1000 }, (_, i) => ({ owner: `o${page}_${i}`, address: `a${page}_${i}`, amount: '1' })) } } };
    };
    try {
      const r = await solana.getAllTokenAccounts('Mint', { maxPages: 10, concurrency: 4, partial: true });
      assert.strictEqual(r.complete, false);
      assert.strictEqual(r.pages, 2);
      assert.strictEqual(r.accounts.length, 2000);
      await assert.rejects(solana.getAllTokenAccounts('Mint', { maxPages: 10, concurrency: 4 }), /DAS page 3/);
    } finally {
      axios.post = realPost2;
    }
  });
});
