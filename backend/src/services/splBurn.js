/**
 * Supply burnt with the SPL burn instruction leaves no balance anywhere; the only
 * trace is a supply below the original. So it can only be inferred when the original
 * supply is known: pump.fun mints exactly 1,000,000,000 tokens at 6 decimals, and its
 * tokens carry a pump.fun update authority.
 *
 * Revoked mint/freeze authority and a supply under 1B prove nothing: that is how most
 * hand-launched tokens look too, and treating them as pump.fun reported e.g. 900M (90%)
 * of a 100M-supply token as burnt. Such tokens get no SPL burn figure (shown as N/A).
 */

const PUMP_FUN_AUTHORITIES = new Set([
  'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
]);
const PUMP_FUN_SUPPLY = 1_000_000_000;

/**
 * @param {object} p
 * @param {number} p.currentSupply  UI-unit supply now
 * @param {number} p.decimals
 * @param {object|null} p.tokenAuth getTokenAuthorities() result
 * @returns {{ isPumpFun: boolean, splBurnt: number, supplyDenominator: number }}
 */
function inferSplBurn({ currentSupply, decimals, tokenAuth }) {
  let splBurnt = 0;
  let isPumpFun = false;
  if (currentSupply && currentSupply > 0) {
    isPumpFun = !!tokenAuth?.authorities?.some(a => PUMP_FUN_AUTHORITIES.has(a.address));
    if (isPumpFun && decimals === 6) {
      const diff = PUMP_FUN_SUPPLY - currentSupply;
      if (diff > 0) splBurnt = diff;
    }
  }
  return { isPumpFun, splBurnt, supplyDenominator: isPumpFun ? PUMP_FUN_SUPPLY : currentSupply };
}

module.exports = { inferSplBurn, PUMP_FUN_AUTHORITIES, PUMP_FUN_SUPPLY };
