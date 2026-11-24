import { isScimagoCollection, d1Get, d1ListAll, d1Query, d1Write, d1Delete } from './scimago-d1.js';
import { HttpError } from '../core/http.js';
import { decodeDocument, encodeFields, encodeValue, vectorValue } from './codec.js';
import { invalidateProjectLinkCache } from './project-cache.js';

const tokenCache = new Map();
const textEncoder = new TextEncoder();
const b64url = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};

const pemBytes = (pem) => {
  const raw = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const binary = atob(raw);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
};

const parseRunQueryResponse = (text) => {
  if (!text.trim()) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch {
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
};

export class FirestoreClient {
  constructor(env) {
    this.env = env;
    this.projectId = env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT;
    this.databaseId = env.FIRESTORE_DATABASE_ID || '(default)';
    if (!this.projectId) throw new HttpError(500, 'FIREBASE_PROJECT_ID is not configured', 'FIRESTORE_CONFIG_MISSING');
  }

  get root() {
    const emulatorHost = this.env.FIRESTORE_EMULATOR_HOST;
    const api = emulatorHost
      ? `http://${String(emulatorHost).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
      : 'https://firestore.googleapis.com';
    return `${api}/v1/projects/${encodeURIComponent(this.projectId)}/databases/${encodeURIComponent(this.databaseId)}/documents`;
  }

  documentName(collection, id) {
    return `projects/${this.projectId}/databases/${this.databaseId}/documents/${collection}/${encodeURIComponent(String(id))}`;
  }

  async accessToken() {
    const rawServiceAccount = this.env.FIRESTORE_SERVICE_ACCOUNT_JSON;
    if (!rawServiceAccount) throw new HttpError(500, 'FIRESTORE_SERVICE_ACCOUNT_JSON is not configured', 'FIRESTORE_CONFIG_MISSING');
    let account;
    try { account = JSON.parse(rawServiceAccount); } catch { throw new HttpError(500, 'Firestore service account JSON is invalid', 'FIRESTORE_CONFIG_INVALID'); }
    const cached = tokenCache.get(account.client_email);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(textEncoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claims = b64url(textEncoder.encode(JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: account.token_uri || 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })));
    const unsigned = `${header}.${claims}`;
    const key = await crypto.subtle.importKey(
      'pkcs8', pemBytes(account.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
    );
    const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, textEncoder.encode(unsigned)));
    const assertion = `${unsigned}.${b64url(signature)}`;
    const response = await fetch(account.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const body = await response.json();
    if (!response.ok || !body.access_token) throw new HttpError(502, 'Could not obtain a Firestore access token', 'FIRESTORE_AUTH_FAILED');
    tokenCache.set(account.client_email, { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 });
    return body.access_token;
  }

  async request(path, options = {}) {
    const token = this.env.FIRESTORE_EMULATOR_HOST ? null : await this.accessToken();
    const response = await fetch(`${this.root}${path}`, {
      ...options,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text();
      console.error('[firestore] request failed', response.status, body.slice(0, 1000));
      throw new HttpError(502, 'Firestore request failed', 'FIRESTORE_REQUEST_FAILED', { status: response.status });
    }
    if (response.status === 204) return null;
    if (options.responseType === 'text') return response.text();
    return response.json();
  }

  async runQuery(path, options) {
    const text = await this.request(path, { ...options, responseType: 'text' });
    return parseRunQueryResponse(text);
  }

  async get(collection, id, transaction) {
    if (isScimagoCollection(collection) && !this.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured', 'SCIMAGO_D1_NOT_CONFIGURED');
    if (isScimagoCollection(collection) && this.env.RANKINGS_DB) return d1Get(this.env.RANKINGS_DB, collection, id);
    const suffix = transaction ? `?transaction=${encodeURIComponent(transaction)}` : '';
    const document = await this.request(`/${collection}/${encodeURIComponent(String(id))}${suffix}`);
    return document ? decodeDocument(document) : null;
  }

  async batchGet(collection, ids) {
    const uniqueIds = [...new Set((ids || []).map(value => String(value || '')).filter(Boolean))];
    const documents = [];
    for (let start = 0; start < uniqueIds.length; start += 100) {
      const names = uniqueIds.slice(start, start + 100).map(id => this.documentName(collection, id));
      const rows = await this.runQuery(':batchGet', { method: 'POST', body: JSON.stringify({ documents: names }) });
      documents.push(...rows.filter(row => row.found).map(row => decodeDocument(row.found)));
    }
    return documents;
  }

  async set(collection, id, data) {
    if (isScimagoCollection(collection) && !this.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured', 'SCIMAGO_D1_NOT_CONFIGURED');
    if (isScimagoCollection(collection) && this.env.RANKINGS_DB) return d1Write(this.env.RANKINGS_DB, collection, [{ id, data }]);
    const name = this.documentName(collection, id);
    const result = await this.request(`/${collection}/${encodeURIComponent(String(id))}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, fields: encodeFields(data) }),
    });
    invalidateProjectLinkCache(collection, data?.project_id);
    return result;
  }

  async merge(collection, id, data) {
    if (isScimagoCollection(collection) && !this.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured', 'SCIMAGO_D1_NOT_CONFIGURED');
    if (isScimagoCollection(collection) && this.env.RANKINGS_DB) { const prior = await d1Get(this.env.RANKINGS_DB, collection, id); return d1Write(this.env.RANKINGS_DB, collection, [{ id, data: { ...(prior || {}), ...data } }]); }
    const query = new URLSearchParams();
    for (const field of Object.keys(data || {})) query.append('updateMask.fieldPaths', field);
    const name = this.documentName(collection, id);
    const result = await this.request(`/${collection}/${encodeURIComponent(String(id))}?${query}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, fields: encodeFields(data) }),
    });
    invalidateProjectLinkCache(collection, data?.project_id);
    return result;
  }

  async create(collection, id, data) {
    if (isScimagoCollection(collection) && !this.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured', 'SCIMAGO_D1_NOT_CONFIGURED');
    if (isScimagoCollection(collection) && this.env.RANKINGS_DB) { if (await d1Get(this.env.RANKINGS_DB, collection, id)) throw new HttpError(409, 'Document already exists', 'ALREADY_EXISTS'); return d1Write(this.env.RANKINGS_DB, collection, [{ id, data }]); }
    const query = new URLSearchParams({ documentId: String(id) });
    const result = await this.request(`/${collection}?${query}`, {
      method: 'POST',
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
    invalidateProjectLinkCache(collection, data?.project_id);
    return result;
  }

  async delete(collection, id) {
    if (isScimagoCollection(collection) && !this.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured', 'SCIMAGO_D1_NOT_CONFIGURED');
    if (isScimagoCollection(collection) && this.env.RANKINGS_DB) return d1Delete(this.env.RANKINGS_DB, collection, [id]);
    const result = await this.request(`/${collection}/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
    invalidateProjectLinkCache(collection);
    return result;
  }

  async list(collection, { pageSize = 100, pageToken, orderBy } = {}) {
    const query = new URLSearchParams({ pageSize: String(Math.min(Math.max(Number(pageSize) || 100, 1), 1000)) });
    if (pageToken) query.set('pageToken', pageToken);
    if (orderBy) query.set('orderBy', orderBy);
    const result = await this.request(`/${collection}?${query}`);
    return { documents: (result?.documents || []).map(decodeDocument), nextPageToken: result?.nextPageToken || null };
  }

  async listAll(collection, { maxDocuments = Infinity } = {}) {
    if (isScimagoCollection(collection) && !this.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured', 'SCIMAGO_D1_NOT_CONFIGURED');
    if (isScimagoCollection(collection) && this.env.RANKINGS_DB) return d1ListAll(this.env.RANKINGS_DB, collection, maxDocuments);
    const documents = [];
    let pageToken;
    do {
      const page = await this.list(collection, { pageSize: 1000, pageToken });
      documents.push(...page.documents);
      pageToken = page.nextPageToken;
    } while (pageToken && documents.length < maxDocuments);
    return Number.isFinite(maxDocuments) ? documents.slice(0, Math.max(0, maxDocuments)) : documents;
  }

  async query(collection, { filters = [], orderBy = [], limit = 100, offset, findNearest } = {}) {
    if (isScimagoCollection(collection) && !this.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured', 'SCIMAGO_D1_NOT_CONFIGURED');
    if (isScimagoCollection(collection) && this.env.RANKINGS_DB) return d1Query(this.env.RANKINGS_DB, collection, { filters, orderBy, limit, offset });
    const where = filters.length === 1 ? this.fieldFilter(filters[0]) : filters.length > 1
      ? { compositeFilter: { op: 'AND', filters: filters.map(filter => this.fieldFilter(filter)) } }
      : undefined;
    const structuredQuery = {
      from: [{ collectionId: collection }],
      ...(where ? { where } : {}),
      ...(orderBy.length ? { orderBy: orderBy.map(order => ({ field: { fieldPath: order.field }, direction: order.direction || 'ASCENDING' })) } : {}),
      ...(offset !== undefined ? { offset: Math.max(0, Number(offset) || 0) } : {}),
      ...(limit !== undefined ? { limit: Math.min(Math.max(Number(limit) || 1, 1), 1000) } : {}),
      ...(findNearest ? { findNearest: {
        vectorField: { fieldPath: findNearest.field },
        queryVector: encodeValue(vectorValue(findNearest.vector)),
        distanceMeasure: findNearest.distanceMeasure || 'COSINE',
        limit: Math.min(Math.max(Number(findNearest.limit) || 10, 1), 1000),
        ...(findNearest.distanceResultField ? { distanceResultField: findNearest.distanceResultField } : {}),
      } } : {}),
    };
    const rows = await this.runQuery(':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery }) });
    return rows.filter(row => row.document).map(row => {
      const doc = decodeDocument(row.document);
      if (findNearest?.distanceResultField && row.document.fields?.[findNearest.distanceResultField]) {
        doc[findNearest.distanceResultField] = Number(row.document.fields[findNearest.distanceResultField].doubleValue || 0);
      }
      return doc;
    });
  }

  fieldFilter({ field, op = 'EQUAL', value }) {
    return { fieldFilter: { field: { fieldPath: field }, op, value: encodeValue(value) } };
  }

  async batchSet(collection, documents) {
    if (isScimagoCollection(collection) && !this.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured', 'SCIMAGO_D1_NOT_CONFIGURED');
    if (isScimagoCollection(collection) && this.env.RANKINGS_DB) return d1Write(this.env.RANKINGS_DB, collection, documents);
    if (!documents.length) return;
    const writes = documents.map(({ id, data }) => ({
      update: { name: this.documentName(collection, id), fields: encodeFields(data) },
    }));
    for (let start = 0; start < writes.length; start += 400) {
      const chunk = writes.slice(start, start + 400);
      const result = await this.request(':commit', { method: 'POST', body: JSON.stringify({ writes: chunk }) });
      if (result?.writeResults?.some(write => write.updateTime === undefined)) {
        throw new HttpError(502, 'One or more Firestore batch writes failed', 'FIRESTORE_BATCH_FAILED');
      }
    }
    invalidateProjectLinkCache(collection);
  }

  async batchDelete(collection, ids) {
    if (isScimagoCollection(collection) && !this.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured', 'SCIMAGO_D1_NOT_CONFIGURED');
    if (isScimagoCollection(collection) && this.env.RANKINGS_DB) return d1Delete(this.env.RANKINGS_DB, collection, ids);
    const writes = ids.map(id => ({ delete: this.documentName(collection, id) }));
    for (let start = 0; start < writes.length; start += 400) {
      await this.request(':commit', { method: 'POST', body: JSON.stringify({ writes: writes.slice(start, start + 400) }) });
    }
    invalidateProjectLinkCache(collection);
  }

  async beginTransaction() {
    const result = await this.request(':beginTransaction', { method: 'POST', body: JSON.stringify({ options: { readWrite: {} } }) });
    return result?.transaction;
  }

  async commit(writes, transaction) {
    return this.request(':commit', { method: 'POST', body: JSON.stringify({ writes, ...(transaction ? { transaction } : {}) }) });
  }
}
