import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { beforeAll, describe, expect, it } from "vitest";
import { tronAddressFromPubkey, tronBase58ToHex } from "../../../src/chains/tron/address";
import { tronDepositKey, tronHotKey } from "../../../src/signing/keys";
import { allowedDestination, type Allowed } from "../../../src/routing/guard";
import { signTronTx } from "../../../src/signing/tron";
import type { Env } from "../../../src/env";
import { assertTronTx, decodeTronRawData, encodeSignedTx, StaleTx, TxMismatch, type TronTxExpect } from "../../../src/chains/tron/txcheck";
import fx from "../../fixtures/tron/txs.json";
import { contract, fBytes, fFixed64, fVarint, nodeTx, rawBytes, transferData, transferParam, triggerParam, type RawOpts } from "./pb";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const DEP = tronDepositKey(SEED, 0);
const HOT = tronHotKey(SEED);
const OTHER = tronDepositKey(SEED, 9).address;
const H = (a: string) => tronBase58ToHex(a);
const NOW = fx.trigger.now;
const EXP = NOW + 60_000;
const AMT = 12_345_678n;

const trigExpect: TronTxExpect = { type: "TriggerSmartContract", owner: DEP.address, to: HOT.address, amount: AMT, contract: USDT };
const xferExpect: TronTxExpect = { type: "TransferContract", owner: HOT.address, to: DEP.address, amount: 500_000n };

/** A TriggerSmartContract raw tx; every option mutates one thing. */
function trig(o: { owner?: string; contract?: string; to?: string; amount?: bigint; data?: string; callValue?: bigint; callTokenValue?: bigint; tokenId?: bigint; paramExtra?: Uint8Array; contractOpts?: Parameters<typeof contract>[2]; raw?: Partial<RawOpts>; twice?: boolean } = {}) {
  const param = triggerParam({
    owner: H(o.owner ?? DEP.address),
    contract: H(o.contract ?? USDT),
    data: o.data ?? transferData(H(o.to ?? HOT.address), o.amount ?? AMT),
    callValue: o.callValue,
    callTokenValue: o.callTokenValue,
    tokenId: o.tokenId,
    extra: o.paramExtra,
  });
  const c = contract("TriggerSmartContract", param, o.contractOpts);
  return nodeTx(rawBytes({ contracts: o.twice ? [c, c] : [c], expiration: EXP, timestamp: NOW, feeLimit: 5_000_000n, ...o.raw }));
}
function xfer(o: { owner?: string; to?: string; amount?: bigint; raw?: Partial<RawOpts> } = {}) {
  const c = contract("TransferContract", transferParam({ owner: H(o.owner ?? HOT.address), to: H(o.to ?? DEP.address), amount: o.amount ?? 500_000n }));
  return nodeTx(rawBytes({ contracts: [c], expiration: EXP, timestamp: NOW, ...o.raw }));
}
const mismatch = (f: () => unknown, re?: RegExp) => {
  let err: unknown;
  try {
    f();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(TxMismatch);
  if (re) expect((err as Error).message).toMatch(re);
};

describe("decodeTronRawData on TronWeb-encoded fixtures", () => {
  it("decodes the TriggerSmartContract fixture", () => {
    const d = decodeTronRawData(fx.trigger.raw_data_hex);
    expect(d.type).toBe("TriggerSmartContract");
    expect(d.owner).toBe(DEP.address);
    expect(d.contract).toBe(USDT);
    expect(d.data).toBe(fx.trigger.json.raw_data.contract[0]!.parameter.value.data);
    expect(d.expiration).toBe(EXP);
    expect(d.feeLimit).toBe(5_000_000n);
  });

  it("decodes the TransferContract fixture", () => {
    const d = decodeTronRawData(fx.transfer.raw_data_hex);
    expect(d).toMatchObject({ type: "TransferContract", owner: HOT.address, to: DEP.address, amount: 500_000n, expiration: EXP });
  });

  it("our test writer encodes the fixture JSON byte for byte like TronWeb", () => {
    expect(trig().raw_data_hex).toBe(fx.trigger.raw_data_hex);
    expect(xfer({ raw: { refBlockBytes: "c3d4", refBlockHash: "8877665544332211" } }).raw_data_hex).toBe(fx.transfer.raw_data_hex);
  });
});

describe("assertTronTx", () => {
  it("passes on both real fixtures", () => {
    expect(assertTronTx(fx.trigger, trigExpect, NOW).type).toBe("TriggerSmartContract");
    expect(assertTronTx(fx.transfer, xferExpect, NOW).type).toBe("TransferContract");
  });

  it("flipping one byte of the recipient inside data is a mismatch (txID recomputed)", () => {
    const raw = hexToBytes(fx.trigger.raw_data_hex);
    const at = bytesToHex(raw).indexOf(H(HOT.address).slice(2)) / 2;
    raw[at + 5]! ^= 0x01;
    mismatch(() => assertTronTx(nodeTx(raw), trigExpect, NOW), /data/);
  });

  it("a txID that is not sha256(raw_data_hex) is a mismatch", () => {
    mismatch(() => assertTronTx({ ...fx.trigger, txID: fx.transfer.txID }, trigExpect, NOW), /txID/);
    mismatch(() => assertTronTx({ ...fx.trigger, txID: "zz" }, trigExpect, NOW), /txID/);
  });

  describe("rejects each single mutation of a TriggerSmartContract", () => {
    const cases: Array<[string, () => { txID: string; raw_data_hex: string }, RegExp]> = [
      ["owner", () => trig({ owner: OTHER }), /owner/],
      ["recipient", () => trig({ to: OTHER }), /data/],
      ["amount", () => trig({ amount: AMT + 1n }), /data/],
      ["token contract", () => trig({ contract: OTHER }), /contract/],
      ["call_value", () => trig({ callValue: 1n }), /call_value/],
      ["call_token_value", () => trig({ callTokenValue: 1n }), /call_token_value|token/],
      ["token_id", () => trig({ tokenId: 1000001n }), /token/],
      ["fee_limit over 5 TRX", () => trig({ raw: { feeLimit: 5_000_001n } }), /fee_limit/],
      ["an extra contract", () => trig({ twice: true }), /contract/],
      ["permission_id", () => trig({ contractOpts: { permissionId: 2 } }), /permission/i],
      ["memo (raw.data)", () => trig({ raw: { memo: "68656c6c6f" } }), /memo|field 10/],
      ["unknown raw field", () => trig({ raw: { extra: fVarint(30, 1) } }), /unknown|field 30/],
      ["auths (raw field 9)", () => trig({ raw: { extra: fBytes(9, new Uint8Array([1])) } }), /field 9|auth/],
      ["scripts (raw field 12)", () => trig({ raw: { extra: fBytes(12, new Uint8Array([1])) } }), /field 12|script/],
      ["unknown contract field", () => trig({ contractOpts: { extra: fBytes(3, new Uint8Array([1])) } }), /contract field 3|provider|unknown/],
      ["unknown parameter field", () => trig({ paramExtra: fVarint(7, 1) }), /unknown|field 7/],
      ["contract type number", () => trig({ contractOpts: { typeNum: 1 } }), /type/],
      ["type_url", () => trig({ contractOpts: { typeUrl: "type.googleapis.com/protocol.TransferContract" } }), /type/],
      ["type_url prefix", () => trig({ contractOpts: { typeUrl: "x/protocol.TriggerSmartContract" } }), /type_url/],
      ["data length", () => trig({ data: `${transferData(H(HOT.address), AMT)}00` }), /data/],
      ["selector", () => trig({ data: `a9059cbc${transferData(H(HOT.address), AMT).slice(8)}` }), /data/],
      ["dirty address padding", () => trig({ data: `a9059cbb01${transferData(H(HOT.address), AMT).slice(10)}` }), /data/],
      ["ref_block_bytes length", () => trig({ raw: { refBlockBytes: "a1b2c3" } }), /ref_block_bytes/],
      ["ref_block_hash length", () => trig({ raw: { refBlockHash: "0f1e2d3c4b5a69" } }), /ref_block_hash/],
      ["expired", () => trig({ raw: { expiration: NOW } }), /expir/],
      ["expiration over 24h", () => trig({ raw: { expiration: NOW + 24 * 3_600_000 + 1 } }), /expir/],
    ];
    for (const [name, build, re] of cases) it(name, () => mismatch(() => assertTronTx(build(), trigExpect, NOW), re));
    it("an expected type that differs from the decoded one", () => mismatch(() => assertTronTx(trig(), { ...xferExpect, owner: DEP.address }, NOW), /type/));
    it("an expected contract that is not USDT", () => mismatch(() => assertTronTx(trig({ contract: OTHER }), { ...trigExpect, contract: OTHER }, NOW), /USDT/));
  });

  describe("rejects each single mutation of a TransferContract", () => {
    it("owner", () => mismatch(() => assertTronTx(xfer({ owner: OTHER }), xferExpect, NOW), /owner/));
    it("recipient", () => mismatch(() => assertTronTx(xfer({ to: OTHER }), xferExpect, NOW), /to/));
    it("amount", () => mismatch(() => assertTronTx(xfer({ amount: 500_001n }), xferExpect, NOW), /amount/));
    it("fee_limit over 5 TRX", () => mismatch(() => assertTronTx(xfer({ raw: { feeLimit: 5_000_001n } }), xferExpect, NOW), /fee_limit/));
    it("memo", () => mismatch(() => assertTronTx(xfer({ raw: { memo: "00" } }), xferExpect, NOW), /memo|field 10/));
    it("passes unmutated", () => expect(assertTronTx(xfer(), xferExpect, NOW).amount).toBe(500_000n));
  });
});

describe("protobuf reader strictness", () => {
  const good = fx.trigger.raw_data_hex;
  it("rejects input truncated anywhere inside a field (and before the contract)", () => {
    // Top-level field ends of the fixture (1, 4, 8, 11, 14, 18): cutting exactly there leaves a shorter but well-formed
    // message, which the assert step judges (missing fee_limit etc.); every other cut must fail to decode.
    const c = contract("TriggerSmartContract", triggerParam({ owner: H(DEP.address), contract: H(USDT), data: transferData(H(HOT.address), AMT) }));
    const pieces = [fBytes(1, hexToBytes("a1b2")), fBytes(4, hexToBytes("0f1e2d3c4b5a6978")), fVarint(8, EXP), fBytes(11, c), fVarint(14, NOW), fVarint(18, 5_000_000)];
    const ends = new Set<number>();
    pieces.reduce((n, p) => (ends.add(n + p.length * 2), n + p.length * 2), 0);
    expect(Math.max(...ends)).toBe(good.length);
    let cuts = 0;
    for (let n = 2; n < good.length; n += 2) {
      if (ends.has(n)) continue;
      mismatch(() => decodeTronRawData(good.slice(0, n)));
      cuts++;
    }
    expect(cuts).toBeGreaterThan(200);
    // Before the contract field: no contract at all.
    for (const n of [...ends].filter((n) => n < good.indexOf("5aae01"))) mismatch(() => decodeTronRawData(good.slice(0, n)), /contract/);
  });
  it("rejects odd-length and non-hex input", () => {
    mismatch(() => decodeTronRawData(`${good}0`));
    mismatch(() => decodeTronRawData(`${good.slice(0, -2)}zz`));
  });
  it("rejects an overlong varint (11 bytes) and a non-minimal one", () => {
    mismatch(() => decodeTronRawData(`${good}70${"ff".repeat(10)}01`), /varint/);
    mismatch(() => decodeTronRawData(`0a02a1b2220800000000000000004080${"80".repeat(2)}00`), /varint/);
  });
  it("rejects a varint above int64", () => {
    // field 8 (expiration) = 2^63
    mismatch(() => decodeTronRawData(`0a02a1b22208000000000000000040${"80".repeat(9)}01`), /int64|range/);
  });
  it("rejects wire types 3 and 4 (groups)", () => {
    mismatch(() => decodeTronRawData(`${good}7b`), /wire/); // field 15, type 3
    mismatch(() => decodeTronRawData(`${good}7c`), /wire/); // field 15, type 4
  });
  it("reads fixed64 fields but still rejects them as unknown", () => {
    mismatch(() => decodeTronRawData(bytesToHex(rawBytes({ contracts: [], expiration: EXP, extra: fFixed64(30, new Uint8Array(8)) }))), /unknown|field 30/);
  });
  it("rejects a known field with the wrong wire type", () => {
    mismatch(() => decodeTronRawData(`${good}4101000000000000 00`.replace(" ", "")), /wire|field 8/);
  });
  it("rejects a duplicated scalar field", () => {
    mismatch(() => decodeTronRawData(`${good}${bytesToHex(fVarint(8, EXP))}`), /duplicate|field 8/);
  });
});

describe("signing", () => {
  // The signer (src/signing/tron.ts) needs guard proofs: hot for the USDT transfer, the deposit's top-up proof for the
  // TRX one (minted only for a recorded Tron payment at that index).
  let proofs: Allowed[] = [];
  beforeAll(async () => {
    const e = env as unknown as Env;
    await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
    await e.DB.prepare(
      "INSERT INTO invoices(id,created_at,expires_at,price_minor,currency,status,late,overpaid,paid_minor) VALUES('inv_txc',0,1,'1','USD','paid',0,0,'1') ON CONFLICT DO NOTHING",
    ).run();
    await e.DB.prepare(
      "INSERT INTO payments(id,invoice_id,asset,chain,address,derivation_index,expected,price_e8,rate_locked_until,received,final,txids,status,created_at,credited_minor) VALUES('pay_txc','inv_txc','tron:usdt','tron',?,0,'1','1',0,'0','0','[]','confirmed',0,'0') ON CONFLICT DO NOTHING",
    ).bind(DEP.address).run();
    proofs = [await allowedDestination(e, "tron", HOT.address), await allowedDestination(e, "tron", DEP.address, { depositIndex: 0 })];
  });
  const specOf = (key: typeof DEP) => (key.address === HOT.address ? ({ role: "hot" } as const) : ({ role: "deposit", index: 0 } as const));
  const signTronTxId = (t: { txID: string; raw_data_hex: string }, key: typeof DEP) => {
    const r = signTronTx(SEED, specOf(key), t.raw_data_hex, proofs);
    expect(r.txID).toBe(t.txID);
    return r.signature;
  };
  it("signs txID with deterministic low-S RFC6979 and appends v = recovery + 27, exactly like TronWeb", () => {
    expect(signTronTxId(fx.trigger, DEP)).toBe(fx.trigger.signature);
    expect(signTronTxId(fx.transfer, HOT)).toBe(fx.transfer.signature);
    expect(signTronTxId(fx.trigger, DEP)).toBe(signTronTxId(fx.trigger, DEP));
  });

  it("recovers the owner address from our signature", () => {
    for (const [t, owner] of [[fx.trigger, DEP.address], [fx.transfer, HOT.address]] as const) {
      const sig = hexToBytes(signTronTxId(t, owner === DEP.address ? DEP : HOT));
      expect(sig).toHaveLength(65);
      expect([27, 28]).toContain(sig[64]);
      const s = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact");
      expect(s.s <= secp256k1.Point.Fn.ORDER / 2n).toBe(true);
      const pub = s.addRecoveryBit(sig[64]! - 27).recoverPublicKey(hexToBytes(t.txID)).toBytes(false);
      expect(tronAddressFromPubkey(pub)).toBe(owner);
    }
  });

  it("refuses raw data that is not a hex Transaction.raw", () => {
    expect(() => signTronTx(SEED, specOf(DEP), "abcd", proofs)).toThrow();
    expect(() => signTronTx(SEED, specOf(DEP), `${fx.trigger.raw_data_hex.slice(0, -2)}zz`, proofs)).toThrow();
  });

  it("encodes a signed Transaction as raw_data (field 1) + signature (field 2)", () => {
    const sig = signTronTxId(fx.trigger, DEP);
    expect(encodeSignedTx(fx.trigger.raw_data_hex, sig)).toBe(bytesToHex(new Uint8Array([...fBytes(1, hexToBytes(fx.trigger.raw_data_hex)), ...fBytes(2, hexToBytes(sig))])));
  });
});

describe("decoder edge cases", () => {
  const data = transferData(H(HOT.address), AMT);
  const wrap = (param: Uint8Array, o: Parameters<typeof contract>[2] = {}) =>
    nodeTx(rawBytes({ contracts: [contract("TriggerSmartContract", param, o)], expiration: EXP, timestamp: NOW, feeLimit: 5_000_000n }));

  it("a contract type that overflows 32 bits (2^32 + 31) is not TriggerSmartContract", () => {
    mismatch(() => decodeTronRawData(trig({ contractOpts: { typeNum: 2 ** 32 + 31 } }).raw_data_hex), /type/);
  });
  it("a 20-byte owner address (no 0x41 prefix) is refused", () => {
    const param = triggerParam({ owner: H(DEP.address).slice(2), contract: H(USDT), data });
    mismatch(() => decodeTronRawData(wrap(param).raw_data_hex), /21-byte 0x41/);
  });
  it("a 21-byte address with another prefix is refused", () => {
    const param = triggerParam({ owner: `42${H(DEP.address).slice(2)}`, contract: H(USDT), data });
    mismatch(() => decodeTronRawData(wrap(param).raw_data_hex), /21-byte 0x41/);
  });
  it("a missing owner is refused", () => {
    const param = concatBytes(fBytes(2, hexToBytes(H(USDT))), fBytes(4, hexToBytes(data)));
    mismatch(() => decodeTronRawData(wrap(param).raw_data_hex), /owner_address: missing/);
  });
  it("missing calldata decodes as empty and never matches a transfer", () => {
    const param = concatBytes(fBytes(1, hexToBytes(H(DEP.address))), fBytes(2, hexToBytes(H(USDT))));
    expect(decodeTronRawData(wrap(param).raw_data_hex).data).toBe("");
    mismatch(() => assertTronTx(wrap(param), trigExpect, NOW), /data/);
  });
  it("an extra field inside the Any is refused", () => {
    const param = triggerParam({ owner: H(DEP.address), contract: H(USDT), data });
    mismatch(() => decodeTronRawData(wrap(param, { anyExtra: fVarint(3, 1) }).raw_data_hex), /parameter: unknown field 3/);
  });
  it("a nested field longer than its parent is truncated, not read past the parent", () => {
    // Contract { type = 31, parameter: LEN 200 } but only 10 bytes follow inside the contract.
    const inner = concatBytes(fVarint(1, 31), Uint8Array.of(0x12, 0xc8, 0x01), new Uint8Array(10));
    const raw = rawBytes({ contracts: [inner], expiration: EXP, timestamp: NOW, extra: fVarint(18, 1) });
    mismatch(() => decodeTronRawData(bytesToHex(raw)), /contract: truncated/);
  });
});

describe("stale node answers", () => {
  it("an expiration already past is StaleTx (still a TxMismatch, so nothing is ever signed)", () => {
    let err: unknown;
    try {
      assertTronTx(trig({ raw: { expiration: NOW } }), trigExpect, NOW);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StaleTx);
    expect(err).toBeInstanceOf(TxMismatch);
  });
  it("a stale tx that is also tampered is reported as a mismatch, not as stale", () => {
    let err: unknown;
    try {
      assertTronTx(trig({ to: OTHER, raw: { expiration: NOW } }), trigExpect, NOW);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TxMismatch);
    expect(err).not.toBeInstanceOf(StaleTx);
    expect((err as Error).message).toMatch(/data/);
  });
});
