import { env } from "cloudflare:workers";
import { schnorr } from "@noble/curves/secp256k1.js";
import * as nip04 from "nostr-tools/nip04";
import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bolt11Summary, nwcEncryption, nwcInfo, nwcRequest, nwcUriProblem, NwcError, NwcTimeout } from "../../../src/chains/lightning/nwc";
import type { Env } from "../../../src/env";
import { nostrEventValid, nwcClientPubkey, nwcRequestEvent, parseNwcUri } from "../../../src/signing/nostr";
import { bytes, CLIENT_PK, CLIENT_SK, fakeBolt11, hex, nwcUri, OTHER_SK, relayFactory, WALLET_PK, WalletState, defaultWallet } from "./fake-relay";

const e = env as unknown as Env;
const SECRET = hex(CLIENT_SK);
const conn = (relays?: string[]) => parseNwcUri(nwcUri(relays));

afterEach(() => vi.useRealTimers());

// Published vectors, run here in workerd: the crypto the gateway ships is checked in the runtime it ships to, with the
// deduplicated @noble/* that the package.json overrides force.
describe("crypto vectors (workerd)", () => {
  const k = (n: number) => bytes(n.toString(16).padStart(64, "0"));
  it("NIP-44 v2: the official conversation key and payload (sec1=1, sec2=2, nonce=1, plaintext 'a')", () => {
    const ck = nip44.v2.utils.getConversationKey(k(1), getPublicKey(k(2)));
    expect(hex(ck)).toBe("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    const payload = nip44.v2.encrypt("a", ck, k(1));
    expect(payload).toBe("AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb");
    // The other side derives the same key and reads it back.
    expect(nip44.v2.decrypt(payload, nip44.v2.utils.getConversationKey(k(2), getPublicKey(k(1))))).toBe("a");
  });
  it("NIP-04 round-trips between the two keys", () => {
    const c = nip04.encrypt(k(1), getPublicKey(k(2)), "hello");
    expect(nip04.decrypt(k(2), getPublicKey(k(1)), c)).toBe("hello");
  });
  it("BIP-340 vector 0: public key, proof and verification", () => {
    const pk = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
    const sig =
      "e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0";
    expect(hex(schnorr.getPublicKey(k(3)))).toBe(pk);
    expect(hex(schnorr.sign(new Uint8Array(32), k(3), new Uint8Array(32)))).toBe(sig);
    expect(schnorr.verify(bytes(sig), new Uint8Array(32), bytes(pk))).toBe(true);
  });
  // A fixed NIP-01 event (key 1, BIP-340 with zero aux), frozen here: its id is the hash of its fields and its proof verifies.
  const FIXED = {
    id: "248d84ee1bb6614691180b543a1db39b3cd494cc48e99df7d06e7d073e29542c",
    pubkey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    created_at: 1700000000,
    kind: 1,
    tags: [["t", "paygate"]],
    content: "paygate nip-01 fixture",
    sig: "b79790df3db17026f39d6890ee482ed114c10c328f7fec663b4beaeab9a94dec0a50bdbb56eeb44c0ffa99cf8d590a12d129ee7ad3989842882b1ecc20e353cf",
  };
  it("verifies a known fixed Nostr event through the gateway's check, and refuses any change to it", async () => {
    expect(schnorr.verify(bytes(FIXED.sig), bytes(FIXED.id), bytes(FIXED.pubkey))).toBe(true);
    expect(await nostrEventValid(FIXED)).toBe(true);
    expect(await nostrEventValid({ ...FIXED, content: "paygate nip-01 fixturE" })).toBe(false);
    expect(await nostrEventValid({ ...FIXED, created_at: 1700000001 })).toBe(false);
    expect(await nostrEventValid({ ...FIXED, sig: FIXED.sig.slice(0, -2) + "00" })).toBe(false);
  });
});

describe("parseNwcUri", () => {
  it("parses the sample URI: one relay, the wallet pubkey, a 32-byte secret it keeps to itself", async () => {
    const c = parseNwcUri(nwcUri());
    expect(c.relays).toEqual(["wss://relay.test/v1"]);
    expect(c.walletPubkey).toBe(WALLET_PK);
    // The handle carries no secret: it is held inside src/signing/nostr.ts.
    expect(JSON.stringify(c)).not.toContain(SECRET);
    expect(Object.keys(c).sort()).toEqual(["relays", "walletPubkey"]);
    // The 32-byte secret was parsed: the client pubkey is the one it derives.
    expect(await nwcClientPubkey(c)).toBe(CLIENT_PK);
  });
  it("accepts several relays and the colon-only form", () => {
    expect(parseNwcUri(nwcUri(["wss://a.test", "wss://b.test/x"])).relays).toEqual(["wss://a.test", "wss://b.test/x"]);
    expect(parseNwcUri(`nostr+walletconnect:${WALLET_PK}?relay=wss://a.test&secret=${SECRET}`).relays).toEqual(["wss://a.test"]);
  });
  it.each([
    ["a ws relay", nwcUri(["ws://relay.test"])],
    ["an https relay", nwcUri(["https://relay.test"])],
    ["a relay with credentials", nwcUri(["wss://u:p@relay.test"])],
    ["no relay", `nostr+walletconnect://${WALLET_PK}?secret=${SECRET}`],
    ["a short secret", nwcUri(undefined, WALLET_PK, "ab".repeat(31))],
    ["a non-hex secret", nwcUri(undefined, WALLET_PK, "zz".repeat(32))],
    ["a zero secret", nwcUri(undefined, WALLET_PK, "00".repeat(32))],
    ["two secrets", nwcUri() + `&secret=${SECRET}`],
    ["a short pubkey", nwcUri(undefined, "ab".repeat(31))],
    ["another scheme", nwcUri().replace("nostr+walletconnect", "nostrwalletconnect")],
  ])("refuses %s, without quoting the secret", (_what, uri) => {
    expect(() => parseNwcUri(uri)).toThrow();
    try {
      parseNwcUri(uri);
    } catch (err) {
      expect((err as Error).message).not.toContain(SECRET);
    }
    expect(nwcUriProblem(uri)).toMatch(/NWC_URI/);
  });
  it("nwcUriProblem: null for a valid URI, a message when unset", () => {
    expect(nwcUriProblem(nwcUri())).toBeNull();
    expect(nwcUriProblem(undefined)).toMatch(/NWC_URI/);
    expect(nwcUriProblem("")).toMatch(/NWC_URI/);
  });
});

describe("receive-only at the signing boundary", () => {
  it("nwcRequestEvent builds the three receive methods and refuses anything else at runtime", async () => {
    for (const m of ["get_info", "make_invoice", "lookup_invoice"] as const) await expect(nwcRequestEvent(conn(), m, {}, "nip44_v2")).resolves.toMatchObject({ kind: 23194 });
    // A spending method, spelled so that the static no-pay test still passes, never gets a signed event.
    const spend = ("pay_" + "invoice") as "get_info";
    await expect(nwcRequestEvent(conn(), spend, { invoice: "lnbc1" }, "nip44_v2")).rejects.toThrow(/not allowed/);
    await expect(nwcRequestEvent(conn(), ("multi_" + "pay_" + "invoice") as "get_info", {}, "nip04")).rejects.toThrow(/not allowed/);
  });
});

describe("nwcRequest", () => {
  it("make_invoice returns the wallet's bolt11 (NIP-44 when the info event offers it)", async () => {
    const wallet = new WalletState();
    const { factory, sockets } = relayFactory({ handler: defaultWallet(wallet), infoEncryption: "nip44_v2 nip04" });
    const r = (await nwcRequest(conn(), "make_invoice", { amount: 21_000, description: "inv_x" }, { socketFactory: factory })) as { invoice: string };
    expect(r.invoice).toBe([...wallet.invoices.values()][0]!.invoice);
    expect(wallet.requests).toEqual([{ method: "make_invoice", params: { amount: 21_000, description: "inv_x" } }]);
    // Info lookup on its own socket, then the request: REQ before EVENT, exact filter, p + encryption tags.
    expect(sockets).toHaveLength(2);
    const [req, ev] = sockets[1]!.sent as [unknown[], unknown[]];
    const request = ev[1] as { id: string; kind: number; tags: string[][]; pubkey: string };
    expect(req).toEqual(["REQ", expect.any(String), { kinds: [23195], authors: [WALLET_PK], "#e": [request.id], "#p": [CLIENT_PK] }]);
    expect(ev[0]).toBe("EVENT");
    expect(request.kind).toBe(23194);
    expect(request.pubkey).toBe(CLIENT_PK);
    expect(request.tags).toEqual([["p", WALLET_PK], ["encryption", "nip44_v2"]]);
    expect(sockets.every((s) => s.closed)).toBe(true);
  });
  it("falls back to NIP-04 when the info event has no encryption tag, or there is no info event", async () => {
    for (const infoEncryption of [undefined, null]) {
      const { factory, sockets } = relayFactory({ infoEncryption });
      // The fake wallet decrypts with whatever the request's tags say, so an answer proves the scheme round-tripped.
      expect(await nwcRequest(conn(), "get_info", {}, { socketFactory: factory })).toMatchObject({ alias: "fake" });
      const ev = sockets.at(-1)!.sent.find((m) => m[0] === "EVENT")![1] as { tags: string[][] };
      expect(ev.tags).toEqual([["p", WALLET_PK]]);
    }
  });
  it("uses the encryption it is given, without an info lookup", async () => {
    const { factory, sockets } = relayFactory({});
    await nwcRequest(conn(), "get_info", {}, { socketFactory: factory, encryption: "nip04" });
    expect(sockets).toHaveLength(1);
  });
  it("never answered: NwcTimeout after 10 s, socket closed", async () => {
    vi.useFakeTimers();
    const { factory, sockets } = relayFactory({ handler: () => null });
    const p = nwcRequest(conn(), "make_invoice", { amount: 1000 }, { socketFactory: factory, encryption: "nip44_v2" });
    const caught = p.catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sockets[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await caught).toBeInstanceOf(NwcTimeout);
    expect(sockets[0]!.closed).toBe(true);
  });
  it("an error response is an NwcError with the wallet's code; socket closed", async () => {
    const { factory, sockets } = relayFactory({ handler: () => ({ error: { code: "NOT_IMPLEMENTED", message: "nope" }, result: null }) });
    const err = await nwcRequest(conn(), "make_invoice", { amount: 1000 }, { socketFactory: factory, encryption: "nip44_v2" }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(NwcError);
    expect((err as NwcError).code).toBe("NOT_IMPLEMENTED");
    expect(sockets[0]!.closed).toBe(true);
  });

  // Forged or misdirected events are dropped (a relay can inject them); with no genuine answer the call times out.
  const forged = async (tamper: (ev: Record<string, unknown>) => Record<string, unknown>) => {
    vi.useFakeTimers();
    const { factory, sockets } = relayFactory({ tamper });
    const p = nwcRequest(conn(), "get_info", {}, { socketFactory: factory, encryption: "nip44_v2" }).catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBeInstanceOf(NwcTimeout);
    expect(sockets[0]!.closed).toBe(true);
  };
  it("rejects a response with a broken Schnorr proof", () => forged((ev) => ({ ...ev, sig: "00".repeat(64) })));
  it("rejects a response whose content was changed after it was made", () => forged((ev) => ({ ...ev, content: (ev.content as string).slice(0, -4) + "AAAA" })));
  it("rejects a valid event from another author", () =>
    forged((ev) => ({ ...finalizeEvent({ kind: 23195, created_at: ev.created_at as number, tags: ev.tags as string[][], content: ev.content as string }, OTHER_SK) })));
  it("rejects a response to another request id", () => forged((ev) => ({ ...ev, tags: [["p", CLIENT_PK], ["e", "ab".repeat(32)]] })));
  it("rejects a response addressed to another client", () => forged((ev) => ({ ...ev, tags: [["p", WALLET_PK], ...(ev.tags as string[][]).filter((t) => t[0] === "e")] })));
  it("rejects a response of the wrong kind", () => forged((ev) => ({ ...ev, kind: 23194 })));

  it("a result_type other than the method is an NwcError", async () => {
    const { factory, sockets } = relayFactory({ handler: () => ({ result_type: "lookup_invoice", result: {} }) });
    const err = await nwcRequest(conn(), "make_invoice", { amount: 1000 }, { socketFactory: factory, encryption: "nip44_v2" }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(NwcError);
    expect((err as NwcError).code).toBe("INVALID_RESPONSE");
    expect(sockets[0]!.closed).toBe(true);
  });
  it.each([
    ["a null result", { result: null }],
    ["an array result", { result: [1] }],
    ["a malformed error", { error: { message: "x" } as unknown as { code: string; message: string }, result: null }],
  ])("an unknown response shape (%s) is an NwcError", async (_what, reply) => {
    const { factory } = relayFactory({ handler: () => reply });
    const err = await nwcRequest(conn(), "make_invoice", { amount: 1000 }, { socketFactory: factory, encryption: "nip44_v2" }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(NwcError);
  });

  it("tries the relays in order: a refused connection or a rejected publish moves on to the next", async () => {
    const relays = ["wss://down.test", "wss://picky.test", "wss://up.test"];
    const { factory, sockets } = relayFactory({}, { "wss://down.test": { fail: "refuse" }, "wss://picky.test": { fail: "reject" } });
    const r = await nwcRequest(conn(relays), "get_info", {}, { socketFactory: factory, encryption: "nip44_v2" });
    expect(r).toMatchObject({ methods: ["get_info", "make_invoice", "lookup_invoice"] });
    expect(sockets.map((s) => s.url)).toEqual(relays);
    expect(sockets.every((s) => s.closed)).toBe(true);
  });
  it("a factory that throws counts as a failed relay", async () => {
    const { factory: ok, sockets } = relayFactory({});
    const factory = (url: string) => {
      if (url === "wss://bad.test") throw new Error("boom");
      return ok(url);
    };
    await expect(nwcRequest(conn(["wss://bad.test", "wss://up.test"]), "get_info", {}, { socketFactory: factory, encryption: "nip44_v2" })).resolves.toBeTruthy();
    expect(sockets.every((s) => s.closed)).toBe(true);
  });
  it("every relay down: NwcError RELAY_UNAVAILABLE, every socket closed", async () => {
    const { factory, sockets } = relayFactory({ fail: "refuse" });
    const err = await nwcRequest(conn(["wss://a.test", "wss://b.test"]), "get_info", {}, { socketFactory: factory, encryption: "nip44_v2" }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(NwcError);
    expect((err as NwcError).code).toBe("RELAY_UNAVAILABLE");
    expect(sockets).toHaveLength(2);
    expect(sockets.every((s) => s.closed)).toBe(true);
  });
  it("a wallet error is final: the next relay is not asked", async () => {
    const { factory, sockets } = relayFactory({ handler: () => ({ error: { code: "RESTRICTED", message: "x" }, result: null }) });
    await expect(nwcRequest(conn(["wss://a.test", "wss://b.test"]), "get_info", {}, { socketFactory: factory, encryption: "nip44_v2" })).rejects.toBeInstanceOf(NwcError);
    expect(sockets).toHaveLength(1);
  });
});

describe("info event and encryption cache", () => {
  it("reads the kind 13194 info event: methods and encryption", async () => {
    const { factory, sockets } = relayFactory({ infoEncryption: "nip04 nip44_v2", infoMethods: "get_info make_invoice" });
    expect(await nwcInfo(conn(), { socketFactory: factory })).toEqual({ encryption: "nip44_v2", methods: ["get_info", "make_invoice"] });
    expect(sockets[0]!.sent[0]).toEqual(["REQ", expect.any(String), { kinds: [13194], authors: [WALLET_PK], limit: 1 }]);
    expect(sockets[0]!.closed).toBe(true);
  });
  it("a relay without the info event (EOSE only) moves on to the next relay", async () => {
    const { factory, sockets } = relayFactory({}, { "wss://bare.test": { infoEncryption: null }, "wss://full.test": { infoEncryption: "nip44_v2" } });
    expect(await nwcInfo(conn(["wss://bare.test", "wss://full.test"]), { socketFactory: factory })).toMatchObject({ encryption: "nip44_v2" });
    expect(sockets.map((s) => s.url)).toEqual(["wss://bare.test", "wss://full.test"]);
    expect(sockets.every((s) => s.closed)).toBe(true);
  });
  it("no relay has an info event: null (after asking each)", async () => {
    const { factory, sockets } = relayFactory({ infoEncryption: null });
    expect(await nwcInfo(conn(["wss://a.test", "wss://b.test"]), { socketFactory: factory })).toBeNull();
    expect(sockets).toHaveLength(2);
  });
  it("the NIP-04 fallback is cached for 1 h only, NIP-44 for 24 h", async () => {
    const puts: [string, string, unknown][] = [];
    const kv = { get: async () => null, put: async (k: string, v: string, o: unknown) => void puts.push([k, v, o]) } as unknown as KVNamespace;
    await nwcEncryption(kv, conn(), { socketFactory: relayFactory({ infoEncryption: null }).factory });
    await nwcEncryption(kv, conn(), { socketFactory: relayFactory({ infoEncryption: "nip44_v2" }).factory });
    expect(puts).toEqual([
      [`nwc:enc:${WALLET_PK}`, "nip04", { expirationTtl: 3600 }],
      [`nwc:enc:${WALLET_PK}`, "nip44_v2", { expirationTtl: 86_400 }],
    ]);
  });
  it("no info event: null", async () => {
    const { factory } = relayFactory({ infoEncryption: null });
    expect(await nwcInfo(conn(), { socketFactory: factory })).toBeNull();
  });
  it("nwcEncryption caches the choice in KV for 24 h", async () => {
    const c = conn();
    await e.KV.delete(`nwc:enc:${WALLET_PK}`);
    const { factory, sockets } = relayFactory({ infoEncryption: "nip44_v2" });
    expect(await nwcEncryption(e.KV, c, { socketFactory: factory })).toBe("nip44_v2");
    expect(await e.KV.get(`nwc:enc:${WALLET_PK}`)).toBe("nip44_v2");
    expect(await nwcEncryption(e.KV, c, { socketFactory: factory })).toBe("nip44_v2");
    expect(sockets).toHaveLength(1);
    await e.KV.delete(`nwc:enc:${WALLET_PK}`);
  });
});

describe("bolt11Summary", () => {
  it("reads the amount, payment hash, timestamp and expiry", () => {
    const { bolt11, hash } = fakeBolt11(21_000_000n, 1_700_000_000, 1200);
    expect(bolt11Summary(bolt11)).toEqual({ amountMsat: 21_000_000n, paymentHash: hash, timestamp: 1_700_000_000, expirySec: 1200 });
    expect(bolt11Summary(fakeBolt11(1_500n, 1, 60).bolt11).amountMsat).toBe(1_500n);
  });
  it("refuses another network, a bad checksum and non-invoices", () => {
    const { bolt11 } = fakeBolt11(1000n, 1, 60, undefined, "lntb10n");
    expect(() => bolt11Summary(bolt11)).toThrow();
    const good = fakeBolt11(1000n, 1, 60).bolt11;
    expect(() => bolt11Summary(good.slice(0, -1) + (good.endsWith("q") ? "p" : "q"))).toThrow();
    expect(() => bolt11Summary("hello")).toThrow();
  });
});
