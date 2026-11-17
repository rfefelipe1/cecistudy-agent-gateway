// Sessão de dispositivo e credencial de admin (SPEC-M-039 D3).
//
// O segredo de assinatura vive **só** aqui, no servidor. O app recebe um JWT de
// vida curta; o aparelho é identificado por `installationId` e pode ser revogado
// no painel. Nenhuma chave da NVIDIA passa por esta camada.

import { createHmac, timingSafeEqual } from 'node:crypto';

const encode = (value) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

const decode = (value) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

const hmac = (secret, data) => createHmac('sha256', secret).update(data).digest('base64url');

/** Compara dois segredos sem vazar, pelo tempo, quantos caracteres acertaram. */
export function safeEqual(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signToken(claims, { secret, ttlSeconds, now = Date.now() }) {
  if (!secret) throw new Error('auth: segredo de assinatura ausente');
  const issuedAt = Math.floor(now / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ ...claims, iat: issuedAt, exp: issuedAt + ttlSeconds });
  const body = `${header}.${payload}`;
  return {
    token: `${body}.${hmac(secret, body)}`,
    expiresAt: new Date((issuedAt + ttlSeconds) * 1000).toISOString(),
  };
}

/**
 * Verificação HS256-only: recusar qualquer outro `alg` é o que impede a
 * confusão de algoritmo (o ataque clássico de JWT).
 */
export function verifyToken(token, { secret, now = Date.now() }) {
  if (!secret || typeof token !== 'string') return { ok: false, reason: 'invalid' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'invalid' };

  let header;
  try {
    header = decode(parts[0]);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (header?.alg !== 'HS256' || header?.typ !== 'JWT') return { ok: false, reason: 'invalid' };

  const expected = Buffer.from(hmac(secret, `${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'invalid' };
  }

  let claims;
  try {
    claims = decode(parts[1]);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof claims?.exp !== 'number' || claims.exp * 1000 <= now) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims };
}

export function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
}

export function headerValue(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Janela fixa de contagem por chave. Memória do processo — sobrevive a nada. */
export function createRateLimiter({ windowMs = 60_000 } = {}) {
  const windows = new Map();
  return {
    check(key, limit, now = Date.now()) {
      const entry = windows.get(key);
      if (!entry || entry.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      entry.count += 1;
      if (entry.count <= limit) return { allowed: true, retryAfterSeconds: 0 };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    },
  };
}
