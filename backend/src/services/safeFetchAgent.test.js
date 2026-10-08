/**
 * The address guard behind the image proxy.
 *
 * This is the whole of what replaced a host allowlist, so it is worth testing directly rather
 * than only through the route: the allowlist was rejecting 51% of this project's real token
 * artwork, and the thing that made removing it safe is exactly these predicates.
 *
 * Plain `node --test`, because the backend has no test runner and this needs none.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { isBlockedAddress, isBlockedHostLiteral } = require('./safeFetchAgent');

test('blocks the addresses an image proxy must never reach', () => {
  for (const ip of [
    '127.0.0.1',        // loopback
    '127.1.2.3',        // all of 127/8, not just .0.1
    '0.0.0.0',          // "this network"
    '10.1.2.3',         // private
    '172.16.0.1',       // private, low edge
    '172.31.255.254',   // private, high edge
    '192.168.1.1',      // private
    '169.254.169.254',  // cloud metadata - the one that turns this into credential disclosure
    '100.64.0.1',       // CGNAT
    '198.18.0.1',       // benchmarking
    '224.0.0.1',        // multicast
    '255.255.255.255',  // broadcast
    '::1',              // IPv6 loopback
    '::',               // IPv6 unspecified
    'fe80::1',          // IPv6 link-local
    'fc00::1',          // IPv6 unique-local
    'ff02::1',          // IPv6 multicast
    '64:ff9b::7f00:1',  // NAT64 - a route back into IPv4 space
    '::ffff:127.0.0.1', // IPv4-mapped, the trivial bypass if judged as IPv6
    '::ffff:10.0.0.1',
  ]) {
    assert.strictEqual(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test('allows ordinary public addresses', () => {
  for (const ip of [
    '1.1.1.1',
    '8.8.8.8',
    '104.18.0.1',       // a CDN
    '172.15.0.1',       // just below the private block
    '172.32.0.1',       // just above it
    '192.167.0.1',      // just below 192.168/16
    '192.169.0.1',      // just above it
    '100.63.255.255',   // just below CGNAT
    '100.128.0.1',      // just above it
    '223.255.255.255',  // last address before multicast
    '2606:4700::1111',  // public IPv6
  ]) {
    assert.strictEqual(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

test('refuses anything that is not an address at all, rather than guessing', () => {
  for (const junk of ['', 'not-an-ip', '999.999.999.999', '10.0.0', '0x7f000001']) {
    assert.strictEqual(isBlockedAddress(junk), true, `${junk} should be refused`);
  }
});

test('judges a hostname that is already a literal address, brackets included', () => {
  // What `new URL(...).hostname` hands back for an IPv6 literal.
  assert.strictEqual(isBlockedHostLiteral('[::1]'), true);
  assert.strictEqual(isBlockedHostLiteral('[::ffff:169.254.169.254]'), true);
  assert.strictEqual(isBlockedHostLiteral('127.0.0.1'), true);
  assert.strictEqual(isBlockedHostLiteral('169.254.169.254'), true);
  assert.strictEqual(isBlockedHostLiteral('1.1.1.1'), false);
  // A NAME is not a literal - it has to be resolved before anything can be said about it, which
  // is the guarded lookup's job, not this one's.
  assert.strictEqual(isBlockedHostLiteral('localhost'), false);
  assert.strictEqual(isBlockedHostLiteral('ipfs.io'), false);
});

test('judges IPv4-mapped IPv6 in the hex spelling URL() normalises to (audit #15)', () => {
  assert.strictEqual(new URL('https://[::ffff:127.0.0.1]/').hostname, '[::ffff:7f00:1]');
  for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:1', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '::127.0.0.1']) {
    assert.strictEqual(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
  assert.strictEqual(isBlockedHostLiteral('[::ffff:7f00:1]'), true);
  assert.strictEqual(isBlockedHostLiteral('[::ffff:a9fe:a9fe]'), true);
  // A mapped PUBLIC address is still judged as that address.
  assert.strictEqual(isBlockedAddress('::ffff:808:808'), false);
  assert.strictEqual(isBlockedAddress('::ffff:8.8.8.8'), false);
});

test('the safe agents refuse IP-literal private hosts, which never reach lookup (audit #15)', async () => {
  const http = require('http');
  const axios = require('axios');
  const { safeHttpAgent } = require('./safeFetchAgent');

  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.end('internal'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    // Direct literal.
    await assert.rejects(
      axios.get(`http://127.0.0.1:${port}/`, { httpAgent: safeHttpAgent, proxy: false, timeout: 3000 }),
      (err) => err.code === 'EBLOCKEDADDRESS'
    );
    // A redirect hop to a literal goes through the same agent.
    const redirector = http.createServer((req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/latest/meta-data/` });
      res.end();
    });
    await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
    try {
      // Reach the redirector with a plain agent; the hop must still be refused by the safe one.
      const hop = await axios.get(`http://127.0.0.1:${redirector.address().port}/`, {
        maxRedirects: 0, validateStatus: () => true, proxy: false, timeout: 3000,
      });
      assert.strictEqual(hop.status, 302);
      await assert.rejects(
        axios.get(hop.headers.location, { httpAgent: safeHttpAgent, proxy: false, timeout: 3000 }),
        (err) => err.code === 'EBLOCKEDADDRESS'
      );
    } finally {
      redirector.close();
    }
    assert.strictEqual(hits, 0, 'the internal server must never be reached');
  } finally {
    server.close();
  }
});
