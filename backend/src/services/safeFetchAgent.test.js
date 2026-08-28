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
