// Pool de chaves NVIDIA NIM com retry e fallback.
//
// A chave nunca sai daqui: o app conhece só o próprio JWT. Toda mensagem de
// erro é sanitizada antes de virar resposta HTTP.

export const NIM_ERROR_MESSAGES = {
  rate_limit: 'limite temporário do provedor',
  provider_down: 'provedor indisponível',
  rejected: 'conteúdo recusado',
  context_too_large: 'contexto grande demais',
  not_found: 'modelo indisponível',
  timeout: 'o provedor não respondeu a tempo',
  unknown: 'o provedor falhou agora',
};

export function nimError(kind, status) {
  return { kind, status, safeMessage: NIM_ERROR_MESSAGES[kind] ?? NIM_ERROR_MESSAGES.unknown };
}

/**
 * Round-robin de **modelo e chave**. Um modelo fora do ar (404/limite/queda)
 * passa para o próximo da lista; erro definitivo (`401`/`402`/`413`/`422`)
 * encerra na hora, porque repetir com outra chave não resolve.
 */
export class NimPool {
  constructor({ apiKeys, models, maxAttemptsPerKey }, adapter) {
    this.apiKeys = apiKeys;
    this.models = models && models.length > 0 ? models : [];
    this.maxAttemptsPerKey = maxAttemptsPerKey;
    this.adapter = adapter;
    this.cursor = 0;
  }

  get size() {
    return this.apiKeys.length;
  }

  get defaultModel() {
    return this.models[0] ?? null;
  }

  nextKey() {
    if (this.apiKeys.length === 0) throw new Error('nim: nenhuma chave configurada');
    const key = this.apiKeys[this.cursor % this.apiKeys.length];
    this.cursor += 1;
    return key;
  }

  async run(messages, signal, { deadline } = {}) {
    if (this.apiKeys.length === 0 || this.models.length === 0) {
      return { ok: false, error: nimError('provider_down', 503) };
    }

    let lastError;
    // Teto de tentativas: 5 modelos × 2 tentativas por chave seria caro demais
    // dentro de 50 s. Um passeio por modelo + uma repetição cobre o caso real.
    const totalAttempts = Math.min(this.models.length * this.maxAttemptsPerKey, this.models.length + 1);

    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      if (deadline && Date.now() >= deadline) {
        return { ok: false, error: nimError('timeout', 504) };
      }
      const model = this.models[attempt % this.models.length];
      const key = this.nextKey();
      const outcome = await this.adapter.call(key, messages, signal, { model, deadline });
      if (outcome.ok) return outcome;

      lastError = outcome.error;
      if (outcome.error.kind === 'rejected' || outcome.error.kind === 'context_too_large') {
        return outcome;
      }
    }

    return { ok: false, error: lastError ?? nimError('provider_down', 503) };
  }
}

export async function callNim(config, apiKey, messages, signal, options = {}) {
  const { model = config.model, maxTokens = 2048, deadline } = options;
  const remaining = deadline ? Math.max(0, deadline - Date.now()) : config.timeoutMs;
  if (remaining <= 0) return { ok: false, error: nimError('timeout', 504) };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, remaining));
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  const body = {
    model,
    messages,
    temperature: 0.7,
    max_tokens: maxTokens,
    stream: false,
  };

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 429) return { ok: false, error: nimError('rate_limit', 429) };
    if (response.status === 401 || response.status === 402) {
      return { ok: false, error: nimError('rejected', response.status) };
    }
    if (response.status === 404) return { ok: false, error: nimError('not_found', 404) };
    if (response.status === 413) return { ok: false, error: nimError('context_too_large', 413) };
    if (response.status === 422) return { ok: false, error: nimError('rejected', 422) };
    if (response.status === 503) return { ok: false, error: nimError('provider_down', 503) };
    if (!response.ok) return { ok: false, error: nimError('provider_down', response.status) };

    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: nimError('unknown') };
    }
    return { ok: true, text: content };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return { ok: false, error: nimError(aborted ? 'rate_limit' : 'provider_down') };
  } finally {
    clearTimeout(timeout);
  }
}
