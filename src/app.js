// Roteamento do gateway (SPEC-M-039 D2: `/v1/...` e sem prefixo).
//
// Regras que valem como código:
//   - nenhuma resposta, nem de erro, devolve chave da NVIDIA ou segredo;
//   - `POST` de job é idempotente por `Idempotency-Key`/`operationId`;
//   - um job só é visível para o aparelho que o criou;
//   - conteúdo clínico é recusado antes de qualquer chamada ao provedor.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bearerToken,
  createRateLimiter,
  headerValue,
  safeEqual,
  signToken,
  verifyToken,
} from './auth.js';
import { containsClinicalData } from './prompt.js';
import { runJob } from './jobs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = readFileSync(join(HERE, 'admin.html'), 'utf8');
const JOB_KINDS = new Set(['analyze', 'plan', 'artifact']);
const DEVICE_ID = /^[A-Za-z0-9_.:-]{8,200}$/;

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return { ok: false, tooLarge: true };
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * Aceita as duas formas (D2): `/v1/agent/jobs/...`, `/agent/jobs/...` e o
 * contrato antigo do mobile, `/jobs/...`.
 */
function canonical(pathname) {
  let path = pathname;
  if (path === '/v1') path = '/';
  else if (path.startsWith('/v1/')) path = path.slice(3);
  if (path === '/jobs' || path.startsWith('/jobs/')) path = `/agent${path}`;
  return path;
}

export function createApp({
  config,
  db,
  pool,
  now = () => new Date().toISOString(),
  logger = console,
}) {
  const sessions = createRateLimiter();
  const adminAttempts = createRateLimiter();
  const jobAttempts = createRateLimiter();
  const startedAt = Date.now();

  const clientIp = (req) => req.socket?.remoteAddress ?? 'desconhecido';

  function authenticateJwt(req, role) {
    const verified = verifyToken(bearerToken(req), { secret: config.sessionSecret });
    if (!verified.ok || verified.claims?.role !== role) {
      return { ok: false, status: 401, error: 'sessão inválida ou expirada' };
    }
    return { ok: true, claims: verified.claims };
  }

  async function authenticateDevice(req) {
    const auth = authenticateJwt(req, 'device');
    if (!auth.ok) return auth;
    const device = await db.getDevice(auth.claims.sub);
    if (!device) return { ok: false, status: 401, error: 'sessão inválida ou expirada' };
    if (device.revokedAt) return { ok: false, status: 403, error: 'este aparelho foi revogado' };
    return { ok: true, device };
  }

  function rateLimited(res, limiter, key, limit) {
    const result = limiter.check(key, limit);
    if (result.allowed) return false;
    res.setHeader('retry-after', String(result.retryAfterSeconds));
    send(res, 429, { error: 'muitas requisições, tente de novo em instantes' });
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const path = canonical(url.pathname);
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      return send(res, 200, { ok: true, at: now() });
    }

    if (method === 'GET' && path === '/') {
      res.statusCode = 302;
      res.setHeader('location', '/admin');
      return res.end();
    }

    if (method === 'GET' && path === '/admin') {
      return send(res, 200, ADMIN_HTML, 'text/html; charset=utf-8');
    }

    if (method === 'GET' && path === '/models') {
      return send(res, 200, { default: config.nimModel, models: [config.nimModel] });
    }

    // --- sessão de dispositivo -------------------------------------------
    if (method === 'POST' && path === '/auth/session') {
      if (rateLimited(res, sessions, clientIp(req), config.sessionsPerMinutePerIp)) return;

      if (!safeEqual(headerValue(req, 'x-app-key'), config.appKey)) {
        return send(res, 401, { error: 'chave do app inválida' });
      }

      const body = await readJson(req, config.maxBodyBytes);
      if (!body.ok) return send(res, body.tooLarge ? 413 : 400, { error: 'corpo inválido' });

      const installationId = String(body.value?.installationId ?? '').trim();
      if (!DEVICE_ID.test(installationId)) {
        return send(res, 400, { error: 'installationId inválido' });
      }

      const at = now();
      const device = await db.upsertDevice({
        id: installationId,
        appVersion: typeof body.value?.appVersion === 'string' ? body.value.appVersion : undefined,
        at,
      });
      if (device?.revokedAt) {
        return send(res, 403, { error: 'este aparelho foi revogado' });
      }

      const session = signToken(
        { sub: installationId, role: 'device' },
        { secret: config.sessionSecret, ttlSeconds: config.sessionTtlSeconds },
      );
      return send(res, 200, { ...session, deviceId: installationId });
    }

    // --- jobs ------------------------------------------------------------
    if (method === 'POST' && path === '/agent/jobs') {
      const auth = await authenticateDevice(req);
      if (!auth.ok) return send(res, auth.status, { error: auth.error });
      if (rateLimited(res, jobAttempts, auth.device.id, config.jobsPerMinutePerDevice)) return;

      const body = await readJson(req, config.maxBodyBytes);
      if (!body.ok) return send(res, body.tooLarge ? 413 : 400, { error: 'corpo inválido' });

      const operationId = String(
        headerValue(req, 'idempotency-key') ?? body.value?.operationId ?? '',
      ).trim();
      const taskId = String(body.value?.taskId ?? '').trim();
      const kind = String(body.value?.kind ?? 'analyze').trim();
      const payload = body.value?.payload ?? {};

      if (!operationId || operationId.length > 200) {
        return send(res, 400, { error: 'operationId obrigatório' });
      }
      if (!taskId || taskId.length > 200) {
        return send(res, 400, { error: 'taskId obrigatório' });
      }
      if (!JOB_KINDS.has(kind)) return send(res, 400, { error: 'kind inválido' });
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return send(res, 400, { error: 'payload inválido' });
      }

      if (containsClinicalData(JSON.stringify(payload))) {
        return send(res, 422, { error: 'conteúdo clínico não é enviado ao agente' });
      }

      const existing = await db.findJob(operationId);
      if (existing) {
        if (existing.deviceId !== auth.device.id) {
          return send(res, 409, { error: 'operationId já usado por outro aparelho' });
        }
        return send(res, 200, {
          operationId: existing.operationId,
          status: existing.status,
          idempotent: true,
        });
      }

      const at = now();
      const job = await db.createJob({
        operationId,
        deviceId: auth.device.id,
        taskId,
        kind,
        status: 'queued_remote',
        attempts: 0,
        createdAt: at,
        updatedAt: at,
      });

      // 409 só acontece em corrida entre dois POSTs simultâneos do mesmo id.
      if (!job) return send(res, 409, { error: 'job concorrente, tente de novo' });

      send(res, 202, { operationId: job.operationId, status: job.status });

      // Dispatch assíncrono: o app não precisa ficar aberto esperando.
      void runJob({ db, pool, job: { ...job, payload }, now });
      return;
    }

    if (method === 'GET' && path.startsWith('/agent/jobs/')) {
      const auth = await authenticateDevice(req);
      if (!auth.ok) return send(res, auth.status, { error: auth.error });

      const operationId = decodeURIComponent(path.slice('/agent/jobs/'.length));
      const job = operationId ? await db.findJob(operationId) : undefined;
      if (!job || job.deviceId !== auth.device.id) {
        return send(res, 404, { error: 'job não encontrado' });
      }

      return send(res, 200, {
        operationId: job.operationId,
        status: job.status,
        messages: job.result?.messages ?? [],
        plan: job.result?.plan,
        artifacts: job.result?.artifacts ?? [],
        error: job.error,
        attempts: job.attempts,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    }

    // --- admin -----------------------------------------------------------
    if (method === 'POST' && path === '/admin/login') {
      if (rateLimited(res, adminAttempts, clientIp(req), config.adminPerMinutePerIp)) return;
      const body = await readJson(req, config.maxBodyBytes);
      if (!body.ok) return send(res, 400, { error: 'corpo inválido' });

      if (!safeEqual(String(body.value?.password ?? ''), config.adminPassword)) {
        return send(res, 401, { error: 'senha inválida' });
      }

      const session = signToken(
        { sub: 'admin', role: 'admin' },
        { secret: config.sessionSecret, ttlSeconds: config.adminTtlSeconds },
      );
      return send(res, 200, session);
    }

    if (path.startsWith('/admin/')) {
      const auth = authenticateJwt(req, 'admin');
      if (!auth.ok) return send(res, auth.status, { error: auth.error });

      if (method === 'GET' && path === '/admin/overview') {
        const counts = await db.countJobsByStatus();
        const devices = await db.listDevices(500);
        return send(res, 200, {
          model: config.nimModel,
          keyCount: config.nimApiKeys.length,
          deviceCount: devices.length,
          revokedCount: devices.filter((device) => device.revokedAt).length,
          jobs: counts,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        });
      }

      if (method === 'GET' && path === '/admin/devices') {
        return send(res, 200, { devices: await db.listDevices(100) });
      }

      if (method === 'DELETE' && path.startsWith('/admin/devices/')) {
        const id = decodeURIComponent(path.slice('/admin/devices/'.length));
        const revoked = await db.revokeDevice(id, now());
        return send(res, revoked ? 200 : 404, revoked ? { ok: true } : { error: 'aparelho não encontrado' });
      }

      if (method === 'GET' && path === '/admin/jobs') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const jobs = await db.listJobs(limit);
        return send(res, 200, {
          jobs: jobs.map((job) => ({
            operationId: job.operationId,
            deviceId: job.deviceId,
            taskId: job.taskId,
            kind: job.kind,
            status: job.status,
            error: job.error,
            attempts: job.attempts,
            createdAt: job.createdAt,
          })),
        });
      }

      if (method === 'POST' && path === '/admin/playground') {
        const body = await readJson(req, config.maxBodyBytes);
        if (!body.ok) return send(res, 400, { error: 'corpo inválido' });
        const prompt = String(body.value?.prompt ?? '').trim();
        if (!prompt) return send(res, 400, { error: 'prompt obrigatório' });

        const outcome = await pool.run([{ role: 'user', content: prompt.slice(0, 4000) }]);
        if (!outcome.ok) return send(res, 503, { error: outcome.error.safeMessage });
        return send(res, 200, { text: outcome.text });
      }
    }

    return send(res, 404, { error: 'rota não encontrada' });
  }

  return async function handler(req, res) {
    try {
      await handle(req, res);
    } catch (error) {
      logger.error(`[gateway] falha interna: ${error instanceof Error ? error.message : 'desconhecida'}`);
      if (!res.headersSent) send(res, 500, { error: 'falha interna do gateway' });
      else res.end();
    }
  };
}

export { canonical };
