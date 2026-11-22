import { openAlexRequest } from './client.js';

const WORK_SELECT = [
  'id', 'doi', 'display_name', 'publication_year', 'publication_date', 'type', 'authorships',
  'primary_location', 'locations', 'referenced_works', 'referenced_works_count', 'cited_by_count',
  'primary_topic', 'topics', 'keywords', 'open_access', 'biblio', 'created_date', 'updated_date',
  'ids', 'abstract_inverted_index', 'language',
].join(',');

const cleanId = value => String(value || '').trim().replace(/^https?:\/\/openalex\.org\//i, '').toUpperCase();
const sourceNumericId = value => {
  const match = String(value || '').match(/(?:^|\/)S(\d+)$/i);
  return match ? Number(match[1]) : null;
};
export const normalizeOpenAlexKeywordId = value => {
  const raw = String(value || '').trim().replace(/^https?:\/\/openalex\.org\//i, '').replace(/\/+$/, '').split('/').pop().trim();
  if (/^TEXT_/i.test(raw)) {
    let term = raw.slice(5);
    try { term = decodeURIComponent(term); } catch { /* Keep malformed legacy encodings as text. */ }
    return `TEXT_${term.normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 80)}`;
  }
  if (/^\d+$/.test(raw)) return `K${raw}`;
  if (/^K\d+$/i.test(raw)) return raw.toUpperCase();
  return raw ? `TEXT_${raw.normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 80)}` : '';
};
const keywordTextForSyncId = (value, fallback) => {
  if (fallback && typeof fallback === 'string') return fallback;
  const normalized = normalizeOpenAlexKeywordId(value);
  if (normalized.startsWith('TEXT_')) {
    return normalized.slice(5).replace(/_/g, ' ');
  }
  return '';
};
const stateId = (projectId, keywordId) => `${projectId}_${keywordId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
const dateOnly = value => new Date(value).toISOString().slice(0, 10);

export async function enqueueProjectKeywordSyncs(env, db, projectId, keywordIds) {
  const queue = env.OPENALEX_SYNC_QUEUE || env.ANALYTICS_QUEUE;
  const rawList = Array.isArray(keywordIds) ? keywordIds : [];
  const keywordMap = new Map();
  for (const item of rawList) {
    const rawText = typeof item === 'string' ? item : item?.keyword || item?.label || item?.name || '';
    const keyId = normalizeOpenAlexKeywordId(item?.keyword_id || item?.id || rawText);
    if (keyId && !keywordMap.has(keyId)) {
      keywordMap.set(keyId, rawText || keywordTextForSyncId(keyId));
    }
  }
  const keywordKeys = [...keywordMap.keys()];
  if (!queue) {
    for (const keywordId of keywordKeys) {
      const key = stateId(projectId, keywordId);
      const previous = await db.get('openalex_project_sync', key);
      await db.set('openalex_project_sync', key, {
        ...(previous || {}), project_id: String(projectId), keyword_id: keywordId,
        ...(keywordMap.get(keywordId) ? { keyword_term: keywordMap.get(keywordId) } : {}),
        status: 'ERROR', error: 'OpenAlex sync queue is not configured', failed_at: new Date().toISOString(),
      });
    }
    return { queued: 0, unavailable: true };
  }
  let queued = 0;
  for (const keywordId of keywordKeys) {
    const key = stateId(projectId, keywordId);
    const keywordTerm = keywordMap.get(keywordId);
    const previous = await db.get('openalex_project_sync', key);
    if (previous?.status === 'PENDING' || previous?.status === 'PROCESSING') continue;
    const mode = previous?.initial_sync_complete ? 'incremental' : 'initial';
    const throughDate = dateOnly(new Date());
    const job = {
      project_id: String(projectId), keyword_id: keywordId,
      ...(keywordTerm ? { keyword_term: keywordTerm } : {}),
      mode, cursor: '*', through_date: throughDate,
      ...(mode === 'incremental' ? { from_date: previous.last_synced_date || throughDate } : {}),
    };
    await db.set('openalex_project_sync', key, {
      ...(previous || {}), project_id: String(projectId), keyword_id: keywordId,
      ...(keywordTerm ? { keyword_term: keywordTerm } : {}),
      status: 'PENDING', mode, progress: 0, error: null, error_code: null, retryable: true, queued_at: new Date().toISOString(),
    });
    try {
      await queue.send({ type: 'openalex-project-sync', ...job });
      queued += 1;
    } catch (error) {
      await db.merge('openalex_project_sync', key, { status: 'ERROR', error: error.message || 'Could not enqueue OpenAlex sync', error_code: 'OPENALEX_QUEUE_SEND_FAILED', retryable: true });
    }
  }
  return { queued, unavailable: false };
}

export async function enqueueScheduledOpenAlexSyncs(env, db) {
  const queue = env.OPENALEX_SYNC_QUEUE || env.ANALYTICS_QUEUE;
  if (!queue) return 0;
  const links = await db.listAll('project_keywords');
  const queuedKeys = new Set();
  let queued = 0;
  for (const link of links) {
    const projectId = String(link.project_id || '');
    const keywordId = normalizeOpenAlexKeywordId(link.keyword_id || link.keyword);
    if (!projectId || !keywordId) continue;
    const keywordTerm = keywordTextForSyncId(keywordId);
    const key = stateId(projectId, keywordId);
    if (queuedKeys.has(key)) continue;
    queuedKeys.add(key);
    const state = await db.get('openalex_project_sync', key);
    if (state?.status === 'PENDING' || state?.status === 'PROCESSING' || state?.error_code === 'OPENALEX_SYNC_PLAN_REQUIRED') continue;
    const throughDate = dateOnly(new Date());
    const mode = state?.initial_sync_complete ? 'incremental' : 'initial';
    const fromDate = state?.last_synced_date || throughDate;
    await db.set('openalex_project_sync', key, {
      ...(state || {}), project_id: projectId, keyword_id: keywordId, ...(keywordTerm ? { keyword_term: keywordTerm } : {}),
      status: 'PENDING', mode, progress: 0, error: null, error_code: null, retryable: true, queued_at: new Date().toISOString(),
    });
    try {
      await queue.send({
        type: 'openalex-project-sync', project_id: projectId, keyword_id: keywordId, ...(keywordTerm ? { keyword_term: keywordTerm } : {}), mode,
        cursor: '*', from_date: fromDate, through_date: throughDate,
      });
      queued += 1;
    } catch (error) {
      await db.merge('openalex_project_sync', key, { status: 'ERROR', error: error.message || 'Could not enqueue OpenAlex sync', error_code: 'OPENALEX_QUEUE_SEND_FAILED', retryable: true });
    }
  }
  return queued;
}

export async function processOpenAlexProjectSync(db, env, message, queue) {
  const projectId = String(message.project_id || '');
  const keywordId = normalizeOpenAlexKeywordId(message.keyword_id);
  if (!projectId || !keywordId) throw new Error('OpenAlex project sync is missing project_id or keyword_id');
  const key = stateId(projectId, keywordId);
  const state = await db.get('openalex_project_sync', key) || { project_id: projectId, keyword_id: keywordId };
  const mode = message.mode === 'incremental' ? 'incremental' : 'initial';
  const throughDate = message.through_date || dateOnly(new Date());
  const fromDate = message.from_date || state.last_synced_date || throughDate;
  const keywordTerm = String(message.keyword_term || keywordTextForSyncId(keywordId)).trim();
  const filters = [
    ...(!keywordTerm ? [`keywords.id:${keywordId}`] : []),
    ...(mode === 'incremental' ? [`from_updated_date:${fromDate}`, `to_updated_date:${throughDate}`] : []),
  ];
  const query = {
    ...(filters.length ? { filter: filters.join(',') } : {}),
    ...(keywordTerm ? { search: keywordTerm } : {}),
  };

  await db.set('openalex_project_sync', key, {
    ...state, project_id: projectId, keyword_id: keywordId, ...(keywordTerm ? { keyword_term: keywordTerm } : {}), status: 'PROCESSING', mode,
    progress: Number(state.progress || 0), error: null, started_at: state.started_at || new Date().toISOString(),
  });
  try {
    const page = await openAlexRequest({ db, env }, 'works', {
      ...query, cursor: message.cursor || '*', per_page: 100, select: WORK_SELECT, corpus: 'all',
    }, { skipCache: true });
    const works = Array.isArray(page.results) ? page.results : [];
    const relationWrites = works.map(work => {
      const workId = cleanId(work.id);
      const source = work.primary_location?.source || work.locations?.find(location => location.is_primary)?.source || null;
      return workId ? {
        id: `${projectId}_${keywordId}_${workId}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
        data: {
          project_id: projectId, keyword_id: keywordId, ...(keywordTerm ? { keyword_term: keywordTerm } : {}), work_id: workId,
          publication_year: work.publication_year ?? null, cited_by_count: work.cited_by_count ?? null,
          updated_date: work.updated_date || null, synced_at: new Date().toISOString(),
          journal_id: sourceNumericId(source?.id), journal_source_id: source?.id || null,
          journal_name: source?.display_name || null, journal_issn: source?.issn_l || source?.issn?.[0] || null,
          primary_topic: work.primary_topic?.id || null,
        },
      } : null;
    }).filter(Boolean);
    if (relationWrites.length) await db.batchSet('openalex_project_works', relationWrites);

    const nextCursor = page.meta?.next_cursor;
    const syncedCount = Number(state.synced_work_count || 0) + works.length;
    if (nextCursor && works.length) {
      await db.set('openalex_project_sync', key, {
        ...state, project_id: projectId, keyword_id: keywordId, ...(keywordTerm ? { keyword_term: keywordTerm } : {}), status: 'PENDING', mode,
        progress: null, synced_work_count: syncedCount, last_page_at: new Date().toISOString(),
        through_date: throughDate, updated_at: new Date().toISOString(),
      });
      await queue.send({ ...message, type: 'openalex-project-sync', cursor: nextCursor });
      return;
    }

    const completedAt = new Date().toISOString();
    await db.set('openalex_project_sync', key, {
      ...state, project_id: projectId, keyword_id: keywordId, ...(keywordTerm ? { keyword_term: keywordTerm } : {}), status: 'COMPLETED', mode,
      progress: 100, synced_work_count: syncedCount, initial_sync_complete: true,
      last_synced_at: completedAt, last_synced_date: throughDate, through_date: throughDate,
      error: null, completed_at: completedAt, updated_at: completedAt,
    });
  } catch (error) {
    const planRequired = error?.details?.upstream_status === 403 || /OpenAlex request failed \(403\)/.test(error?.message || '');
    await db.set('openalex_project_sync', key, {
      ...state, project_id: projectId, keyword_id: keywordId, ...(keywordTerm ? { keyword_term: keywordTerm } : {}), status: 'ERROR', mode,
      error: error.message || 'OpenAlex sync failed', failed_at: new Date().toISOString(),
      ...(planRequired ? { error_code: 'OPENALEX_SYNC_PLAN_REQUIRED', retryable: false } : { error_code: 'OPENALEX_SYNC_FAILED', retryable: true }),
    });
    if (planRequired) return;
    throw error;
  }
}

export async function projectOpenAlexSyncStatus(db, projectId, keywordIds) {
  const states = await Promise.all(keywordIds.map(keywordId => db.get('openalex_project_sync', stateId(projectId, normalizeOpenAlexKeywordId(keywordId)))));
  const rows = states.filter(Boolean);
  return {
    status: rows.some(row => row.status === 'ERROR') ? 'ERROR'
      : rows.some(row => row.status === 'PENDING' || row.status === 'PROCESSING') ? 'PROCESSING'
        : rows.length === new Set(keywordIds.map(normalizeOpenAlexKeywordId)).size && rows.length && rows.every(row => row.initial_sync_complete) ? 'COMPLETED'
          : rows.length < new Set(keywordIds.map(normalizeOpenAlexKeywordId)).size ? 'NOT_STARTED' : 'PENDING',
    keywords: rows,
  };
}
