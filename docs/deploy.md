# Deploying 0Crypto

The deploy guide lives on the docs site, so there is one source. Read these pages in `site/src/content/docs/docs/` (there is no public docs domain yet; run `cd site && npm ci && npm run dev` to read them locally):

- Deploy: [`deploy.mdx`](../site/src/content/docs/docs/deploy.mdx)
- Setup code: [`setup-code.mdx`](../site/src/content/docs/docs/setup-code.mdx)
- Routed mode: [`advanced/routed-mode.mdx`](../site/src/content/docs/docs/advanced/routed-mode.mdx), with [EVM, Tron and Solana](../site/src/content/docs/docs/advanced/evm-tron-solana.mdx), [Lightning](../site/src/content/docs/docs/advanced/lightning.mdx) and [privacy routing](../site/src/content/docs/docs/advanced/privacy-routing.mdx)
- Upgrading: [`upgrading.mdx`](../site/src/content/docs/docs/upgrading.mdx)

## Operator notes

Command-line detail that the docs site intentionally leaves out.

- **Manual first deploy.** `npm run deploy:first` is `wrangler deploy && wrangler d1 migrations apply DB --remote`: on a fresh CLI install the database does not exist until the first deploy creates it, so the Worker goes first. Until the migrations land, admin pages show the generic error page; nobody holds a setup code yet, so nothing can be claimed early. Every later deploy is `npm run deploy` (migrations first, then the Worker).
- **Dry run.** `npx wrangler deploy --dry-run --outdir dist` builds the bundle and lists the bindings without deploying (what CI checks).
- **EVM factory.** Run once per chain, dry run first. The seed is read from stdin only (`scripts/deploy-factory.ts`); never put it on the command line:

  ```sh
  op read "op://Vault/0crypto/MASTER_SEED" | npm run deploy:factory -- --chain base --rpc https://... --dry-run
  ```

  Compare the printed hot wallet with the one on the admin page "Wallets", fund it with native gas (about 620,000 gas), then run again without `--dry-run`. `--chain` is one of `eth`, `base`, `arb`, `polygon`, `bsc`. Running it again is safe ("already deployed").
- **Privacy routing live gates.** Leave `RAILGUN_GOLDEN_OK`, `RAILGUN_GOLDEN_OK_CHAINS` and `TROCADOR_LIVE_OK` empty until the matching spike has shown funds arriving in your own wallet: [railgun-spike.md](railgun-spike.md) (`scripts/railgun-shield-once.ts`; each EVM chain needs its own spike) and [trocador-spike.md](trocador-spike.md) (`scripts/trocador-trade-once.ts`).
- **Before upgrading.** Back up the database (`npx wrangler d1 export DB --remote --output backup-$(date +%F).sql`), then check that every stored JSON column parses. Each query must return no rows; if one does, fix or clear that value first:

  ```sh
  npx wrangler d1 execute DB --remote --command "SELECT id FROM invoices WHERE (metadata IS NOT NULL AND json_valid(metadata)=0) OR (allowed_assets IS NOT NULL AND json_valid(allowed_assets)=0)"
  npx wrangler d1 execute DB --remote --command "SELECT id FROM events WHERE json_valid(payload)=0"
  npx wrangler d1 execute DB --remote --command "SELECT id FROM payments WHERE unexpected IS NOT NULL AND json_valid(unexpected)=0"
  npx wrangler d1 execute DB --remote --command "SELECT id FROM route_batches WHERE json_valid(legs)=0"
  npx wrangler d1 execute DB --remote --command "SELECT id FROM links WHERE allowed_assets IS NOT NULL AND json_valid(allowed_assets)=0"
  npx wrangler d1 execute DB --remote --command "SELECT id FROM subscriptions WHERE metadata IS NOT NULL AND json_valid(metadata)=0"
  ```

  The `links` and `subscriptions` tables exist from migration 0018 on; skip those two queries on an older database. D1 backups cannot recover funds; the seed can. Do not change `MASTER_SEED` on a live deployment.
- **Migrations.** `npx wrangler d1 migrations list DB --remote` shows what is pending. Never edit a migration that has been applied anywhere; add a new one.
