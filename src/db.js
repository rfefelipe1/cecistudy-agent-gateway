// Persistência do gateway (SPEC-M-039 D4).
//
// libSQL/Turso: em desenvolvimento e teste é `file:./data/gateway.db`; em
// produção é a URL remota. O disco do Render Free é efêmero — SQLite local lá
// perderia jobs e aparelhos a cada deploy, por isso o banco é externo.
//
// Duas tabelas bastam: `devices` (quem pode falar com o gateway) e `jobs`
// (fila idempotente). Não há tabela de sessão: o JWT é stateless e a revogação
// é feita no aparelho.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createClient } from '@libsql/client';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS devices (
     id TEXT PRIMARY KEY,
     app_version TEXT,
     created_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     revoked_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS jobs (
     operation_id TEXT PRIMARY KEY,
     device_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     status TEXT NOT NULL,
     result_json TEXT,
     error TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS jobs_device_idx ON jobs (device_id, created_at DESC)',
];

function ensureDirectory(url) {
  if (!url.startsWith('file:')) return;
  const path = url.slice('file:'.length);
  if (path === ':memory:' || path.startsWith('memory:')) return;
  mkdirSync(dirname(path), { recursive: true });
}

function rowToJob(row) {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    deviceId: row.device_id,
    taskId: row.task_id,
    kind: row.kind,
    status: row.status,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    error: row.error ?? undefined,
    attempts: Number(row.attempts),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    appVersion: row.app_version ?? undefined,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at ?? undefined,
  };
}

export async function openDb({ url, authToken }) {
  ensureDirectory(url);
  const client = createClient({ url, authToken });

  for (const statement of SCHEMA) await client.execute(statement);

  return {
    /** Cria o aparelho na primeira sessão e atualiza o `last_seen_at` depois. */
    async upsertDevice({ id, appVersion, at }) {
      await client.execute({
        sql: `INSERT INTO devices (id, app_version, created_at, last_seen_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                last_seen_at = excluded.last_seen_at,
                app_version = COALESCE(excluded.app_version, devices.app_version)`,
        args: [id, appVersion ?? null, at, at],
      });
      return this.getDevice(id);
    },

    async getDevice(id) {
      const result = await client.execute({
        sql: 'SELECT * FROM devices WHERE id = ?',
        args: [id],
      });
      return rowToDevice(result.rows[0]);
    },

    async listDevices(limit = 100) {
      const result = await client.execute({
        sql: 'SELECT * FROM devices ORDER BY last_seen_at DESC LIMIT ?',
        args: [limit],
      });
      return result.rows.map(rowToDevice);
    },

    async revokeDevice(id, at) {
      const result = await client.execute({
        sql: 'UPDATE devices SET revoked_at = ? WHERE id = ?',
        args: [at, id],
      });
      return Number(result.rowsAffected) > 0;
    },

    async findJob(operationId) {
      const result = await client.execute({
        sql: 'SELECT * FROM jobs WHERE operation_id = ?',
        args: [operationId],
      });
      return rowToJob(result.rows[0]);
    },

    /** Idempotente: o mesmo `operation_id` nunca cria duas linhas. */
    async createJob(job) {
      await client.execute({
        sql: `INSERT INTO jobs
                (operation_id, device_id, task_id, kind, status, result_json, error, attempts, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(operation_id) DO NOTHING`,
        args: [
          job.operationId,
          job.deviceId,
          job.taskId,
          job.kind,
          job.status,
          job.result ? JSON.stringify(job.result) : null,
          job.error ?? null,
          job.attempts ?? 0,
          job.createdAt,
          job.updatedAt,
        ],
      });
      return this.findJob(job.operationId);
    },

    async updateJob(operationId, patch) {
      const fields = [];
      const args = [];
      if (patch.status !== undefined) {
        fields.push('status = ?');
        args.push(patch.status);
      }
      if (patch.result !== undefined) {
        fields.push('result_json = ?');
        args.push(patch.result === null ? null : JSON.stringify(patch.result));
      }
      if (patch.error !== undefined) {
        fields.push('error = ?');
        args.push(patch.error);
      }
      if (patch.attempts !== undefined) {
        fields.push('attempts = ?');
        args.push(patch.attempts);
      }
      fields.push('updated_at = ?');
      args.push(patch.updatedAt);
      args.push(operationId);

      await client.execute({
        sql: `UPDATE jobs SET ${fields.join(', ')} WHERE operation_id = ?`,
        args,
      });
      return this.findJob(operationId);
    },

    async listJobs(limit = 50) {
      const result = await client.execute({
        sql: 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?',
        args: [limit],
      });
      return result.rows.map(rowToJob);
    },

    async countJobsByStatus() {
      const result = await client.execute(
        'SELECT status, COUNT(*) AS total FROM jobs GROUP BY status',
      );
      const counts = {};
      for (const row of result.rows) counts[row.status] = Number(row.total);
      return counts;
    },

    async close() {
      client.close();
    },
  };
}

export { SCHEMA };
