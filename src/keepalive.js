// Keepalive: dois pings a cada intervalo — um interno (o próprio /healthz) e um
// externo (URL confiável, padrão Google generate_204). Falha é logada, nunca
// derruba o processo: keepalive é cortesia de disponibilidade, não caminho crítico.

function withTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, { signal: controller.signal, headers: { 'user-agent': 'cecistudy-gateway-keepalive' } }).finally(
    () => clearTimeout(timer),
  );
}

async function ping(fetchImpl, url, timeoutMs, label, logger) {
  const started = Date.now();
  try {
    const res = await withTimeout(fetchImpl, url, timeoutMs);
    const ms = Date.now() - started;
    if (res.ok || (res.status >= 200 && res.status < 400)) {
      logger.info?.(`[keepalive] ${label} ok ${res.status} ${ms}ms`);
      return { ok: true, status: res.status, ms };
    }
    logger.warn?.(`[keepalive] ${label} status ${res.status} ${ms}ms`);
    return { ok: false, status: res.status, ms };
  } catch (error) {
    const ms = Date.now() - started;
    logger.warn?.(`[keepalive] ${label} falhou ${ms}ms: ${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error), ms };
  }
}

export function startKeepalive({
  port,
  intervalMs,
  timeoutMs,
  externalUrl,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  const internalUrl = `http://127.0.0.1:${port}/healthz`;
  let timer = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const jobs = [ping(fetchImpl, internalUrl, timeoutMs, 'interno', logger)];
      if (externalUrl) jobs.push(ping(fetchImpl, externalUrl, timeoutMs, 'externo', logger));
      await Promise.all(jobs);
    } finally {
      running = false;
    }
  };

  if (intervalMs > 0 && fetchImpl) {
    timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
  }

  return {
    tick,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
