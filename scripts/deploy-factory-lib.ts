import { concat, encodeAbiParameters, zeroHash, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import factory from "../contracts/factory-initcode.json";
import { DETERMINISTIC_DEPLOYER, factoryAddress } from "../src/chains/evm/predict";

export interface DeployResult {
  address: Address;
  status: "deployed" | "already-deployed";
  txHash?: Hex;
}

const hasCode = async (client: PublicClient, address: Address): Promise<boolean> => {
  const code = await client.getCode({ address });
  return code !== undefined && code !== "0x";
};

/** Throws unless the RPC reports `expected` as its chain id (a wrong --rpc must never receive a deployment). */
export async function assertChainId(client: PublicClient, expected: number): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== expected) throw new Error(`the RPC is on chain id ${actual}, expected ${expected}`);
}

/**
 * Deploys the forwarder factory for `sink` through the deterministic deployer (salt 0), from the wallet client's account.
 * The init code is the committed fixture, never a fresh compile, so the address is the one the Worker predicts.
 * Idempotent: if code already exists at the predicted address nothing is sent.
 */
export async function deployFactory(args: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  sink: Address;
  /** When set, nothing is read or sent unless the RPC is on this chain id. */
  expectedChainId?: number;
  /** Called with the transaction hash right after it is sent, before waiting for the receipt. */
  onSent?: (txHash: Hex) => void;
}): Promise<DeployResult> {
  const { walletClient, publicClient, sink } = args;
  if (args.expectedChainId !== undefined) await assertChainId(publicClient, args.expectedChainId);
  const expected = factoryAddress(sink);
  if (await hasCode(publicClient, expected)) return { address: expected, status: "already-deployed" };
  if (!(await hasCode(publicClient, DETERMINISTIC_DEPLOYER)))
    throw new Error(`the deterministic deployer (${DETERMINISTIC_DEPLOYER}) has no code on this chain, so the factory cannot be deployed at its predicted address`);

  const data = concat([zeroHash, factory.initcodeWithoutArgs as Hex, encodeAbiParameters([{ type: "address" }], [sink])]);
  const txHash = await walletClient.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data, account: walletClient.account!, chain: walletClient.chain });
  args.onSent?.(txHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`deploy transaction ${txHash} reverted`);
  if (!(await hasCode(publicClient, expected))) throw new Error(`deploy transaction ${txHash} succeeded but there is no code at ${expected}`);
  return { address: expected, status: "deployed", txHash };
}
