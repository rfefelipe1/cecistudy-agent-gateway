import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

const SAMPLE_OUTPUT = {
  kind: 'plan',
  message: 'vamos começar pelo recorte do tema.',
  questions: [{ id: 'q1', text: 'qual é o prazo?' }],
  plan: {
    objective: 'fechar o recorte do tema',
    expectedOutput: 'uma página',
    steps: [{ title: 'listar temas' }, { title: 'escolher um', dueDate: '2026-11-20' }],
  },
  artifacts: [{ name: 'Roteiro', mimeType: 'text/markdown', content: 'passo a passo' }],
};

async function boot() {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-test-'));
  const db = await openDb({ url: `file:${join(directory, 'test.db')}` });
  const pool = {
    calls: 0,
    run: async () => {
      pool.calls += 1;
      return { ok: true, text: JSON.stringify(SAMPLE_OUTPUT) };
    },
  };
  const config = {
    sessionSecret: 'segredo-de-teste-com-mais-de-32-caracteres',
    sessionTtlSeconds: 3600,
    adminTtlSeconds: 3600,
    appKey: 'chave-do-app',
    adminPassword: 'senha-admin',
    nimModel: 'nvidia/nemotron-3.5-bolt-e4b',
    nimApiKeys: ['chave-1'],
    nimMaxAttemptsPerKey: 2,
    nimBaseUrl: 'http://provedor.invalido',
    nimTimeoutMs: 200,
    sessionsPerMinutePerIp: 100,
    adminPerMinutePerIp: 100,
    jobsPerMinutePerDevice: 100,
    maxBodyBytes: 262_144,
  };

  const server = createServer(createApp({ config, db, pool, logger: { error() {} } }));
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    pool,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

async function session(base, installationId) {
  const response = await fetch(`${base}/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-key': 'chave-do-app' },
    body: JSON.stringify({ installationId, appVersion: '1.0.0' }),
  });
  return response.json();
}

async function adminSession(base) {
  const response = await fetch(`${base}/v1/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'senha-admin' }),
  });
  return response.json();
}

async function waitForJob(base, token, operationId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${base}/v1/agent/jobs/${operationId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const job = await response.json();
    if (job.status === 'done' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('o job não terminou');
}

test('healthz responde sem autenticação', async (t) => {
  const { base, close } = await boot();
  t.after(close);

  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('sessão exige a chave do app e um installationId válido', async (t) => {
  const { base, close } = await boot();
  t.after(close);

  const withoutKey = await fetch(`${base}/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installationId: 'aparelho-1234' }),
  });
  assert.equal(withoutKey.status, 401);

  const invalid = await fetch(`${base}/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-key': 'chave-do-app' },
    body: JSON.stringify({ installationId: 'curto' }),
  });
  assert.equal(invalid.status, 400);

  const session1 = await session(base, 'aparelho-1234');
  assert.equal(typeof session1.token, 'string');
  assert.equal(session1.deviceId, 'aparelho-1234');
});

test('job sem token é recusado', async (t) => {
  const { base, close } = await boot();
  t.after(close);

  const response = await fetch(`${base}/v1/agent/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'op-1', taskId: 'task-1', kind: 'analyze' }),
  });
  assert.equal(response.status, 401);
});

test('job completo devolve mensagens, plano e artefatos', async (t) => {
  const { base, pool, close } = await boot();
  t.after(close);

  const { token } = await session(base, 'aparelho-1234');
  const accepted = await fetch(`${base}/v1/agent/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': 'op-1',
    },
    body: JSON.stringify({
      taskId: 'task-1',
      kind: 'plan',
      payload: { message: 'me ajuda a organizar', context: { title: 'TCC' } },
    }),
  });
  assert.equal(accepted.status, 202);

  const job = await waitForJob(base, token, 'op-1');
  assert.equal(job.status, 'done');
  assert.equal(job.messages[0].kind, 'text');
  assert.equal(job.messages[1].kind, 'question');
  assert.equal(job.plan.steps.length, 2);
  assert.equal(job.artifacts[0].path, 'artifacts/roteiro.md');
  assert.equal(pool.calls, 1);
});

test('o mesmo Idempotency-Key não cria outro job', async (t) => {
  const { base, pool, close } = await boot();
  t.after(close);

  const { token } = await session(base, 'aparelho-1234');
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'idempotency-key': 'op-repetida',
  };
  const body = JSON.stringify({ taskId: 'task-1', kind: 'analyze', payload: { message: 'oi' } });

  const first = await fetch(`${base}/v1/agent/jobs`, { method: 'POST', headers, body });
  assert.equal(first.status, 202);
  await waitForJob(base, token, 'op-repetida');

  const second = await fetch(`${base}/v1/agent/jobs`, { method: 'POST', headers, body });
  const payload = await second.json();
  assert.equal(second.status, 200);
  assert.equal(payload.idempotent, true);
  assert.equal(pool.calls, 1);
});

test('outro aparelho não enxerga o job', async (t) => {
  const { base, close } = await boot();
  t.after(close);

  const owner = await session(base, 'aparelho-dono');
  const intruder = await session(base, 'aparelho-outro');

  await fetch(`${base}/v1/agent/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${owner.token}`,
      'idempotency-key': 'op-privada',
    },
    body: JSON.stringify({ taskId: 'task-1', kind: 'analyze', payload: { message: 'oi' } }),
  });

  const response = await fetch(`${base}/v1/agent/jobs/op-privada`, {
    headers: { authorization: `Bearer ${intruder.token}` },
  });
  assert.equal(response.status, 404);
});

test('conteúdo clínico é recusado antes do provedor', async (t) => {
  const { base, pool, close } = await boot();
  t.after(close);

  const { token } = await session(base, 'aparelho-1234');
  const response = await fetch(`${base}/v1/agent/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': 'op-clinica',
    },
    body: JSON.stringify({
      taskId: 'task-1',
      kind: 'analyze',
      payload: { message: 'resumir o prontuário da paciente' },
    }),
  });

  assert.equal(response.status, 422);
  assert.equal(pool.calls, 0);
});

test('rota sem /v1 funciona igual', async (t) => {
  const { base, close } = await boot();
  t.after(close);

  const { token } = await session(base, 'aparelho-1234');
  const response = await fetch(`${base}/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': 'op-sem-prefixo',
    },
    body: JSON.stringify({ taskId: 'task-1', kind: 'analyze', payload: { message: 'oi' } }),
  });
  assert.equal(response.status, 202);
});

test('admin entra, lista e revoga aparelho', async (t) => {
  const { base, close } = await boot();
  t.after(close);

  const wrong = await fetch(`${base}/v1/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'errada' }),
  });
  assert.equal(wrong.status, 401);

  const { token: deviceToken } = await session(base, 'aparelho-1234');
  const forbidden = await fetch(`${base}/v1/admin/devices`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(forbidden.status, 401);

  const admin = await adminSession(base);
  const listed = await fetch(`${base}/v1/admin/devices`, {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).devices.length, 1);

  const revoked = await fetch(`${base}/v1/admin/devices/aparelho-1234`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${admin.token}` },
  });
  assert.equal(revoked.status, 200);

  const afterRevoke = await fetch(`${base}/v1/agent/jobs/qualquer`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(afterRevoke.status, 403);
});

test('playground devolve o texto do provedor', async (t) => {
  const { base, close } = await boot();
  t.after(close);

  const admin = await adminSession(base);
  const response = await fetch(`${base}/v1/admin/playground`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ prompt: 'oi' }),
  });

  assert.equal(response.status, 200);
  assert.match((await response.json()).text, /recorte do tema/);
});
