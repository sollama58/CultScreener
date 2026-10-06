const { VersionedTransaction } = require('@solana/web3.js');

// /api/cultify/send-tx relays signed transactions through our Helius RPC. Without a policy it is
// an open relay: anyone could push arbitrary transactions through our key and rate limits. The
// burn flows (Cultify and Holder Behavior) only ever send one SPL Token burn of the burn mint, so
// that is all we relay, plus the two programs wallets are known to inject into what they sign.

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
// Lighthouse: assertion-only program Phantom adds to transactions it signs. It can only make a
// transaction fail, never move funds.
const LIGHTHOUSE_PROGRAM_ID = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';

const SPL_BURN = 8;          // data: [8, u64 amount]
const SPL_BURN_CHECKED = 15; // data: [15, u64 amount, u8 decimals]

/**
 * Returns { ok: true } when every instruction is a burn of one of `allowedMints` (at least one
 * burn required) or a ComputeBudget / Lighthouse instruction; { ok: false, reason } otherwise.
 */
function checkBurnTransaction(base64Tx, allowedMints) {
  let tx;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, 'base64'));
  } catch {
    return { ok: false, reason: 'undecodable' };
  }

  const message = tx.message;
  // Lookup tables would hide account keys from this check; the burn flow never uses them.
  if (message.addressTableLookups?.length) {
    return { ok: false, reason: 'address_lookup_tables' };
  }

  const keys = message.staticAccountKeys.map(k => k.toBase58());
  let burns = 0;

  for (const ix of message.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (programId === COMPUTE_BUDGET_PROGRAM_ID || programId === LIGHTHOUSE_PROGRAM_ID) continue;
    if (programId !== TOKEN_PROGRAM_ID) {
      return { ok: false, reason: 'program_not_allowed' };
    }

    const data = ix.data;
    const isBurn = data.length === 9 && data[0] === SPL_BURN;
    const isBurnChecked = data.length === 10 && data[0] === SPL_BURN_CHECKED;
    if (!isBurn && !isBurnChecked) {
      return { ok: false, reason: 'token_instruction_not_burn' };
    }
    // Burn accounts: [token account, mint, owner, ...multisig signers]
    const mint = keys[ix.accountKeyIndexes[1]];
    if (!allowedMints.includes(mint)) {
      return { ok: false, reason: 'mint_not_allowed' };
    }
    burns++;
  }

  if (burns === 0) return { ok: false, reason: 'no_burn' };
  return { ok: true };
}

module.exports = { checkBurnTransaction };
