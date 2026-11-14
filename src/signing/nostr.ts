/**
 * The Nostr Wallet Connect (NIP-47) client key. It signs Nostr events, never money: the gateway only asks the
 * merchant's wallet to create and look up invoices (src/chains/lightning/nwc.ts). It lives here because event signing
 * is a signing primitive (the perimeter test keeps nostr-tools inside src/signing), and so the NWC secret never leaves
 * this module: parseNwcUri hands out a connection handle whose secret is held in a module-private WeakMap.
 *
 * nostr-tools is loaded with import() inside each function, so it is not parsed on Worker startup.
 */

export type NwcEncryption = "nip44_v2" | "nip04";

/** The only NIP-47 methods the gateway may ever request: it receives, it never pays. */
export type NwcMethod = "get_info" | "make_invoice" | "lookup_invoice";
const RECEIVE_METHODS: ReadonlySet<string> = new Set<NwcMethod>(["get_info", "make_invoice", "lookup_invoice"]);

/** A parsed NWC_URI without its secret. Only the functions below can use the secret behind it. */
export interface NwcConn {
  readonly walletPubkey: string;
  readonly relays: readonly string[];
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

const secrets = new WeakMap<NwcConn, Uint8Array>();
const pubkeys = new WeakMap<NwcConn, string>();
const HEX64 = /^[0-9a-f]{64}$/;
// secp256k1 group order: a secret key is 0 < k < N.
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** Larger encrypted contents are refused before decryption (a wallet response is a few hundred bytes). */
const MAX_CONTENT = 65_536;

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));

/**
 * Parses `nostr+walletconnect://<wallet pubkey>?relay=wss://...&secret=<hex>`: one or more wss relays (no
 * credentials), a 64-hex secret that is a valid secp256k1 key, and a 64-hex wallet pubkey. Throws an Error whose
 * message never quotes the URI.
 */
export function parseNwcUri(uri: string): NwcConn {
  const m = /^nostr\+walletconnect:(?:\/\/)?([0-9a-fA-F]{64})\?(.*)$/.exec(uri.trim());
  if (!m) throw new Error("NWC_URI must be nostr+walletconnect://<64-hex wallet pubkey>?relay=wss://...&secret=<64-hex>");
  const q = new URLSearchParams(m[2]!);
  const relays = q.getAll("relay").map((r) => r.trim());
  if (relays.length === 0) throw new Error("NWC_URI has no relay");
  for (const r of relays) {
    if (!URL.canParse(r)) throw new Error("NWC_URI relays must be wss URLs");
    const u = new URL(r);
    if (u.protocol !== "wss:") throw new Error("NWC_URI relays must be wss URLs");
    if (u.username !== "" || u.password !== "") throw new Error("NWC_URI relays must not contain a username or password");
  }
  const s = q.getAll("secret");
  if (s.length !== 1 || !HEX64.test(s[0]!.toLowerCase())) throw new Error("NWC_URI must contain one 64-hex secret");
  const k = BigInt("0x" + s[0]!);
  if (k === 0n || k >= N) throw new Error("NWC_URI secret is not a valid key");
  const conn: NwcConn = Object.freeze({ walletPubkey: m[1]!.toLowerCase(), relays: Object.freeze([...relays]) });
  secrets.set(conn, hexBytes(s[0]!.toLowerCase()));
  return conn;
}

function secretOf(conn: NwcConn): Uint8Array {
  const s = secrets.get(conn);
  if (!s) throw new Error("not a parsed NWC connection");
  return s;
}

/** The client's public key (hex), which the wallet addresses its responses to. */
export async function nwcClientPubkey(conn: NwcConn): Promise<string> {
  let p = pubkeys.get(conn);
  if (!p) {
    const { getPublicKey } = await import("nostr-tools/pure");
    p = getPublicKey(secretOf(conn));
    pubkeys.set(conn, p);
  }
  return p;
}

/** A kind 23194 request event for a receive method (anything else throws): `{ method, params }` encrypted to the wallet, tagged `p` (and `encryption` for NIP-44). */
export async function nwcRequestEvent(conn: NwcConn, method: NwcMethod, params: Record<string, unknown>, enc: NwcEncryption): Promise<NostrEvent> {
  // Checked at runtime too: a cast or a computed string can defeat the type, never this.
  if (!RECEIVE_METHODS.has(method)) throw new Error("NWC method not allowed: only get_info, make_invoice and lookup_invoice are ever sent");
  const sk = secretOf(conn);
  const plain = JSON.stringify({ method, params });
  let content: string;
  if (enc === "nip44_v2") {
    const nip44 = await import("nostr-tools/nip44");
    content = nip44.encrypt(plain, nip44.getConversationKey(sk, conn.walletPubkey));
  } else {
    const nip04 = await import("nostr-tools/nip04");
    content = nip04.encrypt(sk, conn.walletPubkey, plain);
  }
  const tags = [["p", conn.walletPubkey], ...(enc === "nip44_v2" ? [["encryption", "nip44_v2"]] : [])];
  const pure = await import("nostr-tools/pure");
  const ev = pure.finalizeEvent({ kind: 23194, created_at: Math.floor(Date.now() / 1000), tags, content }, sk);
  return { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig };
}

/** Decrypts a wallet event's content with the given scheme. Throws when it cannot (never returns a guess). */
export async function nwcOpenResponse(conn: NwcConn, ev: NostrEvent, enc: NwcEncryption): Promise<string> {
  if (ev.pubkey !== conn.walletPubkey) throw new Error("event is not from the wallet");
  if (typeof ev.content !== "string" || ev.content.length > MAX_CONTENT) throw new Error("event content too large");
  const sk = secretOf(conn);
  if (enc === "nip44_v2") {
    const nip44 = await import("nostr-tools/nip44");
    return nip44.decrypt(ev.content, nip44.getConversationKey(sk, conn.walletPubkey));
  }
  const nip04 = await import("nostr-tools/nip04");
  return nip04.decrypt(sk, conn.walletPubkey, ev.content);
}

/**
 * Whether `v` is a well-formed Nostr event whose id is its hash and whose Schnorr proof is valid for its pubkey. Checks a
 * fresh copy with only the event fields (nostr-tools caches the verdict on the object it is given).
 */
export async function nostrEventValid(v: unknown): Promise<boolean> {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== "string" || typeof e.pubkey !== "string" || typeof e.sig !== "string" || typeof e.content !== "string") return false;
  if (typeof e.kind !== "number" || typeof e.created_at !== "number") return false;
  if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return false;
  const { verifyEvent } = await import("nostr-tools/pure");
  try {
    return verifyEvent({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags as string[][], content: e.content, sig: e.sig });
  } catch {
    return false;
  }
}
