import type { ChainId } from "../../core/types";

export type UtxoChain = Extract<ChainId, "btc" | "ltc" | "doge">;

export interface UtxoNetwork {
  bech32?: string;
  pubKeyHash: number;
  scriptHash: number;
  wif: number;
  /** Standard BIP32 version bytes for this network's account keys. */
  bip32: { public: number; private: number };
  /** Account-level hardened derivation path. */
  path: string;
  type: "p2wpkh" | "p2pkh";
}

export const UTXO_NETWORKS: Record<UtxoChain, UtxoNetwork> = {
  btc: {
    bech32: "bc",
    pubKeyHash: 0x00,
    scriptHash: 0x05,
    wif: 0x80,
    bip32: { public: 0x0488b21e, private: 0x0488ade4 }, // xpub / xprv
    path: "m/84'/0'/0'",
    type: "p2wpkh",
  },
  ltc: {
    bech32: "ltc",
    pubKeyHash: 48,
    scriptHash: 50,
    wif: 0xb0,
    bip32: { public: 0x019da462, private: 0x019d9cfe }, // Ltub / Ltpv
    path: "m/84'/2'/0'",
    type: "p2wpkh",
  },
  doge: {
    pubKeyHash: 30,
    scriptHash: 22,
    wif: 158,
    bip32: { public: 0x02facafd, private: 0x02fac398 }, // dgub / dgpv
    path: "m/44'/3'/0'",
    type: "p2pkh",
  },
};

const XPUB = 0x0488b21e;
const ZPUB = 0x04b24746;

/** Public extended-key versions accepted per chain (re-versioned to the network's own on import). */
export const ACCEPTED_PUBLIC_VERSIONS: Record<UtxoChain, readonly number[]> = {
  btc: [XPUB, ZPUB],
  // Mtub (BIP49 P2SH-P2WPKH) deliberately excluded: we derive native segwit.
  ltc: [0x019da462 /* Ltub */, ZPUB, XPUB],
  doge: [0x02facafd /* dgub */, XPUB],
};

/** Private extended-key versions we recognise only to refuse them. */
export const PRIVATE_VERSIONS: readonly number[] = [
  0x0488ade4, // xprv
  0x049d7878, // yprv
  0x04b2430c, // zprv
  0x04358394, // tprv
  0x019d9cfe, // Ltpv
  0x01b26792, // Mtpv
  0x02fac398, // dgpv
];
