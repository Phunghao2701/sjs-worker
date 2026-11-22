import { HttpError } from '../core/http.js';
import { readOpenAlexKey } from './key-store.js';

const API_BASE = 'https://api.openalex.org';
const ENTITY_COLLECTIONS = new Map([
  ['works', 'openalex_works'], ['authors', 'openalex_authors'], ['sources', 'openalex_sources'],
  ['institutions', 'openalex_institutions'], ['topics', 'openalex_topics'], ['keywords', 'openalex_keywords'],
  ['publishers', 'openalex_publishers'], ['funders', 'openalex_funders'], ['awards', 'openalex_awards'],
  ['locations', 'openalex_locations'], ['concepts', 'openalex_concepts'], ['domains', 'openalex_domains'],
  ['fields', 'openalex_fields'], ['subfields', 'openalex_subfields'],
]);
const encoder = new TextEncoder();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const normalizedEndpoint = value => {
  const endpoint = String(value || '').replace(/^\/+|\/+$/g, '');
  if (!/^(works|authors|sources|institutions|topics|keywords|publishers|funders|awards|locations|concepts|domains|fields|subfields)(\/[A-Za-z0-9_-]+)?$/.test(endpoint)) {
    throw new HttpError(400, 'Unsupported OpenAlex endpoint', 'OPENALEX_ENDPOINT_INVALID');
  }
  return endpoint;
};

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function queryString(query = {}) {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
    if (key === 'api_key' || raw === undefined || raw === null || raw === '') continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) params.append(key, String(value));
  }
  return params.toString();
}

function openAlexId(value) {
  const id = String(value || '').replace(/\/+$/, '').split('/').pop();
  return /^[A-Za-z0-9_-]+$/.test(id) ? id.toUpperCase() : null;
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
  const configuredKey = await readOpenAlexKey(ctx, { fallbackOnDecryptFailure: true });
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

async function cachedResponse(ctx, cacheId, entityCollection, isList) {
  const page = await ctx.db.get('openalex_query_cache', cacheId);
  if (!page || Number(page.expires_at_ms || 0) <= Date.now()) return null;
  if (Array.isArray(page.inline_results)) return { meta: page.meta || {}, results: page.inline_results, group_by: page.group_by || [], cached: true };
  if (!entityCollection || !Array.isArray(page.result_ids)) return null;
  const documents = await Promise.all(page.result_ids.map(id => ctx.db.get(entityCollection, id)));
  if (documents.some(document => !document?.data)) return null;
  const results = documents.map(document => document.data);
  if (!isList && results[0]) {
    // If the cached entity is missing display_name/title/name, it's a partial projection or corrupted stub
    if (!results[0].display_name && !results[0].title && !results[0].name) {
      return null;
    }
  }
  return isList ? { meta: page.meta || {}, results, group_by: page.group_by || [], cached: true } : { ...results[0], cached: true };
}

async function saveUpdatedEntities(ctx, collection, results) {
  if (!collection || !results.length) return;
  const keyed = results.map(data => ({ data, id: openAlexId(data?.id) })).filter(item => item.id);
  const existing = await Promise.all(keyed.map(item => ctx.db.get(collection, item.id)));
  const writes = [];
  for (let index = 0; index < keyed.length; index += 1) {
    const { id, data } = keyed[index];
    const previous = existing[index];
    const previousData = previous?.data && typeof previous.data === 'object' ? previous.data : {};
    const mergedData = { ...previousData, ...data };
    const same = previous?.data && JSON.stringify(previous.data) === JSON.stringify(mergedData);
    if (same) continue;
    const previousUpdated = Date.parse(previous?.updated_date || previous?.data?.updated_date || '');
    const incomingUpdated = Date.parse(data.updated_date || '');
    if (previous && Number.isFinite(previousUpdated) && Number.isFinite(incomingUpdated) && incomingUpdated < previousUpdated) continue;
    writes.push({ id, data: { openalex_id: id, updated_date: data.updated_date || previousData.updated_date || null, cached_at: new Date().toISOString(), data: mergedData } });
  }
  if (writes.length) await ctx.db.batchSet(collection, writes);
}

/** Read-through OpenAlex cache. List responses stay inline to avoid one Firestore
 * read per result (which can exceed a Cloudflare Worker's subrequest limit).
 * Detail responses are still stored in their entity collection. */
export async function openAlexRequest(ctx, endpointInput, query = {}, { skipCache = false } = {}) {
  const endpoint = normalizedEndpoint(endpointInput);
  const search = queryString(query);
  const cacheId = await sha256(`${endpoint}?${search}`);
  const entityName = endpoint.split('/')[0];
  const entityCollection = ENTITY_COLLECTIONS.get(entityName);
  const isList = !endpoint.includes('/');
  const cached = skipCache ? null : await cachedResponse(ctx, cacheId, entityCollection, isList);
  if (cached) return cached;

  const payload = await requestOpenAlex(ctx, endpoint, search);
  const results = Array.isArray(payload?.results) ? payload.results : payload?.id ? [payload] : [];
  await saveUpdatedEntities(ctx, entityCollection, isList ? [] : results);
  const resultIds = isList ? [] : results.map(row => openAlexId(row.id)).filter(Boolean);
  const serializedResults = JSON.stringify(results);
  const inlineResults = isList
    ? (serializedResults.length <= 700_000 ? results : undefined)
    : (resultIds.length === results.length ? undefined : (serializedResults.length <= 700_000 ? results : undefined));
  const ttlSeconds = Math.max(60, Math.min(604800, Number(ctx.env.OPENALEX_CACHE_TTL_SECONDS) || 21600));
  await ctx.db.set('openalex_query_cache', cacheId, {
    endpoint,
    query: search,
    result_ids: resultIds,
    ...(inlineResults ? { inline_results: inlineResults } : {}),
    meta: payload?.meta || {},
    group_by: payload?.group_by || [],
    cached_at: new Date().toISOString(),
    expires_at_ms: Date.now() + ttlSeconds * 1000,
  });
  if (!isList && results.length) return results[0];
  return { meta: payload?.meta || {}, results, group_by: payload?.group_by || [], cached: false };
}

/** Builds a bounded OpenAlex change window for Member+/Partner incremental refreshes. */
export function openAlexUpdatedFilter(existingFilter, fromDate, throughDate) {
  const filters = [existingFilter, `from_updated_date:${fromDate}`, `to_updated_date:${throughDate}`].filter(Boolean);
  return filters.join(',');
}
