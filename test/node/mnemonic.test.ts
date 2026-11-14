import { describe, expect, it } from "vitest";
import { assertValidMnemonic, isValidMnemonic, normalizeMnemonic } from "../../src/core/mnemonic";
import { hotAccount } from "../../src/signing/evmkeys";
import { accountFromSeed } from "../../src/chains/utxo/derive";
import { chainConfigError } from "../../src/chains/registry";

const GOOD = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BAD_CHECKSUM = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
const NON_WORD = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandonx";

describe("mnemonic validation", () => {
  it("normalises case, whitespace and a trailing newline to the same wallet", () => {
    const variants = [GOOD.toUpperCase(), `  ${GOOD.replace(/ /g, "   ")}\t`, `${GOOD}\n`, GOOD.replace(/ /g, "\n")];
    for (const v of variants) {
      expect(normalizeMnemonic(v)).toBe(GOOD);
      expect(hotAccount({ MASTER_SEED: v }).address).toBe(hotAccount({ MASTER_SEED: GOOD }).address);
      expect(accountFromSeed(v, "btc").publicExtendedKey).toBe(accountFromSeed(GOOD, "btc").publicExtendedKey);
    }
  });
  it("rejects a bad checksum and a non-word, never deriving a wallet", () => {
    for (const bad of [BAD_CHECKSUM, NON_WORD, "", "abandon"]) {
      expect(isValidMnemonic(bad)).toBe(false);
      expect(() => assertValidMnemonic(bad)).toThrow("MASTER_SEED is not a valid BIP39 mnemonic");
      expect(() => hotAccount({ MASTER_SEED: bad })).toThrow("not a valid BIP39");
      expect(() => accountFromSeed(bad, "btc")).toThrow("not a valid BIP39");
    }
  });
  it("an invalid seed is a chain config error (EVM and routed UTXO), a valid one is not", () => {
    const env = (seed: string) => ({ MASTER_SEED: seed, ALLOW_SEED_CUSTODY: "true", EVM_RPC_BASE: "https://x" }) as never;
    expect(chainConfigError(env(BAD_CHECKSUM), "base")).toBe("MASTER_SEED is not a valid BIP39 mnemonic");
    expect(chainConfigError(env(BAD_CHECKSUM), "btc")).toBe("MASTER_SEED is not a valid BIP39 mnemonic");
    expect(chainConfigError(env(GOOD), "base")).toBeNull();
    expect(chainConfigError(env(GOOD.toUpperCase() + "\n"), "btc")).toBeNull();
  });
});
