const solanaService = require('./solana');

// Mint decimals for scaling raw DAS amounts when the RPC answer that normally carries them
// is missing. Helius metadata is cached for an hour; getTokenSupply is the second source.
// null when neither knows: callers must not guess (a wrong guess is off by 10^n).
// Shared by /api/tokens/:mint/holders and /api/cultify/analyze/:mint, which both feed the
// holder-analytics:<mint> cache.
async function resolveMintDecimals(mint) {
  const meta = await solanaService.getTokenMetadata(mint).catch(() => null);
  if (Number.isInteger(meta?.decimals)) return meta.decimals;
  const supply = await solanaService.getTokenSupply(mint).catch(() => null);
  if (Number.isInteger(supply?.value?.decimals)) return supply.value.decimals;
  return null;
}

module.exports = { resolveMintDecimals };
