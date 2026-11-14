import type { WebhookJob } from "../env";

export type { WebhookJob };

const enc = new TextEncoder();

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Returns the `0Crypto-Signature` header value: `t=<unix>,v1=<hex>`. */
export async function signWebhook(secret: string, body: string, t: number): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}

export async function verifyWebhook(
  secret: string,
  header: string | null | undefined,
  body: string,
  now: number,
  toleranceSec = 300,
): Promise<boolean> {
  if (!header) return false;
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1 = v;
  }
  if (t === undefined || v1 === undefined) return false;
  if (!/^\d+$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const ts = Number(t);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > toleranceSec) return false;
  return safeEqual(v1, await hmacHex(secret, `${t}.${body}`));
}
