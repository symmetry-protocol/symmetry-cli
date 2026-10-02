# Safe operation

This CLI is a local signer, not a custody or isolation boundary. A process that can read the keypair or alter trusted plan/journal files has the same operating-system authority as the CLI. Plan hashes detect accidental edits; they are not keyed attestations. Run untrusted agents with public-key-only planning and an independent signing wallet.

## Implemented controls

- Writes prepare by default. Execution requires human confirmation or explicit noninteractive consent. MCP signing is absent unless the operator enables it, and each call needs the reviewed digest and acknowledgement.
- Only existing local plans execute. External signatures must match the exported message byte-for-byte, with every Ed25519 signature verified. Owner, network and priority-fee configuration are bound to the plan.
- Keypairs are read from owned regular files with restrictive permissions; symlinks and invalid 64-byte Solana secrets fail closed. No secret-key argument, export tool or key generation tool is exposed.
- RPC network is verified with Solana's full genesis hash. Remote RPC requires HTTPS. RPC URLs are redacted in displayed configuration and unexpected error messages.
- On-chain oracle prices are used by default without Hermes credentials. Program freshness, confidence and intent timing checks still apply. Optional Hermes refresh reads credentials only from `PYTH_API_KEY`. HTTPS providers cannot contain URL credentials, queries or fragments; redirects are rejected. Responses have a streaming 4 MiB limit and strict binary validation. Authentication errors do not include upstream response bodies.
- Every transaction is simulated before its first submission. Signed bytes and signatures are fsynced to the journal first. Resume checks signatures and only rebroadcasts the same signed bytes. Ambiguous expired signatures never trigger automatic replacement.
- Per-wallet execution locks coordinate processes using the same data directory. Multi-machine execution requires external coordination. File permissions and atomic writes protect local progress; backups should also be private.
- Exact amount strings, safe-integer SDK limits, strict schemas, total/unique weights and feed-identity verification prevent common agent input mistakes. SDK-generated instructions remain subject to on-chain permissions and simulation.
- Native SOL balance reads preserve the original JSON integer through the full u64 range instead of rounding through JavaScript numbers. The RPC response has a streaming 64 KiB limit and validates its envelope and unsigned integer value.

Confirmations use Solana's `confirmed` commitment. Chain reorganization and inaccurate/malicious RPC responses remain outside a local journal's guarantees. Multi-transaction plans can partially complete. There is no automatic rollback, fiat spending policy or unattended investment mandate enforcement.

## Dependencies

The CLI pins `@symmetry-hq/sdk@1.0.23` and its direct runtime dependencies. The npm shrinkwrap records transitive versions. Use `npm ci --ignore-scripts` for reproducible development installs and rerun the package checks after changing dependencies.

The `bigint-buffer` dependency uses the compatible `@trufflesuite/bigint-buffer` package. It falls back to JavaScript when no native prebuild matches the platform; its stderr diagnostic does not contaminate JSON or MCP output.
