import type { Hex, TransactionSerializableEIP1559, TransactionSerializableLegacy } from "viem";
import { FACTORY_ABI, RAILGUN_SHIELD_ABI } from "../chains/evm/abi";
import { evmChainOf, type EvmChain } from "../chains/evm/config";
import { assetOf, DestinationNotAllowed, requirePays, requireProof, requireShield, type Allowed, type DestinationKind, type Pay } from "../routing/guard";
import type { ShieldRequest } from "../routing/railgun/note";

// viem is imported inside the function, never at module scope (test/node/startup-imports.test.ts).

/*
 * The only EVM signer. The destinations are derived from the tx as serialized (the bytes signed), never from what the
 * caller says it is: an empty-data tx pays `to`; otherwise the selector must be one the gateway sends and its calldata
 * must decode exactly:
 *   a9059cbb transfer(to, amount)         pays the recipient (hot, swap or refund; never a contract of ours)
 *   095ea7b3 approve(spender, amount)     the spender must be the chain's Railgun proxy; amount < 2^120 (a shield
 *                                         value is uint120: an unlimited approval is never sent)
 *   990b65f5 deployAndFlush(salts,tokens) `to` must be the factory (its forwarders pay only the immutable sink = hot)
 *   d0e30db0 deposit()                    `to` must be the chain's wrapper; the only call that may carry value
 *   044a40c3 shield(ShieldRequest[])      `to` must be the chain's Railgun proxy, with a shield proof (allowedShield)
 *                                         that binds the one request it carries: npk, token, value and ciphertext are
 *                                         rebuilt from the bound note under the hot wallet's own shield key
 *                                         (requireShield); single-use, like a swap or refund proof
 * Forwarder.flush is factory-only, so the hot wallet never sends it: refused like any other selector. A value-bearing
 * call to anything but deposit(), a contract creation, a tx type other than legacy/EIP-1559 and an unknown chain id
 * are refused. Value-moving destinations (native value, token transfers) are checked with requirePays, so a bound
 * swap or refund proof covers only its exact asset and amount. The key is the hot wallet's, derived here. After
 * signing, the signed tx is parsed back and must have the same chain, to, data and value.
 */

export type EvmUnsignedTx = (Omit<TransactionSerializableLegacy, "chainId" | "to"> | Omit<TransactionSerializableEIP1559, "chainId" | "to">) & { chainId: number; to: Hex };
type Need = { address: string; kinds: readonly DestinationKind[]; what: string; pays?: { asset: string | null; amount: bigint }; shield?: readonly ShieldRequest[] };
const UINT120_MAX = (1n << 120n) - 1n;
const PAYEE: readonly DestinationKind[] = ["hot", "swap", "refund"];
const SEL = { transfer: "0xa9059cbb", approve: "0x095ea7b3", deployAndFlush: "0x990b65f5", deposit: "0xd0e30db0", shield: "0x044a40c3" } as const;

/** transfer/approve calldata: selector + a clean address word + a uint256 word, nothing more. */
function addressArg(chain: EvmChain, data: string): string {
  if (data.length !== 2 + 8 + 128) throw new DestinationNotAllowed(chain, "calldata is not exactly (address, uint256)");
  const w = data.slice(10, 74);
  if (!/^0{24}[0-9a-f]{40}$/.test(w)) throw new DestinationNotAllowed(chain, "address argument is not a clean 20-byte word");
  return `0x${w.slice(24)}`;
}

async function destinations(chain: EvmChain, to: string, data: string, value: bigint): Promise<Need[]> {
  const native = assetOf(chain, null);
  if (data === "0x") return [{ address: to, kinds: [...PAYEE, "weth"], what: "recipient", pays: { asset: native, amount: value } }];
  const sel = data.slice(0, 10);
  if (sel === SEL.deposit) {
    if (data !== SEL.deposit) throw new DestinationNotAllowed(chain, "deposit() calldata has extra bytes");
    return [{ address: to, kinds: ["weth"], what: "wrapper", pays: { asset: native, amount: value } }];
  }
  if (value !== 0n) throw new DestinationNotAllowed(chain, "a value-bearing call is only allowed to the wrapper's deposit()");
  if (sel === SEL.transfer)
    return [{ address: addressArg(chain, data), kinds: PAYEE, what: "token recipient", pays: { asset: assetOf(chain, to), amount: BigInt(`0x${data.slice(74)}`) } }];
  if (sel === SEL.approve) {
    const spender = addressArg(chain, data);
    if (BigInt(`0x${data.slice(74)}`) > UINT120_MAX) throw new DestinationNotAllowed(chain, "approve amount is above uint120 (an unlimited approval is never sent)");
    return [{ address: spender, kinds: ["railgun"], what: "approve spender" }];
  }
  if (sel === SEL.deployAndFlush || sel === SEL.shield) {
    const { decodeFunctionData, encodeFunctionData } = await import("viem");
    const abi = sel === SEL.shield ? RAILGUN_SHIELD_ABI : FACTORY_ABI;
    let exact = false;
    let decoded: readonly unknown[] = [];
    try {
      const { functionName, args } = decodeFunctionData({ abi, data: data as Hex });
      exact = encodeFunctionData({ abi, functionName, args } as never).toLowerCase() === data;
      decoded = args ?? [];
    } catch {
      exact = false;
    }
    if (!exact) throw new DestinationNotAllowed(chain, "calldata does not decode exactly");
    return sel === SEL.shield
      ? [{ address: to, kinds: ["railgun"], what: "shield target", shield: decoded[0] as readonly ShieldRequest[] }]
      : [{ address: to, kinds: ["factory"], what: "flush target" }];
  }
  throw new DestinationNotAllowed(chain, `selector ${sel} is not one the gateway sends`);
}

/**
 * Signs `tx` with the hot wallet of `env` once every destination of the serialized tx is covered by `proofs` (see
 * above); throws DestinationNotAllowed, signing nothing, otherwise. Returns the signed serialized tx. A shield's note
 * must be for env.RAILGUN_0ZK_ADDRESS as it is now: no caller can name another receiver.
 */
export async function signEvmTx(env: { MASTER_SEED?: string; RAILGUN_0ZK_ADDRESS?: string }, tx: EvmUnsignedTx, proofs: readonly Allowed[]): Promise<Hex> {
  const [{ parseTransaction, serializeTransaction }, { hotAccount }] = await Promise.all([import("viem"), import("./evmkeys")]);
  const anyChain = "evm";
  const t = tx as TransactionSerializableLegacy | TransactionSerializableEIP1559;
  let parsed: ReturnType<typeof parseTransaction>;
  try {
    parsed = parseTransaction(serializeTransaction(t));
  } catch {
    throw new DestinationNotAllowed(anyChain, "the tx does not serialize");
  }
  const chain = parsed.chainId === undefined ? null : evmChainOf(parsed.chainId);
  if (!chain) throw new DestinationNotAllowed(anyChain, `chain id ${String(parsed.chainId)} is not a supported EVM chain`);
  if (parsed.type !== "legacy" && parsed.type !== "eip1559") throw new DestinationNotAllowed(chain, `tx type ${parsed.type} is not allowed`);
  if (!parsed.to) throw new DestinationNotAllowed(chain, "contract creation is not allowed");
  const to = parsed.to.toLowerCase();
  const data = (parsed.data ?? "0x").toLowerCase();
  const value = parsed.value ?? 0n;
  const needs = await destinations(chain, to, data, value);
  const pays: Pay[] = [];
  const shields: Need[] = [];
  for (const n of needs) {
    if (n.pays) pays.push({ address: n.address, kinds: n.kinds, what: n.what, ...n.pays });
    else if (n.shield) shields.push(n);
    else requireProof(proofs, chain, n.address, n.kinds, n.what);
  }
  const account = hotAccount(env);
  if (parsed.nonce === undefined) throw new DestinationNotAllowed(chain, "the tx has no nonce");
  // A bound proof belongs to its first (chain, from, nonce): a fee-bump replacement re-signs that slot, nothing else.
  const slot = { slot: `${parsed.chainId}:${account.address.toLowerCase()}:${parsed.nonce}` };
  if (shields.length > 0) {
    const { shieldPrivateKeyFromHot } = await import("../routing/railgun/note");
    const key = await shieldPrivateKeyFromHot(account);
    for (const n of shields) await requireShield(proofs, chain, n.address, n.shield!, key, slot, env.RAILGUN_0ZK_ADDRESS);
  }
  requirePays(proofs, chain, pays, slot);

  const raw = await account.signTransaction(t);
  const s = parseTransaction(raw);
  if (s.chainId !== parsed.chainId || s.to?.toLowerCase() !== to || (s.data ?? "0x").toLowerCase() !== data || (s.value ?? 0n) !== value || s.type !== parsed.type)
    throw new Error("evm signer: the signed tx differs from the checked one");
  return raw;
}

/**
 * The Railgun shield private key of the hot wallet (keccak256 of its signature of "RAILGUN_SHIELD", see
 * routing/railgun/note.ts). It encrypts shield notes and cannot spend anything; the signing account never leaves
 * src/signing, only this derived key does.
 */
export async function railgunShieldKey(env: { MASTER_SEED?: string }): Promise<Uint8Array> {
  const [{ hotAccount }, { shieldPrivateKeyFromHot }] = await Promise.all([import("./evmkeys"), import("../routing/railgun/note")]);
  return shieldPrivateKeyFromHot(hotAccount(env));
}
