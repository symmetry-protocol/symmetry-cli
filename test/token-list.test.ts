import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo, type Connection } from '@solana/web3.js';
import type { SymmetryCore } from '@symmetry-hq/sdk';
import { Service } from '../src/service.js';
import { configSchema, GENESIS } from '../src/config.js';
import { catalog, parse } from '../src/commands.js';
import registry from '../src/oracles.json' with { type: 'json' };

const feeds = Object.entries(registry).map(([mint, feed]) => ({ mint, ...feed }));
const receiver = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
const now = 1_800_000_000;
function priceAccount(feedId: string, publishTime: number, owner = receiver, verification = 1): AccountInfo<Buffer> {
  const data = Buffer.alloc(133);
  data[40] = verification;
  Buffer.from(feedId, 'hex').copy(data, 41);
  data.writeBigInt64LE(100n, 73);
  data.writeBigInt64LE(BigInt(publishTime), 93);
  data.writeBigInt64LE(100n, 109);
  return { data, owner, executable: false, lamports: 1, rentEpoch: 0 };
}
function fixture() {
  const accounts: (AccountInfo<Buffer> | null)[] = feeds.map(feed => priceAccount(feed.feedId, now - 60));
  const clock = Buffer.alloc(40);
  clock.writeBigInt64LE(BigInt(now), 32);
  accounts.push({ data: clock, owner: SYSVAR_CLOCK_PUBKEY, executable: false, lamports: 1, rentEpoch: 0 });
  let genesisReads = 0, batchReads = 0;
  const connection = {
    getGenesisHash: async () => { genesisReads++; return GENESIS.mainnet; },
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[], commitment: string) => {
      batchReads++;
      assert.equal(commitment, 'confirmed');
      assert.deepEqual(keys.map(key => key.toBase58()), [...feeds.map(feed => feed.account), SYSVAR_CLOCK_PUBKEY.toBase58()]);
      return { context: { slot: 123 }, value: accounts };
    },
  } as unknown as Connection;
  const service = new Service(configSchema.parse({ network: 'mainnet' }), connection, {} as SymmetryCore);
  return { service, accounts, reads: () => ({ genesisReads, batchReads }) };
}

test('token.list stays offline by default and advertises an optional live check', async () => {
  const f = fixture();
  assert.deepEqual(parse('token.list', {}), { checkPrices: false });
  assert.equal((catalog('token.list')['token.list']!.inputSchema as { required?: string[] }).required?.length ?? 0, 0);
  const result = await f.service.read('token.list', {}) as { network: string; assets: unknown[] };
  assert.deepEqual(result, { network: 'mainnet', assets: feeds });
  assert.deepEqual(f.reads(), { genesisReads: 0, batchReads: 0 });
});

test('token.list checks feed identity and age against one on-chain Clock snapshot', async () => {
  const f = fixture();
  f.accounts[0] = priceAccount(feeds[0]!.feedId, now - 130);
  f.accounts[3] = priceAccount(feeds[3]!.feedId, now - 601);
  const result = await f.service.read('token.list', { checkPrices: true }) as { checkedAtSlot: number; chainUnixTimestamp: number; assets: Array<{ oracle: { status: string; ageSeconds: number; maxAgeSeconds: number; custodyMaxAgeSeconds?: number; fresh: boolean } }> };
  assert.equal(result.checkedAtSlot, 123);
  assert.equal(result.chainUnixTimestamp, now);
  assert.deepEqual(f.reads(), { genesisReads: 1, batchReads: 1 });
  assert.deepEqual(result.assets[0]!.oracle, { status: 'stale', publishTime: now - 130, ageSeconds: 130, maxAgeSeconds: 600, custodyMaxAgeSeconds: 120, fresh: false });
  assert.deepEqual(result.assets[1]!.oracle, { status: 'fresh', publishTime: now - 60, ageSeconds: 60, maxAgeSeconds: 600, custodyMaxAgeSeconds: 120, fresh: true });
  assert.deepEqual(result.assets[3]!.oracle, { status: 'stale', publishTime: now - 601, ageSeconds: 601, maxAgeSeconds: 600, fresh: false });
});

test('token.list fails closed for missing, wrong-owner, partial, mismatched, and malformed feeds', async () => {
  const f = fixture();
  f.accounts[0] = null;
  f.accounts[1] = priceAccount(feeds[1]!.feedId, now - 1, PublicKey.default);
  f.accounts[2] = priceAccount(feeds[2]!.feedId, now - 1, receiver, 0);
  f.accounts[3] = priceAccount(feeds[4]!.feedId, now - 1);
  f.accounts[4] = { ...f.accounts[4]!, data: Buffer.alloc(5) };
  const result = await f.service.read('token.list', { checkPrices: true }) as { assets: Array<{ oracle: { status: string; fresh: boolean; publishTime: number | null } }> };
  assert.deepEqual(result.assets.slice(0, 5).map(asset => asset.oracle.status), ['missing', 'invalid', 'invalid', 'invalid', 'invalid']);
  assert.ok(result.assets.slice(0, 5).every(asset => !asset.oracle.fresh && asset.oracle.publishTime === null));
});

test('token.list rejects a missing or malformed on-chain Clock', async () => {
  const f = fixture();
  f.accounts[f.accounts.length - 1] = null;
  await assert.rejects(f.service.read('token.list', { checkPrices: true }), error => (error as { code: string }).code === 'ORACLE_RESPONSE_INVALID');
  f.accounts[f.accounts.length - 1] = { data: Buffer.alloc(40), owner: SYSVAR_CLOCK_PUBKEY, executable: false, lamports: 1, rentEpoch: 0 };
  await assert.rejects(f.service.read('token.list', { checkPrices: true }), error => (error as { code: string }).code === 'ORACLE_RESPONSE_INVALID');
});

test('token.list does not check mainnet feed accounts on devnet', async () => {
  const f = fixture();
  f.service.config.network = 'devnet';
  await assert.rejects(f.service.read('token.list', { checkPrices: true }), error => (error as { code: string }).code === 'UNSUPPORTED_ASSET');
  assert.deepEqual(f.reads(), { genesisReads: 0, batchReads: 0 });
});
