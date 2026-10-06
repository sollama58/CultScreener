const test = require('node:test');
const assert = require('node:assert');
const {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, TransactionMessage, VersionedTransaction
} = require('@solana/web3.js');
const { checkBurnTransaction } = require('./burnTxPolicy');

const BURN_MINT = '9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const BLOCKHASH = '11111111111111111111111111111111';

const owner = Keypair.generate();
const tokenAccount = Keypair.generate().publicKey;

// Mirrors the instruction frontend/js/cultify.js and holderBehavior.js build.
function burnIx(mint = BURN_MINT, opcode = 8) {
  const data = new Uint8Array(opcode === 15 ? 10 : 9);
  data[0] = opcode;
  new DataView(data.buffer).setBigUint64(1, 5_000_000_000n, true);
  if (opcode === 15) data[9] = 6;
  return new TransactionInstruction({
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: false }
    ],
    programId: TOKEN_PROGRAM_ID,
    data: Buffer.from(data)
  });
}

function legacy(...ixs) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = owner.publicKey;
  tx.recentBlockhash = BLOCKHASH;
  tx.sign(owner);
  return tx.serialize().toString('base64');
}

function v0(...ixs) {
  const msg = new TransactionMessage({
    payerKey: owner.publicKey, recentBlockhash: BLOCKHASH, instructions: ixs
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([owner]);
  return Buffer.from(tx.serialize()).toString('base64');
}

test('accepts the frontend burn transaction', () => {
  assert.deepStrictEqual(checkBurnTransaction(legacy(burnIx()), [BURN_MINT]), { ok: true });
});

test('accepts burnChecked, v0 messages and wallet-added compute budget', () => {
  const cb = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });
  assert.ok(checkBurnTransaction(legacy(cb, burnIx(BURN_MINT, 15)), [BURN_MINT]).ok);
  assert.ok(checkBurnTransaction(v0(cb, burnIx()), [BURN_MINT]).ok);
});

test('rejects a burn of another mint', () => {
  const other = Keypair.generate().publicKey.toBase58();
  assert.strictEqual(checkBurnTransaction(legacy(burnIx(other)), [BURN_MINT]).reason, 'mint_not_allowed');
});

test('rejects a SOL transfer, alone or alongside a burn', () => {
  const transfer = SystemProgram.transfer({
    fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1
  });
  assert.strictEqual(checkBurnTransaction(legacy(transfer), [BURN_MINT]).reason, 'program_not_allowed');
  assert.strictEqual(checkBurnTransaction(legacy(burnIx(), transfer), [BURN_MINT]).reason, 'program_not_allowed');
});

test('rejects non-burn token instructions', () => {
  const transferIx = burnIx();
  transferIx.data[0] = 3; // SPL Transfer
  assert.strictEqual(checkBurnTransaction(legacy(transferIx), [BURN_MINT]).reason, 'token_instruction_not_burn');
});

test('rejects a compute-budget-only transaction and garbage', () => {
  const cb = ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 });
  assert.strictEqual(checkBurnTransaction(legacy(cb), [BURN_MINT]).reason, 'no_burn');
  assert.strictEqual(checkBurnTransaction('AAAA', [BURN_MINT]).reason, 'undecodable');
});
