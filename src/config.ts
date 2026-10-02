import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import { z } from 'zod';
import { address, CliError, readJson, uint } from './lib/utils.js';

const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}, 'RPC requires HTTPS, except on localhost');
export const configSchema = z.strictObject({
  network: z.enum(['mainnet', 'devnet']).default('mainnet'),
  rpcUrl: endpoint.optional(),
  hermesUrl: z.string().url().refine(value => new URL(value).protocol === 'https:' && !new URL(value).username && !new URL(value).password && !new URL(value).search && !new URL(value).hash, 'Hermes requires HTTPS; supply credentials through PYTH_API_KEY, not the URL').optional(),
  wallet: z.string().min(1).optional(),
  owner: address.optional(),
  priorityFee: uint.max(1_000_000).default(25_000),
  timeoutMs: uint.min(1_000).max(300_000).default(60_000),
});
export type Config = z.infer<typeof configSchema>;
export type ConfigOverrides = Partial<Config> & { config?: string; dataDir?: string };
export const GENESIS = { mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' } as const;

export function configPaths(options: Pick<ConfigOverrides, 'config' | 'dataDir'> = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.SYMMETRY_HOME ?? join(homedir(), '.symmetry'));
  const configPath = resolve(options.config ?? join(dataDir, 'config.json'));
  return { dataDir, configPath };
}

export async function loadConfig(options: ConfigOverrides = {}) {
  const { dataDir, configPath } = configPaths(options);
  let saved: unknown = {};
  try { saved = await readJson(configPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const env = {
    network: process.env.SYMMETRY_NETWORK, rpcUrl: process.env.SYMMETRY_RPC_URL,
    hermesUrl: process.env.SYMMETRY_HERMES_URL,
    wallet: process.env.SYMMETRY_WALLET, owner: process.env.SYMMETRY_OWNER,
  };
  const { dataDir: _data, config: _config, ...flags } = options;
  const merged = { ...configSchema.partial().parse(saved), ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)), ...Object.fromEntries(Object.entries(flags).filter(([, value]) => value !== undefined)) };
  const config = configSchema.parse(merged);
  config.rpcUrl ??= config.network === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
  return { config, dataDir, configPath };
}

export function connect(config: Config): Connection {
  return new Connection(config.rpcUrl!, {
    commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: async (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(config.timeoutMs) }),
  });
}
export async function assertNetwork(connection: Connection, network: Config['network']) {
  if (await connection.getGenesisHash() !== GENESIS[network]) throw new CliError('NETWORK_MISMATCH', `RPC does not match ${network}.`);
}
export async function loadWallet(path?: string): Promise<Keypair> {
  if (!path) throw new CliError('WALLET_REQUIRED', 'Set --wallet or SYMMETRY_WALLET to a Solana keypair JSON file.');
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) throw new CliError('INVALID_WALLET', 'Expected a small Solana keypair JSON file.');
    if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) throw new CliError('WALLET_PERMISSIONS', 'Keypair must be owned by you with permissions 0600 or 0400.');
    const bytes = z.array(z.number().int().min(0).max(255)).length(64).parse(JSON.parse(await file.readFile('utf8')));
    try { return Keypair.fromSecretKey(Uint8Array.from(bytes)); } finally { bytes.fill(0); }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('INVALID_WALLET', 'Cannot decode this Solana keypair.');
  } finally { await file.close(); }
}
export async function ownerAddress(config: Config): Promise<string> {
  if (config.owner) return config.owner;
  const wallet = await loadWallet(config.wallet);
  try { return wallet.publicKey.toBase58(); } finally { wallet.secretKey.fill(0); }
}
export function publicConfig(config: Config) {
  const url = new URL(config.rpcUrl!);
  const hermes = config.hermesUrl ? new URL(config.hermesUrl) : undefined;
  return { ...config, rpcUrl: `${url.protocol}//${url.host}/[redacted]`, ...(hermes ? { hermesUrl: `${hermes.protocol}//${hermes.host}/[redacted]` } : {}) };
}
