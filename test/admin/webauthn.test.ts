import { base64urlnopad } from "@scure/base";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import {
  authenticationOptions,
  credentialIdOf,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
  type ChallengeCheck,
  type StoredPasskey,
} from "../../src/admin/webauthn";
import { SoftAuthenticator } from "../passkey";

const RP = "pay.test";
const ORIGIN = "https://pay.test";
const USER = new Uint8Array(16).fill(7);

/** A fresh 32-byte base64url challenge, as src/admin/challenges.ts makes them. */
const newChallenge = () => base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(32)));

/** A single-use challenge store: check() consumes the challenge, like the D1 DELETE ... RETURNING in Task 4. */
function store() {
  const live = new Set<string>();
  const seen: string[] = [];
  return {
    issue() {
      const c = newChallenge();
      live.add(c);
      return c;
    },
    check: (async (c: string) => {
      seen.push(c);
      return live.delete(c);
    }) as ChallengeCheck,
    seen,
  };
}

async function registered(a = new SoftAuthenticator()) {
  const s = store();
  const o = await registrationOptions({ rpId: RP, userId: USER, challenge: s.issue(), exclude: [] });
  const reg = await verifyRegistration({ response: await a.register(o, ORIGIN), check: s.check, origin: ORIGIN, rpId: RP });
  if (!reg) throw new Error("registration failed");
  const passkey: StoredPasskey = { id: reg.id, public_key: reg.publicKey, counter: reg.counter, transports: reg.transports.join(",") };
  return { a, passkey };
}

async function login(a: SoftAuthenticator, passkey: StoredPasskey, opts: { origin?: string; rpId?: string; check?: ChallengeCheck; flags?: number } = {}) {
  const s = store();
  const o = await authenticationOptions({ rpId: RP, challenge: s.issue(), allow: [{ id: passkey.id }] });
  const response = await a.assert(o, opts.origin ?? ORIGIN, opts.flags === undefined ? undefined : { flags: opts.flags });
  return verifyAuthentication({ response, check: opts.check ?? s.check, origin: ORIGIN, rpId: opts.rpId ?? RP, passkey });
}

/** Rewrites the clientDataJSON of a response (base64url JSON) with `edit` applied to its bytes. */
function editClientData<T extends RegistrationResponseJSON | AuthenticationResponseJSON>(r: T, edit: (b: Uint8Array) => void): T {
  const b = base64urlnopad.decode(r.response.clientDataJSON);
  edit(b);
  return { ...r, response: { ...r.response, clientDataJSON: base64urlnopad.encode(b) } };
}

describe("registration options", () => {
  it("carry the plan's WebAuthn settings and echo the challenge unchanged", async () => {
    const challenge = newChallenge();
    const o = await registrationOptions({ rpId: RP, userId: USER, challenge, exclude: [{ id: "abc_-", transports: ["internal"] }] });
    expect(o.challenge).toBe(challenge);
    expect(o.rp).toEqual({ id: RP, name: "0Crypto" });
    expect(o.user.name).toBe("admin");
    expect(o.user.id).toBe(base64urlnopad.encode(USER));
    expect(o.timeout).toBe(300000);
    expect(o.attestation).toBe("none");
    expect(o.authenticatorSelection).toMatchObject({ residentKey: "preferred", userVerification: "required" });
    expect(o.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
    expect(o.excludeCredentials).toEqual([{ id: "abc_-", transports: ["internal"], type: "public-key" }]);
  });

  it("reject a challenge that is not canonical base64url", async () => {
    await expect(registrationOptions({ rpId: RP, userId: USER, challenge: "not base64!", exclude: [] })).rejects.toThrow();
    await expect(authenticationOptions({ rpId: RP, challenge: "" })).rejects.toThrow();
  });
});

describe("authentication options", () => {
  it("require user verification and echo the challenge unchanged", async () => {
    const challenge = newChallenge();
    const o = await authenticationOptions({ rpId: RP, challenge, allow: [{ id: "abc_-" }] });
    expect(o.challenge).toBe(challenge);
    expect(o.rpId).toBe(RP);
    expect(o.userVerification).toBe("required");
    expect(o.timeout).toBe(300000);
    expect(o.allowCredentials).toEqual([{ id: "abc_-", type: "public-key" }]);
    expect((await authenticationOptions({ rpId: RP, challenge })).allowCredentials).toBeUndefined();
  });
});

describe("registration", () => {
  it("round trip: returns the authenticator's credential id, counter 0 and its COSE public key", async () => {
    const a = new SoftAuthenticator();
    const s = store();
    const challenge = s.issue();
    const o = await registrationOptions({ rpId: RP, userId: USER, challenge, exclude: [] });
    const reg = await verifyRegistration({ response: await a.register(o, ORIGIN), check: s.check, origin: ORIGIN, rpId: RP });
    expect(reg).not.toBeNull();
    expect(reg!.id).toBe(a.credentialId);
    expect(reg!.counter).toBe(0);
    expect(reg!.publicKey).toEqual(a.cosePublicKey);
    expect(reg!.transports).toEqual(["internal"]);
    expect(s.seen).toEqual([challenge]); // the library checked (and consumed) exactly the issued challenge, once
  });

  it("a challenge is single-use: replaying the same response fails", async () => {
    const a = new SoftAuthenticator();
    const s = store();
    const o = await registrationOptions({ rpId: RP, userId: USER, challenge: s.issue(), exclude: [] });
    const response = await a.register(o, ORIGIN);
    expect(await verifyRegistration({ response, check: s.check, origin: ORIGIN, rpId: RP })).not.toBeNull();
    expect(await verifyRegistration({ response, check: s.check, origin: ORIGIN, rpId: RP })).toBeNull();
  });

  it("wrong origin, wrong rpId or a failed challenge check each return null", async () => {
    for (const bad of [{ origin: "https://evil.test" }, { rpId: "evil.test" }, { check: (async () => false) as ChallengeCheck }]) {
      const a = new SoftAuthenticator();
      const s = store();
      const o = await registrationOptions({ rpId: RP, userId: USER, challenge: s.issue(), exclude: [] });
      const response = await a.register(o, bad.origin ?? ORIGIN);
      expect(await verifyRegistration({ response, check: bad.check ?? s.check, origin: ORIGIN, rpId: bad.rpId ?? RP }), JSON.stringify(bad)).toBeNull();
    }
  });

  it("without user verification returns null", async () => {
    const a = new SoftAuthenticator();
    const s = store();
    const o = await registrationOptions({ rpId: RP, userId: USER, challenge: s.issue(), exclude: [] });
    const response = await a.register(o, ORIGIN, { flags: 0x41 }); // UP|AT, no UV
    expect(await verifyRegistration({ response, check: s.check, origin: ORIGIN, rpId: RP })).toBeNull();
  });

  it("a response whose id is not the credential in authData returns null", async () => {
    const a = new SoftAuthenticator();
    const s = store();
    const o = await registrationOptions({ rpId: RP, userId: USER, challenge: s.issue(), exclude: [] });
    const other = new SoftAuthenticator().credentialId;
    const response = { ...(await a.register(o, ORIGIN)), id: other, rawId: other };
    expect(await verifyRegistration({ response, check: s.check, origin: ORIGIN, rpId: RP })).toBeNull();
  });

  it("a cross-origin (iframe) ceremony returns null", async () => {
    const a = new SoftAuthenticator();
    const s = store();
    const o = await registrationOptions({ rpId: RP, userId: USER, challenge: s.issue(), exclude: [] });
    const r = await a.register(o, ORIGIN);
    const json = new TextDecoder().decode(base64urlnopad.decode(r.response.clientDataJSON)).replace('"crossOrigin":false', '"crossOrigin":true');
    const response = { ...r, response: { ...r.response, clientDataJSON: base64urlnopad.encode(new TextEncoder().encode(json)) } };
    expect(await verifyRegistration({ response, check: s.check, origin: ORIGIN, rpId: RP })).toBeNull();
  });

  it("garbage input returns null rather than throwing", async () => {
    const s = store();
    for (const response of [null, undefined, 5, "x", {}, { id: "a", rawId: "a", type: "public-key", response: {} }]) {
      expect(await verifyRegistration({ response, check: s.check, origin: ORIGIN, rpId: RP })).toBeNull();
    }
  });
});

describe("authentication", () => {
  it("round trip: a counting authenticator returns { newCounter: 1 }", async () => {
    const { a, passkey } = await registered();
    expect(await login(a, passkey)).toEqual({ newCounter: 1 });
  });

  it("a non-counting authenticator asserts twice and both return { newCounter: 0 }", async () => {
    const { a, passkey } = await registered(new SoftAuthenticator({ countsSignatures: false }));
    const first = await login(a, passkey);
    expect(first).toEqual({ newCounter: 0 });
    expect(await login(a, { ...passkey, counter: first!.newCounter })).toEqual({ newCounter: 0 });
  });

  it("a counting authenticator rolled back below the stored counter returns null", async () => {
    const { a, passkey } = await registered();
    a.counter = 0; // the authenticator reports 1; the server last saw 5 (a cloned key)
    expect(await login(a, { ...passkey, counter: 5 })).toBeNull();
  });

  it("a counter equal to the stored one returns null", async () => {
    const { a, passkey } = await registered();
    a.counter = 4; // reports 5
    expect(await login(a, { ...passkey, counter: 5 })).toBeNull();
  });

  it("accepts the stored public key as an ArrayBuffer (a D1 BLOB)", async () => {
    const { a, passkey } = await registered();
    const pk = passkey.public_key as Uint8Array;
    const blob = pk.buffer.slice(pk.byteOffset, pk.byteOffset + pk.byteLength) as ArrayBuffer;
    expect(await login(a, { ...passkey, public_key: blob })).toEqual({ newCounter: 1 });
  });

  it("wrong origin, wrong rpId or a failed challenge check each return null", async () => {
    const { a, passkey } = await registered();
    expect(await login(a, passkey, { origin: "https://evil.test" })).toBeNull();
    expect(await login(a, passkey, { rpId: "evil.test" })).toBeNull();
    expect(await login(a, passkey, { check: async () => false })).toBeNull();
  });

  it("a challenge is single-use: replaying the same assertion fails", async () => {
    const { a, passkey } = await registered(new SoftAuthenticator({ countsSignatures: false }));
    const s = store();
    const o = await authenticationOptions({ rpId: RP, challenge: s.issue() });
    const response = await a.assert(o, ORIGIN);
    expect(await verifyAuthentication({ response, check: s.check, origin: ORIGIN, rpId: RP, passkey })).toEqual({ newCounter: 0 });
    expect(await verifyAuthentication({ response, check: s.check, origin: ORIGIN, rpId: RP, passkey })).toBeNull();
  });

  it("tampered clientDataJSON (one byte flipped) returns null: the signature covers it", async () => {
    const { a, passkey } = await registered();
    const s = store();
    const o = await authenticationOptions({ rpId: RP, challenge: s.issue() });
    const good = await a.assert(o, ORIGIN);
    // Flip one byte of the origin's host ("pay" -> "pAy") and accept any challenge: only the signature can catch it.
    const at = new TextDecoder().decode(base64urlnopad.decode(good.response.clientDataJSON)).indexOf("pay.test");
    const tampered = editClientData(good, (b) => (b[at + 1]! ^= 0x20));
    const anyChallenge: ChallengeCheck = async () => true;
    expect(await verifyAuthentication({ response: tampered, check: anyChallenge, origin: "https://pAy.test", rpId: RP, passkey })).toBeNull();
    expect(await verifyAuthentication({ response: good, check: anyChallenge, origin: ORIGIN, rpId: RP, passkey })).toEqual({ newCounter: 1 });
  });

  it("an assertion without the UV flag (flags 0x01) returns null", async () => {
    const { a, passkey } = await registered();
    expect(await login(a, passkey, { flags: 0x01 })).toBeNull();
  });

  it("an assertion by another credential returns null", async () => {
    const { passkey } = await registered();
    const { a: other } = await registered();
    expect(await login(other, passkey)).toBeNull();
  });

  it("an assertion from a different key under the stored credential id returns null", async () => {
    const { passkey } = await registered();
    const { a: other } = await registered();
    const s = store();
    const o = await authenticationOptions({ rpId: RP, challenge: s.issue() });
    const r = await other.assert(o, ORIGIN);
    const response = { ...r, id: passkey.id, rawId: passkey.id };
    expect(await verifyAuthentication({ response, check: s.check, origin: ORIGIN, rpId: RP, passkey })).toBeNull();
  });

  it("garbage input returns null rather than throwing", async () => {
    const { passkey } = await registered();
    const s = store();
    for (const response of [null, undefined, 5, "x", {}, { id: passkey.id, rawId: passkey.id, type: "public-key", response: {} }]) {
      expect(await verifyAuthentication({ response, check: s.check, origin: ORIGIN, rpId: RP, passkey })).toBeNull();
    }
  });
});

describe("credentialIdOf", () => {
  it("reads a base64url response.id and nothing else", () => {
    expect(credentialIdOf({ id: "abc_-" })).toBe("abc_-");
    expect(credentialIdOf({ id: 5 })).toBeNull();
    expect(credentialIdOf(null)).toBeNull();
    expect(credentialIdOf(undefined)).toBeNull();
    expect(credentialIdOf({ id: "" })).toBeNull();
    expect(credentialIdOf({ id: "ab+/" })).toBeNull();
    expect(credentialIdOf({ id: "abc=" })).toBeNull();
    expect(credentialIdOf({ id: "a".repeat(1366) })).toBe("a".repeat(1366));
    expect(credentialIdOf({ id: "a".repeat(1367) })).toBeNull();
  });
});
