import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { commands } from '../src/commands.js';

const exec = promisify(execFile);
test('packaged CLI exposes machine schemas and JSON validation failures', async () => {
  const result = await exec(process.execPath, ['dist/cli.js', 'schema', 'vault.deposit', '--json']);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.equal(response.data['vault.deposit'].inputSchema.properties.contributions.type, 'array');
  await assert.rejects(exec(process.execPath, ['dist/cli.js', 'vault', 'create', '--name', 'A', '--symbol', 'A', '--start-price', '-1', '--json']), error => {
    const result = error as Error & { stdout: string; code: number };
    assert.equal(result.code, 2); assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_INPUT'); return true;
  });
});
test('config set repairs an invalid saved config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'symmetry-config-'));
  try {
    const config = join(directory, 'config.json'), input = join(directory, 'replacement.json');
    await writeFile(config, '{invalid');
    await writeFile(input, JSON.stringify({ network: 'devnet' }));
    const result = await exec(process.execPath, ['dist/cli.js', '--config', config, 'config', 'set', '--input', input, '--json']);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).network, 'devnet');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('MCP handshake, tool schemas, validation, and resources work over real stdio', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'mcp'], stderr: 'pipe' });
  const client = new Client({ name: 'symmetry-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, Object.keys(commands).length + 4);
    assert.equal(listed.tools.some(tool => tool.name === 'symmetry_transaction_execute'), false);
    assert.equal(listed.tools.some(tool => tool.name === 'symmetry_token_list'), false);
    const addToken = listed.tools.find(tool => tool.name === 'symmetry_vault_add_token')!;
    assert.ok(addToken.inputSchema.required?.includes('token'));
    const legacy = await client.callTool({ name: addToken.name, arguments: { vault: '11111111111111111111111111111111', mint: 'So11111111111111111111111111111111111111112' } });
    assert.equal(legacy.isError, true);
    const invalid = await client.callTool({ name: 'symmetry_vault_create', arguments: { name: 'A', symbol: 'A', startPrice: '-1' } });
    assert.equal(invalid.isError, true);
    const context = await client.readResource({ uri: 'symmetry://context' });
    assert.ok(String(context.contents[0]?.text).includes('raw token units'));
    const catalog = await client.readResource({ uri: 'symmetry://commands' });
    assert.ok(JSON.parse(String(catalog.contents[0]?.text))['vault.create']);
  } finally { await client.close(); }
});
test('MCP live mode exposes execution only with an exact digest and explicit acknowledgement', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'mcp', '--allow-execute'], stderr: 'pipe' });
  const client = new Client({ name: 'symmetry-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'symmetry_transaction_execute');
    assert.ok(tool);
    assert.ok(tool.inputSchema.required?.includes('acknowledged'));
    const result = await client.callTool({ name: tool.name, arguments: { planId: '00000000-0000-4000-8000-000000000000', digest: 'a'.repeat(64), acknowledged: false } });
    assert.equal(result.isError, true);
  } finally { await client.close(); }
});
