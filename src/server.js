import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { NimPool, callNim } from './nim.js';
import { startKeepalive } from './keepalive.js';

const config = loadConfig();
const db = await openDb({ url: config.databaseUrl, authToken: config.databaseAuthToken });

const pool = new NimPool(
  {
    apiKeys: config.nimApiKeys,
    models: config.nimModels,
    maxAttemptsPerKey: config.nimMaxAttemptsPerKey,
  },
  {
    call: (apiKey, messages, signal, options) =>
      callNim(
        { baseUrl: config.nimBaseUrl, timeoutMs: config.nimTimeoutMs },
        apiKey,
        messages,
        signal,
        options,
      ),
  },
);

const server = createServer(createApp({ config, db, pool }));
const keepalive = startKeepalive({
  port: config.port,
  intervalMs: config.keepaliveIntervalMs,
  timeoutMs: config.keepaliveTimeoutMs,
  externalUrl: config.keepaliveUrl,
  logger: console,
});

server.listen(config.port, () => {
  console.log(
    `[gateway] :${config.port} — ${config.nimModels.length} modelo(s), ${config.nimApiKeys.length} chave(s), busca ${config.tavilyApiKey ? 'ligada' : 'desligada'}, banco ${config.databaseUrl}`,
  );
  console.log(
    `[gateway] keepalive a cada ${Math.round(config.keepaliveIntervalMs / 60000)} min — interno + externo (${config.keepaliveUrl || 'desligado'})`,
  );
});

async function shutdown(signal) {
  console.log(`[gateway] ${signal} recebido, encerrando`);
  keepalive.stop();
  server.close();
  await db.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
