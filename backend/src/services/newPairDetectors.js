/**
 * New Pairs: recognise a graduation in one transaction. Pure, no I/O; unit tested
 * against real transactions in newPairDetectors.test.js.
 *
 * Takes the transaction as standard RPC returns it with encoding "json" (also the
 * shape of Helius getTransactionsForAddress "full"): string account keys plus
 * meta.loadedAddresses, instructions as { programIdIndex, accounts: [index], data }.
 */

const bs58 = require('bs58');

function accountKeys(tx) {
  const keys = (tx?.transaction?.message?.accountKeys || []).map(k => (typeof k === 'string' ? k : k?.pubkey || ''));
  const loaded = tx?.meta?.loadedAddresses;
  if (loaded) keys.push(...(loaded.writable || []), ...(loaded.readonly || []));
  return keys;
}

// Top-level instructions, then inner ones: a wrapper program (a buy that completes
// the curve and migrates in one transaction) calls the launchpad from inside.
function* allInstructions(tx) {
  for (const ix of tx?.transaction?.message?.instructions || []) yield ix;
  for (const group of tx?.meta?.innerInstructions || []) {
    for (const ix of group?.instructions || []) yield ix;
  }
}

function discriminatorOf(data) {
  if (typeof data !== 'string' || data.length < 8) return null;
  try {
    const bytes = bs58.decode(data);
    return bytes.length >= 8 ? Buffer.from(bytes.subarray(0, 8)).toString('hex') : null;
  } catch {
    return null;
  }
}

function invoked(tx, programs) {
  const logs = tx?.meta?.logMessages || [];
  return programs.some(p => logs.some(l => typeof l === 'string' && l.startsWith(`Program ${p} invoke`)));
}

/**
 * @returns {null | {unhandled: string} | {mint, quoteMint, instruction, signature, slot, graduatedAt}}
 *   null: not a graduation (failed, another instruction, or a migrate that created no
 *   pool). unhandled: a migration instruction whose layout is not known. graduatedAt
 *   is the block time in ms (null when the node gave none).
 */
function matchGraduation(detector, tx) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const keys = accountKeys(tx);
  let unhandled = null;
  for (const ix of allInstructions(tx)) {
    const program = ix.programId || keys[ix.programIdIndex];
    if (program !== detector.program) continue;
    const disc = discriminatorOf(ix.data);
    if (!disc) continue;
    const layout = detector.instructions[disc];
    if (!layout) {
      if (detector.unhandled[disc]) unhandled = detector.unhandled[disc];
      continue;
    }
    if (!invoked(tx, detector.poolPrograms)) return null;
    const at = i => {
      const a = (ix.accounts || [])[i];
      return typeof a === 'string' ? a : keys[a];
    };
    const mint = at(layout.mint);
    if (!mint) return null;
    // The mint must be a token this transaction moved; a wrong position would name
    // some other account, and listing that is worse than missing one graduation.
    const moved = (tx.meta.postTokenBalances || []).some(b => b && b.mint === mint);
    if (!moved) return null;
    return {
      mint,
      quoteMint: at(layout.quote) || null,
      instruction: layout.name,
      signature: tx.transaction?.signatures?.[0] || null,
      slot: Number.isFinite(tx.slot) ? tx.slot : null,
      graduatedAt: tx.blockTime ? tx.blockTime * 1000 : null,
    };
  }
  return unhandled ? { unhandled } : null;
}

module.exports = { matchGraduation, accountKeys, discriminatorOf };
