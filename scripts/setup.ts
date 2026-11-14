// Generates 0Crypto's optional MASTER_SEED (routed mode only; --only also accepts SESSION_SECRET and WEBHOOK_SECRET) and sets it with `wrangler secret put`.
// Usage: npx tsx scripts/setup.ts [--dry-run] [--env <name>] [--only <NAME>] [--force]
// Values go to wrangler's stdin only; nothing is written to disk.
import { spawn } from "node:child_process";
import {
  generateSecrets,
  isWorkerMissing,
  parseArgs,
  parseSecretList,
  planSecrets,
  planSetup,
  summarize,
  wranglerArgs,
  type SecretName,
} from "./setup-lib";

function putSecret(name: SecretName, value: string, env?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", wranglerArgs(name, env), { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", reject);
    // An early wrangler exit closes stdin; the exit code below carries the real failure.
    child.stdin.on("error", () => {});
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`wrangler secret put ${name} exited with ${code}`))));
    child.stdin.end(value);
  });
}

/** Names of secrets already on the Worker. A Worker that does not exist yet has none. */
function listSecrets(env?: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const args = ["wrangler", "secret", "list", "--format", "json", ...(env ? ["--env", env] : [])];
    const child = spawn("npx", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        try {
          resolve(parseSecretList(out));
        } catch (e) {
          reject(e);
        }
      } else if (isWorkerMissing(out + err)) resolve([]);
      else reject(new Error(`wrangler secret list failed (exit ${code}): ${(err || out).trim().slice(0, 500)}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    console.log("Dry run: would set these secrets (nothing is generated or sent):");
    for (const { name, value } of planSecrets()) if (!args.only || args.only === name) console.log(`  ${name} = ${value}`);
    return;
  }

  const plan = planSetup(await listSecrets(args.env), args);
  if (plan.action === "abort") {
    console.error(plan.message);
    process.exit(1);
  }
  if (plan.overwrites.length > 0) {
    console.warn("!!! --force: replacing " + plan.overwrites.join(", ") + ".");
    if (plan.overwrites.includes("MASTER_SEED"))
      console.warn("!!! Replacing MASTER_SEED orphans any funds at addresses derived from the old seed.");
  }

  const secrets = generateSecrets();
  const line = "==================================================================";
  if (plan.names.includes("MASTER_SEED")) {
    console.log(`${line}\n  Write these 24 words down offline. Anyone with them controls\n  received funds. They are not stored anywhere.\n${line}`);
    console.log(secrets.MASTER_SEED);
    console.log(`${line}\n`);
  }
  if (plan.names.includes("WEBHOOK_SECRET")) {
    console.log(`WEBHOOK_SECRET=${secrets.WEBHOOK_SECRET}`);
    console.log("Configure this on your server to verify webhooks (0Crypto-Signature). It won't be shown again.\n");
  }

  const done: SecretName[] = [];
  const failed: SecretName[] = [];
  for (const name of plan.names) {
    console.log(`Setting ${name}...`);
    try {
      await putSecret(name, secrets[name], args.env);
      done.push(name);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      failed.push(name);
    }
  }
  if (failed.length > 0) {
    console.error("\n" + summarize(done, failed));
    process.exit(1);
  }
  console.log("\nDone. Next: npm run deploy, open your gateway and enter the setup code from the Worker logs.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
