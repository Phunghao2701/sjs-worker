import { HttpError } from '../core/http.js';

function database(env) {
  if (!env.RANKINGS_DB) throw new HttpError(503, 'Application D1 database is not configured', 'APPLICATION_D1_NOT_CONFIGURED');
  return env.RANKINGS_DB;
}

export async function appGet(env, collection, id) {
  const row = await database(env).prepare('SELECT data_json FROM app_documents WHERE collection=? AND document_id=?').bind(String(collection), String(id)).first();
  return row?.data_json ? JSON.parse(row.data_json) : null;
}

export async function appSet(env, collection, id, data) {
  const updatedAt = new Date().toISOString();
  const record = { ...data, id: String(data?.id ?? id) };
  await database(env).prepare('INSERT INTO app_documents(collection,document_id,data_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(collection,document_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at')
    .bind(String(collection), String(id), JSON.stringify(record), updatedAt).run();
  return record;
}

export async function appMerge(env, collection, id, patch) {
  return appSet(env, collection, id, { ...(await appGet(env, collection, id) || {}), ...patch });
}

export async function appListAll(env, collection) {
  const result = await database(env).prepare('SELECT data_json FROM app_documents WHERE collection=? ORDER BY document_id').bind(String(collection)).all();
  return (result.results || []).map(row => JSON.parse(row.data_json));
}
