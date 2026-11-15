import { env } from '../env.js';

/**
 * Web search through the Bocha Search API (博查搜索, domestic, filed in China).
 *
 * POST https://api.bochaai.com/v1/web-search
 *   Authorization: Bearer <BOCHA_API_KEY>
 *   Body: { query, count }
 * Response shape (defensively parsed): data.webPages.value[] with
 * { name, url, snippet }.
 *
 * The function never throws: no key, network failure or a bad response all
 * come back as a short plain-text message, so a turn never crashes because
 * search is unavailable.
 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const MAX_RESULTS = 5;
const MAX_SNIPPET_CHARS = 200;

function truncate(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

export function bochaConfigured(): boolean {
  return env.bochaKey.length > 0;
}

export async function bochaSearch(query: string, count = MAX_RESULTS): Promise<string> {
  const q = (query ?? '').trim();
  if (!q) return 'Empty search query.';
  if (!bochaConfigured()) {
    return 'Web search is not configured: BOCHA_API_KEY is not set on the server. Tell the user search needs a Bocha API key before it can look things up, and do not invent results.';
  }
  const n = Math.min(Math.max(Math.floor(count) || MAX_RESULTS, 1), MAX_RESULTS);
  let res: Response;
  try {
    res = await fetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.bochaKey}` },
      body: JSON.stringify({ query: q, count: n }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    return `Web search failed (network error: ${e?.message ?? e}). Tell the user the search did not run.`;
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return 'Web search failed: the Bocha API key was rejected (401/403). Tell the user the key looks wrong or expired.';
    }
    return `Web search failed (Bocha returned HTTP ${res.status}). Tell the user the search did not run.`;
  }
  let payload: any;
  try {
    payload = await res.json();
  } catch {
    return 'Web search failed: Bocha returned a response that could not be read. Tell the user the search did not run.';
  }
  const values = payload?.data?.webPages?.value ?? payload?.data?.value ?? [];
  const hits: SearchHit[] = (Array.isArray(values) ? values : [])
    .slice(0, MAX_RESULTS)
    .map((v: any) => ({
      title: truncate(String(v?.name ?? v?.title ?? 'Untitled'), 120),
      url: String(v?.url ?? ''),
      snippet: truncate(String(v?.snippet ?? v?.summary ?? ''), MAX_SNIPPET_CHARS),
    }))
    .filter((h) => h.url || h.snippet);
  if (!hits.length) return `No web results for "${q}".`;
  return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`).join('\n');
}
