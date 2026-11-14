import { checkedHex, checkedUtxo, ExplorerHttpError, ExplorerParseError, explorerFetch, jsonArray, uniqueUtxos, normalizeAddr, type AddressTx, type UtxoExplorer } from "./explorer";

export { ExplorerNetworkError, ExplorerParseError, ExplorerUnavailable, withFallback, type UtxoExplorer } from "./explorer";

interface EsploraTx {
  txid: string;
  vout: Array<{ value: number; scriptpubkey_address?: string }>;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
}

const trim = (u: string) => u.replace(/\/+$/, "");

export function esplora(baseUrl: string, apiKey?: string, timeoutMs?: number): UtxoExplorer {
  const base = trim(baseUrl);
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  return {
    async tipHeight() {
      const res = await explorerFetch(`${base}/blocks/tip/height`, { headers }, timeoutMs);
      const n = Number((await res.text()).trim());
      if (!Number.isInteger(n) || n < 0) throw new Error("esplora: bad tip height");
      return n;
    },
    async addressTxs(addr) {
      const res = await explorerFetch(`${base}/address/${encodeURIComponent(addr)}/txs`, { headers }, timeoutMs);
      const txs = (await res.json()) as EsploraTx[];
      const want = normalizeAddr(addr);
      if (txs.filter((t) => t.status.confirmed).length >= 25) {
        console.warn("esplora: >= 25 confirmed txs for an address, pagination may be needed");
      }
      return txs.map((t): AddressTx => {
        const confirmed = t.status.confirmed;
        if (confirmed && (typeof t.status.block_height !== "number" || typeof t.status.block_time !== "number")) {
          throw new ExplorerParseError(`esplora: confirmed tx without block height/time: ${t.txid}`);
        }
        return {
          txid: t.txid,
          height: confirmed ? t.status.block_height! : null,
          time: confirmed ? t.status.block_time! : null,
          valueToAddr: t.vout
            .filter((o) => o.scriptpubkey_address !== undefined && normalizeAddr(o.scriptpubkey_address) === want)
            .reduce((s, o) => s + BigInt(o.value), 0n),
        };
      });
    },
    async utxos(addr) {
      const res = await explorerFetch(`${base}/address/${encodeURIComponent(addr)}/utxo`, { headers }, timeoutMs);
      return uniqueUtxos("esplora", (await jsonArray("esplora", res)).map((u) => {
        // Esplora gives sats as a JSON number: only a non-negative safe integer is exact.
        if (typeof u.value !== "number" || !Number.isSafeInteger(u.value) || u.value < 0) throw new ExplorerParseError("esplora: utxo value is not a whole number of sats");
        const st = u.status as { confirmed?: unknown; block_height?: unknown } | undefined;
        if (typeof st !== "object" || st === null || typeof st.confirmed !== "boolean") throw new ExplorerParseError("esplora: utxo without status.confirmed");
        return checkedUtxo("esplora", { txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: st.confirmed, height: st.block_height });
      }));
    },
    async txHex(txid) {
      const res = await explorerFetch(`${base}/tx/${encodeURIComponent(txid)}/hex`, { headers }, timeoutMs);
      return checkedHex("esplora", await res.text());
    },
    async txStatus(txid) {
      let res: Response;
      try {
        res = await explorerFetch(`${base}/tx/${encodeURIComponent(txid)}/status`, { headers }, timeoutMs);
      } catch (e) {
        // Esplora answers 404 for a txid it has neither in the mempool nor in a block.
        if (e instanceof ExplorerHttpError && e.status === 404) return { known: false, confirmed: false };
        throw e;
      }
      let j: unknown;
      try {
        j = await res.json();
      } catch {
        throw new ExplorerParseError("esplora: tx status is not JSON");
      }
      const c = typeof j === "object" && j !== null ? (j as { confirmed?: unknown }).confirmed : undefined;
      if (typeof c !== "boolean") throw new ExplorerParseError("esplora: tx status without confirmed");
      return { known: true, confirmed: c };
    },
    async broadcast(hex) {
      const res = await explorerFetch(`${base}/tx`, {
        method: "POST",
        headers: { ...headers, "content-type": "text/plain" },
        body: hex,
      }, timeoutMs);
      return (await res.text()).trim();
    },
  };
}
