const PROJECT_LINK_COLLECTIONS = new Set([
  'project_journals',
  'project_keywords',
  'subject_category_projects',
  'project_article_scopes',
]);
const CACHE_TTL_MS = 60_000;
const cache = new Map();

function cacheKey(db, collection, projectId) {
  const namespace = `${db.projectId || ''}/${db.databaseId || ''}`;
  return `${namespace}/${collection}/${String(projectId)}`;
}

export function invalidateProjectLinkCache(collection, projectId) {
  if (!PROJECT_LINK_COLLECTIONS.has(collection)) return;
  const collectionSuffix = `/${collection}/`;
  const projectSuffix = projectId == null ? null : `${collectionSuffix}${String(projectId)}`;
  for (const key of cache.keys()) {
    if (projectSuffix ? key.endsWith(projectSuffix) : key.includes(collectionSuffix)) cache.delete(key);
  }
}

export async function projectRows(db, collection, projectId) {
  const key = cacheKey(db, collection, projectId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const rows = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const page = await db.query(collection, {
        filters: [{ field: 'project_id', op: 'EQUAL', value: String(projectId) }],
        limit: pageSize,
        offset,
      });
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  })();

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  try {
    return await promise;
  } catch (error) {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  }
}
