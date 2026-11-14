import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { REPO_URL } from "./src/site.config.ts";

export default defineConfig({
  // Every inlined <style> needs its own hash in the one-line CSP header (Cloudflare caps a
  // _headers line at 2000 chars), so stylesheets always ship as files.
  build: { inlineStylesheets: "never" },
  integrations: [
    starlight({
      title: "0Crypto Docs",
      social: [{ icon: "github", label: "GitHub", href: REPO_URL }],
      customCss: [
        "@fontsource/archivo/latin-800.css",
        "@fontsource/inter/latin-400.css",
        "@fontsource/inter/latin-500.css",
        "@fontsource/inter/latin-600.css",
        "@fontsource/jetbrains-mono/latin-400.css",
        "@fontsource/jetbrains-mono/latin-500.css",
        "./src/styles/tokens.css",
        "./src/styles/starlight.css",
      ],
      components: {
        ThemeProvider: "./src/components/overrides/ThemeProvider.astro",
        ThemeSelect: "./src/components/overrides/ThemeSelect.astro",
      },
      sidebar: [
        {
          label: "Get started",
          items: [
            { slug: "docs" },
            { slug: "docs/deploy" },
            { slug: "docs/setup-code" },
            { slug: "docs/passkey" },
            { slug: "docs/wallet" },
            { slug: "docs/first-payment" },
          ],
        },
        {
          label: "Get paid",
          items: [
            { slug: "docs/webhooks" },
            { slug: "docs/sell-online/woocommerce" },
            { slug: "docs/sell-online/payment-links" },
            { slug: "docs/sell-online/api" },
            { slug: "docs/point-of-sale" },
            { slug: "docs/recurring" },
          ],
        },
        {
          label: "Your gateway",
          items: [
            { slug: "docs/custom-domain" },
            { slug: "docs/security" },
            { slug: "docs/upgrading" },
            { slug: "docs/troubleshooting" },
          ],
        },
        {
          label: "Advanced",
          items: [
            { slug: "docs/advanced/routed-mode" },
            { slug: "docs/advanced/evm-tron-solana" },
            { slug: "docs/advanced/lightning" },
            { slug: "docs/advanced/privacy-routing" },
          ],
        },
      ],
    }),
  ],
});
