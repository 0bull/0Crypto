/**
 * Writes test/fixtures/tron/txs.json from TronWeb's own protobuf encoder (offline: utils.transaction.txJsonToPb +
 * txPbToRawDataHex/txPbToTxID, utils.crypto.ECKeySign). Run with `npx tsx test/node/gen-tron-fixtures.ts`.
 * The Workers tests decode these bytes; test/node/tron-oracle.test.ts re-encodes the same JSON with TronWeb and
 * asserts the hex still matches, so the fixtures are never hand-crafted.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { hexToBytes } from "@noble/hashes/utils.js";
import { utils } from "tronweb";
import { tronBase58ToHex } from "../../src/chains/tron/address";
import { tronDepositKey, tronHotKey } from "../../src/signing/keys";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const deposit = tronDepositKey(SEED, 0);
const hot = tronHotKey(SEED);
const h = (a: string) => tronBase58ToHex(a);
const TIMESTAMP = 1_800_000_000_000;
const EXPIRATION = TIMESTAMP + 60_000;
const AMOUNT = 12_345_678n;
const pad = (x: string) => x.padStart(64, "0");

export const FIXTURE_JSON = {
  trigger: {
    visible: false,
    raw_data: {
      contract: [
        {
          parameter: {
            value: {
              owner_address: h(deposit.address),
              contract_address: h(USDT),
              data: `a9059cbb${pad(h(hot.address).slice(2))}${pad(AMOUNT.toString(16))}`,
              call_value: 0,
            },
            type_url: "type.googleapis.com/protocol.TriggerSmartContract",
          },
          type: "TriggerSmartContract",
        },
      ],
      ref_block_bytes: "a1b2",
      ref_block_hash: "0f1e2d3c4b5a6978",
      expiration: EXPIRATION,
      fee_limit: 5_000_000,
      timestamp: TIMESTAMP,
    },
  },
  transfer: {
    visible: false,
    raw_data: {
      contract: [
        {
          parameter: {
            value: { owner_address: h(hot.address), to_address: h(deposit.address), amount: 500_000 },
            type_url: "type.googleapis.com/protocol.TransferContract",
          },
          type: "TransferContract",
        },
      ],
      ref_block_bytes: "c3d4",
      ref_block_hash: "8877665544332211",
      expiration: EXPIRATION,
      timestamp: TIMESTAMP,
    },
  },
} as const;

export function tronWebEncode(json: unknown): { raw_data_hex: string; txID: string } {
  const pb = utils.transaction.txJsonToPb(json as Parameters<typeof utils.transaction.txJsonToPb>[0]);
  return { raw_data_hex: utils.transaction.txPbToRawDataHex(pb).toLowerCase(), txID: utils.transaction.txPbToTxID(pb).replace(/^0x/, "") };
}

if (process.argv[1]?.endsWith("gen-tron-fixtures.ts")) {
  const out: Record<string, unknown> = {};
  for (const [name, json] of Object.entries(FIXTURE_JSON)) {
    const enc = tronWebEncode(json);
    const signer = name === "trigger" ? deposit : hot;
    const signature = utils.crypto.ECKeySign(hexToBytes(enc.txID) as unknown as number[], Array.from(signer.priv)).toLowerCase();
    out[name] = { json, ...enc, signature, now: TIMESTAMP };
  }
  out.expect = {
    trigger: { type: "TriggerSmartContract", owner: deposit.address, to: hot.address, amount: AMOUNT.toString(), contract: USDT },
    transfer: { type: "TransferContract", owner: hot.address, to: deposit.address, amount: "500000" },
  };
  const dir = resolve(import.meta.dirname, "../fixtures/tron");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "txs.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log("wrote", resolve(dir, "txs.json"));
  process.exit(0);
}
