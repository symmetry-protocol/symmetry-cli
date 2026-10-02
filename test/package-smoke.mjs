// Explicit release check: install the real tarball in a clean consumer, without lifecycle scripts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'symmetry-package-'));
try {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory]);
  const [packed] = JSON.parse(stdout);
  assert.ok(packed.files.every(file => !/(?:^|\/)(?:test|\.symmetry|node_modules)\/|keypair|\.env(?:\.|$)/.test(file.path)));
  assert.equal(packed.files.some(file => file.path.endsWith('/oracles.json')), false, 'Build must not ship a stale token/oracle registry');
  const publicDocs = ['docs/AGENT.md', 'docs/RELEASE.md', 'docs/SECURITY.md'];
  assert.deepEqual((await readdir('docs')).map(file => `docs/${file}`).sort(), publicDocs);
  assert.deepEqual(manifest.files.filter(path => path === 'docs' || path.startsWith('docs/')).sort(), publicDocs);
  assert.deepEqual(packed.files.filter(file => file.path.startsWith('docs/')).map(file => file.path).sort(), publicDocs);
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'symmetry-release-consumer', version: '1.0.0', private: true }));
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed.filename)], { cwd: directory, timeout: 180000 });
  const packagePath = join(directory, 'node_modules/@symmetry-hq/cli/package.json'), require = createRequire(packagePath);
  const installedSdk = require('@symmetry-hq/sdk/package.json').version;
  assert.equal(installedSdk, manifest.dependencies['@symmetry-hq/sdk']);
  const bin = join(directory, 'node_modules/.bin/symmetry');
  const schema = JSON.parse((await exec(bin, ['schema', 'vault.deposit', '--json'], { cwd: directory })).stdout);
  assert.equal(schema.data['vault.deposit'].inputSchema.properties.contributions.type, 'array');
  const agentGuide = await readFile(join(directory, 'node_modules/@symmetry-hq/cli/docs/AGENT.md'), 'utf8');
  assert.equal(JSON.parse((await exec(bin, ['agent-context', '--json'], { cwd: directory })).stdout).data, agentGuide);
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ owner: '11111111111111111111111111111111' }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SYMMETRY_')));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(directory, 'node_modules/@symmetry-hq/cli/dist/cli.js'), '--config', config, 'mcp'], cwd: directory, env, stderr: 'pipe' });
  const client = new Client({ name: 'package-release-check', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'symmetry_vault_deposit'));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.some(tool => tool.name === 'symmetry_token_list'), false);
    assert.ok(tools.find(tool => tool.name === 'symmetry_vault_add_token').inputSchema.required.includes('token'));
    assert.ok((await client.readResource({ uri: 'symmetry://commands' })).contents.length > 0);
    assert.equal((await client.readResource({ uri: 'symmetry://context' })).contents[0].text, agentGuide);
  } finally { await client.close(); }
  console.log(JSON.stringify({ package: packed.name, version: packed.version, sdk: installedSdk, integrity: packed.integrity, files: packed.entryCount, installedExecutable: true, schema: true, mcp: true, lifecycleScripts: false }));
} finally { await rm(directory, { recursive: true, force: true }); }
