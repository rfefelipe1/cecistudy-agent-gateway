import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { NimPool, callNim } from './nim.js';

const config = loadConfig();
const db = await openDb({ url: config.databaseUrl, authToken: config.databaseAuthToken });

const pool = new NimPool(
  { apiKeys: config.nimApiKeys, maxAttemptsPerKey: config.nimMaxAttemptsPerKey },
  {
    call: (apiKey, messages, signal) =>
      callNim(
        { model: config.nimModel, baseUrl: config.nimBaseUrl, timeoutMs: config.nimTimeoutMs },
        apiKey,
        messages,
        signal,
      ),
  },
);

const server = createServer(createApp({ config, db, pool }));

server.listen(config.port, () => {
  console.log(
    `[gateway] :${config.port} — modelo ${config.nimModel}, ${config.nimApiKeys.length} chave(s), banco ${config.databaseUrl}`,
  );
});

async function shutdown(signal) {
  console.log(`[gateway] ${signal} recebido, encerrando`);
  server.close();
  await db.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
