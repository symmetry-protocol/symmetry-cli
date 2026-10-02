import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { Service } from '../src/service.js';
import { Transactions, type Plan } from '../src/transactions.js';
import { configSchema } from '../src/config.js';
import type { Action } from '../src/commands.js';

async function fixture(count = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'symmetry-tx-'));
  const wallet = Keypair.generate(), owner = wallet.publicKey.toBase58(), recipient = Keypair.generate().publicKey;
  const walletPath = join(directory, 'wallet.json');
  await writeFile(walletPath, JSON.stringify([...wallet.secretKey]), { mode: 0o600 });
  const sent: string[] = [], events: string[] = [], confirmed = new Set<string>();
  let buildCount = 0, simulations = 0, failSimulation = 0, interrupt = false, valid = true, chainError = false, dropped = 0;
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    getFeeForMessage: async () => ({ value: 5000 }),
    simulateTransaction: async () => { events.push('simulate'); simulations++; return { value: { err: simulations === failSimulation ? { InstructionError: [0, 'Custom'] } : null, logs: ['simulated'] } }; },
    getSignatureStatuses: async (signatures: string[]) => {
      if (interrupt && sent.length) { interrupt = false; throw new Error('connection lost after broadcast'); }
      return { value: signatures.map(signature => confirmed.has(signature) ? { err: chainError ? { InstructionError: [0, 1] } : null, confirmationStatus: 'confirmed', slot: 1 } : null) };
    },
    isBlockhashValid: async () => ({ value: valid }),
    sendRawTransaction: async (bytes: Uint8Array) => {
      events.push('send');
      const tx = VersionedTransaction.deserialize(bytes), signature = bs58.encode(tx.signatures[0]!);
      const journal = JSON.parse(await readFile(transactions.path(plan.id, 'journal.json'), 'utf8'));
      assert.ok(journal.phases.some((phase: { transactions: { signature?: string; signed?: string }[] }) => phase.transactions.some(item => item.signature === signature && item.signed === Buffer.from(bytes).toString('base64'))), 'signed bytes must be durable before broadcast');
      sent.push(signature); if (dropped > 0) dropped--; else confirmed.add(signature); return signature;
    },
  } as unknown as Connection;
  const service = new Service(configSchema.parse({ owner, wallet: walletPath, rpcUrl: 'http://localhost:8899', timeoutMs: 1000 }), connection);
  service.checkNetwork = async () => {};
  service.owner = async () => owner;
  const actions: Action[] = Array.from({ length: count }, () => ({ command: 'vault.bounty', input: { vault: recipient.toBase58(), amount: '1' } }));
  service.expand = async () => ({ actions });
  service.build = async () => {
    buildCount++; events.push('build');
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: buildCount })] }).compileToV0Message());
    return { batches: [{ transactions: [{ tx_b64: Buffer.from(transaction.serialize()).toString('base64'), message_version: '0', recent_blockhash: transaction.message.recentBlockhash, payer: owner, lookup_tables: [], instructions: [] }] }] };
  };
  service.verify = async () => ({ transactionsConfirmed: true });
  const transactions = new Transactions(service, directory);
  const plan = await transactions.prepare('vault.bounty', { vault: recipient.toBase58(), amount: '1' }) as Plan;
  return { directory, service, transactions, plan, wallet, sent, events, confirmed,
    simulationFailure: (at: number) => { failSimulation = at; }, interrupt: () => { interrupt = true; }, expire: () => { valid = false; }, chainFailure: () => { chainError = true; },
    drop: () => { dropped = 1; },
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}
test('prepare and simulate never sign or broadcast; simulation covers only the ready step', async () => {
  const f = await fixture(2);
  try {
    const result = await f.transactions.simulate(f.plan.id);
    assert.equal(result.scope, 'next_transaction_only');
    assert.equal(f.sent.length, 0);
    const journal = await f.transactions.journal(f.plan);
    assert.equal(journal.phases.length, 1);
    assert.equal(journal.phases[0]!.transactions[0]!.signed, undefined);
  } finally { await f.cleanup(); }
});
test('execution requires approval digest and matching wallet before signing', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.transactions.execute(f.plan.id, 'wrong'), /exact reviewed/);
    const other = Keypair.generate();
    await writeFile(f.service.config.wallet!, JSON.stringify([...other.secretKey]));
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest), /does not own/);
    assert.equal(f.sent.length, 0);
  } finally { await f.cleanup(); }
});
test('dependent phases build after confirmation and never repeat after completion', async () => {
  const f = await fixture(2);
  try {
    await f.transactions.execute(f.plan.id, f.plan.digest);
    assert.deepEqual(f.events, ['build', 'simulate', 'send', 'build', 'simulate', 'send']);
    await f.transactions.execute(f.plan.id, f.plan.digest);
    assert.equal(f.sent.length, 2);
    assert.equal((await f.transactions.inspect(f.plan.id)).state, 'confirmed');
  } finally { await f.cleanup(); }
});
test('partial simulation failure preserves completed transactions for safe resume', async () => {
  const f = await fixture(2);
  try {
    f.simulationFailure(2);
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest), /simulation/);
    assert.equal(f.sent.length, 1);
    await f.transactions.execute(f.plan.id, f.plan.digest);
    assert.equal(f.sent.length, 2);
    assert.equal(new Set(f.sent).size, 2);
  } finally { await f.cleanup(); }
});
test('crash after broadcast resumes by signature without a duplicate send', async () => {
  const f = await fixture(2);
  try {
    f.interrupt();
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest), error => (error as { code: string; details: { planId: string } }).code === 'EXECUTION_INTERRUPTED' && (error as { details: { planId: string } }).details.planId === f.plan.id);
    assert.equal(f.sent.length, 1);
    await f.transactions.execute(f.plan.id, f.plan.digest);
    assert.equal(f.sent.length, 2);
  } finally { await f.cleanup(); }
});
test('restart after durable signing but before broadcast reuses the exact signature', async () => {
  const f = await fixture();
  try {
    const connection = f.service.connection as any;
    const original = connection.getSignatureStatuses;
    connection.getSignatureStatuses = async () => { throw new Error('RPC unavailable before broadcast'); };
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest), error => (error as { code?: string }).code === 'EXECUTION_INTERRUPTED');
    const signed = (await f.transactions.journal(f.plan)).phases[0]!.transactions[0]!;
    assert.ok(signed.signed && signed.signature);
    assert.equal(f.sent.length, 0);
    connection.getSignatureStatuses = original;
    const resumed = new Transactions(f.service, f.directory);
    await resumed.execute(f.plan.id, f.plan.digest);
    assert.deepEqual(f.sent, [signed.signature]);
    assert.equal(f.events.filter(event => event === 'simulate').length, 1);
  } finally { await f.cleanup(); }
});
test('lost RPC send response reconciles the confirmed signature without rebroadcast', async () => {
  const f = await fixture();
  try {
    const connection = f.service.connection as any;
    const original = connection.sendRawTransaction;
    connection.sendRawTransaction = async (...args: unknown[]) => {
      await original(...args);
      throw new Error('RPC response dropped after acceptance');
    };
    await f.transactions.execute(f.plan.id, f.plan.digest);
    assert.equal(f.sent.length, 1);
    assert.equal((await f.transactions.inspect(f.plan.id)).state, 'confirmed');
  } finally { await f.cleanup(); }
});
test('an uncertain expired transaction is never re-signed or replaced', async () => {
  const f = await fixture();
  try {
    f.interrupt();
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest));
    f.confirmed.clear(); f.expire();
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest), /expired without confirmed/);
    assert.equal(f.sent.length, 1);
  } finally { await f.cleanup(); }
});
test('expired durable signature is not rebuilt even when broadcast was not acknowledged', async () => {
  const f = await fixture();
  try {
    const connection = f.service.connection as any;
    const original = connection.getSignatureStatuses;
    connection.getSignatureStatuses = async () => { throw new Error('RPC unavailable'); };
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest), error => (error as { code?: string }).code === 'EXECUTION_INTERRUPTED');
    const before = (await f.transactions.journal(f.plan)).phases[0]!.transactions[0]!;
    assert.ok(before.signed && before.signature);
    connection.getSignatureStatuses = original;
    f.expire();
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest), /expired without confirmed/);
    const after = (await f.transactions.journal(f.plan)).phases[0]!.transactions[0]!;
    assert.equal(after.signed, before.signed);
    assert.equal(after.signature, before.signature);
    assert.equal(f.sent.length, 0);
  } finally { await f.cleanup(); }
});
test('failed on-chain transaction stops dependent phases', async () => {
  const f = await fixture(2);
  try {
    f.chainFailure();
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest), /failed on-chain/);
    assert.equal(f.sent.length, 1);
    assert.equal((await f.transactions.journal(f.plan)).phases.length, 1);
  } finally { await f.cleanup(); }
});
test('a later confirmed on-chain error preserves earlier success and never retries the failed signature', async () => {
  const f = await fixture(2);
  try {
    const connection = f.service.connection as any;
    const original = connection.getSignatureStatuses;
    connection.getSignatureStatuses = async (signatures: string[], options: unknown) => {
      const response = await original(signatures, options);
      return { value: response.value.map((status: any, index: number) => status && signatures[index] === f.sent[1] ? { ...status, err: { InstructionError: [0, 1] } } : status) };
    };
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest), /failed on-chain/);
    const journal = await f.transactions.journal(f.plan);
    assert.equal(journal.phases[0]!.transactions[0]!.confirmed, true);
    assert.equal(journal.phases[1]!.transactions[0]!.confirmed, undefined);
    assert.equal(f.sent.length, 2);
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest), /failed on-chain/);
    assert.equal(f.sent.length, 2);
  } finally { await f.cleanup(); }
});
test('concurrent execution of the same owner is rejected while a signer holds the lock', async () => {
  const f = await fixture();
  try {
    const connection = f.service.connection as any;
    const original = connection.simulateTransaction;
    let entered!: () => void, release!: () => void;
    const atSimulation = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    connection.simulateTransaction = async (...args: unknown[]) => { entered(); await held; return original(...args); };
    const first = f.transactions.execute(f.plan.id, f.plan.digest);
    await atSimulation;
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest), error => (error as { code?: string }).code === 'BUSY');
    release(); await first;
    assert.equal(f.sent.length, 1);
  } finally { await f.cleanup(); }
});
test('external signing verifies message bytes and every required signature', async () => {
  const f = await fixture(2);
  try {
    f.service.config.wallet = undefined;
    const next = await f.transactions.next(f.plan.id);
    assert.ok('transactionBase64' in next);
    const tx = VersionedTransaction.deserialize(Buffer.from(next.transactionBase64, 'base64'));
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest, next.transactionBase64), /invalid signature/i);
    tx.sign([f.wallet]);
    const signed = Buffer.from(tx.serialize()).toString('base64');
    const result = await f.transactions.execute(f.plan.id, f.plan.digest, signed);
    assert.equal(result.status, 'next_transaction_required');
    assert.equal(f.sent.length, 1);
    const second = await f.transactions.next(f.plan.id);
    assert.ok('transactionBase64' in second);
    assert.equal((await f.transactions.execute(f.plan.id, f.plan.digest, signed)).signature, result.signature);
    const tx2 = VersionedTransaction.deserialize(Buffer.from(second.transactionBase64, 'base64'));
    tx2.message.recentBlockhash = PublicKey.default.toBase58(); tx2.sign([f.wallet]);
    await assert.rejects(f.transactions.execute(f.plan.id, f.plan.digest, Buffer.from(tx2.serialize()).toString('base64')), /does not match/);
    assert.equal(f.sent.length, 1);
  } finally { await f.cleanup(); }
});
test('plan tampering and path traversal are rejected', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.transactions.load('../../wallet'));
    const path = f.transactions.path(f.plan.id, 'plan.json');
    const plan = JSON.parse(await readFile(path, 'utf8'));
    plan.owner = Keypair.generate().publicKey.toBase58();
    await writeFile(path, JSON.stringify(plan));
    await assert.rejects(f.transactions.load(f.plan.id), /modified/);
  } finally { await f.cleanup(); }
});
test('request IDs return the same plan and reject changed input', async () => {
  const f = await fixture();
  try {
    const input = f.plan.input;
    const one = await f.transactions.prepare('vault.bounty', input, 'purchase-1') as Plan;
    const two = await f.transactions.prepare('vault.bounty', input, 'purchase-1') as Plan;
    assert.equal(one.id, two.id);
    await assert.rejects(f.transactions.prepare('vault.bounty', { ...(input as object), amount: '2' }, 'purchase-1'), /different arguments/);
    assert.equal(f.sent.length, 0);
    assert.ok((await f.transactions.list()).some(plan => plan.id === one.id));
  } finally { await f.cleanup(); }
});
test('plan listing survives an interrupted prepare that left an empty plan directory', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.directory, 'plans', '00000000-0000-4000-8000-000000000000'));
    assert.deepEqual((await f.transactions.list()).map(plan => plan.id), [f.plan.id]);
  } finally { await f.cleanup(); }
});
test('plans bind the fee setting and selected network', async () => {
  const f = await fixture();
  try {
    f.service.config.priorityFee++;
    await assert.rejects(f.transactions.load(f.plan.id), /priority fee/);
    f.service.config.priorityFee--; f.service.config.network = 'devnet';
    await assert.rejects(f.transactions.load(f.plan.id), /network recorded/);
  } finally { await f.cleanup(); }
});
test('a dropped submission is rebroadcast with identical signed bytes', async () => {
  const f = await fixture();
  try {
    f.service.config.timeoutMs = 5000; f.drop();
    await f.transactions.execute(f.plan.id, f.plan.digest);
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[0], f.sent[1]);
  } finally { await f.cleanup(); }
});
test('SDK partial signatures and their blockhash survive local signing', async () => {
  const f = await fixture();
  try {
    const secondSigner = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58();
    f.service.build = async () => {
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: f.wallet.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: secondSigner.publicKey, toPubkey: f.wallet.publicKey, lamports: 1 })] }).compileToV0Message());
      tx.sign([secondSigner]);
      return { batches: [{ transactions: [{ tx_b64: Buffer.from(tx.serialize()).toString('base64'), message_version: '0', recent_blockhash: blockhash, payer: f.wallet.publicKey.toBase58(), lookup_tables: [], instructions: [] }] }] };
    };
    // Replace the unused initial fixture phase with the real partially signed payload.
    const journal = await f.transactions.journal(f.plan);
    journal.phases = [f.transactions.phase(await f.service.build(f.plan.actions[0]!, f.plan.owner), f.plan.owner)];
    await f.transactions.persist(f.plan, journal);
    const next = await f.transactions.next(f.plan.id);
    assert.ok('transactionBase64' in next);
    assert.equal(VersionedTransaction.deserialize(Buffer.from(next.transactionBase64, 'base64')).message.recentBlockhash, blockhash);
    await f.transactions.execute(f.plan.id, f.plan.digest);
    assert.equal(f.sent.length, 1);
  } finally { await f.cleanup(); }
});
test('external payer signing preserves and verifies an SDK cosigner signature', async () => {
  const f = await fixture();
  try {
    const cosigner = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: f.wallet.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: cosigner.publicKey, toPubkey: f.wallet.publicKey, lamports: 1 })] }).compileToV0Message());
    tx.sign([cosigner]);
    const journal = await f.transactions.journal(f.plan);
    journal.phases = [{ transactions: [{ transaction: Buffer.from(tx.serialize()).toString('base64') }] }];
    await f.transactions.persist(f.plan, journal);
    f.service.config.wallet = undefined;
    const next = await f.transactions.next(f.plan.id);
    assert.ok('transactionBase64' in next);
    const exported = VersionedTransaction.deserialize(Buffer.from(next.transactionBase64, 'base64'));
    assert.equal(exported.message.recentBlockhash, blockhash);
    const cosignerIndex = exported.message.staticAccountKeys.findIndex(key => key.equals(cosigner.publicKey));
    const cosignerSignature = Buffer.from(exported.signatures[cosignerIndex]!);
    exported.sign([f.wallet]);
    assert.deepEqual(Buffer.from(exported.signatures[cosignerIndex]!), cosignerSignature);
    await f.transactions.execute(f.plan.id, f.plan.digest, Buffer.from(exported.serialize()).toString('base64'));
    assert.equal(f.sent.length, 1);
  } finally { await f.cleanup(); }
});
