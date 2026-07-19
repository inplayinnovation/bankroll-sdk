// @vitest-environment node
//
// The inlined SPL Token instructions must be byte-identical to the reference
// implementation. @solana/spl-token is a devDependency for exactly this — it
// is the oracle, never shipped. If these fail, ./spl-token has drifted and
// payouts would build transactions the chain interprets differently.
import {
  createAssociatedTokenAccountIdempotentInstruction as refCreateAta,
  createTransferCheckedInstruction as refTransfer,
  getAssociatedTokenAddressSync as refAta,
  ASSOCIATED_TOKEN_PROGRAM_ID as REF_ATA_PROGRAM,
  TOKEN_PROGRAM_ID as REF_TOKEN_PROGRAM,
} from '@solana/spl-token';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { HSUSD_MINT } from '../src/charges';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '../src/spl-token';

const MINT = new PublicKey(HSUSD_MINT);

/** Compare an instruction exactly: program, account metas in order, and data. */
function expectIdentical(ours: TransactionInstruction, reference: TransactionInstruction) {
  expect(ours.programId.toBase58()).toBe(reference.programId.toBase58());
  expect(ours.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(
    reference.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
  );
  expect(Buffer.compare(ours.data, reference.data)).toBe(0);
}

describe('inlined SPL Token instructions match @solana/spl-token', () => {
  it('uses the same program ids', () => {
    expect(TOKEN_PROGRAM_ID.toBase58()).toBe(REF_TOKEN_PROGRAM.toBase58());
    expect(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()).toBe(REF_ATA_PROGRAM.toBase58());
  });

  it('derives the same associated token address, across many wallets', () => {
    for (let i = 0; i < 25; i++) {
      const owner = Keypair.generate().publicKey;
      expect(getAssociatedTokenAddressSync(MINT, owner).toBase58()).toBe(
        refAta(MINT, owner).toBase58(),
      );
    }
  });

  it('derives the same address for an off-curve owner when allowed', () => {
    // A PDA — what a smart-contract wallet looks like as a recipient.
    const offCurve = refAta(MINT, Keypair.generate().publicKey);
    expect(getAssociatedTokenAddressSync(MINT, offCurve, true).toBase58()).toBe(
      refAta(MINT, offCurve, true).toBase58(),
    );
  });

  it('refuses an off-curve owner by default, as the reference does', () => {
    const offCurve = refAta(MINT, Keypair.generate().publicKey);
    expect(() => getAssociatedTokenAddressSync(MINT, offCurve)).toThrow();
    expect(() => refAta(MINT, offCurve)).toThrow();
  });

  it('builds an identical transferChecked, across amounts', () => {
    const source = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    // Boundaries where a wrong integer width or endianness would show up.
    for (const amount of [1n, 255n, 256n, 4294967295n, 4294967296n, 2n ** 63n, 2n ** 64n - 1n]) {
      expectIdentical(
        createTransferCheckedInstruction(source, MINT, destination, owner, amount, 9),
        refTransfer(source, MINT, destination, owner, amount, 9),
      );
    }
  });

  it('builds an identical transferChecked across decimals', () => {
    const [source, destination, owner] = [1, 2, 3].map(() => Keypair.generate().publicKey);
    for (const decimals of [0, 6, 9, 255]) {
      expectIdentical(
        createTransferCheckedInstruction(source!, MINT, destination!, owner!, 1000n, decimals),
        refTransfer(source!, MINT, destination!, owner!, 1000n, decimals),
      );
    }
  });

  it('builds an identical idempotent ATA create', () => {
    const payer = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const ata = refAta(MINT, owner);
    expectIdentical(
      createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, MINT),
      refCreateAta(payer, ata, owner, MINT),
    );
  });
});
