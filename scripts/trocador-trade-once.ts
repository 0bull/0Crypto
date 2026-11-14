// MANUAL live spike (Plan 4, Task 3): prints Trocador's /coin entries for the 7 coins, then a quote, and with --send also
// creates ONE real swap and prints its deposit address. It never signs or sends anything: you pay the printed deposit
// address by hand from your OWN wallet. Never uses gateway keys. Steps: docs/trocador-spike.md.
//   TROCADOR_API_KEY=... npx tsx scripts/trocador-trade-once.ts --asset btc:btc --amount 0.0005 --xmr <addr> \
//     --i-understand-this-spends-real-funds [--send]
import { TROCADOR_BASE, TROCADOR_TICKERS, XMR_COIN, trocador } from "../src/routing/trocador";
import type { Env } from "../src/env";
import { USAGE, parseTradeOnceArgs } from "./trocador-trade-once-args";

async function main() {
  const args = parseTradeOnceArgs(process.argv.slice(2));
  const key = process.env.TROCADOR_API_KEY;
  if (!key) throw new Error("set TROCADOR_API_KEY in the environment");
  const from = TROCADOR_TICKERS[args.asset]!;

  // 1. The raw /coin entries, so the operator can confirm or correct the expected network strings.
  const tickers = [...new Set([...Object.values(TROCADOR_TICKERS).map((c) => c.ticker), XMR_COIN.ticker])];
  for (const t of tickers) {
    const res = await fetch(`${TROCADOR_BASE}/coin?ticker=${encodeURIComponent(t)}`, { headers: { "API-Key": key }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`/coin?ticker=${t} failed: HTTP ${res.status}`);
    console.log(`/coin?ticker=${t}`, JSON.stringify(await res.json()));
  }
  console.log("Expected:", JSON.stringify(TROCADOR_TICKERS), "xmr:", JSON.stringify(XMR_COIN));

  // 2. Quote, and optionally the trade, through the same client the gateway uses. The in-memory KV is this process only.
  const mem = new Map<string, string>();
  const KV = {
    get: async (k: string) => mem.get(k) ?? null,
    put: async (k: string, v: string) => void mem.set(k, v),
  } as unknown as KVNamespace;
  const client = trocador({ KV, TROCADOR_API_KEY: key, TROCADOR_MIN_KYC: process.env.TROCADOR_MIN_KYC || "A", TROCADOR_LIVE_OK: "1" } as Env);
  const q = await client.quote(from, args.amount, args.decimals);
  console.log("quote:", JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  if (!args.send) {
    console.log("No trade created. Re-run with --send to create the swap and print its deposit address.");
    return;
  }
  const t = await client.trade({ rateId: q.rateId, provider: q.provider, from, amountFrom: args.amount, decimals: args.decimals, xmrAddress: args.xmr });
  console.log("trade:", JSON.stringify(t));
  if (t.depositMemo) console.log("WARNING: this deposit needs a memo; the gateway does not support memos. Do NOT pay it; treat this coin as unsupported.");
  console.log(`Now send exactly the amount, by hand, from your own wallet, to ${t.depositAddress}. Then watch: status of trade ${t.tradeId}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "failed");
  if (/refusing to run|needs a value|unknown argument|--/.test(String(e instanceof Error ? e.message : ""))) console.error(USAGE);
  process.exit(1);
});
