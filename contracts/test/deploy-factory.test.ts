import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { parseEther, type Hex, type Address } from "viem";
import { assertChainId, deployFactory } from "../../scripts/deploy-factory-lib";
import { DETERMINISTIC_DEPLOYER, factoryAddress } from "../../src/chains/evm/predict";

const { viem } = await hre.network.create();
const publicClient = await viem.getPublicClient();
const testClient = await viem.getTestClient();
const [wallet] = await viem.getWalletClients();

// Runtime code of the deterministic deployer (Nick's factory), as in forwarder.test.ts.
const DEPLOYER_CODE: Hex = `0x7f${"ff".repeat(31)}e03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3`;
const hasCode = async (a: Address) => ((await publicClient.getCode({ address: a })) ?? "0x") !== "0x";
const sink = wallet!.account.address;

describe("deployFactory", () => {
  it("throws a clear error when the deterministic deployer has no code, and sends nothing", async () => {
    await testClient.setCode({ address: DETERMINISTIC_DEPLOYER, bytecode: "0x" });
    const nonce = await publicClient.getTransactionCount({ address: sink });
    await assert.rejects(deployFactory({ walletClient: wallet!, publicClient, sink }), /deterministic deployer .* no code/);
    assert.equal(await hasCode(factoryAddress(sink)), false);
    assert.equal(await publicClient.getTransactionCount({ address: sink }), nonce);
  });

  it("assertChainId rejects a different chain, and deployFactory with expectedChainId sends nothing on a mismatch", async () => {
    const id = await publicClient.getChainId();
    await assertChainId(publicClient, id);
    await assert.rejects(assertChainId(publicClient, 8453), new RegExp(`chain id ${id}, expected 8453`));
    await testClient.setCode({ address: DETERMINISTIC_DEPLOYER, bytecode: DEPLOYER_CODE });
    const other: Address = "0x00000000000000000000000000000000000b0b0b";
    const nonce = await publicClient.getTransactionCount({ address: sink });
    await assert.rejects(deployFactory({ walletClient: wallet!, publicClient, sink: other, expectedChainId: 8453 }), /expected 8453/);
    assert.equal(await hasCode(factoryAddress(other)), false);
    assert.equal(await publicClient.getTransactionCount({ address: sink }), nonce);
  });

  it("deploys at factoryAddress(sink), then reports already-deployed without sending", async () => {
    await testClient.setCode({ address: DETERMINISTIC_DEPLOYER, bytecode: DEPLOYER_CODE });
    await testClient.setBalance({ address: sink, value: parseEther("10") });
    const expected = factoryAddress(sink);
    assert.equal(await hasCode(expected), false);

    const events: string[] = [];
    const sent: Hex[] = [];
    const waiting = publicClient.waitForTransactionReceipt.bind(publicClient);
    const spied = { ...publicClient, waitForTransactionReceipt: async (a: Parameters<typeof waiting>[0]) => { events.push("wait"); const r = await waiting(a); events.push("receipt"); return r; } } as typeof publicClient;
    const first = await deployFactory({ walletClient: wallet!, publicClient: spied, sink, expectedChainId: await publicClient.getChainId(), onSent: (h) => { sent.push(h); events.push("sent"); } });
    assert.deepEqual(sent, [first.txHash]);
    assert.deepEqual(events, ["sent", "wait", "receipt"]); // the hash is reported before the receipt is awaited
    assert.equal(first.status, "deployed");
    assert.equal(first.address, expected);
    assert.match(first.txHash ?? "", /^0x[0-9a-f]{64}$/);
    assert.equal(await hasCode(expected), true);

    const nonce = await publicClient.getTransactionCount({ address: sink });
    const second = await deployFactory({ walletClient: wallet!, publicClient, sink });
    assert.deepEqual(second, { address: expected, status: "already-deployed" });
    assert.equal(await publicClient.getTransactionCount({ address: sink }), nonce);
  });
});
