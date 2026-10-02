import { randomUUID, verify, createPublicKey } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PublicKey, VersionedTransaction, type Keypair } from '@solana/web3.js';
import type { TxPayloadBatchSequence } from '@symmetry-hq/sdk';
import bs58 from 'bs58';
import { z } from 'zod';
import { commands, parse, type Action, type CommandName } from './commands.js';
import { loadWallet } from './config.js';
import { CliError, digest, errorResult, readJson, saveJson, withLock } from './lib/utils.js';
import type { Service } from './service.js';

export type Plan = {
  schemaVersion: 1; id: string; network: 'mainnet' | 'devnet'; owner: string; priorityFee: number;
  command: CommandName; input: unknown; actions: Action[]; result?: unknown;
  createdAt: string; digest: string;
};
type Entry = { transaction: string; signature?: string; signed?: string; confirmed?: boolean };
type Phase = { transactions: Entry[] };
type Journal = { schemaVersion: 1; planDigest: string; phases: Phase[]; verification?: unknown };
const planId = z.string().uuid();

export class Transactions {
  constructor(readonly service: Service, readonly directory: string) {}
  path(id: string, file: string) { return join(this.directory, 'plans', planId.parse(id), file); }
  async load(id: string): Promise<Plan> {
    const plan = await readJson(this.path(id, 'plan.json')) as Plan;
    const { digest: expected, ...body } = plan;
    if (plan.schemaVersion !== 1 || plan.id !== id || expected !== digest(body)) throw new CliError('PLAN_INTEGRITY', 'Plan content or digest was modified.');
    if (plan.network !== this.service.config.network) throw new CliError('NETWORK_MISMATCH', 'Use the network recorded in this plan.');
    if (plan.priorityFee !== this.service.config.priorityFee) throw new CliError('PLAN_CONFIG_MISMATCH', 'Use the priority fee recorded in this plan.');
    if (!Array.isArray(plan.actions) || !plan.actions.length) throw new CliError('PLAN_INTEGRITY', 'Plan has no actions.');
    for (const action of plan.actions) {
      if (!(action.command in commands) || !commands[action.command].write) throw new CliError('PLAN_INTEGRITY', 'Invalid plan action.');
      parse(action.command, action.input);
    }
    return plan;
  }
  async journal(plan: Plan): Promise<Journal> {
    const journal = await readJson(this.path(plan.id, 'journal.json')) as Journal;
    if (journal.schemaVersion !== 1 || journal.planDigest !== plan.digest || !Array.isArray(journal.phases)) throw new CliError('PLAN_INTEGRITY', 'Journal does not match this plan.');
    return journal;
  }
  async persist(plan: Plan, journal: Journal) { await saveJson(this.path(plan.id, 'journal.json'), journal); }
  phase(payload: TxPayloadBatchSequence, owner: string): Phase {
    const transactions = payload.batches.flatMap(batch => batch.transactions).map(payload => {
      const tx = VersionedTransaction.deserialize(Buffer.from(payload.tx_b64, 'base64'));
      if (tx.message.staticAccountKeys[0]?.toBase58() !== owner) throw new CliError('PAYER_MISMATCH', 'SDK transaction uses an unexpected fee payer.');
      return { transaction: payload.tx_b64 };
    });
    if (!transactions.length) throw new CliError('EMPTY_TRANSACTION', 'SDK returned no transactions.');
    return { transactions };
  }
  async prepare(command: CommandName, input: unknown, requestId?: string): Promise<unknown> {
    const parsed = parse(command, input), owner = await this.service.owner();
    if (requestId !== undefined) {
      z.string().min(1).max(200).parse(requestId);
      const path = join(this.directory, 'requests', digest({ network: this.service.config.network, owner, requestId }) + '.json');
      return withLock(path + '.lock', async () => {
        const fingerprint = digest({ command, parsed, priorityFee: this.service.config.priorityFee });
        let previous: { fingerprint: string; planId: string } | undefined;
        try { previous = await readJson(path) as typeof previous; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new CliError('IDEMPOTENCY_CONFLICT', 'This request ID was already used with different arguments.');
          return this.inspect(previous.planId);
        }
        const plan = await this.prepare(command, parsed) as Plan;
        await saveJson(path, { fingerprint, planId: plan.id });
        return plan;
      });
    }
    const expanded = await this.service.expand(command, parsed, owner);
    const first = expanded.first ?? await this.service.build(expanded.actions[0]!, owner);
    const body = { schemaVersion: 1 as const, id: randomUUID(), network: this.service.config.network, priorityFee: this.service.config.priorityFee, owner, command, input: parsed, actions: expanded.actions, ...(expanded.result ? { result: expanded.result } : {}), createdAt: new Date().toISOString() };
    const plan: Plan = { ...body, digest: digest(body) };
    const journal: Journal = { schemaVersion: 1, planDigest: plan.digest, phases: [this.phase(first, owner)] };
    await saveJson(this.path(plan.id, 'plan.json'), plan);
    await this.persist(plan, journal);
    return this.inspect(plan.id);
  }
  async inspect(id: string) {
    const plan = await this.load(id), journal = await this.journal(plan);
    return { ...plan, state: journal.verification ? 'confirmed' : journal.phases.some(phase => phase.transactions.some(tx => tx.signature)) ? 'in_progress' : 'prepared', phases: plan.actions.map((action, index) => ({ ...action, transactions: journal.phases[index]?.transactions.map((tx, transaction) => ({ transaction, signature: tx.signature, confirmed: Boolean(tx.confirmed) })) ?? 'built_after_previous_phase_confirms' })), verification: journal.verification, next: `symmetry transaction next ${id}`, execute: `symmetry transaction execute ${id} --approve ${plan.digest}` };
  }
  async list() {
    let ids: string[];
    try { ids = await readdir(join(this.directory, 'plans')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const plans = [];
    for (const id of ids) {
      if (!planId.safeParse(id).success) continue;
      let plan: Plan;
      try { plan = await readJson(this.path(id, 'plan.json')) as Plan; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      plans.push({ id, network: plan.network, owner: plan.owner, command: plan.command, createdAt: plan.createdAt });
    }
    return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async locked<T>(id: string, run: (plan: Plan, journal: Journal) => Promise<T>) {
    const plan = await this.load(id);
    return withLock(join(this.directory, 'locks', `${plan.network}-${plan.owner}.lock`), async () => run(plan, await this.journal(plan)));
  }
  async pending(plan: Plan, journal: Journal): Promise<{ entry: Entry; phase: number; transaction: number } | null> {
    for (let phase = 0; phase < plan.actions.length; phase++) {
      if (!journal.phases[phase]) {
        const payload = await this.service.build(plan.actions[phase]!, plan.owner);
        journal.phases[phase] = this.phase(payload, plan.owner);
        await this.persist(plan, journal);
      }
      const entries = journal.phases[phase]!.transactions;
      const transaction = entries.findIndex(entry => !entry.confirmed);
      if (transaction >= 0) return { entry: entries[transaction]!, phase, transaction };
    }
    return null;
  }
  async fresh(entry: Entry): Promise<VersionedTransaction> {
    const tx = VersionedTransaction.deserialize(Buffer.from(entry.transaction, 'base64'));
    // Preserve SDK partial signatures. Changing their blockhash would invalidate them.
    if (!entry.signature && tx.signatures.every(signature => signature.every(byte => byte === 0))) {
      tx.message.recentBlockhash = (await this.service.connection.getLatestBlockhash('confirmed')).blockhash;
      entry.transaction = Buffer.from(tx.serialize()).toString('base64');
    }
    return tx;
  }
  assertAge(plan: Plan, journal: Journal) {
    // Creation embeds a recent slot for lookup-table derivation. Do not recycle stale creation plans.
    const limit = plan.command === 'vault.create' ? 90_000 : 15 * 60_000;
    if (!journal.phases.some(phase => phase.transactions.some(tx => tx.signature)) && Date.now() - Date.parse(plan.createdAt) > limit) throw new CliError('PLAN_EXPIRED', 'This unsubmitted plan is stale. Prepare and review a new plan.');
  }
  async next(id: string) {
    return this.locked(id, async (plan, journal) => {
      await this.service.checkNetwork();
      this.assertAge(plan, journal);
      const pending = await this.pending(plan, journal);
      if (!pending) return { complete: true, verification: await this.finish(plan, journal) };
      if (pending.entry.signature) throw new CliError('PENDING_TRANSACTION', 'Resume execution or resubmit the same signed transaction to reconcile its signature.', { signature: pending.entry.signature });
      const tx = await this.fresh(pending.entry);
      await this.persist(plan, journal);
      const lookupTables = await Promise.all(tx.message.addressTableLookups.map(async lookup => {
        const table = await this.service.connection.getAddressLookupTable(lookup.accountKey);
        if (!table.value) throw new CliError('LOOKUP_TABLE_MISSING', 'Transaction lookup table is unavailable.');
        return table.value;
      }));
      const accounts = tx.message.getAccountKeys({ addressLookupTableAccounts: lookupTables });
      const fee = await this.service.connection.getFeeForMessage(tx.message, 'confirmed');
      return { planId: id, digest: plan.digest, owner: plan.owner, network: plan.network, phase: pending.phase, transaction: pending.transaction, action: plan.actions[pending.phase], transactionBase64: pending.entry.transaction, feeLamports: fee.value, instructions: tx.message.compiledInstructions.map(ix => ({ program: accounts.get(ix.programIdIndex)!.toBase58(), accounts: ix.accountKeyIndexes.map(index => ({ address: accounts.get(index)!.toBase58(), writable: tx.message.isAccountWritable(index), signer: tx.message.isAccountSigner(index) })), dataBase64: Buffer.from(ix.data).toString('base64') })), remainingPhases: plan.actions.length - pending.phase, note: 'Only this transaction is ready. Call next again after submit confirms. Fees exclude rent, bounties and token movements.' };
    });
  }
  async simulate(id: string) {
    return this.locked(id, async (plan, journal) => {
      await this.service.checkNetwork();
      this.assertAge(plan, journal);
      const pending = await this.pending(plan, journal);
      if (!pending) return { complete: true };
      if (pending.entry.signature) throw new CliError('PENDING_TRANSACTION', 'Reconcile the submitted transaction before simulating further steps.');
      const tx = await this.fresh(pending.entry);
      await this.persist(plan, journal);
      const simulation = await this.service.connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' });
      if (simulation.value.err) throw new CliError('SIMULATION_FAILED', 'The next transaction failed simulation.', simulation.value);
      return { scope: 'next_transaction_only', phase: pending.phase, transaction: pending.transaction, ...simulation.value, note: 'Dependent transactions are simulated after their prerequisites confirm; this is not an atomic whole-plan simulation.' };
    });
  }
  validateSigned(entry: Entry, signed: string, owner: string): VersionedTransaction {
    if (signed.length > 4096) throw new CliError('INVALID_INPUT', 'Signed transaction exceeds the Solana transaction size limit.');
    const expected = VersionedTransaction.deserialize(Buffer.from(entry.transaction, 'base64'));
    const tx = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'));
    if (!Buffer.from(tx.message.serialize()).equals(Buffer.from(expected.message.serialize())) || tx.message.staticAccountKeys[0]?.toBase58() !== owner) throw new CliError('SIGNATURE_MISMATCH', 'Signed transaction does not match the exported message.');
    const message = tx.message.serialize();
    for (let index = 0; index < tx.message.header.numRequiredSignatures; index++) {
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), tx.message.staticAccountKeys[index]!.toBuffer()]), format: 'der', type: 'spki' });
      if (!verify(null, message, key, tx.signatures[index]!)) throw new CliError('INVALID_SIGNATURE', `Missing or invalid signature for ${tx.message.staticAccountKeys[index]}.`);
    }
    return tx;
  }
  async confirmation(entry: Entry): Promise<boolean> {
    const { value: [status] } = await this.service.connection.getSignatureStatuses([entry.signature!], { searchTransactionHistory: true });
    if (status?.err) throw new CliError('TRANSACTION_FAILED', 'Transaction failed on-chain. Earlier transactions may have succeeded; inspect this plan before preparing another.', { signature: entry.signature, error: status.err });
    return Boolean(status && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? ''));
  }
  async broadcast(plan: Plan, journal: Journal, entry: Entry) {
    const tx = this.validateSigned(entry, entry.signed!, plan.owner);
    if (bs58.encode(tx.signatures[0]!) !== entry.signature) throw new CliError('PLAN_INTEGRITY', 'Recorded transaction signature does not match its signed bytes.');
    if (await this.confirmation(entry)) { entry.confirmed = true; await this.persist(plan, journal); return; }
    if (!(await this.service.connection.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' })).value) throw new CliError('TRANSACTION_EXPIRED', 'The signed transaction expired without confirmed status. Check its signature on a healthy RPC before preparing any replacement. This CLI will not re-sign an uncertain transaction.', { planId: plan.id, signature: entry.signature });
    let broadcastError: unknown, lastSend = 0;
    const deadline = Date.now() + this.service.config.timeoutMs;
    do {
      if (await this.confirmation(entry)) { entry.confirmed = true; await this.persist(plan, journal); return; }
      if (Date.now() - lastSend >= 2000) {
        lastSend = Date.now();
        try { await this.service.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 0, preflightCommitment: 'confirmed' }); }
        catch (error) { broadcastError = error; }
      }
      await sleep(500);
    } while (Date.now() < deadline);
    throw new CliError('CONFIRMATION_PENDING', 'Confirmation is uncertain. Resume this same plan to reconcile or rebroadcast identical bytes.', { planId: plan.id, signature: entry.signature, broadcastError: broadcastError ? 'RPC did not acknowledge submission' : undefined }, true);
  }
  async finish(plan: Plan, journal: Journal) {
    journal.verification ??= await this.service.verify(plan.actions);
    await this.persist(plan, journal);
    return journal.verification;
  }
  async execute(id: string, approval: string, signed?: string) {
    return this.locked(id, async (plan, journal) => {
      if (approval !== plan.digest) throw new CliError('APPROVAL_REQUIRED', 'Execution requires the exact reviewed plan digest.');
      await this.service.checkNetwork();
      this.assertAge(plan, journal);
      let wallet: Keypair | undefined;
      try {
        if (signed) {
          const previous = journal.phases.flatMap(phase => phase.transactions).find(entry => entry.signed === signed && entry.confirmed);
          if (previous) return { planId: id, signature: previous.signature, status: journal.verification ? 'confirmed' : 'next_transaction_required', verification: journal.verification };
        }
        if (!signed) {
          wallet = await loadWallet(this.service.config.wallet);
          if (wallet.publicKey.toBase58() !== plan.owner) throw new CliError('PAYER_MISMATCH', 'Configured wallet does not own this plan.');
        }
        while (true) {
          const pending = await this.pending(plan, journal);
          if (!pending) return { planId: id, status: 'confirmed', result: plan.result, verification: await this.finish(plan, journal) };
          const { entry } = pending;
          if (!entry.signature) {
            let tx: VersionedTransaction;
            if (signed) tx = this.validateSigned(entry, signed, plan.owner);
            else {
              tx = await this.fresh(entry);
              tx.sign([wallet!]);
            }
            const encoded = Buffer.from(tx.serialize()).toString('base64');
            this.validateSigned(entry, encoded, plan.owner);
            const simulation = await this.service.connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
            if (simulation.value.err) throw new CliError('SIMULATION_FAILED', 'Transaction failed pre-submission simulation.', { planId: id, phase: pending.phase, transaction: pending.transaction, ...simulation.value });
            entry.signed = encoded;
            entry.signature = bs58.encode(tx.signatures[0]!);
            await this.persist(plan, journal); // Signed bytes durable before the first network submission.
          } else if (signed && signed !== entry.signed) {
            throw new CliError('SIGNATURE_MISMATCH', 'Only the original signed transaction can resume this step.');
          }
          await this.broadcast(plan, journal, entry);
          if (signed) {
            const complete = journal.phases.length === plan.actions.length && journal.phases.every(phase => phase.transactions.every(tx => tx.confirmed));
            return { planId: id, signature: entry.signature, status: complete ? 'confirmed' : 'next_transaction_required', verification: complete ? await this.finish(plan, journal) : undefined };
          }
        }
      } catch (error) {
        const details = { planId: id, signatures: journal.phases.flatMap(phase => phase.transactions.flatMap(entry => entry.signature ? [entry.signature] : [])) };
        if (error instanceof CliError) { error.details = { ...details, cause: error.details }; throw error; }
        throw new CliError('EXECUTION_INTERRUPTED', 'Execution stopped. Inspect and resume this same plan; do not repeat the original action.', { ...details, cause: errorResult(error) }, true);
      } finally { wallet?.secretKey.fill(0); }
    });
  }
  async status(id: string) {
    const plan = await this.load(id), journal = await this.journal(plan);
    await this.service.checkNetwork();
    const signatures = journal.phases.flatMap(phase => phase.transactions.map(tx => tx.signature).filter((signature): signature is string => Boolean(signature)));
    const statuses = [];
    for (let offset = 0; offset < signatures.length; offset += 256) {
      const batch = signatures.slice(offset, offset + 256);
      const response = await this.service.connection.getSignatureStatuses(batch, { searchTransactionHistory: true });
      statuses.push(...batch.map((signature, index) => ({ signature, status: response.value[index] })));
    }
    return { planId: id, statuses, verification: journal.verification, note: 'This is a read-only snapshot. Resume the same plan to reconcile journal progress.' };
  }
}
