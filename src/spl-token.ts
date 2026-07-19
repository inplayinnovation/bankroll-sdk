// The three SPL Token operations this SDK needs, inlined.
//
// WHY THIS FILE EXISTS
//
// Importing these from @solana/spl-token drags in bigint-buffer, via the
// archived @solana/buffer-layout-utils. bigint-buffer's buffer-overflow
// advisory (CVE-2025-3194) has no fixed version and no active maintainer, and
// @solana/buffer-layout-utils was archived by Solana Labs in January 2025 — so
// every app installing this SDK inherits four high-severity audit findings
// that cannot be resolved by upgrading. For a payments SDK that is its own
// kind of problem, regardless of exploitability (the vulnerable function is a
// decoder none of this code calls).
//
// WHY NOT MIGRATE TO @solana/kit
//
// The obvious fix is @solana/kit + @solana-program/token, which carry none of
// that tree. It is blocked, for now, by a dependency deadlock:
//
//   - every published @privy-io/node (through 0.26.0) peers on @solana/kit@^5
//   - @solana-program/memo and @solana-program/token@0.15 require kit ^7
//   - installing kit 7 alongside @privy-io/node fails with a hard ERESOLVE,
//     not a warning
//
// Since @joinbankroll/sdk/privy is a shipped integration — and the arcade runs
// on it in production — breaking `npm install` for every Privy user is a worse
// outcome than an unfixable advisory in a code path we never execute.
//
// The migration itself is straightforward when that unblocks: payouts.ts maps
// onto kit's pipe/createTransactionMessage/compileTransaction, the token
// program's builders take a createNoopSigner(treasury) where this file takes a
// PublicKey, and kit emits v0 transactions where web3.js emitted legacy ones —
// so the tests, which decode with Transaction.from, need VersionedTransaction.
// Revisit when @privy-io/node peers on kit ^7; at that point this file and the
// @solana/web3.js dependency both go away.
//
// WHAT IS ACTUALLY INLINED
//
// Instruction *shapes* only: fixed account orders and data layouts that are
// part of the SPL Token program's public on-chain interface. There is no
// cryptography here — the program-derived-address maths still comes from
// web3.js. @solana/spl-token remains a devDependency, and the tests assert
// byte-for-byte equality against it, so any drift fails CI.
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

// SPL Token instruction discriminators.
const TRANSFER_CHECKED = 12;
// Associated Token Account program discriminator.
const CREATE_IDEMPOTENT = 1;

/**
 * The associated token account for `owner` and `mint`.
 *
 * `allowOwnerOffCurve` must be true for program-derived owners (smart-contract
 * wallets); the default refuses them, which is what you want for a signer.
 */
export function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
): PublicKey {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBuffer())) {
    throw new Error(`${owner.toBase58()} is off-curve and cannot own a token account directly`);
  }
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

/**
 * Transfer tokens, with the mint and decimals checked on-chain — the safe
 * transfer instruction, as opposed to bare `transfer`.
 */
export function createTransferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(TRANSFER_CHECKED, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);

  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * Create the recipient's associated token account if it doesn't exist. The
 * idempotent variant succeeds rather than failing when it already does, so a
 * payout needs no prior existence check.
 */
export function createAssociatedTokenAccountIdempotentInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([CREATE_IDEMPOTENT]),
  });
}
