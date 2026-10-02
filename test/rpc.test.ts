import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactSolBalance } from '../src/rpc.js';

const owner = '11111111111111111111111111111111';
const url = 'https://user:secret@rpc.example/private?key=secret';
const reply = (value: string) => `{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":${value}}}`;
const fetchReply = (body: string, status = 200): typeof fetch => async () => new Response(body, { status });

test('SOL balance preserves unsafe integers and the full u64 range', async () => {
  let request: RequestInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(input, url);
    request = init;
    return new Response(reply('18446744073709551615'));
  };
  assert.equal(await exactSolBalance(url, owner, 1000, fetcher), '18446744073709551615');
  assert.equal(JSON.parse(String(request?.body)).method, 'getBalance');
  assert.deepEqual(JSON.parse(String(request?.body)).params, [owner, { commitment: 'confirmed' }]);
  assert.equal(request?.redirect, 'error');
  assert.ok(request?.signal);
  assert.equal(await exactSolBalance(url, owner, 1000, fetchReply(reply('500000000000000001'))), '500000000000000001');
});

test('SOL balance rejects malformed and out-of-range RPC values', async () => {
  for (const body of [reply('18446744073709551616'), reply('-1'), reply('1.5'), reply('1e3'), reply('"42"'), reply('null'), reply('{"raw":"42"}'),
    '{"jsonrpc":"2.0","id":1,"error":{"message":"secret"}}',
    '{"jsonrpc":"2.0","id":2,"result":{"context":{"slot":1},"value":5}}',
    '{"jsonrpc":"2.0","id":1,"result":{"context":{},"value":5}}',
    'not json', 'x'.repeat(65536)]) {
    await assert.rejects(exactSolBalance(url, owner, 1000, fetchReply(body)), error => {
      assert.equal((error as { code?: string }).code, 'RPC_RESPONSE_INVALID');
      assert.doesNotMatch((error as Error).message, /secret|rpc\.example/);
      return true;
    });
  }
});

test('SOL balance masks transport and HTTP failures', async () => {
  for (const fetcher of [fetchReply('secret', 503), (async () => { throw new Error(url); }) as typeof fetch]) {
    await assert.rejects(exactSolBalance(url, owner, 1000, fetcher), error => {
      assert.equal((error as { code?: string }).code, 'RPC_UNAVAILABLE');
      assert.doesNotMatch((error as Error).message, /secret|rpc\.example/);
      return true;
    });
  }
});
