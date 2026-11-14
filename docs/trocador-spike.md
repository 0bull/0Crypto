# Trocador live spike (manual, operator only)

0Crypto swaps BTC, LTC, DOGE, Tron USDT, SOL and Solana USDC to XMR through Trocador (`src/routing/trocador.ts`). The client
was built from Trocador's public docs (trocador.app/docs, 2026-11-13), not from a live call, and several things are not
documented: the network strings for USDT-TRC20, SOL and USDC-Solana, the field names inside `quotes`, the error shape, and
whether booleans are JSON or `"True"` strings. So `trade()` refuses with `TrocadorNotVerified` until `TROCADOR_LIVE_OK=1`.
Quotes, status and minimums work without it. Set it only after this spike passes.

This spends real funds: a small swap (a few dollars) plus network and swap fees.

## Steps

1. **Get an API key** from Trocador (trocador.app, API section). Never put it in a URL, a commit or a chat. In production:
   `wrangler secret put TROCADOR_API_KEY`. Optionally set `TROCADOR_MIN_KYC` (A, B, C or D; default `A`: A = no KYC ... D = may
   hold your funds until verified) in `wrangler.jsonc` vars.
2. **Run one small real swap** from the repo root. The key is read from the environment only:

   ```sh
   TROCADOR_API_KEY=... npx tsx scripts/trocador-trade-once.ts --asset btc:btc --amount 0.0005 \
     --xmr "$XMR_ADDRESS" --i-understand-this-spends-real-funds
   ```

   Without the flag the script refuses. Without `--send` it only prints the `/coin` entries for all 7 coins (btc, ltc, doge, usdt,
   sol, usdc, xmr) and the quote; check them against the expected strings it prints (`TROCADOR_TICKERS` in
   `src/routing/trocador.ts`) and fix any ticker/network that differs (a mismatch shows as `TrocadorPairUnverified`). Add
   `--send` to create the trade: it prints the provider deposit address. **Sending is manual**: pay exactly that amount from
   your own wallet to the printed address. The script never signs and never uses gateway keys.
3. **Confirm XMR arrives** at `XMR_ADDRESS` (poll with the printed trade id; the quote's `amountTo` is the expected amount).
4. **Capture the real responses** (`/coin`, `new_rate`, `new_trade`, `trade`) into `test/fixtures/trocador/`, replacing the
   assumed files, with the API key redacted. Update `test/fixtures/trocador/README.md` (remove the ASSUMPTION marks) and fix the
   client wherever the real field names, error shape or booleans differ. Re-run `npm test`.
5. **Set `TROCADOR_LIVE_OK` to `"1"`** in the `vars` of `wrangler.jsonc` and deploy.

Memos: the gateway refuses any coin that needs a memo (`TrocadorPairUnverified`), including XMR.
