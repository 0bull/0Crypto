// Test-only software authenticator: drives real WebAuthn registration and authentication ceremonies against
// src/admin/webauthn.ts without a browser. A P-256 (ES256) key, "none" attestation, and a minimal CBOR encoder.
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function head(major: number, n: number): number[] {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 0x100) return [m | 24, n];
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff];
  return [m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** Minimal CBOR: unsigned and negative ints, byte strings, text strings and maps (keys in insertion order). */
export function cbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  const enc = (x: Cbor) => {
    if (typeof x === "number") {
      if (!Number.isSafeInteger(x)) throw new Error("cbor: only integers");
      out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    } else if (typeof x === "string") {
      const b = new TextEncoder().encode(x);
      out.push(...head(3, b.length), ...b);
    } else if (x instanceof Uint8Array) {
      out.push(...head(2, x.length), ...x);
    } else {
      out.push(...head(5, x.size));
      for (const [k, val] of x) {
        enc(k);
        enc(val);
      }
    }
  };
  enc(v);
  return Uint8Array.from(out);
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const b64u = (b: Uint8Array) => base64urlnopad.encode(b);
const utf8 = (s: string) => new TextEncoder().encode(s);

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class SoftAuthenticator {
  readonly credentialId: string;
  readonly cosePublicKey: Uint8Array;
  counter = 0;
  readonly #secretKey: Uint8Array;
  readonly #countsSignatures: boolean;
  #userHandle: string | undefined;

  constructor(opts?: { countsSignatures?: boolean }) {
    this.#countsSignatures = opts?.countsSignatures ?? true;
    this.#secretKey = p256.utils.randomSecretKey();
    this.credentialId = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const pub = p256.getPublicKey(this.#secretKey, false); // 0x04 | x | y
    this.cosePublicKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, pub.slice(1, 33)],
        [-3, pub.slice(33, 65)],
      ]),
    );
  }

  /** navigator.credentials.create(). `flags` overrides the authData flags (default UP|UV|AT). */
  async register(o: PublicKeyCredentialCreationOptionsJSON, origin: string, opts?: { flags?: number }): Promise<RegistrationResponseJSON> {
    const rpId = o.rp.id ?? new URL(origin).hostname;
    this.#userHandle = o.user.id;
    const clientDataJSON = utf8(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin, crossOrigin: false }));
    const credId = base64urlnopad.decode(this.credentialId);
    const authData = concat(
      sha256(utf8(rpId)),
      Uint8Array.of(opts?.flags ?? FLAG_UP | FLAG_UV | FLAG_AT),
      u32(this.counter),
      new Uint8Array(16), // aaguid
      Uint8Array.of(credId.length >> 8, credId.length & 0xff),
      credId,
      this.cosePublicKey,
    );
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get(). `flags` overrides the authData flags (default UP|UV). */
  async assert(o: PublicKeyCredentialRequestOptionsJSON, origin: string, opts?: { flags?: number }): Promise<AuthenticationResponseJSON> {
    const rpId = o.rpId ?? new URL(origin).hostname;
    if (this.#countsSignatures) this.counter += 1;
    const clientDataJSON = utf8(JSON.stringify({ type: "webauthn.get", challenge: o.challenge, origin, crossOrigin: false }));
    const authData = concat(sha256(utf8(rpId)), Uint8Array.of(opts?.flags ?? FLAG_UP | FLAG_UV), u32(this.counter));
    // ES256: DER ECDSA over sha256(authData || sha256(clientDataJSON)); p256.sign prehashes with sha256.
    const der = p256.sign(concat(authData, sha256(clientDataJSON)), this.#secretKey, { format: "der" });
    const response: AuthenticationResponseJSON["response"] = { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(der) };
    if (this.#userHandle !== undefined) response.userHandle = this.#userHandle;
    return { id: this.credentialId, rawId: this.credentialId, type: "public-key", response, clientExtensionResults: {}, authenticatorAttachment: "platform" };
  }
}
