/**
 * Per-wallet record of the Cultify / Holder Behavior access tokens issued, so a data-deletion
 * request can drop them by exact key. Scanning the keyspace for `<prefix>:access:*` instead cost
 * several full-keyspace SCAN walks plus an MGET of every token on each request, and that route
 * only needs a signature from a wallet the caller made up.
 *
 * `<prefix>:issued:<wallet>` -> [{ token, mint, expiresAt }], expired entries pruned on write.
 * prefix is 'cultify' or 'hb'.
 */
const { cache } = require('./cache');

const PREFIXES = ['cultify', 'hb'];
const issuedKey = (prefix, wallet) => `${prefix}:issued:${wallet}`;

async function recordIssuedToken(prefix, wallet, mint, token, ttlMs) {
  const key = issuedKey(prefix, wallet);
  const now = Date.now();
  const entries = ((await cache.get(key)) || []).filter(e => e && e.expiresAt > now && e.token !== token);
  entries.push({ token, mint, expiresAt: now + ttlMs });
  const keepFor = Math.max(...entries.map(e => e.expiresAt)) - now;
  await cache.set(key, entries, keepFor);
}

/**
 * Drop what the cache holds for a wallet's paid utilities: the Holder Behavior "My Utilities"
 * index, the per-wallet record of issued tokens (access-by), and the access tokens themselves.
 * Exact keys only, no SCAN. A Cultify token issued before the issued-record existed and never
 * remembered in access-by is not found; it expires on its own within its 12-hour lifetime, and
 * no new one can be issued once the burns are unlinked.
 */
async function forgetWalletAccess(wallet) {
  const keys = new Set([`hb:wallet-idx:${wallet}`]);
  const hbIndex = (await cache.get(`hb:wallet-idx:${wallet}`)) || [];
  const accessBy = new Set();
  for (const prefix of PREFIXES) {
    keys.add(issuedKey(prefix, wallet));
    for (const e of (await cache.get(issuedKey(prefix, wallet))) || []) {
      if (e && e.token) keys.add(`${prefix}:access:${e.token}`);
      if (e && e.mint) accessBy.add(`${prefix}:access-by:${wallet}:${e.mint}`);
    }
  }
  for (const e of hbIndex) if (e && e.mint) accessBy.add(`hb:access-by:${wallet}:${e.mint}`);

  // access-by entries name the token last handed out for that wallet+mint
  const byKeys = [...accessBy];
  const byValues = byKeys.length ? await cache.mget(byKeys) : [];
  byKeys.forEach((key, i) => {
    keys.add(key);
    const token = byValues[i] && byValues[i].token;
    if (token) keys.add(`${key.split(':')[0]}:access:${token}`);
  });
  await cache.deleteMany([...keys]);
}

module.exports = { recordIssuedToken, forgetWalletAccess };
