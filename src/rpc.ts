import { CliError } from './lib/utils.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_U64 = 18446744073709551615n;
const RAW_VALUE = Symbol('raw balance');

export async function exactSolBalance(rpcUrl: string, owner: string, timeoutMs: number, fetcher: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [owner, { commitment: 'confirmed' }] }),
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw new CliError('RPC_UNAVAILABLE', 'RPC balance request failed.', undefined, true); }
  if (!response.ok) throw new CliError('RPC_UNAVAILABLE', 'RPC balance request failed.', undefined, response.status === 429 || response.status >= 500);

  const reader = response.body?.getReader();
  if (!reader) throw new CliError('RPC_RESPONSE_INVALID', 'RPC balance response is empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new CliError('RPC_RESPONSE_INVALID', 'RPC balance response is too large.');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('RPC_UNAVAILABLE', 'RPC balance response failed.', undefined, true);
  } finally { await reader.cancel().catch(() => {}); }

  let reply: unknown;
  try {
    const parseWithSource = JSON.parse as (text: string, reviver: (key: string, value: unknown, context: { source: string }) => unknown) => unknown;
    reply = parseWithSource(Buffer.concat(chunks).toString('utf8'), (key, value, context) =>
      key === 'value' && typeof value === 'number' ? { [RAW_VALUE]: context.source } : value);
  } catch { throw new CliError('RPC_RESPONSE_INVALID', 'RPC balance response is invalid JSON.'); }
  if (!reply || typeof reply !== 'object') throw new CliError('RPC_RESPONSE_INVALID', 'RPC balance response is malformed.');
  const envelope = reply as Record<string, unknown>;
  const result = envelope.result as Record<string, unknown> | undefined;
  const context = result?.context as { slot?: unknown } | undefined;
  const value = result?.value as { [RAW_VALUE]?: unknown } | undefined;
  const raw = value?.[RAW_VALUE];
  if (envelope.jsonrpc !== '2.0' || envelope.id !== 1 || envelope.error !== undefined || typeof context?.slot !== 'number' || !Number.isSafeInteger(context.slot) || context.slot < 0 || typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw) || BigInt(raw) > MAX_U64)
    throw new CliError('RPC_RESPONSE_INVALID', 'RPC balance response is malformed.');
  return raw;
}
