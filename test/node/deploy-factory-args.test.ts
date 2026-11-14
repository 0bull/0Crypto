import { describe, expect, it } from "vitest";
import { parseDeployArgs } from "../../scripts/deploy-factory-args";

describe("parseDeployArgs", () => {
  it("parses chain, rpc and --dry-run", () => {
    expect(parseDeployArgs(["--chain", "base", "--rpc", "https://rpc.example/x"])).toEqual({ chain: "base", rpc: "https://rpc.example/x", dryRun: false });
    expect(parseDeployArgs(["--rpc", "http://127.0.0.1:8545", "--dry-run", "--chain", "polygon"])).toEqual({ chain: "polygon", rpc: "http://127.0.0.1:8545", dryRun: true });
  });
  it("rejects missing, unknown and malformed arguments", () => {
    expect(() => parseDeployArgs(["--rpc", "https://x"])).toThrow("--chain is required");
    expect(() => parseDeployArgs(["--chain", "base"])).toThrow("--rpc is required");
    expect(() => parseDeployArgs(["--chain", "solana", "--rpc", "https://x"])).toThrow("--chain must be one of");
    expect(() => parseDeployArgs(["--chain", "base", "--rpc", "ftp://x"])).toThrow("http(s)");
    expect(() => parseDeployArgs(["--chain", "base", "--rpc", "nope"])).toThrow("must be a URL");
    expect(() => parseDeployArgs(["--chain", "--rpc", "https://x"])).toThrow("--chain needs a value");
    expect(() => parseDeployArgs(["--chain", "base", "--rpc", "https://x", "--seed", "abandon"])).toThrow("unknown argument: --seed");
  });
  it("never echoes a positional argument (it could be a seed word)", () => {
    expect(() => parseDeployArgs(["--chain", "base", "--rpc", "https://x", "abandon"])).toThrow("unknown argument: (positional)");
  });
});
