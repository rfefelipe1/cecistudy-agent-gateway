import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeEqual, signToken, verifyToken } from '../src/auth.js';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres';
const options = { secret: SECRET, ttlSeconds: 3600 };

test('assina e verifica o próprio token', () => {
  const { token, expiresAt } = signToken({ sub: 'device-1', role: 'device' }, options);
  const verified = verifyToken(token, { secret: SECRET });

  assert.equal(verified.ok, true);
  assert.equal(verified.claims.sub, 'device-1');
  assert.equal(verified.claims.role, 'device');
  assert.ok(new Date(expiresAt).getTime() > Date.now());
});

test('recusa payload adulterado', () => {
  const { token } = signToken({ sub: 'device-1', role: 'device' }, options);
  const [header, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'device-2', role: 'admin', exp: 9_999_999_999 }))
    .toString('base64url');

  const verified = verifyToken(`${header}.${forged}.${signature}`, { secret: SECRET });
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, 'invalid');
});

test('recusa token expirado', () => {
  const past = Date.now() - 2 * 60 * 60 * 1000;
  const { token } = signToken({ sub: 'device-1', role: 'device' }, { ...options, now: past });
  const verified = verifyToken(token, { secret: SECRET });
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, 'expired');
});

test('recusa qualquer algoritmo que não seja HS256', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'x', exp: 9_999_999_999 })).toString('base64url');
  const verified = verifyToken(`${header}.${payload}.`, { secret: SECRET });
  assert.equal(verified.ok, false);
});

test('recusa segredo diferente', () => {
  const { token } = signToken({ sub: 'device-1', role: 'device' }, options);
  assert.equal(verifyToken(token, { secret: 'outro-segredo-de-32-caracteres-ok!!' }).ok, false);
});

test('safeEqual não aceita vazio nem tamanho diferente', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
});
