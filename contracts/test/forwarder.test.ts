import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import hre from "hardhat";
import {
  encodeAbiParameters, keccak256, getAddress, concatHex, encodeDeployData, getContractAddress,
  parseEther, zeroAddress, type Hex, type Address,
} from "viem";

const { viem } = await hre.network.create();
const { artifacts } = hre;
const publicClient = await viem.getPublicClient();
const testClient = await viem.getTestClient();
const [deployer, stranger] = await viem.getWalletClients();

const SINK_DEAD: Address = "0x000000000000000000000000000000000000dEaD";
const DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const DEPLOYER_CODEHASH = "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989";
// Runtime code of the deterministic deployer (Nick's factory); hash asserted below.
const DEPLOYER_CODE: Hex = `0x7f${"ff".repeat(31)}e03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3`;
const ZERO32: Hex = `0x${"00".repeat(32)}`;
const fixture = JSON.parse(readFileSync(new URL("../factory-initcode.json", import.meta.url), "utf8"));

const salt = (i: bigint): Hex => keccak256(encodeAbiParameters([{ type: "uint256" }], [i]));
const setBalance = (a: Address, v: bigint) => testClient.setBalance({ address: a, value: v });
const bal = (a: Address) => publicClient.getBalance({ address: a });
const hasCode = async (a: Address) => ((await publicClient.getCode({ address: a })) ?? "0x") !== "0x";
const rejectsWith = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => re.test(String(e.message) + String((e as any).cause?.message ?? "") + String((e as any).details ?? "")) || (console.error(e.message), false));

let sinkCounter = 0xbeef0000;
// The sink is the hot wallet: a fresh impersonated EOA per test, funded for gas. Only it may sweep.
async function setup() {
  const sink = getAddress(`0x${(++sinkCounter).toString(16).padStart(40, "0")}`);
  await testClient.impersonateAccount({ address: sink });
  await setBalance(sink, parseEther("100"));
  const sinkWallet = await viem.getWalletClient(sink);
  const factory = await viem.deployContract("ForwarderFactory", [sink]);
  const usdc = await viem.deployContract("MockERC20");
  const usdt = await viem.deployContract("MockUSDT");
  /** deployAndFlush sent by the sink; returns the receipt and the gas fee the sink paid. */
  const sweep = async (salts: Hex[], tokens: Address[]) => {
    const hash = await factory.write.deployAndFlush([salts, tokens], { account: sinkWallet.account });
    const receipt = await publicClient.getTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return { receipt, fee: receipt.gasUsed * receipt.effectiveGasPrice };
  };
  /** Native the sink received from one sweep, net of the gas it paid for it. */
  const sinkGain = async (salts: Hex[], tokens: Address[]) => {
    const before = await bal(sink);
    const { fee } = await sweep(salts, tokens);
    return (await bal(sink)) - before + fee;
  };
  return { sink, sinkWallet, factory, usdc, usdt, sweep, sinkGain };
}

describe("ForwarderFactory", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { s = await setup(); });

  it("predict matches deploy", async () => {
    const p = await s.factory.read.predict([salt(1n)]);
    assert.equal(await hasCode(p), false);
    await s.sweep([salt(1n)], []);
    assert.equal(await hasCode(p), true);
  });

  it("a clone reads the factory's sink and the factory itself through delegatecall", async () => {
    await s.sweep([salt(12n)], []);
    const f = await viem.getContractAt("Forwarder", await s.factory.read.predict([salt(12n)]));
    assert.equal(getAddress(await f.read.sink()), s.sink);
    assert.equal(getAddress(await f.read.factory()), getAddress(s.factory.address));
    assert.equal(getAddress(await s.factory.read.sink()), s.sink);
  });

  it("only the sink may call deployAndFlush", async () => {
    const p = await s.factory.read.predict([salt(20n)]);
    await s.usdc.write.mint([p, 50n]);
    await setBalance(p, 4n);
    await rejectsWith(s.factory.write.deployAndFlush([[salt(20n)], [s.usdc.address]], { account: stranger.account }), /only sink/);
    await rejectsWith(s.factory.write.deployAndFlush([[salt(20n)], [s.usdc.address]], { account: deployer.account }), /only sink/);
    assert.equal(await hasCode(p), false);
    assert.equal(await s.usdc.read.balanceOf([p]), 50n);
    assert.equal(await bal(p), 4n);
  });

  it("nobody but the factory may call flush on a deployed clone (not even the sink)", async () => {
    await s.sweep([salt(21n)], []);
    const p = await s.factory.read.predict([salt(21n)]);
    await s.usdc.write.mint([p, 42n]);
    await setBalance(p, 3n);
    const f = await viem.getContractAt("Forwarder", p);
    await rejectsWith(f.write.flush([[s.usdc.address]], { account: stranger.account }), /only factory/);
    await rejectsWith(f.write.flush([[s.usdc.address]], { account: s.sinkWallet.account }), /only factory/);
    assert.equal(await s.usdc.read.balanceOf([p]), 42n);
    assert.equal(await bal(p), 3n);
    assert.equal(await s.sinkGain([salt(21n)], [s.usdc.address]), 3n);
    assert.equal(await s.usdc.read.balanceOf([s.sink]), 42n);
  });

  it("a forwarder cloned by an attacker from our implementation cannot be flushed by the attacker; as our factory it pays our sink", async () => {
    const impl = (await s.factory.read.implementation()).slice(2).toLowerCase();
    const initcode: Hex = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`;
    const hash = await stranger.sendTransaction({ data: initcode });
    const clone = (await publicClient.getTransactionReceipt({ hash })).contractAddress!;
    await s.usdc.write.mint([clone, 99n]);
    await setBalance(clone, 5n);
    const f = await viem.getContractAt("Forwarder", clone);
    assert.equal(getAddress(await f.read.factory()), getAddress(s.factory.address));
    await rejectsWith(f.write.flush([[s.usdc.address]], { account: stranger.account }), /only factory/);
    assert.equal(await s.usdc.read.balanceOf([clone]), 99n);
    assert.equal(await bal(clone), 5n);
    // The factory has no entry point for foreign clones; acting as it shows the clone obeys it and pays our sink.
    await testClient.impersonateAccount({ address: s.factory.address });
    await setBalance(s.factory.address, parseEther("1"));
    const asFactory = await viem.getWalletClient(s.factory.address);
    const sinkBefore = await bal(s.sink);
    await f.write.flush([[s.usdc.address]], { account: asFactory.account });
    await testClient.stopImpersonatingAccount({ address: s.factory.address });
    assert.equal(await s.usdc.read.balanceOf([s.sink]), 99n);
    assert.equal((await bal(s.sink)) - sinkBefore, 5n);
    assert.equal(await bal(clone), 0n);
    assert.equal(await s.usdc.read.balanceOf([stranger.account.address]), 0n);
  });

  it("rejects a zero sink (factory and forwarder)", async () => {
    await rejectsWith(viem.deployContract("ForwarderFactory", [zeroAddress]), /zero sink/);
    await rejectsWith(viem.deployContract("Forwarder", [zeroAddress]), /zero sink/);
  });

  it("reverts \"native send failed\" when the sink rejects native, leaving the funds in place", async () => {
    const rejecting = await viem.deployContract("RejectingSink");
    const factory = await viem.deployContract("ForwarderFactory", [rejecting.address]);
    const p = await factory.read.predict([salt(22n)]);
    await s.usdc.write.mint([p, 10n]);
    // Token only: nothing native to send, so the contract sink can sweep.
    await rejecting.write.sweep([factory.address, [salt(22n)], [s.usdc.address]]);
    assert.equal(await s.usdc.read.balanceOf([rejecting.address]), 10n);
    await s.usdc.write.mint([p, 6n]);
    await setBalance(p, 1n);
    await rejectsWith(rejecting.write.sweep([factory.address, [salt(22n)], [s.usdc.address]]), /native send failed/);
    assert.equal(await bal(p), 1n);
    assert.equal(await s.usdc.read.balanceOf([p]), 6n);
  });

  it("flush sends native and tokens (incl. no-return USDT) to sink", async () => {
    const p = await s.factory.read.predict([salt(2n)]);
    await s.usdc.write.mint([p, 1000n]);
    await s.usdt.write.mint([p, 500n]);
    await setBalance(p, parseEther("1"));
    assert.equal(await s.sinkGain([salt(2n)], [s.usdc.address, s.usdt.address]), parseEther("1"));
    assert.equal(await s.usdc.read.balanceOf([s.sink]), 1000n);
    assert.equal(await s.usdt.read.balanceOf([s.sink]), 500n);
    assert.equal(await s.usdc.read.balanceOf([p]), 0n);
    assert.equal(await bal(p), 0n);
  });

  it("emits Flushed per non-zero transfer, address(0) for native", async () => {
    const p = await s.factory.read.predict([salt(3n)]);
    await s.usdc.write.mint([p, 7n]);
    await setBalance(p, 2n);
    const { receipt: r } = await s.sweep([salt(3n)], [s.usdc.address, s.usdt.address]);
    const f = await viem.getContractAt("Forwarder", p);
    const logs = await publicClient.getContractEvents({
      address: p, abi: f.abi, eventName: "Flushed", fromBlock: r.blockNumber, toBlock: r.blockNumber,
    });
    assert.equal(logs.length, 2);
    assert.equal(getAddress(logs[0].args.token!), zeroAddress);
    assert.equal(logs[0].args.amount, 2n);
    assert.equal(getAddress(logs[1].args.token!), getAddress(s.usdc.address));
    assert.equal(logs[1].args.amount, 7n);
    assert.equal(getAddress(logs[0].args.forwarder!), getAddress(p));
  });

  it("deployAndFlush is idempotent: second call flushes new balance", async () => {
    const p = await s.factory.read.predict([salt(8n)]);
    await s.usdc.write.mint([p, 10n]);
    await s.sweep([salt(8n)], [s.usdc.address]);
    assert.equal(await s.usdc.read.balanceOf([s.sink]), 10n);
    await s.usdc.write.mint([p, 5n]);
    await setBalance(p, 9n);
    assert.equal(await s.sinkGain([salt(8n)], [s.usdc.address]), 9n);
    assert.equal(await s.usdc.read.balanceOf([s.sink]), 15n);
  });

  it("ETH sent to the predicted address before deployment is flushed on deploy", async () => {
    const p = await s.factory.read.predict([salt(9n)]);
    await deployer.sendTransaction({ to: p, value: parseEther("4") });
    assert.equal(await hasCode(p), false);
    assert.equal(await s.sinkGain([salt(9n)], []), parseEther("4"));
    assert.equal(await bal(p), 0n);
  });

  it("gas: cold first sweep (sink holds 0 of the token) < 120,000; warm is lower", async () => {
    const p = await s.factory.read.predict([salt(10n)]);
    await s.usdc.write.mint([p, 1000n]);
    assert.equal(await s.usdc.read.balanceOf([s.sink]), 0n);
    const cold = (await s.sweep([salt(10n)], [s.usdc.address])).receipt.gasUsed;
    const p2 = await s.factory.read.predict([salt(13n)]);
    await s.usdc.write.mint([p2, 1000n]); // sink now holds the token: warm slot
    const warm = (await s.sweep([salt(13n)], [s.usdc.address])).receipt.gasUsed;
    console.log("deployAndFlush one token gas cold/warm:", cold, warm);
    assert.ok(cold < 120_000n, `cold gas ${cold}`);
    assert.ok(warm < cold, `warm ${warm} !< cold ${cold}`);
  });

  it("compiled factory creation bytecode equals the committed fixture", async () => {
    const art = await artifacts.readArtifact("ForwarderFactory");
    assert.equal(art.bytecode, fixture.initcodeWithoutArgs);
    assert.equal(keccak256(art.bytecode as Hex), fixture.initcodeWithoutArgsHash);
    assert.equal(fixture.solc, "0.8.28");
    assert.equal(fixture.evmVersion, "cancun");
    assert.equal(fixture.optimizerRuns, 200);
  });

  it("factory build-info input holds only the factory, forwarder and their OpenZeppelin imports", async () => {
    const buildInfo = JSON.parse(readFileSync((await artifacts.getBuildInfoPath((await artifacts.readArtifact("ForwarderFactory")).buildInfoId!))!, "utf8"));
    const sources = Object.keys(buildInfo.input.sources);
    assert.ok(sources.some((x) => x.endsWith("contracts/src/ForwarderFactory.sol")), sources.join());
    assert.ok(sources.some((x) => x.endsWith("contracts/src/Forwarder.sol")), sources.join());
    for (const x of sources) {
      assert.ok(/contracts\/src\/(Forwarder|ForwarderFactory)\.sol$/.test(x) || x.includes("@openzeppelin/contracts"), `unexpected source ${x}`);
    }
    assert.ok(!sources.some((x) => x.includes("mocks") || x.includes("Mocks")), sources.join());
  });

  it("printPredict7: production factory address via deterministic deployer, salt 0", async () => {
    await testClient.setCode({ address: DEPLOYER, bytecode: DEPLOYER_CODE });
    assert.equal(keccak256(DEPLOYER_CODE), DEPLOYER_CODEHASH);
    const initCode = encodeDeployData({ abi: s.factory.abi, bytecode: fixture.initcodeWithoutArgs, args: [SINK_DEAD] });
    const expected = getContractAddress({ opcode: "CREATE2", from: DEPLOYER, salt: ZERO32, bytecode: initCode });
    const hash = await deployer.sendTransaction({ to: DEPLOYER, data: concatHex([ZERO32, initCode]) });
    console.log("factory deploy gas (via deterministic deployer):", (await publicClient.getTransactionReceipt({ hash })).gasUsed);
    assert.equal(await hasCode(expected), true);
    const f = await viem.getContractAt("ForwarderFactory", expected);
    assert.equal(getAddress(await f.read.sink()), getAddress(SINK_DEAD));
    const impl = await viem.getContractAt("Forwarder", await f.read.implementation());
    assert.equal(getAddress(await impl.read.factory()), getAddress(expected));
    const p7 = await f.read.predict([salt(7n)]);
    console.log("factory:", expected);
    console.log("predict7:", p7);
    assert.equal(getAddress(expected), getAddress(fixture.pins.sinkDead.factory));
    assert.equal(getAddress(p7), getAddress(fixture.pins.sinkDead.predict7));
  });
});
