import { ed25519 } from "@noble/curves/ed25519.js";
import { expect, it } from "vitest";

// Independent cross-check (Kit's node build) of the ATA table in test/spike/kit-workerd.test.ts.
// KEEP THE TWO TABLES IN SYNC: change both together. Duplication is deliberate.
const MINTS = { usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", wsol: "So11111111111111111111111111111111111111112" };
const ROWS: { fill: number; mint: keyof typeof MINTS; ata: string; bump: number }[] = [
  { fill: 10, mint: "wsol", ata: "6fs3QdNuKuqJZWzmyv5gWACgcKa7N5bt16EcxsSBmy8Q", bump: 249 },
  { fill: 12, mint: "usdc", ata: "aPf5sExn4TfsaLgjPXkBLucQC5SBop8UHMpiuwnoqy9", bump: 250 },
  { fill: 4, mint: "wsol", ata: "GWq4Tm57y4ZuxdBKjUo97Qg9vJdTPx2gCkNELDaLhGqS", bump: 251 },
  { fill: 2, mint: "wsol", ata: "HAVBuXWTeBuLPzkPrDYhmc4CkFB7xCRLLhEeBHpccn5W", bump: 252 },
  { fill: 1, mint: "usdc", ata: "3wvJdyFnGvaMWpbq93NU91SggiVRveULUXL6iX5VZDGP", bump: 254 },
  { fill: 8, mint: "wsol", ata: "2iEknxJzBEL6o3Bb8fwERAu79F8hDAnrVUFX1jVoWTLi", bump: 255 },
  { fill: 3, mint: "usdc", ata: "DNDTCnZkNk358qDFZd9unHtnrc73SsXcpVWtwJJMrR4B", bump: 255 },
];

it("Kit's findAssociatedTokenPda gives each row's address and bump", async () => {
  const { getAddressDecoder } = await import("@solana/kit");
  const { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } = await import("@solana-program/token");
  for (const r of ROWS) {
    const owner = getAddressDecoder().decode(ed25519.getPublicKey(new Uint8Array(32).fill(r.fill)));
    const [ata, bump] = await findAssociatedTokenPda({ owner, mint: MINTS[r.mint] as never, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect({ ata, bump }, `fill ${r.fill} ${r.mint}`).toEqual({ ata: r.ata, bump: r.bump });
  }
});

it("the table exercises the bump search: at least 3 rows below 255, one below 254", () => {
  expect(ROWS.filter((r) => r.bump < 255).length).toBeGreaterThanOrEqual(3);
  expect(ROWS.some((r) => r.bump < 254)).toBe(true);
});
