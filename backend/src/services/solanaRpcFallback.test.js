const test = require('node:test');
const assert = require('node:assert');

process.env.HELIUS_API_KEY = 'test-key';
delete process.env.STANDARD_RPC_URL;
const axios = require('axios');
const solana = require('./solana');

function httpError(status) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: {} };
  return err;
}

test('a 403 from the free RPC falls back to Helius and benches the free RPC', async () => {
  const calls = [];
  const original = axios.post;
  axios.post = async (url, body) => {
    calls.push(new URL(url).host);
    if (url.includes('publicnode')) throw httpError(403);
    return { data: { result: { value: [{ ok: true }], method: body.method } } };
  };
  try {
    const first = await solana.getMultipleAccounts(['a', 'b']);
    assert.deepStrictEqual(first.value, [{ ok: true }]);
    assert.deepStrictEqual(calls, ['solana-rpc.publicnode.com', 'mainnet.helius-rpc.com']);

    // Benched: the next call skips the free endpoint entirely.
    calls.length = 0;
    await solana.getMultipleAccounts(['c']);
    assert.deepStrictEqual(calls, ['mainnet.helius-rpc.com']);
  } finally {
    axios.post = original;
  }
});
