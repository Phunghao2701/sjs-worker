import { HttpError } from '../core/http.js';

export const COLLECTIONS = {
  users: 'users', articles: 'articles', authors: 'authors', publishers: 'publishers', journals: 'journals',
  volumes: 'volumes', issues: 'issues', subjectAreas: 'subject_areas', subjectCategories: 'subject_categories',
  topics: 'topics', keywords: 'keywords', projects: 'projects', projectMembers: 'project_members',
  projectKeywords: 'project_keywords', payments: 'payments', wallets: 'wallets', walletTransactions: 'wallet_transactions',
  coinPackages: 'coin_packages', logs: 'logs', institutions: 'institutions', chatMessages: 'chat_messages',
  analyticsJobs: 'analytics_jobs', graphNodes: 'graph_nodes', graphEdges: 'graph_edges',
};

export const nowIso = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export const collectionFor = (name) => COLLECTIONS[name] || name;

export async function all(db, name, maxDocuments = Infinity) {
  return db.listAll(collectionFor(name), { maxDocuments });
}

export async function byId(db, name, key) {
  const collection = collectionFor(name);
  const direct = await db.get(collection, String(key));
  if (direct) return direct;
  const rows = await all(db, collection);
  return rows.find(row => [row.id, row.user_id, row.article_id, row.project_id, row.journal_id, row.author_id, row.keyword_id].some(value => String(value) === String(key))) || null;
}

export async function find(db, name, predicate = () => true, { limit = Infinity, sort, descending = false } = {}) {
  const rows = (await all(db, name)).filter(predicate);
  if (sort) rows.sort((a, b) => compare(a?.[sort], b?.[sort]) * (descending ? -1 : 1));
  return rows.slice(0, limit);
}

const compare = (a, b) => a == null && b == null ? 0 : a == null ? -1 : b == null ? 1 : typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
export const field = (row, ...names) => names.map(name => row?.[name]).find(value => value !== undefined && value !== null);
export const isDeleted = (row) => ['DELETED', 'deleted'].includes(String(row?.status || '')) || Boolean(row?.deleted_at) || row?.is_deleted === true;
export const paginate = (rows, query = {}, defaultLimit = 20, maxLimit = 100) => {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || defaultLimit));
  return { page, limit, total: rows.length, totalPages: Math.ceil(rows.length / limit), items: rows.slice((page - 1) * limit, page * limit) };
};
export const requireFound = (row, message = 'Resource not found') => { if (!row) throw new HttpError(404, message, 'NOT_FOUND'); return row; };

export async function save(db, name, key, patch, { create = false } = {}) {
  const collection = collectionFor(name);
  const prior = await db.get(collection, key);
  const value = { ...(prior || {}), ...patch, id: String(key), created_at: prior?.created_at || patch.created_at || nowIso(), updated_at: nowIso() };
  if (create && prior) throw new HttpError(409, 'Resource already exists', 'ALREADY_EXISTS');
  await db.set(collection, key, value);
  return value;
}

export async function deleteSoft(db, name, key, extra = {}) {
  const row = requireFound(await byId(db, name, key));
  const value = { ...row, ...extra, status: 'DELETED', deleted_at: nowIso(), updated_at: nowIso() };
  await db.set(collectionFor(name), row.id || String(key), value);
  return value;
}

export function matchText(row, q, fields = []) {
  const needle = String(q || '').trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = fields.map(name => row?.[name]).filter(value => value != null).join(' ').toLocaleLowerCase();
  return haystack.includes(needle);
}

export async function hydrateArticles(db, articles) {
  if (!articles.length) return [];
  const articleIds = new Set(articles.map(row => String(row.article_id || row.id)));
  const [keywordLinks, authorLinks, topicLinks, keywords, authors, journals, publishers, issues, volumes, topics] = await Promise.all([
    all(db, 'keyword_articles'), all(db, 'author_articles'), all(db, 'sub_topics'), all(db, 'keywords'), all(db, 'authors'), all(db, 'journals'), all(db, 'publishers'), all(db, 'issues'), all(db, 'volumes'), all(db, 'topics'),
  ]);
  const keywordById = new Map(keywords.map(row => [String(row.keyword_id || row.id), row]));
  const authorById = new Map(authors.map(row => [String(row.author_id || row.id), row]));
  const journalById = new Map(journals.map(row => [String(row.journal_id || row.id), row]));
  const publisherById = new Map(publishers.map(row => [String(row.publisher_id || row.id), row]));
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
  const keywordMap = new Map(); const authorMap = new Map(); const topicMap = new Map();
  const keywordIdsByArticle = new Map(); const authorIdsByArticle = new Map(); const topicIdsByArticle = new Map();
  const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
  for (const link of keywordLinks) if (articleIds.has(String(link.article_id))) { const key = String(link.article_id); const item = keywordById.get(String(link.keyword_id)); push(keywordMap, key, item?.name || item?.keyword || item?.display_name || String(link.keyword_id)); push(keywordIdsByArticle, key, String(link.keyword_id)); }
  for (const link of authorLinks) if (articleIds.has(String(link.article_id))) { const key = String(link.article_id); const item = authorById.get(String(link.author_id)); push(authorMap, key, item?.display_name || item?.full_name || [item?.first_name, item?.last_name].filter(Boolean).join(' ') || String(link.author_id)); push(authorIdsByArticle, key, String(link.author_id)); }
  for (const link of topicLinks) if (articleIds.has(String(link.article_id))) { const key = String(link.article_id); const item = topicById.get(String(link.topic_id)); push(topicMap, key, item?.display_name || item?.name || String(link.topic_id)); push(topicIdsByArticle, key, String(link.topic_id)); }
  return articles.map(row => {
    const key = String(row.article_id || row.id);
    const issue = issueById.get(String(row.issue_id));
    const volume = volumeById.get(String(issue?.volume_id));
    const journalId = row.journal_id || issue?.journal_id || volume?.journal_id;
    const topic = topicById.get(String(row.primary_topic || row.topic_id));
    const hydratedKeywords = row.keywords?.length ? row.keywords : keywordMap.get(key) || [];
    const hydratedAuthors = row.author_names?.length ? row.author_names : authorMap.get(key) || [];
    const hydratedTopics = topicMap.get(key) || [];
    const authorIds = authorIdsByArticle.get(key) || [];
    const keywordIds = keywordIdsByArticle.get(key) || [];
    const topicIds = topicIdsByArticle.get(key) || [];
    const journal = journalById.get(String(journalId));
    const publisher = publisherById.get(String(journal?.publisher_id));
    const authorsForArticle = row.authors?.length ? row.authors : authorIds.map(authorId => {
      const author = authorById.get(String(authorId));
      return author ? { author_id: String(author.author_id || author.id), display_name: author.display_name || author.full_name || [author.first_name, author.last_name].filter(Boolean).join(' ') } : null;
    }).filter(Boolean);
    const keywordObjects = keywordIds.map(keywordId => {
      const keyword = keywordById.get(String(keywordId));
      const link = keywordLinks.find(item => String(item.article_id) === key && String(item.keyword_id) === String(keywordId));
      return keyword ? { keyword_id: String(keyword.keyword_id || keyword.id), display_name: keyword.display_name || keyword.name || keyword.keyword, score: link?.score ?? 0 } : null;
    }).filter(Boolean);
    const primaryTopicId = row.primary_topic || row.topic_id;
    const topicsForArticle = row.topics?.length ? row.topics : [...new Set([...topicIds, ...(primaryTopicId ? [String(primaryTopicId)] : [])])].map(topicId => {
      const item = topicById.get(String(topicId));
      return item ? { topic_id: String(item.topic_id || item.id), display_name: item.display_name || item.name, is_primary: String(item.topic_id || item.id) === String(primaryTopicId) } : null;
    }).filter(Boolean);
    return {
      ...row,
      volume_id: row.volume_id || issue?.volume_id || volume?.volume_id,
      issue_number: row.issue_number || issue?.issue_number,
      volume_number: row.volume_number || volume?.volume_number,
      keywords: hydratedKeywords,
      keyword_names: hydratedKeywords.join(', '),
      keyword_ids: row.keyword_ids || keywordIds,
      keyword_objects: row.keyword_objects || keywordObjects,
      author_ids: row.author_ids || authorIds,
      authors: authorsForArticle,
      author_names: hydratedAuthors,
      author_name: hydratedAuthors.join(', ') || row.author_name,
      journal_id: journalId,
      journal_name: row.journal_name || journal?.display_name || journal?.title || journal?.name,
      journal_display_name: row.journal_display_name || journal?.display_name,
      journal_source_id: row.journal_source_id || journal?.source_id,
      journal_country: row.journal_country || journal?.country,
      journal_region: row.journal_region || journal?.region,
      journal_issn: row.journal_issn || journal?.issn,
      journal_type: row.journal_type || journal?.type,
      journal_coverage: row.journal_coverage || journal?.coverage,
      journal_is_deleted: row.journal_is_deleted ?? journal?.is_deleted,
      publisher_id: row.publisher_id || journal?.publisher_id,
      publisher_name: row.publisher_name || publisher?.display_name || publisher?.name,
      is_open_access: row.is_open_access ?? journal?.is_open_access ?? false,
      journal_is_open_access: row.journal_is_open_access ?? journal?.is_open_access ?? false,
      is_oa_diamond: row.is_oa_diamond ?? journal?.is_oa_diamond ?? null,
      country_id: row.country_id || journal?.country,
      region_id: row.region_id || journal?.region,
      topic_name: row.topic_name || topic?.display_name || topic?.name || hydratedTopics.join(', '),
      topics: topicsForArticle,
      topic_ids: row.topic_ids || topicIds,
      cited_by_count: row.cited_by_count ?? row.citation_count ?? 0,
      source_url: row.source_url || (row.doi ? String(row.doi).startsWith('http') ? row.doi : `https://doi.org/${row.doi}` : null),
    };
  });
}
