import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

export class CliError extends Error {
  constructor(public code: string, message: string, public details?: unknown, public retryable = false) { super(message); }
}
export const address = z.string().min(32).max(44).refine(value => {
  try { return value.length <= 44 && new PublicKey(value).toBase58() === value; } catch { return false; }
}, 'Expected a base58 Solana public key');
export const rawAmount = z.string().max(16).regex(/^[1-9][0-9]*$/, 'Use a positive integer string in raw token units')
  .refine(value => value.length <= 16 && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), 'Amount exceeds the SDK safe integer limit');
export const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const bps = z.number().int().min(0).max(10_000);
export const empty = z.strictObject({});

export function json(value: unknown, pretty = false): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item instanceof Map ? Object.fromEntries(item) : item, pretty ? 2 : undefined);
}
export function digest(value: unknown): string { return createHash('sha256').update(json(value)).digest('hex'); }
export async function readJson(path: string): Promise<unknown> {
  const info = await stat(path);
  if (info.size > 8 * 1024 * 1024) throw new CliError('INVALID_INPUT', 'JSON input exceeds 8 MiB.');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new CliError('INVALID_INPUT', `Invalid JSON in ${path}.`); }
}

/** Atomic replacement, restrictive permissions, and durability before any broadcast. */
export async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(json(value, true) + '\n');
    await file.sync();
  } finally { await file.close(); }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Never steal a lock: an uncertain previous signer must be reconciled explicitly. */
export async function withLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('BUSY', `Execution locked: ${path}. If a process crashed, verify it has stopped before removing this lock.`, undefined, true);
    throw error;
  }
  try {
    await lock.writeFile(json({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await run();
  } finally { await lock.close(); await unlink(path); }
}

export function errorResult(error: unknown) {
  if (error instanceof z.ZodError) return { code: 'INVALID_INPUT', message: 'Input validation failed.', details: error.issues.map(({ path, message }) => ({ path, message })), retryable: false };
  if (error instanceof CliError) return { code: error.code, message: error.message, details: error.details, retryable: error.retryable };
  // RPC errors can contain credential-bearing URLs. Keep them out of machine output.
  const message = (error instanceof Error ? error.message : 'Unexpected error').replace(/https?:\/\/[^\s"']+/g, '[endpoint]');
  return { code: 'OPERATION_FAILED', message, retryable: false };
}
export function localPath(path: string): string { return resolve(path); }
