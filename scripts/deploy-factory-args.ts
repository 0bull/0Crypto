import { EVM_CHAINS, type EvmChain } from "../src/chains/evm/config";

export interface DeployArgs {
  chain: EvmChain;
  rpc: string;
  dryRun: boolean;
}

export const USAGE = "usage: echo \"$SEED\" | npm run deploy:factory -- --chain <eth|base|arb|polygon|bsc> --rpc <url> [--dry-run]";

/** Parses `--chain <id> --rpc <url> [--dry-run]`. Anything else (including a seed flag) is an error: the seed only comes from stdin. */
export function parseDeployArgs(argv: string[]): DeployArgs {
  let chain: string | undefined;
  let rpc: string | undefined;
  let dryRun = false;
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--chain") chain = value(++i, a);
    else if (a === "--rpc") rpc = value(++i, a);
    else if (a === "--dry-run") dryRun = true;
    else throw new Error(`unknown argument: ${a.startsWith("--") ? a : "(positional)"}`);
  }
  if (!chain) throw new Error("--chain is required");
  if (!Object.hasOwn(EVM_CHAINS, chain)) throw new Error(`--chain must be one of ${Object.keys(EVM_CHAINS).join(", ")}`);
  if (!rpc) throw new Error("--rpc is required");
  let url: URL;
  try {
    url = new URL(rpc);
  } catch {
    throw new Error("--rpc must be a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("--rpc must be an http(s) URL");
  return { chain: chain as EvmChain, rpc, dryRun };
}
