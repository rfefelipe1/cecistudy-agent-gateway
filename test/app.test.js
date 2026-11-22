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

async function boot(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-test-'));
  const db = await openDb({ url: `file:${join(directory, 'test.db')}` });
  const pool = overrides.pool ?? {
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
    nimModels: ['modelo-de-teste'],
    nimApiKeys: ['chave-1'],
    nimMaxAttemptsPerKey: 2,
    nimBaseUrl: 'http://provedor.invalido',
    nimTimeoutMs: 200,
    conversationTimeoutMs: 5000,
    tavilyApiKey: '',
    tavilyMaxResults: 5,
    sessionsPerMinutePerIp: 100,
    adminPerMinutePerIp: 100,
    jobsPerMinutePerDevice: 100,
    conversationsPerMinutePerDevice: 100,
    maxBodyBytes: 262_144,
    ...overrides.config,
  };

  const server = createServer(
    createApp({
      config,
      db,
      pool,
      logger: { error() {} },
      search: 'search' in overrides ? overrides.search : null,
    }),
  );
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

/** Lê o corpo SSE inteiro e separa os eventos (o turno termina sozinho). */
async function sseEvents(response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith(':'))
    .map((block) => ({
      evento: /^event:\s*(.*)$/m.exec(block)?.[1]?.trim() ?? 'message',
      data: [...block.matchAll(/^data:\s?(.*)$/gm)].map((match) => match[1]).join('\n'),
    }));
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

test('ping responde sem autenticação e sinaliza pong', async (t) => {
  const { base, close } = await boot();
  t.after(close);

  const response = await fetch(`${base}/ping`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.pong, true);
  assert.equal(typeof body.at, 'string');
});

test('preflight CORS libera o app no navegador e no WebView', async (t) => {
  const { base, close } = await boot();
  t.after(close);

  const preflight = await fetch(`${base}/v1/auth/session`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-app-key',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  const allowed = preflight.headers.get('access-control-allow-headers') ?? '';
  assert.match(allowed, /x-app-key/);
  assert.match(allowed, /idempotency-key/);
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);

  // Resposta real também precisa da origem liberada, senão o navegador esconde o corpo.
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.headers.get('access-control-allow-origin'), '*');
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

test('conversa em SSE devolve as fases e a resposta no contrato do app', async (t) => {
  const { base, pool, close } = await boot();
  t.after(close);

  const { token } = await session(base, 'aparelho-1234');
  const response = await fetch(`${base}/v1/agent/conversa`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      mensagem: 'quero começar o tcc',
      skill_id: 'tcc',
      tarefa: { titulo: 'tcc' },
      historico: [],
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const eventos = await sseEvents(response);
  assert.deepEqual(
    eventos.filter((evento) => evento.evento === 'fase').map((evento) => evento.data),
    ['lendo_memoria', 'resposta'],
  );

  const resposta = JSON.parse(eventos.find((evento) => evento.evento === 'resposta').data);
  assert.equal(resposta.tipo, 'etapa_plano');
  assert.deepEqual(
    resposta.blocos.map((bloco) => bloco.tipo),
    ['texto', 'pergunta', 'etapa', 'etapa'],
  );
  assert.equal(pool.calls, 1);
});

test('conversa exige sessão de aparelho', async (t) => {
  const { base, close } = await boot();
  t.after(close);

  const response = await fetch(`${base}/v1/agent/conversa`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mensagem: 'oi' }),
  });
  assert.equal(response.status, 401);
});

test('conversa recusa conteúdo clínico antes do provedor', async (t) => {
  const { base, pool, close } = await boot();
  t.after(close);

  const { token } = await session(base, 'aparelho-1234');
  const response = await fetch(`${base}/v1/agent/conversa`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ mensagem: 'resumir o prontuário da paciente' }),
  });

  assert.equal(response.status, 422);
  assert.equal(pool.calls, 0);
});

test('conversa com busca devolve as fontes usadas', async (t) => {
  const pedido = { ok: true, text: JSON.stringify({ buscar: 'recorte do tema tcc' }) };
  const pool = {
    calls: 0,
    run: async () => {
      pool.calls += 1;
      return pool.calls === 1 ? pedido : { ok: true, text: JSON.stringify(SAMPLE_OUTPUT) };
    },
  };
  const consultas = [];
  const search = async (query) => {
    consultas.push(query);
    return {
      ok: true,
      results: [
        { titulo: 'Como delimitar um tema', url: 'https://exemplo.org/tema', trecho: 'recorte' },
        { titulo: 'TCC em dez passos', url: 'https://exemplo.org/tcc', trecho: 'passos' },
      ],
    };
  };
  const { base, close } = await boot({ pool, search });
  t.after(close);

  const { token } = await session(base, 'aparelho-1234');
  const response = await fetch(`${base}/v1/agent/conversa`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ mensagem: 'como delimito o tema?', historico: [] }),
  });

  const eventos = await sseEvents(response);
  assert.deepEqual(
    eventos.filter((evento) => evento.evento === 'fase').map((evento) => evento.data),
    ['lendo_memoria', 'pesquisando', 'lendo_fontes', 'resposta'],
  );

  const resposta = JSON.parse(eventos.find((evento) => evento.evento === 'resposta').data);
  assert.deepEqual(consultas, ['recorte do tema tcc']);
  assert.deepEqual(resposta.fontes, [
    { titulo: 'Como delimitar um tema', url: 'https://exemplo.org/tema' },
    { titulo: 'TCC em dez passos', url: 'https://exemplo.org/tcc' },
  ]);
  assert.equal(pool.calls, 2);
});

test('sem busca configurada o turno segue e não inventa fonte', async (t) => {
  const pool = {
    calls: 0,
    run: async () => {
      pool.calls += 1;
      return pool.calls === 1
        ? { ok: true, text: JSON.stringify({ buscar: 'recorte do tema tcc' }) }
        : { ok: true, text: JSON.stringify(SAMPLE_OUTPUT) };
    },
  };
  const { base, close } = await boot({ pool });
  t.after(close);

  const { token } = await session(base, 'aparelho-1234');
  const response = await fetch(`${base}/v1/agent/conversa`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ mensagem: 'como delimito o tema?', historico: [] }),
  });

  const resposta = JSON.parse(
    (await sseEvents(response)).find((evento) => evento.evento === 'resposta').data,
  );
  assert.deepEqual(resposta.fontes, []);
  assert.equal(pool.calls, 2);
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
