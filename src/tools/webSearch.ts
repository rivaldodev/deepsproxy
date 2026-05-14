import { registry } from './registry.ts';

type SearxngResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  engine?: string;
  engines?: string[];
  publishedDate?: string;
};

function searchEndpoint() {
  return process.env.SEARXNG_SEARCH_URL?.trim()
    || 'http://searxng:8080/search';
}

function searchTimeoutMs() {
  const parsed = Number(process.env.SEARXNG_TIMEOUT_MS || 15000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}

function normalizeLimit(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(Math.floor(value), 10));
}

function simplifyResult(result: SearxngResult) {
  return {
    title: result.title || '',
    url: result.url || '',
    content: result.content || '',
    score: result.score,
    engine: result.engine || result.engines?.join(', '),
    publishedDate: result.publishedDate,
  };
}

export function registerWebSearchTool() {
  if (registry.has('web_search')) return;

  registry.register(
    'web_search',
    'Search the web using SearXNG and return relevant result titles, URLs, and snippets.',
    {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The web search query.',
          minLength: 1,
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return. Default is 5, maximum is 10.',
          minimum: 1,
          maximum: 10,
          default: 5,
        },
      },
      required: ['query'],
    },
    async (args) => {
      const query = String(args.query || '').trim();
      const limit = normalizeLimit(args.limit);

      const url = new URL(searchEndpoint());
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), searchTimeoutMs());

      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return {
            query,
            error: `SearXNG request failed: ${response.status} ${response.statusText}`,
            details: body.slice(0, 1000),
          };
        }

        const data = await response.json() as any;
        const results = Array.isArray(data.results)
          ? data.results.slice(0, limit).map(simplifyResult)
          : [];

        return {
          query,
          results,
          answers: Array.isArray(data.answers) ? data.answers : [],
          suggestions: Array.isArray(data.suggestions) ? data.suggestions.slice(0, 5) : [],
          number_of_results: data.number_of_results,
        };
      } catch (err: any) {
        return {
          query,
          error: err?.name === 'AbortError'
            ? `SearXNG request timed out after ${searchTimeoutMs()}ms`
            : `SearXNG request failed: ${err?.message || String(err)}`,
        };
      } finally {
        clearTimeout(timeout);
      }
    }
  );
}
