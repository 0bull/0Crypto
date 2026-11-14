// Optional allowlist for an invoice's success_url (the SUCCESS_URL_HOSTS setting). Empty: any https URL (and http on
// localhost), as before. Set: the URL's hostname must be listed. The match is exact (no implicit subdomains), case-insensitive,
// and ignores the port. When the list is set, localhost must be listed too.

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const isHostname = (h: string) => h.length <= 253 && h.split(".").every((p) => LABEL.test(p));

/** Comma-separated hostnames, trimmed and lowercased. Throws on an entry with a scheme, path, port or wildcard. */
export function parseSuccessHosts(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    if (!isHostname(entry.toLowerCase())) throw new Error(`SUCCESS_URL_HOSTS: ${entry} is not a hostname`);
    out.push(entry.toLowerCase());
  }
  return out;
}

export function validSuccessUrl(s: string, hosts: string[]): boolean {
  if (s.length > 2048 || s.includes("\\")) return false;
  try {
    const u = new URL(s);
    if (u.username !== "" || u.password !== "") return false;
    if (!(u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "localhost"))) return false;
    return hosts.length === 0 || hosts.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
