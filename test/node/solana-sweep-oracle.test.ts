import { expect, it } from "vitest";
import { solDepositKey, solHotKey } from "../../src/signing/keys";
import { findAta } from "../../src/chains/solana/pda";
import { assertSolSweepMessage, compileSolSweep, sweepPlan } from "../../src/chains/solana/sweeptx";
import { allowedDestination } from "../../src/routing/guard";
import { signSolanaTx } from "../../src/signing/solana";

// Independent oracle for the Solana sweep tx (Node: Kit's node build has working WebCrypto Ed25519, unlike workerd).
// Our signing is noble over Kit's compiled message bytes; here Kit decodes our wire bytes, verifies every signature with
// its own verifySignature, and signs the same message with its own key-pair signers, which must give the identical tx
// (ed25519 signatures are deterministic).
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

it("Kit (node) decodes our wire tx, verifies each signature, and its own signers produce the identical tx", async () => {
  const k = await import("@solana/kit");
  const hot = solHotKey(SEED);
  const d = [solDepositKey(SEED, 1), solDepositKey(SEED, 2), solDepositKey(SEED, 3)];
  const plan = sweepPlan(
    hot.address,
    [
      { address: d[0]!.address, lamports: 1_234_567n, tokens: [] },
      { address: d[1]!.address, lamports: 0n, tokens: [{ account: findAta(d[1]!.address, USDC)[0], amount: 25_000_000n }] },
      { address: d[2]!.address, lamports: 9n, tokens: [{ account: findAta(d[2]!.address, USDC)[0], amount: 1n }, { account: solDepositKey(SEED, 50).address, amount: 0n }] },
    ],
    { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 777n },
  );
  const compiled = await compileSolSweep(plan);
  await assertSolSweepMessage(compiled.messageBytes, plan);
  const { signature, wire } = await signSolanaTx(SEED, compiled, [{ role: "hot" }, ...[1, 2, 3].map((index) => ({ role: "deposit", index }) as const)], [await allowedDestination({ MASTER_SEED: SEED }, "sol", hot.address)]);

  const bytes = Uint8Array.from(Buffer.from(wire, "base64"));
  const tx = k.getTransactionDecoder().decode(bytes);
  expect(Array.from(tx.messageBytes)).toEqual(Array.from(compiled.messageBytes));
  expect(Object.keys(tx.signatures).sort()).toEqual([hot.address, ...d.map((x) => x.address)].sort());
  for (const [addr, sig] of Object.entries(tx.signatures)) {
    expect(sig).not.toBeNull();
    expect(await k.verifySignature(await k.getPublicKeyFromAddress(addr as never), sig!, tx.messageBytes), addr).toBe(true);
  }
  expect(k.getSignatureFromTransaction(tx)).toBe(signature);

  // The decoded message re-encodes to the same bytes and decompiles to our fee payer, lifetime and instructions.
  const decoded = k.getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  expect(Array.from(k.getCompiledTransactionMessageEncoder().encode(decoded))).toEqual(Array.from(compiled.messageBytes));
  const msg = k.decompileTransactionMessage(decoded, { lastValidBlockHeight: 777n }) as unknown as {
    feePayer: { address: string };
    lifetimeConstraint: { blockhash: string };
    instructions: { programAddress: string }[];
  };
  expect(msg.feePayer.address).toBe(hot.address);
  expect(msg.lifetimeConstraint.blockhash).toBe(plan.blockhash);
  expect(msg.instructions).toHaveLength(2 + 1 + 2 + 1 + 4 + 1);

  // Kit's own WebCrypto signing over the same compiled tx gives the same wire bytes.
  const signers = await Promise.all([hot, ...d].map((x) => k.createKeyPairSignerFromPrivateKeyBytes(x.priv)));
  expect(signers.map((s) => s.address)).toEqual([hot, ...d].map((x) => x.address));
  const kitSigned = await k.signTransaction(signers.map((s) => s.keyPair), compiled.tx as never);
  expect(k.getBase64EncodedWireTransaction(kitSigned)).toBe(wire);
});
