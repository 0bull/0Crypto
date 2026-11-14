import { ASSETS } from "../src/core/assets";
import { parseDecimal } from "../src/core/money";
import { TROCADOR_TICKERS } from "../src/routing/trocador";
import { validateXmrAddress } from "../src/routing/xmr";

export const SPEND_FLAG = "--i-understand-this-spends-real-funds";
export const SEND_FLAG = "--send";

export interface TradeOnceArgs {
  asset: string;
  amount: bigint;
  decimals: number;
  xmr: string;
  /** false: print the /coin entries and the quote only, create nothing. true: also create the trade and print its deposit address. */
  send: boolean;
}

export const USAGE = `usage: TROCADOR_API_KEY=... npx tsx scripts/trocador-trade-once.ts --asset btc:btc --amount 0.0005 --xmr <your XMR address> ${SPEND_FLAG} [${SEND_FLAG}]`;

/** Refuses outright, before anything else is parsed, unless the spend flag is present. The API key comes from the environment only. */
export function parseTradeOnceArgs(argv: string[]): TradeOnceArgs {
  if (!argv.includes(SPEND_FLAG)) throw new Error(`refusing to run: this can create a real swap. Pass ${SPEND_FLAG} to proceed.`);
  let asset: string | undefined;
  let amount: string | undefined;
  let xmr: string | undefined;
  let send = false;
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === SPEND_FLAG) continue;
    if (a === SEND_FLAG) send = true;
    else if (a === "--asset") asset = value(++i, a);
    else if (a === "--amount") amount = value(++i, a);
    else if (a === "--xmr") xmr = value(++i, a);
    else throw new Error(`unknown argument: ${a.startsWith("--") ? a : "(positional)"}`);
  }
  if (!asset || !Object.hasOwn(TROCADOR_TICKERS, asset)) throw new Error(`--asset must be one of ${Object.keys(TROCADOR_TICKERS).join(", ")}`);
  if (!amount) throw new Error("--amount is required");
  const decimals = ASSETS[asset]!.decimals;
  let atomic: bigint;
  try {
    atomic = parseDecimal(amount, decimals);
  } catch {
    throw new Error(`--amount must be a plain decimal with at most ${decimals} decimals`);
  }
  if (atomic <= 0n) throw new Error("--amount must be > 0");
  if (!xmr) throw new Error("--xmr is required (your own XMR address)");
  validateXmrAddress(xmr);
  return { asset, amount: atomic, decimals, xmr, send };
}
