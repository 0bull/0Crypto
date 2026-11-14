export const SPEND_FLAG = "--i-understand-this-spends-real-funds";
/** The live spike shields at most this much (atomic USDC, 6 decimals): it exists to prove the note, not to move money. */
export const MAX_SPIKE_USDC = 5_000_000n;

export interface ShieldOnceArgs {
  chain: "arb";
  /** Atomic USDC (6 decimals). */
  amount: bigint;
  rpc: string;
  /** Receiver `0zk` address. */
  to: string;
}

export const USAGE = `usage: echo "$SEED" | npx tsx scripts/railgun-shield-once.ts --chain arb --amount 1 --rpc <url> --to <0zk address> ${SPEND_FLAG}`;

/**
 * Parses the live-spike arguments. Refuses outright, before anything else is parsed, unless the spend flag is present.
 * The seed only comes from stdin; any other argument (including a positional one, which could be a seed word) is an error.
 */
export function parseShieldOnceArgs(argv: string[]): ShieldOnceArgs {
  if (!argv.includes(SPEND_FLAG)) throw new Error(`refusing to run: this shields real USDC on Arbitrum. Pass ${SPEND_FLAG} to proceed.`);
  let chain: string | undefined;
  let amount: string | undefined;
  let rpc: string | undefined;
  let to: string | undefined;
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === SPEND_FLAG) continue;
    if (a === "--chain") chain = value(++i, a);
    else if (a === "--amount") amount = value(++i, a);
    else if (a === "--rpc") rpc = value(++i, a);
    else if (a === "--to") to = value(++i, a);
    else throw new Error(`unknown argument: ${a.startsWith("--") ? a : "(positional)"}`);
  }
  if (chain !== "arb") throw new Error("--chain must be arb (the spike runs on Arbitrum only)");
  if (!amount || !/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error("--amount must be a USDC amount with at most 6 decimals, e.g. 1");
  const [whole, frac = ""] = amount.split(".");
  const atomic = BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  if (atomic <= 0n) throw new Error("--amount must be > 0");
  if (atomic > MAX_SPIKE_USDC) throw new Error("--amount must be at most 5 USDC");
  if (!rpc) throw new Error("--rpc is required");
  let url: URL;
  try {
    url = new URL(rpc);
  } catch {
    throw new Error("--rpc must be a URL");
  }
  if (url.protocol !== "https:") throw new Error("--rpc must be an https URL");
  if (!to) throw new Error("--to is required (the RAILGUN_0ZK_ADDRESS to shield to)");
  return { chain: "arb", amount: atomic, rpc, to };
}
