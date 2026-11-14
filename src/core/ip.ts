/*
 * Rate-limit keys from the client address (Cloudflare's `cf-connecting-ip`). The address is only ever a key: it is not
 * stored or logged. IPv4 is used as is. IPv6 is keyed on its /64, because one customer line or VPS usually holds a whole
 * /64 and could otherwise rotate through 2^64 addresses to get a fresh budget each request. An IPv4-mapped IPv6 address
 * (::ffff:a.b.c.d) is its IPv4 address. A missing or malformed value gives the one shared key "unknown".
 */

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

/** The eight hextets of an IPv6 address (numbers), or null. Accepts one `::` and a trailing dotted IPv4 part. */
function hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.slice(lastColon + 1).includes(".")) {
    // A trailing dotted IPv4 part (::ffff:1.2.3.4) is rewritten as its two hextets.
    const v4 = s.slice(lastColon + 1);
    if (!V4.test(v4)) return null;
    const o = v4.split(".").map(Number);
    s = s.slice(0, lastColon + 1) + (((o[0]! << 8) | o[1]!).toString(16)) + ":" + (((o[2]! << 8) | o[3]!).toString(16));
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const h of part.split(":")) {
      if (!HEXTET.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  if (!head) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const rest = parse(halves[1]!);
  if (!rest) return null;
  const known = head.length + rest.length;
  if (known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest];
}

/** The rate-limit key for a client address: IPv4 as is, IPv6 as its /64 prefix, otherwise "unknown". */
export function rateKeyIp(raw: string | undefined | null): string {
  const ip = (raw ?? "").trim().replace(/::\/64$/, "::"); // idempotent: a key passed back in is the same key
  if (V4.test(ip)) return ip;
  if (!ip.includes(":")) return "unknown";
  const h = hextets(ip);
  if (!h) return "unknown";
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
  return `${h.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** The rate-limit key of this request's client (see rateKeyIp). */
export const clientIpKey = (c: { req: { header(name: string): string | undefined } }): string => rateKeyIp(c.req.header("cf-connecting-ip"));
