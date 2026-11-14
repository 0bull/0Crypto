# Trocador fixtures

**ASSUMPTION: built from docs, not captured live.** Source: trocador.app/docs, fetched 2026-11-13 (the page was served
as HTTP 503 but rendered in a browser; notes taken by the controller). Every JSON file here carries
`"_ASSUMPTION": "built from docs, not captured live"` and is invented from the documented field lists, not from a real
call (no API key was available). Replace them with real captures, key redacted, in spike step 4 of `docs/trocador-spike.md`.

Base `https://api.trocador.app/`, header `API-Key: <key>`. Most methods are GET; `new_rate`, `new_trade`, `validateaddress` also POST.
The client uses GET with query parameters.

## Documented

- **Coin listing**: `GET /coins`, `GET /coin?ticker=btc` (or `?name=Bitcoin`). Fields: `name, ticker, network, memo ("True"/"False"), image, minimum, maximum`.
  `/coin` returns a list when several coins share a ticker. Use tickers and networks exactly as returned.
- **new_rate**: params `ticker_from, network_from, ticker_to, network_to` (mandatory), `amount_from` (standard swap) or `amount_to` (payment),
  `payment` (True/False), `min_kycrating` (A|B|C|D), `markup`, `best_only`. Result: `trade_id` (the rate id for new_trade), `date, ticker_from, ticker_to,
  coin_from, coin_to, network_from, network_to, amount_from, amount_to, provider` (best), `fixed, status, quotes` (other quotes with KYC rating and waste/spread %), `payment`.
- **new_trade**: params `id` (rate id, optional), `ticker_from, network_from, ticker_to, network_to`, `amount_from|amount_to`, `address` (mandatory), `address_memo` ('0' for none),
  `refund, refund_memo, provider` (mandatory), `fixed` (True/False, mandatory), `payment, min_kycrating, webhook, webhook_key, markup`. Result: `trade_id, date,
  ticker_*, coin_*, network_*, amount_from, amount_to, provider, fixed, status, address_provider` (deposit address), `address_provider_memo, address_user, address_user_memo,
  refund_address, refund_address_memo, password, id_provider, payment`.
- **trade status**: `GET /trade?id=ID`. Same fields plus `quotes: { support, expiresAt }` and `details: { hashout }` (payout tx hash, only when finished). Data deleted after 14 days.
- **validateaddress**: `GET /validateaddress?ticker=&network=&address=` returns True/False (not used).
- **min_kycrating**: A = no KYC ... D = may hold the user's funds indefinitely until verification. The client treats A < B < C < D, A best.
- **Status enum**: `new, waiting, confirming, sending, paid partially` (AnonPay/cards only), `finished, failed, expired, halted, refunded`.
  The client maps `paid partially` to `paid_partially` (not finished) and throws `UnknownTradeStatus` for anything else.

## Not documented (ASSUMPTION; resolved at runtime and confirmed in the spike)

- Network strings: BTC, LTC, DOGE, SOL and XMR expect `Mainnet` (docs example). USDT on Tron expects `TRC20` and USDC on Solana expects `Solana`: guesses.
  `TROCADOR_TICKERS` holds only the *expected* strings; before any quote or trade the client calls `/coin?ticker=` and requires exactly one entry with that network
  (else `TrocadorPairUnverified`). Entries with `memo` true are refused.
- Field names inside `quotes` (provider / KYC rating / amount). The client accepts `provider`, `amount_to`/`amount`, and one of `kycrating, kyc_rating, kycRating, KYC, kyc`;
  an entry with no rating is skipped.
- Error shape and HTTP codes: any non-2xx throws, and a 2xx body with an `error` field throws.
- Booleans: the client accepts JSON `true/false` and `"True"/"False"`, nothing else.
- Numeric fields may be JSON numbers or strings; they are read as decimal text (never floats) and parsed to bigint.

## Deviations from the plan's assumed shape

- `quote()` also returns `provider` and `amountToAtomic`; `trade()` takes an object and needs `provider` and `decimals`; `status()` returns an object; `minimum()` needs `decimals`.
- Standard fixed-rate swap (`payment=False`, `fixed=True`, `amount_from`) instead of `payment=True`: the docs say `payment` is for `amount_to`-based payments.
- `status` has two extra values: `new` and `paid_partially`.

## Trade binding (fix round)

- One rate id covers every quote of a `new_rate` (the docs' new_trade takes `id` plus a mandatory `provider`), so `trade()` sends the chosen
  provider next to the id and verifies on the response: provider, `amount_to` (fixed rate, must equal the quote exactly: `TradeQuoteMismatch`),
  `ticker_from/network_from/ticker_to/network_to` echoes, `address_user` (our XMR address), `amount_from`, `fixed`, status new/waiting, no memo,
  and a deposit address valid for the source chain. `refund` (a source-chain address) and `refund_memo=0` are sent.
- Workers fetch has no `redirect: "error"`; the client uses `"manual"`, so a 3xx is a non-2xx failure and the key is never replayed elsewhere.
