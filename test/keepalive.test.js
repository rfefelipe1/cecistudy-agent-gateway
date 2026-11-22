import test from 'node:test';
import assert from 'node:assert/strict';
import { startKeepalive } from '../src/keepalive.js';

test('keepalive pinga interno e externo', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: url.includes('127.0.0.1') ? 200 : 204 };
  };
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };

  const keepalive = startKeepalive({
    port: 9999,
    intervalMs: 60_000,
    timeoutMs: 1000,
    externalUrl: 'https://www.gstatic.com/generate_204',
    fetchImpl,
    logger,
  });

  await keepalive.tick();
  keepalive.stop();

  assert.deepEqual(calls, [
    'http://127.0.0.1:9999/healthz',
    'https://www.gstatic.com/generate_204',
  ]);
  assert.ok(logs.some((m) => m.includes('interno ok 200')));
  assert.ok(logs.some((m) => m.includes('externo ok 204')));
});

test('keepalive sem url externa pinga só interno', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200 };
  };

  const keepalive = startKeepalive({
    port: 9999,
    intervalMs: 60_000,
    timeoutMs: 1000,
    externalUrl: '',
    fetchImpl,
    logger: { info() {}, warn() {} },
  });

  await keepalive.tick();
  keepalive.stop();

  assert.deepEqual(calls, ['http://127.0.0.1:9999/healthz']);
});

test('keepalive registra falha sem lançar', async () => {
  const warns = [];
  const fetchImpl = async () => {
    throw new Error('rede fora');
  };
  const keepalive = startKeepalive({
    port: 9999,
    intervalMs: 60_000,
    timeoutMs: 1000,
    externalUrl: 'https://www.gstatic.com/generate_204',
    fetchImpl,
    logger: { info() {}, warn: (m) => warns.push(m) },
  });

  await keepalive.tick();
  keepalive.stop();

  assert.equal(warns.length, 2);
  assert.ok(warns.every((m) => m.includes('falhou')));
});
