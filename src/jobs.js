// Execução do job: prompt → NIM → JSON validado → `RemoteJob`.
//
// A conversão de saída é feita aqui e não no app: o mobile nunca vê texto cru
// do modelo, só mensagens/plano/artefatos já normalizados.

import { buildMessages, parseOutput, toRemoteResult } from './prompt.js';

export async function runJob({ db, pool, job, now = () => new Date().toISOString() }) {
  const attempts = (job.attempts ?? 0) + 1;
  await db.updateJob(job.operationId, { status: 'processing', updatedAt: now() });

  try {
    const messages = buildMessages({
      kind: job.kind,
      message: job.payload?.message ?? '',
      context: job.payload?.context ?? {},
      history: job.payload?.history ?? [],
    });

    const outcome = await pool.run(messages, undefined);
    if (!outcome.ok) {
      await db.updateJob(job.operationId, {
        status: 'failed',
        error: outcome.error.safeMessage,
        attempts,
        updatedAt: now(),
      });
      return;
    }

    const parsed = parseOutput(outcome.text);
    if (!parsed.ok) {
      await db.updateJob(job.operationId, {
        status: 'failed',
        error: 'o agente respondeu fora do formato esperado',
        attempts,
        updatedAt: now(),
      });
      return;
    }

    await db.updateJob(job.operationId, {
      status: 'done',
      result: toRemoteResult(parsed.value, job.operationId),
      attempts,
      updatedAt: now(),
    });
  } catch {
    await db
      .updateJob(job.operationId, {
        status: 'failed',
        error: 'falha ao processar o job',
        attempts,
        updatedAt: now(),
      })
      .catch(() => undefined);
  }
}
