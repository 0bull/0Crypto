import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { ASSOCIATED_TOKEN_PROGRAM, findAta, TOKEN_PROGRAM } from "../chains/solana/pda";
import { COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM, type CompiledSweep } from "../chains/solana/sweeptx";
import { getAsset } from "../core/assets";
import { assetOf, DestinationNotAllowed, proofsFor, requirePays, requireProof, type Allowed, type DestinationKind, type Pay } from "../routing/guard";
import type { KeySpec } from "./addresses";
import { solDepositKey, solHotKey, type SolKey } from "./keys";

// Kit is imported inside the function, never at module scope (test/node/startup-imports.test.ts).

/*
 * The only Solana signer. Destinations come from the compiled message bytes it signs (Kit's decoder), instruction by
 * instruction; any program or instruction not listed is refused, as are address lookup tables:
 *   ComputeBudget SetComputeUnitLimit / SetComputeUnitPrice   no destination
 *   System transfer                                           pays its destination SOL (hot, swap or refund)
 *   Token transferChecked                                     pays its destination token account, which must be
 *                                                             the ATA (for its mint) of an owner with a proof; the
 *                                                             owner is the one paid (that mint, that amount)
 *   Token closeAccount                                        its rent goes to the destination: hot only
 *   Associated Token create / createIdempotent                funds the ATA of its owner (the payer pays the rent):
 *                                                             the ATA must derive from (owner, mint), owner proven;
 *                                                             an owner proven only by a bound (swap or refund) proof
 *                                                             gets the ATA of that proof's asset's mint, nothing else
 * Paid destinations go through requirePays: a swap or refund proof covers only one payment of its exact asset and
 * amount to its address. ATA creation pays no value of its own and only needs its owner proven. The signer set is
 * the message header's; the keys are derived here from the KeySpecs, which must give exactly it. Every signature is
 * verified before the wire bytes are built. Errors never carry key material.
 */

const PAYEE: readonly DestinationKind[] = ["hot", "swap", "refund"];

type Decoded = {
  header: { numSignerAccounts: number };
  staticAccounts: string[];
  instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
  addressTableLookups?: unknown[];
};

const no = (why: string): never => {
  throw new DestinationNotAllowed("sol", why);
};
const u32le = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0, true);
const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i]);

/** The owner, among the proofs' addresses, whose ATA for `mint` is `account`. */
function ataOwner(proofs: readonly Allowed[], account: string, mint: string, kinds: readonly DestinationKind[]): string {
  const hit = proofsFor(proofs, "sol").find((p) => kinds.includes(p.kind) && findAta(p.address, mint)[0] === account);
  return hit ? hit.address : no(`token account ${account} is not the ${mint} ATA of an allowed owner`);
}
const u64le = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

function checkInstruction(program: string, acc: string[], data: Uint8Array, proofs: readonly Allowed[], pays: Pay[]): void {
  switch (program) {
    case COMPUTE_BUDGET_PROGRAM:
      if (acc.length === 0 && ((data[0] === 2 && data.length === 5) || (data[0] === 3 && data.length === 9))) return;
      return no("ComputeBudget instruction other than the unit limit and price");
    case SYSTEM_PROGRAM:
      if (data.length === 12 && u32le(data) === 2 && acc.length === 2) {
        pays.push({ address: acc[1]!, kinds: PAYEE, what: "SOL transfer destination", asset: assetOf("sol", null), amount: u64le(data, 4) });
        return;
      }
      return no("system instruction other than a transfer");
    case TOKEN_PROGRAM:
      if (data[0] === 12 && data.length === 10 && acc.length === 4) {
        const owner = ataOwner(proofs, acc[2]!, acc[1]!, PAYEE);
        pays.push({ address: owner, kinds: PAYEE, what: "token transfer owner", asset: assetOf("sol", acc[1]!), amount: u64le(data, 1) });
        return;
      }
      if (data[0] === 9 && data.length === 1 && acc.length === 3) {
        // The account's rent goes to the destination: hot only (no bound proof may cover it).
        pays.push({ address: acc[1]!, kinds: ["hot"], what: "closeAccount destination", asset: null, amount: null });
        return;
      }
      return no("token instruction other than transferChecked and closeAccount");
    case ASSOCIATED_TOKEN_PROGRAM:
      if ((data.length === 0 || same(data, Uint8Array.of(0)) || same(data, Uint8Array.of(1))) && acc.length === 6 && acc[4] === SYSTEM_PROGRAM && acc[5] === TOKEN_PROGRAM) {
        let ata: string;
        try {
          ata = findAta(acc[2]!, acc[3]!)[0];
        } catch {
          return no("associated token account owner or mint is not an address");
        }
        if (ata !== acc[1]) no("associated token account does not derive from its owner and mint");
        const owner = requireProof(proofs, "sol", acc[2]!, PAYEE, "associated token account owner").address;
        // A trade deposit (or refund) owner is proven only to receive its bound asset: only that mint's ATA is created for it.
        const fits = (p: Allowed) => p.kind === "hot" || (p.asset !== undefined && getAsset(p.asset).contract === acc[3]);
        if (!proofsFor(proofs, "sol").some((p) => p.address === owner && PAYEE.includes(p.kind) && fits(p)))
          no(`associated token account for mint ${acc[3]} is not for the asset its owner's proof allows`);
        return;
      }
      return no("associated token instruction other than create");
    default:
      return no(`program ${program} is not allowed`);
  }
}

/**
 * Signs a compiled tx with noble once every destination in its message is covered by `proofs` (see above); throws
 * DestinationNotAllowed, signing nothing, otherwise. `keys` must be exactly the message's signers. Returns the fee
 * payer's signature (the tx id, base58) and the base64 wire tx.
 */
export async function signSolanaTx(seed: string, c: CompiledSweep, specs: readonly KeySpec[], proofs: readonly Allowed[]): Promise<{ signature: string; wire: string }> {
  const k = await import("@solana/kit");
  const tx = c.tx as { messageBytes: Uint8Array; signatures: Record<string, unknown> };
  if (!same(tx.messageBytes, c.messageBytes)) throw new Error("solana signer: the compiled tx and its message bytes differ");
  let m: Decoded;
  try {
    m = k.getCompiledTransactionMessageDecoder().decode(c.messageBytes) as unknown as Decoded;
  } catch {
    return no("the message does not decode");
  }
  if ((m.addressTableLookups?.length ?? 0) > 0) no("address table lookups hide accounts");
  const keysOf = m.staticAccounts;
  const pays: Pay[] = [];
  for (const ix of m.instructions) {
    const program = keysOf[ix.programAddressIndex];
    const accounts = (ix.accountIndices ?? []).map((i) => keysOf[i]);
    if (program === undefined || accounts.some((x) => x === undefined)) no("account index out of range");
    checkInstruction(program!, accounts as string[], ix.data ?? new Uint8Array(), proofs, pays);
  }
  const keys: SolKey[] = specs.map((s) => (s.role === "hot" ? solHotKey(seed) : solDepositKey(seed, s.index)));

  const signers = keysOf.slice(0, m.header.numSignerAccounts);
  const byAddress = new Map(keys.map((x) => [x.address, x]));
  if (byAddress.size !== keys.length || signers.length !== byAddress.size || signers.some((s) => !byAddress.has(s)) || signers[0] !== c.feePayer)
    throw new Error("solana: the keys given are not exactly the tx's signers");
  for (const s of signers) {
    const key = byAddress.get(s)!;
    if (base58.encode(key.pub) !== s || base58.encode(ed25519.getPublicKey(key.priv)) !== s) throw new Error(`solana: the key for ${s} does not match its address`);
  }
  // Last check before signing (a bound proof is spent by it): only a failed self-verification follows.
  requirePays(proofs, "sol", pays);
  const sigs: Record<string, Uint8Array> = {};
  for (const s of signers) {
    const key = byAddress.get(s)!;
    const sig = ed25519.sign(c.messageBytes, key.priv);
    if (!ed25519.verify(sig, c.messageBytes, key.pub)) throw new Error(`solana: the signature of ${s} does not verify`);
    sigs[s] = sig;
  }
  const wire = k.getBase64EncodedWireTransaction({ ...tx, signatures: { ...tx.signatures, ...sigs } } as never);
  return { signature: base58.encode(sigs[c.feePayer]!), wire };
}
