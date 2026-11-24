import { HttpError } from '../core/http.js';
import { COLLECTIONS, all, byId, collectionFor, deleteSoft, field, find, hydrateArticles, id, isDeleted, matchText, nowIso, paginate, requireFound, save } from '../firestore/repository.js';
import { defineRoutes, ok } from '../core/router.js';
import { authenticate } from '../core/session.js';
import { getOpenAlexEntity, listOpenAlexEntity, openAlexWorkToLegacy } from '../openalex/adapters.js';
import { openAlexRequest } from '../openalex/client.js';
import { loadProjectResearchScopes, openAlexPublicationTrends } from '../openalex/project-dashboard.js';

const entities = [
  { paths: ['/articles'], name: 'articles', text: ['title', 'abstract', 'description', 'keywords', 'doi'], writes: true },
  { paths: ['/publishers'], name: 'publishers', text: ['name', 'display_name', 'publisher_name'] },
  { paths: ['/author', '/authors'], name: 'authors', text: ['name', 'full_name', 'display_name', 'first_name', 'last_name', 'email'] },
  { paths: ['/journal', '/journals'], name: 'journals', text: ['title', 'name', 'display_name', 'journal_name', 'issn', 'eissn'] },
  { paths: ['/keywords'], name: 'keywords', text: ['name', 'keyword', 'label'] },
  { paths: ['/subject-areas'], name: 'subjectAreas', text: ['name', 'title', 'code'] },
  { paths: ['/subject-categories'], name: 'subjectCategories', text: ['name', 'title', 'code'] },
  { paths: ['/topics'], name: 'topics', text: ['name', 'title', 'description'] },
  { paths: ['/volumes'], name: 'volumes', text: ['title', 'volume_number', 'journal_name'] },
  { paths: ['/issues'], name: 'issues', text: ['title', 'issue_number', 'journal_name'] },
];
const writableEntities = new Set(['authors', 'publishers', 'journals', 'keywords', 'subjectAreas', 'subjectCategories', 'topics', 'volumes', 'issues']);

const normalized = value => String(value ?? '').toLowerCase();
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const matchesQuery = (row, q, textFields) => matchText(row, q, textFields);
const applyFilters = (rows, query, textFields) => {
  let result = rows.filter(row => !isDeleted(row));
  const q = query.q || query.search || query.keyword;
  if (q) result = result.filter(row => matchesQuery(row, q, textFields));
  for (const [param, fields] of Object.entries({
    year: ['year', 'publication_year'], from_year: ['year', 'publication_year'], to_year: ['year', 'publication_year'],
    journal_id: ['journal_id'], publisher_id: ['publisher_id'], author_id: ['author_id'], topic_id: ['topic_id'],
    subject_area_id: ['subject_area_id', 'subject_area'], subject_area: ['subject_area_id', 'subject_area'], subject_category_id: ['subject_category_id'], country: ['country', 'country_code'], status: ['status'],
    quartile: ['quartile', 'ranking_quartile'], type: ['type', 'article_type'],
  })) {
    if (query[param] === undefined || query[param] === '') continue;
    const expected = Number.isNaN(Number(query[param])) ? normalized(query[param]) : Number(query[param]);
    result = result.filter(row => fields.some(name => {
      const actual = row[name];
      if (actual === undefined || actual === null) return false;
      if (Array.isArray(actual)) return actual.some(value => normalized(value) === normalized(expected));
      const actualValue = Number.isNaN(Number(actual)) ? normalized(actual) : Number(actual);
      if (param === 'from_year') return actualValue >= expected;
      if (param === 'to_year') return actualValue <= expected;
      return actualValue === expected;
    }));
  }
  const sort = query.sort || query.sort_by || query.sortBy;
  if (sort) {
    const sortKey = ({ year_desc: 'publication_year', citations_desc: 'citation_count', name_asc: 'name' })[sort] || sort;
    const descending = String(query.sort_order || query.sortOrder || sort).toLowerCase().endsWith('desc');
    result.sort((a, b) => compare(field(a, sortKey, 'publication_year', 'year'), field(b, sortKey, 'publication_year', 'year')) * (descending ? -1 : 1));
  }
  return result;
};
const compare = (a, b) => Number(a ?? 0) - Number(b ?? 0) || String(a ?? '').localeCompare(String(b ?? ''));

async function listEntity(ctx, entity) {
  const openAlexKinds = new Set(['articles', 'authors', 'publishers', 'journals', 'keywords', 'subjectAreas', 'subjectCategories', 'topics']);
  let openAlexRows;
  if (openAlexKinds.has(entity.name)) {
    openAlexRows = entity.name === 'articles'
      ? await listOpenAlexIssueArticles(ctx) || await listOpenAlexEntity(ctx, entity.name)
      : await listOpenAlexEntity(ctx, entity.name);
    if (!openAlexRows) throw new HttpError(502, `OpenAlex did not return ${entity.name}`, 'OPENALEX_RESPONSE_EMPTY');
  }
  if (openAlexRows) {
    if (entity.name !== 'journals') return openAlexRows;
    const sourceItems = openAlexRows.data?.items || [];
    if (!sourceItems.length) return openAlexRows;
    const enriched = await journalList({ ...ctx, query: { ...ctx.query, page: 1, limit: Math.max(1, sourceItems.length) } }, sourceItems);
    return { ...openAlexRows, data: { ...openAlexRows.data, items: enriched.data.items, pagination: openAlexRows.data.pagination } };
  }
  if (entity.name === 'volumes') return catalogVolumes(ctx);
  if (entity.name === 'issues') return catalogIssues(ctx);
  let source = await all(ctx.db, entity.name);
  if (entity.name === 'articles') source = await hydrateArticles(ctx.db, source);
  if (entity.name === 'articles') return listArticles(ctx, source);
  if (entity.name === 'authors') return authorList(ctx, source);
  if (entity.name === 'journals') return journalList(ctx, source);
  if (entity.name === 'publishers') return publisherList(ctx, source);
  if (entity.name === 'subjectAreas') return subjectAreaList(ctx, source);
  if (entity.name === 'subjectCategories') return subjectCategoryList(ctx, source);
  if (entity.name === 'topics') return topicList(ctx, source);
  if (entity.name === 'keywords') return keywordList(ctx, source);
  if (['volumes', 'issues'].includes(entity.name)) return listVolumeIssueEntity(ctx, entity.name, source);
  let rows = applyFilters(source, ctx.query, entity.text);
  const page = paginate(rows, ctx.query, entity.name === 'publishers' ? 100 : 10, 100);
  const pagination = { page: page.page, limit: page.limit, total: page.total, ...(entity.name === 'publishers' ? {} : { total_pages: page.totalPages }) };
  if (entity.name === 'authors') return { success: true, code: 'AUTHOR_LIST_FETCHED', message: 'Láº¥y danh sÃ¡ch tÃ¡c giáº£ thÃ nh cÃ´ng', data: page.items, pagination };
  if (entity.name === 'publishers') return { success: true, message: 'Láº¥y danh sÃ¡ch nhÃ  xuáº¥t báº£n thÃ nh cÃ´ng', data: page.items, pagination };
  if (entity.name === 'journals') return { success: true, message: 'Láº¥y danh sÃ¡ch journal thÃ nh cÃ´ng', data: { items: page.items, pagination: { page: page.page, limit: page.limit, total: page.total } } };
  if (entity.name === 'keywords') return { success: true, code: 'KEYWORD_LIST_FETCHED', message: 'Láº¥y danh sÃ¡ch keyword thÃ nh cÃ´ng', data: page.items, pagination };
  if (['subjectAreas', 'subjectCategories'].includes(entity.name)) return { success: true, code: entity.name === 'subjectAreas' ? 'GET_SUBJECT_AREAS_SUCCESS' : 'GET_SUBJECT_CATEGORIES_SUCCESS', message: `Fetch ${entity.name} successfully`, data: { items: page.items, pagination: { page: page.page, limit: page.limit, total: page.total } } };
  if (entity.name === 'topics') return { success: true, code: 'GET_TOPICS_SUCCESS', message: 'Láº¥y danh sÃ¡ch Topic thÃ nh cÃ´ng', data: { items: page.items, pagination: { page: page.page, limit: page.limit, total: page.total } } };
  return ok(page, `Fetch ${entity.name} successfully`);
}

async function listOpenAlexIssueArticles(ctx) {
  const match = String(ctx.query.issue_id || '').match(/^openalex:(S\d+):issue:(.*):([^:]+)$/i);
  if (!match) return null;

  const [, sourceId, encodedVolume, encodedIssue] = match;
  let volume;
  let issueNumber;
  try {
    volume = decodeURIComponent(encodedVolume);
    issueNumber = decodeURIComponent(encodedIssue);
  } catch {
    throw new HttpError(400, 'Invalid OpenAlex issue_id', 'CATALOG_ISSUE_ID_INVALID');
  }

  // Reuse the exact source query/select that generated this volume and issue;
  // the broad article select can fail upstream and silently fall back to Firestore.
  const result = await openAlexSourceWorks(ctx, sourceId.toUpperCase());

  let rows = (result.results || [])
    .filter(work => String(work.biblio?.volume || '').trim() === volume
      && String(work.biblio?.issue || '').trim() === issueNumber)
    .map(openAlexWorkToLegacy);

  const search = String(ctx.query.search || '').trim().toLowerCase();
  if (search) rows = rows.filter(row => `${row.title || ''} ${row.doi || ''}`.toLowerCase().includes(search));
  const year = ctx.query.publication_year ?? ctx.query.year;
  if (year !== undefined && year !== '') rows = rows.filter(row => String(row.publication_year || '') === String(year));

  const page = paginate(rows, ctx.query, 10, 100);
  const items = page.items;
  return {
    success: true,
    code: 'ARTICLES_GET_SUCCESS',
    message: 'Articles fetched from OpenAlex issue',
    data: {
      articles: items,
      items,
      pagination: { page: page.page, limit: page.limit, total: page.total, total_pages: page.totalPages },
      stats: {
        totalArticles: page.total,
        openAccessCount: rows.filter(row => row.is_open_access).length,
        authorsCount: new Set(rows.flatMap(row => row.author_ids || []).filter(Boolean)).size,
        topicsCount: new Set(rows.flatMap(row => row.topic_ids || []).filter(Boolean)).size,
      },
    },
  };
}

async function journalList(ctx, source) {
  const isEnriching = Array.isArray(source);
  if (isEnriching && source.length === 0) {
    return { success: true, message: 'Láº¥y danh sÃ¡ch journal thÃ nh cÃ´ng', data: { items: [], pagination: { page: 1, limit: 10, total: 0 } } };
  }

  let publishers = [];
  let zones = [];
  let categories = [];
  let categoryLinks = [];
  let rankingRows = [];
  let rankingMetrics = [];
  let volumes = [];
  const scimagoIdByIssn = new Map();

  if (isEnriching) {
    // High-performance enrichment: fetch small metadata and targeted rankings for source items only
    rankingMetrics = await all(ctx.db, 'ranking_metrics', 50);
    const targetJournalIds = new Set();
    for (const j of source) {
      const rawId = String(j.journal_id || j.id || '');
      if (rawId) targetJournalIds.add(rawId);
      const issns = [j.issn, ...(Array.isArray(j.issns) ? j.issns : [])].filter(Boolean);
      for (const issn of issns) {
        const matched = scimagoIdByIssn.get(String(issn).trim().toLowerCase());
        if (matched) targetJournalIds.add(matched);
        const clean = String(issn).replace(/[^0-9xX]/g, '').toUpperCase();
        if (clean) targetJournalIds.add(`scimago_${clean}`);
      }
    }

    if (targetJournalIds.size > 0) {
      const journalIds = [...targetJournalIds];
      const rankingQueries = [];
      for (let start = 0; start < journalIds.length; start += 25) {
        rankingQueries.push(ctx.db.query('journal_rankings', {
          filters: [{ field: 'journal_id', op: 'IN', value: journalIds.slice(start, start + 25) }],
          limit: 1000,
        }));
      }
      const rankingResults = await Promise.all(rankingQueries);
      rankingRows = rankingResults.flat();
    }
  } else {
    // Local database fallback: bounded queries to prevent infinite pagination hanging
    const [p, z, c, cl, rr, rm, v] = await Promise.all([
      all(ctx.db, 'publishers', 200),
      all(ctx.db, 'zones', 200),
      all(ctx.db, 'subjectCategories', 200),
      all(ctx.db, 'journal_subject_categories', 500),
      all(ctx.db, 'journal_rankings', 1000),
      all(ctx.db, 'ranking_metrics', 50),
      all(ctx.db, 'volumes', 200),
    ]);
    publishers = p;
    zones = z;
    categories = c;
    categoryLinks = cl;
    rankingRows = rr;
    rankingMetrics = rm;
    volumes = v;
  }

  const publisherById = new Map(publishers.map(row => [String(row.publisher_id || row.id), row]));
  const zoneById = new Map(zones.map(row => [String(row.zone_id || row.id), row]));
  const categoryById = new Map(categories.map(row => [String(row.subject_category_id || row.id), row]));
  const metricById = new Map(rankingMetrics.map(row => [String(row.metric_id || row.ranking_metric_id || row.id), row]));
  const rankingForJournal = new Map();
  for (const row of rankingRows) {
    const journalId = String(row.journal_id || '');
    if (!rankingForJournal.has(journalId)) rankingForJournal.set(journalId, []);
    const metric = metricById.get(String(row.metric_id || row.ranking_metric_id || ''));
    rankingForJournal.get(journalId).push({ row, metric });
  }
  const rankingsFor = journal => {
    const journalId = String(journal.journal_id || journal.id || '');
    const direct = rankingForJournal.get(journalId);
    if (direct?.length) return direct;
    const issns = [journal.issn, journal.eissn, ...(Array.isArray(journal.issns) ? journal.issns : [])].filter(Boolean);
    for (const value of issns) {
      const normalizedIssn = String(value).replace(/[^0-9xX]/g, '').toUpperCase();
      const linkedId = scimagoIdByIssn.get(String(value).trim().toLowerCase());
      for (const candidateId of [linkedId, normalizedIssn ? `scimago_${normalizedIssn}` : null].filter(Boolean)) {
        const linked = rankingForJournal.get(candidateId);
        if (linked?.length) return linked;
      }
    }
    return [];
  };

  const csv = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  const countryIds = csv(ctx.query.countryIds || ctx.query.country_ids || ctx.query.country_id || ctx.query.country_code || ctx.query.country);
  const areaIds = csv(ctx.query.subjectAreaIds || ctx.query.subject_area_ids || ctx.query.subject_area_id);
  const categoryIds = csv(ctx.query.subjectCategoryIds || ctx.query.subject_category_ids || ctx.query.subject_category_id);
  const quartiles = csv(ctx.query.quartiles).map(value => value.toUpperCase());
  const openAccess = ctx.query.isOpenAccess !== undefined ? ctx.query.isOpenAccess : ctx.query.is_open_access;
  const diamond = ctx.query.isOaDiamond !== undefined ? ctx.query.isOaDiamond : ctx.query.is_oa_diamond;
  const publisherId = ctx.query.publisher_id || ctx.query.publisherId;
  const rawRankingYear = ctx.query.rankingYear || ctx.query.ranking_year;
  const rankingYear = rawRankingYear ? Number.parseInt(rawRankingYear, 10) : null;
  const search = String(ctx.query.search || '').trim().toLowerCase();
  const cleanSearch = search.replace(/[^0-9xX]/gi, '').toLowerCase();

  let rows = source.filter(journal => journal.is_deleted === false);
  if (search) {
    rows = rows.filter(journal => {
      const name = String(journal.display_name || '').toLowerCase();
      const issn = String(journal.issn || '').toLowerCase();
      const eissn = String(journal.eissn || '').toLowerCase();
      const cleanIssn = issn.replace(/[^0-9x]/gi, '');
      const cleanEissn = eissn.replace(/[^0-9x]/gi, '');
      const issns = Array.isArray(journal.issns) ? journal.issns.map(i => String(i).toLowerCase()) : [];
      return name.includes(search) ||
        issn.includes(search) ||
        eissn.includes(search) ||
        (cleanSearch.length >= 4 && (cleanIssn.includes(cleanSearch) || cleanEissn.includes(cleanSearch))) ||
        issns.some(i => i.includes(search));
    });
  }
  if (areaIds.length && !isEnriching) rows = rows.filter(journal => categoryLinks.some(link => String(link.journal_id) === String(journal.journal_id || journal.id) && areaIds.includes(String(categoryById.get(String(link.subject_category_id))?.subject_area_id))));
  if (categoryIds.length && !isEnriching) rows = rows.filter(journal => categoryLinks.some(link => String(link.journal_id) === String(journal.journal_id || journal.id) && categoryIds.includes(String(link.subject_category_id))));
  if (String(openAccess) === 'true') rows = rows.filter(journal => journal.is_open_access === true);
  if (String(openAccess) === 'false') rows = rows.filter(journal => journal.is_open_access === false);
  if (diamond === true || String(diamond) === 'true') rows = rows.filter(journal => journal.is_oa_diamond === true);
  if (publisherId) rows = rows.filter(journal => String(journal.publisher_id) === String(publisherId));
  if (countryIds.length && !isEnriching) {
    const normCountryIds = countryIds.map(c => c.toLowerCase());
    rows = rows.filter(journal => {
      const c = String(journal.country || '').toLowerCase();
      const cc = String(journal.country_code || '').toLowerCase();
      const cid = String(journal.country_id || '').toLowerCase();
      const cname = String(journal.country_name || '').toLowerCase();
      return normCountryIds.includes(c) || normCountryIds.includes(cc) || normCountryIds.includes(cid) || normCountryIds.includes(cname);
    });
  }
  if (quartiles.length) rows = rows.filter(journal => {
    const rankings = rankingsFor(journal);
    return rankings.some(({ row, metric }) => metric?.metric_type === 'QUARTILE' && quartiles.includes(String(row.value_txt || '').toUpperCase()) && (!rankingYear || Number(row.year) === rankingYear));
  });
  if (rankingYear) rows = rows.filter(journal => {
    const rankings = rankingsFor(journal);
    return rankings.some(({ row, metric }) => String(metric?.code || '').toUpperCase() === 'SJR' && Number(row.year) === rankingYear);
  });

  const latestBy = (items, predicate) => items.filter(predicate).sort((a, b) => a.row.year == null ? (b.row.year == null ? 0 : 1) : b.row.year == null ? -1 : number(b.row.year) - number(a.row.year))[0] || null;
  const resultRows = rows.map(journal => {
    const journalId = String(journal.journal_id || journal.id);
    const rankings = rankingsFor(journal);
    const sjr = latestBy(rankings, ({ metric }) => String(metric?.code || '').toUpperCase() === 'SJR');
    const quartile = latestBy(rankings, ({ row, metric }) => metric?.metric_type === 'QUARTILE' && row.value_txt != null);
    const activeVolumeCount = volumes.filter(volume => String(volume.journal_id) === journalId && volume.is_deleted === false).length;
    const publisher = publisherById.get(String(journal.publisher_id || ''));
    const country = zoneById.get(String(journal.country || ''));
    return { ...journal, journal_id: journalId, display_name: journal.display_name ?? null, issn: journal.issn ?? null, type: journal.type ?? null, coverage: journal.coverage ?? null,
      is_open_access: journal.is_open_access ?? null, is_oa_diamond: journal.is_oa_diamond ?? null,
      publisher_id: publisher ? String(publisher.publisher_id || publisher.id) : (journal.publisher_id ?? null),
      publisher_name: publisher?.display_name ?? journal.publisher_name ?? null,
      country_id: country ? String(country.zone_id || country.id) : (journal.country_id ?? null),
      country_name: country?.name ?? journal.country_name ?? journal.country ?? null,
      metric_value: sjr ? (sjr.row.value_float == null ? null : number(sjr.row.value_float)) : null, metric_year: sjr?.row.year ?? null,
      quartile: quartile?.row.value_txt ?? null, best_quartile: quartile?.row.value_txt ?? null, quartile_year: quartile?.row.year ?? null, volume_count: activeVolumeCount,
      __sort_metric: sjr ? (sjr.row.value_float == null ? null : number(sjr.row.value_float)) : null };
  });

  const metricSort = ctx.query.sort === 'metric' || ctx.query.sort === '-metric';
  const sortBy = ctx.query.sort_by;
  if (metricSort) resultRows.sort((a, b) => a.__sort_metric == null ? (b.__sort_metric == null ? String(a.display_name || '').localeCompare(String(b.display_name || '')) : 1) : b.__sort_metric == null ? -1 : b.__sort_metric - a.__sort_metric || String(a.display_name || '').localeCompare(String(b.display_name || '')));
  else if (sortBy === 'volume_count') resultRows.sort((a, b) => (String(ctx.query.sort_order || 'ASC').toUpperCase() === 'DESC' ? -1 : 1) * (a.volume_count - b.volume_count));
  else resultRows.sort((a, b) => (String(ctx.query.sort_order || 'ASC').toUpperCase() === 'DESC' ? -1 : 1) * String(a.display_name || '').localeCompare(String(b.display_name || '')));

  const page = Math.max(1, Math.trunc(number(ctx.query.page, 1)));
  const limit = Math.max(1, Math.trunc(number(ctx.query.limit, 10)));
  const offset = (page - 1) * limit;
  const items = isEnriching ? resultRows.map(({ __sort_metric, ...row }) => row) : resultRows.slice(offset, offset + limit).map(({ __sort_metric, ...row }) => row);
  return { success: true, message: 'Láº¥y danh sÃ¡ch journal thÃ nh cÃ´ng', data: { items, pagination: { page, limit, total: resultRows.length } } };
}

async function publisherList(ctx, source) {
  const search = String(ctx.query.search || '').trim().toLowerCase();
  let rows = source.filter(row => row.is_deleted === false);
  if (search) rows = rows.filter(row => String(row.display_name || '').toLowerCase().includes(search));
  rows.sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || '')));
  const page = Math.max(1, Math.trunc(number(ctx.query.page, 1)));
  const limit = Math.max(1, Math.trunc(number(ctx.query.limit, 100)));
  const data = rows.slice((page - 1) * limit, page * limit).map(publisherProjection);
  return { success: true, message: 'Láº¥y danh sÃ¡ch nhÃ  xuáº¥t báº£n thÃ nh cÃ´ng', data, pagination: { page, limit, total: rows.length, total_pages: Math.ceil(rows.length / limit) } };
}

function uncappedPage(rows, query, defaultLimit = 10) {
  const page = Math.max(1, Math.trunc(number(query.page, 1)));
  const limit = Math.max(1, Math.trunc(number(query.limit, defaultLimit)));
  return { page, limit, total: rows.length, items: rows.slice((page - 1) * limit, page * limit) };
}

async function subjectAreaList(ctx, source) {
  const search = String(ctx.query.search || '').trim().toLowerCase();
  const sortBy = ['subject_area_id', 'display_name'].includes(ctx.query.sort_by) ? ctx.query.sort_by : 'display_name';
  const direction = String(ctx.query.sort_order || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  let rows = source.filter(row => row.is_deleted === false && (!search || String(row.display_name || '').toLowerCase().includes(search)));
  rows.sort((a, b) => direction * compare(a[sortBy] ?? a.id, b[sortBy] ?? b.id));
  const page = uncappedPage(rows, ctx.query);
  return { success: true, message: 'Láº¥y danh sÃ¡ch subject area thÃ nh cÃ´ng', code: 'GET_SUBJECT_AREAS_SUCCESS', data: { items: page.items.map(row => ({ subject_area_id: String(row.subject_area_id || row.id), display_name: row.display_name ?? null, description: row.description ?? null, is_deleted: row.is_deleted })), pagination: { page: page.page, limit: page.limit, total: page.total } } };
}

async function subjectCategoryList(ctx, source) {
  const search = String(ctx.query.search || '').trim().toLowerCase();
  const areaId = ctx.query.subject_area_id;
  const sortBy = ['subject_category_id', 'display_name', 'subject_area_id'].includes(ctx.query.sort_by) ? ctx.query.sort_by : 'display_name';
  const direction = String(ctx.query.sort_order || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  let rows = source.filter(row => row.is_deleted === false && (!areaId || String(row.subject_area_id) === String(areaId)) && (!search || String(row.display_name || '').toLowerCase().includes(search)));
  rows.sort((a, b) => direction * compare(a[sortBy] ?? a.id, b[sortBy] ?? b.id));
  const page = uncappedPage(rows, ctx.query);
  return { success: true, message: 'Láº¥y danh sÃ¡ch subject category thÃ nh cÃ´ng', code: 'GET_SUBJECT_CATEGORIES_SUCCESS', data: { items: page.items.map(row => ({ subject_category_id: String(row.subject_category_id || row.id), subject_area_id: String(row.subject_area_id), display_name: row.display_name ?? null, description: row.description ?? null, is_deleted: row.is_deleted })), pagination: { page: page.page, limit: page.limit, total: page.total } } };
}

async function topicList(ctx, source) {
  const [areas, categories] = await Promise.all([all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories')]);
  for (const [filter, rows, key] of [['subject_area_id', areas, 'subject_area_id'], ['subject_category_id', categories, 'subject_category_id']]) {
    if (ctx.query[filter] && !rows.some(row => String(row[key] || row.id) === String(ctx.query[filter]))) throw new HttpError(400, `${filter} khÃ´ng tá»“n táº¡i`, 'INVALID_FILTER');
  }
  const areaById = new Map(areas.map(row => [String(row.subject_area_id || row.id), row]));
  const categoryById = new Map(categories.map(row => [String(row.subject_category_id || row.id), row]));
  const search = String(ctx.query.search || '').trim().toLowerCase();
  const sortBy = ['topic_id', 'display_name', 'score'].includes(ctx.query.sort_by) ? ctx.query.sort_by : 'display_name';
  if (ctx.query.sort_by && !['topic_id', 'display_name', 'score'].includes(ctx.query.sort_by)) throw new HttpError(400, 'sort_by khÃ´ng há»£p lá»‡', 'INVALID_FILTER');
  const direction = String(ctx.query.sort_order || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  let rows = source.filter(row => row.is_deleted === false
    && (!ctx.query.subject_area_id || String(row.subject_area_id) === String(ctx.query.subject_area_id))
    && (!ctx.query.subject_category_id || String(row.subject_category_id) === String(ctx.query.subject_category_id))
    && (!search || String(row.display_name || '').toLowerCase().includes(search)));
  rows.sort((a, b) => direction * compare(a[sortBy] ?? a.id, b[sortBy] ?? b.id));
  const page = uncappedPage(rows, ctx.query);
  const items = page.items.map(row => ({ topic_id: String(row.topic_id || row.id), display_name: row.display_name ?? null, score: row.score ?? null, subject_area_id: row.subject_area_id == null ? null : String(row.subject_area_id), subject_category_id: row.subject_category_id == null ? null : String(row.subject_category_id), is_deleted: row.is_deleted, subject_area_name: areaById.get(String(row.subject_area_id))?.display_name ?? null, subject_category_name: categoryById.get(String(row.subject_category_id))?.display_name ?? null }));
  return { success: true, code: 'GET_TOPICS_SUCCESS', message: 'Láº¥y danh sÃ¡ch Topic thÃ nh cÃ´ng', data: { items, total: page.total } };
}

async function keywordList(ctx, source) {
  const page = Math.max(1, Math.trunc(number(ctx.query.page, 1)));
  const limit = Math.min(100, Math.max(1, Math.trunc(number(ctx.query.limit, 10))));
  const search = String(ctx.query.search || ctx.query.keyword || '').trim().toLowerCase();
  let rows = source.filter(row => !search || String(row.display_name || row.name || row.keyword || '').toLowerCase().includes(search));
  const areaId = Number.parseInt(ctx.query.subject_area_id, 10);
  const areaFiltered = Number.isInteger(areaId) && areaId > 0;
  if (areaFiltered) {
    const [links, articles, issues, volumes, journals, journalCategories, categories] = await Promise.all(['keyword_articles', 'articles', 'issues', 'volumes', 'journals', 'journal_subject_categories', 'subjectCategories'].map(name => all(ctx.db, name)));
    const articleById = new Map(articles.filter(row => row.is_deleted !== true).map(row => [String(row.article_id || row.id), row]));
    const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
    const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
    const categoryIds = new Set(categories.filter(row => String(row.subject_area_id) === String(areaId)).map(row => String(row.subject_category_id || row.id)));
    const journalIds = new Set(journalCategories.filter(row => categoryIds.has(String(row.subject_category_id))).map(row => String(row.journal_id)));
    const articlesByKeyword = new Map();
    for (const link of links) {
      const article = articleById.get(String(link.article_id));
      if (!article) continue;
      const issue = issueById.get(String(article.issue_id || ''));
      const volume = volumeById.get(String(issue?.volume_id || ''));
      if (!journalIds.has(String(volume?.journal_id || ''))) continue;
      const key = String(link.keyword_id);
      articlesByKeyword.set(key, (articlesByKeyword.get(key) || 0) + 1);
    }
    rows = rows.filter(row => articlesByKeyword.has(String(row.keyword_id || row.id)));
    rows = rows.map(row => ({ ...row, article_count: articlesByKeyword.get(String(row.keyword_id || row.id)) }));
    rows.sort((a, b) => number(b.article_count) - number(a.article_count) || String(a.display_name || '').localeCompare(String(b.display_name || '')));
  } else {
    rows.sort((a, b) => String(a.display_name || a.name || a.keyword || '').localeCompare(String(b.display_name || b.name || b.keyword || '')));
  }
  return { success: true, code: 'KEYWORD_LIST_FETCHED', message: 'Láº¥y danh sÃ¡ch keyword thÃ nh cÃ´ng', data: rows.slice((page - 1) * limit, page * limit).map(row => ({ keyword_id: String(row.keyword_id ?? row.id), display_name: row.display_name || row.name || row.keyword, ...(row.article_count !== undefined ? { article_count: row.article_count } : {}) })), pagination: { page, limit, total: rows.length, total_pages: areaFiltered ? Math.max(1, Math.ceil(rows.length / limit)) : Math.ceil(rows.length / limit) } };
}

const publisherProjection = row => ({ publisher_id: String(row.publisher_id || row.id), display_name: row.display_name ?? null, image_url: row.image_url ?? null, created_at: row.created_at ?? null });

async function createPublisherRecord(ctx) {
  const { display_name, image_url } = ctx.body || {};
  if (typeof display_name !== 'string' || display_name.length < 1 || (image_url !== undefined && image_url !== null && typeof image_url !== 'string')) throw new HttpError(400, 'Invalid publisher fields', 'VALIDATION_ERROR');
  if ((await all(ctx.db, 'publishers')).some(row => row.display_name === display_name)) throw new HttpError(400, 'TÃªn nhÃ  xuáº¥t báº£n Ä‘Ã£ tá»“n táº¡i', 'VALIDATION_ERROR');
  const key = id();
  const row = { id: key, publisher_id: key, display_name, image_url: image_url ?? null, is_deleted: false, created_at: nowIso() };
  await ctx.db.create('publishers', key, row);
  return { body: { success: true, message: 'Táº¡o nhÃ  xuáº¥t báº£n thÃ nh cÃ´ng', data: publisherProjection(row) }, status: 201 };
}

function validateKeywordName(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 255 && !/[!@#$%^&*()_+={}\[\]|\\:;"'<>,?\/\~`]/.test(value) && !/<[^>]*>/.test(value);
}

async function createKeywordRecord(ctx) {
  const name = ctx.body?.display_name;
  if (!validateKeywordName(name)) throw new HttpError(400, 'Invalid keyword display_name', 'VALIDATION_ERROR');
  const rows = await all(ctx.db, 'keywords');
  const duplicate = rows.find(row => String(row.display_name || row.name || row.keyword || '').toLowerCase() === name.toLowerCase());
  if (duplicate) throw new HttpError(409, duplicate.is_deleted === true ? 'Keyword was deleted; restore it first' : 'Keyword already exists', duplicate.is_deleted === true ? 'KEYWORD_ALREADY_DELETED' : 'KEYWORD_DUPLICATE');
  const key = await allocateNumericRecordId(ctx.db, 'keywords', 'keyword_id');
  const row = { id: key, keyword_id: Number(key), display_name: name, is_deleted: false, created_at: nowIso() };
  await ctx.db.create('keywords', key, row);
  return { body: { success: true, code: 'KEYWORD_CREATED', message: 'Keyword created successfully', data: { keyword_id: key, display_name: name } }, status: 201 };
}

const authorFields = ['orcid', 'url_image', 'works_count', 'cited_by_count', 'h_index', 'i10_index', 'last_known_institution', 'last_known_institution_id'];
function validateAuthorRecord(body, creating = false) {
  if (creating && (typeof body.display_name !== 'string' || body.display_name.length < 2 || body.display_name.length > 255)) throw new HttpError(400, 'Invalid author display_name', 'AUTHOR_INVALID_BODY');
  if (body.display_name !== undefined && (typeof body.display_name !== 'string' || body.display_name.length < 2 || body.display_name.length > 255)) throw new HttpError(400, 'Invalid author display_name', 'AUTHOR_INVALID_BODY');
  for (const key of ['orcid', 'url_image', 'homepage_url', 'last_known_institution', 'last_known_institution_id']) if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') throw new HttpError(400, `Invalid ${key}`, 'AUTHOR_INVALID_BODY');
  for (const key of ['works_count', 'cited_by_count', 'h_index', 'i10_index']) if (body[key] !== undefined && body[key] !== null && (!Number.isInteger(body[key]) || body[key] < 0)) throw new HttpError(400, `Invalid ${key}`, 'AUTHOR_INVALID_BODY');
}
const authorProjection = row => { const { id: _id, ...data } = row; return { ...data, author_id: String(row.author_id || row.id) }; };

async function createAuthorRecord(ctx) {
  const body = ctx.body || {};
  validateAuthorRecord(body, true);
  const key = await allocateNumericRecordId(ctx.db, 'authors', 'author_id');
  const row = { id: key, author_id: Number(key), display_name: body.display_name, orcid: body.orcid ?? null, url_image: body.url_image ?? null, works_count: body.works_count ?? null, cited_by_count: body.cited_by_count ?? null, h_index: body.h_index ?? null, i10_index: body.i10_index ?? null, last_known_institution: body.last_known_institution ?? null, last_known_institution_id: body.last_known_institution_id ?? null, is_deleted: false, created_at: nowIso() };
  await ctx.db.create('authors', key, row);
  return { body: { success: true, code: 'AUTHOR_CREATED', message: 'Author created successfully', data: authorProjection(row) }, status: 201 };
}

async function updateAuthorRecord(ctx) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid author ID', 'AUTHOR_INVALID_ID');
  const row = await byId(ctx.db, 'authors', ctx.params.id);
  if (!row || row.is_deleted !== false) throw new HttpError(404, 'Author does not exist', 'AUTHOR_NOT_FOUND');
  const body = ctx.body || {};
  validateAuthorRecord(body);
  const patch = Object.fromEntries(['display_name', ...authorFields].filter(key => key !== 'homepage_url' && body[key] !== undefined).map(key => [key, body[key]]));
  if (!Object.keys(patch).length) throw new HttpError(400, 'No author fields to update', 'AUTHOR_INVALID_BODY');
  const updated = { ...row, ...patch };
  await ctx.db.set('authors', row.id || String(ctx.params.id), updated);
  return { success: true, code: 'AUTHOR_UPDATED', message: 'Author updated successfully', data: authorProjection(updated) };
}

async function deleteAuthorRecord(ctx) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid author ID', 'AUTHOR_INVALID_ID');
  const row = await byId(ctx.db, 'authors', ctx.params.id);
  if (!row) throw new HttpError(404, 'Author does not exist', 'AUTHOR_NOT_FOUND');
  if (row.is_deleted === true) throw new HttpError(400, 'Author already deleted', 'AUTHOR_ALREADY_DELETED');
  await ctx.db.set('authors', row.id || String(ctx.params.id), { ...row, is_deleted: true });
  return { success: true, code: 'AUTHOR_DELETED', message: 'Author deleted successfully' };
}

async function restoreAuthorRecord(ctx) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid author ID', 'AUTHOR_INVALID_ID');
  const row = await byId(ctx.db, 'authors', ctx.params.id);
  if (!row) throw new HttpError(404, 'Author does not exist', 'AUTHOR_NOT_FOUND');
  if (row.is_deleted !== true) throw new HttpError(400, 'Author is already active', 'AUTHOR_ALREADY_ACTIVE');
  const restored = { ...row, is_deleted: false };
  await ctx.db.set('authors', row.id || String(ctx.params.id), restored);
  return { success: true, code: 'AUTHOR_RESTORED', message: 'Author restored successfully', data: { author_id: String(restored.author_id || restored.id), display_name: restored.display_name, is_deleted: false } };
}

async function updateKeywordRecord(ctx) {
  const key = String(ctx.params.id);
  const row = await byId(ctx.db, 'keywords', key);
  if (!row || row.is_deleted === true) throw new HttpError(404, 'Keyword does not exist', 'KEYWORD_NOT_FOUND');
  const name = ctx.body?.display_name;
  if (!validateKeywordName(name)) throw new HttpError(400, 'Invalid keyword display_name', 'VALIDATION_ERROR');
  const rows = await all(ctx.db, 'keywords');
  if (rows.some(item => String(item.keyword_id || item.id) !== String(row.keyword_id || row.id) && item.is_deleted === false && String(item.display_name || item.name || item.keyword || '').toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Keyword already exists', 'KEYWORD_DUPLICATE');
  const updated = { ...row, display_name: name };
  await ctx.db.set('keywords', row.id || key, updated);
  return { success: true, code: 'KEYWORD_UPDATED', message: 'Keyword updated successfully', data: { keyword_id: String(updated.keyword_id || updated.id), display_name: name } };
}

async function deleteKeywordRecord(ctx) {
  const key = String(ctx.params.id);
  const row = await byId(ctx.db, 'keywords', key);
  if (!row) throw new HttpError(404, 'Keyword does not exist', 'KEYWORD_NOT_FOUND');
  if (row.is_deleted === true) throw new HttpError(400, 'Keyword already deleted', 'KEYWORD_ALREADY_DELETED');
  await ctx.db.set('keywords', row.id || key, { ...row, is_deleted: true });
  return { success: true, code: 'KEYWORD_DELETED', message: 'Keyword deleted successfully' };
}

async function restoreKeywordRecord(ctx) {
  const key = String(ctx.params.id);
  const row = await byId(ctx.db, 'keywords', key);
  if (!row) throw new HttpError(404, 'Keyword does not exist', 'KEYWORD_NOT_FOUND');
  if (row.is_deleted !== true) throw new HttpError(400, 'Keyword is already active', 'KEYWORD_ALREADY_ACTIVE');
  const restored = { ...row, is_deleted: false };
  await ctx.db.set('keywords', row.id || key, restored);
  return { success: true, code: 'KEYWORD_RESTORED', message: 'Keyword restored successfully', data: { keyword_id: String(restored.keyword_id || restored.id), display_name: restored.display_name, is_deleted: false } };
}

async function updatePublisherRecord(ctx) {
  const row = await byId(ctx.db, 'publishers', ctx.params.id);
  if (!row || row.is_deleted !== false) throw new HttpError(404, 'KhÃ´ng tÃ¬m tháº¥y nhÃ  xuáº¥t báº£n Ä‘á»ƒ cáº­p nháº­t', 'NOT_FOUND');
  const { display_name, image_url } = ctx.body || {};
  if (display_name !== undefined && (typeof display_name !== 'string' || display_name.length < 1)) throw new HttpError(400, 'Invalid display_name', 'VALIDATION_ERROR');
  if (image_url !== undefined && image_url !== null && typeof image_url !== 'string') throw new HttpError(400, 'Invalid image_url', 'VALIDATION_ERROR');
  if (display_name !== undefined && (await all(ctx.db, 'publishers')).some(item => String(item.id || item.publisher_id) !== String(row.id || row.publisher_id) && item.display_name === display_name)) throw new HttpError(400, 'TÃªn nhÃ  xuáº¥t báº£n Ä‘Ã£ tá»“n táº¡i', 'VALIDATION_ERROR');
  const updated = { ...row, ...(display_name != null ? { display_name } : {}), ...(image_url != null ? { image_url } : {}) };
  await ctx.db.set('publishers', row.id || ctx.params.id, updated);
  return { success: true, message: 'Cáº­p nháº­t nhÃ  xuáº¥t báº£n thÃ nh cÃ´ng', data: publisherProjection(updated) };
}

async function deletePublisherRecord(ctx) {
  const row = await byId(ctx.db, 'publishers', ctx.params.id);
  if (!row) throw new HttpError(404, 'KhÃ´ng tÃ¬m tháº¥y nhÃ  xuáº¥t báº£n', 'NOT_FOUND');
  if (row.is_deleted === true) throw new HttpError(400, 'NhÃ  xuáº¥t báº£n Ä‘Ã£ bá»‹ xÃ³a tá»« trÆ°á»›c', 'ALREADY_DELETED');
  const [journals, references] = await Promise.all([all(ctx.db, 'journals'), all(ctx.db, 'articles')]);
  if (journals.some(item => String(item.publisher_id) === String(row.publisher_id || row.id)) || references.some(item => String(item.publisher_id) === String(row.publisher_id || row.id))) throw new HttpError(400, 'KhÃ´ng thá»ƒ xÃ³a nhÃ  xuáº¥t báº£n vÃ¬ Ä‘ang cÃ³ thá»±c thá»ƒ liÃªn káº¿t', 'VALIDATION_ERROR');
  await ctx.db.set('publishers', row.id || ctx.params.id, { ...row, is_deleted: true });
  return { success: true, message: 'XÃ³a nhÃ  xuáº¥t báº£n thÃ nh cÃ´ng' };
}

async function restorePublisherRecord(ctx) {
  const row = await byId(ctx.db, 'publishers', ctx.params.id);
  if (!row) throw new HttpError(404, 'KhÃ´ng tÃ¬m tháº¥y nhÃ  xuáº¥t báº£n', 'NOT_FOUND');
  if (row.is_deleted !== true) throw new HttpError(400, 'NhÃ  xuáº¥t báº£n Ä‘ang hoáº¡t Ä‘á»™ng, khÃ´ng cáº§n khÃ´i phá»¥c', 'NOT_DELETED');
  const restored = { ...row, is_deleted: false };
  await ctx.db.set('publishers', row.id || ctx.params.id, restored);
  return { success: true, message: 'KhÃ´i phá»¥c nhÃ  xuáº¥t báº£n thÃ nh cÃ´ng', data: publisherProjection(restored) };
}

async function listArticles(ctx, source) {
  if (ctx.query.keywords !== undefined) {
    const words = String(ctx.query.keywords || '').split(',').map(word => word.trim().toLowerCase()).filter(Boolean);
    if (!words.length) throw new HttpError(400, 'keywords must contain at least one value', 'MISSING_KEYWORDS');
    if (!ctx.user) ctx.user = await authenticate(ctx.request, ctx.env, ctx.db);
    let rows = source.filter(row => !isDeleted(row));
    const [keywordLinks, keywords] = await Promise.all([all(ctx.db, 'keyword_articles'), all(ctx.db, 'keywords')]);
    const keywordById = new Map(keywords.map(row => [String(row.keyword_id || row.id), String(row.display_name || row.name || row.keyword || '').trim().toLowerCase()]));
    const exactKeywordsByArticle = new Map();
    for (const link of keywordLinks) {
      const articleId = String(link.article_id || '');
      const label = keywordById.get(String(link.keyword_id || ''));
      if (!label) continue;
      if (!exactKeywordsByArticle.has(articleId)) exactKeywordsByArticle.set(articleId, new Set());
      exactKeywordsByArticle.get(articleId).add(label);
    }
    rows = rows.filter(row => {
      const articleId = String(row.article_id || row.id);
      const values = new Set(exactKeywordsByArticle.get(articleId) || []);
      for (const item of [row.keyword_objects, row.keywords, row.keyword_names, row.keyword]) {
        for (const value of Array.isArray(item) ? item : [item]) {
          const label = typeof value === 'object' && value !== null ? value.display_name || value.name || value.keyword : value;
          if (label) values.add(String(label).trim().toLowerCase());
        }
      }
      return words.some(word => values.has(word));
    });
    rows.sort((a, b) => compare(field(b, 'publication_year', 'year'), field(a, 'publication_year', 'year'))
      || compare(a.created_at, b.created_at) * -1);
    const page = Math.max(1, Number.parseInt(ctx.query.page, 10) || 1);
    const limit = Math.max(1, Number.parseInt(ctx.query.limit, 10) || 20);
    const total = rows.length;
    const articles = rows.slice((page - 1) * limit, page * limit).map(row => ({
      article_id: String(row.article_id || row.id), title: row.title ?? null, abstract: row.abstract ?? null,
      publication_year: row.publication_year ?? null, doi: row.doi ?? null, created_at: row.created_at ?? null,
    }));
    return { success: true, code: 'ARTICLES_GET_BY_KEYWORDS_SUCCESS', message: 'Láº¥y danh sÃ¡ch bÃ i bÃ¡o thÃ nh cÃ´ng!', data: { articles, pagination: { total, page, limit, total_pages: Math.ceil(total / limit) } } };
  }

  let rows = source.filter(row => !isDeleted(row));
  const search = String(ctx.query.search || '').trim().toLowerCase();
  if (search) rows = rows.filter(row => `${row.title || ''} ${row.doi || ''}`.toLowerCase().includes(search));
  const journalFilter = ctx.query.journal_id ?? ctx.query.journal;
  const topicFilter = ctx.query.topic_id ?? ctx.query.topic;
  const volumeFilter = ctx.query.volume_id;
  const issueFilter = ctx.query.issue_id;
  const yearFilter = ctx.query.publication_year ?? ctx.query.year;
  const countryFilter = ctx.query.country_id ?? ctx.query.country;
  for (const [value, predicate] of [
    [yearFilter, row => String(row.publication_year ?? row.year) === String(yearFilter)],
    [journalFilter, row => String(row.journal_id ?? '') === String(journalFilter)],
    [topicFilter, row => String(row.primary_topic ?? row.topic_id ?? '') === String(topicFilter)],
    [volumeFilter, row => String(row.volume_id ?? '') === String(volumeFilter)],
    [issueFilter, row => String(row.issue_id ?? '') === String(issueFilter)],
    [countryFilter, row => String(row.country_id ?? row.country ?? '') === String(countryFilter)],
  ]) if (value !== undefined && value !== '') rows = rows.filter(predicate);
  let access = ctx.query.is_open_access ?? ctx.query.access;
  if (['all', ''].includes(String(access || '').toLowerCase())) access = undefined;
  if (['oa', 'true'].includes(String(access || '').toLowerCase())) access = true;
  if (['closed', 'non-oa', 'false'].includes(String(access || '').toLowerCase())) access = false;
  if (access !== undefined && typeof access !== 'boolean') access = undefined;
  if (access !== undefined) rows = rows.filter(row => Boolean(row.is_open_access ?? row.journal_is_open_access) === access);

  const allowedSort = ['article_id', 'title', 'publication_year', 'created_at', 'doi'];
  const sortBy = allowedSort.includes(ctx.query.sortBy) ? ctx.query.sortBy : 'created_at';
  const descending = String(ctx.query.sortOrder || 'DESC').toUpperCase() !== 'ASC';
  rows.sort((a, b) => compare(a[sortBy], b[sortBy]) * (descending ? -1 : 1) || compare(a.article_id, b.article_id) * -1);
  const page = paginate(rows, ctx.query, 10, 100);
  const [authors, topics, authorLinks, topicLinks] = await Promise.all([all(ctx.db, 'authors'), all(ctx.db, 'topics'), all(ctx.db, 'author_articles'), all(ctx.db, 'sub_topics')]);
  const stats = {
    totalArticles: source.filter(row => !isDeleted(row)).length,
    openAccessCount: source.filter(row => !isDeleted(row) && Boolean(row.is_open_access ?? row.journal_is_open_access)).length,
    authorsCount: new Set(authorLinks.map(row => String(row.author_id))).size || authors.filter(row => !isDeleted(row)).length,
    topicsCount: new Set(topicLinks.map(row => String(row.topic_id))).size || topics.filter(row => !isDeleted(row)).length,
  };
  return { success: true, code: 'ARTICLES_GET_SUCCESS', message: 'Láº¥y danh sÃ¡ch bÃ i bÃ¡o thÃ nh cÃ´ng!', data: { articles: page.items, items: page.items, pagination: { page: page.page, limit: page.limit, total: page.total, total_pages: page.totalPages }, stats } };
}

async function listVolumeIssueEntity(ctx, name, source) {
  if (name === 'volumes') return listSourceVolumes(ctx, source);
  return listSourceIssues(ctx, source);
}

function sourcePagination(ctx) {
  const page = ctx.query.page === undefined ? 1 : Number(ctx.query.page);
  const limit = ctx.query.limit === undefined ? 10 : Number(ctx.query.limit);
  if (!Number.isInteger(page) || page < 1) throw new HttpError(400, 'page must be a positive integer', 'VALIDATION_ERROR');
  if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, 'limit must be a positive integer', 'VALIDATION_ERROR');
  return { page, limit, start: (page - 1) * limit };
}

async function listSourceVolumes(ctx, source) {
  const { page, limit, start } = sourcePagination(ctx);
  if (ctx.query.publication_year !== undefined && !/^-?\d+$/.test(String(ctx.query.publication_year))) throw new HttpError(400, 'publication_year must be an integer', 'VALIDATION_ERROR');
  const sortBy = ctx.query.sort_by || 'volume_number';
  const sortOrder = ctx.query.sort_order || 'asc';
  if (!['volume_id', 'volume_number', 'publication_year'].includes(sortBy)) throw new HttpError(400, 'sort_by is invalid', 'VALIDATION_ERROR');
  if (!['asc', 'desc'].includes(String(sortOrder))) throw new HttpError(400, 'sort_order is invalid', 'VALIDATION_ERROR');
  let rows = source.filter(row => row.is_deleted === false);
  if (ctx.query.journal_id) rows = rows.filter(row => String(row.journal_id) === String(ctx.query.journal_id));
  if (ctx.query.publication_year !== undefined && ctx.query.publication_year !== '') rows = rows.filter(row => Number(row.publication_year) === Number(ctx.query.publication_year));
  const search = String(ctx.query.search || '').trim().toLowerCase();
  if (search) rows = rows.filter(row => String(row.volume_number ?? '').toLowerCase().includes(search));
  const direction = sortOrder === 'desc' ? -1 : 1;
  const sortValue = row => sortBy === 'volume_id' ? row.volume_id || row.id : row[sortBy];
  rows.sort((a, b) => compare(sortValue(a), sortValue(b)) * direction);
  const items = rows.slice(start, start + limit).map(row => ({
    volume_id: String(row.volume_id || row.id), journal_id: row.journal_id == null ? null : String(row.journal_id),
    volume_number: row.volume_number, publication_year: row.publication_year, is_deleted: row.is_deleted,
  }));
  return { success: true, code: 'GET_VOLUMES_SUCCESS', message: 'Láº¥y danh sÃ¡ch volume thÃ nh cÃ´ng', data: { items, pagination: { page, limit, total: rows.length } } };
}

async function listSourceIssues(ctx, source) {
  const { page, limit, start } = sourcePagination(ctx);
  for (const key of ['volume_id', 'journal_id']) {
    if (ctx.query[key] !== undefined && !/^-?\d+$/.test(String(ctx.query[key]))) throw new HttpError(400, `${key} must be an integer`, 'VALIDATION_ERROR');
  }
  const volumes = await all(ctx.db, 'volumes');
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  if (ctx.query.volume_id) {
    const selected = volumeById.get(String(ctx.query.volume_id));
    if (!selected || selected.is_deleted !== false) throw new HttpError(404, 'Volume not found', 'VOLUME_NOT_FOUND');
  }
  let rows = source.filter(row => row.is_deleted === false && volumeById.has(String(row.volume_id)));
  if (ctx.query.volume_id) rows = rows.filter(row => String(row.volume_id) === String(ctx.query.volume_id));
  if (ctx.query.journal_id) rows = rows.filter(row => String(volumeById.get(String(row.volume_id))?.journal_id) === String(ctx.query.journal_id));
  rows.sort((a, b) => compare(b.publication_year, a.publication_year) || compare(b.issue_number, a.issue_number));
  const items = rows.slice(start, start + limit).map(row => {
    const volume = volumeById.get(String(row.volume_id));
    return { issue_id: String(row.issue_id || row.id), volume_id: String(row.volume_id), issue_number: row.issue_number, publication_year: row.publication_year, journal_id: volume.journal_id == null ? null : String(volume.journal_id), volume_number: volume.volume_number };
  });
  return { success: true, message: 'Láº¥y danh sÃ¡ch Issue thÃ nh cÃ´ng', data: items, pagination: { page, limit, total: rows.length, totalPages: Math.ceil(rows.length / limit) } };
}

async function createVolumeIssue(ctx, name) {
  if (name === 'volumes') {
    const journalId = String(ctx.body.journal_id || '');
    const number = Number(ctx.body.volume_number);
    const year = Number(ctx.body.publication_year);
    if (!/^\d+$/.test(journalId) || !Number.isInteger(number) || number < 1 || !Number.isInteger(year) || year < 1) throw new HttpError(400, 'journal_id, positive integer volume_number and publication_year are required', 'VALIDATION_ERROR');
    const journal = await byId(ctx.db, 'journals', journalId);
    if (!journal || journal.is_deleted !== false) throw new HttpError(400, 'Journal not found or deleted', 'JOURNAL_NOT_FOUND');
    const duplicate = await find(ctx.db, 'volumes', row => row.is_deleted === false && String(row.journal_id) === journalId && Number(row.volume_number) === number, { limit: 1 });
    if (duplicate.length) throw new HttpError(400, 'Volume number already exists for this journal', 'DUPLICATE_VOLUME');
    const key = await allocateNumericRecordId(ctx.db, 'volumes', 'volume_id');
    const row = { id: key, volume_id: Number(key), journal_id: Number(journalId), volume_number: number, publication_year: year, is_deleted: false, created_at: nowIso() };
    await ctx.db.create('volumes', key, row);
    return { body: { success: true, code: 'CREATE_VOLUME_SUCCESS', message: 'Táº¡o Volume thÃ nh cÃ´ng', data: row }, status: 201 };
  }
  const volumeId = String(ctx.body.volume_id || '');
  const number = Number(ctx.body.issue_number);
  const year = Number(ctx.body.publication_year);
  if (!/^\d+$/.test(volumeId) || !Number.isInteger(number) || number < 1 || !Number.isInteger(year) || year < 1) throw new HttpError(400, 'volume_id, positive integer issue_number and publication_year are required', 'VALIDATION_ERROR');
  const volume = await byId(ctx.db, 'volumes', volumeId);
  if (!volume || volume.is_deleted !== false) throw new HttpError(400, 'Volume not found or deleted', 'VOLUME_NOT_FOUND');
  const duplicate = await find(ctx.db, 'issues', row => row.is_deleted === false && String(row.volume_id) === volumeId && Number(row.issue_number) === number, { limit: 1 });
  if (duplicate.length) throw new HttpError(400, 'Issue number already exists for this volume', 'DUPLICATE_ISSUE');
  const key = await allocateNumericRecordId(ctx.db, 'issues', 'issue_id');
  const row = { id: key, issue_id: Number(key), volume_id: Number(volumeId), issue_number: number, publication_year: year, is_deleted: false, created_at: nowIso() };
  await ctx.db.create('issues', key, row);
  return { body: { success: true, code: 'CREATE_ISSUE_SUCCESS', message: 'Táº¡o Issue thÃ nh cÃ´ng', data: row }, status: 201 };
}

const volumeIssueProjection = (row, name) => name === 'volumes'
  ? { volume_id: String(row.volume_id || row.id), journal_id: String(row.journal_id), volume_number: row.volume_number, publication_year: row.publication_year, is_deleted: row.is_deleted }
  : { issue_id: String(row.issue_id || row.id), volume_id: String(row.volume_id), issue_number: row.issue_number, publication_year: row.publication_year, is_deleted: row.is_deleted };

async function updateVolumeIssue(ctx, name) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid ID', 'VALIDATION_ERROR');
  const keyName = name === 'volumes' ? 'volume_id' : 'issue_id';
  const row = requireFound(await byId(ctx.db, name, ctx.params.id), `${name === 'volumes' ? 'Volume' : 'Issue'} not found`);
  if (row.is_deleted !== false) throw new HttpError(400, `${name === 'volumes' ? 'Volume' : 'Issue'} is deleted`, `${name === 'volumes' ? 'VOLUME' : 'ISSUE'}_ALREADY_DELETED`);
  if (name === 'issues' && !await byId(ctx.db, 'volumes', row.volume_id)) throw new HttpError(404, 'Issue not found', 'ISSUE_NOT_FOUND');
  const numberField = name === 'volumes' ? 'volume_number' : 'issue_number';
  for (const key of [numberField, 'publication_year']) if (ctx.body[key] !== undefined && (!Number.isInteger(Number(ctx.body[key])) || Number(ctx.body[key]) < 1)) throw new HttpError(400, `Invalid ${key}`, 'VALIDATION_ERROR');
  const nextNumber = ctx.body[numberField] === undefined ? row[numberField] : Number(ctx.body[numberField]);
  const parentId = String(name === 'volumes' ? row.journal_id : row.volume_id);
  const duplicate = await find(ctx.db, name, item => item.is_deleted === false && String(item[keyName] || item.id) !== String(row[keyName] || row.id) && String(name === 'volumes' ? item.journal_id : item.volume_id) === parentId && Number(item[numberField]) === Number(nextNumber), { limit: 1 });
  if (duplicate.length) throw new HttpError(400, `${name === 'volumes' ? 'Volume' : 'Issue'} number already exists`, name === 'volumes' ? 'DUPLICATE_VOLUME' : 'DUPLICATE_ISSUE');
  if (ctx.body[numberField] === undefined && ctx.body.publication_year === undefined) return { success: true, code: name === 'volumes' ? 'UPDATE_VOLUME_SUCCESS' : 'UPDATE_ISSUE_SUCCESS', message: `Cáº­p nháº­t ${name === 'volumes' ? 'Volume' : 'Issue'} thÃ nh cÃ´ng`, data: null };
  const updated = { ...row, [numberField]: nextNumber, ...(ctx.body.publication_year === undefined ? {} : { publication_year: Number(ctx.body.publication_year) }), updated_at: nowIso() };
  await ctx.db.set(collectionFor(name), row.id || String(ctx.params.id), updated);
  return { success: true, code: name === 'volumes' ? 'UPDATE_VOLUME_SUCCESS' : 'UPDATE_ISSUE_SUCCESS', message: `${name === 'volumes' ? 'Volume' : 'Issue'} updated successfully`, data: volumeIssueProjection(updated, name) };
}

async function deleteVolumeIssue(ctx, name) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid ID', 'VALIDATION_ERROR');
  const row = requireFound(await byId(ctx.db, name, ctx.params.id), `${name === 'volumes' ? 'Volume' : 'Issue'} not found`);
  if (row.is_deleted !== false) throw new HttpError(400, `${name === 'volumes' ? 'Volume' : 'Issue'} is already deleted`, `${name === 'volumes' ? 'VOLUME' : 'ISSUE'}_ALREADY_DELETED`);
  const updated = { ...row, is_deleted: true, deleted_at: nowIso(), updated_at: nowIso() };
  await ctx.db.set(collectionFor(name), row.id || String(ctx.params.id), updated);
  return { success: true, code: name === 'volumes' ? 'DELETE_VOLUME_SUCCESS' : 'DELETE_ISSUE_SUCCESS', message: `${name === 'volumes' ? 'Volume' : 'Issue'} deleted successfully`, data: volumeIssueProjection(updated, name) };
}

async function restoreVolumeIssue(ctx, name) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid ID', 'VALIDATION_ERROR');
  const row = requireFound(await byId(ctx.db, name, ctx.params.id), `${name === 'volumes' ? 'Volume' : 'Issue'} not found`);
  if (row.is_deleted !== true) throw new HttpError(400, `${name === 'volumes' ? 'Volume' : 'Issue'} is not deleted`, name === 'volumes' ? 'VOLUME_NOT_DELETED' : 'ISSUE_NOT_DELETED');
  const updated = { ...row, is_deleted: false, deleted_at: null, updated_at: nowIso() };
  if (String(updated.status || '').toUpperCase() === 'DELETED') updated.status = 'ACTIVE';
  await ctx.db.set(collectionFor(name), row.id || String(ctx.params.id), updated);
  return { success: true, code: name === 'volumes' ? 'RESTORE_VOLUME_SUCCESS' : 'RESTORE_ISSUE_SUCCESS', message: `${name === 'volumes' ? 'Volume' : 'Issue'} restored successfully`, data: volumeIssueProjection(updated, name) };
}

async function journalDetail(ctx, idValue) {
  const [journals, publishers, zones, categories, categoryLinks, rankingRows, rankingMetrics] = await Promise.all(['journals', 'publishers', 'zones', 'subjectCategories', 'journal_subject_categories', 'journal_rankings', 'ranking_metrics'].map(name => all(ctx.db, name)));
  const journal = journals.find(row => String(row.journal_id || row.id) === String(idValue) && row.is_deleted === false);
  if (!journal) throw new HttpError(404, 'Journal not found', 'NOT_FOUND');
  const journalId = String(journal.journal_id || journal.id);
  const publisher = publishers.find(row => String(row.publisher_id || row.id) === String(journal.publisher_id || ''));
  const country = zones.find(row => String(row.zone_id || row.id) === String(journal.country || ''));
  const region = zones.find(row => String(row.zone_id || row.id) === String(journal.region || ''));
  const categoryById = new Map(categories.map(row => [String(row.subject_category_id || row.id), row]));
  const subjectCategories = categoryLinks.filter(link => String(link.journal_id) === journalId).map(link => categoryById.get(String(link.subject_category_id)))
    .filter(category => category && category.is_deleted !== true).sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''))).slice(0, 12)
    .map(category => ({ id: String(category.subject_category_id || category.id), display_name: category.display_name ?? null, subject_area_id: category.subject_area_id == null ? null : String(category.subject_area_id) }));
  const metricById = new Map(rankingMetrics.map(row => [String(row.metric_id || row.ranking_metric_id || row.id), row]));
  const metricsByCode = new Map();
  for (const { ranking, metric } of rankingRows.filter(row => String(row.journal_id) === journalId).map(row => ({ ranking: row, metric: metricById.get(String(row.metric_id || row.ranking_metric_id || '')) }))
    .sort((a, b) => String(a.metric?.code || '').toUpperCase().localeCompare(String(b.metric?.code || '').toUpperCase()) || (a.ranking.year == null ? (b.ranking.year == null ? 0 : 1) : b.ranking.year == null ? -1 : number(b.ranking.year) - number(a.ranking.year)))) {
    const code = String(metric?.code || '').toUpperCase();
    if (code && !metricsByCode.has(code)) metricsByCode.set(code, { ...metric, year: ranking.year, value_txt: ranking.value_txt, value_int: ranking.value_int, value_float: ranking.value_float });
  }
  const metrics = [...metricsByCode.values()];
  const findMetric = (...codes) => metrics.find(metric => codes.includes(metric.code));
  const getValue = metric => !metric ? null : metric.value_float != null ? number(metric.value_float) : metric.value_int != null ? number(metric.value_int) : metric.value_txt ?? null;
  const sjr = findMetric('SJR'); const hIndex = findMetric('H_INDEX', 'H-INDEX', 'HINDEX'); const citeScore = findMetric('CITE_SCORE', 'CITESCORE', 'CITE SCORE');
  const quartile = metrics.find(metric => metric.metric_type === 'QUARTILE' && metric.value_txt);
  const coverage = journal.coverage ?? null;
  const establishedYear = String(coverage || '').match(/([0-9]{4})/)?.[1];
  const data = {
    journal_id: journalId, source_id: journal.source_id ?? null, display_name: journal.display_name ?? null, issn: journal.issn ?? null,
    type: journal.type ?? null, coverage, description: coverage, is_open_access: journal.is_open_access ?? null, is_oa_diamond: journal.is_oa_diamond ?? null,
    publisher_id: publisher ? String(publisher.publisher_id || publisher.id) : null, publisher_name: publisher?.display_name ?? null, publisher_image_url: publisher?.image_url ?? null,
    country_id: country ? String(country.zone_id || country.id) : null, country_name: country?.name ?? null, country_code: country?.code ?? null, country_iso_code: country?.iso_code ?? null,
    region_id: region ? String(region.zone_id || region.id) : null, region_name: region?.name ?? null, region_code: region?.code ?? null,
    established_year: establishedYear ? Number(establishedYear) : null, subject_categories: subjectCategories,
    quartile: quartile?.value_txt || null, metric_value: getValue(sjr), metric_name: sjr?.display_name || 'SJR Score', metric_year: sjr?.year ? String(sjr.year) : null,
    h_index: getValue(hIndex), cite_score: getValue(citeScore), latest_metrics: { year: sjr?.year || hIndex?.year || citeScore?.year || quartile?.year || null, sjr: getValue(sjr), h_index: getValue(hIndex), cite_score: getValue(citeScore), quartile: quartile?.value_txt || null },
  };
  return { success: true, message: 'LÃ¡ÂºÂ¥y journal thÃƒÂ nh cÃƒÂ´ng', data };
}

async function taxonomyDetail(ctx, name, idValue, row) {
  const notFoundCode = name === 'topics' ? 'TOPIC_NOT_FOUND' : name === 'subjectAreas' ? 'SUBJECT_AREA_NOT_FOUND' : 'SUBJECT_CATEGORY_NOT_FOUND';
  if (row.is_deleted !== false) throw new HttpError(404, `${entityLabel(name)} not found`, notFoundCode);
  if (name === 'subjectAreas') return { success: true, message: 'Láº¥y chi tiáº¿t subject area thÃ nh cÃ´ng', code: 'GET_SUBJECT_AREA_SUCCESS', data: { subject_area_id: String(row.subject_area_id || row.id), display_name: row.display_name ?? null, description: row.description ?? null, is_deleted: row.is_deleted } };
  const [areas, categories] = await Promise.all([all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories')]);
  if (name === 'subjectCategories') {
    const area = areas.find(item => String(item.subject_area_id || item.id) === String(row.subject_area_id));
    return { success: true, message: 'Láº¥y chi tiáº¿t subject category thÃ nh cÃ´ng', code: 'GET_SUBJECT_CATEGORY_SUCCESS', data: { subject_category_id: String(row.subject_category_id || row.id), subject_area_id: String(row.subject_area_id), display_name: row.display_name ?? null, description: row.description ?? null, is_deleted: row.is_deleted, subject_area_name: area?.display_name ?? null } };
  }
  const area = areas.find(item => String(item.subject_area_id || item.id) === String(row.subject_area_id));
  const category = categories.find(item => String(item.subject_category_id || item.id) === String(row.subject_category_id));
  return { success: true, message: 'Láº¥y chi tiáº¿t Topic thÃ nh cÃ´ng', code: 'GET_TOPIC_SUCCESS', data: { topic_id: String(row.topic_id || idValue), display_name: row.display_name ?? null, score: row.score ?? null, subject_area_id: row.subject_area_id == null ? null : String(row.subject_area_id), subject_category_id: row.subject_category_id == null ? null : String(row.subject_category_id), is_deleted: row.is_deleted, subject_area_name: area?.display_name ?? null, subject_category_name: category?.display_name ?? null } };
}

async function getEntity(ctx, entity) {
  const openAlexKinds = new Set(['articles', 'authors', 'publishers', 'journals', 'keywords', 'subjectAreas', 'subjectCategories', 'topics']);
  const openAlexRow = openAlexKinds.has(entity.name) ? await getOpenAlexEntity(ctx, entity.name) : null;
  if (openAlexRow) {
    if (entity.name === 'articles') return { success: true, code: 'ARTICLE_GET_SUCCESS', message: 'LÃ¡ÂºÂ¥y thÃƒÂ´ng tin bÃƒÂ i bÃƒÂ¡o thÃƒÂ nh cÃƒÂ´ng!', data: { ...openAlexRow, keywords: openAlexRow.keyword_objects || [] } };
    if (entity.name === 'authors') return { success: true, code: 'AUTHOR_FETCHED', message: 'LÃ¡ÂºÂ¥y thÃƒÂ´ng tin tÃƒÂ¡c giÃ¡ÂºÂ£ thÃƒÂ nh cÃƒÂ´ng', data: authorProjection(openAlexRow) };
    if (entity.name === 'publishers') return { success: true, message: 'LÃ¡ÂºÂ¥y thÃƒÂ´ng tin nhÃƒÂ  xuÃ¡ÂºÂ¥t bÃ¡ÂºÂ£n thÃƒÂ nh cÃƒÂ´ng', data: publisherProjection(openAlexRow) };
    if (entity.name === 'keywords') return { success: true, code: 'KEYWORD_FETCHED', message: 'LÃ¡ÂºÂ¥y keyword thÃƒÂ nh cÃƒÂ´ng', data: { keyword_id: String(openAlexRow.keyword_id), display_name: openAlexRow.display_name } };
    if (entity.name === 'journals') {
      const enriched = await journalList({ ...ctx, query: { page: 1, limit: 1 } }, [openAlexRow]);
      const localJournal = enriched.data.items[0] || {};
      return { success: true, message: 'Fetched journal from OpenAlex', data: {
        ...localJournal,
        ...openAlexRow,
        display_name: openAlexRow.display_name || localJournal.display_name,
        issn: openAlexRow.issn || localJournal.issn,
        eissn: openAlexRow.eissn || localJournal.eissn,
        publisher_name: openAlexRow.publisher_name || localJournal.publisher_name,
        country_name: localJournal.country_name || openAlexRow.country_name || openAlexRow.country,
        region_name: localJournal.region_name || openAlexRow.region_name,
        subject_area_name: localJournal.subject_area_name || openAlexRow.subject_area_name,
        coverage: localJournal.coverage || openAlexRow.coverage,
        metric_value: localJournal.metric_value ?? null, metric_year: localJournal.metric_year ?? null,
        quartile: localJournal.quartile ?? null, best_quartile: localJournal.best_quartile ?? null,
        quartile_year: localJournal.quartile_year ?? null, volume_count: localJournal.volume_count ?? 0,
      } };
    }
    if (entity.name === 'topics') return { success: true, code: 'GET_TOPIC_SUCCESS', message: 'LÃ¡ÂºÂ¥y chi tiÃ¡ÂºÂ¿t Topic thÃƒÂ nh cÃƒÂ´ng', data: openAlexRow };
    if (entity.name === 'subjectAreas') return { success: true, code: 'GET_SUBJECT_AREA_SUCCESS', message: 'Fetched subject area from OpenAlex', data: openAlexRow };
    if (entity.name === 'subjectCategories') return { success: true, code: 'GET_SUBJECT_CATEGORY_SUCCESS', message: 'Fetched subject category from OpenAlex', data: openAlexRow };
  }
  if (openAlexKinds.has(entity.name)) throw new HttpError(404, `${entity.name} not found`, entity.name === 'articles' ? 'ARTICLE_NOT_FOUND' : entity.name === 'keywords' ? 'KEYWORD_NOT_FOUND' : entity.name === 'authors' ? 'AUTHOR_NOT_FOUND' : 'NOT_FOUND');
  if (['volumes', 'issues'].includes(entity.name)) return getOpenAlexVolumeIssue(ctx, entity.name);
  let row = await byId(ctx.db, entity.name, ctx.params.id);
  if (!row) throw new HttpError(404, `${entity.name} not found`, entity.name === 'articles' ? 'ARTICLE_NOT_FOUND' : entity.name === 'keywords' ? 'KEYWORD_NOT_FOUND' : entity.name === 'authors' ? 'AUTHOR_NOT_FOUND' : 'NOT_FOUND');
  if (entity.name === 'journals') return journalDetail(ctx, ctx.params.id);
  if (entity.name === 'authors') return { success: true, code: 'AUTHOR_FETCHED', message: 'Láº¥y thÃ´ng tin tÃ¡c giáº£ thÃ nh cÃ´ng', data: authorProjection(row) };
  if (entity.name === 'publishers') {
    if (row.is_deleted !== false) throw new HttpError(404, 'KhÃ´ng tÃ¬m tháº¥y nhÃ  xuáº¥t báº£n', 'NOT_FOUND');
    return { success: true, message: 'Láº¥y thÃ´ng tin nhÃ  xuáº¥t báº£n thÃ nh cÃ´ng', data: publisherProjection(row) };
  }
  if (entity.name === 'keywords') return { success: true, code: 'KEYWORD_FETCHED', message: 'Láº¥y keyword thÃ nh cÃ´ng', data: { keyword_id: String(row.keyword_id ?? row.id), display_name: row.display_name || row.name || row.keyword } };
  if (entity.name === 'volumes') {
    if (row.is_deleted !== false) throw new HttpError(404, 'Volume not found', 'VOLUME_NOT_FOUND');
    return { success: true, code: 'GET_VOLUME_DETAIL_SUCCESS', message: 'Volume details fetched successfully', data: volumeIssueProjection(row, 'volumes') };
  }
  if (entity.name === 'issues') {
    if (row.is_deleted !== false) throw new HttpError(404, 'Issue not found', 'ISSUE_NOT_FOUND');
    const volume = await byId(ctx.db, 'volumes', row.volume_id);
    if (!volume) throw new HttpError(404, 'Issue not found', 'ISSUE_NOT_FOUND');
    return { success: true, code: 'GET_ISSUE_DETAIL_SUCCESS', message: 'Issue details fetched successfully', data: { ...volumeIssueProjection(row, 'issues'), journal_id: String(volume.journal_id), volume_number: volume.volume_number } };
  }
  if (['subjectAreas', 'subjectCategories', 'topics'].includes(entity.name)) return taxonomyDetail(ctx, entity.name, ctx.params.id, row);
  if (isDeleted(row)) throw new HttpError(entity.name === 'articles' ? 410 : 404, `${entity.name} is deleted`, entity.name === 'articles' ? 'ARTICLE_DELETED' : 'NOT_FOUND');
  if (entity.name === 'articles') {
    row = (await hydrateArticles(ctx.db, [row]))[0];
    row = { ...row, keywords: row.keyword_objects || [] };
    return { success: true, code: 'ARTICLE_GET_SUCCESS', message: 'Láº¥y thÃ´ng tin bÃ i bÃ¡o thÃ nh cÃ´ng!', data: row };
  }
  if (entity.name === 'volumes') return { success: true, code: 'GET_VOLUME_DETAIL_SUCCESS', message: 'Láº¥y chi tiáº¿t volume thÃ nh cÃ´ng', data: row };
  if (entity.name === 'issues') return { success: true, code: 'GET_ISSUE_DETAIL_SUCCESS', message: 'Láº¥y chi tiáº¿t Issue thÃ nh cÃ´ng', data: row };
  if (entity.name === 'authors') return { success: true, code: 'AUTHOR_FETCHED', message: 'Láº¥y thÃ´ng tin tÃ¡c giáº£ thÃ nh cÃ´ng', data: row };
  if (entity.name === 'keywords') return { success: true, code: 'KEYWORD_FETCHED', message: 'Láº¥y keyword thÃ nh cÃ´ng', data: row };
  if (entity.name === 'topics') return { success: true, code: 'GET_TOPIC_SUCCESS', message: 'Láº¥y chi tiáº¿t Topic thÃ nh cÃ´ng', data: row };
  if (entity.name === 'subjectAreas') return { success: true, code: 'GET_SUBJECT_AREA_SUCCESS', message: 'Láº¥y chi tiáº¿t subject area thÃ nh cÃ´ng', data: row };
  if (entity.name === 'subjectCategories') return { success: true, code: 'GET_SUBJECT_CATEGORY_SUCCESS', message: 'Láº¥y chi tiáº¿t subject category thÃ nh cÃ´ng', data: row };
  return ok(row, `Fetch ${entity.name} detail successfully`, entityCode(entity.name, 'GET'));
}

async function createArticle(ctx) {
  const { title, publication_year, version, issue_id, abstract, doi, primary_topic, sub_topic, authors, keywords } = ctx.body;
  if (!title || publication_year === undefined) throw new HttpError(400, 'title and publication_year are required', 'VALIDATION_ERROR');
  const authorIds = normalizeAuthorIds(authors || []);
  await validateAuthorIds(ctx.db, authorIds);
  let resolvedPrimaryTopic = Number(primary_topic) === 0 ? null : primary_topic ?? null;
  if (resolvedPrimaryTopic != null) {
    const topics = await all(ctx.db, 'topics');
    const requestedTopic = topics.find(row => String(row.topic_id || row.id) === String(resolvedPrimaryTopic));
    if (requestedTopic) resolvedPrimaryTopic = requestedTopic.topic_id || requestedTopic.id;
    else {
      const categoryTopic = topics.find(row => String(row.subject_category_id || '') === String(resolvedPrimaryTopic));
      resolvedPrimaryTopic = categoryTopic?.topic_id || categoryTopic?.id || topics[0]?.topic_id || topics[0]?.id || null;
    }
  }
  const articleId = await allocateNumericRecordId(ctx.db, 'articles', 'article_id');
  const article = await save(ctx.db, 'articles', articleId, { article_id: Number(articleId), title, publication_year, version, issue_id, abstract, doi, primary_topic: resolvedPrimaryTopic, status: ctx.body.status || 'ACTIVE', created_by: ctx.user.user_id }, { create: true });
  await replaceArticleLinks(ctx.db, articleId, { authors: authorIds, topics: sub_topic || [], keywords: keywords || [], primaryTopic: article.primary_topic });
  return { body: { success: true, code: 'ARTICLE_CREATE_SUCCESS', message: 'BÃ i bÃ¡o Ä‘Ã£ Ä‘Æ°á»£c táº¡o thÃ nh cÃ´ng!', data: await hydrateArticles(ctx.db, [article]).then(rows => rows[0]) }, status: 201 };
}

async function updateArticle(ctx) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid article ID', 'VALIDATION_ERROR');
  const row = requireFound(await byId(ctx.db, 'articles', ctx.params.id), 'Article not found');
  const patch = Object.fromEntries(['title', 'publication_year', 'version', 'issue_id', 'abstract', 'doi', 'primary_topic']
    .filter(key => ctx.body[key] !== undefined).map(key => [key, ctx.body[key]]));
  delete patch.authors; delete patch.sub_topic; delete patch.keywords;
  if (patch.title !== undefined) {
    patch.title = String(patch.title).trim();
    if (!patch.title) throw new HttpError(400, 'title cannot be empty', 'VALIDATION_ERROR');
  }
  if (patch.publication_year !== undefined) {
    patch.publication_year = Number(patch.publication_year);
    if (!Number.isFinite(patch.publication_year) || patch.publication_year <= 0) throw new HttpError(400, 'publication_year must be a positive number', 'VALIDATION_ERROR');
  }
  if (patch.issue_id !== undefined) {
    if (String(row.issue_id) === String(patch.issue_id)) throw new HttpError(400, 'Cannot update to the same issue_id', 'VALIDATION_ERROR');
    if (!await byId(ctx.db, 'issues', patch.issue_id)) throw new HttpError(400, 'Issue ID does not exist', 'VALIDATION_ERROR');
  }
  if (patch.primary_topic !== undefined) {
    if (Number(patch.primary_topic) === 0) patch.primary_topic = null;
    else {
      if (String(row.primary_topic) === String(patch.primary_topic)) throw new HttpError(400, 'Cannot update to the same primary_topic', 'VALIDATION_ERROR');
      if (!await byId(ctx.db, 'topics', patch.primary_topic)) throw new HttpError(400, 'Primary topic does not exist', 'VALIDATION_ERROR');
    }
  }
  const authors = ctx.body.authors === undefined ? undefined : normalizeAuthorIds(ctx.body.authors);
  if (authors !== undefined) await validateAuthorIds(ctx.db, authors);
  const article = await save(ctx.db, 'articles', row.id || ctx.params.id, { ...patch, article_id: row.article_id || row.id });
  if (authors !== undefined) await replaceLinks(ctx.db, 'author_articles', 'author_id', article.article_id, authors);
  if (ctx.body.sub_topic !== undefined) await replaceLinks(ctx.db, 'sub_topics', 'topic_id', article.article_id, normalizeIds(ctx.body.sub_topic).filter(topicId => String(topicId) !== String(article.primary_topic || '')));
  if (ctx.body.keywords !== undefined) await replaceKeywordLinks(ctx.db, article.article_id, normalizeKeywords(ctx.body.keywords));
  const hydrated = (await hydrateArticles(ctx.db, [article]))[0];
  return ok(hydrated, 'Article updated successfully', 'ARTICLE_UPDATE_SUCCESS');
}

async function deleteArticle(ctx) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid article ID', 'VALIDATION_ERROR');
  await deleteSoft(ctx.db, 'articles', ctx.params.id, { is_deleted: true, deleted_by: ctx.user.user_id });
  return ok(undefined, 'Article Ä‘Ã£ xÃ³a thÃ nh cÃ´ng', 'ARTICLE_DELETE_SUCCESS');
}

async function restoreArticle(ctx) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid article ID', 'VALIDATION_ERROR');
  const row = requireFound(await byId(ctx.db, 'articles', ctx.params.id), 'Article not found');
  if (row.is_deleted !== true) throw new HttpError(404, 'Article not found or already restored', 'ARTICLE_NOT_FOUND');
  const article = { ...row, is_deleted: false, deleted_at: null, updated_at: nowIso() };
  await ctx.db.set(collectionFor('articles'), row.id || ctx.params.id, article);
  return ok(article, 'Article Ä‘Ã£ khÃ´i phá»¥c thÃ nh cÃ´ng', 'ARTICLE_RESTORE_SUCCESS');
}

const entityIdField = name => ({ authors: 'author_id', publishers: 'publisher_id', journals: 'journal_id', keywords: 'keyword_id', subjectAreas: 'subject_area_id', subjectCategories: 'subject_category_id', topics: 'topic_id', volumes: 'volume_id', issues: 'issue_id' })[name] || 'id';
const entityLabel = name => ({ authors: 'Author', publishers: 'Publisher', journals: 'Journal', keywords: 'Keyword', subjectAreas: 'Subject Area', subjectCategories: 'Subject Category', topics: 'Topic', volumes: 'Volume', issues: 'Issue' })[name] || name;
const entityCode = (name, action) => `${entityLabel(name).toUpperCase().replaceAll(' ', '_')}_${action}_SUCCESS`;

async function createEntity(ctx, entity) {
  const keyField = entityIdField(entity.name);
  const numericIdEntity = ['subjectAreas', 'subjectCategories', 'topics'].includes(entity.name);
  const display = numericIdEntity ? ctx.body.display_name : field(ctx.body, 'display_name', 'name', 'title');
  if (numericIdEntity ? typeof display !== 'string' : !display) throw new HttpError(400, `${entityLabel(entity.name)} name is required`, 'VALIDATION_ERROR');
  const displayName = ['subjectAreas', 'subjectCategories', 'topics'].includes(entity.name) ? String(display).trim() : display;
  if (['subjectAreas', 'subjectCategories'].includes(entity.name) && ctx.body.description !== undefined && typeof ctx.body.description !== 'string') throw new HttpError(400, 'description must be a string', 'VALIDATION_ERROR');
  if (entity.name === 'topics') {
    if (!displayName) throw new HttpError(400, 'display_name is required and must not be empty', 'INVALID_TOPIC_DATA');
    if (ctx.body.score !== undefined && (typeof ctx.body.score !== 'number' || ctx.body.score < 0 || ctx.body.score > 1)) throw new HttpError(400, 'score must be between 0 and 1', 'INVALID_TOPIC_DATA');
    const [topics, areas, categories] = await Promise.all([all(ctx.db, 'topics'), all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories')]);
    if (topics.some(row => row.is_deleted === false && String(row.display_name || '').trim() === displayName)) throw new HttpError(409, 'Topic name already exists', 'TOPIC_NAME_DUPLICATED');
    if (ctx.body.subject_area_id != null && !areas.some(row => String(row.subject_area_id || row.id) === String(ctx.body.subject_area_id))) throw new HttpError(400, 'subject_area_id does not exist', 'INVALID_TOPIC_DATA');
    if (ctx.body.subject_category_id != null && !categories.some(row => String(row.subject_category_id || row.id) === String(ctx.body.subject_category_id))) throw new HttpError(400, 'subject_category_id does not exist', 'INVALID_TOPIC_DATA');
  }
  if (entity.name === 'subjectCategories' && (!/^\d+$/.test(String(ctx.body.subject_area_id ?? '')) || !(await all(ctx.db, 'subjectAreas')).some(row => String(row.subject_area_id || row.id) === String(ctx.body.subject_area_id)))) throw new HttpError(400, 'subject_area_id does not exist', 'VALIDATION_ERROR');
  const key = String(numericIdEntity ? await allocateNumericRecordId(ctx.db, entity.name, keyField) : ctx.body[keyField] || ctx.body.id || id());
  const row = { ...ctx.body, display_name: displayName, ...(entity.name === 'subjectAreas' || entity.name === 'subjectCategories' ? { description: ctx.body.description ? String(ctx.body.description).trim() : null } : {}), ...(entity.name === 'topics' && ctx.body.score === undefined ? { score: 0 } : {}), id: key, [keyField]: numericIdEntity ? Number(key) : (ctx.body[keyField] || key), is_deleted: false, created_at: nowIso() };
  await ctx.db.create(collectionFor(entity.name), key, row);
  const responseData = entity.name === 'subjectAreas'
    ? { subject_area_id: key, display_name: row.display_name, description: row.description, is_deleted: false }
    : entity.name === 'subjectCategories'
      ? { subject_category_id: key, subject_area_id: String(row.subject_area_id), display_name: row.display_name, description: row.description, is_deleted: false }
      : entity.name === 'topics'
        ? { topic_id: key, display_name: row.display_name, score: row.score, subject_area_id: row.subject_area_id == null ? null : String(row.subject_area_id), subject_category_id: row.subject_category_id == null ? null : String(row.subject_category_id), is_deleted: false }
        : row;
  const code = entity.name === 'topics' ? 'TOPIC_CREATED' : entity.name === 'subjectAreas' ? 'CREATE_SUBJECT_AREA_SUCCESS' : entity.name === 'subjectCategories' ? 'CREATE_SUBJECT_CATEGORY_SUCCESS' : entityCode(entity.name, 'CREATE');
  return { body: { success: true, code, message: `${entityLabel(entity.name)} created successfully`, data: responseData }, status: 201 };
}

async function allocateNumericRecordId(db, name, fieldName) {
  const rows = await all(db, name);
  for (let attempt = 0; attempt < 32; attempt++) {
    const random = new Uint16Array(1);
    crypto.getRandomValues(random);
    const candidate = String(Date.now() * 1000 + random[0] % 1000);
    if (!rows.some(row => String(row[fieldName] || row.id) === candidate)) return candidate;
  }
  throw new HttpError(503, `Unable to allocate ${entityLabel(name)} ID`, 'ID_ALLOCATION_FAILED');
}

async function updateEntity(ctx, entity) {
  const row = requireFound(await byId(ctx.db, entity.name, ctx.params.id), `${entityLabel(entity.name)} not found`);
  if (isDeleted(row)) throw new HttpError(400, `${entityLabel(entity.name)} is deleted`, 'RESOURCE_DELETED');
  const key = row.id || ctx.params.id;
  const patch = { ...ctx.body };
  delete patch.id; delete patch[entityIdField(entity.name)]; delete patch.created_at; delete patch.is_deleted; delete patch.deleted_at;
  const updated = { ...row, ...patch, updated_at: nowIso() };
  await ctx.db.set(collectionFor(entity.name), key, updated);
  return ok(updated, `${entityLabel(entity.name)} updated successfully`, entityCode(entity.name, 'UPDATE'));
}

async function updateTopicRecord(ctx) {
  const row = await byId(ctx.db, 'topics', ctx.params.id);
  if (!row) throw new HttpError(404, 'Topic does not exist', 'TOPIC_NOT_FOUND');
  if (row.is_deleted === true) throw new HttpError(400, 'Cannot update a deleted topic', 'TOPIC_DELETED');
  const body = ctx.body || {};
  if (body.display_name !== undefined && (typeof body.display_name !== 'string' || !body.display_name.trim())) throw new HttpError(400, 'display_name must not be empty', 'INVALID_TOPIC_DATA');
  if (body.score !== undefined && (typeof body.score !== 'number' || body.score < 0 || body.score > 1)) throw new HttpError(400, 'score must be between 0 and 1', 'INVALID_TOPIC_DATA');
  const [areas, categories] = await Promise.all([all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories')]);
  if (body.subject_area_id !== undefined && !areas.some(item => String(item.subject_area_id || item.id) === String(body.subject_area_id))) throw new HttpError(400, 'subject_area_id does not exist', 'INVALID_TOPIC_DATA');
  if (body.subject_category_id !== undefined && !categories.some(item => String(item.subject_category_id || item.id) === String(body.subject_category_id))) throw new HttpError(400, 'subject_category_id does not exist', 'INVALID_TOPIC_DATA');
  const patch = Object.fromEntries(['display_name', 'score', 'subject_area_id', 'subject_category_id'].filter(key => body[key] !== undefined).map(key => [key, key === 'display_name' ? body[key].trim() : body[key]]));
  if (!Object.keys(patch).length) throw new HttpError(400, 'No valid fields to update', 'NO_DATA_UPDATED');
  const updated = { ...row, ...patch };
  await ctx.db.set('topics', row.id || String(ctx.params.id), updated);
  return { success: true, code: 'TOPIC_UPDATED', message: 'Topic updated successfully', data: updated };
}

async function updateTaxonomyRecord(ctx, name) {
  const row = await byId(ctx.db, name, ctx.params.id);
  const keyField = entityIdField(name);
  const allowed = name === 'subjectAreas' ? ['display_name', 'description'] : ['subject_area_id', 'display_name', 'description'];
  if (['display_name', 'description'].some(key => ctx.body?.[key] !== undefined && typeof ctx.body[key] !== 'string')) throw new HttpError(400, 'Invalid taxonomy fields', 'VALIDATION_ERROR');
  if (name === 'subjectCategories' && ctx.body?.subject_area_id !== undefined && !/^\d+$/.test(String(ctx.body.subject_area_id))) throw new HttpError(400, 'Invalid subject_area_id', 'VALIDATION_ERROR');
  const patch = Object.fromEntries(allowed.filter(key => ctx.body?.[key] !== undefined).map(key => [key, typeof ctx.body[key] === 'string' ? ctx.body[key].trim() : key === 'subject_area_id' ? firestoreDbId(ctx.body[key]) : ctx.body[key]]));
  if (!row || row.is_deleted !== false || !Object.keys(patch).length) return { success: true, message: `${entityLabel(name)} updated successfully`, code: name === 'subjectAreas' ? 'UPDATE_SUBJECT_AREA_SUCCESS' : 'UPDATE_SUBJECT_CATEGORY_SUCCESS', data: null };
  const updated = { ...row, ...patch };
  await ctx.db.set(collectionFor(name), row.id || String(ctx.params.id), updated);
  const data = name === 'subjectAreas'
    ? { subject_area_id: String(updated[keyField] || updated.id), display_name: updated.display_name, description: updated.description ?? null, is_deleted: updated.is_deleted }
    : { subject_category_id: String(updated[keyField] || updated.id), subject_area_id: String(updated.subject_area_id), display_name: updated.display_name, description: updated.description ?? null, is_deleted: updated.is_deleted };
  return { success: true, message: `${entityLabel(name)} updated successfully`, code: name === 'subjectAreas' ? 'UPDATE_SUBJECT_AREA_SUCCESS' : 'UPDATE_SUBJECT_CATEGORY_SUCCESS', data };
}

async function deleteTaxonomyRecord(ctx, name) {
  const row = await byId(ctx.db, name, ctx.params.id);
  const codeName = name === 'subjectAreas' ? 'SUBJECT_AREA' : 'SUBJECT_CATEGORY';
  if (!row) throw new HttpError(404, `${entityLabel(name)} not found`, `${codeName}_NOT_FOUND`);
  if (row.is_deleted === true) throw new HttpError(400, `${entityLabel(name)} already deleted`, `${codeName}_ALREADY_DELETED`);
  const deleted = { ...row, is_deleted: true };
  await ctx.db.set(collectionFor(name), row.id || String(ctx.params.id), deleted);
  const data = name === 'subjectAreas'
    ? { subject_area_id: String(deleted.subject_area_id || deleted.id), display_name: deleted.display_name, description: deleted.description ?? null, is_deleted: true }
    : { subject_category_id: String(deleted.subject_category_id || deleted.id), subject_area_id: String(deleted.subject_area_id), display_name: deleted.display_name, description: deleted.description ?? null, is_deleted: true };
  return { success: true, message: `${entityLabel(name)} deleted successfully`, code: `DELETE_${codeName}_SUCCESS`, data };
}

async function restoreTaxonomyRecord(ctx, name) {
  const row = await byId(ctx.db, name, ctx.params.id);
  const codeName = name === 'subjectAreas' ? 'SUBJECT_AREA' : 'SUBJECT_CATEGORY';
  if (!row) throw new HttpError(404, `${entityLabel(name)} not found`, `${codeName}_NOT_FOUND`);
  if (row.is_deleted !== true) throw new HttpError(400, `${entityLabel(name)} is not deleted`, `${codeName}_NOT_DELETED`);
  const restored = { ...row, is_deleted: false };
  await ctx.db.set(collectionFor(name), row.id || String(ctx.params.id), restored);
  const data = name === 'subjectAreas'
    ? { subject_area_id: String(restored.subject_area_id || restored.id), display_name: restored.display_name, description: restored.description ?? null, is_deleted: false }
    : { subject_category_id: String(restored.subject_category_id || restored.id), subject_area_id: String(restored.subject_area_id), display_name: restored.display_name, description: restored.description ?? null, is_deleted: false };
  return { success: true, message: `${entityLabel(name)} restored successfully`, code: `RESTORE_${codeName}_SUCCESS`, data };
}

async function deleteTopicRecord(ctx) {
  const row = await byId(ctx.db, 'topics', ctx.params.id);
  if (!row) throw new HttpError(404, 'Topic does not exist', 'TOPIC_NOT_FOUND');
  if (row.is_deleted === true) throw new HttpError(400, 'Topic already deleted', 'TOPIC_ALREADY_DELETED');
  const deleted = { ...row, is_deleted: true };
  await ctx.db.set('topics', row.id || String(ctx.params.id), deleted);
  return { success: true, code: 'TOPIC_DELETED', message: 'Topic deleted successfully', data: deleted };
}

async function restoreTopicRecord(ctx) {
  const row = await byId(ctx.db, 'topics', ctx.params.id);
  if (!row) throw new HttpError(404, 'Topic does not exist', 'TOPIC_NOT_FOUND');
  if (row.is_deleted !== true) throw new HttpError(400, 'Topic is not deleted', 'TOPIC_NOT_DELETED');
  const restored = { ...row, is_deleted: false };
  await ctx.db.set('topics', row.id || String(ctx.params.id), restored);
  return { success: true, code: 'TOPIC_RESTORED', message: 'Topic restored successfully', data: restored };
}

async function deleteEntity(ctx, entity) {
  const row = requireFound(await byId(ctx.db, entity.name, ctx.params.id), `${entityLabel(entity.name)} not found`);
  if (isDeleted(row)) throw new HttpError(400, `${entityLabel(entity.name)} is already deleted`, 'RESOURCE_ALREADY_DELETED');
  const updated = { ...row, is_deleted: true, deleted_at: nowIso(), updated_at: nowIso() };
  await ctx.db.set(collectionFor(entity.name), row.id || ctx.params.id, updated);
  return ok(undefined, `${entityLabel(entity.name)} deleted successfully`, entityCode(entity.name, 'DELETE'));
}

async function restoreEntity(ctx, entity) {
  const row = requireFound(await byId(ctx.db, entity.name, ctx.params.id), `${entityLabel(entity.name)} not found`);
  const updated = { ...row, is_deleted: false, deleted_at: null, updated_at: nowIso() };
  if (String(updated.status || '').toUpperCase() === 'DELETED') updated.status = 'ACTIVE';
  await ctx.db.set(collectionFor(entity.name), row.id || ctx.params.id, updated);
  return ok(updated, `${entityLabel(entity.name)} restored successfully`, entityCode(entity.name, 'RESTORE'));
}

const validJournalId = value => /^\d+$/.test(String(value ?? '')) && BigInt(String(value)) > 0n;
const firestoreDbId = value => Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
function validateJournalInput(body, creating = false) {
  if (creating && (typeof body.display_name !== 'string' || body.display_name.length < 1 || !['publisher_id', 'country', 'region'].every(key => Number.isInteger(body[key]) && body[key] > 0))) throw new HttpError(400, 'display_name, publisher_id, country and region are required', 'VALIDATION_ERROR');
  for (const key of ['publisher_id', 'country', 'region']) if (body[key] !== undefined && (!Number.isInteger(body[key]) || body[key] < 1)) throw new HttpError(400, `${key} must be a positive integer`, 'VALIDATION_ERROR');
  for (const key of ['display_name', 'type']) if (body[key] !== undefined && (typeof body[key] !== 'string' || (key === 'display_name' && body[key].length < 1))) throw new HttpError(400, `Invalid ${key}`, 'VALIDATION_ERROR');
  if (body.source_id !== undefined && body.source_id !== null && typeof body.source_id !== 'string') throw new HttpError(400, 'Invalid source_id', 'VALIDATION_ERROR');
  for (const key of ['is_open_access', 'is_oa_diamond']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new HttpError(400, `Invalid ${key}`, 'VALIDATION_ERROR');
  for (const key of ['coverage', 'scope_detail', 'description']) if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') throw new HttpError(400, `Invalid ${key}`, 'VALIDATION_ERROR');
  if (body.issn !== undefined && body.issn !== null && typeof body.issn !== 'string' && !(Array.isArray(body.issn) && body.issn.every(item => typeof item === 'string'))) throw new HttpError(400, 'Invalid issn', 'VALIDATION_ERROR');
}
async function createJournalRecord(ctx) {
  const body = ctx.body || {};
  validateJournalInput(body, true);
  const journals = await all(ctx.db, 'journals');
  let key;
  for (let attempt = 0; attempt < 32; attempt++) {
    const random = new Uint16Array(1);
    crypto.getRandomValues(random);
    const candidate = String(Date.now() * 1000 + random[0] % 1000);
    if (!journals.some(item => String(item.journal_id || item.id) === candidate)) { key = candidate; break; }
  }
  if (!key) throw new HttpError(503, 'Unable to allocate a journal ID', 'JOURNAL_ID_ALLOCATION_FAILED');
  const row = { id: key, journal_id: Number(key), source_id: body.source_id || null, publisher_id: firestoreDbId(body.publisher_id), country: firestoreDbId(body.country), region: firestoreDbId(body.region), display_name: body.display_name, type: body.type || 'Journal', is_open_access: body.is_open_access ?? false, is_oa_diamond: body.is_oa_diamond ?? false, coverage: body.coverage || body.scope_detail || body.description || null, issn: body.issn || null, is_deleted: false, created_at: nowIso() };
  await ctx.db.create('journals', key, row);
  return { body: { success: true, code: 'JOURNAL_CREATED', message: 'Journal created successfully', data: row }, status: 201 };
}
async function updateJournalRecord(ctx) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid journal ID', 'VALIDATION_ERROR');
  const row = await byId(ctx.db, 'journals', ctx.params.id);
  if (!row || row.is_deleted !== false) throw new HttpError(404, 'Journal not found', 'JOURNAL_NOT_FOUND');
  const body = { ...ctx.body };
  validateJournalInput(body);
  if (body.coverage === undefined) body.coverage = body.scope_detail ?? body.description;
  const fields = ['source_id', 'publisher_id', 'country', 'region', 'display_name', 'type', 'is_open_access', 'is_oa_diamond', 'coverage', 'issn'];
  const patch = Object.fromEntries(fields.filter(key => body[key] !== undefined && body[key] !== null).map(key => [key, ['publisher_id', 'country', 'region'].includes(key) ? firestoreDbId(body[key]) : body[key]]));
  if (!Object.keys(patch).length) throw new HttpError(404, 'Journal not found', 'JOURNAL_NOT_FOUND');
  const updated = { ...row, ...patch };
  await ctx.db.set('journals', row.id || String(ctx.params.id), updated);
  return ok(updated, 'Journal updated successfully', 'JOURNAL_UPDATED');
}
async function deleteJournalRecord(ctx) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid journal ID', 'VALIDATION_ERROR');
  const row = await byId(ctx.db, 'journals', ctx.params.id);
  if (!row || row.is_deleted !== false) throw new HttpError(404, 'Journal not found', 'JOURNAL_NOT_FOUND');
  const deleted = { ...row, is_deleted: true };
  await ctx.db.set('journals', row.id || String(ctx.params.id), deleted);
  return ok(deleted, 'Journal deleted successfully', 'JOURNAL_DELETED');
}
async function restoreJournalRecord(ctx) {
  if (!validJournalId(ctx.params.id)) throw new HttpError(400, 'Invalid journal ID', 'VALIDATION_ERROR');
  const row = await byId(ctx.db, 'journals', ctx.params.id);
  if (!row || row.is_deleted !== true) throw new HttpError(404, 'Journal not found', 'JOURNAL_NOT_FOUND');
  const restored = { ...row, is_deleted: false };
  await ctx.db.set('journals', row.id || String(ctx.params.id), restored);
  return ok(restored, 'Journal restored successfully', 'JOURNAL_RESTORED');
}

async function filterOptions(ctx) {
  const currentYear = new Date().getFullYear();
  const fallbackYears = Array.from({ length: 16 }, (_, i) => currentYear - i);

  let years = fallbackYears;
  let journals = [];
  let topics = [];

  try {
    const [sourcesRes, topicsRes, yearsRes] = await Promise.all([
      openAlexRequest(ctx, 'sources', {
        per_page: 50,
        sort: 'works_count:desc',
        select: 'id,display_name,works_count',
      }),
      openAlexRequest(ctx, 'topics', {
        per_page: 50,
        sort: 'works_count:desc',
        select: 'id,display_name,works_count',
      }),
      openAlexRequest(ctx, 'works', {
        group_by: 'publication_year',
        per_page: 50,
      }).catch(() => null),
    ]);

    if (yearsRes?.group_by?.length) {
      const gYears = yearsRes.group_by
        .map(g => Number(g.key))
        .filter(y => Number.isInteger(y) && y >= 1990 && y <= currentYear + 1)
        .sort((a, b) => b - a);
      if (gYears.length) years = gYears;
    }

    if (sourcesRes?.results?.length) {
      journals = sourcesRes.results.map(s => {
        const rawId = String(s.id || '').replace(/^https?:\/\/openalex\.org\//i, '').replace(/\/+$/, '').split('/').pop();
        const numId = rawId?.match(/^[A-Z]*(\d+)$/i)?.[1] || rawId;
        return {
          journal_id: numId,
          display_name: s.display_name,
          article_count: Number(s.works_count || 0),
        };
      });
    }

    if (topicsRes?.results?.length) {
      topics = topicsRes.results.map(t => {
        const rawId = String(t.id || '').replace(/^https?:\/\/openalex\.org\//i, '').replace(/\/+$/, '').split('/').pop();
        const numId = rawId?.match(/^[A-Z]*(\d+)$/i)?.[1] || rawId;
        return {
          topic_id: numId,
          display_name: t.display_name,
          article_count: Number(t.works_count || 0),
        };
      });
    }
  } catch (error) {
    console.error('[openalex] filterOptions failed, falling back to defaults:', error?.message || error);
    try {
      const [localJournals, localTopics] = await Promise.all([
        ctx.db.list('journals', { pageSize: 50 }).catch(() => ({ documents: [] })),
        ctx.db.list('topics', { pageSize: 50 }).catch(() => ({ documents: [] })),
      ]);
      journals = (localJournals?.documents || []).map(j => ({
        journal_id: String(j.journal_id || j.id),
        display_name: j.display_name || j.name || null,
        article_count: Number(j.article_count || j.works_count || 0),
      })).filter(j => j.display_name);
      topics = (localTopics?.documents || []).map(t => ({
        topic_id: String(t.topic_id || t.id),
        display_name: t.display_name || t.name || null,
        article_count: Number(t.article_count || t.works_count || 0),
      })).filter(t => t.display_name);
    } catch { /* ignore fallback errors */ }
  }

  return {
    success: true,
    code: 'ARTICLE_FILTER_OPTIONS_SUCCESS',
    message: 'Láº¥y tÃ¹y chá»n bá»™ lá»c bÃ i bÃ¡o thÃ nh cÃ´ng!',
    data: {
      years,
      journals,
      topics,
    },
  };
}

const normalizeIds = values => (Array.isArray(values) ? values : []).map(item => String(item?.id || item?.topic_id || item)).filter(Boolean);
const normalizeAuthorIds = values => (Array.isArray(values) ? values : []).map(item => String(item?.author_id || item?.id || item)).filter(Boolean);
const normalizeKeywords = values => Array.isArray(values)
  ? values.map(item => ({ name: typeof item === 'string' ? item : item?.display_name || item?.name || item?.keyword, score: Number(item?.score || 0) })).filter(item => item.name)
  : Object.entries(values || {}).map(([name, score]) => ({ name, score: Number(score || 0) }));
async function validateAuthorIds(db, authorIds) {
  const authors = await all(db, 'authors');
  const missing = authorIds.filter(authorId => !authors.some(row => String(row.author_id || row.id) === authorId));
  if (missing.length) throw new HttpError(400, `Authors not found: ${missing.join(', ')}`, 'AUTHORS_NOT_FOUND');
}
async function replaceLinks(db, collection, foreignKey, articleId, values) {
  const prior = await find(db, collection, row => String(row.article_id) === String(articleId), { limit: Infinity });
  await db.batchDelete(collectionFor(collection), prior.map(row => row.id));
  const unique = [...new Set(values.map(String))];
  await db.batchSet(collectionFor(collection), unique.map(value => ({ id: id(), data: { article_id: String(articleId), [foreignKey]: value } })));
}
async function replaceKeywordLinks(db, articleId, names) {
  const prior = await find(db, 'keyword_articles', row => String(row.article_id) === String(articleId), { limit: Infinity });
  await db.batchDelete('keyword_articles', prior.map(row => row.id));
  const existing = await all(db, 'keywords');
  const docs = [];
  const unique = new Map();
  for (const item of names) { const name = String(item.name || item).trim(); if (name && !unique.has(name)) unique.set(name, Number(item.score || 0)); }
  for (const [name, score] of unique) {
    let keyword = existing.find(row => normalized(row.name || row.keyword || row.display_name) === normalized(name));
    if (!keyword) {
      const keywordId = id();
      keyword = { id: keywordId, keyword_id: keywordId, name, created_at: nowIso() };
      await db.create('keywords', keywordId, keyword);
      existing.push(keyword);
    }
    docs.push({ id: id(), data: { article_id: String(articleId), keyword_id: String(keyword.keyword_id || keyword.id), score } });
  }
  await db.batchSet('keyword_articles', docs);
}
async function replaceArticleLinks(db, articleId, links) {
  const topicIds = normalizeIds(links.topics).filter(topicId => String(topicId) !== String(links.primaryTopic || ''));
  await Promise.all([
    replaceLinks(db, 'author_articles', 'author_id', articleId, links.authors),
    replaceLinks(db, 'sub_topics', 'topic_id', articleId, topicIds),
    replaceKeywordLinks(db, articleId, normalizeKeywords(links.keywords)),
  ]);
}

async function related(ctx, entityName, relationshipField = null) {
  const entityId = ctx.params.id;
  const collection = entityName === 'authors' ? 'authors' : entityName;
  const docs = await all(ctx.db, collection);
  const match = docs.find(row => [row.id, row[`${entityName.slice(0, -1)}_id`], row.author_id, row.keyword_id, row.topic_id].some(value => String(value) === String(entityId)));
  const name = match ? field(match, 'name', 'full_name', 'title', 'keyword') : '';
  const articles = await hydrateArticles(ctx.db, await all(ctx.db, 'articles'));
  const relationCollection = { authors: 'author_articles', keywords: 'keyword_articles', topics: 'sub_topics' }[entityName];
  const relationField = { authors: 'author_id', keywords: 'keyword_id', topics: 'topic_id' }[entityName];
  const linkedIds = relationCollection ? new Set((await find(ctx.db, relationCollection, row => String(row[relationField]) === String(entityId), { limit: Infinity })).map(row => String(row.article_id))) : new Set();
  const rows = articles.filter(article => {
    const rel = relationshipField ? article[relationshipField] : article[`${entityName.slice(0, -1)}_ids`];
    const primaryTopicMatch = entityName === 'topics' && String(article.primary_topic || '') === String(entityId);
    return primaryTopicMatch || linkedIds.has(String(article.article_id || article.id)) || (Array.isArray(rel) && rel.map(String).includes(String(entityId))) || String(rel ?? '') === String(entityId);
  }).filter(row => !isDeleted(row));
  const page = paginate(rows, ctx.query, 10, entityName === 'keywords' ? 50 : 100);
  const code = entityName === 'authors' ? 'AUTHOR_ARTICLES_FETCHED' : entityName === 'keywords' ? 'KEYWORD_ARTICLES_FETCHED' : 'GET_ARTICLES_BY_TOPIC_SUCCESS';
  return { success: true, code, message: 'Láº¥y bÃ i viáº¿t liÃªn quan thÃ nh cÃ´ng', data: page.items, pagination: { page: page.page, limit: page.limit, total: page.total, total_pages: page.totalPages } };
}

async function topicArticles(ctx) {
  const openAlexTopic = await getOpenAlexEntity(ctx, 'topics');
  if (openAlexTopic) {
    const topicId = String(openAlexTopic.topic_id || ctx.params.id);
    const result = await listOpenAlexEntity({ ...ctx, query: { ...ctx.query, topic_id: topicId, sort: 'publication_year:desc' } }, 'articles');
    const page = result.data;
    return { success: true, message: 'Láº¥y danh sÃ¡ch bÃ i bÃ¡o theo topic thÃ nh cÃ´ng', data: {
      topic: { topic_id: topicId, display_name: openAlexTopic.display_name ?? null },
      articles: page.articles.map(row => ({ article_id: String(row.article_id), title: row.title ?? null, publication_year: row.publication_year ?? null, doi: row.doi ?? null })),
      pagination: { page: page.pagination.page, limit: page.pagination.limit, total: page.pagination.total },
    } };
  }
  const topic = await byId(ctx.db, 'topics', ctx.params.id);
  if (!topic || topic.is_deleted !== false) throw new HttpError(404, 'Topic does not exist', 'TOPIC_NOT_FOUND');
  const topicId = String(topic.topic_id || topic.id);
  const [articles, links] = await Promise.all([all(ctx.db, 'articles'), find(ctx.db, 'sub_topics', row => String(row.topic_id) === topicId, { limit: Infinity })]);
  const linkedIds = new Set(links.map(row => String(row.article_id)));
  const unique = new Map();
  for (const article of articles) {
    const articleId = String(article.article_id || article.id);
    if (article.is_deleted === false && (String(article.primary_topic || '') === topicId || linkedIds.has(articleId))) unique.set(articleId, article);
  }
  const rows = [...unique.values()].sort((a, b) => {
    const yearOrder = a.publication_year == null ? (b.publication_year == null ? 0 : 1) : b.publication_year == null ? -1 : number(b.publication_year) - number(a.publication_year);
    return yearOrder || compare(b.article_id || b.id, a.article_id || a.id);
  });
  const page = uncappedPage(rows, ctx.query);
  return { success: true, message: 'Láº¥y danh sÃ¡ch bÃ i bÃ¡o theo topic thÃ nh cÃ´ng', data: { topic: { topic_id: topicId, display_name: topic.display_name ?? null }, articles: page.items.map(row => ({ article_id: String(row.article_id || row.id), title: row.title ?? null, publication_year: row.publication_year ?? null, doi: row.doi ?? null })), pagination: { page: page.page, limit: page.limit, total: page.total } } };
}

async function keywordArticles(ctx) {
  const keywordId = String(ctx.params.id);
  const page = Math.max(1, Math.trunc(number(ctx.query.page, 1)));
  const limit = Math.min(50, Math.max(1, Math.trunc(number(ctx.query.limit, 10))));
  const sortByRaw = ctx.query.sortBy || ctx.query.sort_by || 'publication_year';
  const sortBy = ['publication_year', 'title', 'created_at'].includes(sortByRaw) ? sortByRaw : 'publication_year';
  const sortOrder = (ctx.query.sortOrder || ctx.query.sort_order || 'desc') === 'asc' ? 1 : -1;
  const openAlexResult = await listOpenAlexEntity({ ...ctx, query: {
    ...ctx.query, page, limit, keyword_id: ctx.params.id,
    sort: sortBy === 'publication_year' && sortOrder < 0 ? 'publication_year:desc' : sortBy === 'publication_year' ? 'publication_year:asc' : sortBy === 'title' ? 'title' : undefined,
  } }, 'articles');
  if (openAlexResult) {
    const result = openAlexResult.data;
    const items = result.articles.map(row => ({ article_id: String(row.article_id), title: row.title ?? null, abstract: row.abstract ?? null,
      publication_year: row.publication_year ?? null, doi: row.doi ?? null, journal_name: row.journal_name ?? null, citations_count: number(row.citation_count) }));
    return { success: true, code: 'KEYWORD_ARTICLES_FETCHED', message: 'Láº¥y danh sÃ¡ch bÃ i bÃ¡o theo keyword thÃ nh cÃ´ng', data: items,
      pagination: { page: result.pagination.page, limit: result.pagination.limit, total: result.pagination.total, total_pages: Math.max(1, result.pagination.total_pages) } };
  }
  const [links, articles, issues, volumes, journals] = await Promise.all(['keyword_articles', 'articles', 'issues', 'volumes', 'journals'].map(name => all(ctx.db, name)));
  const articleIds = new Set(links.filter(row => String(row.keyword_id) === keywordId).map(row => String(row.article_id)));
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  const journalById = new Map(journals.map(row => [String(row.journal_id || row.id), row]));
  const rowsById = new Map();
  for (const row of articles) if (articleIds.has(String(row.article_id || row.id))) rowsById.set(String(row.article_id || row.id), row);
  const rows = [...rowsById.values()];
  rows.sort((a, b) => {
    const av = a[sortBy]; const bv = b[sortBy];
    if (av == null || bv == null) return av == null && bv == null ? 0 : av == null ? 1 : -1;
    return compare(av, bv) * sortOrder;
  });
  const total = rows.length;
  const pageItems = rows.slice((page - 1) * limit, page * limit).map(row => {
    const issue = issueById.get(String(row.issue_id || ''));
    const volume = volumeById.get(String(issue?.volume_id || ''));
    const journal = journalById.get(String(volume?.journal_id || ''));
    return { article_id: String(row.article_id || row.id), title: row.title ?? null, abstract: row.abstract ?? null, publication_year: row.publication_year ?? null, doi: row.doi ?? null, journal_name: journal?.display_name ?? null, citations_count: 0 };
  });
  return { success: true, code: 'KEYWORD_ARTICLES_FETCHED', message: 'Láº¥y danh sÃ¡ch bÃ i bÃ¡o theo keyword thÃ nh cÃ´ng', data: pageItems, pagination: { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) } };
}

async function legacyGlobalSearch(ctx) {
  const keyword = String(ctx.params.keyword || '').trim();
  if (!keyword) return { success: true, code: 'SEARCH_SUCCESS', data: [] };
  const limit = Math.min(100, Math.max(1, Number(ctx.query.limit) || 20));
  const openAlexResult = await listOpenAlexEntity({ ...ctx, query: { ...ctx.query, search: keyword, page: 1, limit, sort: undefined } }, 'articles');
  if (openAlexResult) {
    const rows = openAlexResult.data.articles.map(article => {
      const articleId = String(article.article_id);
      const authors = (article.authors || []).map(author => ({ id: String(author.author_id), author_id: String(author.author_id), name: author.display_name || '', display_name: author.display_name || '' }));
      const journal = article.journal_name ? { id: String(article.journal_id || ''), journal_id: String(article.journal_id || ''), name: article.journal_name, display_name: article.journal_name } : null;
      const topic = article.topic_name ? { id: String(article.primary_topic || ''), topic_id: String(article.primary_topic || ''), name: article.topic_name, display_name: article.topic_name } : null;
      return { id: articleId, article_id: articleId, title: article.title || '', name: article.title || '', type: 'ARTICLE', abstract: article.abstract ?? null,
        publication_year: article.publication_year ?? null, doi: article.doi ?? null, citation_count: number(article.citation_count), journal, subject_area: null, topic, authors };
    });
    return { success: true, code: 'SEARCH_SUCCESS', data: rows };
  }
  const [articleRows, subjectAreas, subjectCategories, topics, keywords, keywordLinks, authors, journals, issues, volumes] = await Promise.all([
    all(ctx.db, 'articles'), all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories'), all(ctx.db, 'topics'),
    all(ctx.db, 'keywords'), all(ctx.db, 'keyword_articles'), all(ctx.db, 'authors'), all(ctx.db, 'journals'), all(ctx.db, 'issues'), all(ctx.db, 'volumes'),
  ]);
  const articles = await hydrateArticles(ctx.db, articleRows.filter(row => !isDeleted(row)));
  const normalize = value => String(value || '').toLocaleLowerCase();
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixPattern = new RegExp(`(^|[^a-zA-Z0-9])${escape(keyword)}`, 'i');
  const exactPattern = new RegExp(`(^|[^a-zA-Z0-9])${escape(keyword)}([^a-zA-Z0-9]|$)`, 'i');
  const tokens = keyword.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).map(normalize);
  const areaById = new Map(subjectAreas.map(row => [String(row.subject_area_id || row.id), row]));
  const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
  const areaMatches = new Set(subjectAreas.filter(row => prefixPattern.test(row.display_name || row.name || '')).map(row => String(row.subject_area_id || row.id)));
  const topicMatches = new Set(topics.filter(row => prefixPattern.test(row.display_name || row.name || '')).map(row => String(row.topic_id || row.id)));
  const keywordMatches = new Set(keywords.filter(row => prefixPattern.test(row.display_name || row.name || row.keyword || '')).map(row => String(row.keyword_id || row.id)));
  const articleIdsByKeyword = new Map();
  for (const link of keywordLinks) if (keywordMatches.has(String(link.keyword_id))) {
    const id = String(link.keyword_id);
    if (!articleIdsByKeyword.has(id)) articleIdsByKeyword.set(id, new Set());
    articleIdsByKeyword.get(id).add(String(link.article_id));
  }
  const authorById = new Map(authors.filter(row => row.is_deleted === false || row.is_deleted == null).map(row => [String(row.author_id || row.id), row]));
  const journalById = new Map(journals.map(row => [String(row.journal_id || row.id), row]));
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  const candidates = [];
  for (const article of articles) {
    const title = String(article.title || ''); const articleId = String(article.article_id || article.id);
    const topicId = String(article.primary_topic || article.topic_id || ''); const topic = topicById.get(topicId);
    const areaId = String(topic?.subject_area_id || '');
    const areaMatch = areaMatches.has(areaId); const topicMatch = topicMatches.has(topicId);
    const keywordMatch = (article.keyword_ids || []).some(id => keywordMatches.has(String(id))) || [...keywordMatches].some(id => articleIdsByKeyword.get(id)?.has(articleId));
    const tokensMatch = tokens.length > 0 && tokens.every(token => normalize(title).includes(token));
    if (!areaMatch && !topicMatch && !keywordMatch && !tokensMatch && !prefixPattern.test(title)) continue;
    const priority = exactPattern.test(title) ? 1 : prefixPattern.test(title) ? 2 : areaMatch ? 3 : keywordMatch || topicMatch ? 4 : tokensMatch ? 5 : 6;
    const issue = issueById.get(String(article.issue_id || ''));
    const activeIssue = issue && (issue.is_deleted === false || issue.is_deleted == null) ? issue : null;
    const volume = activeIssue && volumeById.get(String(activeIssue.volume_id || ''));
    const activeVolume = volume && (volume.is_deleted === false || volume.is_deleted == null) ? volume : null;
    const journal = activeVolume && journalById.get(String(activeVolume.journal_id || ''));
    const activeJournal = journal && (journal.is_deleted === false || journal.is_deleted == null) ? journal : null;
    const area = areaById.get(areaId);
    const authorRows = (article.author_ids || []).map(id => authorById.get(String(id))).filter(Boolean).map(author => {
      const id = String(author.author_id || author.id); const name = author.display_name || author.full_name || [author.first_name, author.last_name].filter(Boolean).join(' ');
      return { id, author_id: id, name, display_name: name };
    });
    const journalId = activeJournal && String(activeJournal.journal_id || activeJournal.id); const areaKey = area && String(area.subject_area_id || area.id);
    candidates.push({
      id: articleId, article_id: articleId, title, name: title, type: 'ARTICLE', abstract: article.abstract ?? null,
      publication_year: article.publication_year ?? null, doi: article.doi ?? null, citation_count: Number(article.citation_count || 0),
      journal: activeJournal ? { id: journalId, journal_id: journalId, name: activeJournal.display_name || activeJournal.name, display_name: activeJournal.display_name || activeJournal.name } : null,
      subject_area: area ? { id: areaKey, subject_area_id: areaKey, name: area.display_name || area.name, display_name: area.display_name || area.name } : null,
      topic: topic ? { id: topicId, topic_id: topicId, name: topic.display_name || topic.name, display_name: topic.display_name || topic.name } : null,
      authors: authorRows, _priority: priority,
    });
  }
  const unique = new Map();
  for (const row of candidates) {
    const key = normalize(row.title); const prior = unique.get(key);
    if (!prior || row._priority < prior._priority || row._priority === prior._priority && row.citation_count > prior.citation_count) unique.set(key, row);
  }
  return { success: true, code: 'SEARCH_SUCCESS', data: [...unique.values()]
    .sort((a, b) => a._priority - b._priority || b.citation_count - a.citation_count || Number(b.publication_year || 0) - Number(a.publication_year || 0))
    .slice(0, limit).map(({ _priority, ...row }) => row) };
}

async function statistics(ctx, entityName) {
  const row = await byId(ctx.db, entityName, ctx.params.id);
  if (!row || row.is_deleted === true) throw new HttpError(404, entityName === 'subjectAreas' ? 'Subject Area not found' : 'Subject Category not found', entityName === 'subjectAreas' ? 'SUBJECT_AREA_NOT_FOUND' : 'SUBJECT_CATEGORY_NOT_FOUND');
  const key = entityName === 'subjectAreas' ? 'subject_area_id' : 'subject_category_id';
  const [articlesRaw, journals, categories, journalCategories, authorLinks, issues, volumes] = await Promise.all(['articles', 'journals', 'subjectCategories', 'journal_subject_categories', 'author_articles', 'issues', 'volumes'].map(name => all(ctx.db, name)));
  const categoriesInArea = new Set(categories.filter(category => String(category.subject_area_id) === String(ctx.params.id)).map(category => String(category.subject_category_id || category.id)));
  const journalIds = new Set(journalCategories.filter(link => entityName === 'subjectAreas' ? categoriesInArea.has(String(link.subject_category_id)) : String(link.subject_category_id) === String(ctx.params.id)).map(link => String(link.journal_id)));
  const matchingJournals = journals.filter(journal => journal.is_deleted !== true && journalIds.has(String(journal.journal_id || journal.id)));
  const issueById = new Map(issues.map(issue => [String(issue.issue_id || issue.id), issue]));
  const volumeById = new Map(volumes.map(volume => [String(volume.volume_id || volume.id), volume]));
  const articles = await hydrateArticles(ctx.db, articlesRaw);
  const activeJournalIds = new Set(matchingJournals.map(journal => String(journal.journal_id || journal.id)));
  const articleIds = new Set(articles.filter(article => {
    if (article.is_deleted === true) return false;
    const issue = issueById.get(String(article.issue_id || ''));
    const volume = volumeById.get(String(issue?.volume_id || ''));
    return volume?.is_deleted !== true && activeJournalIds.has(String(volume?.journal_id || ''));
  }).map(article => String(article.article_id || article.id)));
  const totalAuthors = new Set(authorLinks.filter(link => link.author_id != null && articleIds.has(String(link.article_id))).map(link => String(link.author_id))).size;
  const data = { [key]: String(ctx.params.id), display_name: row.display_name || row.name, total_journals: matchingJournals.length, total_articles: articleIds.size, total_authors: totalAuthors };
  return { success: true, code: entityName === 'subjectAreas' ? 'GET_SUBJECT_AREA_STATISTICS_SUCCESS' : 'GET_SUBJECT_CATEGORY_STATISTICS_SUCCESS', message: 'Statistics fetched successfully', data };
}
async function publicationTrends(ctx) {
  const userId = String(ctx.user.user_id || ctx.user.id);
  if (!await byId(ctx.db, 'users', userId)) throw new HttpError(404, 'User not found: ' + userId, 'USER_NOT_FOUND');
  const projects = (await all(ctx.db, 'projects')).filter(row => !isDeleted(row) && String(row.user_id || row.owner_id || row.created_by) === userId);
  const projectId = ctx.query.projectId || ctx.query.project_id;
  const scopedProjects = projectId ? projects.filter(row => String(row.project_id || row.id) === String(projectId)) : projects;
  if (projectId && !scopedProjects.length) throw new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND');
  const fromYear = ctx.query.fromYear === undefined ? undefined : Number(ctx.query.fromYear);
  const toYear = ctx.query.toYear === undefined ? undefined : Number(ctx.query.toYear);
  if ((fromYear !== undefined && !Number.isInteger(fromYear)) || (toYear !== undefined && !Number.isInteger(toYear)) || (fromYear !== undefined && toYear !== undefined && fromYear > toYear)) {
    throw new HttpError(400, 'fromYear and toYear must be valid years', 'BAD_REQUEST');
  }
  const scopes = await loadProjectResearchScopes(ctx.db, scopedProjects);
  const data = await openAlexPublicationTrends(ctx, scopes, { fromYear, toYear });
  return { success: true, message: data.length ? 'Publication trend fetched successfully' : 'No publication trend data', data };
}

export const recordRoutes = [];
for (const entity of entities) {
  for (const prefix of entity.paths) {
    recordRoutes.push({ method: 'GET', path: prefix, handler: ctx => listEntity(ctx, entity) });
    if (entity.name === 'articles') {
      recordRoutes.push({ method: 'GET', path: `${prefix}/filter-options`, handler: filterOptions });
      recordRoutes.push({ method: 'GET', path: `${prefix}/:id`, handler: ctx => getEntity(ctx, entity) });
      recordRoutes.push({ method: 'POST', path: prefix, auth: true, handler: createArticle });
      recordRoutes.push({ method: 'PUT', path: `${prefix}/:id`, auth: true, handler: updateArticle });
      recordRoutes.push({ method: 'DELETE', path: `${prefix}/:id`, auth: true, handler: deleteArticle });
      recordRoutes.push({ method: 'PATCH', path: `${prefix}/:id/restore`, auth: true, handler: restoreArticle });
    } else {
      recordRoutes.push({ method: 'GET', path: `${prefix}/:id`, handler: ctx => getEntity(ctx, entity) });
      if (['volumes', 'issues'].includes(entity.name)) {
        recordRoutes.push({ method: 'POST', path: prefix, auth: true, handler: ctx => createVolumeIssue(ctx, entity.name) });
        recordRoutes.push({ method: 'PUT', path: `${prefix}/:id`, auth: true, handler: ctx => updateVolumeIssue(ctx, entity.name) });
        recordRoutes.push({ method: 'DELETE', path: `${prefix}/:id`, auth: true, handler: ctx => deleteVolumeIssue(ctx, entity.name) });
        recordRoutes.push({ method: 'PATCH', path: `${prefix}/:id/restore`, auth: true, handler: ctx => restoreVolumeIssue(ctx, entity.name) });
      } else if (writableEntities.has(entity.name)) {
        const admin = entity.name === 'publishers';
        recordRoutes.push({ method: 'POST', path: prefix, auth: true, admin, handler: ctx => entity.name === 'journals' ? createJournalRecord(ctx) : entity.name === 'publishers' ? createPublisherRecord(ctx) : entity.name === 'keywords' ? createKeywordRecord(ctx) : entity.name === 'authors' ? createAuthorRecord(ctx) : createEntity(ctx, entity) });
        recordRoutes.push({ method: 'PUT', path: `${prefix}/:id`, auth: true, admin, handler: ctx => entity.name === 'journals' ? updateJournalRecord(ctx) : entity.name === 'publishers' ? updatePublisherRecord(ctx) : entity.name === 'keywords' ? updateKeywordRecord(ctx) : entity.name === 'authors' ? updateAuthorRecord(ctx) : entity.name === 'topics' ? updateTopicRecord(ctx) : ['subjectAreas', 'subjectCategories'].includes(entity.name) ? updateTaxonomyRecord(ctx, entity.name) : updateEntity(ctx, entity) });
        recordRoutes.push({ method: 'DELETE', path: `${prefix}/:id`, auth: true, admin, handler: ctx => entity.name === 'journals' ? deleteJournalRecord(ctx) : entity.name === 'publishers' ? deletePublisherRecord(ctx) : entity.name === 'keywords' ? deleteKeywordRecord(ctx) : entity.name === 'authors' ? deleteAuthorRecord(ctx) : entity.name === 'topics' ? deleteTopicRecord(ctx) : ['subjectAreas', 'subjectCategories'].includes(entity.name) ? deleteTaxonomyRecord(ctx, entity.name) : deleteEntity(ctx, entity) });
        recordRoutes.push({ method: 'PATCH', path: `${prefix}/:id/restore`, auth: true, admin, handler: ctx => entity.name === 'journals' ? restoreJournalRecord(ctx) : entity.name === 'publishers' ? restorePublisherRecord(ctx) : entity.name === 'keywords' ? restoreKeywordRecord(ctx) : entity.name === 'authors' ? restoreAuthorRecord(ctx) : entity.name === 'topics' ? restoreTopicRecord(ctx) : ['subjectAreas', 'subjectCategories'].includes(entity.name) ? restoreTaxonomyRecord(ctx, entity.name) : restoreEntity(ctx, entity) });
      }
      if (['authors', 'keywords', 'topics'].includes(entity.name)) recordRoutes.push({ method: 'GET', path: `${prefix}/:id/articles`, handler: entity.name === 'authors' ? authorArticles : entity.name === 'topics' ? topicArticles : keywordArticles });
      if (['subjectAreas', 'subjectCategories'].includes(entity.name)) recordRoutes.push({ method: 'GET', path: `${prefix}/:id/statistics`, handler: ctx => statistics(ctx, entity.name) });
    }
  }
}

recordRoutes.push(
  { method: 'GET', path: '/author/leaderboard', handler: authorLeaderboard },
  { method: 'GET', path: '/author/:id/areas-breakdown', handler: authorAreasBreakdown },
  { method: 'GET', path: '/catalog/subject-areas', handler: async ctx => ({ success: true, code: 'CATALOG_SUBJECT_AREA_LIST_SUCCESS', message: 'Láº¥y danh sÃ¡ch subject area thÃ nh cÃ´ng', data: await catalogSubjectAreas(ctx) }) },
  { method: 'GET', path: '/catalog/subject-categories', handler: async ctx => ({ success: true, code: 'CATALOG_SUBJECT_CATEGORY_LIST_SUCCESS', message: 'Láº¥y danh sÃ¡ch subject category thÃ nh cÃ´ng', data: await catalogSubjectCategories(ctx) }) },
  { method: 'GET', path: '/catalog/journals/:id/rankings', handler: catalogJournalRankings },
  { method: 'GET', path: '/catalog/volumes', handler: catalogVolumes },
  { method: 'GET', path: '/catalog/issues', handler: catalogIssues },
  { method: 'GET', path: '/statistics/publication-trends', auth: true, handler: publicationTrends },
  { method: 'GET', path: '/zones/countries/stats', handler: async ctx => zoneStats(ctx, 'country') },
  { method: 'GET', path: '/zones/regions/stats', handler: async ctx => zoneStats(ctx, 'region', ctx.query.country_code || ctx.query.countryCode) },
  { method: 'GET', path: '/zones/countries/:code/regions/stats', handler: async ctx => zoneStats(ctx, 'region', ctx.params.code) },
  { method: 'GET', path: '/search/:keyword', handler: async ctx => {
    return legacyGlobalSearch(ctx);
  } },
);

async function authorList(ctx, source) {
  const search = String(ctx.query.search || '').trim().toLowerCase();
  const sort = String(ctx.query.sort || 'impact').toLowerCase();
  const subjectArea = String(ctx.query.subject_area || ctx.query.subject_area_id || '').trim();
  const [links, articles, issues, volumes, subjectAreas, categories, journalCategories] = await Promise.all(['author_articles', 'articles', 'issues', 'volumes', 'subjectAreas', 'subjectCategories', 'journal_subject_categories'].map(name => all(ctx.db, name)));
  const area = subjectArea ? subjectAreas.find(row => String(row.subject_area_id || row.id) === subjectArea || String(row.display_name || '').toLowerCase() === subjectArea.toLowerCase()) : null;
  const categoryIds = new Set(area ? categories.filter(row => String(row.subject_area_id || '') === String(area.subject_area_id || area.id)).map(row => String(row.subject_category_id || row.id)) : []);
  const journalIds = new Set(journalCategories.filter(row => categoryIds.has(String(row.subject_category_id))).map(row => String(row.journal_id)));
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  const linksByArticle = new Map();
  for (const link of links) {
    const articleId = String(link.article_id); const authorId = String(link.author_id);
    if (!linksByArticle.has(articleId)) linksByArticle.set(articleId, new Set());
    linksByArticle.get(articleId).add(authorId);
  }
  const linkedAuthorIds = subjectArea ? new Set(articles.filter(article => {
    const issue = issueById.get(String(article.issue_id || ''));
    const volume = volumeById.get(String(issue?.volume_id || ''));
    return journalIds.has(String(volume?.journal_id || ''));
  }).flatMap(article => [...(linksByArticle.get(String(article.article_id || article.id)) || [])])) : null;
  let rows = source.filter(author => author.is_deleted === false
    && (!subjectArea || linkedAuthorIds.has(String(author.author_id || author.id)))
    && (!search || `${author.display_name || ''} ${author.last_known_institution || ''}`.toLowerCase().includes(search)));
  const metricOrder = sort === 'citations' ? ['cited_by_count', 'h_index', 'works_count']
    : sort === 'articles' ? ['works_count', 'h_index', 'cited_by_count'] : ['h_index', 'cited_by_count', 'works_count'];
  rows.sort((a, b) => {
    if (sort === 'name') return String(a.display_name || '').localeCompare(String(b.display_name || ''));
    for (const key of metricOrder) { const difference = number(b[key]) - number(a[key]); if (difference) return difference; }
    return String(a.display_name || '').localeCompare(String(b.display_name || ''));
  });
  const authorIds = new Set(rows.map(author => String(author.author_id || author.id)));
  const categoryAreaIds = new Map(categories.map(row => [String(row.subject_category_id || row.id), String(row.subject_area_id || '')]));
  const areaNames = new Map(subjectAreas.map(row => [String(row.subject_area_id || row.id), String(row.display_name || '')]));
  const categoryIdsByJournal = new Map();
  for (const link of journalCategories) {
    const journalId = String(link.journal_id); const categoryId = String(link.subject_category_id);
    if (!categoryIdsByJournal.has(journalId)) categoryIdsByJournal.set(journalId, new Set());
    categoryIdsByJournal.get(journalId).add(categoryId);
  }
  const countsByAuthorArea = new Map();
  for (const article of articles) {
    const articleId = String(article.article_id || article.id);
    const issue = issueById.get(String(article.issue_id || ''));
    const volume = volumeById.get(String(issue?.volume_id || ''));
    const areas = new Set([...(categoryIdsByJournal.get(String(volume?.journal_id || '')) || [])].map(id => areaNames.get(categoryAreaIds.get(id) || '')).filter(Boolean));
    for (const authorId of linksByArticle.get(articleId) || []) {
      if (!authorIds.has(authorId)) continue;
      if (!countsByAuthorArea.has(authorId)) countsByAuthorArea.set(authorId, new Map());
      for (const areaName of areas) { const map = countsByAuthorArea.get(authorId); map.set(areaName, (map.get(areaName) || 0) + 1); }
    }
  }
  rows = rows.map(author => {
    const areas = [...(countsByAuthorArea.get(String(author.author_id || author.id)) || new Map())].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);
    if (subjectArea && !areas.some(name => name.toLowerCase() === subjectArea.toLowerCase())) areas.unshift(subjectArea);
    return { author_id: author.author_id ?? author.id, orcid: author.orcid ?? null, display_name: author.display_name ?? null, url_image: author.url_image ?? null,
      openalex_id: author.openalex_id ?? null, works_count: author.works_count ?? null, cited_by_count: author.cited_by_count ?? null, h_index: author.h_index ?? null,
      i10_index: author.i10_index ?? null, last_known_institution: author.last_known_institution ?? null, last_known_institution_id: author.last_known_institution_id ?? null,
      subject_areas: areas, subject_area: areas[0] || null };
  });
  const page = paginate(rows, ctx.query, 10, 100);
  return { success: true, code: 'AUTHOR_LIST_FETCHED', message: 'LÃ¡ÂºÂ¥y danh sÃƒÂ¡ch tÃƒÂ¡c giÃ¡ÂºÂ£ thÃƒÂ nh cÃƒÂ´ng', data: page.items, pagination: { page: page.page, limit: page.limit, total: page.total, total_pages: Math.max(1, page.totalPages) } };
}

async function authorArticles(ctx) {
  const authorId = String(ctx.params.id);
  if (!/^\d+$/.test(authorId) || BigInt(authorId) < 1n) throw new HttpError(400, 'Invalid author ID', 'AUTHOR_INVALID_ID');
  const limit = Math.max(1, Math.trunc(number(ctx.query.limit, 10)));
  const page = Math.max(1, Math.trunc(number(ctx.query.page, 1)));
  const openAlexResult = await listOpenAlexEntity({ ...ctx, query: { ...ctx.query, author_id: authorId, page, limit, sort: 'publication_year:desc' } }, 'articles');
  if (openAlexResult) {
    const result = openAlexResult.data;
    const rows = result.articles.map(article => ({ article_id: article.article_id, title: article.title, abstract: article.abstract,
      publication_year: article.publication_year, doi: article.doi, cited_by_count: number(article.citation_count), citation_count: number(article.citation_count),
      journal_name: article.journal_name || article.primary_location?.source?.display_name || article.journal?.display_name || null,
      authors: Array.isArray(article.authors) ? article.authors : Array.isArray(article.authorships)
        ? article.authorships.map(authorship => authorship.author || authorship).filter(author => author?.display_name || author?.name)
        : Array.isArray(article.author_names) ? article.author_names.map((display_name, index) => ({
          author_id: article.author_ids?.[index] ?? null, display_name,
        })) : [],
      author_ids: article.author_ids || [], author_names: article.author_names || [],
      primary_topic: article.primary_topic, created_at: article.created_at }));
    return { success: true, code: 'AUTHOR_ARTICLES_FETCHED', message: 'Láº¥y bÃ i viáº¿t cá»§a tÃ¡c giáº£ thÃ nh cÃ´ng',
      pagination: { page: result.pagination.page, limit: result.pagination.limit, total: result.pagination.total, total_pages: Math.max(1, result.pagination.total_pages) }, data: rows };
  }
  const [links, articles] = await Promise.all([all(ctx.db, 'author_articles'), all(ctx.db, 'articles')]);
  const linkedIds = new Set(links.filter(link => String(link.author_id) === authorId).map(link => String(link.article_id)));
  const rows = articles.filter(article => linkedIds.has(String(article.article_id || article.id))).map(article => ({
    article_id: article.article_id || article.id, title: article.title, abstract: article.abstract, publication_year: article.publication_year, doi: article.doi,
    cited_by_count: number(article.citation_count), citation_count: number(article.citation_count), primary_topic: article.primary_topic, created_at: article.created_at,
  })).sort((a, b) => {
    if (a.publication_year == null && b.publication_year != null) return -1;
    if (a.publication_year != null && b.publication_year == null) return 1;
    return number(b.publication_year) - number(a.publication_year) || String(b.article_id).localeCompare(String(a.article_id), undefined, { numeric: true });
  });
  const start = (page - 1) * limit;
  return { success: true, code: 'AUTHOR_ARTICLES_FETCHED', message: 'LÃ¡ÂºÂ¥y bÃƒÂ i viÃ¡ÂºÂ¿t cÃ¡Â»Â§a tÃƒÂ¡c giÃ¡ÂºÂ£ thÃƒÂ nh cÃƒÂ´ng', pagination: { page, limit, total: rows.length, total_pages: Math.max(1, Math.ceil(rows.length / limit)) }, data: rows.slice(start, start + limit) };
}

const ORGANIZATION_LIKE_AUTHOR_NAME = /\b(universit(?:y|ies)|college|institute|institution|museum|laborator(?:y|ies)|lab|research center|research centre|biodiversity center|biodiversity centre|botanic garden|botanical garden|academy|hospital|society|foundation|observatory|department|ministry|organization|organisation|association|library|herbarium|bureau|commission|corporation|consortium|council|agency|cluster)\b/i;

function isOrganizationLikeAuthor(name, orcid) {
  return !orcid && ORGANIZATION_LIKE_AUTHOR_NAME.test(String(name || '').trim());
}
async function authorLeaderboard(ctx) {
  {
  const period = String(ctx.query.period || 'all').trim().toLowerCase();
  const days = period === 'month' ? 30 : period === 'year' ? 365 : period === 'all' ? 0 : 7;
  const fromDate = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : null;
  const toDate = new Date().toISOString().slice(0, 10);
  const grouped = await openAlexRequest(ctx, 'works', {
    ...(fromDate ? { filter: `from_publication_date:${fromDate},to_publication_date:${toDate}` } : {}),
    group_by: 'authorships.author.id', per_page: 100,
  });
  const groups = (grouped.group_by || []).filter(group => group.key && group.key !== 'unknown')
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0)).slice(0, 100);
  const openAlexIds = groups.map(group => String(group.key).replace(/^.*\//, '').toUpperCase()).filter(value => /^A\d+$/.test(value));
  let metadataById = new Map();
  if (openAlexIds.length) {
    const metadata = await openAlexRequest(ctx, 'authors', {
      filter: `ids.openalex:${openAlexIds.join('|')}`,
      select: 'id,orcid,display_name,works_count,cited_by_count,summary_stats,last_known_institutions,topics',
      per_page: Math.min(100, openAlexIds.length),
    });
    metadataById = new Map((metadata.results || []).map(author => [String(author.id).replace(/^.*\//, '').toUpperCase(), author]));
  }
  const rows = groups.map(group => {
    const openAlexId = String(group.key).replace(/^.*\//, '').toUpperCase();
    const author = metadataById.get(openAlexId) || {};
    const displayName = author.display_name || group.key_display_name || 'Unknown author';
    if (isOrganizationLikeAuthor(displayName, author.orcid)) return null;
    const topics = Array.isArray(author.topics) ? [...author.topics] : [];
    const subjectAreas = [...new Set(topics
      .map(topic => topic.field?.display_name || topic.subfield?.display_name || topic.display_name)
      .filter(Boolean))];
    return {
      author_id: Number(openAlexId.slice(1)), openalex_id: openAlexId,
      orcid: author.orcid || null, display_name: displayName,
      last_known_institution: author.last_known_institutions?.[0]?.display_name || null,
      article_count: Number(group.count || 0), works_count: Number(group.count || 0),
      cited_by_count: Number(author.cited_by_count || 0),
      h_index: Number(author.summary_stats?.h_index || 0), i10_index: Number(author.summary_stats?.i10_index || 0),
      subject_area: subjectAreas[0] || null, primary_subject_area: subjectAreas[0] || null, subject_areas: subjectAreas,
    };
  }).filter(Boolean).map((author, index) => ({ ...author, final_rank: index + 1 }));
  const openAlexPage = paginate(rows, ctx.query, 10, 100);
  openAlexPage.totalPages = Math.max(1, openAlexPage.totalPages);
  return { success: true, code: 'AUTHOR_LEADERBOARD_FETCHED', message: 'Author leaderboard fetched from OpenAlex', pagination: { page: openAlexPage.page, limit: openAlexPage.limit, total: openAlexPage.total, total_pages: openAlexPage.totalPages }, data: openAlexPage.items };
  }

  const [authors, links, articles, issues, volumes, subjectAreas, categories, journalCategories] = await Promise.all(['authors', 'author_articles', 'articles', 'issues', 'volumes', 'subjectAreas', 'subjectCategories', 'journal_subject_categories'].map(name => all(ctx.db, name)));
  const subjectArea = String(ctx.query.subject_area || '').trim();
  const period = String(ctx.query.period || 'all').trim().toLowerCase();
  const area = subjectAreas.find(row => String(row.subject_area_id || row.id) === subjectArea || String(row.display_name || '').toLowerCase() === subjectArea.toLowerCase());
  const categoryIds = new Set(area ? categories.filter(row => String(row.subject_area_id || '') === String(area.subject_area_id || area.id)).map(row => String(row.subject_category_id || row.id)) : []);
  const journalIds = new Set(journalCategories.filter(row => categoryIds.has(String(row.subject_category_id))).map(row => String(row.journal_id)));
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  const now = Date.now();
  const inPeriod = article => period === 'month' ? new Date(article.created_at || 0).getTime() >= now - 30 * 86400000
    : period === 'year' ? number(article.publication_year) >= new Date().getFullYear() - 1 : true;
  let candidateArticleIds = null;
  if (subjectArea || period === 'month' || period === 'year') {
    candidateArticleIds = new Set(articles.filter(article => {
      if (!inPeriod(article)) return false;
      if (!subjectArea) return true;
      const issue = issueById.get(String(article.issue_id || ''));
      const volume = volumeById.get(String(issue?.volume_id || ''));
      return journalIds.has(String(volume?.journal_id || ''));
    }).map(article => String(article.article_id || article.id)));
  }
  const candidateAuthorIds = candidateArticleIds === null ? null : new Set(links.filter(link => candidateArticleIds.has(String(link.article_id))).map(link => String(link.author_id)));
  let authorRows = authors.filter(author => author.is_deleted !== true && (candidateAuthorIds === null || candidateAuthorIds.has(String(author.author_id || author.id))));
  const metricFields = ['h_index', 'cited_by_count', 'i10_index', 'works_count'];
  authorRows.sort((a, b) => {
    for (const field of metricFields) {
      if (a[field] == null && b[field] == null) continue;
      if (a[field] == null) return 1;
      if (b[field] == null) return -1;
      const difference = number(b[field]) - number(a[field]);
      if (difference !== 0) return difference;
    }
    return 0;
  });
  const areaNames = new Map(subjectAreas.map(row => [String(row.subject_area_id || row.id), String(row.display_name || '')]));
  const areaIdByCategory = new Map(categories.map(row => [String(row.subject_category_id || row.id), String(row.subject_area_id || '')]));
  const categoryIdsByJournal = new Map();
  for (const link of journalCategories) {
    const journalId = String(link.journal_id); const categoryId = String(link.subject_category_id);
    if (!categoryIdsByJournal.has(journalId)) categoryIdsByJournal.set(journalId, new Set());
    categoryIdsByJournal.get(journalId).add(categoryId);
  }
  const authorIdsByArticle = new Map();
  for (const link of links) {
    const articleId = String(link.article_id); const authorId = String(link.author_id);
    if (!authorIdsByArticle.has(articleId)) authorIdsByArticle.set(articleId, new Set());
    authorIdsByArticle.get(articleId).add(authorId);
  }
  const areaCounts = new Map();
  for (const article of articles) {
    const issue = issueById.get(String(article.issue_id || ''));
    const volume = volumeById.get(String(issue?.volume_id || ''));
    const names = new Set([...(categoryIdsByJournal.get(String(volume?.journal_id || '')) || [])].map(categoryId => areaNames.get(areaIdByCategory.get(categoryId) || '')).filter(Boolean));
    for (const authorId of authorIdsByArticle.get(String(article.article_id || article.id)) || []) for (const name of names) {
      if (!areaCounts.has(authorId)) areaCounts.set(authorId, new Map());
      const counts = areaCounts.get(authorId);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  const rows = authorRows.map((author, index) => {
    const authorId = String(author.author_id || author.id);
    const assignedAreas = [...(areaCounts.get(authorId) || new Map())].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);
    if (subjectArea && !assignedAreas.some(name => name.toLowerCase() === subjectArea.toLowerCase())) assignedAreas.unshift(subjectArea);
    return { author_id: author.author_id || author.id, orcid: author.orcid, display_name: author.display_name, url_image: author.url_image, works_count: number(author.works_count), cited_by_count: number(author.cited_by_count), h_index: number(author.h_index), i10_index: number(author.i10_index), final_rank: index + 1, subject_areas: assignedAreas, subject_area: assignedAreas[0] || null };
  });
  const page = paginate(rows, ctx.query, 10, 100);
  page.totalPages = Math.max(1, page.totalPages);
  return { success: true, code: 'AUTHOR_LEADERBOARD_FETCHED', message: 'Láº¥y báº£ng xáº¿p háº¡ng tÃ¡c giáº£ thÃ nh cÃ´ng', pagination: { page: page.page, limit: page.limit, total: page.total, total_pages: page.totalPages }, data: page.items };
}
async function authorAreasBreakdown(ctx) {
  if (!/^\d+$/.test(String(ctx.params.id)) || BigInt(String(ctx.params.id)) < 1n) throw new HttpError(400, 'Invalid author ID', 'AUTHOR_INVALID_ID');
  const author = requireFound(await byId(ctx.db, 'authors', ctx.params.id), 'Author not found');
  const [links, articles, issues, volumes, journalCategories, categories] = await Promise.all(['author_articles', 'articles', 'issues', 'volumes', 'journal_subject_categories', 'subjectCategories'].map(name => all(ctx.db, name)));
  const articleIds = new Set(links.filter(link => String(link.author_id) === String(ctx.params.id)).map(link => String(link.article_id)));
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  const categoryById = new Map(categories.map(row => [String(row.subject_category_id || row.id), row]));
  const categoryIdsByJournal = new Map();
  for (const relation of journalCategories) {
    const journalId = String(relation.journal_id); const categoryId = String(relation.subject_category_id);
    if (!categoryIdsByJournal.has(journalId)) categoryIdsByJournal.set(journalId, new Set());
    categoryIdsByJournal.get(journalId).add(categoryId);
  }
  const categoryArticles = new Map();
  for (const article of articles) {
    const articleId = String(article.article_id || article.id);
    if (!articleIds.has(articleId)) continue;
    const issue = issueById.get(String(article.issue_id || ''));
    const volume = volumeById.get(String(issue?.volume_id || ''));
    for (const categoryId of categoryIdsByJournal.get(String(volume?.journal_id || '')) || []) {
      if (!categoryById.has(categoryId)) continue;
      if (!categoryArticles.has(categoryId)) categoryArticles.set(categoryId, new Set());
      categoryArticles.get(categoryId).add(articleId);
    }
  }
  const total = [...categoryArticles.values()].reduce((sum, ids) => sum + ids.size, 0);
  const breakdown = [...categoryArticles].map(([categoryId, ids]) => ({ subject_category_id: categoryId, category_name: categoryById.get(categoryId)?.display_name, article_count: ids.size, percentage: total ? Math.round(ids.size / total * 10000) / 100 : null })).sort((a, b) => b.article_count - a.article_count);
  return { success: true, code: 'AREA_BREAKDOWN_FETCHED', message: 'PhÃ¢n tÃ­ch lÄ©nh vá»±c nghiÃªn cá»©u cá»§a tÃ¡c giáº£ thÃ nh cÃ´ng', data: { ...author, breakdown } };
}
async function catalogSubjectAreas(ctx) {
  const rows = (await all(ctx.db, 'subjectAreas')).filter(row => !isDeleted(row));
  rows.sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || '')));
  return rows.map(row => ({ subject_area_id: String(row.subject_area_id || row.id), display_name: row.display_name ?? null, description: row.description ?? null }));
}

async function catalogSubjectCategories(ctx) {
  try {
    const openAlexResult = await listOpenAlexEntity(ctx, 'subjectCategories');
    if (openAlexResult?.data?.items?.length) {
      return openAlexResult.data.items;
    }
  } catch (err) {
    console.warn('[openalex] catalogSubjectCategories fallback to local db:', err?.message || err);
  }
  const rows = (await all(ctx.db, 'subjectCategories')).filter(row => !isDeleted(row)
    && (!ctx.query.subject_area_id || String(row.subject_area_id) === String(ctx.query.subject_area_id)));
  rows.sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || '')));
  return rows.map(row => ({ subject_category_id: String(row.subject_category_id || row.id), subject_area_id: row.subject_area_id == null ? null : String(row.subject_area_id), display_name: row.display_name ?? null, description: row.description ?? null }));
}

async function catalogJournalRankings(ctx) {
  const journalId = String(ctx.params.id || '').trim();
  if (!journalId) throw new HttpError(400, 'Journal ID is required', 'CATALOG_JOURNAL_ID_REQUIRED');
  const sourceId = /^S/i.test(journalId) ? journalId.toUpperCase() : `S${journalId}`;
  const source = await openAlexRequest(ctx, `sources/${sourceId}`, { select: 'id,counts_by_year' });
  const data = (source.counts_by_year || []).map(row => ({
    year: Number(row.year), value: Number(row.works_count || 0),
    works_count: Number(row.works_count || 0), cited_by_count: Number(row.cited_by_count || 0),
    metric_code: 'OPENALEX_WORKS_COUNT', metric_name: 'OpenAlex works', metric_type: 'COUNT',
  })).filter(row => Number.isInteger(row.year)).sort((a, b) => b.year - a.year);
  return { success: true, code: 'CATALOG_JOURNAL_ACTIVITY_SUCCESS', message: 'Journal publication activity fetched from OpenAlex', data };
}

const openAlexWorksSelect = 'id,display_name,publication_year,publication_date,biblio,primary_location,doi,type,cited_by_count';
const openAlexSourceWorks = (ctx, sourceId) => openAlexRequest(ctx, 'works', {
  filter: `primary_location.source.id:${sourceId}`, page: 1, per_page: 100,
  select: openAlexWorksSelect, sort: 'publication_date:desc',
});
async function openAlexSourceWorksSample(ctx, sourceId) {
  const rows = [];
  for (let page = 1; page <= 5; page += 1) {
    const result = await openAlexRequest(ctx, 'works', { filter: `primary_location.source.id:${sourceId}`, page, per_page: 100, select: openAlexWorksSelect, sort: 'publication_date:desc' });
    rows.push(...(result.results || []));
    if (rows.length >= Number(result.meta?.count || 0) || !(result.results || []).length) break;
  }
  return { results: rows };
}
const openAlexVolumeId = (sourceId, volume) => `openalex:${sourceId}:volume:${encodeURIComponent(volume)}`;
const openAlexIssueId = (sourceId, volume, issue) => `openalex:${sourceId}:issue:${encodeURIComponent(volume)}:${encodeURIComponent(issue)}`;
async function catalogVolumes(ctx) {
  const journalFilter = String(ctx.query.journal_id || '').trim();
  const sourceSuffix = journalFilter.replace(/^S/i, '');
  if (!/^\d+$/.test(sourceSuffix) || BigInt(sourceSuffix) <= 0n) throw new HttpError(400, 'journal_id is required and must be an OpenAlex source ID or positive integer', 'CATALOG_JOURNAL_ID_INVALID');
  const sourceId = `S${sourceSuffix}`;
  const result = await openAlexSourceWorksSample(ctx, sourceId);
  const groups = new Map();
  for (const work of result.results || []) {
    const volume = String(work.biblio?.volume || '').trim();
    const issue = String(work.biblio?.issue || '').trim();
    const key = volume || `year:${work.publication_year || 'unknown'}`;
    const row = groups.get(key) || {
      id: openAlexVolumeId(sourceId, key), volume_id: openAlexVolumeId(sourceId, key), journal_id: sourceSuffix,
      volume_number: volume, display_label: volume ? null : `Publications in ${work.publication_year || 'unknown year'}`,
      publication_year: work.publication_year ?? null, year: work.publication_year ?? null,
      issue_count: 0, article_count: 0, can_expand: Boolean(volume), _issues: new Set(),
    };
    row.article_count += 1;
    if (issue) row._issues.add(issue);
    if (Number(work.publication_year) > Number(row.publication_year || 0)) row.publication_year = row.year = work.publication_year;
    groups.set(key, row);
  }
  const rows = [...groups.values()].map(({ _issues, ...row }) => ({ ...row, issue_count: _issues.size }));
  rows.sort((a, b) => number(b.publication_year) - number(a.publication_year) || String(b.volume_number).localeCompare(String(a.volume_number), undefined, { numeric: true }));
  const page = paginate(rows, ctx.query, 10, 100);
  return { success: true, code: 'CATALOG_VOLUME_LIST_SUCCESS', message: 'Volumes derived from OpenAlex works', data: { items: page.items, pagination: { page: page.page, limit: page.limit, total: page.total, total_pages: Math.max(1, Math.ceil(page.total / page.limit)) } } };
}
async function catalogIssues(ctx) {
  const volumeFilter = String(ctx.query.volume_id || '').trim();
  const volumeMatch = volumeFilter.match(/^openalex:(S\d+):volume:(.+)$/i);
  const journalFilter = String(ctx.query.journal_id || '').trim();
  const sourceSuffix = volumeMatch ? volumeMatch[1].slice(1) : journalFilter.replace(/^S/i, '');
  if (!/^\d+$/.test(sourceSuffix) || BigInt(sourceSuffix) <= 0n || (!volumeMatch && !journalFilter)) {
    throw new HttpError(400, 'Provide an OpenAlex volume_id or journal_id to list issues', 'CATALOG_ISSUE_SCOPE_REQUIRED');
  }
  const sourceId = `S${sourceSuffix}`;
  let requestedVolume = null;
  if (volumeMatch) {
    try { requestedVolume = decodeURIComponent(volumeMatch[2]); }
    catch { throw new HttpError(400, 'Invalid OpenAlex volume_id', 'CATALOG_VOLUME_ID_INVALID'); }
  }
  const result = await openAlexSourceWorksSample(ctx, sourceId);
  const groups = new Map();
  for (const work of result.results || []) {
    const volume = String(work.biblio?.volume || '').trim();
    const issue = String(work.biblio?.issue || '').trim();
    if (!volume || !issue || (requestedVolume !== null && volume !== requestedVolume)) continue;
    const key = `${volume}:${issue}`;
    const row = groups.get(key) || {
      id: openAlexIssueId(sourceId, volume, issue), issue_id: openAlexIssueId(sourceId, volume, issue),
      volume_id: openAlexVolumeId(sourceId, volume), journal_id: sourceSuffix, volume_number: volume,
      issue_number: issue, publication_year: work.publication_year ?? null, year: work.publication_year ?? null, article_count: 0,
    };
    row.article_count += 1;
    if (Number(work.publication_year) > Number(row.publication_year || 0)) row.publication_year = row.year = work.publication_year;
    groups.set(key, row);
  }
  const rows = [...groups.values()].sort((a, b) => number(b.publication_year) - number(a.publication_year) || String(b.issue_number).localeCompare(String(a.issue_number), undefined, { numeric: true }));
  const page = paginate(rows, ctx.query, 10, 100);
  return { success: true, code: 'CATALOG_ISSUE_LIST_SUCCESS', message: 'Issues derived from OpenAlex works', data: { items: page.items, pagination: { page: page.page, limit: page.limit, total: page.total, total_pages: Math.max(1, Math.ceil(page.total / page.limit)) } } };
}
async function getOpenAlexVolumeIssue(ctx, name) {
  const value = String(ctx.params.id || '');
  const match = name === 'volumes'
    ? value.match(/^openalex:(S\d+):volume:(.+)$/i)
    : value.match(/^openalex:(S\d+):issue:(.*):([^:]+)$/i);
  if (!match) throw new HttpError(404, `${name === 'volumes' ? 'Volume' : 'Issue'} not found in OpenAlex`, name === 'volumes' ? 'VOLUME_NOT_FOUND' : 'ISSUE_NOT_FOUND');
  if (name === 'volumes') {
    const result = await catalogVolumes({ ...ctx, query: { ...ctx.query, journal_id: match[1].slice(1), page: 1, limit: 100 } });
    const row = result.data.items.find(item => item.volume_id === value);
    if (!row) throw new HttpError(404, 'Volume not found in OpenAlex', 'VOLUME_NOT_FOUND');
    return { success: true, code: 'GET_VOLUME_DETAIL_SUCCESS', data: row };
  }
  let volume; let issue;
  try { volume = decodeURIComponent(match[2]); issue = decodeURIComponent(match[3]); }
  catch { throw new HttpError(400, 'Invalid OpenAlex issue_id', 'CATALOG_ISSUE_ID_INVALID'); }
  const result = await openAlexSourceWorksSample(ctx, match[1].toUpperCase());
  const works = (result.results || []).filter(work => String(work.biblio?.volume || '').trim() === volume && String(work.biblio?.issue || '').trim() === issue);
  if (!works.length) throw new HttpError(404, 'Issue not found in OpenAlex', 'ISSUE_NOT_FOUND');
  return { success: true, code: 'GET_ISSUE_DETAIL_SUCCESS', data: { issue_id: value, volume_id: openAlexVolumeId(match[1].toUpperCase(), volume), journal_id: match[1].slice(1), issue_number: issue, volume_number: volume, publication_year: Math.max(...works.map(work => Number(work.publication_year) || 0)) || null, article_count: works.length } };
}
async function zoneStats(ctx, level, code) {
  if (level === 'region' && ctx.path.includes('/countries/') && (!code || !String(code).trim())) throw new HttpError(400, 'Country code is required', 'COUNTRY_REGIONS_STATS_ERROR');
  code = code ? String(code).trim() : undefined;
  if (level === 'country') {
    const rawYear = ctx.query.year ?? ctx.query.publication_year;
    if (rawYear !== undefined && rawYear !== '' && !Number.isFinite(Number(rawYear))) throw new HttpError(400, 'Year must be a number', 'YEAR_INVALID');
    const filters = [];
    if (rawYear !== undefined && rawYear !== '') filters.push(`publication_year:${Number(rawYear)}`);
    const result = await openAlexRequest(ctx, 'works', { ...(filters.length ? { filter: filters.join(',') } : {}), group_by: 'institutions.country_code', per_page: 200 });
    const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    const rows = (result.group_by || []).map(group => {
      const countryCode = String(group.key || '').split('/').pop().toUpperCase();
      if (!/^[A-Z]{2}$/.test(countryCode)) return null;
      let name = group.key_display_name;
      try { name = name || displayNames.of(countryCode) || countryCode; } catch { name = name || countryCode; }
      return { zone_id: countryCode, code: countryCode, iso_code: countryCode, name, source: 'OpenAlex', article_count: Number(group.count || 0) };
    }).filter(Boolean).sort((a, b) => b.article_count - a.article_count || a.name.localeCompare(b.name));
    const countryPage = Math.max(1, Number(ctx.query.page) || 1); const countryLimit = Math.min(1000, Math.max(1, Number(ctx.query.limit) || 10));
    return { success: true, code: 'GET_COUNTRY_STATS_SUCCESS', message: 'Country publication statistics fetched from OpenAlex', data: rows.slice((countryPage - 1) * countryLimit, countryPage * countryLimit), pagination: { total: rows.length, page: countryPage, limit: countryLimit, totalPages: Math.ceil(rows.length / countryLimit) } };
  }
  const [zones, journals, volumes, issues, articles] = await Promise.all(['zones','journals','volumes','issues','articles'].map(name => all(ctx.db, name)));
  const zoneId = row => String(row.zone_id || row.id);
  const journalId = row => String(row.journal_id || row.id);
  const volumeId = row => String(row.volume_id || row.id);
  const issueId = row => String(row.issue_id || row.id);
  const zoneFields = row => ({ zone_id: zoneId(row), code: row.code, name: row.name, iso_code: row.iso_code, source: row.source, created_at: row.created_at });
  const articleCount = (zone, type, { activeOnly = false, year } = {}) => {
    const active = row => !activeOnly || row.is_deleted !== true;
    const matchingJournalIds = new Set(journals.filter(row => String(row[type] || '') === zoneId(zone) && active(row)).map(journalId));
    const matchingVolumeIds = new Set(volumes.filter(row => matchingJournalIds.has(String(row.journal_id || '')) && active(row)).map(volumeId));
    const matchingIssueIds = new Set(issues.filter(row => matchingVolumeIds.has(String(row.volume_id || '')) && active(row)).map(issueId));
    return articles.filter(row => matchingIssueIds.has(String(row.issue_id || '')) && active(row) && (year === undefined || Number(row.publication_year) === year)).length;
  };
  const page = Math.max(1, Number(ctx.query.page) || 1); const limit = Math.min(100, Math.max(1, Number(ctx.query.limit) || 10));
  if (level === 'country') {
    const rawYear = ctx.query.year ?? ctx.query.publication_year;
    if (rawYear !== undefined && rawYear !== '' && !Number.isFinite(Number(rawYear))) throw new HttpError(400, 'Year must be a number', 'YEAR_INVALID');
    const year = rawYear === undefined || rawYear === '' ? undefined : Number(rawYear);
    const rows = zones.filter(row => String(row.type).toUpperCase() === 'COUNTRY').map(zone => ({ ...zoneFields(zone), article_count: articleCount(zone, 'country', { activeOnly: true, year }) }));
    rows.sort((a, b) => b.article_count - a.article_count || String(a.name).localeCompare(String(b.name)));
    const items = rows.slice((page - 1) * limit, page * limit);
    return { success: true, code: 'GET_COUNTRY_STATS_SUCCESS', message: 'Láº¥y danh sÃ¡ch thá»‘ng kÃª quá»‘c gia thÃ nh cÃ´ng', data: items, pagination: { total: rows.length, page, limit, totalPages: Math.ceil(rows.length / limit) } };
  }
  const country = code ? zones.find(row => String(row.type).toUpperCase() === 'COUNTRY' && [row.code, row.iso_code].some(value => String(value || '').toUpperCase() === String(code).toUpperCase())) : null;
  if (code && !country) throw new HttpError(404, `Country '${code}' not found`, 'COUNTRY_NOT_FOUND');
  const rows = zones.filter(row => {
    if (String(row.type).toUpperCase() !== 'REGION' || !country) return String(row.type).toUpperCase() === 'REGION';
    return journals.some(journal => String(journal.region || '') === zoneId(row) && String(journal.country || '') === zoneId(country)
      && volumes.some(volume => String(volume.journal_id || '') === journalId(journal)
        && issues.some(issue => String(issue.volume_id || '') === volumeId(volume))));
  }).map(zone => ({ ...zoneFields(zone), article_count: articleCount(zone, 'region') }));
  rows.sort((a, b) => b.article_count - a.article_count || String(a.name).localeCompare(String(b.name)));
  if (level === 'region' && ctx.path.includes('/countries/')) return { success: true, code: 'GET_COUNTRY_REGIONS_STATS_SUCCESS', message: 'Láº¥y thá»‘ng kÃª region theo quá»‘c gia thÃ nh cÃ´ng', data: { country: zoneFields(country), regions: rows } };
  return { success: true, code: 'GET_REGION_STATS_SUCCESS', message: code ? `Láº¥y danh sÃ¡ch phÃ¢n vÃ¹ng cá»§a quá»‘c gia '${code}' thÃ nh cÃ´ng` : 'Láº¥y danh sÃ¡ch phÃ¢n vÃ¹ng toÃ n cáº§u thÃ nh cÃ´ng', data: rows };
}
