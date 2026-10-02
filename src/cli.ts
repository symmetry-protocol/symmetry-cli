#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Command, CommanderError } from 'commander';
import { commands, catalog, type CommandName } from './commands.js';
import { configPaths, configSchema, loadConfig, publicConfig, type ConfigOverrides } from './config.js';
import { CliError, errorResult, json, readJson, saveJson } from './lib/utils.js';
import { Service } from './service.js';
import { Transactions, type Plan } from './transactions.js';

// Dependency diagnostics must never corrupt JSON or MCP stdout.
console.log = (...values: unknown[]) => console.error(...values);
process.stdout.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EPIPE') process.exit(0); else throw error; });
const program = new Command().name('symmetry').description('Symmetry v3 vaults for humans and agents. Writes prepare plans by default.').version('0.1.0')
  .option('--json', 'Machine-readable output (also default when stdout is piped)')
  .option('-o, --output <format>', 'json or human')
  .option('--network <network>', 'mainnet or devnet')
  .option('--rpc-url <url>', 'HTTPS Solana RPC endpoint')
  .option('--hermes-url <url>', 'HTTPS Hermes endpoint; authentication from PYTH_API_KEY')
  .option('--wallet <path>', 'Solana keypair file (0600); never passed as inline secret')
  .option('--owner <address>', 'Public key for unsigned planning')
  .option('--config <path>', 'Configuration file')
  .option('--data-dir <path>', 'Private plan/journal directory')
  .option('--priority-fee <number>', 'Micro-lamports per compute unit', Number)
  .option('--timeout-ms <number>', 'RPC and confirmation timeout', Number)
  .exitOverride();
const machine = () => program.opts().json || program.opts().output === 'json' || (!process.stdout.isTTY && program.opts().output !== 'human');
function output(data: unknown) { process.stdout.write(json({ ok: true, data, meta: { schemaVersion: 1, cliVersion: '0.1.0' } }, !machine()) + '\n'); }
async function runtime() {
  const options = program.opts();
  if (options.output && !['json', 'human'].includes(options.output)) throw new CliError('INVALID_INPUT', 'Output must be json or human.');
  const loaded = await loadConfig(Object.fromEntries(['network', 'rpcUrl', 'hermesUrl', 'wallet', 'owner', 'config', 'dataDir', 'priorityFee', 'timeoutMs'].map(key => [key, options[key]])) as ConfigOverrides);
  const service = new Service(loaded.config);
  return { ...loaded, service, transactions: new Transactions(service, loaded.dataDir) };
}
async function inputFile(path?: string): Promise<unknown> {
  if (!path) return {};
  if (path !== '-') return readJson(path);
  let content = '';
  for await (const chunk of process.stdin) {
    content += chunk;
    if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new CliError('INVALID_INPUT', 'Stdin JSON exceeds 8 MiB.');
  }
  try { return JSON.parse(content); } catch { throw new CliError('INVALID_INPUT', 'Stdin must contain one JSON object.'); }
}
async function approval(plan: Plan, provided?: string, yes = false) {
  if (provided) return provided;
  if (yes) return plan.digest;
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new CliError('APPROVAL_REQUIRED', 'Noninteractive execution requires --approve with the reviewed digest, or --execute --yes on the original action.', { planId: plan.id, digest: plan.digest });
  process.stderr.write(`\nNetwork: ${plan.network}\nWallet: ${plan.owner}\n${json(plan.actions, true)}\nPlan: ${plan.id}\nDigest: ${plan.digest}\n`);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { if ((await prompt.question('Sign and submit these actions? [y/N] ')).trim().toLowerCase() !== 'y') throw new CliError('CANCELLED', 'Execution cancelled. The prepared plan remains available.'); }
  finally { prompt.close(); }
  return plan.digest;
}

program.command('schema [command]').description('Exact JSON schemas; use dot notation such as vault.create').action(name => output(catalog(name)));
program.command('agent-context').description('Print the agent runtime contract').action(async () => output(await readFile(new URL('../docs/AGENT.md', import.meta.url), 'utf8')));
program.command('mcp').description('Serve MCP over stdio; preparation and reads by default').option('--allow-execute', 'Expose live signing tools; each call still needs digest and acknowledgment').action(async options => {
  const { service, transactions } = await runtime();
  const { startMcp } = await import('./mcp.js');
  await startMcp(service, transactions, Boolean(options.allowExecute));
});
const config = program.command('config').description('Manage non-secret configuration');
config.command('show').action(async () => { const loaded = await runtime(); output({ ...publicConfig(loaded.config), dataDir: loaded.dataDir, configPath: loaded.configPath }); });
config.command('set').requiredOption('--input <file>', 'JSON config file, or - for stdin; replaces saved config').action(async options => {
  const value = configSchema.parse(await inputFile(options.input));
  const { configPath } = configPaths({ config: program.opts().config, dataDir: program.opts().dataDir });
  await saveJson(configPath, value);
  output({ saved: configPath });
});

const groups = new Map<string, Command>();
for (const [name, definition] of Object.entries(commands)) {
  const parts = name.split('.');
  let parent = program;
  if (parts.length === 2) {
    if (!groups.has(parts[0]!)) groups.set(parts[0]!, program.command(parts[0]!));
    parent = groups.get(parts[0]!)!;
  }
  const command = parent.command(parts.at(-1)!).description(definition.description).option('--input <file>', 'JSON arguments file, or - for stdin');
  const properties = (catalog(name)[name]!.inputSchema as { properties?: Record<string, { type?: string; description?: string }> }).properties ?? {};
  for (const [key, schema] of Object.entries(properties)) {
    if (['string', 'number', 'integer', 'boolean'].includes(schema.type ?? '')) {
      const flag = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      command.option(`--${flag} <value>`, schema.description ?? key);
    }
  }
  if (definition.write) command.option('--request-id <id>', 'Reuse a plan for retries of the same logical request').option('--execute', 'Prepare then execute this action').option('-y, --yes', 'Explicit noninteractive consent with --execute').option('--dry-run', 'Prepare and simulate the next transaction without signing or broadcasting');
  command.action(async options => {
    const { service, transactions } = await runtime();
    const input = await inputFile(options.input);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new CliError('INVALID_INPUT', 'Arguments must be a JSON object.');
    const args: Record<string, unknown> = { ...input };
    for (const [key, schema] of Object.entries(properties)) if (options[key] !== undefined) {
      const value = options[key];
      if (schema.type === 'boolean') { if (!['true', 'false'].includes(value)) throw new CliError('INVALID_INPUT', `${key} must be true or false.`); args[key] = value === 'true'; }
      else args[key] = ['number', 'integer'].includes(schema.type ?? '') ? Number(value) : value;
    }
    const parsed = definition.schema.parse(args);
    if (!definition.write) return output(await service.read(name as CommandName, parsed));
    if (options.execute && options.dryRun) throw new CliError('INVALID_INPUT', '--execute and --dry-run are mutually exclusive.');
    if (options.yes && !options.execute) throw new CliError('INVALID_INPUT', '--yes requires --execute.');
    const prepared = await transactions.prepare(name as CommandName, parsed, options.requestId) as Plan;
    if (options.dryRun) return output({ plan: prepared, simulation: await transactions.simulate(prepared.id) });
    if (options.execute) return output(await transactions.execute(prepared.id, await approval(prepared, undefined, options.yes)));
    output(prepared);
  });
}
const transaction = program.command('transaction').description('Review, simulate, sign, submit and resume saved plans');
transaction.command('list').description('Find saved plans after an interrupted command').action(async () => { const { transactions } = await runtime(); output(await transactions.list()); });
for (const method of ['inspect', 'next', 'simulate', 'status'] as const) transaction.command(`${method} <plan-id>`).action(async id => { const { transactions } = await runtime(); output(await transactions[method](id)); });
transaction.command('execute <plan-id>').option('--approve <digest>', 'Exact digest returned by prepare/inspect').action(async (id, options) => {
  const { transactions } = await runtime();
  output(await transactions.execute(id, await approval(await transactions.load(id), options.approve)));
});
transaction.command('submit <plan-id>').requiredOption('--input <file>', 'JSON object containing signedTransactionBase64').requiredOption('--approve <digest>', 'Exact reviewed plan digest').action(async (id, options) => {
  const { transactions } = await runtime();
  const input = await inputFile(options.input) as { signedTransactionBase64?: unknown };
  if (!input || typeof input.signedTransactionBase64 !== 'string' || Object.keys(input).length !== 1) throw new CliError('INVALID_INPUT', 'Expected only signedTransactionBase64.');
  output(await transactions.execute(id, options.approve, input.signedTransactionBase64));
});

try { await program.parseAsync(process.argv); }
catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
  else {
    const failure = error instanceof CommanderError ? { code: 'INVALID_INPUT', message: error.message, retryable: false } : errorResult(error);
    process.stdout.write(json({ ok: false, error: failure, meta: { schemaVersion: 1, cliVersion: '0.1.0' } }, !machine()) + '\n');
    process.exitCode = failure.code === 'INVALID_INPUT' ? 2 : failure.code === 'APPROVAL_REQUIRED' ? 3 : failure.code === 'CONFIRMATION_PENDING' ? 4 : 1;
  }
}
