import { bech32 } from "@scure/base";
import {
  nostrEventValid,
  nwcClientPubkey,
  nwcOpenResponse,
  nwcRequestEvent,
  parseNwcUri,
  type NostrEvent,
  type NwcConn,
  type NwcEncryption,
  type NwcMethod,
} from "../../signing/nostr";

/*
 * NIP-47 Nostr Wallet Connect client, receive-only. The gateway sends exactly three methods (NwcMethod) to the
 * merchant's hosted wallet: get_info, make_invoice and lookup_invoice. No spending method exists in this codebase
 * (test/node/lightning-receive-only.test.ts). Each call opens one relay WebSocket and closes it in `finally`: outbound
 * sockets do not hibernate and are billed while open.
 *
 * Trust: a relay is untrusted. A response counts only if it is a kind 23195 event authored by the wallet pubkey from
 * NWC_URI, with a valid Schnorr proof, tagged `e` = our request id and `p` = our client pubkey; anything else is
 * dropped. A genuine wallet response that cannot be decrypted, names another result_type or has an unknown shape is an
 * NwcError (fail closed). Event signing and the NWC secret live in src/signing/nostr.ts.
 */

export type { NwcConn, NwcEncryption, NwcMethod };

const TIMEOUT_MS = 10_000;
const ENC_TTL_SEC = 86_400;
/** The NIP-04 fallback (no info event found) is re-checked sooner: a wallet may publish its info event later. */
const ENC_FALLBACK_TTL_SEC = 3_600;
const MAX_FRAME = 262_144;
const HEX64 = /^[0-9a-f]{64}$/;

/** The wallet answered with an error, or with something the gateway cannot trust; or no relay could be reached. */
export class NwcError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? `NWC error ${code}`);
    this.name = "NwcError";
    this.code = code;
  }
}

/** No genuine response arrived in time. */
export class NwcTimeout extends Error {
  constructor(message = "NWC request timed out") {
    super(message);
    this.name = "NwcTimeout";
  }
}

/** A relay connection failed (connect, socket error or close, publish or subscription refused): try the next relay. */
class RelayFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayFailure";
  }
}

/** The part of a WebSocket the client uses; tests pass a fake relay through `socketFactory`. */
export interface NwcSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", fn: (ev: { data?: unknown }) => void): void;
}
export type SocketFactory = (url: string) => NwcSocket;

export interface NwcOptions {
  timeoutMs?: number;
  socketFactory?: SocketFactory;
  /** Skip the info-event lookup and use this scheme. */
  encryption?: NwcEncryption;
  /** Overall deadline (epoch ms) across relays and calls: no relay is tried, and no round waits, past it. */
  deadlineAt?: number;
}

/** This round's wait: the per-relay timeout, cut to the overall deadline. */
const roundTimeout = (opts: NwcOptions): number => Math.min(opts.timeoutMs ?? TIMEOUT_MS, opts.deadlineAt === undefined ? Infinity : opts.deadlineAt - Date.now());

/** The real outbound WebSocket. There is no module-level override: callers inject `socketFactory` (tests pass a fake relay). */
const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as NwcSocket;

/** Why NWC_URI cannot be used, or null. The message never quotes the URI (it holds the client secret). */
export function nwcUriProblem(uri: string | undefined): string | null {
  if (!uri) return "set NWC_URI (a nostr+walletconnect:// URI from your Lightning wallet; create it with receive-only permissions)";
  try {
    parseNwcUri(uri);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "NWC_URI is invalid";
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const randomId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

function parseFrame(data: unknown): unknown[] | null {
  if (typeof data !== "string" || data.length > MAX_FRAME) return null;
  try {
    const m = JSON.parse(data) as unknown;
    return Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

interface Session<T> {
  /** Sent in order once the socket is open. */
  frames: unknown[][];
  subId: string;
  /** The published event's id, whose OK false means the relay refused it. */
  eventId?: string;
  /** A boxed value settles the session; null drops the event and keeps waiting. Throwing ends the call. */
  onEvent(ev: unknown): Promise<{ value: T } | null>;
  onEose?(): { value: T } | null;
}

/** One relay: open, send the frames, wait for the session to settle, the timeout or a failure. Always closes the socket. */
async function session<T>(url: string, factory: SocketFactory, timeoutMs: number, s: Session<T>): Promise<T> {
  let socket: NwcSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      let done = false;
      const end = (f: () => void) => {
        if (!done) {
          done = true;
          f();
        }
      };
      const fail = (why: string) => end(() => reject(new RelayFailure(why)));
      timer = setTimeout(() => end(() => reject(new NwcTimeout())), timeoutMs);
      try {
        socket = factory(url);
      } catch {
        return fail("connect failed");
      }
      const ws = socket;
      let queue = Promise.resolve();
      ws.addEventListener("open", () => {
        try {
          for (const f of s.frames) ws.send(JSON.stringify(f));
        } catch {
          fail("send failed");
        }
      });
      ws.addEventListener("error", () => fail("socket error"));
      ws.addEventListener("close", () => fail("socket closed"));
      ws.addEventListener("message", (m) => {
        // Messages are handled one at a time (verification and decryption are async).
        queue = queue
          .then(async () => {
            if (done) return;
            const msg = parseFrame(m.data);
            if (!msg) return;
            if (msg[0] === "EVENT" && msg[1] === s.subId) {
              const r = await s.onEvent(msg[2]);
              if (r) end(() => resolve(r.value));
            } else if (msg[0] === "EOSE" && msg[1] === s.subId && s.onEose) {
              const r = s.onEose();
              if (r) end(() => resolve(r.value));
            } else if (msg[0] === "OK" && s.eventId !== undefined && msg[1] === s.eventId && msg[2] === false) fail("publish refused");
            else if (msg[0] === "CLOSED" && msg[1] === s.subId) fail("subscription closed");
          })
          .catch((e: unknown) => end(() => reject(e)));
      });
    });
  } finally {
    clearTimeout(timer);
    try {
      socket?.close(1000, "done");
    } catch {
      // already closed
    }
  }
}

/**
 * Tries each relay of the URI in order. A relay failure or a timeout moves on to the next relay; a wallet answer
 * (result or NwcError) is final. No relay is tried past `opts.deadlineAt`. With no answer: NwcTimeout if any relay timed
 * out (or the deadline passed), else NwcError RELAY_UNAVAILABLE.
 */
async function overRelays<T>(conn: NwcConn, opts: NwcOptions, run: (url: string) => Promise<T>): Promise<T> {
  let timedOut = false;
  for (const url of conn.relays) {
    if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
      timedOut = true;
      break;
    }
    try {
      return await run(url);
    } catch (e) {
      if (e instanceof RelayFailure) continue;
      if (e instanceof NwcTimeout) {
        timedOut = true;
        continue;
      }
      throw e;
    }
  }
  throw timedOut ? new NwcTimeout("no NWC relay answered in time") : new NwcError("RELAY_UNAVAILABLE", "no NWC relay could be reached");
}

export interface NwcInfo {
  encryption: NwcEncryption;
  methods: string[];
}

/** The wallet's kind 13194 info event (verified, from the wallet pubkey), or null when the relay has none. */
export async function nwcInfo(conn: NwcConn, opts: NwcOptions = {}): Promise<NwcInfo | null> {
  const factory = opts.socketFactory ?? defaultFactory;
  // A relay that answers EOSE without the event may just not carry it: ask the next one. Null only when every relay
  // that answered had none; failures and timeouts as in overRelays.
  let empty = false;
  const found = await overRelays(conn, opts, async (url) => {
    const r = await infoFrom(url, conn, factory, roundTimeout(opts));
    if (r !== null) return r;
    empty = true;
    throw new RelayFailure("no info event");
  }).catch((e: unknown) => {
    if (empty && (e instanceof NwcTimeout || (e instanceof NwcError && e.code === "RELAY_UNAVAILABLE"))) return null;
    throw e;
  });
  return found;
}

/** One relay's info event, or null when it answered EOSE without one. */
function infoFrom(url: string, conn: NwcConn, factory: SocketFactory, timeoutMs: number): Promise<NwcInfo | null> {
  const subId = randomId();
  return session<NwcInfo | null>(url, factory, timeoutMs, {
    frames: [["REQ", subId, { kinds: [13194], authors: [conn.walletPubkey], limit: 1 }]],
    subId,
    async onEvent(raw) {
      if (!isPlainObject(raw) || raw.kind !== 13194 || raw.pubkey !== conn.walletPubkey || !(await nostrEventValid(raw))) return null;
      const ev = raw as unknown as NostrEvent;
      const schemes = ev.tags.find((t) => t[0] === "encryption")?.[1]?.split(/\s+/) ?? [];
      // No encryption tag means a NIP-04-only wallet (NIP-47).
      return { value: { encryption: schemes.includes("nip44_v2") ? "nip44_v2" : "nip04", methods: ev.content.split(/\s+/).filter(Boolean) } };
    },
    onEose: () => ({ value: null }),
  });
}

const encKey = (walletPubkey: string) => `nwc:enc:${walletPubkey}`;

/**
 * The scheme to talk to this wallet with: from its info event (NIP-44 when offered, else NIP-04), cached in KV for 24 h;
 * the NIP-04 fallback used when no relay has an info event is cached for 1 h only.
 */
export async function nwcEncryption(kv: KVNamespace, conn: NwcConn, opts: NwcOptions = {}): Promise<NwcEncryption> {
  const cached = await kv.get(encKey(conn.walletPubkey)).catch(() => null);
  if (cached === "nip44_v2" || cached === "nip04") return cached;
  const info = await nwcInfo(conn, opts);
  const enc = info?.encryption ?? "nip04";
  await kv.put(encKey(conn.walletPubkey), enc, { expirationTtl: info === null ? ENC_FALLBACK_TTL_SEC : ENC_TTL_SEC }).catch(() => {});
  return enc;
}

/** A response event for our request: kind 23195 from the wallet, every `e` tag our request id, every `p` tag our pubkey. */
function addressedToUs(raw: unknown, wallet: string, requestId: string, client: string): boolean {
  if (!isPlainObject(raw) || raw.kind !== 23195 || raw.pubkey !== wallet || !Array.isArray(raw.tags)) return false;
  const tags = raw.tags.filter((t): t is string[] => Array.isArray(t));
  const es = tags.filter((t) => t[0] === "e");
  const ps = tags.filter((t) => t[0] === "p");
  return es.length > 0 && ps.length > 0 && es.every((t) => t[1] === requestId) && ps.every((t) => t[1] === client);
}

/** The `result` of a decrypted response for `method`, or an NwcError. */
function readResponse(body: unknown, method: NwcMethod): Record<string, unknown> {
  if (!isPlainObject(body) || body.result_type !== method) throw new NwcError("INVALID_RESPONSE", "unexpected NWC response");
  if (body.error !== undefined && body.error !== null) {
    if (!isPlainObject(body.error) || typeof body.error.code !== "string") throw new NwcError("INVALID_RESPONSE", "unexpected NWC error shape");
    const code = /^[A-Z_]{1,40}$/.test(body.error.code) ? body.error.code : "OTHER";
    throw new NwcError(code, `wallet refused ${method}: ${code}`);
  }
  if (!isPlainObject(body.result)) throw new NwcError("INVALID_RESPONSE", "unexpected NWC result shape");
  return body.result;
}

/**
 * One NIP-47 request: subscribe to kind 23195 responses for our request id, publish the kind 23194 request, return the
 * decrypted `result` of the first genuine response. The encryption comes from `opts`, else the info event (NIP-04 when
 * there is none).
 */
export async function nwcRequest(conn: NwcConn, method: NwcMethod, params: Record<string, unknown>, opts: NwcOptions = {}): Promise<Record<string, unknown>> {
  const factory = opts.socketFactory ?? defaultFactory;
  const enc = opts.encryption ?? (await nwcInfo(conn, opts))?.encryption ?? "nip04";
  const [client, req] = await Promise.all([nwcClientPubkey(conn), nwcRequestEvent(conn, method, params, enc)]);
  const filter = { kinds: [23195], authors: [conn.walletPubkey], "#e": [req.id], "#p": [client] };
  return overRelays(conn, opts, (url) => {
    const subId = randomId();
    return session(url, factory, roundTimeout(opts), {
      frames: [["REQ", subId, filter], ["EVENT", req]],
      subId,
      eventId: req.id,
      async onEvent(raw) {
        if (!addressedToUs(raw, conn.walletPubkey, req.id, client) || !(await nostrEventValid(raw))) return null;
        let body: unknown;
        try {
          body = JSON.parse(await nwcOpenResponse(conn, raw as unknown as NostrEvent, enc));
        } catch {
          throw new NwcError("INVALID_RESPONSE", "NWC response could not be decrypted");
        }
        return { value: readResponse(body, method) };
      },
    });
  });
}

// ---- BOLT11 -----------------------------------------------------------------------------------------------------------

export interface Bolt11Summary {
  /** null for an amountless invoice. */
  amountMsat: bigint | null;
  paymentHash: string;
  /** Unix seconds. */
  timestamp: number;
  expirySec: number;
}

/** Words of the node's 65-byte recoverable proof at the end of the data part. */
const PROOF_WORDS = 104;
const MULTIPLIER_MSAT: Record<string, [bigint, bigint]> = { m: [100_000_000n, 1n], u: [100_000n, 1n], n: [100n, 1n], p: [1n, 10n] };

const wordsToInt = (w: number[]) => w.reduce((n, x) => n * 32 + x, 0);

/**
 * Reads what the gateway checks from a mainnet BOLT11 invoice: the HRP amount, the timestamp, the `p` payment hash and
 * the `x` expiry (default 3600 s). The node's proof is not verified (the wallet is the merchant's own); the checksum is.
 * Throws on anything else (another network, a malformed amount, no or several payment hashes).
 */
export function bolt11Summary(invoice: string): Bolt11Summary {
  const s = invoice.trim();
  if (s.length > 2048 || (s !== s.toLowerCase() && s !== s.toUpperCase())) throw new Error("not a BOLT11 invoice");
  const { prefix, words } = bech32.decode(s.toLowerCase() as `${string}1${string}`, false);
  const m = /^lnbc(?:([1-9]\d*)([munp])?)?$/.exec(prefix);
  if (!m) throw new Error("not a mainnet BOLT11 invoice");
  let amountMsat: bigint | null = null;
  if (m[1] !== undefined) {
    const n = BigInt(m[1]);
    const [mul, div] = m[2] ? MULTIPLIER_MSAT[m[2]]! : [100_000_000_000n, 1n];
    if ((n * mul) % div !== 0n) throw new Error("BOLT11 amount is not a whole msat");
    amountMsat = (n * mul) / div;
  }
  if (words.length < 7 + PROOF_WORDS) throw new Error("BOLT11 invoice too short");
  const data = words.slice(0, -PROOF_WORDS);
  const timestamp = wordsToInt(data.slice(0, 7));
  let paymentHash: string | null = null;
  let expirySec = 3600;
  let hashes = 0;
  for (let i = 7; i < data.length; ) {
    if (i + 3 > data.length) throw new Error("BOLT11 field truncated");
    const type = data[i]!;
    const len = data[i + 1]! * 32 + data[i + 2]!;
    const field = data.slice(i + 3, i + 3 + len);
    if (field.length !== len) throw new Error("BOLT11 field truncated");
    if (type === 1 && len === 52) {
      paymentHash = [...bech32.fromWords(field)].map((b) => b.toString(16).padStart(2, "0")).join("");
      hashes++;
    } else if (type === 6) expirySec = wordsToInt(field);
    i += 3 + len;
  }
  if (hashes !== 1 || paymentHash === null || !HEX64.test(paymentHash)) throw new Error("BOLT11 invoice must have exactly one payment hash");
  return { amountMsat, paymentHash, timestamp, expirySec };
}
