import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import type { Vault, SymmetryCore } from '@symmetry-hq/sdk';
import { getRebalanceIntentPda } from '@symmetry-hq/sdk/dist/instructions/pda.js';
import { VAULTS_V3_PROGRAM_ID } from '@symmetry-hq/sdk/dist/constants.js';
import { Service } from '../src/service.js';
import { configSchema } from '../src/config.js';
import { parse, type Input } from '../src/commands.js';

const owner = Keypair.generate().publicKey.toBase58(), vaultAddress = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, asset = Keypair.generate().publicKey;
function tokenSettings(mint: string): Input<'vault.token-set'>['token'] {
  return { token_mint: mint, active: true, min_oracles_thresh: 1, min_conf_bps: 20, conf_thresh_bps: 200, conf_multiplier: 2,
    oracles: [{ oracle_type: 'pyth', account: Keypair.generate().publicKey.toBase58(), account_lut_id: 0, account_lut_index: 0,
      weight_bps: 10000, is_required: true, conf_thresh_bps: 200, volatility_thresh_bps: 300, max_slippage_bps: 40,
      min_liquidity: 12345, staleness_thresh: 90, staleness_conf_rate_bps: 1, token_decimals: 6,
      twap_seconds_ago: 0, twap_secondary_seconds_ago: 0, quote_token: 'usd' }] };
}
const vault = () => ({ ownAddress: vaultAddress, mint, numTokens: 1, settings: { addTokenDelay: new BN(0), updateWeightsDelay: new BN(0) }, composition: [{ mint: asset, weight: 10000, active: 1 }] }) as unknown as Vault;
function fixture() {
  const current = vault();
  const calls: { method: string; args: unknown[] }[] = [];
  const payload = { batches: [] };
  const pending = { vault: vaultAddress, owner: new PublicKey(owner), rebalanceType: 0, currentAction: 1 };
  const global = { bountyMint: new PublicKey('So11111111111111111111111111111111111111112'), bountyBondAmount: new BN(100000), bountyPerTask: { maxBounty: new BN(250000) }, bountyPerPriceUpdateTaskDivisor: new BN(3) };
  const sdk = new Proxy({}, { get: (_target, method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return method === 'fetchVault' ? current : method === 'fetchRebalanceIntent' ? { chain_data: pending } : method === 'fetchGlobalConfig' ? global : method === 'createVaultTx' ? { ...payload, vault: vaultAddress.toBase58(), mint: mint.toBase58() } : payload;
  } }) as SymmetryCore;
  const connection = { getAccountInfo: async () => null } as unknown as Connection;
  const service = new Service(configSchema.parse({ owner, network: 'mainnet' }), connection, sdk);
  service.checkNetwork = async () => {};
  return { service, current, pending, global, calls, connection };
}
test('deposit planning includes explicit lock after SDK buy, and forwards exact raw units', async () => {
  const f = fixture();
  const input = { vault: vaultAddress.toBase58(), contributions: [{ mint: asset.toBase58(), amount: '9007199254740991' }], slippageBps: 42, perTradeSlippageBps: 21 };
  const expanded = await f.service.expand('vault.deposit', input, owner);
  assert.deepEqual(expanded.actions.map(action => action.command), ['vault.deposit', 'vault.lock']);
  await f.service.build(expanded.actions[0]!, owner);
  assert.deepEqual(f.calls.find(call => call.method === 'buyVaultTx')?.args[0], { buyer: owner, vault_mint: mint.toBase58(), contributions: [{ mint: asset.toBase58(), amount: Number.MAX_SAFE_INTEGER }], rebalance_slippage_bps: 42, per_trade_rebalance_slippage_bps: 21 });
});
test('pending deposits fail before another buy is built', async () => {
  const f = fixture();
  f.connection.getAccountInfo = async () => ({ lamports: 1 }) as never;
  await assert.rejects(f.service.build({ command: 'vault.deposit', input: { vault: vaultAddress.toBase58(), contributions: [{ mint: asset.toBase58(), amount: '1' }] } }, owner), /Existing deposit/);
  assert.equal(f.calls.some(call => call.method === 'buyVaultTx'), false);
});
test('updated SDK rounds bounty tasks and combined SOL overflow still fails before a buy is built', async () => {
  const f = fixture(), sol = f.global.bountyMint.toBase58();
  f.current.composition[0]!.mint = f.global.bountyMint;
  const action = { command: 'vault.deposit' as const, input: { vault: vaultAddress.toBase58(), contributions: [{ mint: sol, amount: '1000000' }] } };
  f.global.bountyPerTask.maxBounty = new BN(123);
  await f.service.build(action, owner);
  f.global.bountyPerTask.maxBounty = new BN(250000);
  action.input.contributions[0]!.amount = String(Number.MAX_SAFE_INTEGER);
  await assert.rejects(f.service.build(action, owner), error => (error as { code: string }).code === 'AMOUNT_TOO_LARGE');
  assert.equal(f.calls.filter(call => call.method === 'buyVaultTx').length, 1);
});
test('deposit-more targets only the signer’s unlocked deposit intent', async () => {
  const f = fixture(), intent = getRebalanceIntentPda(vaultAddress, new PublicKey(owner)).toBase58();
  const action = { command: 'vault.deposit-more' as const, input: { intent, contributions: [{ mint: asset.toBase58(), amount: '123' }] } };
  await f.service.build(action, owner);
  assert.deepEqual(f.calls.find(call => call.method === 'depositTokensTx')?.args[0], { buyer: owner, rebalance_intent_chain_data: f.pending, contributions: [{ mint: asset.toBase58(), amount: 123 }] });
  for (const change of [
    () => { f.pending.owner = Keypair.generate().publicKey; },
    () => { f.pending.owner = new PublicKey(owner); action.input.intent = Keypair.generate().publicKey.toBase58(); },
    () => { action.input.intent = intent; f.pending.currentAction = 3; },
    () => { f.pending.currentAction = 1; f.pending.rebalanceType = 1; },
  ]) {
    change();
    await assert.rejects(f.service.build(action, owner), /Deposit intent/);
  }
  assert.equal(f.calls.filter(call => call.method === 'depositTokensTx').length, 1);
});
test('withdraw defaults to all underlying mints for in-kind redemption', async () => {
  const f = fixture();
  await f.service.build({ command: 'vault.withdraw', input: { vault: vaultAddress.toBase58(), amount: '123' } }, owner);
  const args = f.calls.find(call => call.method === 'sellVaultTx')!.args[0] as { keep_tokens: string[]; withdraw_amount: number };
  assert.deepEqual(args.keep_tokens, [asset.toBase58()]);
  assert.equal(args.withdraw_amount, 123);
});
test('unsupported configurations reject new operations while preserving in-kind withdrawal', async () => {
  const f = fixture(), dataAddress = Keypair.generate().publicKey;
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const program = Buffer.alloc(36), data = Buffer.alloc(12);
  program.writeUInt32LE(2); dataAddress.toBuffer().copy(program, 4);
  data.writeUInt32LE(3); data.writeBigUInt64LE(1n, 4);
  f.connection.getAccountInfo = (async (key: PublicKey) => key.equals(VAULTS_V3_PROGRAM_ID) ? { executable: true, owner: loader, data: program } : key.equals(dataAddress) ? { owner: loader, data } : null) as never;
  f.current.composition.push(...Array.from({ length: 50 }, () => ({ mint: Keypair.generate().publicKey, weight: 0, active: 1 })));
  f.current.numTokens = 51;
  const deposit = { command: 'vault.deposit' as const, input: { vault: vaultAddress.toBase58(), contributions: [{ mint: asset.toBase58(), amount: '1' }] } };
  const withdraw = { command: 'vault.withdraw' as const, input: { vault: vaultAddress.toBase58(), amount: '1' } };
  for (const action of [deposit, { command: 'vault.lock' as const, input: { vault: vaultAddress.toBase58() } }, { command: 'vault.rebalance' as const, input: { vault: vaultAddress.toBase58() } }, { command: 'vault.withdraw' as const, input: { ...withdraw.input, keepTokens: [asset.toBase58()] } }])
    await assert.rejects(f.service.build(action, owner), error => (error as { code: string }).code === 'UNSUPPORTED_CONFIGURATION');
  const intent = getRebalanceIntentPda(vaultAddress, new PublicKey(owner)).toBase58();
  await assert.rejects(f.service.build({ command: 'vault.deposit-more', input: { intent, contributions: deposit.input.contributions } }, owner), error => (error as { code: string }).code === 'UNSUPPORTED_CONFIGURATION');
  assert.equal(f.calls.some(call => ['buyVaultTx', 'depositTokensTx', 'lockDepositsTx', 'rebalanceVaultTx', 'sellVaultTx'].includes(call.method)), false);
  await f.service.build(withdraw, owner);
  assert.equal(f.calls.filter(call => call.method === 'sellVaultTx').length, 1);
  assert.equal((f.calls.find(call => call.method === 'sellVaultTx')!.args[0] as { keep_tokens: string[] }).keep_tokens.length, 51);
  f.current.numTokens = 50;
  await f.service.build(deposit, owner);
  assert.equal(f.calls.filter(call => call.method === 'buyVaultTx').length, 1);
  f.current.numTokens = 51;
  data.writeBigUInt64LE(2n, 4);
  await assert.rejects(f.service.build(deposit, owner), error => (error as { code: string }).code === 'UNSUPPORTED_CONFIGURATION');
  f.connection.getAccountInfo = async () => null;
  await assert.rejects(f.service.assertSettleable(f.current), /unavailable for the current basket configuration/);
  assert.equal(f.calls.filter(call => call.method === 'buyVaultTx').length, 1);
});
test('status reports the installed SDK version', async () => {
  const f = fixture();
  f.service.config.rpcUrl = 'https://rpc.example';
  f.connection.getAccountInfo = async () => ({ executable: true }) as never;
  f.connection.getSlot = async () => 1;
  assert.equal((await f.service.read('status', {}) as { sdkVersion: string }).sdkVersion, '1.0.23');
});
test('compose schedules missing assets first and builds weights only after their activation', async () => {
  const f = fixture(), additional = Keypair.generate().publicKey;
  const token = tokenSettings(additional.toBase58());
  const expanded = await f.service.expand('vault.compose', { vault: vaultAddress.toBase58(), assets: [{ mint: additional.toBase58(), weightBps: 10000, token }] }, owner);
  assert.deepEqual(expanded.actions.map(action => action.command), ['vault.token-set', 'vault.weights']);
  await f.service.build(expanded.actions[0]!, owner);
  assert.deepEqual(f.calls.find(call => call.method === 'addOrEditTokenTx')?.args[1], token);
  await assert.rejects(f.service.build(expanded.actions[1]!, owner), /must be active/);
  f.current.composition.push({ mint: additional, weight: 0, active: 1 } as never); f.current.numTokens++;
  await f.service.build(expanded.actions[1]!, owner);
  assert.deepEqual(f.calls.find(call => call.method === 'updateWeightsTx')?.args[1], { token_weights: [{ mint: additional.toBase58(), weight_bps: 10000 }] });
});
test('compose refuses time locks; verification detects changed or missing weights', async () => {
  const f = fixture(), input = { vault: vaultAddress.toBase58(), assets: [{ mint: asset.toBase58(), weightBps: 10000 }] };
  f.current.settings.addTokenDelay = new BN(10);
  await assert.rejects(f.service.expand('vault.compose', input, owner), /time locks/);
  assert.equal((await f.service.verify([{ command: 'vault.weights', input }])).composition, 'verified');
  f.current.composition[0]!.weight = 5000;
  await assert.rejects(f.service.verify([{ command: 'vault.weights', input }]), /do not match/);
});
test('creation and composition reject missing oracle choices without selecting replacement assets', async () => {
  const f = fixture(), additional = Keypair.generate().publicKey.toBase58();
  for (const mint of [additional, 'CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu']) {
    const assets = [{ mint, weightBps: 10000 }];
    await assert.rejects(f.service.expand('vault.create', { name: 'Test', symbol: 'TEST', assets }, owner), error => (error as { code: string }).code === 'ORACLE_CONFIGURATION_REQUIRED');
    await assert.rejects(f.service.expand('vault.compose', { vault: vaultAddress.toBase58(), assets }, owner), error => (error as { code: string }).code === 'ORACLE_CONFIGURATION_REQUIRED');
  }
  assert.equal(f.calls.some(call => ['createVaultTx', 'addOrEditTokenTx', 'updateWeightsTx'].includes(call.method)), false);
  const existing = [{ mint: asset.toBase58(), weightBps: 10000 }];
  assert.deepEqual((await f.service.expand('vault.compose', { vault: vaultAddress.toBase58(), assets: existing }, owner)).actions, [{ command: 'vault.weights', input: { vault: vaultAddress.toBase58(), assets: existing } }]);
  f.current.composition[0]!.active = 0;
  await assert.rejects(f.service.expand('vault.compose', { vault: vaultAddress.toBase58(), assets: existing }, owner), /explicit token\/oracle settings/);
});
test('creation accepts independently selected mints on either network and retains all caller settings', async () => {
  for (const network of ['mainnet', 'devnet'] as const) {
    const f = fixture(), selectedMint = Keypair.generate().publicKey.toBase58(), token = tokenSettings(selectedMint);
    f.service.config.network = network;
    let slot = 1; f.connection.getSlot = async () => slot++;
    const result = await f.service.expand('vault.create', { name: 'Test', symbol: 'TEST', assets: [{ mint: selectedMint, weightBps: 10000, token }] }, owner);
    assert.deepEqual(result.actions.slice(1), [
      { command: 'vault.token-set', input: { vault: vaultAddress.toBase58(), token } },
      { command: 'vault.weights', input: { vault: vaultAddress.toBase58(), assets: [{ mint: selectedMint, weightBps: 10000 }] } },
    ]);
    await f.service.build(result.actions[1]!, owner);
    assert.deepEqual(f.calls.find(call => call.method === 'addOrEditTokenTx')!.args[1], token);
  }
});
test('explicit settings for existing assets are applied before weights, not silently discarded', async () => {
  const f = fixture(), token = tokenSettings(asset.toBase58());
  const result = await f.service.expand('vault.compose', { vault: vaultAddress.toBase58(), assets: [{ mint: asset.toBase58(), weightBps: 10000, token }] }, owner);
  assert.deepEqual(result.actions.map(action => action.command), ['vault.token-set', 'vault.weights']);
  for (const action of result.actions) await f.service.build(action, owner);
  assert.deepEqual(f.calls.find(call => call.method === 'addOrEditTokenTx')!.args[1], token);
  assert.deepEqual(f.calls.find(call => call.method === 'updateWeightsTx')!.args[1], { token_weights: [{ mint: asset.toBase58(), weight_bps: 10000 }] });
});
test('mint-only, mismatched, inactive and incomplete oracle configurations fail input validation', async () => {
  const f = fixture(), token = tokenSettings(asset.toBase58()), base = { vault: vaultAddress.toBase58() };
  await assert.rejects(f.service.expand('vault.add-token', { ...base, mint: asset.toBase58() }, owner));
  for (const change of [{ token_mint: Keypair.generate().publicKey.toBase58() }, { active: false }, { oracles: [] }]) {
    const assets = [{ mint: asset.toBase58(), weightBps: 10000, token: { ...token, ...change } }];
    await assert.rejects(f.service.expand('vault.create', { name: 'Test', symbol: 'TEST', assets }, owner));
    await assert.rejects(f.service.expand('vault.compose', { ...base, assets }, owner));
  }
  const incomplete = { ...token, oracles: token.oracles.map(({ staleness_thresh, ...oracle }) => oracle) };
  await assert.rejects(f.service.expand('vault.add-token', { ...base, token: incomplete }, owner));
  assert.throws(() => parse('vault.weights', { ...base, assets: [{ mint: asset.toBase58(), weightBps: 10000, token }] }));
  assert.equal(f.calls.length, 0);
});
test('both explicit token commands pass through each supported caller-selected oracle type', async () => {
  const f = fixture();
  for (const command of ['vault.add-token', 'vault.token-set'] as const) {
    for (const oracleType of ['pyth', 'raydium_cpmm', 'raydium_clmm'] as const) {
      const token = tokenSettings(Keypair.generate().publicKey.toBase58());
      token.oracles[0]!.oracle_type = oracleType;
      await f.service.build({ command, input: { vault: vaultAddress.toBase58(), token, activationTimestamp: 123 } }, owner);
      assert.deepEqual(f.calls.at(-1)!.args, [{ vault: vaultAddress.toBase58(), manager: owner, activation_timestamp: 123, expiration_timestamp: undefined }, token]);
    }
  }
});
test('creation counts protocol custody slots and never inserts them into the requested weights', async () => {
  const f = fixture(); let slot = 1; f.connection.getSlot = async () => slot++;
  const assets = Array.from({ length: 100 }, (_, index) => {
    const mint = Keypair.generate().publicKey.toBase58();
    return { mint, weightBps: index === 0 ? 10000 : 0, token: tokenSettings(mint) };
  });
  await assert.rejects(f.service.expand('vault.create', { name: 'Test', symbol: 'TEST', assets }, owner), error => (error as { code: string }).code === 'ASSET_LIMIT');
  const sol = 'So11111111111111111111111111111111111111112';
  const result = await f.service.expand('vault.create', { name: 'Test', symbol: 'TEST', assets: [{ mint: sol, weightBps: 10000 }] }, owner);
  assert.deepEqual(result.actions.slice(1), [{ command: 'vault.weights', input: { vault: vaultAddress.toBase58(), assets: [{ mint: sol, weightBps: 10000 }] } }]);
});
test('creation waits for its lookup-table slot to become recent before returning', async () => {
  const f = fixture(); let reads = 0;
  f.connection.getSlot = async () => ++reads < 3 ? 10 : 11;
  await f.service.build({ command: 'vault.create', input: { name: 'Test', symbol: 'TEST' } }, owner);
  assert.equal(reads, 3);
  assert.ok(f.calls.some(call => call.method === 'createVaultTx'));
});
test('real web3 transport integrates with CLI network checking and balance formatting', async () => {
  const seen: string[] = [];
  const connection = new Connection('https://rpc.example', { fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)); seen.push(request.method);
    const result = request.method === 'getGenesisHash' ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : { context: { slot: 1 }, value: [] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } });
  } });
  const service = new Service(configSchema.parse({ owner }), connection);
  const fetcher = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); seen.push(request.method);
    return new Response(`{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":500000000000000001}}`);
  };
  try {
    const result = await service.read('wallet.balance', { owner }) as { solLamports: string; tokens: unknown[] };
    assert.equal(result.solLamports, '500000000000000001'); assert.deepEqual(result.tokens, []);
    assert.equal(seen[0], 'getGenesisHash'); assert.equal(seen.filter(method => method === 'getBalance').length, 1);
    assert.equal(seen.filter(method => method === 'getTokenAccountsByOwner').length, 2);
  } finally { globalThis.fetch = fetcher; }
});
