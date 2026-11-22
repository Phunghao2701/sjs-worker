import { HttpError } from '../core/http.js';
import { defineRoutes } from '../core/router.js';
import { d1Get, d1Query, d1Write, d1ScimagoImportSummary, d1DeleteScimagoYear } from '../firestore/scimago-d1.js';

const MAX_ROWS = 100000;
const MAX_IMPORT_BATCH_ROWS = 500;
const MAX_IMPORT_BATCH_BYTES = 4 * 1024 * 1024;
const METRICS = [
  { code: 'SJR', display: 'SCImago Journal Rank', type: 'SCORE', aliases: ['sjr', 'scimagojournalrank'], kind: 'float' },
  { code: 'SJR_BEST_QUARTILE', display: 'SCImago Best Quartile', type: 'QUARTILE', aliases: ['sjrbestquartile', 'bestquartile', 'quartile'], kind: 'text' },
  { code: 'H_INDEX', display: 'H Index', type: 'INTEGER', aliases: ['hindex'], kind: 'int' },
];

const headerKey = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const normalizeIssn = value => String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
const parseNumber = value => {
  let clean = String(value ?? '').trim().replace(/\s/g, '');
  if (!clean || clean === '-' || clean.toLowerCase() === 'n/a') return null;
  if (clean.includes(',') && !clean.includes('.')) clean = clean.replace(',', '.');
  else clean = clean.replace(/,(?=\d{3}(?:\D|$))/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '');
  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
};

function parseCsv(text, { requireData = true, maxRows = MAX_ROWS } = {}) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = input.split(/\r?\n/, 1)[0] || '';
  const delimiter = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) { row.push(field); field = ''; }
    else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some(value => value.trim())) rows.push(row);
  if (quoted) throw new HttpError(400, 'The SCImago CSV contains an unclosed quoted field.', 'SCIMAGO_CSV_INVALID');
  if (rows.length < (requireData ? 2 : 1)) throw new HttpError(400, 'The SCImago CSV has no data rows.', 'SCIMAGO_CSV_EMPTY');
  if (rows.length - 1 > maxRows) throw new HttpError(413, `The SCImago batch exceeds the ${maxRows.toLocaleString()} row limit.`, 'SCIMAGO_TOO_MANY_ROWS');
  return rows;
}

function csvCell(row, index, headers) {
  for (const name of headers) {
    const position = index.get(name);
    if (position !== undefined && String(row[position] || '').trim()) return String(row[position]).trim();
  }
  return '';
}

function validateHeaders(rawHeader) {
  const parsed = parseCsv(rawHeader, { requireData: false });
  const headers = parsed[0].map(headerKey);
  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  const issnNames = ['issn', 'printissn', 'eissn', 'electronicissn'];
  if (!headers.some(header => issnNames.includes(header))) throw new HttpError(400, 'The CSV must contain an ISSN, Print ISSN, or E-ISSN column.', 'SCIMAGO_ISSN_COLUMN_MISSING');
  const metrics = METRICS.filter(metric => headers.some(header => metric.aliases.includes(header)));
  if (!metrics.length) throw new HttpError(400, 'The CSV must include SJR, SJR Best Quartile, or H Index.', 'SCIMAGO_METRIC_COLUMN_MISSING');
  return { headers, headerIndex, issnNames, metrics };
}

function validateYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1990 || year > 2100) throw new HttpError(400, 'Choose a valid ranking year.', 'SCIMAGO_YEAR_INVALID');
  return year;
}

async function startScimagoImport(ctx) {
  const header = String(ctx.body.header || '');
  if (!header.trim()) throw new HttpError(400, 'The SCImago CSV header is missing.', 'SCIMAGO_FILE_REQUIRED');
  if (new TextEncoder().encode(header).byteLength > 64 * 1024) throw new HttpError(400, 'The SCImago CSV header is too large.', 'SCIMAGO_HEADER_TOO_LARGE');
  const year = validateYear(ctx.body.year);
  if (!ctx.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured.', 'SCIMAGO_D1_NOT_CONFIGURED');
  const existingYear = (await d1ScimagoImportSummary(ctx.env.RANKINGS_DB)).find(item => item.year === year);
  if (Number(existingYear?.ranking_values || 0) > 0) {
    throw new HttpError(409, `SCImago rankings already exist for ${year}. Delete that year's data before starting over to avoid duplicate rankings.`, 'SCIMAGO_YEAR_ALREADY_IMPORTED');
  }
  const { metrics } = validateHeaders(header);
  const importId = crypto.randomUUID();
  const job = {
    id: importId, import_id: importId, status: 'PROCESSING', file_name: String(ctx.body.file_name || ''),
    year, csv_header: header, metric_codes: metrics.map(metric => metric.code),
    requested_by: ctx.user.user_id, last_batch_index: -1, created_at: new Date().toISOString(),
  };
  await d1Write(ctx.env.RANKINGS_DB, 'scimago_import_jobs', [{ id: importId, data: job }]);
  return { status: 202, body: { success: true, data: { import_id: importId, status: job.status } } };
}

async function processScimagoChunk(ctx) {
  const importId = String(ctx.params.importId || '');
  const batchIndex = Number(ctx.body.batch_index);
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= 1000) throw new HttpError(400, 'Invalid SCImago batch index.', 'SCIMAGO_BATCH_INVALID');
  const csv = String(ctx.body.csv || '');
  const byteLength = new TextEncoder().encode(csv).byteLength;
  if (!csv || byteLength > MAX_IMPORT_BATCH_BYTES) throw new HttpError(413, 'Each SCImago batch must be 256 KB or smaller.', 'SCIMAGO_BATCH_TOO_LARGE');
  const job = await d1Get(ctx.env.RANKINGS_DB, 'scimago_import_jobs', importId);
  if (!job) throw new HttpError(404, 'SCImago import was not found.', 'SCIMAGO_IMPORT_NOT_FOUND');
  const batchId = `${importId}_${batchIndex}`;
  const priorBatch = await d1Get(ctx.env.RANKINGS_DB, 'scimago_import_batches', batchId);
  if (priorBatch?.status === 'COMPLETED') return { success: true, data: { ...priorBatch, replayed: true } };
  if (job.status !== 'PROCESSING') throw new HttpError(409, 'This SCImago import is no longer accepting batches.', 'SCIMAGO_IMPORT_CLOSED');

  const parsed = parseCsv(`${job.csv_header}${/[\r\n]$/.test(job.csv_header) ? '' : '\n'}${csv}`, { maxRows: MAX_IMPORT_BATCH_ROWS + 1 });
  if (parsed.length < 2) throw new HttpError(400, 'The SCImago batch contains no data rows.', 'SCIMAGO_CSV_EMPTY');
  const { headerIndex, issnNames, metrics } = validateHeaders(job.csv_header);
  const rows = parsed.slice(1);
  if (rows.length > MAX_IMPORT_BATCH_ROWS) throw new HttpError(413, `Each batch may contain at most ${MAX_IMPORT_BATCH_ROWS} rows.`, 'SCIMAGO_BATCH_TOO_MANY_ROWS');

  const timestamp = new Date().toISOString();
  const titleNames = ['title', 'journaltitle', 'sourcetitle', 'name'];
  const yearNames = ['year', 'rankingyear'];
  const entries = new Map();
  let invalidRows = 0;
  for (const cells of rows) {
    const foundIssns = issnNames.map(name => csvCell(cells, headerIndex, [name])).filter(Boolean)
      .flatMap(value => value.split(/[,;|/]/)).map(normalizeIssn).filter(value => value.length === 8);
    if (!foundIssns.length) { invalidRows += 1; continue; }
    const journalId = `scimago_${foundIssns[0]}`;
    const yearValue = parseNumber(csvCell(cells, headerIndex, yearNames));
    const year = yearValue === null ? Number(job.year) : Math.trunc(yearValue);
    if (year < 1990 || year > 2100) { invalidRows += 1; continue; }
    const key = `${journalId}:${year}`;
    const entry = entries.get(key) || { journalId, year, issn: foundIssns[0], title: csvCell(cells, headerIndex, titleNames), values: {} };
    for (const metric of metrics) {
      const raw = csvCell(cells, headerIndex, metric.aliases);
      if (!raw) continue;
      if (metric.kind === 'text') {
        const quartile = raw.toUpperCase().match(/\bQ[1-4]\b/)?.[0];
        if (quartile) entry.values[metric.code] = { value_txt: quartile };
      } else {
        const value = parseNumber(raw);
        if (value !== null && (metric.kind !== 'int' || Number.isInteger(value))) entry.values[metric.code] = metric.kind === 'int' ? { value_int: value } : { value_float: value };
      }
    }
    entries.set(key, entry);
  }

  const metricDocs = metrics.map(metric => {
    const metricId = `scimago_${metric.code.toLowerCase()}`;
    return { id: metricId, data: { id: metricId, metric_id: metricId, code: metric.code, display_name: metric.display, name: metric.display, metric_type: metric.type, description: 'Imported from a SCImago Journal Rank file', updated_at: timestamp } };
  });
  const rankDocs = [];
  for (const entry of entries.values()) for (const [code, values] of Object.entries(entry.values)) {
    const rankId = `scimago_${entry.journalId}_${code.toLowerCase()}_${entry.year}`;
    rankDocs.push({ id: rankId, data: { id: rankId, journal_ranking_id: rankId, journal_id: entry.journalId, issn: entry.issn, metric_id: `scimago_${code.toLowerCase()}`, year: entry.year, ...values, source: 'SCIMAGO', source_title: entry.title || null, updated_at: timestamp } });
  }
  await d1Write(ctx.env.RANKINGS_DB, 'ranking_metrics', metricDocs);
  await d1Write(ctx.env.RANKINGS_DB, 'journal_rankings', rankDocs);
  const summary = {
    id: batchId, batch_id: batchId, import_id: importId, batch_index: batchIndex, status: 'COMPLETED',
    rows: rows.length, imported: entries.size, ranking_values: rankDocs.length, matched_sources_added: 0,
    unmatched: 0, unmatched_issns: [], invalid_rows: invalidRows,
    openalex_lookup_errors: 0, completed_at: timestamp,
  };
  await d1Write(ctx.env.RANKINGS_DB, 'scimago_import_batches', [{ id: batchId, data: summary }]);
  await d1Write(ctx.env.RANKINGS_DB, 'scimago_import_jobs', [{ id: importId, data: { ...job, last_batch_index: Math.max(Number(job.last_batch_index ?? -1), batchIndex), updated_at: timestamp } }]);
  return { success: true, data: summary };
}

async function completeScimagoImport(ctx) {
  if (!ctx.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured.', 'SCIMAGO_D1_NOT_CONFIGURED');
  const importId = String(ctx.params.importId || '');
  const job = await d1Get(ctx.env.RANKINGS_DB, 'scimago_import_jobs', importId);
  if (!job) throw new HttpError(404, 'SCImago import was not found.', 'SCIMAGO_IMPORT_NOT_FOUND');
  if (job.status === 'COMPLETED') return { success: true, data: job.result };
  const totalChunks = Number(ctx.body.total_chunks);
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 1000) throw new HttpError(400, 'The SCImago import has no valid batches.', 'SCIMAGO_BATCH_COUNT_INVALID');
  const batches = await d1Query(ctx.env.RANKINGS_DB, 'scimago_import_batches', { filters: [{ field: 'import_id', op: 'EQUAL', value: importId }], limit: 1000 });
  const ordered = batches.filter(batch => batch.status === 'COMPLETED').sort((a, b) => a.batch_index - b.batch_index);
  if (ordered.length !== totalChunks || ordered.some((batch, index) => batch.batch_index !== index)) throw new HttpError(409, 'Some SCImago batches are missing. Retry the import before completing it.', 'SCIMAGO_BATCHES_INCOMPLETE');
  const totals = ordered.reduce((result, batch) => {
    result.rows += Number(batch.rows || 0);
    result.imported += Number(batch.imported || 0);
    result.rankingValues += Number(batch.ranking_values || 0);
    result.matchedSourcesAdded += Number(batch.matched_sources_added || 0);
    result.unmatched += Number(batch.unmatched || 0);
    result.invalidRows += Number(batch.invalid_rows || 0);
    result.openAlexLookupErrors += Number(batch.openalex_lookup_errors || 0);
    for (const issn of batch.unmatched_issns || []) if (result.unmatchedIssns.length < 100 && !result.unmatchedIssns.includes(issn)) result.unmatchedIssns.push(issn);
    return result;
  }, { rows: 0, imported: 0, rankingValues: 0, matchedSourcesAdded: 0, unmatched: 0, invalidRows: 0, openAlexLookupErrors: 0, unmatchedIssns: [] });
  const result = { fileName: job.file_name, year: job.year, ...totals, metrics: job.metric_codes || [] };
  await d1Write(ctx.env.RANKINGS_DB, 'scimago_import_jobs', [{ id: importId, data: { ...job, status: 'COMPLETED', progress: 100, result, completed_at: new Date().toISOString() } }]);
  return { success: true, data: result };
}

async function deleteScimagoImportYear(ctx) {
  if (!ctx.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured.', 'SCIMAGO_D1_NOT_CONFIGURED');
  const year = Number(ctx.params.year);
  if (!Number.isInteger(year) || year < 1990 || year > 2100) throw new HttpError(400, 'Choose a valid SCImago year.', 'SCIMAGO_YEAR_INVALID');
  const deleted = await d1DeleteScimagoYear(ctx.env.RANKINGS_DB, year);
  return { success: true, data: { year, ...deleted } };
}
async function getScimagoImportSummary(ctx) {
  if (!ctx.env.RANKINGS_DB) throw new HttpError(503, 'SCImago D1 database is not configured.', 'SCIMAGO_D1_NOT_CONFIGURED');
  return { success: true, data: { years: await d1ScimagoImportSummary(ctx.env.RANKINGS_DB) } };
}
export const scimagoImportRoutes = defineRoutes([
  { method: 'GET', path: '/admin/imports/scimago/summary', auth: true, admin: true, handler: getScimagoImportSummary },
  { method: 'DELETE', path: '/admin/imports/scimago/:year', auth: true, admin: true, handler: deleteScimagoImportYear },
  { method: 'POST', path: '/admin/imports/scimago', auth: true, admin: true, handler: startScimagoImport },
  { method: 'POST', path: '/admin/imports/scimago/:importId/chunks', auth: true, admin: true, handler: processScimagoChunk },
  { method: 'POST', path: '/admin/imports/scimago/:importId/complete', auth: true, admin: true, handler: completeScimagoImport },
]);
