const { test, describe } = require('node:test');
const assert = require('node:assert');
const { normalizeLogoUri, sniffImageType } = require('./tokenImage');

describe('normalizeLogoUri', () => {
  test('keeps https URLs and upgrades http ones', () => {
    assert.strictEqual(normalizeLogoUri('https://ipfs.io/ipfs/QmAbc'), 'https://ipfs.io/ipfs/QmAbc');
    assert.strictEqual(normalizeLogoUri(' http://example.com/a.png '), 'https://example.com/a.png');
  });

  test('drops GeckoTerminal "missing.png" in any form', () => {
    assert.strictEqual(normalizeLogoUri('missing.png'), null);
    assert.strictEqual(normalizeLogoUri('https://assets.geckoterminal.com/images/missing.png'), null);
    assert.strictEqual(normalizeLogoUri('https://assets.coingecko.com/coins/images/missing_large.png'), null);
  });

  test('drops relative paths, junk and non-strings', () => {
    for (const v of ['', '   ', '/logo.png', 'logo.png', 'javascript:alert(1)', 'data:image/png;base64,AA', null, undefined, 42]) {
      assert.strictEqual(normalizeLogoUri(v), null, String(v));
    }
  });

  test('rewrites ipfs:// and ar:// to https gateways', () => {
    assert.strictEqual(normalizeLogoUri('ipfs://QmAbc'), 'https://ipfs.io/ipfs/QmAbc');
    assert.strictEqual(normalizeLogoUri('ipfs://ipfs/QmAbc'), 'https://ipfs.io/ipfs/QmAbc');
    assert.strictEqual(normalizeLogoUri('ar://XyZ'), 'https://arweave.net/XyZ');
  });
});

describe('sniffImageType', () => {
  test('recognises the common image formats', () => {
    assert.strictEqual(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image/png');
    assert.strictEqual(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.strictEqual(sniffImageType(Buffer.from('GIF89a')), 'image/gif');
    assert.strictEqual(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
    assert.strictEqual(sniffImageType(Buffer.from('\0\0\0\x1cftypavif')), 'image/avif');
    assert.strictEqual(sniffImageType(Buffer.from('  <svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
    assert.strictEqual(sniffImageType(Buffer.from('<?xml version="1.0"?><svg></svg>')), 'image/svg+xml');
  });

  test('refuses everything else', () => {
    assert.strictEqual(sniffImageType(Buffer.from('<!doctype html><html>')), null);
    assert.strictEqual(sniffImageType(Buffer.from('{"error":1}')), null);
    assert.strictEqual(sniffImageType(Buffer.from([1, 2])), null);
    assert.strictEqual(sniffImageType(null), null);
  });
});
