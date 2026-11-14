import type { Env } from "../env";
import { normalizeSetting, publicOrigin, publicUrlPinned } from "../settings";
import { LOOPBACK_HOSTS } from "./session";

/*
 * Where a passkey ceremony may run: the one place that decides it for claim, recovery, sign-in, adding a passkey and
 * action confirmation.
 *
 * Invariant: sessions and passkeys only exist for the PUBLIC_URL origin. Sign-in, adding a passkey and the confirm
 * challenge run only when the request's origin (scheme, host and port) is PUBLIC_URL's. Claim and recovery bind to the
 * request's own origin, which then becomes PUBLIC_URL (claim, or a recovery that moves); when a Wrangler var pins
 * PUBLIC_URL, they run only on that origin. Passkeys cannot be bound to an IP address (an RP ID is a domain), so no
 * ceremony starts on an IPv4 or IPv6 literal host; `localhost` works. Plain http reaches none of this except on a
 * loopback host: the admin middleware sends it to https first (httpsUpgrade).
 */

export type RelyingParty = { rpId: string; origin: string };
/**
 * A ceremony's relying party, or the message to show instead of starting one and why: an IP-literal host, PUBLIC_URL
 * unset, another origin than PUBLIC_URL, an origin that cannot be PUBLIC_URL (http off loopback), or a pinning var.
 */
export type RpRefusal = { ok: false; error: string; reason: "ip" | "unset" | "elsewhere" | "http" | "pinned" };
export type RpCheck = { ok: true; rp: RelyingParty } | RpRefusal;

export const NO_PUBLIC_URL = "This gateway has no public address yet. Use “Lost your passkey or moved?” to set it to this address.";
export const NO_HTTPS = "Open the gateway over https:// to use passkeys here (http:// works only on localhost).";

/** An IPv4 or IPv6 literal, as URL.hostname spells it (IPv4 is always canonical dotted decimal, IPv6 bracketed). */
export const isIpLiteral = (hostname: string): boolean => hostname.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);

/** The https URL an http request on a non-loopback host is sent to (308), or null when it may stay. */
export function httpsUpgrade(url: string): string | null {
  const u = new URL(url);
  if (u.protocol !== "http:" || LOOPBACK_HOSTS.has(u.hostname)) return null;
  u.protocol = "https:";
  return u.toString();
}

function ipRefusal(u: URL, page: string): RpRefusal {
  const error = LOOPBACK_HOSTS.has(u.hostname)
    ? `Passkeys cannot use an IP address. Open http://localhost${u.port ? `:${u.port}` : ""}${page} instead.`
    : "Passkeys cannot use an IP address. Open the gateway on its domain name instead.";
  return { ok: false, error, reason: "ip" };
}

/**
 * Sign-in, adding a passkey and action confirmation: PUBLIC_URL's relying party, only when the request came in on
 * exactly PUBLIC_URL's origin. `page` is the admin path named in the refusal ("Open <PUBLIC_URL><page>").
 */
export function publicRp(env: Pick<Env, "PUBLIC_URL">, requestUrl: string, page: string): RpCheck {
  const u = new URL(requestUrl);
  if (isIpLiteral(u.hostname)) return ipRefusal(u, page);
  const pub = publicOrigin(env);
  if (pub === null) return { ok: false, error: NO_PUBLIC_URL, reason: "unset" };
  if (u.origin !== pub) return { ok: false, error: `Open ${pub}${page}`, reason: "elsewhere" };
  return { ok: true, rp: { rpId: u.hostname, origin: u.origin } };
}

/**
 * Claim and recovery: the request's own origin, if it can be stored as PUBLIC_URL and passkeys can bind to it. While a
 * Wrangler var pins PUBLIC_URL, only that origin.
 */
export function requestRp(env: Env, requestUrl: string, page: string): RpCheck {
  const u = new URL(requestUrl);
  if (isIpLiteral(u.hostname)) return ipRefusal(u, page);
  try {
    if (normalizeSetting("PUBLIC_URL", u.origin) !== u.origin) return { ok: false, error: NO_HTTPS, reason: "http" };
  } catch {
    return { ok: false, error: NO_HTTPS, reason: "http" };
  }
  if (publicUrlPinned(env)) {
    const pub = publicOrigin(env) ?? env.PUBLIC_URL;
    if (pub !== u.origin) return { ok: false, error: `PUBLIC_URL is set by a Wrangler var to ${pub}: open ${pub}${page}, or change the var.`, reason: "pinned" };
  }
  return { ok: true, rp: { rpId: u.hostname, origin: u.origin } };
}

/** PUBLIC_URL's host: the RP ID of every passkey that can sign in now (null while PUBLIC_URL is unset). */
export function currentRpId(env: Pick<Env, "PUBLIC_URL">): string | null {
  const pub = publicOrigin(env);
  return pub === null ? null : new URL(pub).hostname;
}
