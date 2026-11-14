// Deploys the forwarder factory on one EVM chain. The seed is read from stdin only (never argv or env):
//   op read "op://Vault/0crypto/MASTER_SEED" | npm run deploy:factory -- --chain base --rpc https://... [--dry-run]
import { createPublicClient, createWalletClient, http } from "viem";
import { EVM_CHAINS, VIEM_CHAINS } from "../src/chains/evm/chains";
import { assertValidMnemonic } from "../src/core/mnemonic";
import { hotAccount } from "../src/signing/evmkeys";
import { DETERMINISTIC_DEPLOYER, factoryAddress } from "../src/chains/evm/predict";
import { USAGE, parseDeployArgs } from "./deploy-factory-args";
import { assertChainId, deployFactory } from "./deploy-factory-lib";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("pipe the seed phrase on stdin (it is never taken from arguments or the environment)");
  let out = "";
  for await (const chunk of process.stdin) out += chunk;
  return out.trim().replace(/\s+/g, " ");
}

async function main() {
  const args = parseDeployArgs(process.argv.slice(2));
  // Validated before anything is derived: a mistyped phrase must not silently become a different wallet.
  const seed = assertValidMnemonic(await readStdin());
  const account = hotAccount({ MASTER_SEED: seed });
  const sink = account.address;
  const expected = factoryAddress(sink);
  const info = EVM_CHAINS[args.chain];

  console.log(`chain:   ${args.chain} (id ${info.chainId})`);
  console.log(`sink:    ${sink} (hot wallet)`);
  console.log(`factory: ${expected}`);
  console.log("Compare the sink with the hot wallet on the admin page 'EVM chains' before funding it.");

  const chain = VIEM_CHAINS[args.chain];
  const publicClient = createPublicClient({ chain, transport: http(args.rpc) });
  await assertChainId(publicClient, info.chainId);

  if (args.dryRun) {
    const [deployed, hasDeployer, balance] = await Promise.all([
      publicClient.getCode({ address: expected }),
      publicClient.getCode({ address: DETERMINISTIC_DEPLOYER }),
      publicClient.getBalance({ address: sink }),
    ]);
    console.log(`dry run: factory ${deployed && deployed !== "0x" ? "already deployed" : "not deployed"}; deterministic deployer ${hasDeployer && hasDeployer !== "0x" ? "present" : "MISSING"}; hot wallet balance ${balance} wei. Nothing sent.`);
    return;
  }

  const walletClient = createWalletClient({ account, chain, transport: http(args.rpc) });
  const r = await deployFactory({ walletClient, publicClient, sink, expectedChainId: info.chainId, onSent: (h) => console.log(`sent ${h}, waiting for the receipt...`) });
  console.log(r.status === "already-deployed" ? "already deployed" : `deployed in ${r.txHash}`);
}

main().catch((e: unknown) => {
  // Only the message: an error object could carry request details; the seed is never part of one.
  const msg = (e as { shortMessage?: string } | undefined)?.shortMessage ?? (e instanceof Error ? e.message : "failed");
  console.error(`error: ${msg}`);
  if (e instanceof Error && /argument|required|needs a value|must be/.test(e.message)) console.error(USAGE);
  process.exit(1);
});
