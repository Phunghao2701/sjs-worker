import { HttpError } from '../core/http.js';
import { readOpenAlexKey } from './key-store.js';

const API_BASE = 'https://api.openalex.org';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const normalizedEndpoint = value => {
  const endpoint = String(value || '').replace(/^\/+|\/+$/g, '');
  if (!/^(works|authors|sources|institutions|topics|keywords|publishers|funders|awards|locations|concepts|domains|fields|subfields)(\/[A-Za-z0-9_-]+)?$/.test(endpoint)) {
    throw new HttpError(400, 'Unsupported OpenAlex endpoint', 'OPENALEX_ENDPOINT_INVALID');
  }
  return endpoint;
};

function queryString(query = {}) {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
    if (key === 'api_key' || raw === undefined || raw === null || raw === '') continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) params.append(key, String(value));
  }
  return params.toString();
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1000, 10000)
    : Math.min(500 * (2 ** attempt), 8000);
}

async function requestOpenAlex(ctx, endpoint, search) {
  const url = `${API_BASE}/${endpoint}${search ? `?${search}` : ''}`;
  const headers = { accept: 'application/json' };
  const configuredKey = await readOpenAlexKey(ctx);
  if (configuredKey.value) headers.authorization = `Bearer ${configuredKey.value}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(Math.min(60000, Math.max(1000, Number(ctx.env.OPENALEX_TIMEOUT_MS) || 30000))) });
    } catch (error) {
      if (attempt === 3) throw new HttpError(502, 'OpenAlex request failed', 'OPENALEX_REQUEST_FAILED');
      await delay(Math.min(500 * (2 ** attempt), 8000));
      continue;
    }
    if (response.ok) {
      try { return await response.json(); }
      catch { throw new HttpError(502, 'OpenAlex returned invalid JSON', 'OPENALEX_RESPONSE_INVALID'); }
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await delay(retryDelay(response, attempt));
      continue;
    }
    throw new HttpError(502, `OpenAlex request failed (${response.status})`, 'OPENALEX_REQUEST_FAILED', { upstream_status: response.status });
  }
  throw new HttpError(502, 'OpenAlex request failed after retries', 'OPENALEX_REQUEST_FAILED');
}

/** Fetch OpenAlex directly. Scholarly responses are never read from or written to Firestore. */
export async function openAlexRequest(ctx, endpointInput, query = {}) {
  const endpoint = normalizedEndpoint(endpointInput);
  const search = queryString(query);
  const payload = await requestOpenAlex(ctx, endpoint, search);
  const results = Array.isArray(payload?.results) ? payload.results : payload?.id ? [payload] : [];
  const isList = !endpoint.includes('/');
  if (!isList && results.length) return results[0];
  return { meta: payload?.meta || {}, results, group_by: payload?.group_by || [], cached: false };
}

/** Builds a bounded OpenAlex change window for Member+/Partner incremental refreshes. */
export function openAlexUpdatedFilter(existingFilter, fromDate, throughDate) {
  const filters = [existingFilter, `from_updated_date:${fromDate}`, `to_updated_date:${throughDate}`].filter(Boolean);
  return filters.join(',');
}
