import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** The one normalisation every consumer of MASTER_SEED uses (Worker and scripts): NFKD, trimmed, single spaces, lowercase. */
export const normalizeMnemonic = (s: string): string => s.normalize("NFKD").trim().replace(/\s+/g, " ").toLowerCase();

const verdicts = new Map<string, boolean>();

/** Whether the (normalised) phrase is a valid English BIP39 mnemonic. Memoised per isolate. */
export function isValidMnemonic(s: string): boolean {
  let ok = verdicts.get(s);
  if (ok === undefined) {
    ok = validateMnemonic(normalizeMnemonic(s), wordlist);
    verdicts.set(s, ok);
  }
  return ok;
}

/** Returns the normalised mnemonic, or throws without echoing any of the input. */
export function assertValidMnemonic(s: string): string {
  if (!isValidMnemonic(s)) throw new Error("MASTER_SEED is not a valid BIP39 mnemonic");
  return normalizeMnemonic(s);
}
