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

/** Deposit forwarder for payment `index`: OZ Clones.predictDeterministicAddress(implementation, salt, factory). */
export function predictDeposit(factoryAddr: Address, index: number): Address {
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff)
    throw new Error("deposit index must be an integer from 0 to 2147483647");
  // The factory's constructor creates the implementation first: CREATE nonce 1.
  const implementation = getContractAddress({ from: factoryAddr, nonce: 1n });
  const salt = keccak256(encodeAbiParameters([{ type: "uint256" }], [BigInt(index)]));
  const bytecodeHash = keccak256(concat([CLONE_PREFIX, implementation, CLONE_SUFFIX]));
  return getCreate2Address({ from: factoryAddr, salt, bytecodeHash });
}
