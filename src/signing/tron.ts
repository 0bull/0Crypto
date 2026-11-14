import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { tronAddressFromPubkey, tronHexToBase58 } from "../chains/tron/address";
import { decodeTronRawData, TOPUP_SUN, trc20TransferData } from "../chains/tron/txcheck";
import { getAsset } from "../core/assets";
import { DestinationNotAllowed, requirePays, type Allowed } from "../routing/guard";
import type { KeySpec } from "./addresses";
import { tronDepositKey, tronHotKey, tronSignDigest } from "./keys";

/*
 * The only Tron signer. The destination comes from `raw_data_hex` itself (the strict decoder of chains/tron/txcheck):
 * a TransferContract pays its to_address TRX (hot, a deposit top-up, swap or refund); a TriggerSmartContract must be
 * USDT transfer(to, amount) with no TRX attached and pays the recipient USDT (hot, swap or refund). Anything else is
 * refused. An `energy` proof covers only the sweep top-up: a TransferContract of exactly TOPUP_SUN from the hot
 * wallet. Swap and refund proofs cover only their exact asset and amount (requirePays). The key is derived here from
 * the KeySpec and must own the tx. The txID signed is our own sha256 of the bytes. Callers still run assertTronTx
 * (amount, fee limit, expiry) first.
 */

/**
 * Signs `rawHex` with our key `spec` once its destination is covered by `proofs`; throws DestinationNotAllowed (or the
 * decoder's TxMismatch), signing nothing, otherwise. Returns the txID and r || s || v (v = recovery + 27, as
 * TronWeb's ECKeySign: tronweb 6.5.1 lib/esm/utils/crypto.js:168-173), deterministic RFC 6979, low-S.
 */
export function signTronTx(seed: string, spec: KeySpec, rawHex: string, proofs: readonly Allowed[]): { txID: string; signature: string } {
  const d = decodeTronRawData(rawHex);
  const hot = tronHotKey(seed);
  const key = spec.role === "hot" ? hot : tronDepositKey(seed, spec.index);
  if (tronAddressFromPubkey(secp256k1.getPublicKey(key.priv, false)) !== key.address) throw new Error("tron signer: the key does not match its address");
  if (d.owner !== key.address) throw new Error("tron signer: the key is not the tx owner");
  if (d.type === "TransferContract") {
    const topup = d.owner === hot.address && d.amount === TOPUP_SUN;
    requirePays(proofs, "tron", [{ address: d.to!, kinds: ["hot", "energy", "swap", "refund"], what: "TRX recipient", asset: "tron:trx", amount: d.amount!, topup }]);
  } else {
    if (d.contract !== getAsset("tron:usdt").contract) throw new DestinationNotAllowed("tron", `contract ${d.contract} is not USDT`);
    if (d.callValue !== 0n) throw new DestinationNotAllowed("tron", "TRX attached to a contract call");
    const data = d.data ?? "";
    if (data.length !== 136 || !data.startsWith("a9059cbb") || !/^0{24}$/.test(data.slice(8, 32))) throw new DestinationNotAllowed("tron", "calldata is not transfer(address, uint256)");
    const to = tronHexToBase58(`41${data.slice(32, 72)}`);
    const amount = BigInt(`0x${data.slice(72)}`);
    if (trc20TransferData(to, amount) !== data) throw new DestinationNotAllowed("tron", "calldata does not decode exactly");
    requirePays(proofs, "tron", [{ address: to, kinds: ["hot", "swap", "refund"], what: "USDT recipient", asset: "tron:usdt", amount }]);
  }
  const txID = bytesToHex(sha256(hexToBytes(rawHex)));
  return { txID, signature: tronSignDigest(txID, key.priv) };
}
