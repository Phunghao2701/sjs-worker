import { HttpError } from '../core/http.js';
const COLLECTIONS = new Set(['ranking_metrics','journal_rankings','scimago_import_jobs','scimago_import_batches']);
const unpack = row => row ? JSON.parse(row.data_json) : null;
export const isScimagoCollection = name => COLLECTIONS.has(name);
export async function d1Get(db,c,id){return unpack(await db.prepare('SELECT data_json FROM scimago_documents WHERE collection=? AND document_id=?').bind(c,String(id)).first());}
export async function d1ListAll(db,c,max=Infinity){let sql='SELECT data_json FROM scimago_documents WHERE collection=? ORDER BY document_id',args=[c];if(Number.isFinite(max)){sql+=' LIMIT ?';args.push(Math.max(0,Math.trunc(max)));}const r=await db.prepare(sql).bind(...args).all();return(r.results||[]).map(unpack);}
export async function d1Query(db, c, { filters = [], orderBy = [], limit = 100, offset } = {}) {
  const indexedFields = new Set(['journal_id', 'metric_id', 'year']);
  const where = ['collection=?'];
  const values = [c];
  for (const filter of filters) {
    const field = String(filter.field || '');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) continue;
    const column = indexedFields.has(field) ? field : null;
    const expression = column || 'json_extract(data_json, ?)';
    if (filter.op === 'IN' && Array.isArray(filter.value) && filter.value.length) {
      where.push(`${expression} IN (${filter.value.map(() => '?').join(',')})`);
      if (!column) values.push(`$.${field}`);
      values.push(...filter.value);
    } else if (filter.op === 'EQUAL') {
      where.push(`${expression} = ?`);
      if (!column) values.push(`$.${field}`);
      values.push(filter.value);
    }
  }
  const validOrder = orderBy.filter(item => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(item.field || '')));
  const orderSql = validOrder.map(item => {
    const field = String(item.field);
    const expression = indexedFields.has(field) ? field : 'json_extract(data_json, ?)';
    if (!indexedFields.has(field)) values.push(`$.${field}`);
    return `${expression} ${String(item.direction).toUpperCase() === 'DESCENDING' ? 'DESC' : 'ASC'}`;
  });
  const sql = `SELECT data_json FROM scimago_documents WHERE ${where.join(' AND ')}${orderSql.length ? ` ORDER BY ${orderSql.join(', ')}` : ''} LIMIT ? OFFSET ?`;
  values.push(Math.min(1000, Math.max(1, Number(limit) || 100)), Math.max(0, Number(offset) || 0));
  const result = await db.prepare(sql).bind(...values).all();
  return (result.results || []).map(unpack);
}
export async function d1Write(db, collection, documents) {
  const statements = documents.map(({ id, data }) => db.prepare(
    'INSERT INTO scimago_documents(collection,document_id,journal_id,metric_id,year,data_json) VALUES(?,?,?,?,?,?) ON CONFLICT(collection,document_id) DO UPDATE SET journal_id=excluded.journal_id,metric_id=excluded.metric_id,year=excluded.year,data_json=excluded.data_json',
  ).bind(
    collection,
    String(id),
    data.journal_id == null ? null : String(data.journal_id),
    data.metric_id == null ? null : String(data.metric_id),
    Number.isFinite(Number(data.year)) ? Number(data.year) : null,
    JSON.stringify({ ...data, id: String(data.id || id) }),
  ));
  try {
    for (let start = 0; start < statements.length; start += 100) await db.batch(statements.slice(start, start + 100));
  } catch (error) {
    if (/daily row write limit|free tier.*row write limit/i.test(String(error?.message || error))) {
      throw new HttpError(507, 'Cloudflare D1 daily write limit has been reached. Wait for the quota reset or upgrade the D1 plan, then start a new import.', 'SCIMAGO_D1_DAILY_WRITE_LIMIT');
    }
    throw error;
  }
}export async function d1Delete(db,c,ids){const s=ids.map(id=>db.prepare('DELETE FROM scimago_documents WHERE collection=? AND document_id=?').bind(c,String(id)));for(let i=0;i<s.length;i+=100)await db.batch(s.slice(i,i+100));}

export async function d1ScimagoImportSummary(db) {
  const [rankingResult, jobResult, batchResult] = await Promise.all([
    db.prepare("SELECT year,COUNT(*) AS ranking_values,COUNT(DISTINCT journal_id) AS journals,COUNT(DISTINCT metric_id) AS metrics FROM scimago_documents WHERE collection='journal_rankings' GROUP BY year ORDER BY year DESC").all(),
    db.prepare("SELECT document_id,json_extract(data_json,'$.year') AS year,json_extract(data_json,'$.status') AS status FROM scimago_documents WHERE collection='scimago_import_jobs'").all(),
    db.prepare("SELECT json_extract(data_json,'$.import_id') AS import_id,COUNT(*) AS batches,SUM(CASE WHEN json_extract(data_json,'$.status')='COMPLETED' THEN 1 ELSE 0 END) AS completed_batches,SUM(CASE WHEN json_extract(data_json,'$.status')='COMPLETED' THEN COALESCE(CAST(json_extract(data_json,'$.rows') AS INTEGER),0) ELSE 0 END) AS imported_rows FROM scimago_documents WHERE collection='scimago_import_batches' GROUP BY json_extract(data_json,'$.import_id')").all(),
  ]);
  const byImport = new Map((batchResult.results || []).map(row => [String(row.import_id || ''), row]));
  const byYear = new Map();
  const getYear = value => {
    const year = Number(value);
    if (!Number.isInteger(year)) return null;
    if (!byYear.has(year)) byYear.set(year, { year, ranking_values: 0, journals: 0, metrics: 0, imported_rows: 0, batches: 0, completed_batches: 0, jobs: 0, statuses: [] });
    return byYear.get(year);
  };
  for (const row of rankingResult.results || []) {
    const summary = getYear(row.year);
    if (summary) Object.assign(summary, { ranking_values: Number(row.ranking_values || 0), journals: Number(row.journals || 0), metrics: Number(row.metrics || 0) });
  }
  for (const job of jobResult.results || []) {
    const summary = getYear(job.year);
    if (!summary) continue;
    summary.jobs += 1;
    if (job.status) summary.statuses.push(String(job.status).toUpperCase());
    const batches = byImport.get(String(job.document_id || ''));
    if (batches) {
      summary.batches += Number(batches.batches || 0);
      summary.completed_batches += Number(batches.completed_batches || 0);
      summary.imported_rows += Number(batches.imported_rows || 0);
    }
  }
  return [...byYear.values()].sort((a, b) => b.year - a.year).map(({ statuses, ...summary }) => ({
    ...summary,
    status: !summary.jobs ? 'DATA_AVAILABLE' : statuses.every(value => value === 'COMPLETED') ? 'COMPLETED' : statuses.includes('PROCESSING') ? 'PROCESSING' : statuses.includes('CANCELLED') ? 'CANCELLED' : 'INCOMPLETE',
  }));
}
export async function d1DeleteScimagoYear(db, year) {
  const results = await db.batch([
    db.prepare("DELETE FROM scimago_documents WHERE collection='journal_rankings' AND year=?").bind(year),
    db.prepare("DELETE FROM scimago_documents WHERE collection='scimago_import_batches' AND json_extract(data_json,'$.import_id') IN (SELECT document_id FROM scimago_documents WHERE collection='scimago_import_jobs' AND CAST(json_extract(data_json,'$.year') AS INTEGER)=?)").bind(year),
    db.prepare("DELETE FROM scimago_documents WHERE collection='scimago_import_jobs' AND CAST(json_extract(data_json,'$.year') AS INTEGER)=?").bind(year),
  ]);
  return {
    ranking_values_deleted: Number(results[0]?.meta?.changes || 0),
    batches_deleted: Number(results[1]?.meta?.changes || 0),
    jobs_deleted: Number(results[2]?.meta?.changes || 0),
  };
}