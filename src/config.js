// Toda leitura de ambiente acontece aqui, e uma variável obrigatória ausente
// derruba o processo no boot — não na primeira requisição de uma usuária.

const DEFAULTS = {
  port: 10000,
  databaseUrl: 'file:./data/gateway.db',
  // Pool ordenada por qualidade: o primeiro que responder bem vence; os
  // seguintes cobrem 404/limite/queda do provedor. `gpt-oss-120b` fecha como
  // saída rápida quando os grandes estão indisponíveis.
  nimModels: [
    'nvidia/nemotron-3-ultra-550b-a55b',
    'deepseek-ai/deepseek-v4-pro',
    'moonshotai/kimi-k3',
    'z-ai/glm-5-3',
    'openai/gpt-oss-120b',
  ],
  nimBaseUrl: 'https://integrate.api.nvidia.com',
  nimTimeoutMs: 60_000,
  nimMaxAttemptsPerKey: 2,
  // Teto do turno de conversa: o app corta em 60 s (SPEC-038 RF15), então o
  // gateway precisa desistir antes para ainda mandar `erro` em vez de sumir.
  conversationTimeoutMs: 50_000,
  tavilyMaxResults: 5,
  sessionTtlSeconds: 12 * 60 * 60,
  adminTtlSeconds: 60 * 60,
  sessionsPerMinutePerIp: 10,
  adminPerMinutePerIp: 5,
  jobsPerMinutePerDevice: 6,
  conversationsPerMinutePerDevice: 20,
  maxBodyBytes: 262_144,
  // Keepalive: ping interno (localhost/healthz) + ping externo (URL confiável).
  // O externo padrão é um endpoint estável do Google; troque por um monitor que
  // bata na URL pública do serviço se quiser evitar sleep do Render por inatividade.
  keepaliveIntervalMs: 5 * 60_000,
  keepaliveTimeoutMs: 10_000,
  keepaliveUrl: 'https://www.gstatic.com/generate_204',
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
    nimModels: list(env.NIM_MODELS).length > 0 ? list(env.NIM_MODELS) : DEFAULTS.nimModels,
    nimBaseUrl: env.NIM_BASE_URL?.trim() || DEFAULTS.nimBaseUrl,
    nimTimeoutMs: positiveNumber(env.NIM_TIMEOUT_MS, DEFAULTS.nimTimeoutMs),
    nimMaxAttemptsPerKey: positiveNumber(env.NIM_MAX_ATTEMPTS_PER_KEY, DEFAULTS.nimMaxAttemptsPerKey),
    conversationTimeoutMs: positiveNumber(
      env.CONVERSATION_TIMEOUT_MS,
      DEFAULTS.conversationTimeoutMs,
    ),
    tavilyApiKey: env.TAVILY_API_KEY?.trim() || '',
    tavilyMaxResults: positiveNumber(env.TAVILY_MAX_RESULTS, DEFAULTS.tavilyMaxResults),
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
    keepaliveIntervalMs: positiveNumber(env.KEEPALIVE_INTERVAL_MS, DEFAULTS.keepaliveIntervalMs),
    keepaliveTimeoutMs: positiveNumber(env.KEEPALIVE_TIMEOUT_MS, DEFAULTS.keepaliveTimeoutMs),
    keepaliveUrl: env.KEEPALIVE_URL?.trim() || DEFAULTS.keepaliveUrl,
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
