import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM, findAta } from "../../../src/chains/solana/pda";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
// Owner = ed25519 pubkey of a 32-byte fill seed. Same table as test/spike/kit-workerd.test.ts and, cross-checked against
// Kit's node build, test/node/solana-ata-vector.test.ts. KEEP THE THREE TABLES IN SYNC: change all together (duplication is deliberate).
const ATA_ROWS: { fill: number; mint: string; ata: string; bump: number }[] = [
  { fill: 10, mint: WSOL, ata: "6fs3QdNuKuqJZWzmyv5gWACgcKa7N5bt16EcxsSBmy8Q", bump: 249 },
  { fill: 12, mint: USDC, ata: "aPf5sExn4TfsaLgjPXkBLucQC5SBop8UHMpiuwnoqy9", bump: 250 },
  { fill: 4, mint: WSOL, ata: "GWq4Tm57y4ZuxdBKjUo97Qg9vJdTPx2gCkNELDaLhGqS", bump: 251 },
  { fill: 2, mint: WSOL, ata: "HAVBuXWTeBuLPzkPrDYhmc4CkFB7xCRLLhEeBHpccn5W", bump: 252 },
  { fill: 1, mint: USDC, ata: "3wvJdyFnGvaMWpbq93NU91SggiVRveULUXL6iX5VZDGP", bump: 254 },
  { fill: 8, mint: WSOL, ata: "2iEknxJzBEL6o3Bb8fwERAu79F8hDAnrVUFX1jVoWTLi", bump: 255 },
  { fill: 3, mint: USDC, ata: "DNDTCnZkNk358qDFZd9unHtnrc73SsXcpVWtwJJMrR4B", bump: 255 },
];
const ownerOf = (fill: number) => base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(fill)));

describe("findAta", () => {
  it("program constants", () => {
    expect(TOKEN_PROGRAM).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(ASSOCIATED_TOKEN_PROGRAM).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  });
  it("matches every Node-derived row (address and bump)", () => {
    for (const r of ATA_ROWS) expect(findAta(ownerOf(r.fill), r.mint), `fill ${r.fill}`).toEqual([r.ata, r.bump]);
    expect(ATA_ROWS.filter((r) => r.bump < 255).length).toBeGreaterThanOrEqual(3);
    expect(ATA_ROWS.some((r) => r.bump < 254)).toBe(true);
  });
  it("legacy vector: seed 1..32 + USDC", () => {
    const owner = base58.encode(ed25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1)));
    expect(findAta(owner, USDC)).toEqual(["FjCjyojZLVYVQ2dEdDKQx76msks96TdH9xqvc8BQ9UUx", 255]);
  });
  it("rejects an owner or mint that is not 32 bytes of base58", () => {
    expect(() => findAta("abc", USDC)).toThrow();
    expect(() => findAta(ownerOf(1), "0OIl")).toThrow();
  });
});
