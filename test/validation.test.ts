import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { parse, catalog } from '../src/commands.js';
import { configSchema, loadWallet, assertNetwork, GENESIS } from '../src/config.js';
import { errorResult, rawAmount, withLock } from '../src/lib/utils.js';

const mint = Keypair.generate().publicKey.toBase58();
test('schedule and automation limits match deployed program boundaries', () => {
  const settings = { cycle_start_time: 0, cycle_duration: 600, deposits_start: 0, deposits_end: 600, automation_start: 0, automation_end: 600, management_start: 0, management_end: 600, modification_delay: 0 };
  const schedule = (value: object) => parse('vault.edit', { vault: mint, change: { kind: 'schedule', settings: value } });
  assert.doesNotThrow(() => schedule(settings));
  for (const field of ['cycle_duration', 'deposits_end', 'automation_end', 'management_end']) assert.throws(() => schedule({ ...settings, [field]: 599 }));
  const automation = { enabled: true, rebalance_slippage_threshold_bps: 9999, per_trade_rebalance_slippage_threshold_bps: 9999, rebalance_activation_threshold_abs_bps: 9999, rebalance_activation_threshold_rel_bps: 9999, rebalance_activation_cooldown: 0, modification_delay: 0 };
  const validate = (value: object) => parse('vault.edit', { vault: mint, change: { kind: 'automation', settings: value } });
  assert.doesNotThrow(() => validate(automation));
  for (const field of Object.keys(automation).filter(key => key.endsWith('_bps'))) assert.throws(() => validate({ ...automation, [field]: 10000 }));
});
test('exact amount strings reject rounding, signs, exponent notation and overflow', () => {
  for (const value of [1, '0', '-1', '1.1', '1e6', '01', ' 1', '9007199254740992']) assert.throws(() => rawAmount.parse(value));
  assert.equal(rawAmount.parse('9007199254740991'), '9007199254740991');
});
test('weights require unique valid mints and an exact 10000 bps total', () => {
  assert.throws(() => parse('vault.compose', { vault: mint, assets: [{ mint, weightBps: 9999 }] }));
  assert.throws(() => parse('vault.compose', { vault: mint, assets: [{ mint, weightBps: 5000 }, { mint, weightBps: 5000 }] }));
  assert.throws(() => parse('vault.compose', { vault: 'bad', assets: [{ mint, weightBps: 10000 }] }));
  assert.equal(parse('vault.compose', { vault: mint, assets: [{ mint, weightBps: 10000 }] }).assets.length, 1);
});
test('advanced token configuration accepts only deployed oracle implementations', () => {
  const oracle = { oracle_type: 'pyth', account: mint, weight_bps: 10000, is_required: true, conf_thresh_bps: 500,
    volatility_thresh_bps: 5000, max_slippage_bps: 500, min_liquidity: 0, staleness_thresh: 600,
    staleness_conf_rate_bps: 0, token_decimals: 6, twap_seconds_ago: 0, twap_secondary_seconds_ago: 0, quote_token: 'usd' };
  const input = (oracle_type: string) => ({ vault: mint, token: { token_mint: mint, active: true, min_oracles_thresh: 1,
    min_conf_bps: 50, conf_thresh_bps: 500, conf_multiplier: 1, oracles: [{ ...oracle, oracle_type }] } });
  for (const type of ['pyth', 'raydium_cpmm', 'raydium_clmm']) assert.doesNotThrow(() => parse('vault.token-set', input(type)));
  for (const type of ['lst', 'overpass', 'byreal_clmm', 'meteora_dlmm']) assert.throws(() => parse('vault.token-set', input(type)), /pyth|raydium_cpmm|raydium_clmm/);
});
test('create validates metadata by UTF-8 bytes and rejects unknown settings', () => {
  assert.throws(() => parse('vault.create', { name: '😀'.repeat(9), symbol: 'A' }));
  assert.throws(() => parse('vault.create', { name: 'A', symbol: 'A', surprise: true }));
  assert.throws(() => parse('vault.create', { name: 'A', symbol: 'A', startPrice: '1e5' }));
  assert.throws(() => parse('vault.create', { name: 'A', symbol: 'A', metadataUri: 'javascript:alert(1)' }));
  assert.equal(parse('vault.create', { name: 'Test', symbol: 'ABC' }).startPrice, '1');
});
test('creation and metadata editing enforce program byte minima and ASCII symbols', () => {
  const validate = (name: string, symbol: string) => [
    () => parse('vault.create', { name, symbol }),
    () => parse('vault.edit', { vault: mint, change: { kind: 'metadata', settings: { name, symbol, uri: '', modification_delay: 0 } } }),
  ];
  for (const [name, symbol] of [['AB', 'ABC'], ['Test', 'AB'], ['Test', 'A-B'], ['Test', '海'], ['Test', 'ABCDEFGHIJK'], ['🌊'.repeat(9), 'ABC']])
    for (const check of validate(name!, symbol!)) assert.throws(check);
  for (const [name, symbol] of [['海', 'ABC'], ['🌊'.repeat(8), '0123456789'], ['abc', 'aZ9']])
    for (const check of validate(name!, symbol!)) assert.doesNotThrow(check);
});
test('trade limits, duplicate contributions and list filters fail closed', () => {
  assert.throws(() => parse('vault.deposit', { vault: mint, contributions: [{ mint, amount: '1' }], slippageBps: 1001 }));
  assert.throws(() => parse('vault.deposit', { vault: mint, contributions: [{ mint, amount: '1' }, { mint, amount: '2' }] }));
  assert.throws(() => parse('vault.list', { owner: mint }));
  assert.throws(() => parse('rebalance.list', { vault: mint, owner: mint }));
  assert.throws(() => parse('rebalance.list', {}));
});
test('discovery describes input defaults as optional', () => {
  const schema = catalog('vault.create')['vault.create']!.inputSchema as { required: string[] };
  assert.deepEqual(schema.required, ['name', 'symbol']);
});
test('configuration restricts insecure endpoints and priority fees', () => {
  assert.throws(() => configSchema.parse({ rpcUrl: 'http://remote.example' }));
  assert.throws(() => configSchema.parse({ priorityFee: 1_000_001 }));
  assert.equal(configSchema.parse({ rpcUrl: 'http://127.0.0.1:8899' }).network, 'mainnet');
});
test('cluster verification checks full genesis hash', async () => {
  await assertNetwork({ getGenesisHash: async () => GENESIS.mainnet } as never, 'mainnet');
  await assert.rejects(assertNetwork({ getGenesisHash: async () => GENESIS.devnet } as never, 'mainnet'), /does not match/);
});
test('keypair loader enforces ownership, mode, key consistency and no symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'symmetry-wallet-'));
  try {
    const path = join(directory, 'wallet.json'), wallet = Keypair.generate();
    await writeFile(path, JSON.stringify([...wallet.secretKey]), { mode: 0o600 });
    assert.equal((await loadWallet(path)).publicKey.toBase58(), wallet.publicKey.toBase58());
    await chmod(path, 0o644);
    if (process.platform !== 'win32') await assert.rejects(loadWallet(path), /permissions/);
    await chmod(path, 0o600);
    await symlink(path, join(directory, 'link'));
    await assert.rejects(loadWallet(join(directory, 'link')));
    await writeFile(path, JSON.stringify(new Array(64).fill(0)));
    await assert.rejects(loadWallet(path), /decode/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('wallet lock prevents concurrent execution and releases after errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'symmetry-lock-')), path = join(directory, 'lock');
  try {
    await withLock(path, async () => assert.rejects(withLock(path, async () => {}), /locked/));
    await assert.rejects(withLock(path, async () => { throw new Error('failed'); }));
    await withLock(path, async () => {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('RPC endpoint credentials are redacted from unexpected errors', () => {
  assert.equal(errorResult(new Error('403 from https://host/path?api-key=secret')).message, '403 from [endpoint]');
});
