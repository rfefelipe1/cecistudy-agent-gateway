// Turno de conversa: modelo → (busca) → modelo → `RespostaCecinho`.
//
// Por que o pedido de busca é um JSON (`{ "buscar": "..." }`) e não tool calling
// da OpenAI: o contrato do modelo já é "responda um único objeto JSON". Uma
// chamada de ferramenta abriria um segundo formato de saída e ainda precisaria
// de uma rodada final em JSON; o campo `buscar` faz o mesmo com um formato só e
// reaproveita `parseOutput`. Limite: no máximo duas buscas por turno.

import { buildConversationMessages, parseOutput, parseSearchRequest, toConversationResponse } from './prompt.js';

const MAX_BUSCAS = 2;
const MAX_FONTES = 5;

function resultadoDaBusca(results) {
  const linhas = results.map(
    (item, index) => `[${index + 1}] ${item.titulo}\n${item.url}\n${item.trecho}`,
  );
  return [
    'Resultados da busca (use só o que estiver aqui; cite pelo título):',
    ...linhas,
    '',
    'Agora responda no formato JSON normal. Não peça outra busca se já tem o suficiente.',
  ].join('\n');
}

function semResultado(query) {
  return [
    `A busca por "${query}" não devolveu resultados.`,
    'Responda com o que o contexto permite e diga que não encontrou fontes sobre isso.',
  ].join('\n');
}

/**
 * `onPhase` recebe `pesquisando`/`lendo_fontes` para o loader do app.
 * Falha de busca não derruba o turno: o modelo responde avisando.
 */
export async function runConversation({ pool, search, request, signal, deadline, onPhase }) {
  const messages = buildConversationMessages(request);
  const fontes = [];
  let outcome = await pool.run(messages, signal, { deadline });

  for (let busca = 0; busca < MAX_BUSCAS; busca += 1) {
    if (!outcome.ok) return { ok: false, error: outcome.error };

    const pedido = parseSearchRequest(outcome.text);
    if (!pedido) break;
    if (!search) {
      messages.push(
        { role: 'assistant', content: outcome.text },
        { role: 'user', content: semResultado(pedido.query) },
      );
      outcome = await pool.run(messages, signal, { deadline });
      continue;
    }
    if (deadline && Date.now() >= deadline) break;

    onPhase?.('pesquisando');
    const found = await search(pedido.query);

    messages.push({ role: 'assistant', content: outcome.text });
    if (!found.ok || found.results.length === 0) {
      messages.push({ role: 'user', content: semResultado(pedido.query) });
    } else {
      onPhase?.('lendo_fontes');
      for (const fonte of found.results) {
        if (fontes.length >= MAX_FONTES) break;
        if (!fontes.some((item) => item.url === fonte.url)) {
          fontes.push({ titulo: fonte.titulo, url: fonte.url });
        }
      }
      messages.push({ role: 'user', content: resultadoDaBusca(found.results) });
    }
    outcome = await pool.run(messages, signal, { deadline });
  }

  if (!outcome.ok) return { ok: false, error: outcome.error };

  const parsed = parseOutput(outcome.text);
  if (!parsed.ok) return { ok: false, error: { kind: 'invalid_output', safeMessage: 'o agente respondeu fora do formato esperado' } };

  return { ok: true, value: toConversationResponse(parsed.value, fontes) };
}
