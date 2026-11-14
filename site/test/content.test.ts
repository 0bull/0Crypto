import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

export const PAGES: { slug: string; task: boolean }[] = [
  { slug: "index", task: false },
  { slug: "deploy", task: true },
  { slug: "setup-code", task: true },
  { slug: "passkey", task: true },
  { slug: "wallet", task: true },
  { slug: "first-payment", task: true },
  { slug: "webhooks", task: true },
  { slug: "sell-online/woocommerce", task: true },
  { slug: "sell-online/payment-links", task: true },
  { slug: "sell-online/api", task: true },
  { slug: "point-of-sale", task: true },
  { slug: "recurring", task: true },
  { slug: "custom-domain", task: true },
  { slug: "advanced/routed-mode", task: true },
  { slug: "advanced/evm-tron-solana", task: true },
  { slug: "advanced/lightning", task: true },
  { slug: "advanced/privacy-routing", task: true },
  { slug: "security", task: false },
  { slug: "upgrading", task: true },
  { slug: "troubleshooting", task: false },
];

const DIR = new URL("../src/content/docs/docs/", import.meta.url);
const read = (slug: string) => readFileSync(new URL(`${slug}.mdx`, DIR), "utf8");
const frontmatter = (src: string) => /^---\n([\s\S]*?)\n---/.exec(src)?.[1] ?? "";

describe.each(PAGES)("docs page $slug", ({ slug, task }) => {
  it("exists with title and description", () => {
    expect(existsSync(new URL(`${slug}.mdx`, DIR))).toBe(true);
    const fm = frontmatter(read(slug));
    expect(fm).toMatch(/^title: .+/m);
    expect(fm).toMatch(/^description: .+/m);
  });
  if (task) {
    it("ends with a success check", () => {
      expect(read(slug)).toContain(":::tip[You should now see]");
    });
  }
  it("has no old-flow wording", () => {
    expect(read(slug)).not.toMatch(/paygate|\bTOTP\b|authenticator app|admin password/i);
  });
});

describe("page specifics", () => {
  it("setup-code states the code facts", () => {
    const s = read("setup-code");
    for (const t of ["6 words", "60 minutes", "Workers & Pages", "wrangler tail", "Print a new code"]) {
      expect(s).toContain(t);
    }
  });
  it("setup-code warns that the code is secret", () => {
    expect(read("setup-code")).toMatch(/Anyone who has a live code can claim your gateway/);
    expect(read("index")).not.toContain("Nothing here asks you to type a secret");
  });
  it("wallet has the three wallet tabs", () => {
    const s = read("wallet");
    for (const t of ["Sparrow", "Electrum", "BlueWallet", "Menu names can differ by version"]) {
      expect(s).toContain(t);
    }
  });
  it("deploy uses DEPLOY_URL from site config and names the paid plan", () => {
    const s = read("deploy");
    expect(s).toMatch(/import \{[^}]*DEPLOY_URL[^}]*\} from ["'][^"']*site\.config/);
    expect(s).toContain("{DEPLOY_URL}");
    expect(s).toContain("Workers Paid");
    expect(s).not.toContain("deploy.workers.cloudflare.com");
  });
  it("deploy has a by-hand section with the real commands, and honest plan reasons", () => {
    const s = read("deploy");
    for (const t of ["## Deploy by hand (developers)", "npm ci", "npx wrangler login", "npm run deploy:first", "/admin"]) {
      expect(s).toContain(t);
    }
    expect(s).not.toMatch(/only exist on the paid plan/);
  });
  it("routed-mode does not overclaim or point at the dashboard for ALLOW_SEED_CUSTODY", () => {
    const s = read("advanced/routed-mode");
    expect(s).not.toContain("only terminal command");
    expect(s).not.toContain("Cloudflare's own settings screen");
    expect(s).toContain("not in the Cloudflare dashboard");
  });
  it("tron numbers match the code (0.5 TRX top-up, 2 TRX minimum)", () => {
    const s = read("advanced/evm-tron-solana");
    expect(s).toContain("0.5 TRX");
    expect(s).not.toContain("2 TRX per new deposit");
  });
  it("passkey quotes the real last-passkey text", () => {
    expect(read("passkey")).toContain("You can't remove your only passkey");
  });
  it("security states the privacy trade-off", () => {
    const s = read("security");
    for (const t of ["hot wallet", "merge", "reduces"]) expect(s).toContain(t);
  });
  it("custom-domain has the recovery heading text", () => {
    expect(read("custom-domain")).toContain("Lost your passkey or moved to a new domain?");
  });
  it("troubleshooting has the three headings", () => {
    const s = read("troubleshooting");
    for (const t of ["I can't find the setup code", "My browser doesn't offer a passkey", "A coin is greyed out"]) {
      expect(s).toMatch(new RegExp(`^#{2,3} ${t}`, "m"));
    }
  });
  it("webhooks names the secret prefix and header", () => {
    const s = read("webhooks");
    expect(s).toContain("whsec_");
    expect(s).toContain("0Crypto-Signature");
  });
  it("lightning says receive-only", () => {
    expect(read("advanced/lightning")).toContain("receive-only");
  });
  it("routed mode states the seed command and opt-in", () => {
    const s = read("advanced/routed-mode");
    expect(s).toContain('"ALLOW_SEED_CUSTODY": "true"');
    expect(s).toMatch(/no watch mode/i);
  });
  it("curl examples live only on the API page", () => {
    for (const { slug } of PAGES) {
      if (slug === "sell-online/api") continue;
      expect(read(slug), slug).not.toMatch(/curl /);
    }
  });
  it("keys and plugin use the 0Crypto names", () => {
    expect(read("sell-online/api")).toContain("0c_live_");
    expect(read("sell-online/woocommerce")).toContain("0crypto-woocommerce");
    expect(read("sell-online/woocommerce")).toContain("/wp-json/0crypto/v1/webhook");
  });
});

describe("labels confirmed against the gateway code", () => {
  it("setup-code uses the exact log line and button labels", () => {
    const s = read("setup-code");
    for (const t of ["0crypto setup code:", "Print a new code", "Setup code (6 words)", "Where to find the code", "Too many wrong codes. Wait 10 minutes and try again."]) {
      expect(s).toContain(t);
    }
  });
  it("passkey and custom-domain use the exact recovery link text and log line", () => {
    for (const slug of ["passkey", "custom-domain", "troubleshooting"]) {
      expect(read(slug), slug).toContain("Lost your passkey or moved to a new domain?");
    }
    expect(read("passkey")).toContain("0crypto recovery code:");
    expect(read("custom-domain")).toContain("This will move your gateway to");
    expect(read("passkey")).toContain("Create passkey");
  });
  it("wizard and developers labels match the admin", () => {
    const w = read("first-payment") + read("webhooks");
    for (const t of ["Reveal secret", "Send test event", "Create a $1 test invoice", "Save webhook URL", "API keys & webhooks"]) {
      expect(w).toContain(t);
    }
    expect(read("wallet")).toContain("Start index");
    expect(read("wallet")).toContain("Save wallets and coins");
  });
  it("webhooks lists the confirmed events and retry facts", () => {
    const s = read("webhooks");
    for (const t of ["refund.approved", "webhook.test", "20 times", "Rotate secret"]) expect(s).toContain(t);
  });
  it("payment links state the real budgets and the POS uses its real button", () => {
    expect(read("sell-online/payment-links")).toContain("each link 10 invoices a minute, and all links together 40 a minute");
    expect(read("point-of-sale")).toContain("Open the POS");
  });
  it("hedges about our own UI labels are gone", () => {
    for (const slug of ["webhooks", "setup-code", "passkey", "first-payment"]) {
      expect(read(slug), slug).not.toMatch(/names may differ by version/i);
    }
    const wallet = read("wallet").replace(/<TabItem[\s\S]*?<\/TabItem>/g, "");
    expect(wallet).not.toMatch(/names may differ by version/i);
  });
});

describe("fix round 1 pins", () => {
  it("code-cap wording", () => {
    for (const slug of ["setup-code", "troubleshooting"]) {
      expect(read(slug), slug).toContain("cancels the oldest");
      expect(read(slug), slug).not.toContain("never cancels");
    }
    expect(read("setup-code")).toContain("5 tries");
    expect(read("troubleshooting")).toContain("5 wrong tries");
  });
  it("passkey and security labels", () => {
    expect(read("passkey")).toContain("Passkey 1");
    expect(read("security")).toContain("Sign out everywhere");
  });
  it("woocommerce plugin field titles", () => {
    const s = read("sell-online/woocommerce");
    for (const t of ["0Crypto (crypto)", "Enable 0Crypto", "Gateway URL", "API key", "Webhook secret"]) expect(s).toContain(t);
  });
  it("webhooks retry facts", () => {
    const s = read("webhooks");
    expect(s).toContain("webhook.dead");
    expect(s).toContain("about a minute at first");
  });
});
