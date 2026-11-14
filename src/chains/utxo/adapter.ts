import type { HDKey } from "@scure/bip32";
import { formatDecimal } from "../../core/money";
import type { AssetInfo, ChainAdapter, DepositTarget, Observation } from "../../core/types";
import { deriveUtxoAddress } from "./derive";
import type { UtxoExplorer } from "./explorer";
import type { UtxoChain } from "./networks";

const URI_SCHEME: Record<UtxoChain, string> = { btc: "bitcoin", ltc: "litecoin", doge: "dogecoin" };
/** Txs confirmed more than this long before the target was created are ignored (index reuse guard). */
const LOOKBACK_MS = 2 * 60 * 60 * 1000;

export function utxoAdapter(chain: UtxoChain, explorer: UtxoExplorer, account: HDKey): ChainAdapter {
  return {
    chain,
    async deriveAddress(index) {
      return deriveUtxoAddress(account, chain, index);
    },
    async observe(t: DepositTarget, asset: AssetInfo): Promise<Observation> {
      const txs = await explorer.addressTxs(t.address);
      // The tip only matters for confirmed txs: an empty or mempool-only address costs one explorer request.
      const tip = txs.some((tx) => tx.height !== null) ? await explorer.tipHeight() : 0;
      const cutoff = t.createdAt - LOOKBACK_MS;
      let received = 0n;
      let final = 0n;
      const txids: string[] = [];
      for (const tx of txs) {
        if (tx.height !== null && tx.time !== null && tx.time * 1000 < cutoff) {
          console.warn(`utxo: ignoring tx older than target window: ${tx.txid}`);
          continue;
        }
        received += tx.valueToAddr;
        txids.push(tx.txid);
        if (tx.height !== null && tip - tx.height + 1 >= asset.confirmations) final += tx.valueToAddr;
      }
      return { received, final, txids };
    },
    paymentUri(t, asset, amount) {
      return `${URI_SCHEME[chain]}:${t.address}?amount=${formatDecimal(amount, asset.decimals)}`;
    },
  };
}
