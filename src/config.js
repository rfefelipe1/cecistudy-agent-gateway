// Toda leitura de ambiente acontece aqui, e uma variável obrigatória ausente
// derruba o processo no boot — não na primeira requisição de uma usuária.

const DEFAULTS = {
  port: 10000,
  databaseUrl: 'file:./data/gateway.db',
  nimModel: 'nvidia/nemotron-3.5-bolt-e4b',
  nimBaseUrl: 'https://integrate.api.nvidia.com',
  nimTimeoutMs: 60_000,
  nimMaxAttemptsPerKey: 2,
  sessionTtlSeconds: 12 * 60 * 60,
  adminTtlSeconds: 60 * 60,
  sessionsPerMinutePerIp: 10,
  adminPerMinutePerIp: 5,
  jobsPerMinutePerDevice: 6,
  conversationsPerMinutePerDevice: 20,
  maxBodyBytes: 262_144,
};

const REQUIRED = [
  ['NIM_API_KEYS', 'chave(s) da NVIDIA NIM, separadas por vírgula'],
  ['GATEWAY_SESSION_SECRET', 'segredo de assinatura do token de sessão (mínimo 32 caracteres)'],
  ['AGENT_APP_KEY', 'chave que o app envia em X-App-Key para abrir sessão'],
  ['ADMIN_PASSWORD', 'senha do painel administrativo'],
];

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function list(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const config = {
    port: positiveNumber(env.PORT, DEFAULTS.port),
    databaseUrl: env.DATABASE_URL?.trim() || DEFAULTS.databaseUrl,
    databaseAuthToken: env.DATABASE_AUTH_TOKEN?.trim() || undefined,
    nimApiKeys: list(env.NIM_API_KEYS),
    nimModel: env.NIM_MODEL?.trim() || DEFAULTS.nimModel,
    nimBaseUrl: env.NIM_BASE_URL?.trim() || DEFAULTS.nimBaseUrl,
    nimTimeoutMs: positiveNumber(env.NIM_TIMEOUT_MS, DEFAULTS.nimTimeoutMs),
    nimMaxAttemptsPerKey: positiveNumber(env.NIM_MAX_ATTEMPTS_PER_KEY, DEFAULTS.nimMaxAttemptsPerKey),
    sessionSecret: env.GATEWAY_SESSION_SECRET?.trim() || '',
    sessionTtlSeconds: positiveNumber(env.SESSION_TTL_SECONDS, DEFAULTS.sessionTtlSeconds),
    adminTtlSeconds: positiveNumber(env.ADMIN_TTL_SECONDS, DEFAULTS.adminTtlSeconds),
    appKey: env.AGENT_APP_KEY?.trim() || '',
    adminPassword: env.ADMIN_PASSWORD?.trim() || '',
    sessionsPerMinutePerIp: positiveNumber(env.SESSIONS_PER_MINUTE_PER_IP, DEFAULTS.sessionsPerMinutePerIp),
    adminPerMinutePerIp: positiveNumber(env.ADMIN_PER_MINUTE_PER_IP, DEFAULTS.adminPerMinutePerIp),
    jobsPerMinutePerDevice: positiveNumber(env.JOBS_PER_MINUTE_PER_DEVICE, DEFAULTS.jobsPerMinutePerDevice),
    conversationsPerMinutePerDevice: positiveNumber(
      env.CONVERSATIONS_PER_MINUTE_PER_DEVICE,
      DEFAULTS.conversationsPerMinutePerDevice,
    ),
    maxBodyBytes: positiveNumber(env.MAX_BODY_BYTES, DEFAULTS.maxBodyBytes),
  };

  const missing = REQUIRED.filter(([key]) => !env[key]?.trim()).map(
    ([key, why]) => `${key} — ${why}`,
  );
  if (config.sessionSecret && config.sessionSecret.length < 32) {
    missing.push('GATEWAY_SESSION_SECRET — precisa de pelo menos 32 caracteres');
  }
  if (missing.length > 0) {
    throw new Error(`configuração incompleta:\n  - ${missing.join('\n  - ')}`);
  }

  return config;
}

export { DEFAULTS };
