import { defineConfig } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";

export default defineConfig({
  plugins: [hardhatViem, hardhatNodeTestRunner],
  // Test mocks live outside src/ and are compiled for tests only. `isolated` gives every file its own
  // compile job with just its dependencies, so mocks never share the factory's solc input.
  paths: { sources: ["./contracts/src", "./contracts/test/mocks"], tests: { nodejs: "./contracts/test" } },
  solidity: {
    version: "0.8.28",
    isolated: true,
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      metadata: { bytecodeHash: "none", appendCBOR: false },
    },
  },
});
