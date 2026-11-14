import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      exclude: ["plugins/**", "test/node/**", "contracts/**", "node_modules/**", "tools/**", "site/**"],
      // The first test of each EVM-touching file cold-imports viem (3.7-4.9 s measured), close to vitest's 5 s default:
      // under load that first test timed out. 20 s leaves room without hiding a real hang for long.
      testTimeout: 20_000,
    },
    plugins: [
      {
        // The pool sends each test file a snapshot of its whole transformed import graph in ONE WebSocket message, and
        // workerd closes the socket (1009, "Message is too large") past 32 MiB. In a full run that graph reached ~33 MB,
        // ~70% of it inline source maps of dependencies (viem, noble, ...). Dropping dependency source maps keeps the
        // snapshot far below the limit; our own src/ and test/ keep theirs.
        name: "0crypto:no-dependency-sourcemaps",
        enforce: "post",
        transform(code: string, id: string) {
          if (id.includes("/node_modules/")) return { code, map: { mappings: "" } };
          return undefined;
        },
      },
      cloudflareTest({
        // A test-only config in a directory with no .dev.vars, so local dev values never leak into tests.
        wrangler: { configPath: "./test/wrangler.test.jsonc" },
        miniflare: {
          // Tests never reach the network: anything msw does not intercept fails loudly here.
          outboundService: (req: Request) => {
            console.error(`blocked outbound request in tests: ${new URL(req.url).origin}`);
            return new Response("outbound network disabled in tests", { status: 599 });
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789abcdef",
            // BIP39 test vector; tests derive in routed mode, which needs the custody opt-in.
            ALLOW_SEED_CUSTODY: "true",
            MASTER_SEED: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
          },
        },
      }),
    ],
  };
});
