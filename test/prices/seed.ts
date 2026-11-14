import type { Env } from "../../src/env";

type Record_ = Record<string, { e8: string; at: number }>;

/** Test helpers for the single `prices` KV key (the same shape src/prices/cache.ts reads). */
export async function putPrice(e: Env, currency: string, symbol: string, e8: bigint | string, at: number = Date.now()): Promise<void> {
  const raw = await e.KV.get("prices");
  const rec: Record_ = raw ? (JSON.parse(raw) as Record_) : {};
  rec[`${currency}:${symbol}`] = { e8: e8.toString(), at };
  await e.KV.put("prices", JSON.stringify(rec));
}

export async function dropPrice(e: Env, currency: string, symbol: string): Promise<void> {
  const raw = await e.KV.get("prices");
  if (!raw) return;
  const rec = JSON.parse(raw) as Record_;
  delete rec[`${currency}:${symbol}`];
  await e.KV.put("prices", JSON.stringify(rec));
}

export const clearPrices = (e: Env) => e.KV.delete("prices");
