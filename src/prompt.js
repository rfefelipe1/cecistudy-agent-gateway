// Prompt, bloqueio clínico e contrato de saída (SPEC-M-039 D8).
//
// O modelo devolve **um objeto JSON**. Este arquivo é o único lugar que traduz
// esse JSON para o formato que o mobile já consome (`messages`/`plan`/
// `artifacts`). Se a saída não validar, o job falha com erro nomeado — nunca
// entra lixo estruturado na conversa.

export const SYSTEM_PROMPT = `Você é o Cecinho, um agente acolhedor na conversa e objetivo no plano.

Sua função é ajudar a usuária a organizar e executar tarefas acadêmicas sem substituir
sua autoria, suas ideias ou suas decisões.

Use somente o contexto fornecido.
Não invente prazos, referências, fatos ou decisões.
Faça no máximo três perguntas por rodada.
Aceite que a usuária responda "não sei".
Se o prazo estiver muito próximo, proponha um plano mínimo viável.
Não trate dados clínicos ou de atendimento.
Não conclua a tarefa principal sem confirmação.
Separe claramente fatos, sugestões, perguntas e ações.
Responda em português brasileiro.

Responda SEMPRE com um único objeto JSON, sem texto fora dele, neste formato:
{
  "kind": "message" | "question" | "plan" | "completed",
  "message": "o que você quer dizer para a usuária, em português brasileiro",
  "questions": [{ "id": "q1", "text": "pergunta objetiva" }],
  "plan": {
    "objective": "o que a tarefa precisa entregar",
    "expectedOutput": "formato esperado da entrega",
    "steps": [
      { "title": "passo curto", "description": "detalhe opcional", "dueDate": "YYYY-MM-DD" }
    ]
  },
  "artifacts": [
    { "name": "roteiro", "mimeType": "text/markdown", "content": "conteúdo curto" }
  ]
}

Regras do JSON:
- "message" é obrigatório e sempre presente.
- "questions" no máximo 3; use quando faltar informação essencial.
- "plan" quando você já consegue propor um caminho; no máximo 12 passos.
- "artifacts" no máximo 3, cada um com no máximo 1000 caracteres.
- Nunca inclua "dueDate" que você não tenha recebido do contexto.`;

// Bloqueio grosseiro de conteúdo clínico: o runtime do mobile já recusa a
// tarefa, isto é a segunda barreira (defesa em profundidade, não a única).
const CLINICAL_KEYWORDS = [
  'prontuário',
  'laudo médico',
  'receituário',
  'atestado',
  'diagnóstico',
  'prescrição',
  'medicação',
  'consulta médica',
  'exame clínico',
  'histórico clínico',
  'paciente',
  'doença',
  'sintoma',
  'tratamento médico',
  'cid-',
];

export function containsClinicalData(text) {
  const lower = String(text ?? '').toLowerCase();
  return CLINICAL_KEYWORDS.some((keyword) => lower.includes(keyword));
}

const MODE_HINT = {
  analyze: 'Entenda a tarefa e devolva uma mensagem curta; pergunte só o essencial.',
  plan: 'Proponha um plano com passos pequenos e verificáveis.',
  artifact: 'Proponha um artefato curto e útil, além da mensagem.',
};

export function buildMessages({ kind = 'analyze', message = '', context = {} }) {
  const contextJson = JSON.stringify(context ?? {});
  const user = [
    `Modo: ${MODE_HINT[kind] ?? MODE_HINT.analyze}`,
    `Idioma: pt-BR`,
    'Contexto fornecido (use somente isso):',
    contextJson,
    '',
    'Mensagem da usuária:',
    String(message ?? ''),
    '',
    'Responda com o objeto JSON do formato definido, em português brasileiro.',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * Acha o primeiro objeto JSON balanceado, respeitando strings e escapes.
 * Regex guloso quebra quando o modelo escreve dois objetos; isto não.
 */
export function firstJsonObject(text) {
  const input = String(text ?? '');
  const start = input.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, index + 1);
    }
  }
  return null;
}

function repairJson(text) {
  const cleaned = String(text).replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function asText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asDate(value) {
  const text = asText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

const KINDS = new Set(['message', 'question', 'plan', 'completed']);

export function normalizeOutput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const message = asText(raw.message, 4000);
  if (!message) return { ok: false };

  const questions = Array.isArray(raw.questions)
    ? raw.questions
        .slice(0, 3)
        .map((question, index) => ({
          id: asText(question?.id, 80) || `q${index + 1}`,
          text: asText(question?.text, 500),
        }))
        .filter((question) => question.text)
    : [];

  let plan;
  if (raw.plan && typeof raw.plan === 'object' && !Array.isArray(raw.plan)) {
    const steps = Array.isArray(raw.plan.steps)
      ? raw.plan.steps
          .map((step) => ({
            title: asText(step?.title, 200),
            description: asText(step?.description, 500) || undefined,
            dueDate: asDate(step?.dueDate),
          }))
          .filter((step) => step.title)
          .slice(0, 12)
      : [];
    const objective = asText(raw.plan.objective, 500);
    if (objective && steps.length > 0) {
      plan = { objective, expectedOutput: asText(raw.plan.expectedOutput, 500) || undefined, steps };
    }
  }

  const artifacts = Array.isArray(raw.artifacts)
    ? raw.artifacts
        .slice(0, 3)
        .map((artifact) => ({
          name: asText(artifact?.name, 120),
          mimeType: asText(artifact?.mimeType, 80) || 'text/markdown',
          content: typeof artifact?.content === 'string' ? artifact.content.slice(0, 1000) : '',
        }))
        .filter((artifact) => artifact.name && artifact.content)
    : [];

  return {
    ok: true,
    value: {
      kind: KINDS.has(raw.kind) ? raw.kind : 'message',
      message,
      questions,
      plan,
      artifacts,
    },
  };
}

export function parseOutput(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { ok: false };

  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const balanced = firstJsonObject(trimmed);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    try {
      const normalized = normalizeOutput(JSON.parse(candidate));
      if (normalized.ok) return normalized;
    } catch {
      // próximo candidato
    }
  }
  for (const candidate of candidates) {
    const repaired = repairJson(candidate);
    if (!repaired) continue;
    const normalized = normalizeOutput(repaired);
    if (normalized.ok) return normalized;
  }
  return { ok: false };
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** Saída validada → o formato `RemoteJob` que o mobile já aplica. */
export function toRemoteResult(output, operationId) {
  const messages = [
    {
      id: `${operationId}-m1`,
      role: 'assistant',
      kind: 'text',
      content: output.message,
    },
  ];

  output.questions.forEach((question, index) => {
    messages.push({
      id: `${operationId}-q${index + 1}`,
      role: 'assistant',
      kind: 'question',
      content: question.text,
      question: { id: question.id, text: question.text },
    });
  });

  const artifacts = output.artifacts.map((artifact, index) => {
    const name = slug(artifact.name) || `artefato-${index + 1}`;
    return {
      name: artifact.name,
      path: `artifacts/${index === 0 ? name : `${name}-${index + 1}`}.md`,
      mimeType: artifact.mimeType,
      content: artifact.content,
    };
  });

  return { messages, plan: output.plan, artifacts };
}
