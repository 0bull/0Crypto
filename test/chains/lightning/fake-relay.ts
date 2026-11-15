import * as nip04 from "nostr-tools/nip04";
import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { NwcSocket } from "../../../src/chains/lightning/nwc";

/**
 * A fake Nostr relay with an NWC wallet behind it, speaking through the socketFactory seam. Both sides use real
 * nostr-tools crypto: the wallet checks the request's Schnorr proof, decrypts it (NIP-44 or NIP-04, from the request's
 * `encryption` tag), and answers with an encrypted kind 23195 event it signs with its own key.
 */

export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const bytes = (h: string) => Uint8Array.from(h.match(/../g)!, (b) => parseInt(b, 16));

export const WALLET_SK = bytes("22".repeat(32));
export const WALLET_PK = getPublicKey(WALLET_SK);
export const CLIENT_SK = bytes("11".repeat(32));
export const CLIENT_PK = getPublicKey(CLIENT_SK);
export const OTHER_SK = bytes("33".repeat(32));

export const nwcUri = (relays = ["wss://relay.test/v1"], pubkey = WALLET_PK, secret = hex(CLIENT_SK)) =>
  `nostr+walletconnect://${pubkey}?${relays.map((r) => `relay=${encodeURIComponent(r)}`).join("&")}&secret=${secret}`;

export type Reply = { result_type?: string; result?: unknown; error?: { code: string; message: string } | null };
export type Handler = (method: string, params: Record<string, unknown>) => Reply | null;

export interface RelayOptions {
  /** Answers each request; null = never answer. */
  handler?: Handler;
  /** The info event's `encryption` tag (undefined: no tag; null: no info event at all). */
  infoEncryption?: string | null;
  infoMethods?: string;
  /** Tamper with the wallet's response before it is delivered. */
  tamper?: (ev: Record<string, unknown>) => Record<string, unknown>;
  /** Fail this relay: "refuse" fires error+close right away; "reject" answers the publish with OK false. */
  fail?: "refuse" | "reject";
}

type Listener = (ev: { data?: unknown }) => void;

export class FakeSocket implements NwcSocket {
  closed = false;
  sent: unknown[][] = [];
  private listeners = new Map<string, Listener[]>();
  private subs = new Map<string, Record<string, unknown>>();

  constructor(
    readonly url: string,
    private readonly o: RelayOptions,
  ) {
    queueMicrotask(() => {
      if (o.fail === "refuse") {
        this.emit("error", {});
        this.emit("close", {});
      } else this.emit("open", {});
    });
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close(): void {
    this.closed = true;
  }
  private emit(type: string, ev: { data?: unknown }) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  private deliver(msg: unknown[]) {
    if (!this.closed) queueMicrotask(() => this.emit("message", { data: JSON.stringify(msg) }));
  }

  send(data: string): void {
    if (this.closed) throw new Error("send on a closed socket");
    const msg = JSON.parse(data) as unknown[];
    this.sent.push(msg);
    if (msg[0] === "REQ") {
      const [, id, filter] = msg as [string, string, Record<string, unknown>];
      this.subs.set(id, filter);
      if ((filter.kinds as number[]).includes(13194)) {
        if (this.o.infoEncryption !== null) this.deliver(["EVENT", id, this.info()]);
        this.deliver(["EOSE", id]);
      }
    } else if (msg[0] === "EVENT") this.onRequest(msg[1] as Parameters<typeof verifyEvent>[0]);
  }

  private info() {
    const tags = typeof this.o.infoEncryption === "string" ? [["encryption", this.o.infoEncryption]] : [];
    return finalizeEvent({ kind: 13194, created_at: 1, tags, content: this.o.infoMethods ?? "get_info make_invoice lookup_invoice" }, WALLET_SK);
  }

  private onRequest(req: Parameters<typeof verifyEvent>[0]) {
    if (this.o.fail === "reject") return this.deliver(["OK", req.id, false, "blocked: test"]);
    this.deliver(["OK", req.id, true, ""]);
    if (!verifyEvent({ ...req }) || req.kind !== 23194) return;
    const nip44Used = req.tags.some((t) => t[0] === "encryption" && t[1] === "nip44_v2");
    const ck = nip44.getConversationKey(WALLET_SK, req.pubkey);
    const { method, params } = JSON.parse(nip44Used ? nip44.decrypt(req.content, ck) : nip04.decrypt(WALLET_SK, req.pubkey, req.content));
    const reply = (this.o.handler ?? defaultWallet())(method, params);
    if (reply === null) return;
    const body = JSON.stringify({ result_type: method, ...reply });
    const content = nip44Used ? nip44.encrypt(body, ck) : nip04.encrypt(WALLET_SK, req.pubkey, body);
    let ev: Record<string, unknown> = { ...finalizeEvent({ kind: 23195, created_at: req.created_at, tags: [["p", req.pubkey], ["e", req.id]], content }, WALLET_SK) };
    if (this.o.tamper) ev = this.o.tamper(ev);
    for (const [id, f] of this.subs) {
      if (!(f.kinds as number[]).includes(23195)) continue;
      // A real relay applies the filter; the tamper tests bypass it to show the client checks for itself.
      this.deliver(["EVENT", id, ev]);
    }
  }
}

/** A minimal wallet: make_invoice returns a stored invoice, lookup_invoice reports it from `invoices`. */
export function defaultWallet(state: WalletState = new WalletState()): Handler {
  return (method, params) => {
    if (method === "get_info") return { result: { alias: "fake", methods: state.methods, ...(state.pubkey ? { pubkey: state.pubkey } : {}) } };
    if (method === "make_invoice") return { result: state.make(params) };
    if (method === "lookup_invoice") return { result: state.lookup(params) };
    return { error: { code: "NOT_IMPLEMENTED", message: "no" }, result: null };
  };
}

export class WalletState {
  methods = ["get_info", "make_invoice", "lookup_invoice"];
  /** The node id get_info reports, if any. */
  pubkey: string | undefined = undefined;
  invoices = new Map<string, { invoice: string; payment_hash: string; amount: number; created_at: number; expires_at: number; settled_at?: number; description: string }>();
  nextInvoice: { bolt11: string; hash: string } | null = null;
  requests: { method: string; params: Record<string, unknown> }[] = [];

  make(params: Record<string, unknown>) {
    this.requests.push({ method: "make_invoice", params });
    const amount = params.amount as number;
    const now = Math.floor(Date.now() / 1000);
    const expiry = (params.expiry as number | undefined) ?? 3600;
    const { bolt11, hash } = this.nextInvoice ?? fakeBolt11(BigInt(amount), now, expiry);
    const inv = { type: "incoming", invoice: bolt11, payment_hash: hash, amount, created_at: now, expires_at: now + expiry, description: params.description as string };
    this.invoices.set(hash, inv);
    return inv;
  }
  lookup(params: Record<string, unknown>) {
    this.requests.push({ method: "lookup_invoice", params });
    const inv = this.invoices.get(params.payment_hash as string);
    if (!inv) return null;
    return { type: "incoming", ...inv };
  }
  settle(hash: string) {
    this.invoices.get(hash)!.settled_at = Math.floor(Date.now() / 1000);
  }
}

// ---- BOLT11 (only the parts the gateway reads: HRP amount, timestamp, `p` payment hash, `x` expiry) --------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= G[i]!;
  }
  return chk;
}
const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function toWords(b: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const x of b) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}
const intWords = (n: number, len: number) => Array.from({ length: len }, (_, i) => Math.floor(n / 32 ** (len - 1 - i)) % 32);

/** An HRP amount for msat: the shortest exact multiplier (p-units must be multiples of 10). */
function hrpAmount(msat: bigint): string {
  if (msat % 100_000_000n === 0n) return `${msat / 100_000_000n}m`;
  if (msat % 100_000n === 0n) return `${msat / 100_000n}u`;
  if (msat % 100n === 0n) return `${msat / 100n}n`;
  return `${msat * 10n}p`;
}

/** A structurally valid mainnet BOLT11 (checksum ok; the node's 65-byte proof is random filler, which the gateway never checks). */
export function fakeBolt11(msat: bigint, timestamp: number, expiry: number, hash = hex(crypto.getRandomValues(new Uint8Array(32))), hrp = `lnbc${hrpAmount(msat)}`) {
  const field = (type: number, words: number[]) => [type, Math.floor(words.length / 32), words.length % 32, ...words];
  const data = [...intWords(timestamp, 7), ...field(1, toWords(bytes(hash))), ...field(6, intWords(expiry, 4)), ...toWords(crypto.getRandomValues(new Uint8Array(65)))];
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const chk = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return { bolt11: hrp + "1" + [...data, ...chk].map((w) => CHARSET[w]).join(""), hash };
}

/** Sockets created by a factory, for "closed in every path" checks. `perUrl` overrides `o` for one relay. */
export function relayFactory(o: RelayOptions = {}, perUrl: Record<string, RelayOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const factory = (url: string) => {
    const s = new FakeSocket(url, perUrl[url] ?? o);
    sockets.push(s);
    return s;
  };
  return { factory, sockets };
}
