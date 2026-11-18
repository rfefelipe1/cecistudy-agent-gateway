# cecistudy-agent-gateway

Gateway do **Cecinho Agent**: a peça de servidor que deixa o app `cecistudy`
conversar com a NVIDIA NIM sem carregar chave de API no aparelho.

- **Uma responsabilidade:** autenticar o aparelho, enfileirar o job e chamar o modelo.
- **Sem chave no app:** a única credencial da NVIDIA que existe mora no ambiente deste serviço.
- **Sem build:** Node ESM puro; `node src/server.js` roda o que está no repositório.

## Como funciona

```
app mobile ──(X-App-Key)──► POST /v1/auth/session ──► JWT (12h)
                                                                 │
app mobile ──(Bearer JWT)──► POST /v1/agent/jobs ──► 202 ──┐
                                                            ├─► NIM ─► JSON validado
app mobile ──(Bearer JWT)──► GET  /v1/agent/jobs/:id ──► done
```

Três decisões que valem como código:

1. **Sessão de dispositivo.** `POST /v1/auth/session` troca `installationId` +
   `X-App-Key` por um JWT HS256 de vida curta. O segredo de assinatura nunca sai
   daqui. Revogar o aparelho no painel derruba a sessão na requisição seguinte.
2. **Fila idempotente.** `Idempotency-Key` (ou `operationId` no corpo) identifica
   o job. Repetir a chamada devolve o job existente; nunca cria outro.
3. **Saída normalizada.** O modelo responde JSON; o gateway valida, corta excesso
   (3 perguntas, 12 passos, 3 artefatos) e entrega ao app no formato
   `messages` / `plan` / `artifacts`. Texto cru do modelo não chega na tela.

Conteúdo clínico é recusado (`422`) antes de qualquer chamada ao provedor.

## Endpoints

| Método | Rota | Auth | O que faz |
|---|---|---|---|
| GET | `/healthz` | — | liveness, não toca no provedor |
| GET | `/v1/models` | — | modelo habilitado |
| POST | `/v1/auth/session` | `X-App-Key` | abre sessão do aparelho |
| POST | `/v1/agent/jobs` | Bearer | cria job (202) |
| GET | `/v1/agent/jobs/:id` | Bearer | estado, mensagens, plano, artefatos |
| POST | `/v1/agent/conversa` | Bearer | turno do Cecinho em SSE (`fase`, `resposta`, `erro`) |
| POST | `/v1/admin/login` | senha | token do painel (1h) |
| GET | `/v1/admin/overview` | admin | modelo, chaves, contadores |
| GET | `/v1/admin/devices` | admin | aparelhos conhecidos |
| DELETE | `/v1/admin/devices/:id` | admin | revoga aparelho |
| GET | `/v1/admin/jobs?limit=` | admin | últimos jobs |
| POST | `/v1/admin/playground` | admin | prompt direto no modelo |
| GET | `/admin` | — | painel (HTML servido pelo próprio gateway) |

As rotas de job também respondem **sem** o prefixo `/v1` (`/jobs`,
`/jobs/:id`), para não quebrar cliente antigo.

## Rodando local

```bash
npm install
cp .env.example .env      # preencha NIM_API_KEYS, GATEWAY_SESSION_SECRET, AGENT_APP_KEY, ADMIN_PASSWORD
npm run dev               # http://localhost:10000/admin
```

Sem banco externo, o `DATABASE_URL` padrão é `file:./data/gateway.db`.
Gere o segredo com:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Testes (26, sem rede):

```bash
npm test
```

## Deploy no Render

1. Crie o banco no [Turso](https://turso.tech) (free) e guarde `libsql://...` + o token.
2. No Render: **New → Blueprint**, aponte para este repositório (`render.yaml`).
3. Preencha os segredos marcados `sync: false`:

| Variável | De onde vem |
|---|---|
| `DATABASE_URL` | `libsql://<banco>-<org>.turso.io` |
| `DATABASE_AUTH_TOKEN` | token do Turso |
| `NIM_API_KEYS` | NVIDIA NIM, separadas por vírgula |
| `GATEWAY_SESSION_SECRET` | 32+ caracteres aleatórios |
| `AGENT_APP_KEY` | string aleatória; vai também no app |
| `ADMIN_PASSWORD` | senha do painel |

4. Confira `GET https://<serviço>.onrender.com/healthz` → `{"ok":true}`.
5. Abra `/admin`, entre com a senha e teste o playground.

**Por que Turso e não SQLite no disco:** o Web Service Free do Render tem disco
efêmero — jobs e aparelhos sumiriam a cada deploy ou reinício.

**Cold start:** o plano free suspende após ~15 min sem tráfego. A primeira
requisição depois disso demora alguns segundos; o app trata como timeout e
tenta de novo.

## Variáveis

Todas em `.env.example`. As quatro obrigatórias: `NIM_API_KEYS`,
`GATEWAY_SESSION_SECRET`, `AGENT_APP_KEY`, `ADMIN_PASSWORD`. O processo recusa
subir sem elas.

## Contrato com o app

`GET /v1/agent/jobs/:id` devolve:

```json
{
  "operationId": "op-1",
  "status": "done",
  "messages": [
    { "id": "op-1-m1", "role": "assistant", "kind": "text", "content": "..." },
    { "id": "op-1-q1", "role": "assistant", "kind": "question", "content": "...",
      "question": { "id": "q1", "text": "..." } }
  ],
  "plan": { "objective": "...", "steps": [{ "title": "...", "dueDate": "YYYY-MM-DD" }] },
  "artifacts": [{ "name": "...", "path": "artifacts/roteiro.md", "mimeType": "text/markdown", "content": "..." }],
  "error": null
}
```

O plano sempre chega ao app como **rascunho**: quem decide se vira tarefa é a
usuária, nunca o agente.

## Limites conhecidos

- Persistência de job em processo único; não há worker separado nem retomada de
  job interrompido no meio (`processing` órfão fica `processing`).
- Rate limit em memória do processo: reiniciar zera a janela.
- Sem streaming: o app consulta o estado por polling.
