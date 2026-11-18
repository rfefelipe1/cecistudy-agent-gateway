// Busca na web pelo gateway (SPEC-038 RF17).
//
// A chave fica no servidor: o app pede o turno, o gateway decide buscar. O que
// sai do aparelho é a consulta escrita pelo modelo — nunca contexto da tarefa.
// Resultado é sanitizado aqui: só http/https, texto curto, sem HTML.

const TAVILY_URL = 'https://api.tavily.com/search';
const MAX_TITLE = 120;
const MAX_CONTENT = 700;

function texto(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function urlSegura(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Busca pronta para o prompt: título, link e trecho. Falha é valor, não exceção. */
export function createTavilySearch({ apiKey, fetchImpl, timeoutMs = 8000, maxResults = 5 }) {
  if (!apiKey) return null;
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (!doFetch) return null;

  return async function search(query) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(TAVILY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query: texto(query, 200),
          max_results: maxResults,
          search_depth: 'basic',
          include_answer: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, results: [] };

      const payload = await response.json().catch(() => null);
      const results = Array.isArray(payload?.results) ? payload.results : [];
      return {
        ok: true,
        results: results
          .map((item) => ({
            titulo: texto(item?.title, MAX_TITLE),
            url: urlSegura(item?.url),
            trecho: texto(item?.content, MAX_CONTENT),
          }))
          .filter((item) => item.url && item.titulo)
          .slice(0, maxResults),
      };
    } catch {
      return { ok: false, results: [] };
    } finally {
      clearTimeout(timeout);
    }
  };
}
