// One-off dev script (NOT shipped in the worker). Derives BTC/LTC/DOGE index 0/1
// addresses for the BIP39 "abandon ... about" seed with an independent
// implementation (bitcoinjs-lib + bip32 + tiny-secp256k1), using explicit network
// params. The BTC BIP84 outputs must match the official test vectors; if they do,
// the LTC/DOGE outputs are trustworthy and get pinned in test/chains/utxo/derive.test.ts.
import * as bitcoin from "bitcoinjs-lib";
import { BIP32Factory } from "bip32";
import * as ecc from "tiny-secp256k1";
import { mnemonicToSeedSync } from "bip39";

const bip32 = BIP32Factory(ecc);
const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const seed = mnemonicToSeedSync(mnemonic);

const nets = {
  btc: { messagePrefix: "\x18Bitcoin Signed Message:\n", bech32: "bc", bip32: { public: 0x0488b21e, private: 0x0488ade4 }, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80, path: "m/84'/0'/0'", type: "p2wpkh" },
  ltc: { messagePrefix: "\x19Litecoin Signed Message:\n", bech32: "ltc", bip32: { public: 0x0488b21e, private: 0x0488ade4 }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0, path: "m/84'/2'/0'", type: "p2wpkh" },
  doge: { messagePrefix: "\x19Dogecoin Signed Message:\n", bip32: { public: 0x02facafd, private: 0x02fac398 }, pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e, path: "m/44'/3'/0'", type: "p2pkh" },
};

const out = {};
for (const [chain, net] of Object.entries(nets)) {
  const root = bip32.fromSeed(seed, net);
  const account = root.derivePath(net.path);
  out[chain] = { accountXpubStd: account.neutered().toBase58(), addrs: [] };
  for (const i of [0, 1]) {
    const pubkey = Buffer.from(account.derive(0).derive(i).publicKey);
    const pay = bitcoin.payments[net.type]({ pubkey, network: net });
    out[chain].addrs.push(pay.address);
  }
}
console.log(JSON.stringify(out, null, 2));
const ok = out.btc.addrs[0] === "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu" && out.btc.addrs[1] === "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
console.log(ok ? "BTC BIP84 anchor: MATCH" : "BTC BIP84 anchor: MISMATCH");
process.exit(ok ? 0 : 1);
