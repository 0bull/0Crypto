import { setupNetwork } from "@msw/cloudflare";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Spike (option b): in workerd Kit does RPC, instruction building and transaction compile/encode; every ed25519
// operation goes through @noble/curves. Nothing here patches globals: production must not either.
// workerd has native Ed25519 but no `globalThis.isSecureContext`, and Kit's browser build asserts it
// (@solana/assertions src/subtle-crypto.ts:14, assertIsSecureContext) before any subtle-crypto call.
const network = setupNetwork();
beforeAll(() => {
  expect((globalThis as { isSecureContext?: boolean }).isSecureContext).toBeUndefined();
  network.enable();
});
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SYSTEM = "11111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
// Owner = ed25519 pubkey of a 32-byte fill seed. Cross-checked against Kit's node build in
// test/node/solana-ata-vector.test.ts. KEEP THE TWO TABLES IN SYNC: change both together (duplication is deliberate).
const ATA_ROWS: { fill: number; mint: string; ata: string; bump: number }[] = [
  { fill: 10, mint: WSOL, ata: "6fs3QdNuKuqJZWzmyv5gWACgcKa7N5bt16EcxsSBmy8Q", bump: 249 },
  { fill: 12, mint: USDC, ata: "aPf5sExn4TfsaLgjPXkBLucQC5SBop8UHMpiuwnoqy9", bump: 250 },
  { fill: 4, mint: WSOL, ata: "GWq4Tm57y4ZuxdBKjUo97Qg9vJdTPx2gCkNELDaLhGqS", bump: 251 },
  { fill: 2, mint: WSOL, ata: "HAVBuXWTeBuLPzkPrDYhmc4CkFB7xCRLLhEeBHpccn5W", bump: 252 },
  { fill: 1, mint: USDC, ata: "3wvJdyFnGvaMWpbq93NU91SggiVRveULUXL6iX5VZDGP", bump: 254 },
  { fill: 8, mint: WSOL, ata: "2iEknxJzBEL6o3Bb8fwERAu79F8hDAnrVUFX1jVoWTLi", bump: 255 },
  { fill: 3, mint: USDC, ata: "DNDTCnZkNk358qDFZd9unHtnrc73SsXcpVWtwJJMrR4B", bump: 255 },
];
// Used as the (known-correct) ATA of SEED for the USDC transfer test; bump 255.
const EXPECTED_ATA = "FjCjyojZLVYVQ2dEdDKQx76msks96TdH9xqvc8BQ9UUx";
const DEST_SEED = new Uint8Array(32).fill(5);
const BLOCKHASH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";

const kit = () => import("@solana/kit");

async function buildAndSign(instructions: (owner: string) => Promise<unknown[]>) {
  const k = await kit();
  const pub = ed25519.getPublicKey(SEED);
  const owner = k.getAddressDecoder().decode(pub);
  const message = k.pipe(
    k.createTransactionMessage({ version: 0 }),
    (m) => k.setTransactionMessageFeePayer(owner, m),
    (m) => k.setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, m),
  );
  let m: any = message;
  for (const ix of await instructions(owner)) m = k.appendTransactionMessageInstruction(ix as never, m);
  const tx = k.compileTransaction(m);
  const sig = ed25519.sign(tx.messageBytes as unknown as Uint8Array, SEED);
  const signed = { ...tx, signatures: { ...tx.signatures, [owner]: sig as never } };
  const wire = k.getBase64EncodedWireTransaction(signed as never);
  // round trip
  const bytes = Uint8Array.from(atob(wire), (c) => c.charCodeAt(0));
  const decoded = k.getTransactionDecoder().decode(bytes);
  expect(ed25519.verify(sig, tx.messageBytes as unknown as Uint8Array, pub)).toBe(true);
  expect(Array.from(decoded.messageBytes)).toEqual(Array.from(tx.messageBytes as unknown as Uint8Array));
  expect(Array.from(decoded.signatures[owner as never] as unknown as Uint8Array)).toEqual(Array.from(sig));
  return { owner, decoded };
}

describe("kit (no crypto) in workerd", () => {
  it("getBalance against a mocked RPC", async () => {
    let seen: { id: number; method: string } | undefined;
    network.use(
      http.post("https://sol.test/rpc", async ({ request }) => {
        seen = (await request.json()) as { id: number; method: string };
        return HttpResponse.json({ jsonrpc: "2.0", id: seen.id, result: { context: { slot: 1 }, value: 123456789 } });
      }),
    );
    const { createSolanaRpc, address } = await kit();
    const res = await createSolanaRpc("https://sol.test/rpc").getBalance(address(SYSTEM)).send();
    expect(seen?.method).toBe("getBalance");
    expect(res.value).toBe(123456789n);
  });

  it("address from a noble public key via the address decoder", async () => {
    const k = await kit();
    expect(k.getAddressDecoder().decode(new Uint8Array(32))).toBe(SYSTEM);
    const owner = k.getAddressDecoder().decode(ed25519.getPublicKey(SEED));
    expect(owner).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("SOL transfer: compile, sign with noble, encode, decode", async () => {
    const k = await kit();
    const system = await import("@solana-program/system");
    await buildAndSign(async (owner) => [
      system.getTransferSolInstruction({ source: k.createNoopSigner(owner as never), destination: k.getAddressDecoder().decode(ed25519.getPublicKey(DEST_SEED)), amount: 1n }),
    ]);
  });

  it("USDC transferChecked with idempotent ATA creation", async () => {
    const k = await kit();
    const token = await import("@solana-program/token");
    const dest = k.getAddressDecoder().decode(ed25519.getPublicKey(DEST_SEED));
    await buildAndSign(async (owner) => {
      const ownerSigner = k.createNoopSigner(owner as never);
      const src = k.address(EXPECTED_ATA);
      return [
        token.getCreateAssociatedTokenIdempotentInstruction({
          payer: ownerSigner,
          ata: src,
          owner: owner as never,
          mint: USDC as never,
        }),
        token.getTransferCheckedInstruction({
          source: src,
          mint: USDC as never,
          destination: dest,
          authority: ownerSigner,
          amount: 5n,
          decimals: 6,
        }),
      ];
    });
  });
});

describe("PDA derivation", () => {
  // Hand-written for workerd: Kit's getProgramDerivedAddress needs subtle digest (asserted as a secure context).
  const PDA_MARK = new TextEncoder().encode("ProgramDerivedAddress");
  const realOnCurve = (b: Uint8Array) => {
    try {
      ed25519.Point.fromBytes(b);
      return true;
    } catch {
      return false;
    }
  };
  async function findPda(programId: string, seeds: Uint8Array[], onCurve = realOnCurve): Promise<[string, number]> {
    const k = await kit();
    const prog = k.getAddressEncoder().encode(programId as never) as unknown as Uint8Array;
    for (let bump = 255; bump >= 0; bump--) {
      const parts = [...seeds, Uint8Array.of(bump), prog, PDA_MARK];
      const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) (buf.set(p, o), (o += p.length));
      const h = sha256(buf);
      if (!onCurve(h)) return [k.getAddressDecoder().decode(h), bump];
    }
    throw new Error("no bump");
  }
  async function ataOf(fill: number, mint: string, onCurve = realOnCurve) {
    const k = await kit();
    const token = await import("@solana-program/token");
    const enc = k.getAddressEncoder();
    const owner = k.getAddressDecoder().decode(ed25519.getPublicKey(new Uint8Array(32).fill(fill)));
    return findPda(
      token.ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      [owner, token.TOKEN_PROGRAM_ADDRESS, mint].map((a) => enc.encode(a as never) as unknown as Uint8Array),
      onCurve,
    );
  }

  it("canary: Kit's findAssociatedTokenPda throws in workerd without isSecureContext", async () => {
    const k = await kit();
    const token = await import("@solana-program/token");
    const owner = k.getAddressDecoder().decode(ed25519.getPublicKey(SEED));
    await expect(
      token.findAssociatedTokenPda({ owner, mint: USDC as never, tokenProgram: token.TOKEN_PROGRAM_ADDRESS }),
    ).rejects.toThrow(/secure browser contexts/);
  });

  it("hand-written derivation matches every Node-derived row (address and bump)", async () => {
    for (const r of ATA_ROWS) {
      const [ata, bump] = await ataOf(r.fill, r.mint);
      expect({ ata, bump }, `fill ${r.fill}`).toEqual({ ata: r.ata, bump: r.bump });
    }
    expect(ATA_ROWS.filter((r) => r.bump < 255).length).toBeGreaterThanOrEqual(3);
  });

  it("legacy vector: SEED + USDC", async () => {
    const k = await kit();
    const token = await import("@solana-program/token");
    const enc = k.getAddressEncoder();
    const owner = k.getAddressDecoder().decode(ed25519.getPublicKey(SEED));
    const [ata, bump] = await findPda(
      token.ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      [owner, token.TOKEN_PROGRAM_ADDRESS, USDC].map((a) => enc.encode(a as never) as unknown as Uint8Array),
    );
    expect({ ata, bump }).toEqual({ ata: EXPECTED_ATA, bump: 255 });
  });

  it("negative: an on-curve check that always says off-curve gives the wrong address for a sub-255 row", async () => {
    const row = ATA_ROWS.find((r) => r.bump < 255)!;
    const [ata, bump] = await ataOf(row.fill, row.mint, () => false);
    expect(bump).toBe(255);
    expect(ata).not.toBe(row.ata);
  });
});

describe("kit key canaries (must throw in workerd; production uses noble)", () => {
  it("generateKeyPairSigner throws (@solana/assertions subtle-crypto.ts:14 via keys key-pair.ts:30)", async () => {
    const { generateKeyPairSigner } = await kit();
    await expect(generateKeyPairSigner()).rejects.toThrow(/secure browser contexts/);
  });
  it("createKeyPairSignerFromPrivateKeyBytes throws (subtle-crypto.ts:14 via keys public-key.ts:29)", async () => {
    const { createKeyPairSignerFromPrivateKeyBytes } = await kit();
    await expect(createKeyPairSignerFromPrivateKeyBytes(SEED)).rejects.toThrow(/secure browser contexts/);
  });
});

describe("noble in workerd", () => {
  it("signs a 32-byte hash with secp256k1", () => {
    const priv = new Uint8Array(32).fill(3);
    const hash = new Uint8Array(32).fill(7);
    const sig = secp256k1.sign(hash, priv, { prehash: false });
    expect(secp256k1.verify(sig, hash, secp256k1.getPublicKey(priv), { prehash: false })).toBe(true);
  });
});
