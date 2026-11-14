// MANUAL live spike (Plan 4, Task 1, Step 6): shields a small amount of USDC from the Arbitrum hot wallet into a
// Railgun `0zk` address, using 0Crypto's own note builder. It spends real funds. Operator steps: docs/railgun-spike.md.
//   op read "op://Vault/0crypto/MASTER_SEED" | npx tsx scripts/railgun-shield-once.ts --chain arb --amount 1 \
//     --rpc https://... --to "$RAILGUN_0ZK_ADDRESS" --i-understand-this-spends-real-funds
import { createWalletClient, erc20Abi, http, type Address, type Hex } from "viem";
import { arbitrum } from "viem/chains";
import { evmClient } from "../src/chains/evm/chains";
import { hotAccount } from "../src/signing/evmkeys";
import { assertValidMnemonic } from "../src/core/mnemonic";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { validateRailgunDestination } from "../src/routing/railgun/address";
import { buildShieldRequest, getSharedSymmetricKey, shieldPrivateKeyFromHot } from "../src/routing/railgun/note";
import { USAGE, parseShieldOnceArgs } from "./railgun-shield-once-args";

/** RailgunSmartWallet proxy on Arbitrum (spec table; @railgun-community/shared-models NETWORK_CONFIG.Arbitrum). */
const RAILGUN_PROXY_ARB: Address = "0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9";
/** Railgun's chain for Arbitrum (shared-models NETWORK_CONFIG.Arbitrum.chain). */
const ARBITRUM_RAILGUN_CHAIN = { type: 0, id: 42161 };
/** Native USDC on Arbitrum. */
const USDC_ARB: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

/** `shield(ShieldRequest[])` from the engine's V2.1 RailgunSmartWallet ABI. */
const SHIELD_ABI = [
  {
    type: "function",
    name: "shield",
    stateMutability: "payable",
    outputs: [],
    inputs: [
      {
        name: "_shieldRequests",
        type: "tuple[]",
        components: [
          {
            name: "preimage",
            type: "tuple",
            components: [
              { name: "npk", type: "bytes32" },
              {
                name: "token",
                type: "tuple",
                components: [
                  { name: "tokenType", type: "uint8" },
                  { name: "tokenAddress", type: "address" },
                  { name: "tokenSubID", type: "uint256" },
                ],
              },
              { name: "value", type: "uint120" },
            ],
          },
          {
            name: "ciphertext",
            type: "tuple",
            components: [
              { name: "encryptedBundle", type: "bytes32[3]" },
              { name: "shieldKey", type: "bytes32" },
            ],
          },
        ],
      },
    ],
  },
] as const;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("pipe the seed phrase on stdin (it is never taken from arguments or the environment)");
  let out = "";
  for await (const chunk of process.stdin) out += chunk;
  return out.trim().replace(/\s+/g, " ");
}

// The RPC URL usually carries an API key: it is redacted from anything printed.
let rpcSecret: string | undefined;
const redact = (msg: string) => (rpcSecret ? msg.split(rpcSecret).join("<rpc>") : msg);

const hexToBytes = (h: Hex) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));

async function main() {
  // Refuses before reading the seed or touching the network unless the spend flag is present.
  const args = parseShieldOnceArgs(process.argv.slice(2));
  rpcSecret = args.rpc;
  // Decodes, checks the viewing key is an ed25519 point, and refuses an address bound to a chain other than Arbitrum.
  const receiver = validateRailgunDestination(args.to, ARBITRUM_RAILGUN_CHAIN);
  const seed = assertValidMnemonic(await readStdin());
  const hot = hotAccount({ MASTER_SEED: seed });
  const client = await evmClient({ EVM_RPC_ARB: args.rpc }, "arb");
  const wallet = createWalletClient({ account: hot, chain: arbitrum, transport: http(args.rpc, { retryCount: 0 }) });

  console.log(`hot wallet: ${hot.address}`);
  console.log(`receiver:   ${args.to.slice(0, 12)}...${args.to.slice(-6)}${receiver.chain ? ` (chain ${receiver.chain.type}:${receiver.chain.id})` : " (all chains)"}`);
  console.log(`amount:     ${args.amount} atomic USDC (expect ${(args.amount * 9975n) / 10000n} after the 0.25% shield fee)`);

  const [usdc, eth] = await Promise.all([
    client.readContract({ address: USDC_ARB, abi: erc20Abi, functionName: "balanceOf", args: [hot.address] }),
    client.getBalance({ address: hot.address }),
  ]);
  if (usdc < args.amount) throw new Error(`hot wallet holds ${usdc} atomic USDC, less than ${args.amount}`);
  if (eth === 0n) throw new Error("hot wallet has no ETH for gas");

  const shieldPrivateKey = await shieldPrivateKeyFromHot(hot);
  const random = crypto.getRandomValues(new Uint8Array(16));
  const req = await buildShieldRequest({ receiver0zk: args.to, token: USDC_ARB, value: args.amount, shieldPrivateKey, random });

  // Self-check before spending: the random decrypts from the bundle as the receiver's wallet will decrypt it.
  const [b0, b1] = req.ciphertext.encryptedBundle.map(hexToBytes) as [Uint8Array, Uint8Array];
  const key = await crypto.subtle.importKey("raw", new Uint8Array(await getSharedSymmetricKey(shieldPrivateKey, receiver.viewingPublicKey)), "AES-GCM", false, ["decrypt"]);
  const back = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(b0.subarray(0, 16)), tagLength: 128 }, key, new Uint8Array([...b1.subarray(0, 16), ...b0.subarray(16)])),
  );
  if (Buffer.from(back).toString("hex") !== Buffer.from(random).toString("hex")) throw new Error("self-check failed: the note's random does not decrypt");
  // ...and the decrypted random with the receiver's master public key gives the note's npk.
  const npk = poseidon2([receiver.masterPublicKey, BigInt(`0x${Buffer.from(back).toString("hex")}`)]);
  if (npk !== BigInt(req.preimage.npk)) throw new Error("self-check failed: poseidon(mpk, decrypted random) is not the note's npk");

  const allowance = await client.readContract({ address: USDC_ARB, abi: erc20Abi, functionName: "allowance", args: [hot.address, RAILGUN_PROXY_ARB] });
  if (allowance < args.amount) {
    const approveTx = await wallet.writeContract({ address: USDC_ARB, abi: erc20Abi, functionName: "approve", args: [RAILGUN_PROXY_ARB, args.amount] });
    console.log(`approve tx: ${approveTx}`);
    const r = await client.waitForTransactionReceipt({ hash: approveTx });
    if (r.status !== "success") throw new Error(`approve reverted: ${approveTx}`);
  }

  const { request } = await client.simulateContract({ account: hot, address: RAILGUN_PROXY_ARB, abi: SHIELD_ABI, functionName: "shield", args: [[req]] });
  const tx = await wallet.writeContract(request);
  console.log(`shield tx:  ${tx}`);
  const receipt = await client.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new Error(`shield reverted: ${tx}`);
  console.log(`mined in block ${receipt.blockNumber}: https://arbiscan.io/tx/${tx}`);
  console.log("Record this tx hash in docs/railgun-spike.md. Set RAILGUN_GOLDEN_OK=1 only once the funds show in the Railgun wallet.");
}

main().catch((e: unknown) => {
  // viem errors carry a shortMessage without the request details (which include the URL).
  const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  console.error(`railgun-shield-once: ${redact(msg)}`);
  console.error(USAGE);
  process.exit(1);
});
