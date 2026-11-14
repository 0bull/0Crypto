import type { ChainId } from "../core/types";
import type { Env } from "../env";

/** How long one chain's pollers stand down after any of them is rate-limited (60 s is the KV minimum). */
export const BACKOFF_TTL_SEC = 60;

const key = (chain: ChainId) => `backoff:${chain}`;

/** True when the error, or any cause up to depth 5, carries HTTP status 429 (explorer errors, viem HttpRequestError). */
export function isRateLimited(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== null && typeof cur === "object"; i++) {
    if ((cur as { status?: unknown }).status === 429) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export async function chainBackedOff(env: Env, chain: ChainId): Promise<boolean> {
  try {
    return (await env.KV.get(key(chain), { cacheTtl: BACKOFF_TTL_SEC })) !== null;
  } catch {
    return false;
  }
}

export async function noteRateLimited(env: Env, chain: ChainId): Promise<void> {
  try {
    await env.KV.put(key(chain), "1", { expirationTtl: BACKOFF_TTL_SEC });
  } catch {
    // best effort: without the flag each watcher just finds the 429 itself
  }
}
