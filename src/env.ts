import type { PaymentWatcher } from "./watcher/PaymentWatcher";

export type WebhookJob = { eventId: string };

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  WATCHER: DurableObjectNamespace<PaymentWatcher>;
  WEBHOOKS: Queue<WebhookJob>;
  ASSETS: Fetcher;
  API_RATE: RateLimit;
  PUBLIC_URL: string;
  ENABLED_ASSETS: string;
  MERCHANT_NAME?: string;
  /** Optional: blank on a fresh deploy. Chains that derive keys from it are disabled with "MASTER_SEED is not set". */
  MASTER_SEED?: string;
  SESSION_SECRET: string;
  WEBHOOK_SECRET: string;
  WEBHOOK_URL?: string;
  /** Comma-separated hostnames an invoice success_url may point to (settings, src/settings.ts). */
  SUCCESS_URL_HOSTS?: string;
  /** Optional secret: a setup code the owner chose at deploy time, for the first claim of /admin/setup. */
  ADMIN_SETUP_CODE?: string;
  /** Optional secret, set by the owner to recover the admin (/admin/recover): 32+ characters, each value works once. */
  ADMIN_RECOVERY_CODE?: string;
  COINGECKO_KEY?: string;
  /** "true" lets a UTXO chain without an xpub derive deposit addresses from MASTER_SEED (routed mode). */
  ALLOW_SEED_CUSTODY?: string;
  BTC_XPUB?: string;
  LTC_XPUB?: string;
  DOGE_XPUB?: string;
  /** First derivation index for the chain (default 0), for an xpub account used before. */
  BTC_XPUB_START_INDEX?: string;
  LTC_XPUB_START_INDEX?: string;
  DOGE_XPUB_START_INDEX?: string;
  BTC_ESPLORA_URL?: string;
  LTC_ESPLORA_URL?: string;
  DOGE_BLOCKBOOK_URL?: string;
  DOGE_API_KEY?: string;
  /**
   * Optional secrets: JSON-RPC URL(s) for the chain, comma-separated for fallbacks (secrets, not vars: the URLs usually
   * carry an API key). EVM assets need one plus ALLOW_SEED_CUSTODY.
   */
  /** Tron (secrets): TronGrid API key (required to enable Tron), optional endpoint override (https, default api.trongrid.io), TronSave key (sweeps only). */
  TRONGRID_API_KEY?: string;
  TRON_API_URL?: string;
  TRONSAVE_API_KEY?: string;
  /** Solana (secret): mainnet JSON-RPC URL(s), comma-separated https fallbacks (required to enable Solana). */
  SOLANA_RPC_URL?: string;
  /**
   * Lightning (secret): a NIP-47 Nostr Wallet Connect URI from the merchant's hosted wallet, created with receive-only
   * permissions (get_info, make_invoice, lookup_invoice). Its `secret` is a Nostr client key, used only in src/signing/nostr.ts.
   */
  NWC_URI?: string;
  /**
   * Test-only, never a binding: a fake relay's socket factory for code paths that build the Lightning adapter
   * themselves. Read only when it is a function (chains/lightning/adapter.ts testSocketFactory); deployed vars and
   * secrets are strings, so production ignores it.
   */
  NWC_TEST_SOCKET_FACTORY?: unknown;
  EVM_RPC_ETH?: string;
  EVM_RPC_BASE?: string;
  EVM_RPC_ARB?: string;
  EVM_RPC_POLYGON?: string;
  EVM_RPC_BSC?: string;
  /**
   * Privacy routing (vars). RAILGUN_0ZK_ADDRESS: the merchant's Railgun `0zk` address that EVM funds are shielded to
   * (never settable through the API or admin UI). RAILGUN_GOLDEN_OK: "1" only after the operator's live shield spike
   * (docs/railgun-spike.md) showed the funds in a real Railgun wallet; shielding refuses otherwise (the master switch).
   * RAILGUN_GOLDEN_OK_CHAINS: the EVM chains (comma list, e.g. "base,arb") whose own spike (and native wrap) passed;
   * shielding happens only on these, and only while RAILGUN_GOLDEN_OK is "1".
   */
  RAILGUN_0ZK_ADDRESS?: string;
  RAILGUN_GOLDEN_OK?: string;
  RAILGUN_GOLDEN_OK_CHAINS?: string;
  /**
   * Trocador (swaps non-EVM funds to XMR_ADDRESS). TROCADOR_API_KEY is a secret. TROCADOR_MIN_KYC (var, A-D, default "A") is
   * the worst KYC rating of a provider the gateway will use (A = no KYC, D = may hold funds). TROCADOR_LIVE_OK: "1" only
   * after the operator's live swap spike (docs/trocador-spike.md); trades refuse otherwise.
   */
  TROCADOR_API_KEY?: string;
  /**
   * The merchant's Monero address (var, never settable through the API or admin UI): standard (4...) or subaddress
   * (8...), mainnet, checked by validateXmrAddress. A route batch freezes it when it is created; its legs pay that.
   */
  XMR_ADDRESS?: string;
  TROCADOR_MIN_KYC?: string;
  TROCADOR_LIVE_OK?: string;
  /** Batch routing (vars, decimals as strings): minimum batch USD (200), delay window in hours (2..24), hot cap USD (5000). */
  ROUTE_MIN_BATCH_USD?: string;
  ROUTE_DELAY_MIN_H?: string;
  ROUTE_DELAY_MAX_H?: string;
  HOT_CAP_USD?: string;
}
