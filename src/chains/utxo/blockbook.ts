import { checkedHex, checkedUtxo, EXPLORER_TIMEOUT_MS, ExplorerHttpError, ExplorerNetworkError, ExplorerParseError, explorerFetch, jsonArray, uniqueUtxos, normalizeAddr, type AddressTx, type UtxoExplorer } from "./explorer";

interface BlockbookTx {
  txid: string;
  blockHeight?: number;
  blockTime?: number;
  vout?: Array<{ value: string; addresses?: string[] }>;
}

const trim = (u: string) => u.replace(/\/+$/, "");

export function blockbook(baseUrl: string, apiKey?: string, timeoutMs?: number): UtxoExplorer {
  const base = trim(baseUrl);
  const headers: Record<string, string> = apiKey ? { "api-key": apiKey } : {};
  return {
    async tipHeight() {
      const res = await explorerFetch(`${base}/api/v2`, { headers }, timeoutMs);
      const j = (await res.json()) as { blockbook?: { bestHeight?: number } };
      const n = j.blockbook?.bestHeight;
      if (typeof n !== "number" || !Number.isInteger(n)) throw new Error("blockbook: bad bestHeight");
      return n;
    },
    async addressTxs(addr) {
      const res = await explorerFetch(`${base}/api/v2/address/${encodeURIComponent(addr)}?details=txs`, { headers }, timeoutMs);
      const j = (await res.json()) as { transactions?: BlockbookTx[]; totalPages?: number };
      if ((j.totalPages ?? 1) > 1) console.warn("blockbook: totalPages > 1 for an address, pagination may be needed");
      const want = normalizeAddr(addr);
      return (j.transactions ?? []).map((t): AddressTx => {
        const confirmed = typeof t.blockHeight === "number" && t.blockHeight > 0;
        if (confirmed && typeof t.blockTime !== "number") {
          throw new ExplorerParseError(`blockbook: confirmed tx without blockTime: ${t.txid}`);
        }
        return {
          txid: t.txid,
          height: confirmed ? t.blockHeight! : null,
          time: confirmed ? t.blockTime! : null,
          valueToAddr: (t.vout ?? [])
            .filter((o) => o.addresses?.some((x) => normalizeAddr(x) === want))
            .reduce((s, o) => s + BigInt(o.value), 0n),
        };
      });
    },
    async utxos(addr) {
      const res = await explorerFetch(`${base}/api/v2/utxo/${encodeURIComponent(addr)}`, { headers }, timeoutMs);
      return uniqueUtxos("blockbook", (await jsonArray("blockbook", res)).map((u) => {
        // Blockbook gives satoshis as a decimal string.
        if (typeof u.value !== "string" || !/^(0|[1-9]\d*)$/.test(u.value)) throw new ExplorerParseError("blockbook: utxo value is not a decimal string");
        const c = u.confirmations;
        if (typeof c !== "number" || !Number.isSafeInteger(c) || c < 0) throw new ExplorerParseError("blockbook: utxo without confirmations");
        return checkedUtxo("blockbook", { txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: c > 0, height: u.height });
      }));
    },
    async txHex(txid) {
      const res = await explorerFetch(`${base}/api/v2/tx/${encodeURIComponent(txid)}`, { headers }, timeoutMs);
      let j: unknown;
      try {
        j = await res.json();
      } catch {
        throw new ExplorerParseError("blockbook: tx response is not JSON");
      }
      return checkedHex("blockbook", typeof j === "object" && j !== null ? (j as { hex?: unknown }).hex : undefined);
    },
    async txStatus(txid) {
      // Blockbook answers an unknown txid with 400/404 and {"error": "...not found..."}: the body decides, so this call
      // reads non-2xx bodies itself. Anything else that is not 2xx throws like explorerFetch would.
      let res: Response;
      try {
        res = await fetch(`${base}/api/v2/tx/${encodeURIComponent(txid)}`, { headers, signal: AbortSignal.timeout(timeoutMs ?? EXPLORER_TIMEOUT_MS) });
      } catch (e) {
        throw new ExplorerNetworkError("explorer network error", { cause: e });
      }
      let j: unknown;
      try {
        j = await res.json();
      } catch {
        j = undefined;
      }
      const o = typeof j === "object" && j !== null ? (j as { error?: unknown; confirmations?: unknown; txid?: unknown }) : undefined;
      if (!res.ok) {
        if ((res.status === 400 || res.status === 404) && typeof o?.error === "string" && /not found/i.test(o.error)) return { known: false, confirmed: false };
        throw new ExplorerHttpError(res.status, `explorer HTTP ${res.status}`);
      }
      if (!o || typeof o.txid !== "string" || o.txid.toLowerCase() !== txid.toLowerCase()) throw new ExplorerParseError("blockbook: tx answer for another txid");
      const c = o.confirmations;
      if (typeof c !== "number" || !Number.isSafeInteger(c) || c < 0) throw new ExplorerParseError("blockbook: tx without confirmations");
      return { known: true, confirmed: c > 0 };
    },
    async broadcast(hex) {
      const res = await explorerFetch(`${base}/api/v2/sendtx/`, {
        method: "POST",
        headers: { ...headers, "content-type": "text/plain" },
        body: hex,
      }, timeoutMs);
      const j = (await res.json()) as { result?: string };
      if (!j.result) throw new Error("blockbook: sendtx returned no txid");
      return j.result;
    },
  };
}
