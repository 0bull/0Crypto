# Railgun live spike (manual, operator only)

0Crypto builds Railgun shield notes itself (`src/routing/railgun/note.ts`). The golden test
(`test/routing/railgun/note.test.ts`, vectors from the real `@railgun-community/engine` via
`tools/railgun-golden/gen.mjs`) proves the bytes match the engine. Only a real wallet can prove the funds show up
there, so the Railgun executor refuses to shield until `RAILGUN_GOLDEN_OK=1` (the master switch) and the chain is
listed in `RAILGUN_GOLDEN_OK_CHAINS` (a comma list such as `arb,base`). Set the switch only after this spike passes,
and list a chain only after the spike passed **on that chain**: proxies, tokens and gas differ per chain. Spike the
chain's native coin too (the executor wraps it to WETH/WBNB/WPOL before shielding) before listing a chain whose native
asset you accept.

This spends real funds: about $1 of USDC plus Arbitrum gas.

## Steps

1. **Set up the receiver.** In Railway (or another Railgun wallet), open the wallet that holds the `0zk` address you
   will use as `RAILGUN_0ZK_ADDRESS`. Copy the address.
2. **Fund the hot wallet.** Find the EVM hot wallet address on the admin page ("EVM chains"; `m/44'/60'/0'/0/0` of
   `MASTER_SEED`). On **Arbitrum One**, send it about **$2 of native USDC**
   (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, not USDC.e) plus a little **ETH for gas** (about $0.50 is plenty).
3. **Run the script** from the repo root. The seed is read from stdin only, never from arguments or the environment:

   ```sh
   op read "op://Vault/0crypto/MASTER_SEED" | npx tsx scripts/railgun-shield-once.ts \
     --chain arb --amount 1 --rpc "https://<your Arbitrum RPC URL>" --to "<RAILGUN_0ZK_ADDRESS>" \
     --i-understand-this-spends-real-funds
   ```

   Without `--i-understand-this-spends-real-funds` the script refuses and does nothing. It checks the balances,
   builds the note with 0Crypto's own code, checks that the note's random decrypts, sends an exact-amount USDC
   `approve` to the RailgunSmartWallet proxy `0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9` if needed, simulates
   `shield`, and then sends it. It prints the shield tx hash.
4. **Wait for the Proof of Innocence screening** (about 1 hour). Then, in the Railgun wallet holding
   `RAILGUN_0ZK_ADDRESS`, check that the shielded balance shows **0.9975 USDC** (1 USDC minus the 0.25% shield fee).
   If it doesn't appear after a few hours, do **not** set the var. Record the failure below and stop.
5. **Record the result** in the log below: date, tx hash, amount, and what the wallet showed.
6. **Only then** set `RAILGUN_GOLDEN_OK` to `"1"` and add the chain to `RAILGUN_GOLDEN_OK_CHAINS` (for this run,
   `arb`) in the `vars` of `wrangler.jsonc`, and deploy.

**Each further chain** (`eth`, `base`, `polygon`, `bsc`): run steps 2 to 5 on that chain (`--chain <id>`, its RPC, its
native USDC and gas) and add the chain to `RAILGUN_GOLDEN_OK_CHAINS` only after the funds showed up in the wallet.
Removing a chain from the list stops new shields there at once; a shield in progress is not finished until the chain
is listed again.

**The native wrap.** The router also shields a listed chain's native coin (ETH, BNB, POL) held beyond the gas
reserve, whether or not it is in `ENABLED_ASSETS`: it wraps it (WETH/WBNB/WPOL `deposit`) and shields the wrapped
token. `scripts/railgun-shield-once.ts` shields USDC only, so that path has no live spike yet
([plan-4-deferred.md](superpowers/plans/plan-4-deferred.md)). Until it has one, before listing a chain either accept that risk or keep
the hot wallet's native balance at the gas reserve (top it up by hand, not past `GAS_RESERVE`).

Repeat the spike whenever `src/routing/railgun/` or the pinned engine version in `tools/railgun-golden/` changes.

## Log

| Date | Chain | Shield tx | Amount (token or native) | Wallet showed | Operator |
|---|---|---|---|---|
| _not run yet_ | | | | | |
