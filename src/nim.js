// Pool de chaves NVIDIA NIM com retry e fallback.
//
// A chave nunca sai daqui: o app conhece só o próprio JWT. Toda mensagem de
// erro é sanitizada antes de virar resposta HTTP.

export const NIM_ERROR_MESSAGES = {
  rate_limit: 'limite temporário do provedor',
  provider_down: 'provedor indisponível',
  rejected: 'conteúdo recusado',
  context_too_large: 'contexto grande demais',
  unknown: 'o provedor falhou agora',
};

export function nimError(kind, status) {
  return { kind, status, safeMessage: NIM_ERROR_MESSAGES[kind] ?? NIM_ERROR_MESSAGES.unknown };
}

/**
 * Round-robin determinístico. `429`/`503` passam para a próxima chave; erro
 * definitivo (`401`/`402`/`413`/`422`) encerra na hora.
 */
export class NimPool {
  constructor({ apiKeys, maxAttemptsPerKey }, adapter) {
    this.apiKeys = apiKeys;
    this.maxAttemptsPerKey = maxAttemptsPerKey;
    this.adapter = adapter;
    this.cursor = 0;
  }

  get size() {
    return this.apiKeys.length;
  }

  nextKey() {
    if (this.apiKeys.length === 0) throw new Error('nim: nenhuma chave configurada');
    const key = this.apiKeys[this.cursor % this.apiKeys.length];
    this.cursor += 1;
    return key;
  }

  async run(messages, signal) {
    if (this.apiKeys.length === 0) {
      return { ok: false, error: nimError('provider_down', 503) };
    }

    let lastError;
    const totalAttempts = this.apiKeys.length * this.maxAttemptsPerKey;

    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      const key = this.nextKey();
      const outcome = await this.adapter.call(key, messages, signal);
      if (outcome.ok) return outcome;

      lastError = outcome.error;
      if (outcome.error.kind === 'rate_limit' || outcome.error.kind === 'provider_down') {
        continue;
      }
      return outcome;
    }

    return { ok: false, error: lastError ?? nimError('provider_down', 503) };
  }
}

export async function callNim(config, apiKey, messages, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  const body = {
    model: config.model,
    messages,
    temperature: 0.7,
    max_tokens: 2048,
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
