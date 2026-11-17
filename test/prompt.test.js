import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMessages,
  containsClinicalData,
  firstJsonObject,
  normalizeOutput,
  parseOutput,
  toRemoteResult,
} from '../src/prompt.js';

const valid = {
  kind: 'plan',
  message: 'vamos começar pequeno.',
  questions: [{ id: 'q1', text: 'qual o prazo?' }],
  plan: {
    objective: 'fechar o recorte',
    expectedOutput: 'uma página',
    steps: [{ title: 'listar temas' }, { title: 'escolher um', dueDate: '2026-11-20' }],
  },
  artifacts: [{ name: 'Roteiro', mimeType: 'text/markdown', content: 'passo a passo' }],
};

test('bloqueia conteúdo clínico', () => {
  assert.equal(containsClinicalData('revisar o prontuário da paciente'), true);
  assert.equal(containsClinicalData('organizar o TCC'), false);
});

test('lê JSON puro, cercado por texto e em bloco markdown', () => {
  const json = JSON.stringify(valid);
  assert.equal(parseOutput(json).ok, true);
  assert.equal(parseOutput(`Claro!\n${json}\nEspero ajudar.`).ok, true);
  assert.equal(parseOutput('```json\n' + json + '\n```').ok, true);
});

test('repara vírgula sobrando', () => {
  const parsed = parseOutput('{"kind":"message","message":"oi",}');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.message, 'oi');
});

test('recusa saída sem mensagem', () => {
  assert.equal(parseOutput('{"kind":"message"}').ok, false);
  assert.equal(parseOutput('texto qualquer sem json').ok, false);
});

test('firstJsonObject ignora chave dentro de string', () => {
  const text = 'antes {"message":"use {assim}","plan":{"objective":"x"}} depois';
  const found = firstJsonObject(text);
  assert.equal(found, '{"message":"use {assim}","plan":{"objective":"x"}}');
});

test('corta excesso de perguntas e passos', () => {
  const normalized = normalizeOutput({
    message: 'oi',
    questions: Array.from({ length: 6 }, (_, index) => ({ id: `q${index}`, text: `p${index}` })),
    plan: { objective: 'x', steps: Array.from({ length: 20 }, (_, index) => ({ title: `s${index}` })) },
  });
  assert.equal(normalized.value.questions.length, 3);
  assert.equal(normalized.value.plan.steps.length, 12);
});

test('plano sem objetivo é descartado, mensagem fica', () => {
  const normalized = normalizeOutput({ message: 'oi', plan: { steps: [{ title: 'a' }] } });
  assert.equal(normalized.value.plan, undefined);
  assert.equal(normalized.value.message, 'oi');
});

test('traduz para o formato que o mobile aplica', () => {
  const result = toRemoteResult(normalizeOutput(valid).value, 'op-1');

  assert.equal(result.messages[0].kind, 'text');
  assert.equal(result.messages[0].id, 'op-1-m1');
  assert.equal(result.messages[1].kind, 'question');
  assert.equal(result.messages[1].question.text, 'qual o prazo?');
  assert.equal(result.plan.steps.length, 2);
  assert.equal(result.plan.steps[1].dueDate, '2026-11-20');
  assert.equal(result.artifacts[0].path, 'artifacts/roteiro.md');
  assert.equal(result.artifacts[0].mimeType, 'text/markdown');
});

test('data inválida não vira dueDate', () => {
  const normalized = normalizeOutput({
    message: 'oi',
    plan: { objective: 'x', steps: [{ title: 'a', dueDate: '20/11/2026' }] },
  });
  assert.equal(normalized.value.plan.steps[0].dueDate, undefined);
});

test('mensagem leva o contexto e o modo', () => {
  const messages = buildMessages({ kind: 'plan', message: 'me ajuda', context: { task: 'TCC' } });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /JSON/);
  assert.match(messages[1].content, /TCC/);
  assert.match(messages[1].content, /plano/);
});
