/**
 * TronWeb as an independent oracle (Node only; tronweb is a devDependency never imported by src/ or the Workers tests):
 * its protobuf encoder pins the fixtures and our test writer, and its signer pins ours.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { utils } from "tronweb";
import { beforeAll, describe, expect, it } from "vitest";
import { tronBase58ToHex } from "../../src/chains/tron/address";
import { tronDepositKey, tronHotKey, tronSignDigest, type TronKey } from "../../src/signing/keys";
import { allowedDestination, type Allowed } from "../../src/routing/guard";
import { signTronTx } from "../../src/signing/tron";
import { assertTronTx, decodeTronRawData, encodeSignedTx } from "../../src/chains/tron/txcheck";
import fx from "../fixtures/tron/txs.json";
import { contract, rawBytes, transferData, transferParam, triggerParam } from "../chains/tron/pb";
import { FIXTURE_JSON, tronWebEncode } from "./gen-tron-fixtures";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const H = (a: string) => tronBase58ToHex(a);
const hot = tronHotKey(SEED);

type Json = Parameters<typeof utils.transaction.txJsonToPb>[0];
const triggerJson = (o: { owner: string; to: string; amount: bigint; callValue?: number; feeLimit?: number; exp: number; ts: number; permission?: number }) => ({
  visible: false,
  raw_data: {
    contract: [
      {
        parameter: {
          value: { owner_address: H(o.owner), contract_address: H(USDT), data: transferData(H(o.to), o.amount), call_value: o.callValue ?? 0 },
          type_url: "type.googleapis.com/protocol.TriggerSmartContract",
        },
        type: "TriggerSmartContract",
        ...(o.permission ? { Permission_id: o.permission } : {}),
      },
    ],
    ref_block_bytes: "beef",
    ref_block_hash: "0123456789abcdef",
    expiration: o.exp,
    ...(o.feeLimit ? { fee_limit: o.feeLimit } : {}),
    timestamp: o.ts,
  },
});
const transferJson = (o: { owner: string; to: string; amount: number; exp: number; ts: number }) => ({
  visible: false,
  raw_data: {
    contract: [{ parameter: { value: { owner_address: H(o.owner), to_address: H(o.to), amount: o.amount }, type_url: "type.googleapis.com/protocol.TransferContract" }, type: "TransferContract" }],
    ref_block_bytes: "beef",
    ref_block_hash: "0123456789abcdef",
    expiration: o.exp,
    timestamp: o.ts,
  },
});

describe("fixtures", () => {
  it("TronWeb's encoding of the fixture JSON still equals the stored hex and txID", () => {
    for (const name of ["trigger", "transfer"] as const) {
      expect(fx[name].json).toEqual(FIXTURE_JSON[name]);
      expect(tronWebEncode(fx[name].json)).toEqual({ raw_data_hex: fx[name].raw_data_hex, txID: fx[name].txID });
    }
  });
});

describe("test writer and decoder vs TronWeb", () => {
  const vectors = [1, 7, 42, 999].map((i, k) => ({
    owner: tronDepositKey(SEED, i).address,
    to: hot.address,
    amount: [1n, 999_999n, 12_345_678_901n, 2n ** 62n][k]!,
    exp: 1_790_000_000_000 + i * 1000,
    ts: 1_789_999_940_000 + i,
    feeLimit: [5_000_000, 1, 4_999_999, 3_000_000][k]!,
  }));

  it("TriggerSmartContract: same bytes as TronWeb, and our decoder reads them back", () => {
    for (const v of vectors) {
      const tw = tronWebEncode(triggerJson(v) as Json);
      const ours = bytesToHex(
        rawBytes({
          contracts: [contract("TriggerSmartContract", triggerParam({ owner: H(v.owner), contract: H(USDT), data: transferData(H(v.to), v.amount) }))],
          expiration: v.exp, timestamp: v.ts, feeLimit: BigInt(v.feeLimit), refBlockBytes: "beef", refBlockHash: "0123456789abcdef",
        }),
      );
      expect(ours).toBe(tw.raw_data_hex);
      const d = decodeTronRawData(tw.raw_data_hex);
      expect(d).toMatchObject({ type: "TriggerSmartContract", owner: v.owner, contract: USDT, data: transferData(H(v.to), v.amount), expiration: v.exp, feeLimit: BigInt(v.feeLimit) });
      expect(assertTronTx(tw, { type: "TriggerSmartContract", owner: v.owner, to: v.to, amount: v.amount, contract: USDT }, v.ts).type).toBe("TriggerSmartContract");
    }
  });

  it("call_value and Permission_id encode where TronWeb puts them, and both are refused", () => {
    const v = vectors[0]!;
    for (const extra of [{ callValue: 5 }, { permission: 2 }]) {
      const tw = tronWebEncode(triggerJson({ ...v, ...extra }) as Json);
      const c = contract("TriggerSmartContract", triggerParam({ owner: H(v.owner), contract: H(USDT), data: transferData(H(v.to), v.amount), callValue: BigInt(extra.callValue ?? 0) }), { permissionId: extra.permission });
      expect(bytesToHex(rawBytes({ contracts: [c], expiration: v.exp, timestamp: v.ts, feeLimit: BigInt(v.feeLimit), refBlockBytes: "beef", refBlockHash: "0123456789abcdef" }))).toBe(tw.raw_data_hex);
      expect(() => assertTronTx(tw, { type: "TriggerSmartContract", owner: v.owner, to: v.to, amount: v.amount, contract: USDT }, v.ts)).toThrow(/call_value|permission/i);
    }
  });

  it("TransferContract: same bytes as TronWeb, and our decoder reads them back", () => {
    for (const [k, amount] of [1, 500_000, 2 ** 40].entries()) {
      const owner = hot.address;
      const to = tronDepositKey(SEED, k).address;
      const tw = tronWebEncode(transferJson({ owner, to, amount, exp: 1_790_000_060_000, ts: 1_790_000_000_000 }) as Json);
      const ours = bytesToHex(
        rawBytes({ contracts: [contract("TransferContract", transferParam({ owner: H(owner), to: H(to), amount: BigInt(amount) }))], expiration: 1_790_000_060_000, timestamp: 1_790_000_000_000, refBlockBytes: "beef", refBlockHash: "0123456789abcdef" }),
      );
      expect(ours).toBe(tw.raw_data_hex);
      expect(decodeTronRawData(tw.raw_data_hex)).toMatchObject({ type: "TransferContract", owner, to, amount: BigInt(amount) });
    }
  });
});

describe("signing vs TronWeb", () => {
  // The signer (src/signing/tron.ts) signs only real txs whose destination a guard proof covers: here the hot wallet.
  let proofs: Allowed[] = [];
  beforeAll(async () => {
    proofs = [await allowedDestination({ MASTER_SEED: SEED }, "tron", hot.address)];
  });
  const specOf = (k: TronKey) => (k.address === hot.address ? ({ role: "hot" } as const) : ({ role: "deposit", index: [0, 3].find((i) => tronDepositKey(SEED, i).address === k.address)! } as const));
  const signTronTxId = (raw: string, k: TronKey) => signTronTx(SEED, specOf(k), raw, proofs).signature;
  /** A USDT transfer owned by `owner` paying the hot wallet (TRX from hot to itself for the hot key). */
  const txOf = (owner: TronKey, amount: bigint, exp: number): { txID: string; raw: string } => {
    const c =
      owner.address === hot.address
        ? contract("TransferContract", transferParam({ owner: H(owner.address), to: H(hot.address), amount }))
        : contract("TriggerSmartContract", triggerParam({ owner: H(owner.address), contract: H(USDT), data: transferData(H(hot.address), amount) }));
    const raw = bytesToHex(rawBytes({ contracts: [c], expiration: exp, timestamp: exp - 60_000, refBlockBytes: "beef", refBlockHash: "0123456789abcdef" }));
    return { txID: bytesToHex(sha256(hexToBytes(raw))), raw };
  };
  // TronWeb 6.5.1, node_modules/tronweb/lib/esm/utils/crypto.js:168-173 (ECKeySign): r || s || byte(recovery + 27).
  it("our signature equals TronWeb's ECKeySign for the same txID and key", () => {
    const keys = [tronDepositKey(SEED, 0), tronDepositKey(SEED, 3), hot];
    for (const k of keys)
      for (const [amount, exp] of [[1n, 1_790_000_060_000], [12_345_678n, 1_790_000_061_000], [(1n << 62n) - 1n, 1_790_000_062_000], [7n, 1_800_000_000_000]] as const) {
        const { txID, raw } = txOf(k, amount, exp);
        expect(signTronTxId(raw, k)).toBe(utils.crypto.ECKeySign(hexToBytes(txID) as unknown as number[], Array.from(k.priv)).toLowerCase());
      }
    // Edge digests no real tx hashes to: the internal digest signer under signTronTx (src/signing/keys.ts).
    const edges = [fx.trigger.txID, fx.transfer.txID, "00".repeat(32), "ff".repeat(31) + "fe", bytesToHex(hexToBytes(fx.trigger.txID).reverse())];
    for (const k of keys) for (const id of edges) expect(tronSignDigest(id, k.priv)).toBe(utils.crypto.ECKeySign(hexToBytes(id) as unknown as number[], Array.from(k.priv)).toLowerCase());
    const dep0 = tronDepositKey(SEED, 0);
    expect(signTronTxId(fx.trigger.raw_data_hex, dep0)).toBe(utils.crypto.ECKeySign(hexToBytes(fx.trigger.txID) as unknown as number[], Array.from(dep0.priv)).toLowerCase());
  });

  it("TronWeb recovers the signer's address from our signature", () => {
    const k = tronDepositKey(SEED, 0);
    const sig = signTronTxId(fx.trigger.raw_data_hex, k);
    expect(utils.crypto.ecRecover(fx.trigger.txID, sig).toLowerCase()).toBe(H(k.address));
  });

  it("encodeSignedTx equals TronWeb's Transaction protobuf with that signature", () => {
    const sig = signTronTxId(fx.trigger.raw_data_hex, tronDepositKey(SEED, 0));
    const pb = utils.transaction.txJsonToPb(fx.trigger.json as unknown as Json) as unknown as { addSignature(b: Uint8Array): void; serializeBinary(): Uint8Array };
    pb.addSignature(hexToBytes(sig));
    expect(encodeSignedTx(fx.trigger.raw_data_hex, sig)).toBe(bytesToHex(pb.serializeBinary()));
  });
});

describe("tronweb stays a Node-only test oracle", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs)$/.test(p) ? [p] : [];
    });
  it("nothing in src/ or the Workers tests imports tronweb", () => {
    const root = resolve(import.meta.dirname, "../..");
    const offenders = [...files(join(root, "src")), ...files(join(root, "test")).filter((p) => !p.includes(`${join("test", "node")}`))].filter((p) =>
      /from\s+["']tronweb|import\(\s*["']tronweb|require\(\s*["']tronweb/.test(readFileSync(p, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
