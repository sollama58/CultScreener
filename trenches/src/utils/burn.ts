import { Buffer } from "buffer";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

export const SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** SPL Token instruction discriminator for `Burn`. */
const BURN_INSTRUCTION = 8;

/**
 * The caller's associated token account for a mint.
 *
 * Derived rather than looked up: the address is a pure function of owner and mint, so deriving it
 * costs nothing and works even when an RPC call would have been rate-limited. If the account does
 * not exist the burn simply fails on simulation, before any tokens move.
 */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

/**
 * An SPL `Burn` instruction, hand-encoded.
 *
 * Nine bytes: the discriminator and a little-endian u64. Encoded here rather than pulling in
 * @solana/spl-token, which would add a dependency to the bundle for one instruction whose layout
 * has not changed since the program shipped. The same approach the HolDEX site already uses for
 * its Cultify burn.
 *
 * Account order is fixed by the program and load-bearing for the server's verification: the
 * authority in slot 2 is what the API credits the months to, so it must be the signer who owns
 * the tokens.
 */
export function createBurnInstruction(
  tokenAccount: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  rawAmount: bigint,
): TransactionInstruction {
  // Buffer, not Uint8Array: TransactionInstruction's type demands one, and web3.js's own Buffer
  // shim is already in the bundle for exactly this.
  const data = Buffer.alloc(9);
  data[0] = BURN_INSTRUCTION;
  data.writeBigUInt64LE(rawAmount, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: SPL_TOKEN_PROGRAM_ID,
    data,
  });
}

/** Base units for a whole-token amount at the given decimals, without going through a float. */
export function toRawAmount(tokens: number, decimals: number): bigint {
  return BigInt(tokens) * 10n ** BigInt(decimals);
}

/** Serialise a signed transaction for the API to relay. */
export function serializeSigned(transaction: Transaction): string {
  const bytes = transaction.serialize();
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const PENDING_KEY = "trenches.pendingBurn";

export interface PendingBurn {
  signature: string;
  wallet: string;
  at: number;
}

/**
 * Remember a burn the moment it is broadcast, before anything else can fail.
 *
 * A third safety net, behind the server having already recorded the signature and the reconciler
 * finding it on-chain regardless. It costs one localStorage write and it is what lets a reloaded
 * tab say "finishing your burn" instead of leaving the user to wonder whether their tokens went
 * anywhere.
 */
export function rememberPendingBurn(signature: string, wallet: string): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ signature, wallet, at: Date.now() }));
  } catch {
    // Private mode, or storage full. The server already knows the signature; this was the belt to
    // its braces.
  }
}

export function readPendingBurn(): PendingBurn | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { signature, wallet, at } = parsed as Record<string, unknown>;
    if (typeof signature !== "string" || typeof wallet !== "string") return null;
    // A week is long past the point where the reconciler will have dealt with it anyway.
    if (typeof at === "number" && Date.now() - at > 7 * 86_400_000) return null;
    return { signature, wallet, at: typeof at === "number" ? at : Date.now() };
  } catch {
    return null;
  }
}

export function clearPendingBurn(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to do - a stale entry expires on its own.
  }
}
