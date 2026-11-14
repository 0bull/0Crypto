import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { assertValidMnemonic } from "../core/mnemonic";

// Internal to src/signing (see ./keys). Loaded with dynamic import() only: viem/accounts must stay off worker startup.

// Deriving runs PBKDF2 (2048 rounds): done once per normalised seed per isolate.
const cache = new Map<string, HDAccount>();

/** The hot-wallet EOA: m/44'/60'/0'/0/0 of MASTER_SEED. It funds and sweeps deposit forwarders. */
export function hotAccount(env: { MASTER_SEED?: string }): HDAccount {
  const seed = assertValidMnemonic(env.MASTER_SEED ?? "");
  let account = cache.get(seed);
  if (!account) {
    account = mnemonicToAccount(seed, { path: "m/44'/60'/0'/0/0" });
    cache.set(seed, account);
  }
  return account;
}
