import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { commands, catalog, type CommandName } from './commands.js';
import { errorResult, json } from './lib/utils.js';
import type { Service } from './service.js';
import type { Transactions } from './transactions.js';

export async function startMcp(service: Service, transactions: Transactions, allowExecute: boolean) {
  const server = new McpServer({ name: 'symmetry', version: '0.2.0' });
  const respond = async (run: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: json({ ok: true, data: await run() }) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: json({ ok: false, error: errorResult(error) }) }] }; }
  };
  for (const [name, command] of Object.entries(commands)) {
    server.registerTool(`symmetry_${name.replaceAll('.', '_').replaceAll('-', '_')}`, {
      description: command.description + (command.write ? ' Creates a local plan only. No signing or broadcasting.' : ''),
      inputSchema: command.schema,
      annotations: { readOnlyHint: !command.write, destructiveHint: false, openWorldHint: true, idempotentHint: !command.write },
    }, async (input: unknown) => respond(() => command.write ? transactions.prepare(name as CommandName, input) : service.read(name as CommandName, input)));
  }
  for (const name of ['inspect', 'next', 'simulate', 'status'] as const) {
    server.registerTool(`symmetry_transaction_${name}`, {
      description: `${name} a saved transaction plan. Never signs or broadcasts.`,
      inputSchema: z.strictObject({ planId: z.string().uuid() }),
      annotations: { readOnlyHint: ['inspect', 'status'].includes(name), destructiveHint: false, openWorldHint: true },
    }, ({ planId }) => respond(() => transactions[name](planId)));
  }
  if (allowExecute) server.registerTool('symmetry_transaction_execute', {
    description: 'Sign and broadcast a reviewed saved plan. Requires explicit authorization for these actions and the exact plan digest. Resume the same plan after uncertainty.',
    inputSchema: z.strictObject({ planId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), acknowledged: z.literal(true) }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true },
  }, ({ planId, digest }) => respond(() => transactions.execute(planId, digest)));
  server.registerResource('agent-context', 'symmetry://context', { mimeType: 'text/markdown' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readFile(new URL('../docs/AGENT.md', import.meta.url), 'utf8') }] }));
  server.registerResource('command-catalog', 'symmetry://commands', { mimeType: 'application/json' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: json(catalog()) }] }));
  await server.connect(new StdioServerTransport());
  return server;
}
