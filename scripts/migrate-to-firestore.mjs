import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import neo4j from 'neo4j-driver';

const { Client } = pg;
const args = new Set(process.argv.slice(2));
const option = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const dryRun = args.has('--dry-run');
const importPostgres = !args.has('--neo4j-only');
const importNeo4j = !args.has('--pg-only') && !args.has('--no-neo4j');
const maxRows = Number(option('--max-rows')) || Infinity;
const tableFilter = option('--tables')?.split(',').map(value => value.trim()).filter(Boolean);
const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
const databaseId = process.env.FIRESTORE_DATABASE_ID || '(default)';
if (!projectId && !dryRun) throw new Error('Set FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT');

async function serviceAccount() {
  if (process.env.FIRESTORE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIRESTORE_SERVICE_ACCOUNT_JSON);
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path) return JSON.parse(await readFile(path, 'utf8'));
  throw new Error('Set FIRESTORE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS');
}

let cachedToken;
let tokenExpires = 0;
async function accessToken() {
  if (cachedToken && Date.now() < tokenExpires - 60000) return cachedToken;
  const account = await serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const b64 = value => Buffer.from(value).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: account.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const input = `${header}.${claim}`;
  const signer = createSign('RSA-SHA256'); signer.update(input);
  const assertion = `${input}.${signer.sign(account.private_key, 'base64url')}`;
  const response = await fetch(account.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Google token exchange failed: ${JSON.stringify(data)}`);
  cachedToken = data.access_token; tokenExpires = Date.now() + Number(data.expires_in || 3600) * 1000;
  return cachedToken;
}

const encode = value => {
  if (value && value.__firestoreVector === true) return { vectorValue: { values: value.values.map(Number) } };
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Buffer.isBuffer(value)) return { bytesValue: value.toString('base64') };
  if (typeof value === 'bigint') return { integerValue: String(value) };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (typeof value === 'object') return { mapValue: { fields: encodeFields(value) } };
  return { stringValue: String(value) };
};
const encodeFields = row => Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, encode(value)]));
const collectionNames = {
  Article: 'articles', Author: 'authors', Publisher: 'publishers', Journal: 'journals', Issue: 'issues', Volume: 'volumes',
  Keyword: 'keywords', Topic: 'topics', Subject_Area: 'subject_areas', Subject_Category: 'subject_categories', Institution: 'institutions',
  Project: 'projects', Project_Member: 'project_members', Project_Keyword: 'project_keywords', Project_Chat_Message: 'chat_messages',
  Project_Journal: 'project_journals', Project_Article_Scope: 'project_article_scopes', Project_Article_Bookmark: 'project_article_bookmarks',
  Sub_Topic: 'sub_topics',
  Subject_Category_Project: 'subject_category_projects', Journal_Ranking: 'journal_rankings', Journal_Ranking_Subject_Category: 'journal_ranking_subject_categories',
  Journal_Subject_Category: 'journal_subject_categories', Author_Article: 'author_articles', Keyword_Article: 'keyword_articles',
  Institution_Author: 'institution_authors', System_Log: 'logs', user: 'users', wallet: 'wallets', wallet_transaction: 'wallet_transactions',
  system_log: 'logs', coin_package: 'coin_packages', payment_transaction: 'payments', Password_Reset_Token: 'password_reset_tokens', Zone: 'zones',
  Journal_ISSN: 'journal_issns', Bookmark: 'bookmarks', Orcid_Scan_Job: 'orcid_scan_jobs', Orcid_Scan_Job_Item: 'orcid_scan_job_items',
  Ranking_Metric: 'ranking_metrics', Article_Citing_Work: 'article_citing_works', Article_Reference: 'article_references',
  analytics_topic_year: 'analytics_topic_year', analytics_keyword_year: 'analytics_keyword_year',
  analytics_journal_year: 'analytics_journal_year', analytics_country_year: 'analytics_country_year',
  analytics_job: 'analytics_jobs',
};
const collectionForTable = table => {
  if (collectionNames[table]) return collectionNames[table];
  const normalized = table.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/^_+|_+$/g, '');
  return normalized.endsWith('s') ? normalized : `${normalized}s`;
};
const normalizePgRow = (row, fields) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
  if (value === null || value === undefined) return [key, value];
  const typeId = fields.find(field => field.name === key)?.dataTypeID;
  if ([20, 21, 23, 700, 701, 1700].includes(typeId) && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) && Number.isSafeInteger(Number(value))) return [key, Number(value)];
  if (key === 'embedding' && typeof value === 'string') {
    try { const vector = JSON.parse(value); if (Array.isArray(vector) && vector.every(item => Number.isFinite(Number(item)))) return [key, { __firestoreVector: true, values: vector }]; } catch { /* preserve provider-specific vector text */ }
  }
  return [key, value];
}));
const root = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId || 'dry-run')}/databases/${encodeURIComponent(databaseId)}/documents`;
async function firestore(path, body) {
  const token = await accessToken();
  const response = await fetch(`${root}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Firestore returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json().catch(() => ({}));
}
async function writeBatch(collection, rows) {
  if (dryRun || !rows.length) return;
  const name = row => `projects/${projectId}/databases/${databaseId}/documents/${collection}/${encodeURIComponent(String(row.id))}`;
  for (let start = 0; start < rows.length; start += 400) {
    await firestore(':commit', { writes: rows.slice(start, start + 400).map(row => ({ update: { name: name(row), fields: encodeFields(row.data) } })) });
  }
}
const idFor = (row, primaryKeys) => {
  const key = primaryKeys.map(name => row[name]).filter(value => value !== undefined && value !== null).map(String).join('__');
  if (!key) throw new Error('Found a PostgreSQL row without a primary key');
  return key.replaceAll('/', '%2F');
};

async function migratePostgres() {
  const client = new Client({ connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : undefined });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT c.table_name, array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS primary_keys
      FROM information_schema.tables c
      LEFT JOIN information_schema.table_constraints tc ON tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND tc.constraint_type='PRIMARY KEY'
      LEFT JOIN information_schema.key_column_usage kcu ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema AND kcu.table_name=tc.table_name
      WHERE c.table_schema='public' AND c.table_type='BASE TABLE' AND c.table_name <> '_prisma_migrations'
      GROUP BY c.table_name ORDER BY c.table_name`);
    let total = 0;
    for (const table of result.rows) {
      if (tableFilter && !tableFilter.includes(table.table_name)) continue;
      const keys = (table.primary_keys || []).filter(Boolean);
      if (!keys.length) { console.warn(`[skip] ${table.table_name} has no primary key`); continue; }
      const identifier = keys.map(key => `"${key.replaceAll('"', '""')}"`).join(',');
      const data = await client.query(`SELECT * FROM "${table.table_name.replaceAll('"', '""')}" ORDER BY ${identifier} LIMIT $1`, [Number.isFinite(maxRows) ? maxRows : 1000000000]);
      const rows = data.rows.map(row => { const normalized = normalizePgRow(row, data.fields); return { id: idFor(row, keys), data: { ...normalized, legacy_table: table.table_name, legacy_primary_key: keys.length === 1 ? row[keys[0]] : keys.map(key => row[key]) } }; });
      await writeBatch(collectionForTable(table.table_name), rows);
      total += rows.length;
      console.log(`[postgres] ${table.table_name}: ${rows.length}${dryRun ? ' (dry run)' : ' migrated'}`);
    }
    console.log(`[postgres] complete: ${total} documents`);
  } finally { await client.end(); }
}

async function migrateNeo4j() {
  const uri = process.env.NEO4J_URI; const username = process.env.NEO4J_USERNAME || process.env.NEO4J_USER; const password = process.env.NEO4J_PASSWORD;
  if (!uri || !username || !password) { console.log('[neo4j] skipped: set NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD'); return; }
  const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
  const session = driver.session();
  try {
    let offset = 0; let totalNodes = 0;
    while (totalNodes < maxRows) {
      const result = await session.run('MATCH (n) RETURN id(n) AS neo4jId, elementId(n) AS elementId, labels(n) AS labels, properties(n) AS properties ORDER BY elementId(n) SKIP $skip LIMIT $limit', { skip: neo4j.int(offset), limit: neo4j.int(Math.min(400, maxRows - totalNodes)) });
      if (!result.records.length) break;
      const rows = result.records.map(record => {
        const elementId = record.get('elementId');
        const neo4jId = record.get('neo4jId').toString();
        const props = normalizeNeoValue(record.get('properties'));
        return { id: `neo4j_${elementId.replaceAll('/', '%2F')}`, data: { element_id: elementId, neo4j_id: neo4jId, labels: record.get('labels'), properties: props, ...safeProperties(props), source: 'neo4j' } };
      });
      await writeBatch('graph_nodes', rows); totalNodes += rows.length; offset += rows.length;
      console.log(`[neo4j] nodes: ${totalNodes}`);
      if (rows.length < 400) break;
    }
    offset = 0; let totalEdges = 0;
    while (totalEdges < maxRows) {
      const result = await session.run('MATCH (a)-[r]->(b) RETURN id(r) AS neo4jId, elementId(r) AS elementId, id(a) AS sourceNeo4jId, id(b) AS targetNeo4jId, elementId(a) AS sourceId, elementId(b) AS targetId, type(r) AS type, properties(r) AS properties ORDER BY elementId(r) SKIP $skip LIMIT $limit', { skip: neo4j.int(offset), limit: neo4j.int(Math.min(400, maxRows - totalEdges)) });
      if (!result.records.length) break;
      const rows = result.records.map(record => ({ id: `neo4j_${record.get('elementId').replaceAll('/', '%2F')}`, data: { element_id: record.get('elementId'), neo4j_id: record.get('neo4jId').toString(), source_id: `neo4j_${record.get('sourceId')}`, target_id: `neo4j_${record.get('targetId')}`, source_neo4j_id: record.get('sourceNeo4jId').toString(), target_neo4j_id: record.get('targetNeo4jId').toString(), type: record.get('type'), properties: normalizeNeoValue(record.get('properties')), source: 'neo4j' } }));
      await writeBatch('graph_edges', rows); totalEdges += rows.length; offset += rows.length;
      console.log(`[neo4j] relationships: ${totalEdges}`);
      if (rows.length < 400) break;
    }
    console.log(`[neo4j] complete: ${totalNodes} nodes, ${totalEdges} relationships`);
  } finally { await session.close(); await driver.close(); }
}
const normalizeNeoValue = value => {
  if (value === null || value === undefined) return value;
  if (typeof value?.toNumber === 'function') { try { const number = value.toNumber(); return Number.isSafeInteger(number) ? number : value.toString(); } catch { return value.toString(); } }
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(normalizeNeoValue);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeNeoValue(item)]));
  return value;
};
const safeProperties = properties => Object.fromEntries(Object.entries(properties || {}).filter(([, value]) => value === null || ['string', 'boolean', 'number'].includes(typeof value) || Array.isArray(value)).map(([key, value]) => [key, value]));

if (importPostgres) {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) throw new Error('Set DATABASE_URL or POSTGRES_URL');
  await migratePostgres();
}
if (importNeo4j) await migrateNeo4j();
