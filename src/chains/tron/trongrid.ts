import type { Env } from "../../env";
import { getAsset } from "../../core/assets";
import { EXPLORER_TIMEOUT_MS, explorerFetch } from "../utxo/explorer";
import { tronBase58ToHex } from "./address";

export const DEFAULT_TRON_API_URL = "https://api.trongrid.io";
/** Pages of 200 transfers. Past this the answer would be a silent truncation, so the call throws instead. */
export const MAX_PAGES = 10;
/** Incoming-TRX history is display-only (`unexpected`): a shorter cap, then it is omitted. */
export const TRX_MAX_PAGES = 3;
const PAGE_SIZE = 200;

export interface Trc20Transfer {
  txid: string;
  value: bigint;
  blockTimestamp: number;
}

const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Strict hex string (optional 0x, lowercased). `lens` limits its digit count; null accepts any even length. */
function hexField(v: unknown, lens: number[] | null, txid: string): string {
  const h = typeof v === "string" ? v.replace(/^0x/i, "").toLowerCase() : "";
  if (!/^[0-9a-f]+$/.test(h) || (lens ? !lens.includes(h.length) : h.length % 2 !== 0)) throw new Error(`trongrid: malformed log field in ${txid}`);
  return h;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * TronGrid client. Every call sends the API key, times out, and throws on a non-2xx status or a body that is not
 * the expected JSON: an unreadable answer is never read as "nothing there".
 */
export function tronGrid(env: Pick<Env, "TRONGRID_API_KEY" | "TRON_API_URL">, timeoutMs = EXPLORER_TIMEOUT_MS) {
  const base = (env.TRON_API_URL || DEFAULT_TRON_API_URL).replace(/\/+$/, "");
  const headers: Record<string, string> = { "TRON-PRO-API-KEY": env.TRONGRID_API_KEY ?? "" };

  async function json(url: string, init: RequestInit = {}): Promise<Json> {
    const res = await explorerFetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }, timeoutMs);
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      throw new Error("trongrid: response is not JSON", { cause: e });
    }
    if (!isObj(body)) throw new Error("trongrid: unexpected response shape");
    return body;
  }

  return {
    /** The endpoint in use (part of the adapter's cache key). */
    base,

    /**
     * Incoming TRC-20 transfers of `contract` to `addr` since `minTimestamp` (unix ms). Every row is re-checked
     * here (recipient, token contract, event type) and the amount parsed strictly; the query filters are not trusted.
     */
    async trc20Incoming(addr: string, contract: string, minTimestamp: number): Promise<Trc20Transfer[]> {
      const out: Trc20Transfer[] = [];
      let fingerprint: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const q = new URLSearchParams({ only_to: "true", contract_address: contract, min_timestamp: String(minTimestamp), limit: String(PAGE_SIZE) });
        if (fingerprint !== undefined) q.set("fingerprint", fingerprint);
        const body = await json(`${base}/v1/accounts/${encodeURIComponent(addr)}/transactions/trc20?${q}`);
        if (!Array.isArray(body.data)) throw new Error("trongrid: trc20 response has no data array");
        for (const r of body.data as unknown[]) {
          if (!isObj(r)) throw new Error("trongrid: malformed trc20 row");
          const token = isObj(r.token_info) ? r.token_info : {};
          if (r.to !== addr || token.address !== contract || r.type !== "Transfer") continue;
          const { transaction_id: txid, value, block_timestamp: ts } = r;
          if (typeof txid !== "string" || txid === "") throw new Error("trongrid: trc20 row without transaction_id");
          if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`trongrid: bad transfer value in ${txid}`);
          if (typeof ts !== "number" || !Number.isFinite(ts)) throw new Error(`trongrid: bad block_timestamp in ${txid}`);
          out.push({ txid, value: BigInt(value), blockTimestamp: ts });
        }
        const next = isObj(body.meta) ? body.meta.fingerprint : undefined;
        if (typeof next !== "string" || next === "") return out;
        fingerprint = next;
      }
      throw new Error(`trongrid: more than ${MAX_PAGES} pages of transfers for ${addr}`);
    },

    /**
     * The solidity node's view of a transaction, as what it paid to `addr`: null while it has not solidified (an empty
     * `{}` answer), else the sum of USDT Transfer logs to `addr` (0 unless the receipt is SUCCESS). The log address is the
     * authority, not the called contract, so wrapper and multisend payments count. A malformed log throws.
     */
    async solidTxInfo(txid: string, addr: string): Promise<{ value: bigint } | null> {
      const info = await json(`${base}/walletsolidity/gettransactioninfobyid`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: txid }),
      });
      if (Object.keys(info).length === 0) return null;
      const logs = info.log === undefined ? [] : info.log;
      if (!Array.isArray(logs)) throw new Error(`trongrid: malformed log list in ${txid}`);
      const usdt = tronBase58ToHex(getAsset("tron:usdt").contract!).slice(2);
      const me = tronBase58ToHex(addr).slice(2);
      let value = 0n;
      for (const l of logs as unknown[]) {
        if (!isObj(l)) throw new Error(`trongrid: malformed log in ${txid}`);
        // Foreign logs (NFTs, all-indexed events) may omit fields: only type-guard, then filter by emitter and event.
        // Protobuf-JSON omits empty repeated fields, so a LOG0 event has no `topics` key at all.
        const topics: unknown = l.topics === undefined ? [] : l.topics;
        if (typeof l.address !== "string" || !Array.isArray(topics)) throw new Error(`trongrid: malformed log in ${txid}`);
        const emitter = l.address.replace(/^0x/i, "").toLowerCase();
        // 20-byte address as the node prints it, or with the 0x41 prefix. Any other length is not USDT (ignored).
        const emitterBody = emitter.length === 40 ? emitter : emitter.length === 42 && emitter.startsWith("41") ? emitter.slice(2) : null;
        const sig = typeof topics[0] === "string" ? topics[0].replace(/^0x/i, "").toLowerCase() : "";
        if (emitterBody !== usdt || sig !== TRANSFER_TOPIC) continue;
        // A real USDT Transfer has 3 topics (padded recipient) and 32 bytes of data; anything else throws.
        const t = topics.map((x) => hexField(x, [64], txid));
        const data = hexField(l.data, [64], txid);
        if (t.length !== 3 || !/^0{24}[0-9a-f]{40}$/.test(t[2]!)) throw new Error(`trongrid: malformed Transfer log in ${txid}`);
        if (t[2]!.slice(-40) === me) value += BigInt(`0x${data}`);
      }
      return info.receipt && isObj(info.receipt) && info.receipt.result === "SUCCESS" ? { value } : { value: 0n };
    },

    /**
     * Incoming TRX (TransferContract, contractRet SUCCESS) to `addr` since `minTimestamp`, in sun, each at least
     * `floor`, skipping transfers whose owner is `exclude` (the sweeper's own top-ups). Rows are re-checked here (type,
     * recipient, owner, result); internal txs are skipped. Index data (pre-solid): display only, never credited. A
     * malformed row or more than TRX_MAX_PAGES pages throws.
     */
    async trxIncoming(addr: string, minTimestamp: number, exclude: string, floor: bigint): Promise<bigint> {
      const me = tronBase58ToHex(addr);
      const skip = tronBase58ToHex(exclude);
      let total = 0n;
      let fingerprint: string | undefined;
      for (let page = 0; page < TRX_MAX_PAGES; page++) {
        const q = new URLSearchParams({ only_to: "true", min_timestamp: String(minTimestamp), limit: String(PAGE_SIZE) });
        if (fingerprint !== undefined) q.set("fingerprint", fingerprint);
        const body = await json(`${base}/v1/accounts/${encodeURIComponent(addr)}/transactions?${q}`);
        if (!Array.isArray(body.data)) throw new Error("trongrid: transactions response has no data array");
        for (const r of body.data as unknown[]) {
          if (!isObj(r)) throw new Error("trongrid: malformed transaction row");
          if (r.internal_tx_id !== undefined) continue; // contract-internal TRX moves: not a plain transfer
          const raw = isObj(r.raw_data) ? r.raw_data : null;
          const c: unknown = raw && Array.isArray(raw.contract) ? raw.contract[0] : undefined;
          if (!isObj(c) || typeof c.type !== "string") throw new Error("trongrid: transaction row without a contract");
          if (c.type !== "TransferContract") continue;
          const v = isObj(c.parameter) && isObj(c.parameter.value) ? c.parameter.value : null;
          const ret: unknown = Array.isArray(r.ret) ? r.ret[0] : undefined;
          if (!v || !isObj(ret)) throw new Error("trongrid: malformed TRX transfer row");
          const amount = v.amount;
          if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new Error("trongrid: bad TRX transfer amount");
          const to = hexAddr(v.to_address);
          const from = hexAddr(v.owner_address);
          if (ret.contractRet !== "SUCCESS" || to !== me || from === skip || BigInt(amount) < floor) continue;
          total += BigInt(amount);
        }
        const next = isObj(body.meta) ? body.meta.fingerprint : undefined;
        if (typeof next !== "string" || next === "") return total;
        fingerprint = next;
      }
      throw new Error(`trongrid: more than ${TRX_MAX_PAGES} pages of TRX transfers for ${addr}`);
    },

    /** TRX balance in sun (1 TRX = 1e6). A never-activated account has `data: []` and 0 TRX. */
    async trxBalance(addr: string): Promise<bigint> {
      const body = await json(`${base}/v1/accounts/${encodeURIComponent(addr)}`);
      if (!Array.isArray(body.data)) throw new Error("trongrid: account response has no data array");
      if (body.data.length === 0) return 0n;
      const acct: unknown = body.data[0];
      if (!isObj(acct)) throw new Error("trongrid: malformed account");
      if (acct.balance === undefined) return 0n; // activated, zero balance: the field is omitted
      const b = acct.balance;
      if (typeof b === "number" && Number.isSafeInteger(b) && b >= 0) return BigInt(b);
      if (typeof b === "string" && /^\d+$/.test(b)) return BigInt(b);
      throw new Error("trongrid: bad account balance");
    },

    // ---- Sweeping. Every node-built tx goes through assertTronTx before it is signed (see sweep/tron.ts). ----

    /** Whether the full node has the tx in a block (gettransactioninfobyid answers more than `{}`), solid or not. */
    async fullNodeKnows(txid: string): Promise<boolean> {
      const info = await post("/wallet/gettransactioninfobyid", { value: txid });
      if (Object.keys(info).length === 0) return false;
      if (typeof info.id !== "string" || info.id.toLowerCase() !== txid.toLowerCase()) throw new Error(`trongrid: full-node info for another tx than ${txid}`);
      return true;
    },

    /** The solidity node's verdict on a tx of any type: null while not solid, else whether it succeeded. */
    async solidTxStatus(txid: string): Promise<{ success: boolean } | null> {
      const info = await post("/walletsolidity/gettransactioninfobyid", { value: txid });
      if (Object.keys(info).length === 0) return null;
      if (typeof info.id !== "string" || info.id.toLowerCase() !== txid.toLowerCase()) throw new Error(`trongrid: solid info for another tx than ${txid}`);
      // System contracts (TRX transfers) carry no receipt.result; a failed tx says result: "FAILED".
      const receipt = isObj(info.receipt) ? info.receipt.result : undefined;
      return { success: info.result !== "FAILED" && (receipt === undefined || receipt === "SUCCESS") };
    },

    /** TRC-20 balanceOf(holder) through a constant call (no tx). `caller` is any activated account (the hot wallet). */
    async trc20Balance(contract: string, holder: string, caller: string): Promise<bigint> {
      const body = await post("/wallet/triggerconstantcontract", {
        owner_address: caller,
        contract_address: contract,
        function_selector: "balanceOf(address)",
        parameter: word(holder),
        visible: true,
      });
      if (!isObj(body.result) || body.result.result !== true || !Array.isArray(body.constant_result)) throw new Error("trongrid: balanceOf call failed");
      const r: unknown = body.constant_result[0];
      if (typeof r !== "string" || !/^[0-9a-fA-F]{64}$/.test(r)) throw new Error("trongrid: malformed balanceOf result");
      return BigInt(`0x${r}`);
    },

    /** Energy the account can spend now: EnergyLimit - EnergyUsed (own stake + delegated, e.g. rented). */
    async energyAvailable(addr: string): Promise<number> {
      const body = await post("/wallet/getaccountresource", { address: addr, visible: true });
      const n = (v: unknown) => {
        if (v === undefined) return 0; // protobuf JSON omits zeros
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("trongrid: malformed account resource");
        return v;
      };
      return Math.max(0, n(body.EnergyLimit) - n(body.EnergyUsed));
    },

    /** Unsigned TRX transfer built by the node. Only txID and raw_data_hex are kept. */
    async createTrxTransfer(from: string, to: string, amountSun: bigint): Promise<UnsignedTronTx> {
      const body = await post("/wallet/createtransaction", { owner_address: from, to_address: to, amount: safe(amountSun), visible: true });
      if (body.Error !== undefined) throw new Error("trongrid: createtransaction refused");
      return unsigned(body, "createtransaction");
    },

    /** Unsigned TRC-20 transfer(to, amount) from `owner`, built by the node. Only txID and raw_data_hex are kept. */
    async triggerTrc20Transfer(owner: string, contract: string, to: string, amount: bigint, feeLimitSun: bigint): Promise<UnsignedTronTx> {
      const body = await post("/wallet/triggersmartcontract", {
        owner_address: owner,
        contract_address: contract,
        function_selector: "transfer(address,uint256)",
        parameter: word(to) + amount.toString(16).padStart(64, "0"),
        fee_limit: safe(feeLimitSun),
        call_value: 0,
        visible: true,
      });
      if (!isObj(body.result) || body.result.result !== true) throw new Error("trongrid: triggersmartcontract refused");
      return unsigned(body.transaction, "triggersmartcontract");
    },

    /**
     * Broadcasts a signed Transaction protobuf (hex). The node re-hashes the bytes we verified and signed, so the
     * raw_data JSON is never involved. A refusal is { ok: false, code }; DUP_TRANSACTION_ERROR (already known) is ok.
     */
    async broadcastHex(signedHex: string): Promise<{ ok: true } | { ok: false; code: string }> {
      const body = await post("/wallet/broadcasthex", { transaction: signedHex });
      if (body.result === true) return { ok: true };
      const code = typeof body.code === "string" ? body.code.replace(/[^A-Z_]/g, "").slice(0, 40) : "UNKNOWN";
      if (code === "DUP_TRANSACTION_ERROR") return { ok: true };
      return { ok: false, code };
    },
  };

  function post(path: string, payload: unknown): Promise<Json> {
    return json(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  }
}

/** A node-built unsigned tx. raw_data (JSON) is dropped on purpose: only the hex is verified and signed. */
export interface UnsignedTronTx {
  txID: string;
  raw_data_hex: string;
}
function unsigned(v: unknown, what: string): UnsignedTronTx {
  if (!isObj(v) || typeof v.txID !== "string" || typeof v.raw_data_hex !== "string") throw new Error(`trongrid: ${what} returned no transaction`);
  return { txID: v.txID, raw_data_hex: v.raw_data_hex };
}
/** An address field of a /v1 row: 0x41 hex (visible=false) or base58, as lowercase 42-char hex. Throws otherwise. */
function hexAddr(v: unknown): string {
  if (typeof v !== "string") throw new Error("trongrid: malformed address");
  if (/^41[0-9a-fA-F]{40}$/.test(v)) return v.toLowerCase();
  try {
    return tronBase58ToHex(v);
  } catch {
    throw new Error("trongrid: malformed address");
  }
}
/** A base58 address as an ABI word: the 20-byte body left-padded to 32 bytes. */
const word = (addr: string) => tronBase58ToHex(addr).slice(2).padStart(64, "0");
const safe = (v: bigint): number => {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("trongrid: amount out of range");
  return Number(v);
};
