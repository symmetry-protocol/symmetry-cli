# Symmetry CLI

A command-line client and MCP server for creating and managing Symmetry v3 baskets. Use it interactively, in scripts, or through AI agents.

Supports local keypair signing, unsigned transactions for external wallets, structured JSON output and typed MCP tools. See the [agent guide](docs/AGENT.md), [operating guidance](docs/SECURITY.md) and [build instructions](docs/RELEASE.md).

## Install

Requires Node 22.15 or newer and npm.

```sh
git clone https://github.com/symmetry-protocol/symmetry-cli.git
cd symmetry-cli
npm ci --ignore-scripts --no-audit --no-fund
npm pack
npm install --global ./symmetry-hq-cli-0.2.0.tgz
symmetry --help
symmetry status
```

## Configure

Reads do not need a keypair. Use a public key to prepare unsigned transactions:

```sh
export SYMMETRY_OWNER=YOUR_PUBLIC_KEY
export SYMMETRY_RPC_URL=https://YOUR_SOLANA_RPC
symmetry --network mainnet wallet balance
symmetry vault list --limit 10 --json
symmetry vault show --vault VAULT_STATE_ADDRESS
symmetry vault from-mint --mint VAULT_SHARE_TOKEN_MINT
symmetry token show --mint TOKEN_MINT
symmetry vault price --vault VAULT_STATE_ADDRESS
```

For local signing, use an existing Solana CLI keypair file, owned by you and readable only by you. The CLI never creates, exports or uploads your private key:

```sh
chmod 600 /path/to/agent-keypair.json
export SYMMETRY_WALLET=/path/to/agent-keypair.json
symmetry wallet address
```

Unset `SYMMETRY_OWNER` when switching signing wallets, or set it to the same public key. A mismatch is rejected before signing. Keypair symlinks are rejected.

Settings are resolved in order: command flags, `SYMMETRY_*` environment variables, saved configuration, defaults. Environment variables: `SYMMETRY_NETWORK`, `SYMMETRY_RPC_URL`, `SYMMETRY_HERMES_URL`, `SYMMETRY_WALLET`, `SYMMETRY_OWNER`, `SYMMETRY_HOME`. Default network is mainnet; default home is `~/.symmetry`. HTTPS is required except for local RPCs. RPC genesis must match the selected network, including when using a local fork.

`symmetry config set --input config.json` replaces saved non-secret settings. `config show` redacts RPC and Hermes paths. Supported settings: `network`, `rpcUrl`, `hermesUrl`, `wallet`, `owner`, `priorityFee` (micro-lamports/CU; default 25000; maximum 1000000), `timeoutMs` (default 60000). The same priority fee must be used when resuming a plan.

## Create and compose a basket

```sh
symmetry vault create --input examples/create.json --request-id first-basket --json
```

This prepares a plan and returns its `id`, `digest`, predicted vault/mint addresses, and actions. It sends no transaction. By default new vaults are **private**, as specified by the program.

```sh
symmetry transaction inspect PLAN_ID
symmetry transaction simulate PLAN_ID
symmetry transaction execute PLAN_ID --approve PLAN_DIGEST
```

On an interactive terminal, `execute` can omit `--approve` and ask for confirmation. To explicitly authorize immediate execution of an action in a script:

```sh
symmetry vault create --input examples/create.json --request-id first-basket --execute --yes
```

Use the same request ID when retrying the same logical request. Different input with the same ID is rejected. An expired unsubmitted plan requires a new request ID after review. `transaction list` locates saved plans after a terminal or process interruption.

The creation example requests a vault without a target allocation. Select assets and configure their allocation before depositing. The protocol initializes SOL/USDC custody assets; those protocol accounts do not define the basket’s investment theme.

Asset discovery and oracle selection belong to the user or calling agent. The CLI has no token catalog, recommended portfolio or mint-to-oracle registry. Discover candidate mints through sources such as [Jupiter Tokens](https://developers.jup.ag/docs/tokens/token-information) and verify their identity against the issuer’s published mint addresses. For tokenized stocks, verify the issuer and underlying security, token mechanics and available liquidity. A ticker match or a quoted USD price does not establish an on-chain oracle pairing. Keep the requested exposure; if the requested assets or suitable oracles cannot be verified, explain the gap and ask the user before changing the allocation.

`vault create` and `vault compose` accept `assets`, each with `mint`, `weightBps` and an optional `token` configuration. Supply `token` for every new or inactive asset. It uses the same complete structure as `vault token-set`: `token_mint`, `active`, aggregator settings and `oracles`. The configuration must match the asset mint and set `active: true`. A token already active in the target vault retains its on-chain settings when `token` is omitted; supplying `token` explicitly updates them. Creation can also retain the protocol-initialized custody settings. Missing configurations are rejected before a creation plan is built.

`vault add-token` and `vault token-set` require `{ "vault": "VAULT_STATE_ADDRESS", "token": { ... } }`. Inspect the exact fields with:

```sh
symmetry schema vault.create
symmetry schema vault.compose
symmetry schema vault.token-set
```

Choose and verify each oracle’s account, mint pairing, quote currency, decimals, freshness, confidence, liquidity and other thresholds. Pyth, Raydium CPMM and Raydium CLMM are available oracle implementations; the CLI does not select a feed or pool for a mint. JSON validation and transaction simulation do not establish that an oracle prices the intended economic asset.

Weight changes are built against the current on-chain composition **after** all token-configuration steps confirm. Final weights are read back and verified. `vault weights` accepts only mints and weights; use the configuration commands to change oracles.

Composition with time locks requires separate `add-token` and `weights` intents, followed by `intent execute` when eligible. Existing active assets omitted from the target allocation get zero weight; they are not automatically removed. Configuring weights does not itself trade existing vault balances: use `vault rebalance` when appropriate.

## Deposit, withdraw and settle

All amounts are positive **integer strings in raw token units**, never floating-point UI amounts. Example: `"1000000"` is one token with six decimals. Values above `9007199254740991` are rejected because the SDK accepts JavaScript numbers; the CLI never silently rounds them. Weights total 10000 basis points. Trade slippage defaults to 100 bps, with a CLI maximum of 1000 bps.

```sh
symmetry vault deposit --input deposit.json
symmetry vault withdraw --vault VAULT_STATE_ADDRESS --amount 1000000
symmetry rebalance list --owner YOUR_PUBLIC_KEY
symmetry rebalance show --intent REBALANCE_INTENT_ADDRESS
```

Example `deposit.json`:

```json
{
  "vault": "VAULT_STATE_ADDRESS",
  "contributions": [{ "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "amount": "1000000" }],
  "slippageBps": 100,
  "perTradeSlippageBps": 100
}
```

Deposits include a separate dependent action that locks the deposited assets. An existing owner/vault deposit or withdrawal intent prevents opening another deposit. Resume the original plan to complete a partial deposit; `deposit-more` and `lock` support explicit recovery of deposits created outside the CLI.

Withdrawals default to keeping **all underlying assets in kind**. Set `keepTokens` explicitly to choose which assets are not rebalanced. Confirmation means the submitted transaction confirmed; auction settlement, share minting, token redemption and bounty claims may remain. Inspect `rebalance show`; eligible actions include `rebalance prices`, `rebalance mint`, `rebalance redeem`, and `rebalance claim-bounty`. Keeper auctions require available market liquidity and running protocol keepers; this CLI does not run an unattended swap-solving service.

`rebalance prices` uses the vault’s configured on-chain oracle accounts by default (`refreshPyth: false`). **No Hermes API key is required for this mode.** Verify that your chosen feeds have an active publisher and updates that satisfy the vault’s settings and protocol custody requirements. See the provider’s current [Solana push-feed information](https://docs.pyth.network/price-feeds/core/push-feeds/solana). The program enforces confidence, freshness and intent timing. Wait until the intent is eligible and the feeds are fresh; never disable these checks to force settlement.

To explicitly publish fresh Pyth data, use `symmetry rebalance prices --intent ADDRESS --refresh-pyth true`. This optional mode needs authorized Hermes access (`PYTH_API_KEY` in the environment, or a compatible `--hermes-url` / `SYMMETRY_HERMES_URL` HTTPS provider). URL credentials and redirects are rejected. Authentication failure returns `ORACLE_AUTH_REQUIRED`. If a chosen feed is unavailable, resolve publication or review another suitable oracle with the user before proceeding. Never substitute a different token to bypass an oracle configuration problem.

`fees withdraw` withdraws and claims only positive fee categories authorized for the signer. `NO_FEES` means there are no new eligible fees. If a previous withdrawal left an account behind, use `fees list` and `fees claim` to recover it before withdrawing that category again.

## External wallets

Use only `SYMMETRY_OWNER`; a local keypair is unnecessary:

```sh
symmetry transaction next PLAN_ID --json > next.json
```

Read `.data.transactionBase64`, inspect its decoded programs/accounts, and sign it with the user's wallet. Save the signed base64 bytes as:

```json
{ "signedTransactionBase64": "SIGNED_BASE64_TRANSACTION" }
```

```sh
symmetry transaction submit PLAN_ID --approve PLAN_DIGEST --input signed.json
symmetry transaction next PLAN_ID --json
```

Repeat one transaction at a time until confirmed. The CLI validates the exact exported message and every Ed25519 signature. It rejects changed recipients, instructions, fee payers, blockhashes, or missing signatures. Re-submitting an already confirmed signed message returns its previous result without replaying another step. `next` can refresh an unsigned blockhash; always sign the most recently exported message.

## Agents and MCP

```sh
symmetry schema
symmetry schema vault.create
symmetry agent-context
symmetry mcp
```

Example MCP client configuration (adapt the enclosing key to the client):

```json
{
  "mcpServers": {
    "symmetry": {
      "command": "symmetry",
      "args": ["mcp"],
      "env": { "SYMMETRY_OWNER": "YOUR_PUBLIC_KEY", "SYMMETRY_RPC_URL": "https://YOUR_RPC" }
    }
  }
}
```

Default MCP tools read data, prepare plans, inspect, export, and simulate. They cannot broadcast. To expose local signing, the operator starts `symmetry mcp --allow-execute` and supplies a protected `SYMMETRY_WALLET` file. Each execution call additionally requires the plan's digest and `acknowledged: true`. Read [the agent contract](docs/AGENT.md). No API key or wallet secret belongs in tool arguments or chat.

## Commands and output

`--help` lists command flags. `schema` is the authoritative full JSON input contract; arrays and objects use `--input file.json` or `--input -`. Unknown properties fail validation. Scalar fields can also be supplied as flags. Boolean scalar flags take `true` or `false`.

| Group | Operations |
| --- | --- |
| `vault` | list, show, price, from-mint, create, compose, weights, add-token, token-set, edit, deposit, deposit-more, lock, withdraw, rebalance, bounty |
| `intent` | list, show, execute, cancel |
| `rebalance` | list, show, prices, mint, redeem, cancel, claim-bounty |
| `fees` | list, withdraw, claim |
| `transaction` | list, inspect, next, simulate, execute, submit, status |
| Other | status, wallet address/balance, token show, config show/set, schema, agent-context, mcp |

`vault edit` supports creator, managers/authorities, fees, schedule, automation, metadata and deposit settings. The protocol enforces permissions and delays. Disabled management/performance fees must remain zero.

Piped output defaults to one JSON result on stdout. Use `--json` explicitly in agents. Diagnostics and prompts go to stderr. Terminal output is indented for readability. SDK-formatted balances may be approximate; use `exact`/`exactTokens` and wallet amount strings for accounting.

```json
{ "ok": true, "data": {}, "meta": { "schemaVersion": 1, "cliVersion": "0.2.0" } }
```

Errors use `{ "ok": false, "error": { "code": "...", "message": "...", "details": {}, "retryable": false }, "meta": {...} }`. Exit codes: 0 success, 1 operation failure, 2 invalid input, 3 missing execution approval, 4 confirmation pending. `--help` and `--version` are plain text.

## Recovery

Plans and signed journals are written atomically with private file permissions before broadcast. Transactions run sequentially, including within SDK batches. A crash or RPC timeout is recovered by checking the saved signature and, if needed, rebroadcasting the same signed bytes. Signed uncertain transactions are never refreshed or replaced automatically.

```sh
symmetry transaction status PLAN_ID
symmetry transaction execute PLAN_ID --approve PLAN_DIGEST
```

On `TRANSACTION_EXPIRED`, verify the signature using a healthy archival RPC before deciding how to recover; inspect every confirmed phase. On simulation failure, previous confirmed phases remain saved. Do not repeat the original deposit/create without its original request ID. The plan is not an atomic transaction; there is no rollback of earlier confirmed steps.

Execution takes a per-wallet, per-network filesystem lock. After an ungraceful process death, verify its recorded PID is no longer active, then remove that one lock under `~/.symmetry/locks` before resuming. Never delete a live process's lock. Separate machines or data directories are not coordinated by these locks.

Creation plans expire after 90 seconds if never submitted because lookup-table creation embeds a recent slot. Other unsubmitted plans expire after 15 minutes. Once started, confirmed steps are retained and unsubmitted steps receive fresh blockhashes where no SDK partial signature would be invalidated. Dry-run simulates only the next ready transaction; it cannot simulate future transactions against uncommitted state.
