import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { AddressLookupTableAccount, Keypair, PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import type { RebalanceIntent, Vault } from '@symmetry-hq/sdk';
import { VAULTS_V3_PROGRAM_ID, PYTHNET_CUSTODY_PRICE_WSOL_ACCOUNT, PYTHNET_CUSTODY_PRICE_USDC_ACCOUNT } from '@symmetry-hq/sdk/dist/constants.js';
import { OracleType } from '@symmetry-hq/sdk/dist/layouts/oracle.js';
import { getPythPriceFeedAccountAddress } from '@symmetry-hq/sdk/dist/states/oracles/pythOracle.js';
import { parse } from '../src/commands.js';
import { configSchema } from '../src/config.js';
import { hermesClient, priceTransactions } from '../src/prices.js';
import registry from '../src/oracles.json' with { type: 'json' };

const address = () => Keypair.generate().publicKey;
const config = configSchema.parse({ hermesUrl: 'https://prices.example/base/', timeoutMs: 1000 });

test('Hermes request sends bearer auth, deduplicates feeds, and disables redirects', async () => {
  const previous = process.env.PYTH_API_KEY;
  process.env.PYTH_API_KEY = 'offline-test-secret';
  try {
    let requests = 0;
    const client = hermesClient(config, async (url, init) => {
      requests++;
      const parsed = new URL(String(url));
      assert.equal(parsed.origin + parsed.pathname, 'https://prices.example/base/v2/updates/price/latest');
      assert.deepEqual(parsed.searchParams.getAll('ids[]'), ['0xaaa', '0xbbb']);
      assert.equal(parsed.searchParams.get('encoding'), 'base64');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer offline-test-secret');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      return new Response(JSON.stringify({ binary: { data: ['AQID'] } }));
    });
    assert.deepEqual(await client.getLatestPriceUpdates(['0xaaa', '0xbbb', '0xaaa'], { encoding: 'base64' }), { binary: { data: ['AQID'] } });
    assert.equal(requests, 1);
  } finally {
    if (previous === undefined) delete process.env.PYTH_API_KEY;
    else process.env.PYTH_API_KEY = previous;
  }
});

test('Hermes authentication failure does not leak the API key or response body', async () => {
  const previous = process.env.PYTH_API_KEY;
  process.env.PYTH_API_KEY = 'offline-unique-secret';
  try {
    await assert.rejects(hermesClient(config, async () => new Response('upstream-secret-body', { status: 401 })).getLatestPriceUpdates(['0xaaa'], { encoding: 'base64' }), error => {
      assert.equal((error as { code?: string }).code, 'ORACLE_AUTH_REQUIRED');
      assert.doesNotMatch(String(error), /offline-unique-secret|upstream-secret-body/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.PYTH_API_KEY;
    else process.env.PYTH_API_KEY = previous;
  }
});

test('Hermes URL rejects credentials, redirects, and query secrets', () => {
  for (const url of ['http://prices.example', 'https://user:password@prices.example', 'https://prices.example/?key=secret', 'https://prices.example/#secret']) {
    assert.equal(configSchema.safeParse({ hermesUrl: url }).success, false);
  }
});

test('Hermes rejects malformed and oversized responses', async () => {
  for (const body of ['not json', '{}', JSON.stringify({ binary: { data: [] } }), JSON.stringify({ binary: { data: ['***'] } }), 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    await assert.rejects(hermesClient(config, async () => new Response(body)).getLatestPriceUpdates(['0xaaa'], { encoding: 'base64' }), error => {
      assert.equal((error as { code?: string }).code, 'ORACLE_RESPONSE_INVALID');
      return true;
    });
  }
});

test('Hermes stops reading when a streamed response exceeds 4 MiB', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.alloc(3 * 1024 * 1024));
      controller.enqueue(Buffer.alloc(2 * 1024 * 1024));
    },
    cancel() { cancelled = true; },
  });
  const fetcher = async () => new Response(body, { headers: { 'content-length': '1' } });
  await assert.rejects(hermesClient(config, fetcher).getLatestPriceUpdates(['0xaaa'], { encoding: 'base64' }), error => {
    assert.equal((error as { code?: string }).code, 'ORACLE_RESPONSE_INVALID');
    return true;
  });
  assert.equal(cancelled, true);
});

function priceFixture(numTokens: number, oraclesPerToken = 1, complexAt = -1) {
  const keeper = address(), vaultKey = address(), intent = address(), mint = address(), feeds = Array.from({ length: numTokens * oraclesPerToken }, address), lutKeys = [address(), address()];
  const lutBytes = (addresses: PublicKey[]) => {
    const data = Buffer.alloc(56 + addresses.length * 32);
    data.writeUInt32LE(1, 0);
    data.writeBigUInt64LE((1n << 64n) - 1n, 4);
    addresses.forEach((key, index) => key.toBuffer().copy(data, 56 + index * 32));
    return data;
  };
  const luts = lutKeys.map((key, index) => new AddressLookupTableAccount({ key, state: AddressLookupTableAccount.deserialize(lutBytes(index === 0 ? feeds : [])) }));
  const vault = {
    ownAddress: vaultKey, mint, numTokens, lutPubkeys: luts,
    lookupTables: { active: lutKeys },
    settings: { activeRebalance: new BN(0), fees: { hostPerformanceFeeBps: 0, creatorPerformanceFeeBps: 0, managersPerformanceFeeBps: 0 } },
    composition: Array.from({ length: numTokens }, (_, index) => ({ mint: address(), active: 1, amount: new BN(0), oracleAggregator: { numOracles: oraclesPerToken, oracles: Array.from({ length: oraclesPerToken }, (_, oracle) => ({ oracleSettings: { oracleType: index === complexAt ? OracleType.RaydiumCpmm : OracleType.Pyth, numRequiredAccounts: 1 }, accountsToLoadLutIds: [0], accountsToLoadLutIndices: [index * oraclesPerToken + oracle] })) } })),
  } as unknown as Vault;
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: address().toBase58(), lastValidBlockHeight: 100 }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(key => ({ data: lutBytes(key.equals(lutKeys[0]!) ? feeds : []), owner: address(), lamports: 1, executable: false, rentEpoch: 0 })),
  } as unknown as Connection;
  const intentTokens = vault.composition.map(asset => ({ mint: asset.mint, amount: new BN(0) })) as RebalanceIntent['tokens'];
  return { keeper, vaultKey, intent, feeds, lutKeys, luts, vault, connection, intentTokens };
}

test('default price update avoids Hermes and builds a direct Symmetry instruction with exact oracle accounts', async () => {
  const { keeper, vaultKey, intent, feeds, lutKeys, luts, vault, connection, intentTokens } = priceFixture(2);
  const refreshPyth = parse('rebalance.prices', { intent: intent.toBase58() }).refreshPyth;
  assert.equal(refreshPyth, false);
  assert.equal(parse('rebalance.prices', { intent: intent.toBase58(), refreshPyth: true }).refreshPyth, true);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected Hermes request'); };
  let result: Awaited<ReturnType<typeof priceTransactions>>;
  try { result = await priceTransactions(connection, config, vault, intent, keeper, refreshPyth, intentTokens); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(requests, 0);
  assert.deepEqual(result.batches.map(batch => batch.transactions.length), [2]);
  const tx = VersionedTransaction.deserialize(Buffer.from(result.batches[0]!.transactions[0]!.tx_b64, 'base64'));
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: luts });
  const protocol = tx.message.compiledInstructions.filter(ix => keys.get(ix.programIdIndex)!.equals(VAULTS_V3_PROGRAM_ID));
  assert.equal(protocol.length, 1);
  assert.deepEqual([...protocol[0]!.data.subarray(8)], [0, ...Array(19).fill(255)]);
  const accounts = protocol[0]!.accountKeyIndexes.map(index => keys.get(index)!.toBase58());
  for (const key of [keeper, vaultKey, intent, ...lutKeys, feeds[0]!, PYTHNET_CUSTODY_PRICE_WSOL_ACCOUNT, PYTHNET_CUSTODY_PRICE_USDC_ACCOUNT]) assert.ok(accounts.includes(key.toBase58()), key.toBase58());
  assert.deepEqual(accounts.slice(-1), [feeds[0]!.toBase58()]);
  assert.equal(tx.message.staticAccountKeys[0]!.toBase58(), keeper.toBase58());
});

test('100-token price updates cover every index in bounded Pyth batches', async () => {
  const { keeper, intent, luts, vault, connection, intentTokens } = priceFixture(100);
  const result = await priceTransactions(connection, config, vault, intent, keeper, false, intentTokens);
  assert.deepEqual(result.batches.map(batch => batch.transactions.length), [11]);
  const covered = result.batches[0]!.transactions.flatMap((payload, batch) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.tx_b64, 'base64'));
    const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: luts });
    const ix = tx.message.compiledInstructions.find(ix => keys.get(ix.programIdIndex)!.equals(VAULTS_V3_PROGRAM_ID))!;
    const count = batch === 10 ? 1 : batch === 9 ? 9 : 10;
    assert.deepEqual([...ix.data.subarray(8 + count)], Array(20 - count).fill(255));
    return [...ix.data.subarray(8, 8 + count)];
  });
  assert.deepEqual(covered, Array.from({ length: 100 }, (_, index) => index));
});

test('price batching counts multiple feeds per token and isolates complex oracle tokens', async () => {
  for (const [tokens, feeds, complex, batches] of [[25, 2, -1, 6], [3, 1, 1, 3]] as const) {
    const { keeper, intent, vault, connection, intentTokens } = priceFixture(tokens, feeds, complex);
    const result = await priceTransactions(connection, config, vault, intent, keeper, false, intentTokens);
    assert.deepEqual(result.batches.map(batch => batch.transactions.length), [batches]);
  }
});

test('price updates exclude inactive empty slots but retain inactive tokens holding vault or intent funds', async () => {
  const { keeper, intent, vault, connection, intentTokens, luts } = priceFixture(5);
  for (const index of [0, 1, 2, 4]) vault.composition[index]!.active = 0;
  vault.composition[1]!.amount = new BN(1);
  intentTokens[2]!.amount = new BN(1);
  const result = await priceTransactions(connection, config, vault, intent, keeper, false, intentTokens);
  const indices = result.batches[0]!.transactions.map(payload => {
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.tx_b64, 'base64'));
    const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: luts });
    const ix = tx.message.compiledInstructions.find(ix => keys.get(ix.programIdIndex)!.equals(VAULTS_V3_PROGRAM_ID))!;
    return [...ix.data.subarray(8)].filter(index => index !== 255);
  });
  assert.deepEqual(indices, [[1, 2], [3]]);
});

test('guarded CLMM prices include current tick arrays from the pool owner and isolate their batch', async () => {
  for (const type of [OracleType.RaydiumClmm, OracleType.ByrealClmm]) {
    for (const owner of ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH']) {
      const f = priceFixture(2, 2), oracle = f.vault.composition[0]!.oracleAggregator.oracles[0]!;
      f.vault.composition[0]!.oracleAggregator.numOracles = 1;
      oracle.oracleSettings.oracleType = type; oracle.oracleSettings.numRequiredAccounts = 2; oracle.oracleSettings.minLiquidity = new BN(1);
      oracle.accountsToLoadLutIds = [0, 0]; oracle.accountsToLoadLutIndices = [0, 1];
      const data = Buffer.alloc(1600); data.writeUInt16LE(16, 235); data.writeInt32LE(1025, 269);
      const getAccounts = f.connection.getMultipleAccountsInfo.bind(f.connection);
      f.connection.getMultipleAccountsInfo = async keys => keys[0]!.equals(f.feeds[0]!)
        ? keys.map(() => ({ data, owner: new PublicKey(owner), lamports: 1, executable: false, rentEpoch: 0 })) : getAccounts(keys);
      const payload = await priceTransactions(f.connection, config, f.vault, f.intent, f.keeper, false, f.intentTokens);
      assert.equal(payload.batches[0]!.transactions.length, 2);
      const ix = payload.batches[0]!.transactions[0]!.instructions[0]!;
      const expected = [0, 960, 1920].map(tick => {
        const index = Buffer.alloc(4); index.writeInt32BE(tick);
        return PublicKey.findProgramAddressSync([Buffer.from('tick_array'), f.feeds[0]!.toBuffer(), index], new PublicKey(owner))[0].toBase58();
      });
      assert.deepEqual(ix.accounts.slice(-5).map(account => account.pubkey), [f.feeds[0]!.toBase58(), f.feeds[1]!.toBase58(), ...expected]);
      f.connection.getMultipleAccountsInfo = async () => [null];
      await assert.rejects(priceTransactions(f.connection, config, f.vault, f.intent, f.keeper, false, f.intentTokens), error => (error as { code: string }).code === 'ORACLE_ACCOUNT_MISSING');
    }
  }
});

test('explicit Pyth refresh preserves multiple shards of one feed through the real SDK encoder', async () => {
  const f = priceFixture(2), feedId = '09'.repeat(32);
  f.feeds[0] = getPythPriceFeedAccountAddress(1, Buffer.from(feedId, 'hex'));
  f.feeds[1] = getPythPriceFeedAccountAddress(3, Buffer.from(feedId, 'hex'));
  f.luts[0]!.state.addresses = f.feeds;
  const ids = new Map<string, string>([
    [PYTHNET_CUSTODY_PRICE_WSOL_ACCOUNT.toBase58(), registry['So11111111111111111111111111111111111111112'].feedId],
    [PYTHNET_CUSTODY_PRICE_USDC_ACCOUNT.toBase58(), registry['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'].feedId],
    ...f.feeds.map(key => [key.toBase58(), feedId] as [string, string]),
  ]);
  const getAccounts = f.connection.getMultipleAccountsInfo.bind(f.connection);
  f.connection.getMultipleAccountsInfo = async keys => ids.has(keys[0]!.toBase58()) ? keys.map(key => {
    const data = Buffer.alloc(133); data[40] = 1; Buffer.from(ids.get(key.toBase58())!, 'hex').copy(data, 41);
    return { data, owner: new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ'), lamports: 1, executable: false, rentEpoch: 0 };
  }) : getAccounts(keys);
  const fetcher = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async url => {
    requests++;
    const requested = new URL(String(url)).searchParams.getAll('ids[]');
    assert.equal(requested.filter(id => id.replace(/^0x/, '') === feedId).length, 1);
    // Offline serialization fixture only: no valid guardian signatures, no simulation/submission.
    const vaa = Buffer.alloc(64), header = Buffer.from('504e4155010000000000', 'hex'); header.writeUInt16BE(vaa.length, 8);
    const messages = requested.map(id => {
      const message = Buffer.alloc(85); Buffer.from(id.replace(/^0x/, ''), 'hex').copy(message, 1);
      const size = Buffer.alloc(2); size.writeUInt16BE(message.length);
      return Buffer.concat([size, message, Buffer.from([0])]);
    });
    return new Response(JSON.stringify({ binary: { data: [Buffer.concat([header, vaa, Buffer.from([messages.length]), ...messages]).toString('base64')] } }));
  };
  try {
    const payload = await priceTransactions(f.connection, config, f.vault, f.intent, f.keeper, true, f.intentTokens);
    assert.equal(requests, 1);
    assert.deepEqual(payload.batches.map(batch => batch.transactions.length), [1, 1, 4, 2, 1]);
    const updates = payload.batches[2]!.transactions.map(tx => tx.instructions[0]!);
    assert.deepEqual(updates.map(ix => ix.accounts[5]!.pubkey).sort(), [...ids.keys()].sort());
    const shardUpdates = updates.filter(ix => f.feeds.some(key => key.toBase58() === ix.accounts[5]!.pubkey));
    assert.deepEqual(shardUpdates.map(ix => { const bytes = Buffer.from(ix.data, 'base64'); return bytes.readUInt16LE(bytes.length - 34); }), [1, 3]);
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.batches[0]!.transactions[0]!.tx_b64, 'base64'));
    assert.equal(tx.message.header.numRequiredSignatures, 2);
    assert.ok(tx.signatures[1]!.some(byte => byte !== 0), 'SDK VAA signer must be retained');
    assert.ok(tx.signatures[0]!.every(byte => byte === 0), 'User signature remains external');
    const noncanonical = address(); ids.set(noncanonical.toBase58(), feedId); f.luts[0]!.state.addresses[0] = noncanonical;
    await assert.rejects(priceTransactions(f.connection, config, f.vault, f.intent, f.keeper, true, f.intentTokens), /canonical feed/);
    assert.equal(requests, 1, 'Noncanonical identities fail before contacting Hermes');
  } finally { globalThis.fetch = fetcher; }
});
