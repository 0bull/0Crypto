// WebAuthn (passkeys) for the admin, on @simplewebauthn/server. The library is loaded with dynamic import() only
// (test/node/startup-imports.test.ts): it stays off the Worker's startup path and out of /healthz.
//
// Every verifier returns null on any failure, thrown errors included, so callers have one failure path. What is
// enforced: the challenge (the caller's single-use check, called by the library exactly when it compares it), the
// exact origin, the rpId hash, user presence and user verification, no cross-origin (iframe) ceremony, the
// response id matching the credential, ES256/RS256 keys only, and the counter (0 is accepted from authenticators
// that do not count; otherwise it must grow).
import { base64urlnopad } from "@scure/base";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

export type StoredPasskey = { id: string; public_key: ArrayBuffer | Uint8Array; counter: number; transports: string | null };
/** Consumes `challenge` (the clientDataJSON value) if it is live for this ceremony; true iff it was. */
export type ChallengeCheck = (challenge: string) => Promise<boolean>;

const RP_NAME = "0Crypto";
const USER_NAME = "admin";
const TIMEOUT_MS = 300000;
/** ES256 and RS256. EdDSA (a library default) is left out. */
const ALGORITHMS = [-7, -257];
const TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_ID = 1366;

const lib = () => import("@simplewebauthn/server");

/**
 * The challenge as bytes, so the options (and so clientDataJSON) carry the caller's string unchanged and the
 * ChallengeCheck sees exactly what the caller stored. Throws unless it is canonical unpadded base64url.
 */
function challengeBytes(challenge: string): Uint8Array<ArrayBuffer> {
  if (!B64URL.test(challenge)) throw new Error("challenge is not base64url");
  const bytes = base64urlnopad.decode(challenge);
  if (base64urlnopad.encode(bytes) !== challenge) throw new Error("challenge is not canonical base64url");
  return new Uint8Array(bytes);
}

function sameChallenge<T extends { challenge: string }>(o: T, challenge: string): T {
  if (o.challenge !== challenge) throw new Error("options challenge differs from the issued one");
  return o;
}

const descriptors = (list: { id: string; transports?: string[] }[]) =>
  list.map((c) => (c.transports === undefined ? { id: c.id } : { id: c.id, transports: cleanTransports(c.transports) }));

function cleanTransports(t: unknown): string[] {
  return Array.isArray(t) ? [...new Set(t.filter((x): x is string => typeof x === "string" && TRANSPORTS.has(x)))] : [];
}

/** The response's clientDataJSON says the ceremony ran in a cross-origin frame (or names a top origin). */
function crossOrigin(response: { response?: { clientDataJSON?: unknown } }): boolean {
  const raw = response.response?.clientDataJSON;
  if (typeof raw !== "string" || !B64URL.test(raw)) return true;
  const data: unknown = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(raw)));
  if (!data || typeof data !== "object") return true;
  const d = data as { crossOrigin?: unknown; topOrigin?: unknown };
  return d.crossOrigin === true || d.topOrigin !== undefined;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isCounter = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;

export async function registrationOptions(p: {
  rpId: string;
  userId: Uint8Array;
  challenge: string;
  exclude: { id: string; transports?: string[] }[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { generateRegistrationOptions } = await lib();
  const o = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: p.rpId,
    userName: USER_NAME,
    userID: new Uint8Array(p.userId),
    challenge: challengeBytes(p.challenge),
    timeout: TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: descriptors(p.exclude),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    supportedAlgorithmIDs: ALGORITHMS,
  });
  return sameChallenge(o, p.challenge);
}

export async function verifyRegistration(p: {
  response: unknown;
  check: ChallengeCheck;
  origin: string;
  rpId: string;
}): Promise<{ id: string; publicKey: Uint8Array; counter: number; transports: string[] } | null> {
  try {
    if (!p.origin || !p.rpId || !isObject(p.response) || credentialIdOf(p.response) === null) return null;
    const response = p.response as unknown as RegistrationResponseJSON;
    if (crossOrigin(response)) return null;
    const { verifyRegistrationResponse } = await lib();
    const out = await verifyRegistrationResponse({
      response,
      expectedChallenge: p.check,
      expectedOrigin: p.origin,
      expectedRPID: p.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
    if (!out.verified || !out.registrationInfo?.userVerified) return null;
    const c = out.registrationInfo.credential;
    // The library takes the id from authData; the response's own id must name the same credential.
    if (c.id !== response.id || !isCounter(c.counter)) return null;
    return { id: c.id, publicKey: new Uint8Array(c.publicKey), counter: c.counter, transports: cleanTransports(c.transports) };
  } catch {
    return null;
  }
}

export async function authenticationOptions(p: {
  rpId: string;
  challenge: string;
  allow?: { id: string; transports?: string[] }[];
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { generateAuthenticationOptions } = await lib();
  const o = await generateAuthenticationOptions({
    rpID: p.rpId,
    challenge: challengeBytes(p.challenge),
    timeout: TIMEOUT_MS,
    userVerification: "required",
    ...(p.allow === undefined ? {} : { allowCredentials: descriptors(p.allow) }),
  });
  return sameChallenge(o, p.challenge);
}

export async function verifyAuthentication(p: {
  response: unknown;
  check: ChallengeCheck;
  origin: string;
  rpId: string;
  passkey: StoredPasskey;
}): Promise<{ newCounter: number } | null> {
  try {
    const { passkey } = p;
    if (!p.origin || !p.rpId || !isObject(p.response) || !isCounter(passkey.counter)) return null;
    // The assertion must name the stored credential (the library verifies against whatever key it is given).
    if (credentialIdOf(p.response) !== passkey.id) return null;
    const response = p.response as unknown as AuthenticationResponseJSON;
    if (crossOrigin(response)) return null;
    const { verifyAuthenticationResponse } = await lib();
    const out = await verifyAuthenticationResponse({
      response,
      expectedChallenge: p.check,
      expectedOrigin: p.origin,
      expectedRPID: p.rpId,
      requireUserVerification: true,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: passkey.counter,
        // transports are a browser hint only; the library does not read them when verifying.
      },
    });
    if (!out.verified || !out.authenticationInfo.userVerified) return null;
    const n = out.authenticationInfo.newCounter;
    // Also checked by the library: 0 from an authenticator that never counted; otherwise strictly greater.
    if (!isCounter(n) || ((n > 0 || passkey.counter > 0) && n <= passkey.counter)) return null;
    return { newCounter: n };
  } catch {
    return null;
  }
}

/** The credential id a response claims (`response.id`), if it is a base64url string of at most 1366 chars. */
export function credentialIdOf(response: unknown): string | null {
  if (!isObject(response)) return null;
  const id = response.id;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID && B64URL.test(id) ? id : null;
}
