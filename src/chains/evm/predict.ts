import {
  concat,
  encodeAbiParameters,
  getContractAddress,
  getCreate2Address,
  keccak256,
  zeroHash,
  type Address,
} from "viem";
import factory from "../../../contracts/factory-initcode.json";

export const DETERMINISTIC_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/** The same address on every EVM chain: the factory is deployed by the deterministic deployer with a zero salt. */
export function factoryAddress(sink: Address): Address {
  return getCreate2Address({
    from: DETERMINISTIC_DEPLOYER,
    salt: zeroHash,
    bytecode: concat([factory.initcodeWithoutArgs as `0x${string}`, encodeAbiParameters([{ type: "address" }], [sink])]),
  });
}

const CLONE_PREFIX = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const CLONE_SUFFIX = "0x5af43d82803e903d91602b57fd5bf3";

/** Validates a derivation index (the shared EVM counter): an integer from 0 to 2^31 - 1. */
export function assertDepositIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff)
    throw new Error("deposit index must be an integer from 0 to 2147483647");
}

/**
 * The salt of deposits made before secret salts: keccak256(abi.encode(uint256(index))). Anyone who knows the factory
 * can compute it for every index, so new deposits use evmDepositSalt (src/signing/addresses.ts) instead. Kept so the
 * sweep can still flush the forwarders of payments created with it.
 */
export function legacyDepositSalt(index: number): `0x${string}` {
  assertDepositIndex(index);
  return keccak256(encodeAbiParameters([{ type: "uint256" }], [BigInt(index)]));
}

/** Forwarder address for a CREATE2 salt: OZ Clones.predictDeterministicAddress(implementation, salt, factory). */
export function predictForwarder(factoryAddr: Address, salt: `0x${string}`): Address {
  // The factory's constructor creates the implementation first: CREATE nonce 1.
  const implementation = getContractAddress({ from: factoryAddr, nonce: 1n });
  const bytecodeHash = keccak256(concat([CLONE_PREFIX, implementation, CLONE_SUFFIX]));
  return getCreate2Address({ from: factoryAddr, salt, bytecodeHash });
}

/** The forwarder of a deposit made with the legacy salt of `index`. */
export function predictLegacyDeposit(factoryAddr: Address, index: number): Address {
  return predictForwarder(factoryAddr, legacyDepositSalt(index));
}

/**
 * The CREATE2 salt of a payment's forwarder: the one whose predicted address is the payment's address. New payments
 * use `secret` (evmDepositSalt of its index), payments made before secret salts the legacy salt. Null when neither
 * matches (MASTER_SEED changed since the payment was made): flushing a guessed forwarder would move nothing.
 */
export function depositSalt(factoryAddr: Address, p: { address: string; derivation_index: number }, secret: `0x${string}`): `0x${string}` | null {
  const want = p.address.toLowerCase();
  for (const salt of [secret, legacyDepositSalt(p.derivation_index)])
    if (predictForwarder(factoryAddr, salt).toLowerCase() === want) return salt;
  return null;
}
