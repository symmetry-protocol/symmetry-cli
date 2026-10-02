import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Keypair, VersionedTransaction, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { GlobalConfig, SymmetryCore, Vault } from '@symmetry-hq/sdk';
import { VAULTS_V3_PROGRAM_ID } from '@symmetry-hq/sdk/dist/constants.js';
import { getRebalanceIntentPda, getVaultState } from '@symmetry-hq/sdk/dist/instructions/pda.js';
import { claimableFeeTypes, withdrawFeeTransactions } from '../src/fees.js';
import { configSchema } from '../src/config.js';

function fixture() {
  const owner = Keypair.generate().publicKey, manager = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, asset = Keypair.generate().publicKey;
  const vault = { ownAddress: getVaultState(mint), mint, numTokens: 1, composition: [{ mint: asset }], settings: { activeRebalance: new BN(0), creator: owner, host: owner, managers: { managers: [manager] } }, accumulatedFees: { symmetryFees: new BN(0), creatorFees: new BN(123), hostFees: new BN(0), managersFees: new BN(0) } } as unknown as Vault;
  const global = { symmetryFeeCollector: owner } as GlobalConfig;
  const connection = {
    getMultipleAccountsInfo: async (keys: typeof owner[]) => keys.map(key => key.equals(asset) ? { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82), lamports: 1, executable: false, rentEpoch: 0 } : null),
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
  } as unknown as Connection;
  const sdk = { fetchGlobalConfig: async () => global } as unknown as SymmetryCore;
  return { owner, manager, vault, global, connection, sdk, config: configSchema.parse({}) };
}

test('fee withdrawal includes positive authorized categories and excludes empty categories', async () => {
  const f = fixture();
  const payload = await withdrawFeeTransactions(f.connection, f.config, f.sdk, f.vault, f.owner);
  assert.deepEqual(payload.batches.map(batch => batch.transactions.length), [1, 1]);
  const tx = VersionedTransaction.deserialize(Buffer.from(payload.batches[0]!.transactions[0]!.tx_b64, 'base64'));
  const ix = tx.message.compiledInstructions.find(ix => tx.message.staticAccountKeys[ix.programIdIndex]!.equals(VAULTS_V3_PROGRAM_ID))!;
  assert.equal(ix.data[8], 1, 'Only accrued creator fees should be withdrawn');
  f.vault.accumulatedFees.creatorFees = new BN(0);
  await assert.rejects(withdrawFeeTransactions(f.connection, f.config, f.sdk, f.vault, f.owner), error => (error as { code: string }).code === 'NO_FEES');
});

test('manager fee authority includes creator but does not authorize strangers', () => {
  const f = fixture(); f.vault.accumulatedFees.managersFees = new BN(500);
  assert.deepEqual(claimableFeeTypes(f.vault, f.global, f.owner), [1, 3]);
  assert.deepEqual(claimableFeeTypes(f.vault, f.global, f.manager), [3]);
  assert.deepEqual(claimableFeeTypes(f.vault, f.global, Keypair.generate().publicKey), []);
});

test('fee transactions preserve the optional account slot and synchronize an active rebalance', async () => {
  const f = fixture(); f.vault.accumulatedFees.managersFees = new BN(500);
  for (const active of [0, 1]) {
    f.vault.settings.activeRebalance = new BN(active);
    const payload = await withdrawFeeTransactions(f.connection, f.config, f.sdk, f.vault, f.owner);
    assert.deepEqual(payload.batches[0]!.transactions.map(tx => Buffer.from(tx.instructions[0]!.data, 'base64')[8]), [1, 3]);
    for (const transaction of payload.batches[0]!.transactions) {
      const tx = VersionedTransaction.deserialize(Buffer.from(transaction.tx_b64, 'base64'));
      const keys = tx.message.getAccountKeys();
      const ix = tx.message.compiledInstructions.find(ix => keys.get(ix.programIdIndex)!.equals(VAULTS_V3_PROGRAM_ID))!;
      const accountIndex = ix.accountKeyIndexes[7]!;
      assert.equal(keys.get(accountIndex)!.toBase58(), (active ? getRebalanceIntentPda(f.vault.ownAddress, f.vault.ownAddress) : VAULTS_V3_PROGRAM_ID).toBase58());
      assert.equal(tx.message.isAccountWritable(accountIndex), Boolean(active));
      assert.equal(keys.get(ix.accountKeyIndexes[8]!)!.toBase58(), '11111111111111111111111111111111');
    }
  }
});

test('existing fee withdrawal must be claimed before another withdrawal is built', async () => {
  const f = fixture(); f.connection.getMultipleAccountsInfo = async keys => keys.map(() => ({ lamports: 1 }) as never);
  await assert.rejects(withdrawFeeTransactions(f.connection, f.config, f.sdk, f.vault, f.owner), error => (error as { code: string }).code === 'PENDING_FEES');
});
