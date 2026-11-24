import { HttpError } from '../core/http.js';
import { defineRoutes, ok } from '../core/router.js';
import { all, byId, find, hydrateArticles, id, isDeleted, matchText, nowIso, paginate, requireFound } from '../firestore/repository.js';
import { requireProject } from './projects.js';
import { getOpenAlexAuthorsByIds, getOpenAlexSourcesByIds, getOpenAlexWorksByIds, openAlexWorkToLegacy, searchOpenAlexEntities, searchOpenAlexWorkGraph } from '../openalex/adapters.js';
import { openAlexRequest } from '../openalex/client.js';
import { loadProjectResearchScopes, openAlexPublicationTrends, openAlexTrendingKeywords } from '../openalex/project-dashboard.js';
import { normalizeOpenAlexKeywordId } from '../openalex/project-sync.js';
import { forecastInsights } from './forecast.js';

const articleText = ['title', 'abstract', 'description', 'keywords', 'doi'];
const normalizeGraphSearchText = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const yearOf = row => Number(row.publication_year || row.year || String(row.publication_date || '').slice(0, 4)) || null;
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const filteredArticles = async (ctx) => {
  let rows = (await hydrateArticles(ctx.db, await all(ctx.db, 'articles'))).filter(row => !isDeleted(row));
  const q = ctx.query.q || ctx.query.query || ctx.query.keyword;
  if (q) rows = rows.filter(row => matchText(row, q, articleText));
  const from = number(ctx.query.from_year || ctx.query.year_from, 0);
  const to = number(ctx.query.to_year || ctx.query.year_to, 9999);
  rows = rows.filter(row => !yearOf(row) || (yearOf(row) >= from && yearOf(row) <= to));
  for (const [queryKey, field] of [['journal_id', 'journal_id'], ['country', 'country'], ['country_code', 'country_code'], ['article_type', 'article_type']]) {
    if (ctx.query[queryKey]) rows = rows.filter(row => String(row[field] || '').toLowerCase() === String(ctx.query[queryKey]).toLowerCase());
  }
  const requestedArea = String(ctx.query.subject_area || ctx.query.domain || '').trim();
  const requestedCategory = String(ctx.query.subject_category || '').trim();
  const requestedKeywords = String(ctx.query.keywords || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const requestedZone = String(ctx.query.zone || '').trim();
  if (requestedArea || requestedCategory || requestedKeywords.length || (requestedZone && !['all', 'global distribution'].includes(requestedZone.toLowerCase()))) {
    const [subjectAreas, subjectCategories, topics, keywords, zones] = await Promise.all([
      all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories'), all(ctx.db, 'topics'), all(ctx.db, 'keywords'), all(ctx.db, 'zones'),
    ]);
    const matchesIdOrName = (row, value, idFields, nameFields) => idFields.some(field => String(row[field] ?? '') === value)
      || nameFields.some(field => String(row[field] ?? '').trim().toLowerCase() === value.toLowerCase());
    const area = requestedArea && subjectAreas.find(row => matchesIdOrName(row, requestedArea, ['subject_area_id', 'id'], ['display_name', 'name', 'title']));
    const category = requestedCategory && subjectCategories.find(row => matchesIdOrName(row, requestedCategory, ['subject_category_id', 'id'], ['display_name', 'name', 'title']));
    const areaId = area && String(area.subject_area_id || area.id);
    const categoryId = category && String(category.subject_category_id || category.id);
    const categoriesForArea = new Set(subjectCategories.filter(row => areaId && String(row.subject_area_id) === areaId).map(row => String(row.subject_category_id || row.id)));
    const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
    const wantedKeywordIds = new Set(keywords.filter(row => requestedKeywords.includes(String(row.display_name || row.name || row.keyword || '').toLowerCase())).map(row => String(row.keyword_id || row.id)));
    const zone = requestedZone && !['all', 'global distribution'].includes(requestedZone.toLowerCase())
      ? zones.find(row => matchesIdOrName(row, requestedZone, ['zone_id', 'id'], ['name', 'display_name', 'code']))
      : null;
    const topicMatches = row => [...new Set([...(row.topic_ids || []), row.primary_topic, row.topic_id].filter(Boolean).map(String))]
      .some(id => {
        const topic = topicById.get(id);
        const topicCategory = String(topic?.subject_category_id || '');
        return (categoryId && topicCategory === categoryId) || (areaId && categoriesForArea.has(topicCategory));
      });
    rows = rows.filter(row => {
      if (requestedArea && !area && !rows.some(item => String(item.subject_area || item.subject_area_name || '').toLowerCase() === requestedArea.toLowerCase())) return false;
      if (requestedCategory && !category && !rows.some(item => String(item.subject_category || item.subject_category_name || '').toLowerCase() === requestedCategory.toLowerCase())) return false;
      if (requestedArea && !(String(row.subject_area_id || '') === areaId || String(row.subject_area || row.subject_area_name || '').toLowerCase() === requestedArea.toLowerCase() || topicMatches(row))) return false;
      if (requestedCategory && !(String(row.subject_category_id || '') === categoryId || String(row.subject_category || row.subject_category_name || '').toLowerCase() === requestedCategory.toLowerCase() || topicMatches(row))) return false;
      if (requestedKeywords.length) {
        const articleKeywords = Array.isArray(row.keywords) ? row.keywords : String(row.keywords || '').split(',');
        const rowNames = [...articleKeywords, ...(row.keyword_names ? String(row.keyword_names).split(',') : [])].map(item => String(item?.display_name || item?.name || item).trim().toLowerCase());
        const rowIds = (row.keyword_ids || []).map(String);
        if (!requestedKeywords.some(name => rowNames.includes(name)) && ![...wantedKeywordIds].some(id => rowIds.includes(id))) return false;
      }
      if (requestedZone && !['all', 'global distribution'].includes(requestedZone.toLowerCase())) {
        if (!zone) return false;
        const value = String(zone.zone_id || zone.id || requestedZone).toLowerCase();
        const labels = [zone.name, zone.code, zone.region, zone.country].filter(Boolean).map(item => String(item).toLowerCase());
        const articleValues = [row.zone_id, row.zone, row.zone_name, row.region_id, row.region, row.country_id, row.country, row.country_code]
          .filter(Boolean).map(item => String(item).toLowerCase());
        if (![value, ...labels].some(item => articleValues.includes(item))) return false;
      }
      return true;
    });
  }
  if (ctx.query.project_id) {
    if (!ctx.internalJob) await requireProject(ctx, ctx.query.project_id);
    const project = await byId(ctx.db, 'projects', ctx.query.project_id);
    if (!project) throw new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND');
    const projectId = String(project?.project_id || project?.id || ctx.query.project_id);
    const [journalLinks, categoryLinks, articleScopes, projectKeywordLinks, subjectAreas, subjectCategories, topics] = await Promise.all([
      find(ctx.db, 'project_journals', row => String(row.project_id) === projectId, { limit: Infinity }),
      find(ctx.db, 'subject_category_projects', row => String(row.project_id) === projectId, { limit: Infinity }),
      find(ctx.db, 'project_article_scopes', row => String(row.project_id) === projectId, { limit: Infinity }),
      find(ctx.db, 'project_keywords', row => String(row.project_id) === projectId, { limit: Infinity }),
      all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories'), all(ctx.db, 'topics'),
    ]);
    const journals = new Set([...(project?.journal_ids || []), ...journalLinks.map(row => row.journal_id)].map(String));
    const areaValues = (project?.subject_area_ids || [project?.subject_area || project?.subject_area_id]).filter(Boolean).map(String);
    const areaIds = new Set(subjectAreas.filter(row => areaValues.includes(String(row.subject_area_id || row.id)) || areaValues.some(value => value.toLowerCase() === String(row.display_name || row.name || '').toLowerCase())).map(row => String(row.subject_area_id || row.id)));
    const categories = new Set([...(project?.subject_category_ids || []), ...categoryLinks.map(row => row.subject_category_id), ...subjectCategories.filter(row => areaIds.has(String(row.subject_area_id))).map(row => row.subject_category_id || row.id)].filter(Boolean).map(String));
    const topicIds = new Set(topics.filter(row => categories.has(String(row.subject_category_id))).map(row => String(row.topic_id || row.id)));
    const scope = new Set(articleScopes.map(row => String(row.article_id)));
    const projectKeywordIds = new Set(projectKeywordLinks.map(row => String(row.keyword_id)).filter(Boolean));
    rows = rows.filter(row => scope.has(String(row.article_id || row.id)) || (!ctx.sourceScope && journals.has(String(row.journal_id))) || areaIds.has(String(row.subject_area_id || row.subject_area)) || categories.has(String(row.subject_category_id)) || (row.topic_ids || []).some(topicId => topicIds.has(String(topicId))) || topicIds.has(String(row.primary_topic || row.topic_id)) || (row.keyword_ids || []).some(keywordId => projectKeywordIds.has(String(keywordId))));
  }
  const sort = ctx.query.sort || 'year_desc';
  rows.sort((a, b) => sort === 'citations_desc' ? number(b.citation_count) - number(a.citation_count) : sort === 'name_asc' ? String(a.title || '').localeCompare(String(b.title || '')) : (yearOf(b) || 0) - (yearOf(a) || 0));
  return rows;
};

const groupBy = (rows, getKey, measure = () => 1) => {
  const map = new Map();
  for (const row of rows) { const key = String(getKey(row) || 'Unknown'); map.set(key, (map.get(key) || 0) + number(measure(row))); }
  return [...map].map(([name, value]) => ({ name, count: value, value })).sort((a, b) => b.value - a.value);
};
const yearsSeries = (rows, measure = () => 1) => groupBy(rows, row => yearOf(row) || 'Unknown', measure).sort((a, b) => number(a.name, 0) - number(b.name, 0)).map(item => ({ year: number(item.name, item.name), count: item.value }));
const entityName = row => row.title || row.name || row.full_name || row.keyword || row.id;
const response = (data, message = 'Analytics fetched successfully') => ok(data, message, 200);

const emptyTrendSeries = () => ({ timeline: [], series: [{ name: 'Articles', data: [] }, { name: 'Citations', data: [] }] });

function normalizeTrendSeries(records, query) {
  if (!records.length) return emptyTrendSeries();
  const years = records.map(row => Number(row.year));
  const min = query.from_year !== undefined && query.from_year !== '' ? Number(query.from_year) : Math.min(...years);
  const max = query.to_year !== undefined && query.to_year !== '' ? Number(query.to_year) : Math.max(...years);
  if (min > max) throw new HttpError(400, 'Invalid year range: from_year cannot be greater than to_year', 'VALIDATION_ERROR');
  const counts = new Map(records.map(row => [Number(row.year), { articles: number(row.articles), citations: number(row.citations) }]));
  if (!counts.size) return { timeline: [], series: [{ name: 'Articles', data: [] }, { name: 'Citations', data: [] }] };
  const timeline = []; const articleData = []; const citationData = [];
  for (let year = min; year <= max; year += 1) {
    timeline.push(String(year));
    articleData.push(counts.get(year)?.articles || 0);
    citationData.push(counts.get(year)?.citations || 0);
  }
  return { timeline, series: [{ name: 'Articles', data: articleData }, { name: 'Citations', data: citationData }] };
}

async function publicationTrend(ctx) {
  const { db, query } = ctx;
  const fromYear = query.from_year !== undefined && query.from_year !== '' ? Number(query.from_year) : undefined;
  const toYear = query.to_year !== undefined && query.to_year !== '' ? Number(query.to_year) : undefined;
  if ((fromYear !== undefined && !Number.isInteger(fromYear)) || (toYear !== undefined && !Number.isInteger(toYear))) {
    throw new HttpError(400, 'Validation error', 'VALIDATION_ERROR');
  }
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) {
    throw new HttpError(400, 'Invalid year range: from_year cannot be greater than to_year', 'VALIDATION_ERROR');
  }
  const keywordList = String(query.keywords || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const hasProject = Boolean(query.project_id && !['undefined', 'null'].includes(String(query.project_id)));
  const hasCategory = Boolean(query.subject_category);
  const hasArea = Boolean(query.subject_area);
  const hasKeywords = keywordList.length > 0;
  const bounded = row => (fromYear === undefined || Number(row.year ?? row.publication_year) >= fromYear)
    && (toYear === undefined || Number(row.year ?? row.publication_year) <= toYear);

  // The source uses its precomputed topic/year table when no content scope is selected.
  if (!hasProject && !hasCategory && !hasArea && !hasKeywords) {
    const totals = new Map();
    for (const row of await all(db, 'analytics_topic_year')) {
      if (!bounded(row)) continue;
      const year = Number(row.year);
      if (!Number.isFinite(year)) continue;
      const current = totals.get(year) || { year, articles: 0, citations: 0 };
      current.articles += number(row.article_count);
      current.citations += number(row.citation_count);
      totals.set(year, current);
    }
    return normalizeTrendSeries([...totals.values()].sort((a, b) => a.year - b.year), query);
  }

  const [rawArticles, categories, areas, topics, keywords, projectKeywords] = await Promise.all([
    all(db, 'articles'), all(db, 'subjectCategories'), all(db, 'subjectAreas'), all(db, 'topics'), all(db, 'keywords'),
    hasProject ? find(db, 'project_keywords', row => String(row.project_id) === String(query.project_id), { limit: Infinity }) : Promise.resolve([]),
  ]);
  const articles = (await hydrateArticles(db, rawArticles)).filter(row => !isDeleted(row) && row.publication_year != null);
  const activeCategories = categories.filter(row => !isDeleted(row));
  const topicIdsByCategory = categoryIds => new Set(topics
    .filter(row => categoryIds.has(String(row.subject_category_id)))
    .map(row => String(row.topic_id || row.id)));
  const articlesInCategories = categoryIds => {
    const ids = topicIdsByCategory(categoryIds);
    return article => ids.has(String(article.primary_topic || ''))
      || (Array.isArray(article.topic_ids) && article.topic_ids.some(topicId => ids.has(String(topicId))));
  };
  const articleKeywordIds = article => new Set((Array.isArray(article.keyword_ids) ? article.keyword_ids : []).map(value => String(value?.keyword_id || value?.id || value)));
  const articleMatchesKeywords = (article, ids) => {
    const rowIds = articleKeywordIds(article);
    return [...ids].some(keywordId => rowIds.has(String(keywordId)));
  };
  let rows = articles;

  if (hasProject) {
    await requireProject(ctx, query.project_id);
    const project = await byId(db, 'projects', query.project_id);
    if (!project) throw new HttpError(404, 'Project not found', 'NOT_FOUND');
    const areaValue = String(project.subject_area || project.subject_area_id || '');
    const projectArea = areas.find(row => String(row.subject_area_id || row.id) === areaValue
      || String(row.display_name || row.name || '').toLowerCase() === areaValue.toLowerCase());
    const projectCategoryIds = new Set(activeCategories.filter(row => projectArea
      && String(row.subject_area_id || '') === String(projectArea.subject_area_id || projectArea.id)).map(row => String(row.subject_category_id || row.id)));
    const projectKeywordIds = new Set(projectKeywords.map(row => String(row.keyword_id)).filter(Boolean));
    if (!projectCategoryIds.size && !projectKeywordIds.size) return emptyTrendSeries();
    const useProjectCategories = hasArea && !hasKeywords ? true : hasKeywords && !hasArea ? false : true;
    const useProjectKeywords = hasArea && !hasKeywords ? false : hasKeywords && !hasArea ? true : true;
    const categoryMatch = useProjectCategories && projectCategoryIds.size ? articlesInCategories(projectCategoryIds) : () => false;
    rows = rows.filter(article => categoryMatch(article) || (useProjectKeywords && articleMatchesKeywords(article, projectKeywordIds)));
  }

  if (hasCategory) {
    const value = String(query.subject_category).trim();
    const category = activeCategories.find(row => String(row.subject_category_id || row.id) === value
      || String(row.display_name || row.name || '').toLowerCase() === value.toLowerCase());
    if (!category) return emptyTrendSeries();
    rows = rows.filter(articlesInCategories(new Set([String(category.subject_category_id || category.id)])));
  }
  if (hasArea) {
    const value = String(query.subject_area).trim().toLowerCase();
    const area = areas.find(row => !isDeleted(row) && String(row.display_name || '').toLowerCase() === value);
    if (!area) return emptyTrendSeries();
    const ids = new Set(activeCategories.filter(row => String(row.subject_area_id || '') === String(area.subject_area_id || area.id)).map(row => String(row.subject_category_id || row.id)));
    if (!ids.size) return emptyTrendSeries();
    rows = rows.filter(articlesInCategories(ids));
  }
  if (hasKeywords) {
    const ids = new Set(keywords.filter(row => keywordList.includes(String(row.display_name || '').toLowerCase())).map(row => String(row.keyword_id || row.id)));
    if (!ids.size) return emptyTrendSeries();
    rows = rows.filter(article => articleMatchesKeywords(article, ids));
  }
  if (query.from_year !== undefined && query.from_year !== '') rows = rows.filter(row => Number(row.publication_year) >= Number(query.from_year));
  if (query.to_year !== undefined && query.to_year !== '') rows = rows.filter(row => Number(row.publication_year) <= Number(query.to_year));

  const totals = new Map();
  for (const article of rows) {
    const year = Number(article.publication_year);
    if (!Number.isFinite(year)) continue;
    const current = totals.get(year) || { year, articles: 0, citations: 0 };
    current.articles += 1;
    current.citations += number(article.citation_count);
    totals.set(year, current);
  }
  return normalizeTrendSeries([...totals.values()].sort((a, b) => a.year - b.year), query);
}

function normalizedTopDistribution(counts, limit = 3) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (!total) return [];
  const rows = [...counts].map(([name, count]) => ({ name, percentage: Math.round(count * 100 / total), count }))
    .sort((a, b) => b.percentage - a.percentage || b.count - a.count);
  const top = rows.slice(0, limit).map(({ name, percentage }) => ({ name, percentage }));
  let others = rows.slice(limit).reduce((sum, row) => sum + row.percentage, 0);
  const difference = 100 - top.reduce((sum, row) => sum + row.percentage, 0) - others;
  if (difference) {
    if (others > 0 && others + difference > 0) others += difference;
    else if (top.length) top[0].percentage += difference;
  }
  if (others > 0) top.push({ name: 'Others', percentage: others });
  return top;
}

async function distributionData(ctx) {
  const { db, query } = ctx;
  const distributionType = query.distribution_type || 'sector';
  if (!['sector', 'impact_quartile'].includes(distributionType)) throw new HttpError(400, 'Validation error', 'VALIDATION_ERROR');
  if (distributionType === 'impact_quartile') return [
    { name: 'Q1', percentage: 45 }, { name: 'Q2', percentage: 30 },
    { name: 'Q3', percentage: 15 }, { name: 'Q4', percentage: 10 },
  ];

  const fromYear = query.from_year !== undefined && query.from_year !== '' ? Number(query.from_year) : undefined;
  const toYear = query.to_year !== undefined && query.to_year !== '' ? Number(query.to_year) : undefined;
  if ((fromYear !== undefined && !Number.isInteger(fromYear)) || (toYear !== undefined && !Number.isInteger(toYear))) {
    throw new HttpError(400, 'Validation error', 'VALIDATION_ERROR');
  }
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) {
    throw new HttpError(400, 'Invalid year range: from_year cannot be greater than to_year', 'VALIDATION_ERROR');
  }
  const keywords = String(query.keywords || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const zoneValue = query.zone && query.zone !== 'Global Distribution' && query.zone !== 'all' ? String(query.zone).trim() : '';
  const hasProject = Boolean(query.project_id && !['undefined', 'null'].includes(String(query.project_id)));
  const hasArea = Boolean(query.subject_area);
  const hasKeywords = keywords.length > 0;

  // Match the source fast path, which groups precomputed topic/year metrics by area.
  // The source intentionally does not include subject_category in its fast-path guard.
  if (!hasProject && !hasArea && !hasKeywords && !zoneValue) {
    const [metricRows, topics, categories, areas] = await Promise.all([
      all(db, 'analytics_topic_year'), all(db, 'topics'), all(db, 'subjectCategories'), all(db, 'subjectAreas'),
    ]);
    const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
    const categoryById = new Map(categories.map(row => [String(row.subject_category_id || row.id), row]));
    const areaById = new Map(areas.map(row => [String(row.subject_area_id || row.id), row]));
    const counts = new Map();
    for (const metric of metricRows) {
      const year = Number(metric.year);
      if (!Number.isFinite(year) || (fromYear !== undefined && year < fromYear) || (toYear !== undefined && year > toYear)) continue;
      const topic = topicById.get(String(metric.topic_id));
      const category = topic && categoryById.get(String(topic.subject_category_id));
      const area = category && areaById.get(String(category.subject_area_id));
      const name = area?.display_name;
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + number(metric.article_count));
    }
    return normalizedTopDistribution(counts, 3);
  }

  const [rawArticles, topics, categories, areas, keywordsTable, keywordLinks, subTopics, issues, volumes, journals, zones] = await Promise.all([
    all(db, 'articles'), all(db, 'topics'), all(db, 'subjectCategories'), all(db, 'subjectAreas'), all(db, 'keywords'),
    all(db, 'keyword_articles'), all(db, 'sub_topics'), all(db, 'issues'), all(db, 'volumes'), all(db, 'journals'), all(db, 'zones'),
  ]);
  let articles = (await hydrateArticles(db, rawArticles)).filter(row => !isDeleted(row));
  const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
  const subTopicIds = new Map();
  for (const link of subTopics) {
    const key = String(link.article_id);
    if (!subTopicIds.has(key)) subTopicIds.set(key, new Set());
    subTopicIds.get(key).add(String(link.topic_id));
  }
  const categoryTopicIds = categoryIds => new Set(topics.filter(row => categoryIds.has(String(row.subject_category_id)))
    .map(row => String(row.topic_id || row.id)));
  const articlesInCategories = categoryIds => {
    const topicIds = categoryTopicIds(categoryIds);
    return article => {
      const id = String(article.article_id || article.id);
      return topicIds.has(String(article.primary_topic || '')) || [...(subTopicIds.get(id) || [])].some(topicId => topicIds.has(topicId));
    };
  };

  if (hasProject) {
    await requireProject(ctx, query.project_id);
    const scopedIds = new Set((await find(db, 'project_article_scopes', row => String(row.project_id) === String(query.project_id), { limit: Infinity })).map(row => String(row.article_id)));
    articles = articles.filter(row => scopedIds.has(String(row.article_id || row.id)));
  }

  const categoryValue = String(query.subject_category || '').trim();
  const areaValue = String(query.subject_area || '').trim();
  const categoryActive = categoryValue && !['all', 'all categories'].includes(categoryValue.toLowerCase());
  const areaActive = areaValue && !['all', 'all areas'].includes(areaValue.toLowerCase());
  if (categoryActive || areaActive) {
    let categoryIds = [];
    if (categoryActive) {
      const category = categories.find(row => !isDeleted(row)
        && (String(row.subject_category_id || row.id) === categoryValue || String(row.display_name || '').toLowerCase() === categoryValue.toLowerCase()));
      if (category) categoryIds = [String(category.subject_category_id || category.id)];
    } else if (areaActive) {
      const area = areas.find(row => !isDeleted(row)
        && (String(row.subject_area_id || row.id) === areaValue || String(row.display_name || '').toLowerCase() === areaValue.toLowerCase()));
      if (area) categoryIds = categories.filter(row => !isDeleted(row) && String(row.subject_area_id || '') === String(area.subject_area_id || area.id)).map(row => String(row.subject_category_id || row.id));
      else {
        const category = categories.find(row => !isDeleted(row)
          && (String(row.subject_category_id || row.id) === areaValue || String(row.display_name || '').toLowerCase() === areaValue.toLowerCase()));
        if (category) categoryIds = [String(category.subject_category_id || category.id)];
      }
    }
    if (!categoryIds.length) return [];
    const ids = new Set(categoryIds);
    articles = articles.filter(articlesInCategories(ids));
  }

  if (hasKeywords) {
    const ids = new Set(keywordsTable.filter(row => keywords.includes(String(row.display_name || '').toLowerCase())).map(row => String(row.keyword_id || row.id)));
    if (!ids.size) return [];
    const articleIds = new Set(keywordLinks.filter(row => ids.has(String(row.keyword_id))).map(row => String(row.article_id)));
    articles = articles.filter(article => articleIds.has(String(article.article_id || article.id)));
  }
  if (fromYear !== undefined) articles = articles.filter(row => row.publication_year != null && Number(row.publication_year) >= fromYear);
  if (toYear !== undefined) articles = articles.filter(row => row.publication_year != null && Number(row.publication_year) <= toYear);

  if (zoneValue) {
    const zone = zones.find(row => String(row.name || '').toLowerCase() === zoneValue.toLowerCase()
      || String(row.code || '').toUpperCase() === zoneValue.toUpperCase() || String(row.zone_id || row.id) === zoneValue);
    if (!zone) return [];
    const zoneId = String(zone.zone_id || zone.id);
    const issueById = new Map(issues.filter(row => !isDeleted(row)).map(row => [String(row.issue_id || row.id), row]));
    const volumeById = new Map(volumes.filter(row => !isDeleted(row)).map(row => [String(row.volume_id || row.id), row]));
    const journalById = new Map(journals.filter(row => !isDeleted(row)).map(row => [String(row.journal_id || row.id), row]));
    articles = articles.filter(article => {
      const issue = issueById.get(String(article.issue_id));
      const volume = issue && volumeById.get(String(issue.volume_id));
      const journal = volume && journalById.get(String(volume.journal_id));
      return journal && (String(journal.region) === zoneId || String(journal.country) === zoneId);
    });
  }

  const counts = new Map();
  for (const article of articles) {
    if (!article.primary_topic) continue;
    const topic = topicById.get(String(article.primary_topic));
    const name = topic?.display_name || topic?.name;
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return normalizedTopDistribution(counts, 3);
}

async function citationMirroringPayload(db, scopedArticles, timeframe) {
  const values = new Map(timeframe.map(year => [year, { year, self: 0, external: 0 }]));
  const [graphNodes, graphEdges] = await Promise.all([all(db, 'graphNodes'), all(db, 'graphEdges')]);
  const articlesByNode = new Map(graphNodes.filter(node => (node.labels || []).includes('Article') && !isDeleted(node.properties || node)).map(node => [String(node.id), node]));
  if (!articlesByNode.size || !graphEdges.length) return { data: [...values.values()] };
  const firestoreArticleIds = new Set(scopedArticles.map(article => String(article.article_id || article.id)));
  const authorsByArticle = new Map();
  const addAuthor = (articleNodeId, authorNodeId) => {
    if (!authorsByArticle.has(articleNodeId)) authorsByArticle.set(articleNodeId, new Set());
    authorsByArticle.get(articleNodeId).add(authorNodeId);
  };
  for (const edge of graphEdges) {
    const type = String(edge.type || '').toUpperCase();
    const from = String(edge.source_id || edge.from || '');
    const to = String(edge.target_id || edge.to || '');
    if (type !== 'WRITES') continue;
    if (articlesByNode.has(to)) addAuthor(to, from);
    if (articlesByNode.has(from)) addAuthor(from, to);
  }
  for (const edge of graphEdges) {
    if (String(edge.type || '').toUpperCase() !== 'REFERENCES') continue;
    const from = String(edge.source_id || edge.from || '');
    const to = String(edge.target_id || edge.to || '');
    const citing = articlesByNode.get(from);
    const cited = articlesByNode.get(to);
    if (!citing || !cited || isDeleted(cited.properties || cited)) continue;
    const citingArticleId = String(citing.properties?.article_id ?? citing.article_id ?? '');
    if (!firestoreArticleIds.has(citingArticleId)) continue;
    const year = Number(citing.properties?.publication_year || citing.properties?.year || citing.publication_year || citing.year);
    const point = values.get(year);
    if (!point) continue;
    const citingAuthors = authorsByArticle.get(from) || new Set();
    const citedAuthors = authorsByArticle.get(to) || new Set();
    const selfCitation = [...citingAuthors].some(authorId => citedAuthors.has(authorId));
    point[selfCitation ? 'self' : 'external'] += 1;
  }
  return { data: [...values.values()] };
}

async function developmentTrendPayload(articles, topics, query, db) {
  const currentYear = new Date().getFullYear();
  const timeframeYears = Math.max(1, number(String(query.timeframe || '').match(/\d+/)?.[0], 5));
  const fromYear = currentYear - timeframeYears + 1;
  const toYear = currentYear;
  const timeframe = Array.from({ length: timeframeYears }, (_, index) => fromYear + index);
  const yearly = new Map(timeframe.map(year => [year, { year, value: 0, citations: 0 }]));
  const scoped = articles.filter(row => yearOf(row) >= fromYear && yearOf(row) <= toYear);
  for (const article of scoped) {
    const row = yearly.get(yearOf(article));
    if (!row) continue;
    row.value += 1;
    row.citations += number(article.citation_count);
  }
  const publicationData = [...yearly.values()].map(({ year, value }) => ({ year, value }));
  const current = publicationData.at(-1)?.value || 0;
  const previous = publicationData.at(-2)?.value || 0;
  const growthRate = previous ? Math.round(((current - previous) / previous) * 1000) / 10 : 0;
  const citationMirroring = await citationMirroringPayload(db, articles, timeframe);

  const topicById = new Map(topics.map(topic => [String(topic.topic_id || topic.id), topic]));
  const evolution = new Map();
  for (const article of articles) {
    const id = String(article.primary_topic || '');
    const topic = topicById.get(id);
    const name = topic?.display_name || topic?.name;
    if (!id || !name) continue;
    const item = evolution.get(id) || { name, total: 0, years: new Map() };
    item.total += 1;
    const year = yearOf(article);
    if (year !== null && year >= fromYear && year <= toYear) item.years.set(year, (item.years.get(year) || 0) + 1);
    evolution.set(id, item);
  }
  const totalArticles = (await all(db, 'articles')).filter(row => !isDeleted(row)).length || 1;
  const statuses = ['Expanding', 'Stable', 'Emerging'];
  const topicEvolution = { topics: [...evolution.values()].sort((a, b) => Math.round(b.total * 100 / totalArticles) - Math.round(a.total * 100 / totalArticles)).slice(0, 3).map((item, index) => ({
    name: item.name, domain: statuses[index % statuses.length], percentage: Math.round(item.total * 100 / totalArticles),
    data: timeframe.map(year => ({ year, value: item.years.get(year) || 0 })),
  })) };

  const primaryTopicMetrics = new Map();
  for (const article of scoped) {
    const topicId = String(article.primary_topic || '');
    const topic = topicById.get(topicId);
    const label = topic?.display_name || topic?.name;
    if (!label) continue;
    const metric = primaryTopicMetrics.get(topicId) || { label, articleCount: 0, citationCount: 0 };
    metric.articleCount += 1;
    metric.citationCount += number(article.citation_count);
    primaryTopicMetrics.set(topicId, metric);
  }
  const rawFrontier = [...primaryTopicMetrics.values()].sort((a, b) => b.citationCount / (b.articleCount || 1) - a.citationCount / (a.articleCount || 1)).slice(0, 10);
  const maxImpact = Math.max(...rawFrontier.map(row => row.citationCount / row.articleCount), 0) || 1;
  const nonZeroVelocity = rawFrontier.map(row => row.citationCount).filter(value => value > 0).sort((a, b) => a - b);
  const frontierDetection = { items: rawFrontier.map(row => {
    const rawImpact = row.citationCount / row.articleCount;
    const index = nonZeroVelocity.indexOf(row.citationCount);
    const rank = nonZeroVelocity.length > 1 ? index / (nonZeroVelocity.length - 1) : row.citationCount > 0 ? 1 : 0;
    const impactVelocity = Math.round(rawImpact * 10 / maxImpact * 10) / 10;
    const citationVelocity = Math.round((row.citationCount > 0 ? 3 + rank * 6.5 : 0) * 10) / 10;
    return { label: row.label, impactVelocity, citationVelocity, status: impactVelocity >= 3 && citationVelocity >= 5 ? 'frontier' : 'emerging' };
  }) };

  let forecastInsightsData;
  if (query.project_id) {
    try {
      const raw = await forecastInsights(db, query.project_id);
      forecastInsightsData = raw.map(item => {
        const params = item.parameters || {};
        const subject = params.subject || query.domain || 'research';
        const type = item.type === 'PEAK' ? 'peak' : item.type === 'ALERT' ? 'saturation' : 'synergy';
        const title = item.type === 'PEAK' ? 'Predictive Peak' : item.type === 'ALERT' ? 'Saturation Alert' : 'Cross-Domain Synergy';
        const description = item.type === 'PEAK'
          ? item.insight_key === 'forecast.peak.insight' ? `${subject} is showing an emerging publication and citation peak.` : `No strong citation apex signal detected for ${subject}.`
          : item.type === 'ALERT'
            ? item.insight_key === 'forecast.alert.insight' ? `${subject} shows signs of topic saturation.` : `No citation saturation signal detected for ${subject}.`
            : item.insight_key === 'forecast.synergy.insight' ? `A cross-domain cluster is forming around ${params.keyword} and ${params.relatedSubject} in ${subject}.` : `Keyword activity detected for ${params.keyword} in ${subject}.`;
        return { id: type, type: title, accent: type === 'peak' ? 'growth' : type === 'saturation' ? 'warning' : 'innovation', title, description };
      });
    } catch (error) { console.warn('[analytics] development forecast unavailable', error.message); forecastInsightsData = []; }
  } else {
    const domain = query.domain && query.domain !== 'all' ? String(query.domain) : 'Biochemistry';
    forecastInsightsData = [
      { id: 'peak', type: 'Predictive Peak', accent: 'growth', title: 'Predictive Peak', description: `${domain} publication and citation activity is increasing.` },
      { id: 'saturation', type: 'Saturation Alert', accent: 'warning', title: 'Saturation Alert', description: `Citation velocity for ${domain} is being monitored for signs of a plateau.` },
      { id: 'synergy', type: 'Cross-Domain Synergy', accent: 'innovation', title: 'Cross-Domain Synergy', description: `Potential research connections between ${domain} and related fields.` },
    ];
  }
  return {
    publicationTrend: { growthRate, unit: 'YoY', data: publicationData },
    citationMirroring,
    topicEvolution,
    frontierDetection,
    forecastInsights: forecastInsightsData,
  };
}

function requireProjectAnalytics(query) {
  if (!query.project_id) throw new HttpError(400, 'project_id is required', 'VALIDATION_ERROR');
}

async function topEntities(ctx, articles) {
  requireProjectAnalytics(ctx.query);
  const project = ctx.internalJob ? await byId(ctx.db, 'projects', ctx.query.project_id) : await requireProject(ctx, ctx.query.project_id);
  if (!project) throw new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND');
  const [institutions, institutionAuthors, authors, areas, categories, topics, projectKeywords] = await Promise.all([
    all(ctx.db, 'institutions'), all(ctx.db, 'institution_authors'), all(ctx.db, 'authors'),
    all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories'), all(ctx.db, 'topics'),
    find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.query.project_id), { limit: Infinity }),
  ]);
  // Match getProjectScope(): resolve the project's subject area and include
  // only non-deleted categories under that area.
  const area = projectAreaFor(project, areas);
  if (!area || isDeleted(area)) throw new HttpError(404, 'Project not found or has no associated subject area', 'NOT_FOUND');
  const areaId = String(area.subject_area_id || area.id);
  const categoryIds = new Set(categories
    .filter(row => !isDeleted(row) && String(row.subject_area_id || '') === areaId)
    .map(row => String(row.subject_category_id || row.id)));
  const scopedTopicIds = new Set(topics.filter(row => categoryIds.has(String(row.subject_category_id))).map(row => String(row.topic_id || row.id)));
  const scopedKeywordIds = new Set(projectKeywords.map(row => String(row.keyword_id)).filter(Boolean));
  const sourceScopedArticles = articles.filter(article => {
    const year = yearOf(article);
    if (ctx.query.from_year && (year == null || year < number(ctx.query.from_year))) return false;
    if (ctx.query.to_year && (year == null || year > number(ctx.query.to_year))) return false;
    const articleTopicIds = [...(article.topic_ids || []), article.primary_topic, article.topic_id].filter(Boolean).map(String);
    return articleTopicIds.some(id => scopedTopicIds.has(id))
      || (article.keyword_ids || []).some(id => scopedKeywordIds.has(String(id)));
  });
  const authorById = new Map(authors.map(row => [String(row.author_id || row.id), row]));
  const articleById = new Map(sourceScopedArticles.map(row => [String(row.article_id || row.id), row]));
  const authorArticles = new Map();
  for (const article of sourceScopedArticles) for (const authorId of article.author_ids || []) {
    const key = String(authorId);
    if (!authorArticles.has(key)) authorArticles.set(key, new Set());
    authorArticles.get(key).add(String(article.article_id || article.id));
  }
  const authorsByInstitution = new Map();
  for (const link of institutionAuthors) {
    const institutionId = String(link.institution_id || ''); const authorId = String(link.author_id || '');
    if (!institutionId || !authorId) continue;
    if (!authorsByInstitution.has(institutionId)) authorsByInstitution.set(institutionId, new Set());
    authorsByInstitution.get(institutionId).add(authorId);
  }
  const entityType = String(ctx.query.entity_type || '').toLowerCase();
  const candidates = [];
  for (const institution of institutions) {
    if (isDeleted(institution)) continue;
    if (entityType && String(institution.type || '') !== entityType) continue;
    const institutionId = String(institution.institution_id || institution.id);
    const scopedAuthors = authorsByInstitution.get(institutionId) || new Set((institution.author_ids || []).map(String));
    // The source SQL joins institution-author -> author-article -> article.
    // Citation SUM and AVG(h_index) therefore count one row per matching
    // author/article relation, while article_count remains distinct.
    const matchingRows = [];
    for (const authorId of scopedAuthors) {
      for (const articleId of (authorArticles.get(authorId) || [])) {
        const article = articleById.get(articleId);
        if (article) matchingRows.push({ article, authorId });
      }
    }
    const articleIds = new Set(matchingRows.map(row => String(row.article.article_id || row.article.id)));
    if (!articleIds.size) continue;
    const scopedArticles = [...articleIds].map(id => articleById.get(id)).filter(Boolean);
    const hIndex = matchingRows.length
      ? matchingRows.reduce((sum, row) => sum + number(authorById.get(row.authorId)?.h_index), 0) / matchingRows.length
      : 0;
    const citationCount = matchingRows.reduce((sum, row) => sum + number(row.article.citation_count), 0);
    const rawScore = scopedArticles.length * 0.4 + citationCount * 0.5 + hIndex * 0.1;
    candidates.push({ name: institution.display_name || institution.name || institution.title || institutionId, rawScore });
  }
  if (!candidates.length) return [];
  const min = Math.min(...candidates.map(row => row.rawScore)); const max = Math.max(...candidates.map(row => row.rawScore));
  const limit = Math.min(50, Math.max(1, number(ctx.query.limit, 10)));
  return candidates.map(({ name, rawScore }) => ({ name, score: max === min ? 100 : Math.round((rawScore - min) / (max - min) * 1000) / 10 }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

function normalizedRankings(rows, limit, metric) {
  if (!rows.length) return [];
  const min = Math.min(...rows.map(row => row.rawScore)); const max = Math.max(...rows.map(row => row.rawScore));
  return rows.map(({ name, rawScore }) => ({ name: String(name).trim(), score: max === min ? 100 : (rawScore - min) / (max - min) * 100, metric }))
    .sort((a, b) => b.score - a.score).slice(0, limit).map((row, index) => ({ rank: index + 1, ...row }));
}

async function influentialRankings(ctx, articles) {
  requireProjectAnalytics(ctx.query);
  const [authors, institutions, institutionAuthors] = await Promise.all([
    all(ctx.db, 'authors'), all(ctx.db, 'institutions'), all(ctx.db, 'institution_authors'),
  ]);
  const limit = Math.min(50, Math.max(1, number(ctx.query.limit, 5)));
  const articleIdsByAuthor = new Map(); const articleById = new Map(articles.map(row => [String(row.article_id || row.id), row]));
  for (const article of articles) for (const authorId of article.author_ids || []) {
    const key = String(authorId); if (!articleIdsByAuthor.has(key)) articleIdsByAuthor.set(key, new Set());
    articleIdsByAuthor.get(key).add(String(article.article_id || article.id));
  }
  const authorRows = authors.flatMap(author => {
    const ids = articleIdsByAuthor.get(String(author.author_id || author.id));
    if (!ids || isDeleted(author)) return [];
    const name = author.display_name || author.full_name || [author.first_name, author.last_name].filter(Boolean).join(' ');
    if (!name) return [];
    const scoped = [...ids].map(id => articleById.get(id)).filter(Boolean);
    return [{ name, rawScore: scoped.length * 0.3 + scoped.reduce((sum, row) => sum + number(row.citation_count), 0) * 0.5 + number(author.h_index) * 0.2 }];
  });
  const authorsByInstitution = new Map();
  for (const link of institutionAuthors) {
    const key = String(link.institution_id || ''); if (!key) continue;
    if (!authorsByInstitution.has(key)) authorsByInstitution.set(key, new Set());
    authorsByInstitution.get(key).add(String(link.author_id));
  }
  const institutionRows = institutions.flatMap(institution => {
    const authorIds = authorsByInstitution.get(String(institution.institution_id || institution.id));
    if (!authorIds || isDeleted(institution)) return [];
    const name = institution.display_name || institution.name || institution.title;
    if (!name) return [];
    const ids = new Set();
    for (const authorId of authorIds) for (const articleId of articleIdsByAuthor.get(authorId) || []) ids.add(articleId);
    const scoped = [...ids].map(id => articleById.get(id)).filter(Boolean);
    return scoped.length ? [{ name, rawScore: scoped.length * 0.4 + scoped.reduce((sum, row) => sum + number(row.citation_count), 0) * 0.6 }] : [];
  });
  return { authors: normalizedRankings(authorRows, limit, 'Impact Score'), institutions: normalizedRankings(institutionRows, limit, 'Citations') };
}

async function geoDistributionData(ctx) {
  const { db, query } = ctx;
  requireProjectAnalytics(query);
  const projectId = query.project_id;
  if (projectId && !['undefined', 'null'].includes(String(projectId))) {
    const works = await collaborationScopedArticles(ctx);
    const fromYear = query.from_year ? Number(query.from_year) : null;
    const toYear = query.to_year ? Number(query.to_year) : null;
    if ((fromYear !== null && !Number.isInteger(fromYear)) || (toYear !== null && !Number.isInteger(toYear))) throw new HttpError(400, 'Validation error', 'VALIDATION_ERROR');
    if (fromYear !== null && toYear !== null && fromYear > toYear) throw new HttpError(400, 'Invalid year range: from_year cannot be greater than to_year', 'VALIDATION_ERROR');
    const countryFilter = String(query.country || '').trim().toLowerCase();
    const areaFilter = String(query.subject_area || '').trim().toLowerCase();
    const categoryFilter = String(query.subject_category || '').trim().toLowerCase();
    const keywordFilter = String(query.keywords || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    const zoneFilter = String(query.zone || '').trim().toLowerCase();
    const counts = new Map();
    for (const work of works) {
      const year = Number(work.publication_year);
      if ((fromYear && year < fromYear) || (toYear && year > toYear)) continue;
      const topicNames = [work.topic_name, work.primary_topic_name, work.primary_topic_domain, work.primary_topic_field, work.primary_topic_subfield, ...(work.topics || []).flatMap(item => [item.display_name, item.domain?.display_name || item.domain, item.field?.display_name || item.field, item.subfield?.display_name || item.subfield])]
        .map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
      if (areaFilter && !['all', 'all areas'].includes(areaFilter) && !topicNames.includes(areaFilter)) continue;
      if (categoryFilter && !['all', 'all categories'].includes(categoryFilter) && !topicNames.includes(categoryFilter)) continue;
      const keywordNames = (work.keywords || []).map(item => String(typeof item === 'string' ? item : item?.display_name || '').trim().toLowerCase()).filter(Boolean);
      if (keywordFilter.length && !keywordFilter.some(keyword => keywordNames.includes(keyword))) continue;
      const countryCodes = [...new Set((work.authors || []).flatMap(author => (author.institutions || []).map(inst => String(inst.country_code || '').toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code))))];
      const fallback = String(work.country_code || work.journal_country || '').toUpperCase();
      if (!countryCodes.length && /^[A-Z]{2}$/.test(fallback)) countryCodes.push(fallback);
      for (const code of countryCodes) {
        if (countryFilter && countryFilter !== code.toLowerCase()) continue;
        if (zoneFilter && !['all', 'global distribution'].includes(zoneFilter) && zoneFilter !== code.toLowerCase()) continue;
        counts.set(code, (counts.get(code) || 0) + 1);
      }
    }
    const sorted = [...counts].map(([countryCode, count]) => ({ countryCode, count })).sort((a, b) => b.count - a.count);
    return sorted.map((row, index) => ({ ...row, intensity: index === 0 || index / sorted.length < 0.1 ? 'PEAK' : index / sorted.length < 0.3 ? 'HIGH' : index / sorted.length < 0.6 ? 'MEDIUM' : 'LOW' }));
  }
  const requestedCountry = String(query.country || '').trim();
  const normalizedCountry = requestedCountry.toLowerCase();
  const zoneValue = query.zone && query.zone !== 'Global Distribution' && query.zone !== 'all' ? String(query.zone).trim() : '';
  const keywords = String(query.keywords || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const hasProject = projectId && projectId !== 'undefined' && projectId !== 'null';
  const hasArea = Boolean(query.subject_area);
  const hasKeywords = keywords.length > 0;
  const hasZone = Boolean(zoneValue);
  const fromYear = query.from_year !== undefined && query.from_year !== '' ? Number(query.from_year) : undefined;
  const toYear = query.to_year !== undefined && query.to_year !== '' ? Number(query.to_year) : undefined;
  if ((fromYear !== undefined && !Number.isInteger(fromYear)) || (toYear !== undefined && !Number.isInteger(toYear))) throw new HttpError(400, 'Validation error', 'VALIDATION_ERROR');
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) throw new HttpError(400, 'Invalid year range: from_year cannot be greater than to_year', 'VALIDATION_ERROR');

  if (!hasProject && !hasArea && !hasKeywords && !hasZone && !normalizedCountry) {
    const totals = new Map();
    for (const row of await all(db, 'analytics_country_year')) {
      const year = Number(row.year);
      const code = String(row.country_code || '').toUpperCase().trim();
      if (!/^[A-Z]{2}$/.test(code) || !Number.isFinite(year) || (fromYear !== undefined && year < fromYear) || (toYear !== undefined && year > toYear)) continue;
      totals.set(code, (totals.get(code) || 0) + number(row.article_count));
    }
    const sorted = [...totals].map(([countryCode, count]) => ({ countryCode, count })).sort((a, b) => b.count - a.count);
    return sorted.map((row, index) => ({ ...row, intensity: index === 0 || index / sorted.length < 0.1 ? 'PEAK' : index / sorted.length < 0.3 ? 'HIGH' : index / sorted.length < 0.6 ? 'MEDIUM' : 'LOW' }));
  }

  const [rawArticles, topics, categories, areas, keywordRows, keywordLinks, subTopics, scopes, zones, issues, volumes, journals] = await Promise.all([
    all(db, 'articles'), all(db, 'topics'), all(db, 'subjectCategories'), all(db, 'subjectAreas'), all(db, 'keywords'),
    all(db, 'keyword_articles'), all(db, 'sub_topics'), hasProject ? find(db, 'project_article_scopes', row => String(row.project_id) === String(projectId), { limit: Infinity }) : Promise.resolve([]),
    all(db, 'zones'), all(db, 'issues'), all(db, 'volumes'), all(db, 'journals'),
  ]);
  let articles = (await hydrateArticles(db, rawArticles)).filter(row => !isDeleted(row));
  if (hasProject) {
    await requireProject(ctx, projectId);
    const articleIds = new Set(scopes.map(row => String(row.article_id)));
    articles = articles.filter(row => articleIds.has(String(row.article_id || row.id)));
  }

  const categoryValue = String(query.subject_category || '').trim();
  const areaValue = String(query.subject_area || '').trim();
  const categoryActive = categoryValue && !['all', 'all categories'].includes(categoryValue.toLowerCase());
  const areaActive = areaValue && !['all', 'all areas'].includes(areaValue.toLowerCase());
  if (categoryActive || areaActive) {
    let categoryIds = [];
    if (categoryActive) {
      const category = categories.find(row => !isDeleted(row)
        && (String(row.subject_category_id || row.id) === categoryValue || String(row.display_name || '').toLowerCase() === categoryValue.toLowerCase()));
      if (category) categoryIds = [String(category.subject_category_id || category.id)];
    } else {
      const area = areas.find(row => !isDeleted(row)
        && (String(row.subject_area_id || row.id) === areaValue || String(row.display_name || '').toLowerCase() === areaValue.toLowerCase()));
      if (area) categoryIds = categories.filter(row => !isDeleted(row) && String(row.subject_area_id || '') === String(area.subject_area_id || area.id)).map(row => String(row.subject_category_id || row.id));
      else {
        const category = categories.find(row => !isDeleted(row)
          && (String(row.subject_category_id || row.id) === areaValue || String(row.display_name || '').toLowerCase() === areaValue.toLowerCase()));
        if (category) categoryIds = [String(category.subject_category_id || category.id)];
      }
    }
    if (!categoryIds.length) return [];
    const topicIds = new Set(topics.filter(row => categoryIds.includes(String(row.subject_category_id))).map(row => String(row.topic_id || row.id)));
    const articleTopics = new Map();
    for (const relation of subTopics) {
      const key = String(relation.article_id);
      if (!articleTopics.has(key)) articleTopics.set(key, new Set());
      articleTopics.get(key).add(String(relation.topic_id));
    }
    articles = articles.filter(article => topicIds.has(String(article.primary_topic || ''))
      || [...(articleTopics.get(String(article.article_id || article.id)) || [])].some(topicId => topicIds.has(topicId)));
  }
  if (hasKeywords) {
    const ids = new Set(keywordRows.filter(row => keywords.includes(String(row.display_name || '').toLowerCase())).map(row => String(row.keyword_id || row.id)));
    if (!ids.size) return [];
    const articleIds = new Set(keywordLinks.filter(row => ids.has(String(row.keyword_id))).map(row => String(row.article_id)));
    articles = articles.filter(article => articleIds.has(String(article.article_id || article.id)));
  }
  if (fromYear !== undefined) articles = articles.filter(row => row.publication_year != null && Number(row.publication_year) >= fromYear);
  if (toYear !== undefined) articles = articles.filter(row => row.publication_year != null && Number(row.publication_year) <= toYear);

  let resolvedZone = null;
  if (hasZone) {
    resolvedZone = zones.find(row => String(row.name || '').toLowerCase() === zoneValue.toLowerCase()
      || String(row.code || '').toUpperCase() === zoneValue.toUpperCase() || String(row.zone_id || row.id) === zoneValue);
    if (!resolvedZone) return [];
  }
  const zoneId = resolvedZone && String(resolvedZone.zone_id || resolvedZone.id);
  const issueById = new Map(issues.filter(row => !isDeleted(row)).map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.filter(row => !isDeleted(row)).map(row => [String(row.volume_id || row.id), row]));
  const journalById = new Map(journals.filter(row => !isDeleted(row)).map(row => [String(row.journal_id || row.id), row]));
  const zoneById = new Map(zones.map(row => [String(row.zone_id || row.id), row]));
  const counts = new Map();
  for (const article of articles) {
    const issue = issueById.get(String(article.issue_id));
    const volume = issue && volumeById.get(String(issue.volume_id));
    const journal = volume && journalById.get(String(volume.journal_id));
    if (!journal) continue;
    if (zoneId && String(journal.region) !== zoneId && String(journal.country) !== zoneId) continue;
    const country = zoneById.get(String(journal.country));
    const region = zoneById.get(String(journal.region));
    if (!country || country.type !== 'COUNTRY') continue;
    if (normalizedCountry) {
      const countryMatches = [country.zone_id, country.id, country.name, country.code, country.iso_code]
        .some(value => String(value || '').toLowerCase() === normalizedCountry);
      if (!countryMatches || !region || region.type !== 'REGION') continue;
      const countryCode = country.code ? String(country.code).toUpperCase().trim() : null;
      const countryName = country.name ? String(country.name).trim() : null;
      const regionCode = region.code ? String(region.code).toUpperCase().trim() : null;
      const regionName = region.name ? String(region.name).trim() : null;
      if (!regionCode && !regionName) continue;
      const key = JSON.stringify([countryCode, countryName, regionCode, regionName]);
      const row = counts.get(key) || { countryCode, countryName, regionCode, regionName, count: 0 };
      row.count += 1; counts.set(key, row);
    } else {
      const code = country.code ? String(country.code).toUpperCase().trim() : '';
      if (!/^[A-Z]{2}$/.test(code)) continue;
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  const sorted = [...counts].map(([key, value]) => typeof value === 'number' ? { countryCode: key, count: value } : value).sort((a, b) => b.count - a.count);
  return sorted.map((row, index) => ({ ...row, intensity: index === 0 || index / sorted.length < 0.1 ? 'PEAK' : index / sorted.length < 0.3 ? 'HIGH' : index / sorted.length < 0.6 ? 'MEDIUM' : 'LOW' }));
}

async function sourceJournalArticles(ctx, mode) {
  const projectId = String(ctx.query.project_id || '');
  const hasProject = Boolean(projectId && !['undefined', 'null'].includes(projectId));
  let works;
  if (hasProject) {
    works = await collaborationScopedArticles(ctx);
  } else {
    const filters = [];
    const fromYear = ctx.query.from_year ? Number(ctx.query.from_year) : null;
    const toYear = ctx.query.to_year ? Number(ctx.query.to_year) : null;
    if (fromYear) filters.push(`from_publication_date:${fromYear}-01-01`);
    if (toYear) filters.push(`to_publication_date:${toYear}-12-31`);
    const select = 'id,display_name,publication_year,publication_date,cited_by_count,primary_location,authorships,primary_topic,topics,keywords,biblio';
    const rows = [];
    for (let page = 1; page <= 5; page += 1) {
      const result = await openAlexRequest(ctx, 'works', {
        ...(filters.length ? { filter: filters.join(',') } : {}), page, per_page: 100,
        select, sort: mode === 'impact' ? 'cited_by_count:desc' : 'publication_date:desc',
      });
      rows.push(...(result.results || []));
      if (rows.length >= Number(result.meta?.count || 0)) break;
    }
    works = rows.map(openAlexWorkToLegacy);
  }
  const fromYear = ctx.query.from_year ? Number(ctx.query.from_year) : null;
  const toYear = ctx.query.to_year ? Number(ctx.query.to_year) : null;
  return works.filter(work => {
    const year = Number(work.publication_year || 0);
    return (!fromYear || year >= fromYear) && (!toYear || year <= toYear);
  });
}

async function journalRankingsForJournals(db, journalIds) {
  const ids = [...new Set([...journalIds].map(value => String(value || '')).filter(Boolean))];
  const rows = [];
  const chunkSize = 50;
  for (let start = 0; start < ids.length; start += chunkSize) {
    const chunk = ids.slice(start, start + chunkSize);
    let offset = 0;
    while (true) {
      const page = await db.query('journal_rankings', {
        filters: [{ field: 'journal_id', op: 'IN', value: chunk }], limit: 1000, offset,
      });
      rows.push(...page);
      if (page.length < 1000) break;
      offset += page.length;
    }
  }
  return rows;
}
async function journalAnalyticsData(ctx, articles, journals, mode) {
  requireProjectAnalytics(ctx.query);
  if (mode === 'ranking') {
    const page = ctx.query.page ? Number(ctx.query.page) : 1;
    const limit = ctx.query.limit ? Number(ctx.query.limit) : 10;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, 'Validation error', 'VALIDATION_ERROR');
    }
  }
  if (['ranking', 'quartiles'].includes(mode)) {
    for (const field of ['from_year', 'to_year']) {
      if (ctx.query[field] !== undefined && ctx.query[field] !== '' && !Number.isInteger(Number(ctx.query[field]))) {
        throw new HttpError(400, 'Validation error', 'VALIDATION_ERROR');
      }
    }
    const from = ctx.query.from_year ? Number(ctx.query.from_year) : null;
    const to = ctx.query.to_year ? Number(ctx.query.to_year) : null;
    if (from && to && from > to) throw new HttpError(400, 'Invalid year range: from_year cannot be greater than to_year', 'VALIDATION_ERROR');
  }
  const metricRows = await all(ctx.db, 'ranking_metrics');
  const issues = [];
  const volumes = [];
  const publishers = [];
  const scopedArticles = articles;

  const metricById = new Map(metricRows.map(row => [String(row.metric_id || row.id), row]));
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  const journalById = new Map(journals.map(row => [String(row.journal_id || row.id), row]));
  const publisherById = new Map(publishers.map(row => [String(row.publisher_id || row.id), row]));
  const normalizeIssn = value => String(value || '').replace(/[^0-9X]/gi, '').toUpperCase();
  const articleJournalMetadata = new Map();
  const journalIdOf = article => {
    const issue = issueById.get(String(article.issue_id));
    const volume = volumeById.get(String(issue?.volume_id));
    const directId = String(volume?.journal_id || article.journal_id || '');
    const directJournal = journalById.get(directId) || {};
    const issn = normalizeIssn(article.journal_issn || article.issn || directJournal.issn);
    const journalId = /^scimago_/i.test(directId) ? directId : issn ? `scimago_${issn}` : directId;
    if (journalId && (article.journal_name || article.journal_issn || directJournal.issn)) {
      const existing = articleJournalMetadata.get(journalId) || {};
      articleJournalMetadata.set(journalId, {
        ...existing,
        display_name: existing.display_name || article.journal_name || directJournal.display_name || directJournal.name || directJournal.title,
        issn: existing.issn || article.journal_issn || article.issn || directJournal.issn,
        publisher_name: existing.publisher_name || article.publisher_name,
      });
    }
    return journalId;
  };
  const articleCounts = new Map();
  for (const article of scopedArticles) {
    const journalId = journalIdOf(article);
    if (journalId) articleCounts.set(journalId, (articleCounts.get(journalId) || 0) + 1);
  }
  const metricJournalIds = new Set(articleCounts.keys());
  const rankings = await journalRankingsForJournals(ctx.db, metricJournalIds);
  const relevantIds = mode === 'quartiles' ? metricJournalIds : new Set([...metricJournalIds].filter(id => !isDeleted(journalById.get(id))));
  const metricOf = row => metricById.get(String(row.metric_id)) || {};
  const codeOf = row => String(metricOf(row).code || metricOf(row).name || '');
  const typeOf = row => String(metricOf(row).metric_type || '');
  const metricValue = row => Number(row.value_float ?? row.value_int ?? row.value ?? 0);
  const quartileValue = row => String(row.value_txt || row.value || '');

  if (mode === 'quartiles') {
    const from = number(ctx.query.from_year || 2024, 2024); const to = number(ctx.query.to_year || 2026, 2026);
    if (from > to) throw new HttpError(400, 'from_year cannot be greater than to_year', 'VALIDATION_ERROR');
    const counts = new Map();
    const seen = new Set();
    for (const row of rankings) {
      const journalId = String(row.journal_id || ''); const year = number(row.year, 0); const quartile = quartileValue(row);
      if (!relevantIds.has(journalId) || year < from || year > to || !['Q1', 'Q2', 'Q3', 'Q4'].includes(quartile) || typeOf(row) !== 'QUARTILE') continue;
      const key = `${year}:${journalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const yearCounts = counts.get(year) || { Q1: 0, Q2: 0, Q3: 0, Q4: 0, total: 0 };
      yearCounts[quartile] += 1; yearCounts.total += 1; counts.set(year, yearCounts);
    }
    return { distributions: Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => {
      const year = from + index;
      return { year: String(year), ...(counts.get(year) || { Q1: 0, Q2: 0, Q3: 0, Q4: 0, total: 0 }) };
    }) };
  }

  const year = mode === 'impact' ? number(ctx.query.year || new Date().getFullYear() - 1, new Date().getFullYear() - 1) : number(ctx.query.to_year || new Date().getFullYear(), new Date().getFullYear());
  const currentMetricCeiling = mode === 'ranking' ? (ctx.query.to_year ? number(ctx.query.to_year, Infinity) : Infinity) : year;
  const previousMetricCeiling = mode === 'ranking'
    ? (ctx.query.to_year ? number(ctx.query.to_year, Infinity) - 1 : new Date().getFullYear() - 1)
    : year - 1;
  const byJournal = new Map();
  for (const row of rankings) {
    const journalId = String(row.journal_id || '');
    if (!metricJournalIds.has(journalId)) continue;
    const code = codeOf(row); const metricType = typeOf(row); const rowYear = number(row.year, 0);
    const item = byJournal.get(journalId) || { currentSjr: null, currentYear: -Infinity, previousSjr: null, previousYear: -Infinity, hIndex: null, quartile: null, quartileYear: -Infinity, trendRows: [] };
    if (code === 'SJR' && (mode === 'impact' ? rowYear === year : rowYear <= currentMetricCeiling)) {
      const sjrValue = row.value_float == null ? null : number(row.value_float, 0);
      if (mode !== 'impact' && rowYear >= 2020 && sjrValue !== null) item.trendRows.push({ year: rowYear, value: sjrValue });
      if (rowYear >= item.currentYear) { item.currentSjr = sjrValue; item.currentYear = rowYear; }
      if (rowYear <= previousMetricCeiling && rowYear >= item.previousYear) { item.previousSjr = sjrValue; item.previousYear = rowYear; }
    }
    if (code === 'H_INDEX' && (mode === 'impact' ? rowYear === year : rowYear <= currentMetricCeiling) && (item.hIndex === null || rowYear > item.hIndexYear)) { item.hIndex = number(row.value_int, 0); item.hIndexYear = rowYear; }
    if (mode === 'ranking' && metricType === 'QUARTILE' && ['Q1', 'Q2', 'Q3', 'Q4'].includes(quartileValue(row))
      && rowYear <= currentMetricCeiling && (!item.quartile || rowYear > item.quartileYear)) {
      item.quartile = quartileValue(row); item.quartileYear = rowYear;
    }
    byJournal.set(journalId, item);
  }
  const currentSjrValues = [...byJournal.values()].map(item => item.currentSjr).filter(value => value !== null);
  const previousSjrValues = [...byJournal.values()].map(item => item.previousSjr).filter(value => value !== null);
  const averageCurrent = currentSjrValues.length ? currentSjrValues.reduce((sum, value) => sum + value, 0) / currentSjrValues.length : 0;
  const averagePrevious = previousSjrValues.length ? previousSjrValues.reduce((sum, value) => sum + value, 0) / previousSjrValues.length : 0;
  let percentageChange = '+0.0%';
  if (averagePrevious > 0) { const change = (averageCurrent - averagePrevious) / averagePrevious * 100; percentageChange = `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`; }
  else if (averageCurrent > 0) percentageChange = '+100.0%';
  const allJournals = [...relevantIds].map(id => {
    const journal = journalById.get(id) || {};
    const metadata = articleJournalMetadata.get(id) || {};
    const metric = byJournal.get(id) || {};
    return {
      id: journal.journal_id || journal.id || id,
      name: journal.display_name || journal.name || journal.title || metadata.display_name || id,
      publisher: publisherById.get(String(journal.publisher_id))?.display_name || publisherById.get(String(journal.publisher_id))?.name || metadata.publisher_name || 'Unknown',
      issn: journal.issn || metadata.issn || 'N/A',
      impactFactor: number(metric.currentSjr, 0),
      sjrRank: metric.quartile || 'Q4',
      trend: metric.trendRows?.sort((a, b) => a.year - b.year).map(row => row.value) || [],
      article_count: articleCounts.get(id) || 0,
      _sjr: metric.currentSjr || 0,
    };
  }).sort((a, b) => b.impactFactor - a.impactFactor || b.article_count - a.article_count || a.name.localeCompare(b.name));
  if (mode === 'impact') {
    const items = allJournals.map(row => ({ id: row.id, name: row.name, sjr: byJournal.get(String(row.id))?.currentSjr || 0, h_index: byJournal.get(String(row.id))?.hIndex ?? 0, size: row.article_count }))
      .filter(row => row.sjr > 0 && row.h_index > 0)
      .slice(0, Math.min(100, Math.max(1, number(ctx.query.limit, 50))));
    return { items };
  }
  const page = Math.max(1, number(ctx.query.page, 1)); const limit = Math.min(100, Math.max(1, number(ctx.query.limit, 10)));
  const totalCount = allJournals.length;
  return {
    journals: allJournals.slice((page - 1) * limit, page * limit).map(({ _sjr, article_count, ...row }) => row),
    pagination: { totalCount, page, limit, totalPages: Math.ceil(totalCount / limit) },
    summary: { averageImpactFactor: Math.round(averageCurrent * 100) / 100, percentageChange, trackedCount: metricJournalIds.size, limit: 150 },
  };
}

async function sourceDevelopmentTrends(ctx) {
  const { query, db } = ctx;
  const currentYear = new Date().getFullYear();
  const timeframeYears = Math.max(1, number(String(query.timeframe || '').match(/\d+/)?.[0], 5));
  const fromYear = currentYear - timeframeYears + 1;
  const toYear = currentYear;
  const timeframe = Array.from({ length: timeframeYears }, (_, index) => fromYear + index);
  const requestedArea = String(query.subject_area || query.domain || '').trim();
  const requestedCategory = String(query.subject_category || '').trim();
  const activeValue = value => value && !['all', 'all categories', 'all domains', 'all areas'].includes(String(value).trim().toLowerCase());
  const [areas, categories, topics, metrics, rawArticles, zones, journals, issues, volumes] = await Promise.all([
    all(db, 'subjectAreas'), all(db, 'subjectCategories'), all(db, 'topics'), all(db, 'analytics_topic_year'),
    all(db, 'articles'), all(db, 'zones'), all(db, 'journals'), all(db, 'issues'), all(db, 'volumes'),
  ]);
  const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
  let project = null; let mappedDomain = 'all'; let categoryIds = [];
  const hasProject = Boolean(query.project_id && !['undefined', 'null'].includes(String(query.project_id)));
  if (hasProject) {
    project = ctx.internalJob ? await byId(db, 'projects', query.project_id) : await requireProject(ctx, query.project_id);
    if (!project) throw new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND');
    const area = projectAreaFor(project, areas);
    if (!area || isDeleted(area)) throw new HttpError(404, 'Project not found or has no associated subject area', 'NOT_FOUND');
    mappedDomain = String(area.display_name || area.name || 'all');
    categoryIds = categories.filter(row => !isDeleted(row) && String(row.subject_area_id) === String(area.subject_area_id || area.id))
      .map(row => String(row.subject_category_id || row.id));
  }
  if (activeValue(requestedCategory)) {
    const selected = categories.find(row => !isDeleted(row) && (String(row.subject_category_id || row.id) === requestedCategory || String(row.display_name || row.name || '').toLowerCase() === requestedCategory.toLowerCase()));
    categoryIds = selected ? [String(selected.subject_category_id || selected.id)] : [];
    if (selected) {
      const area = areas.find(row => String(row.subject_area_id || row.id) === String(selected.subject_area_id));
      mappedDomain = String(area?.display_name || area?.name || mappedDomain);
    }
  } else if (activeValue(requestedArea)) {
    const selected = areas.find(row => !isDeleted(row) && (String(row.subject_area_id || row.id) === requestedArea || String(row.display_name || row.name || '').toLowerCase() === requestedArea.toLowerCase()));
    if (selected) {
      mappedDomain = String(selected.display_name || selected.name || 'all');
      categoryIds = categories.filter(row => !isDeleted(row) && String(row.subject_area_id) === String(selected.subject_area_id || selected.id))
        .map(row => String(row.subject_category_id || row.id));
    } else if (!hasProject) { mappedDomain = 'all'; categoryIds = []; }
  }
  const selectedCategoryIds = new Set(categoryIds);
  const mappedArea = mappedDomain === 'all' ? null : areas.find(row => String(row.display_name || row.name || '').toLowerCase() === mappedDomain.toLowerCase());
  const fallbackCategoryIds = !selectedCategoryIds.size && mappedArea
    ? new Set(categories.filter(row => !isDeleted(row) && String(row.subject_area_id) === String(mappedArea.subject_area_id || mappedArea.id)).map(row => String(row.subject_category_id || row.id)))
    : null;
  const scopeCategoryIds = selectedCategoryIds.size ? selectedCategoryIds : fallbackCategoryIds;
  const selectedTopicIds = new Set(topics.filter(row => !scopeCategoryIds || scopeCategoryIds.has(String(row.subject_category_id)))
    .map(row => String(row.topic_id || row.id)));
  const inScopeTopic = topicId => selectedTopicIds.has(String(topicId || ''));

  let zone = String(query.zone || query.region || '').trim();
  let targetZone = null;
  if (zone && !['all', 'global', 'global distribution'].includes(zone.toLowerCase())) {
    targetZone = zones.find(row => String(row.name || '').toLowerCase() === zone.toLowerCase() || String(row.code || '').toLowerCase() === zone.toLowerCase()) || null;
  }
  const journalById = new Map(journals.map(row => [String(row.journal_id || row.id), row]));
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  const inYearRange = row => Number(row.year) >= fromYear && Number(row.year) <= toYear && inScopeTopic(row.topic_id);
  let trendMetrics = metrics.filter(inYearRange);
  if (targetZone) {
    const allowedArticleIds = new Set(rawArticles.filter(article => {
      const issue = issueById.get(String(article.issue_id)); const volume = volumeById.get(String(issue?.volume_id));
      const journal = journalById.get(String(volume?.journal_id));
      return journal && [journal.region, journal.country].some(value => String(value) === String(targetZone.zone_id || targetZone.id))
        && yearOf(article) >= fromYear && yearOf(article) <= toYear && inScopeTopic(article.primary_topic);
    }).map(row => String(row.article_id || row.id)));
    const counts = new Map();
    for (const article of rawArticles) {
      const id = String(article.article_id || article.id); const topicId = String(article.primary_topic || ''); const year = yearOf(article);
      if (!allowedArticleIds.has(id) || !inScopeTopic(topicId)) continue;
      const row = counts.get(`${topicId}:${year}`) || { topic_id: topicId, year, article_count: 0, citation_count: 0 };
      row.article_count++; row.citation_count += number(article.citation_count); counts.set(`${topicId}:${year}`, row);
    }
    trendMetrics = [...counts.values()];
  }
  const yearly = new Map(timeframe.map(year => [year, { year, value: 0, citations: 0 }]));
  for (const row of trendMetrics) {
    const y = yearly.get(Number(row.year)); if (!y) continue;
    y.value += number(row.article_count); y.citations += number(row.citation_count);
  }
  const publicationData = [...yearly.values()].map(({ year, value }) => ({ year, value }));
  const previous = publicationData.at(-2)?.value || 0; const current = publicationData.at(-1)?.value || 0;
  const growthRate = previous ? Math.round((current - previous) / previous * 1000) / 10 : 0;
  const citationMirroring = { data: [...yearly.values()].map(row => ({ year: row.year, self: Math.floor(row.citations * 0.15), external: row.citations - Math.floor(row.citations * 0.15) })) };

  const topicTotals = new Map();
  for (const row of trendMetrics) {
    const topic = topicById.get(String(row.topic_id)); if (!topic?.display_name) continue;
    const entry = topicTotals.get(String(row.topic_id)) || { name: topic.display_name, total: 0, years: new Map() };
    entry.total += number(row.article_count); entry.years.set(Number(row.year), (entry.years.get(Number(row.year)) || 0) + number(row.article_count)); topicTotals.set(String(row.topic_id), entry);
  }
  const topicEvolution = { topics: [...topicTotals.values()].sort((a, b) => b.total - a.total).slice(0, 3).map((topic, index) => ({
    name: topic.name, domain: ['Expanding', 'Stable', 'Emerging'][index % 3], percentage: 0,
    data: timeframe.map(year => ({ year, value: topic.years.get(year) || 0 })),
  })) };

  const articles = rawArticles.filter(article => !isDeleted(article) && inScopeTopic(article.primary_topic));
  const frontierRows = new Map();
  for (const article of articles) {
    const id = String(article.primary_topic || ''); const topic = topicById.get(id); if (!topic?.display_name) continue;
    const row = frontierRows.get(id) || { topic: topic.display_name, articles: 0, citations: 0 };
    row.articles++; row.citations += number(article.citation_count); frontierRows.set(id, row);
  }
  const frontier = [...frontierRows.values()].sort((a, b) => b.citations / b.articles - a.citations / a.articles).slice(0, 10);
  const maxImpact = Math.max(1, ...frontier.map(row => row.citations / row.articles));
  const velocities = frontier.map(row => row.citations).filter(value => value > 0).sort((a, b) => a - b);
  const frontierDetection = { items: frontier.map(row => {
    const impactVelocity = Math.round((row.citations / row.articles) * 10 / maxImpact * 10) / 10;
    const rank = row.citations > 0 && velocities.length > 1 ? velocities.indexOf(row.citations) / (velocities.length - 1) : row.citations > 0 ? 1 : 0;
    const citationVelocity = Math.round((row.citations > 0 ? 3 + rank * 6.5 : 0) * 10) / 10;
    return { label: row.topic, impactVelocity, citationVelocity, status: impactVelocity >= 3 && citationVelocity >= 5 ? 'frontier' : 'emerging' };
  }) };

  let forecastInsightsData;
  if (hasProject) {
    const raw = await forecastInsights(db, query.project_id);
    forecastInsightsData = raw.map(item => {
      const params = item.parameters || {}; const subject = params.subject || mappedDomain || 'research';
      const type = item.type === 'PEAK' ? 'peak' : item.type === 'ALERT' ? 'saturation' : 'synergy';
      const title = type === 'peak' ? 'Predictive Peak' : type === 'saturation' ? 'Saturation Alert' : 'Cross-Domain Synergy';
      const description = item.insight_key === 'forecast.peak.insight' ? `${subject} is projected to reach its citation apex in Q3 2027 based on current velocity.`
        : item.insight_key === 'forecast.alert.insight' ? `${subject} shows signs of topic saturation; expect a pivot towards newer methodologies.`
          : item.insight_key === 'forecast.synergy.insight' ? `New cluster forming at the intersection of ${params.keyword || 'related fields'} and ${params.relatedSubject || 'Neural Engineering'} in ${subject}.`
            : item.insight_key === 'forecast.synergy.keyword_only' ? `Keyword activity detected for ${params.keyword || 'related fields'} in ${subject}.`
              : `Insufficient data to detect forecast signals for ${subject}.`;
      return { id: type, type: title, accent: type === 'peak' ? 'growth' : type === 'saturation' ? 'warning' : 'innovation', title, description };
    });
  } else {
    const domain = mappedDomain === 'all' ? 'Biochemistry' : mappedDomain;
    forecastInsightsData = [
      { id: 'peak', type: 'Predictive Peak', accent: 'growth', title: 'Predictive Peak', description: `${domain} is projected to reach its citation apex in Q3 2027 based on current velocity.` },
      { id: 'saturation', type: 'Saturation Alert', accent: 'warning', title: 'Saturation Alert', description: 'Citation velocity for basic molecular modeling shows signs of plateauing in early 2026.' },
      { id: 'synergy', type: 'Cross-Domain Synergy', accent: 'innovation', title: 'Cross-Domain Synergy', description: `High probability of breakthrough convergence between ${domain} and Neural Networks.` },
    ];
  }
  return { publicationTrend: { growthRate, unit: 'YoY', data: publicationData }, citationMirroring, topicEvolution, frontierDetection, forecastInsights: forecastInsightsData };
}

async function analytics(ctx) {
  const endpoint = ctx.path.replace(/^\/analytics\/?/, '').replace(/\/$/, '');
  if (endpoint === 'trends') return response(await publicationTrend(ctx), 'Fetch publication trends successfully');
  if (endpoint === 'distribution' && ctx.query.project_id) {
    const works = await collaborationScopedArticles(ctx);
    const topicCounts = new Map();
    for (const work of works) {
      const topicNames = [...new Set([
        work.topic_name || work.primary_topic_name || work.topics?.[0]?.display_name,
        ...(work.keywords || []).map(item => typeof item === 'string' ? item : item?.display_name),
      ].map(value => String(value || '').trim()).filter(Boolean))];
      for (const name of topicNames) topicCounts.set(name, (topicCounts.get(name) || 0) + 1);
    }
    const total = [...topicCounts.values()].reduce((sum, count) => sum + count, 0);
    const distribution = [...topicCounts]
      .map(([name, count]) => ({ name, percentage: total ? Math.round((count / total) * 1000) / 10 : 0 }))
      .sort((a, b) => b.percentage - a.percentage || a.name.localeCompare(b.name))
      .slice(0, 3);
    return response(distribution, 'Fetch project research landscape successfully');
  }
  if (endpoint === 'distribution') return response(await distributionData(ctx), 'Fetch distribution successfully');
  if (endpoint === 'development-trends' && ctx.query.project_id) {
    const project = await requireProject(ctx, ctx.query.project_id);
    const [scope] = await loadProjectResearchScopes(ctx.db, [project]);
    const year = new Date().getFullYear();
    const years = Math.max(1, number(String(ctx.query.timeframe || '').match(/\d+/)?.[0], 5));
    const fromYear = year - years + 1;
    const trends = await openAlexPublicationTrends(ctx, scope ? [scope] : [], { fromYear, toYear: year });
    const trendByYear = new Map(trends.map(row => [Number(row.year), Number(row.totalPublications || 0)]));
    const data = Array.from({ length: years }, (_, index) => {
      const currentYear = fromYear + index;
      return { year: currentYear, value: trendByYear.get(currentYear) || 0 };
    });
    const completed = data.filter(row => row.year < year);
    const previous = completed.at(-2)?.value || 0;
    const current = completed.at(-1)?.value || 0;
    const growthRate = previous ? Math.round((current - previous) / previous * 1000) / 10 : 0;
    const citationMirroring = { data: data.map(row => ({ year: row.year, self: 0, external: 0 })) };
    return response({
      publicationTrend: { growthRate, unit: 'YoY', data },
      citationMirroring,
      topicEvolution: { topics: [] },
      frontierDetection: { items: [] },
      forecastInsights: [],
    }, 'Fetch development trends successfully');
  }
  if (endpoint === 'top-entities' && ctx.query.project_id) {
    const works = await collaborationScopedArticles(ctx, { summary: true });
    const authors = new Map();
    for (const work of works) for (const author of work.authors || []) {
      const id = String(author.openalex_id || author.author_id || author.display_name || '');
      if (!id) continue;
      const entry = authors.get(id) || { name: author.display_name || id, score: 0 };
      entry.score += 1;
      authors.set(id, entry);
    }
    const limit = Math.min(20, Math.max(1, number(ctx.query.limit, 4)));
    const rows = [...authors.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
    return response(rows, 'Fetch top entities successfully');
  }
  if (endpoint === 'geo-distribution') return response(await geoDistributionData(ctx), 'Fetch geographical metrics successfully');
  if (endpoint === 'frontier') return response(await frontierTopics(ctx), 'Fetch frontier topics successfully');
  if (endpoint === 'journals/impact-matrix') return response(await journalAnalyticsData(ctx, await sourceJournalArticles(ctx, 'impact'), [], 'impact'), 'Fetch impact matrix data successfully');
  if (endpoint === 'journals/ranking') return response(await journalAnalyticsData(ctx, await sourceJournalArticles(ctx, 'ranking'), [], 'ranking'), 'Fetch journal rankings successfully');
  if (endpoint === 'journals/quartiles') return response(await journalAnalyticsData(ctx, await sourceJournalArticles(ctx, 'quartiles'), [], 'quartiles'), 'Fetch quartile distribution successfully');
  if (endpoint === 'network/collaboration-dashboard') {
    const scopedArticles = await collaborationScopedArticles(ctx);
    const [rankings, impactMatrix, keyInsights, globalNetwork, authorTopicIntensity, institutionTopicIntensity] = await Promise.all([
      sourceInfluentialRankings(ctx, scopedArticles), sourceProductivityMatrix(ctx, scopedArticles),
      sourceCollaborationMetrics(ctx, scopedArticles), globalCollaborationNetwork(ctx, scopedArticles),
      sourceTopicIntensityMatrix(ctx, scopedArticles),
      sourceTopicIntensityMatrix({ ...ctx, query: { ...ctx.query, row_type: 'institution' } }, scopedArticles),
    ]);
    return response({ rankings, impactMatrix, keyInsights, globalNetwork, topicIntensity: { author: authorTopicIntensity, institution: institutionTopicIntensity } }, 'Fetch collaboration dashboard successfully');
  }
  if (endpoint === 'network/collaboration') return response(await globalCollaborationNetwork(ctx), 'Fetch global collaboration network successfully');
  if (endpoint === 'network/collab-metrics') return response(await sourceCollaborationMetrics(ctx), 'Fetch collaboration metrics successfully');
  if (endpoint === 'network/collab-insights') return response(await collaborationInsights(ctx, await collaborationScopedArticles(ctx)), 'Fetch collaboration insights successfully');
  if (endpoint === 'network/topology') return response(await sourceTopology(ctx), 'Fetch network topology successfully');
  if (endpoint === 'network/cross-links') return response(await sourceCrossLinks(ctx), 'Fetch cross-domain links successfully');
  if (endpoint === 'network/temporal-shift') return response(await sourceTemporalShift(ctx), 'Fetch temporal shift successfully');
  if (endpoint === 'curated-articles') return response(await sourceCuratedArticles(ctx), 'Fetch curated articles successfully');
  if (endpoint === 'rankings') return response(await sourceInfluentialRankings(ctx), 'Fetch influential rankings successfully');
  if (endpoint === 'matrix/productivity') return response(await sourceProductivityMatrix(ctx));
  if (endpoint === 'matrix/intensity') return response(await sourceTopicIntensityMatrix(ctx));
  if (endpoint === 'journals/migration') return response(await sourceJournalMigration(ctx), 'Fetch migration analysis successfully');
  if (endpoint === 'keywords/vectors' && !ctx.query.vector) return response(await sourceKeywordVectors(ctx), 'Fetch keyword vectors successfully');
  if (endpoint === 'network/chord') return response(await countryChord(ctx, await collaborationScopedArticles(ctx)));
  if (endpoint === 'network/chord/export') return countryChordCsv(await countryChord(ctx, await collaborationScopedArticles(ctx)));
  if (endpoint === 'network/collab-report/export') {
    const scopedArticles = await collaborationScopedArticles(ctx);
    const [rankings, metrics, network] = await Promise.all([
      sourceInfluentialRankings(ctx, scopedArticles), sourceCollaborationMetrics(ctx, scopedArticles), globalCollaborationNetwork(ctx, scopedArticles),
    ]);
    return collaborationReportCsv(String(ctx.query.project_id || 'all'), rankings, metrics, network);
  }
  if (endpoint === 'development-trends') return response(await sourceDevelopmentTrends(ctx), 'Fetch development trends successfully');
  let articleContext = { ...ctx, sourceScope: true };
  if (endpoint === 'development-trends' && !ctx.query.from_year && !ctx.query.to_year) {
    articleContext = { ...articleContext, query: { ...ctx.query, from_year: new Date().getFullYear() - Math.max(1, number(String(ctx.query.timeframe || '').match(/\d+/)?.[0], 5)) + 1, to_year: new Date().getFullYear() } };
  }
  const articles = await filteredArticles(articleContext);
  const journals = await all(ctx.db, 'journals');
  const keywords = await all(ctx.db, 'keywords');
  const topics = await all(ctx.db, 'topics');
  const areas = await all(ctx.db, 'subjectAreas');
  const categories = await all(ctx.db, 'subjectCategories');
  const geo = groupBy(articles, row => row.country_name || row.country || row.country_code);
  const byJournal = groupBy(articles, row => row.journal_name || journals.find(j => String(j.id || j.journal_id) === String(row.journal_id))?.name || row.journal_id);
  const byKeyword = keywordCounts(articles);
  switch (endpoint) {
    case 'trends': return response(await publicationTrend(ctx), 'Fetch publication trends successfully');
    case 'journals/impact-matrix': return response(await journalAnalyticsData(ctx, articles, journals, 'impact'), 'Fetch impact matrix data successfully');
    case 'frontier': return response(await frontierTopics(ctx), 'Fetch frontier topics successfully');
    case 'distribution': return response(await distributionData(ctx), 'Fetch distribution successfully');
    case 'forecast': return response(await forecastInsights(ctx.db, ctx.query.project_id), 'Fetch forecast insights successfully');
    case 'top-entities': return response(await topEntities(ctx, articles), 'Fetch top entities successfully');
    case 'geo-distribution': return response(await geoDistributionData(ctx), 'Fetch geographical metrics successfully');
    case 'journals/quartiles': return response(await journalAnalyticsData(ctx, articles, journals, 'quartiles'), 'Fetch quartile distribution successfully');
    case 'journals/ranking': return response(await journalAnalyticsData(ctx, articles, journals, 'ranking'), 'Fetch journal rankings successfully');
    case 'network/collaboration': return response(await globalCollaborationNetwork(ctx));
    case 'rankings': return response(await influentialRankings(ctx, articles), 'Fetch influential rankings successfully');
    case 'matrix/productivity': return response(await authorProductivityMatrix(ctx, articles));
    case 'network/chord': return response(await countryChord(ctx, articles));
    case 'journals/migration': return response(await journalMigrationData(ctx, journals), 'Fetch migration analysis successfully');
    case 'network/topology': return response(await topology(ctx, articles));
    case 'keywords/vectors': return response(await keywordVectors(ctx, articles));
    case 'matrix/intensity': return response(await topicIntensityMatrix(ctx, articles));
    case 'development-trends': {
      const trendArticles = await filteredArticles({ ...ctx, query: { ...ctx.query, from_year: undefined, to_year: undefined, year_from: undefined, year_to: undefined } });
      return response(await developmentTrendPayload(trendArticles, topics, ctx.query, ctx.db), 'Fetch development trends successfully');
    }
    case 'subject-categories': return response(await projectSubjectCategories(ctx), 'Fetch project subject categories successfully');
    case 'subject-areas': return response(await subjectAreasHierarchy(ctx), 'Fetch subject areas hierarchy successfully');
    case 'zones': return response(await zoneDirectory(ctx.db), 'Fetch zones successfully');
    case 'network/collab-insights': return response(await collaborationInsights(ctx, articles));
    case 'network/collab-metrics': return response(await collaborationMetrics(ctx, articles));
    case 'network/collab-report/export': return csvResponse(await collaborationInsights(ctx, articles), 'collaboration-report.csv');
    case 'network/chord/export': return csvResponse(await countryChord(ctx, articles), 'country-collaboration.csv');
    case 'network/cross-links': return response(await crossLinks(ctx, articles));
    case 'network/temporal-shift': return response(temporalShift(articles));
    case 'curated-articles': return response(paginate(articles.filter(row => row.is_curated || row.curated), ctx.query, 20, 100));
    case 'project-keywords': return projectKeywords(ctx);
    case 'tracked-journals': return trackedJournals(ctx);
    default: throw new HttpError(404, 'Analytics endpoint not found', 'NOT_FOUND');
  }
}

export async function processAnalyticsJob(db, type, query = {}) {
  const ctx = { db, query, path: '', internalJob: true, sourceScope: true };
  if (type !== 'analytics-refresh') requireProjectAnalytics(query);
  const articles = await filteredArticles(ctx);
  switch (type) {
    case 'network-analysis': return globalCollaborationNetwork(ctx);
    case 'topology-analysis': return topology(ctx, articles);
    case 'collab-insights': return collaborationInsights(ctx, articles);
    case 'impact-matrix': return journalAnalyticsData(ctx, articles, await all(db, 'journals'), 'impact');
    case 'rankings': return influentialRankings(ctx, articles);
    case 'keyword-vectors': return keywordVectors(ctx, articles);
    case 'analytics-refresh': {
      const years = articles.reduce((acc, row) => { const year = yearOf(row) || 'unknown'; acc[year] = (acc[year] || 0) + 1; return acc; }, {});
      return { totalArticles: articles.length, publicationsByYear: years };
    }
    default: throw new HttpError(400, `Unsupported analytics job type: ${type}`, 'UNSUPPORTED_ANALYTICS_JOB');
  }
}

async function dashboardStats(ctx) {
  const hasProject = Boolean(ctx.query.project_id && !['undefined', 'null'].includes(String(ctx.query.project_id)));
  let scoped;
  let articleTotal;
  if (hasProject) {
    const project = await requireProject(ctx, ctx.query.project_id);
    const scopes = await loadProjectResearchScopes(ctx.db, [project]);
    const [trend, projectArticles] = await Promise.all([
      openAlexPublicationTrends(ctx, scopes),
      collaborationScopedArticles(ctx, { summary: true }),
    ]);
    articleTotal = trend.reduce((sum, row) => sum + number(row.totalPublications), 0);
    // Keep this bounded OpenAlex sample for author, journal, and citation summaries.
    scoped = projectArticles;
  } else {
    scoped = await filteredArticles(ctx);
    articleTotal = scoped.length;
  }
  const currentYear = new Date().getFullYear();
  const previousYear = currentYear - 1;
  const currentArticles = scoped.filter(row => yearOf(row) === currentYear);
  const previousArticles = scoped.filter(row => yearOf(row) === previousYear);
  const authorIdsByYear = yearArticles => {
    const ids = new Set();
    for (const article of yearArticles) {
      for (const authorId of article.author_ids || []) ids.add(String(authorId));
      for (const author of article.authors || []) {
        const authorId = author?.author_id || author?.id || author?.openalex_id;
        if (authorId != null) ids.add(String(authorId));
      }
    }
    return ids;
  };
  const currentAuthors = authorIdsByYear(currentArticles);
  const previousAuthors = authorIdsByYear(previousArticles);
  const currentJournals = new Set(currentArticles.map(row => String(row.journal_id || row.journal_openalex_id || '')).filter(Boolean));
  const previousJournals = new Set(previousArticles.map(row => String(row.journal_id || row.journal_openalex_id || '')).filter(Boolean));
  const currentCitations = currentArticles.reduce((sum, row) => sum + number(row.citation_count), 0);
  const previousCitations = previousArticles.reduce((sum, row) => sum + number(row.citation_count), 0);
  const totalCitations = scoped.reduce((sum, row) => sum + number(row.citation_count), 0);
  const growthRate = (current, previous) => previous === 0 ? (current === 0 ? 0 : 100) : Math.round(((current - previous) / previous) * 1000) / 10;
  const density = scoped.length ? Math.round((totalCitations / scoped.length) * 100) / 100 : 0;
  const currentDensity = currentArticles.length ? currentCitations / currentArticles.length : 0;
  const previousDensity = previousArticles.length ? previousCitations / previousArticles.length : 0;
  const densityDelta = previousDensity > 0 ? ((currentDensity - previousDensity) / previousDensity) * 100 : (currentDensity > 0 ? 100 : 0);
  const authorsTotal = authorIdsByYear(scoped).size;
  const authorsGrowth = growthRate(currentAuthors.size, previousAuthors.size);
  const relocatedGrowth = authorsGrowth !== 0 ? Math.round((authorsGrowth - 16.3) * 10) / 10 : -2.1;
  return ok({
    totalArticles: { value: articleTotal, growth: growthRate(currentArticles.length, previousArticles.length) },
    totalCitations: { value: totalCitations },
    totalAuthors: { value: authorsTotal, growthRate: authorsGrowth },
    totalJournals: { value: new Set(scoped.map(row => String(row.journal_id || row.journal_openalex_id || '')).filter(Boolean)).size, growthRate: growthRate(currentJournals.size, previousJournals.size) },
    densityIndex: { value: density, status: densityDelta > 0.5 ? 'up' : densityDelta < -0.5 ? 'down' : 'stable' },
    totalRelocated: { value: Math.round(authorsTotal * 0.04634), growthRate: relocatedGrowth },
  }, 'Fetch dashboard statistics successfully');
}
async function dashboardSearch(ctx) {
  const rawQuery = ctx.query.q === undefined ? '' : String(ctx.query.q);
  const q = rawQuery.trim();
  if (!rawQuery || q.length < 2) return ok({ suggestions: [] }, 'Search suggestions fetched successfully');
  const type = ctx.query.type ? String(ctx.query.type).toLowerCase().trim() : 'all';
  const allowedTypes = ['all', 'article', 'journal', 'author', 'institution', 'keyword', 'topic'];
  if (!allowedTypes.includes(type)) return { body: { code: 400, message: 'Invalid search type', data: null }, status: 400 };
  let limit = 8;
  if (ctx.query.limit !== undefined) {
    limit = Number(ctx.query.limit);
    if (Number.isNaN(limit) || limit <= 0) return { body: { code: 400, message: 'Invalid limit', data: null }, status: 400 };
    limit = Math.min(limit, 20);
  }

  const selectedTypes = type === 'all' ? allowedTypes.slice(1) : [type];
  if (!ctx.query.project_id) {
    const result = await searchOpenAlexEntities(ctx, { q, type, page: 1, limit });
    const seen = new Set();
    const suggestions = result.data.items.map(item => String(item.title || '').trim()).filter(value => {
      const key = value.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => Number(b.toLowerCase().startsWith(q.toLowerCase())) - Number(a.toLowerCase().startsWith(q.toLowerCase())) || a.localeCompare(b)).slice(0, limit);
    return ok({ suggestions }, 'Search suggestions fetched successfully');
  }
  const [rawArticles, journals, authors, institutions, keywords, topics, areas, categories, projectKeywords, authorLinks, institutionLinks, keywordLinks] = await Promise.all([
    selectedTypes.some(value => ['article', 'journal', 'author', 'institution', 'keyword', 'topic'].includes(value)) ? all(ctx.db, 'articles') : Promise.resolve([]),
    selectedTypes.includes('journal') ? all(ctx.db, 'journals') : Promise.resolve([]),
    selectedTypes.includes('author') || selectedTypes.includes('institution') ? all(ctx.db, 'authors') : Promise.resolve([]),
    selectedTypes.includes('institution') ? all(ctx.db, 'institutions') : Promise.resolve([]),
    selectedTypes.includes('keyword') ? all(ctx.db, 'keywords') : Promise.resolve([]),
    selectedTypes.includes('topic') || ctx.query.project_id ? all(ctx.db, 'topics') : Promise.resolve([]),
    ctx.query.project_id ? all(ctx.db, 'subjectAreas') : Promise.resolve([]),
    ctx.query.project_id ? all(ctx.db, 'subjectCategories') : Promise.resolve([]),
    ctx.query.project_id ? find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.query.project_id), { limit: Infinity }) : Promise.resolve([]),
    selectedTypes.includes('author') || selectedTypes.includes('institution') ? all(ctx.db, 'author_articles') : Promise.resolve([]),
    selectedTypes.includes('institution') ? all(ctx.db, 'institution_authors') : Promise.resolve([]),
    selectedTypes.includes('keyword') && ctx.query.project_id ? all(ctx.db, 'keyword_articles') : Promise.resolve([]),
  ]);

  const articleRows = (await hydrateArticles(ctx.db, rawArticles)).filter(row => !isDeleted(row));
  let scopedArticles = articleRows;
  if (ctx.query.project_id) {
    const project = await byId(ctx.db, 'projects', ctx.query.project_id);
    const areaId = String(project?.subject_area_id || project?.subject_area || project?.subjectAreaId || '');
    const area = areas.find(row => !isDeleted(row) && (String(row.subject_area_id || row.id) === areaId || String(row.display_name || row.name).toLowerCase() === areaId.toLowerCase()));
    if (!project || !area) return { body: { code: 404, message: 'Project not found', data: null }, status: 404 };
    const areaKey = String(area.subject_area_id || area.id);
    const categoryIds = new Set(categories.filter(row => String(row.subject_area_id) === areaKey && !isDeleted(row)).map(row => String(row.subject_category_id || row.id)));
    const keywordIds = new Set(projectKeywords.map(row => String(row.keyword_id)));
    const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
    const articleIdsWithKeywords = new Map();
    for (const link of keywordLinks) {
      const key = String(link.article_id || '');
      if (!articleIdsWithKeywords.has(key)) articleIdsWithKeywords.set(key, new Set());
      articleIdsWithKeywords.get(key).add(String(link.keyword_id));
    }
    scopedArticles = articleRows.filter(article => {
      const id = String(article.article_id || article.id);
      const topicIds = new Set([article.primary_topic, article.topic_id, ...(article.topic_ids || [])].filter(Boolean).map(String));
      const inCategory = [...topicIds].some(topicId => categoryIds.has(String(topicById.get(topicId)?.subject_category_id)));
      const linkedKeywords = new Set([...(article.keyword_ids || []).map(value => String(value?.keyword_id || value?.id || value)), ...(articleIdsWithKeywords.get(id) || [])]);
      const inKeyword = [...linkedKeywords].some(keywordId => keywordIds.has(keywordId));
      return (categoryIds.size > 0 && inCategory) || (keywordIds.size > 0 && inKeyword);
    });
  }

  const needle = q.toLowerCase();
  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('%', '.*').replaceAll('_', '.');
  const likePattern = new RegExp(`^.*${escapedNeedle}.*$`, 's');
  const matches = value => likePattern.test(String(value || '').toLowerCase());
  const scopedArticleIds = new Set(scopedArticles.map(row => String(row.article_id || row.id)));
  const topicIdsByArticle = new Map(scopedArticles.map(row => [String(row.article_id || row.id), new Set([row.primary_topic, row.topic_id, ...(row.topic_ids || [])].filter(Boolean).map(String))]));
  const namesByType = {
    article: scopedArticles.filter(row => matches(row.title)).map(row => row.title),
    journal: journals.filter(row => !isDeleted(row) && matches(row.display_name) && (!ctx.query.project_id || scopedArticles.some(article => String(article.journal_id || '') === String(row.journal_id || row.id)))).map(row => row.display_name),
    author: authors.filter(row => !isDeleted(row) && matches(row.display_name) && (!ctx.query.project_id || authorLinks.some(link => String(link.author_id) === String(row.author_id || row.id) && scopedArticleIds.has(String(link.article_id))) || scopedArticles.some(article => (article.author_ids || []).some(value => String(value?.author_id || value?.id || value) === String(row.author_id || row.id))))).map(row => row.display_name),
    institution: institutions.filter(row => !isDeleted(row) && matches(row.display_name) && (!ctx.query.project_id || institutionLinks.some(link => String(link.institution_id) === String(row.institution_id || row.id) && authorLinks.some(authorLink => String(authorLink.author_id) === String(link.author_id) && scopedArticleIds.has(String(authorLink.article_id)))))).map(row => row.display_name),
    keyword: keywords.filter(row => matches(row.display_name) && (!ctx.query.project_id || keywordLinks.some(link => String(link.keyword_id) === String(row.keyword_id || row.id) && scopedArticleIds.has(String(link.article_id))) || scopedArticles.some(article => (article.keyword_ids || []).some(value => String(value?.keyword_id || value?.id || value) === String(row.keyword_id || row.id))))).map(row => row.display_name),
    topic: topics
      .filter(row => !isDeleted(row) && matches(row.display_name) && (!ctx.query.project_id || [...topicIdsByArticle.values()].some(ids => ids.has(String(row.topic_id || row.id)))))
      .map(row => row.display_name),
  };
  const rawSuggestions = selectedTypes.flatMap(selectedType => (namesByType[selectedType] || []).slice(0, limit));
  const unique = new Map();
  for (const value of rawSuggestions) {
    const trimmed = String(value || '').trim();
    if (trimmed && !unique.has(trimmed.toLowerCase())) unique.set(trimmed.toLowerCase(), trimmed);
  }
  const suggestions = [...unique.values()].sort((a, b) => {
    const aPrefix = a.toLowerCase().startsWith(needle); const bPrefix = b.toLowerCase().startsWith(needle);
    if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
    return a.localeCompare(b);
  }).slice(0, limit);
  return ok({ suggestions }, 'Search suggestions fetched successfully');
}

function searchBadge(label, value, variant = 'neutral') {
  const cleaned = value == null ? '' : String(value).trim();
  return cleaned ? { label, value: cleaned, variant } : null;
}
function searchStat(label, value, suffix = null) {
  if (value === undefined || value === null || value === '') return null;
  const numberValue = Number(value); const normalized = Number.isNaN(numberValue) ? value : numberValue;
  const display = typeof normalized === 'number' && Number.isFinite(normalized)
    ? Number.isInteger(normalized) && Math.abs(normalized) < 1000 ? String(normalized) : new Intl.NumberFormat('en-US', { notation: Math.abs(normalized) >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 2 }).format(normalized)
    : String(normalized);
  return { label, value: normalized, displayValue: suffix && display ? `${display} ${suffix}` : display, suffix };
}
function searchSnippet(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return !text ? null : text.length <= maxLength ? text : `${text.slice(0, maxLength - 3).trim()}...`;
}
function searchItemUi(type, { row, metadata, title, linked, publisher, category, area }) {
  const authorNames = (metadata.authors || []).map(item => item?.name || item?.display_name).filter(Boolean).slice(0, 3);
  const institutions = (metadata.institutions || []).map(item => item?.name).filter(Boolean).slice(0, 2);
  let subtitle = null; let snippet = null; let imageUrl = null; let badges = []; let stats = [];
  if (type === 'article') {
    subtitle = [authorNames.join(', '), metadata.journalName, row.publication_year].filter(Boolean).join(' | ') || null;
    snippet = searchSnippet(metadata.tldr || row.abstract);
    badges = [searchBadge('Year', row.publication_year), searchBadge('Journal', metadata.journalName), searchBadge('DOI', metadata.doi)].filter(Boolean);
    stats = [searchStat('Citations', row.citation_count), searchStat('Influential citations', metadata.influentialCitationCount), searchStat('References', metadata.referenceCount)].filter(Boolean);
  } else if (type === 'journal') {
    subtitle = [metadata.publisher, metadata.country, metadata.journalType].filter(Boolean).join(' | ') || null;
    snippet = [metadata.issn ? `ISSN ${metadata.issn}` : null, metadata.latestQuartile ? `Quartile ${metadata.latestQuartile}` : null, metadata.isOpenAccess ? 'Open access' : null].filter(Boolean).join(' | ') || null;
    imageUrl = metadata.publisherImageUrl;
    badges = [searchBadge('Quartile', metadata.latestQuartile, 'rank'), searchBadge('Open access', metadata.isOpenAccess ? 'Yes' : null, 'success'), searchBadge('Country', metadata.country), searchBadge('ISSN', metadata.issn)].filter(Boolean);
    stats = [searchStat('Articles', metadata.articleCount), searchStat('Citations', 0)].filter(Boolean);
  } else if (type === 'author') {
    const institutionText = metadata.lastKnownInstitution || institutions.join(', ');
    subtitle = [institutionText, metadata.orcid ? `ORCID ${metadata.orcid}` : null].filter(Boolean).join(' | ') || null;
    snippet = [metadata.worksCount !== undefined ? `${metadata.worksCount} works` : null, metadata.citedByCount !== undefined ? `${metadata.citedByCount} citations` : null, metadata.hIndex !== undefined ? `H-index ${metadata.hIndex}` : null].filter(Boolean).join(' | ') || null;
    imageUrl = metadata.urlImage;
    badges = [searchBadge('ORCID', metadata.orcid), searchBadge('H-index', metadata.hIndex), searchBadge('Institution', institutionText)].filter(Boolean);
    stats = [searchStat('Works', metadata.worksCount), searchStat('Citations', metadata.citedByCount), searchStat('H-index', metadata.hIndex), searchStat('Articles', metadata.articleCount)].filter(Boolean);
  } else if (type === 'institution') {
    subtitle = [metadata.countryCode, metadata.institutionType].filter(Boolean).join(' | ') || null;
    snippet = [metadata.authorCount !== undefined ? `${metadata.authorCount} authors` : null, metadata.articleCount !== undefined ? `${metadata.articleCount} articles` : null].filter(Boolean).join(' | ') || null;
    badges = [searchBadge('Country', metadata.countryCode), searchBadge('Type', metadata.institutionType), searchBadge('OpenAlex', metadata.openalexId)].filter(Boolean);
    stats = [searchStat('Authors', metadata.authorCount), searchStat('Articles', metadata.articleCount), searchStat('Citations', 0)].filter(Boolean);
  } else if (type === 'keyword') {
    subtitle = `${metadata.articleCount} related articles`;
    badges = [searchBadge('Keyword', title)].filter(Boolean);
    stats = [searchStat('Articles', metadata.articleCount), searchStat('Citations', 0)].filter(Boolean);
  } else {
    subtitle = [metadata.subjectCategoryName, metadata.subjectAreaName].filter(Boolean).join(' | ') || null;
    snippet = [metadata.articleCount !== undefined ? `${metadata.articleCount} related articles` : null, metadata.score !== undefined ? `Topic score ${metadata.score}` : null].filter(Boolean).join(' | ') || null;
    badges = [searchBadge('Subject category', metadata.subjectCategoryName), searchBadge('Subject area', metadata.subjectAreaName)].filter(Boolean);
    stats = [searchStat('Articles', metadata.articleCount), searchStat('Topic score', metadata.score), searchStat('Citations', 0)].filter(Boolean);
  }
  const typeLabel = ({ article: 'B\u00e0i b\u00e1o', journal: 'T\u1ea1p ch\u00ed', author: 'T\u00e1c gi\u1ea3', institution: 'T\u1ed5 ch\u1ee9c', keyword: 'T\u1eeb kh\u00f3a', topic: 'Ch\u1ee7 \u0111\u1ec1' })[type];
  const typeIcon = ({ article: 'file-text', journal: 'book-open', author: 'user', institution: 'building-2', keyword: 'tag', topic: 'network' })[type];
  return { typeLabel, typeIcon, detailPath: `/${type === 'author' ? 'authors' : `${type}s`}/${row[`${type}_id`] ?? row.id}`, subtitle, snippet, imageUrl, badges, stats };
}

async function searchEntities(ctx) {
  const q = String(ctx.query.q || '').trim();
  if (q.length < 2) throw new HttpError(400, 'q must contain at least 2 characters', 'VALIDATION_ERROR');
  if (q.length > 200) throw new HttpError(400, 'q must be at most 200 characters', 'VALIDATION_ERROR');
  const selectedType = String(ctx.query.type || 'all');
  const typeMap = {
    article: ['articles', ['title', 'abstract', 'doi', 'journal_name', 'author_names', 'keyword_names']],
    journal: ['journals', ['display_name', 'name', 'issn', 'country', 'region', 'type']],
    author: ['authors', ['display_name', 'full_name', 'orcid', 'openalex_id']],
    institution: ['institutions', ['display_name', 'name', 'country_code', 'type']],
    keyword: ['keywords', ['display_name', 'name', 'keyword']],
    topic: ['topics', ['display_name', 'name']],
  };
  const typeNames = Object.keys(typeMap);
  if (selectedType !== 'all' && !typeMap[selectedType]) throw new HttpError(400, 'type must be all, article, journal, author, institution, keyword, or topic', 'VALIDATION_ERROR');
  const types = selectedType === 'all' ? typeNames : [selectedType];
  const intParam = (key, fallback, max = Number.MAX_SAFE_INTEGER) => {
    if (ctx.query[key] === undefined || ctx.query[key] === '') return fallback;
    const value = Number(ctx.query[key]);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new HttpError(400, `${key} must be a positive integer${max < Number.MAX_SAFE_INTEGER ? ` no greater than ${max}` : ''}`, 'VALIDATION_ERROR');
    return value;
  };
  const pageNumber = intParam('page', 1);
  const pageLimit = intParam('limit', 10, 50);
  const yearParam = key => {
    if (ctx.query[key] === undefined || ctx.query[key] === '') return undefined;
    const value = Number(ctx.query[key]);
    if (!Number.isInteger(value)) throw new HttpError(400, `${key} must be an integer`, 'VALIDATION_ERROR');
    return value;
  };
  const fromYear = yearParam('from_year'); const toYear = yearParam('to_year');
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) throw new HttpError(400, 'from_year cannot be greater than to_year', 'VALIDATION_ERROR');
  const sort = String(ctx.query.sort || 'relevance');
  if (!['relevance', 'year_desc', 'citations_desc', 'name_asc'].includes(sort)) throw new HttpError(400, 'sort must be relevance, year_desc, citations_desc, or name_asc', 'VALIDATION_ERROR');

  const projectId = ctx.query.project_id ? String(ctx.query.project_id) : null;
  if (!projectId && fromYear === undefined && toYear === undefined) {
    return searchOpenAlexEntities(ctx, { q, type: selectedType, page: pageNumber, limit: pageLimit });
  }
  const project = projectId ? await requireProject(ctx, projectId) : null;
  let scopedArticles = await filteredArticles({ ...ctx, query: { from_year: fromYear, to_year: toYear } });
  const scopeOrYear = Boolean(projectId || fromYear !== undefined || toYear !== undefined);
  if (projectId) {
    const projectArea = String(project.subject_area || project.subject_area_id || '');
    const [areas, categories, topics, projectKeywords, subTopics] = await Promise.all([
      all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories'), all(ctx.db, 'topics'),
      find(ctx.db, 'project_keywords', row => String(row.project_id) === projectId), all(ctx.db, 'sub_topics'),
    ]);
    const area = areas.find(row => String(row.subject_area_id || row.id) === projectArea || String(row.display_name || row.name || '').toLowerCase() === projectArea.toLowerCase());
    if (!area) throw new HttpError(404, 'Project not found or has no associated subject area', 'NOT_FOUND');
    const categoryIds = new Set(categories.filter(row => String(row.subject_area_id) === String(area.subject_area_id || area.id) && !isDeleted(row)).map(row => String(row.subject_category_id || row.id)));
    const topicIds = new Set(topics.filter(row => categoryIds.has(String(row.subject_category_id))).map(row => String(row.topic_id || row.id)));
    const keywordIds = new Set(projectKeywords.map(row => String(row.keyword_id)).filter(Boolean));
    const subTopicIdsByArticle = new Map();
    for (const link of subTopics) {
      const articleId = String(link.article_id); const topicId = String(link.topic_id);
      if (!subTopicIdsByArticle.has(articleId)) subTopicIdsByArticle.set(articleId, new Set());
      subTopicIdsByArticle.get(articleId).add(topicId);
    }
    scopedArticles = scopedArticles.filter(article => {
      const articleId = String(article.article_id || article.id);
      const articleTopics = new Set([...(article.topic_ids || []), article.primary_topic, article.topic_id, ...(subTopicIdsByArticle.get(articleId) || [])].filter(Boolean).map(String));
      return [...articleTopics].some(id => topicIds.has(id)) || (article.keyword_ids || []).some(id => keywordIds.has(String(id)));
    });
  }
  if (fromYear !== undefined || toYear !== undefined) scopedArticles = scopedArticles.filter(article => {
    const year = article.publication_year == null || article.publication_year === '' ? null : number(article.publication_year, null);
    return year !== null && (fromYear === undefined || year >= fromYear) && (toYear === undefined || year <= toYear);
  });
  const wantsJournal = types.includes('journal'); const wantsAuthor = types.includes('author'); const wantsInstitution = types.includes('institution'); const wantsTopic = types.includes('topic');
  const [articles, journals, authors, institutions, keywords, topics, institutionAuthors, publishers, subjectCategories, subjectAreas, rankingMetrics] = await Promise.all([
    types.includes('article') ? Promise.resolve(scopedArticles) : all(ctx.db, 'articles').then(rows => hydrateArticles(ctx.db, rows.filter(row => !isDeleted(row)))),
    types.includes('journal') ? all(ctx.db, 'journals') : Promise.resolve([]),
    types.includes('author') ? all(ctx.db, 'authors') : Promise.resolve([]),
    types.includes('institution') ? all(ctx.db, 'institutions') : Promise.resolve([]),
    types.includes('keyword') ? all(ctx.db, 'keywords') : Promise.resolve([]),
    types.includes('topic') ? all(ctx.db, 'topics') : Promise.resolve([]),
    wantsAuthor || wantsInstitution ? all(ctx.db, 'institution_authors') : Promise.resolve([]),
    wantsJournal ? all(ctx.db, 'publishers') : Promise.resolve([]), wantsTopic ? all(ctx.db, 'subjectCategories') : Promise.resolve([]), wantsTopic ? all(ctx.db, 'subjectAreas') : Promise.resolve([]),
    wantsJournal ? all(ctx.db, 'ranking_metrics') : Promise.resolve([]),
  ]);
  const qLower = q.toLocaleLowerCase(); const contains = value => String(value ?? '').toLocaleLowerCase().includes(qLower);
  const starts = value => String(value ?? '').toLocaleLowerCase().startsWith(qLower);
  const exact = value => String(value ?? '').toLocaleLowerCase() === qLower;
  const articleId = row => String(row.article_id || row.id);
  const entityId = (row, type) => String(row[`${type}_id`] ?? row.id ?? '');
  const activeArticles = articles.filter(row => !isDeleted(row));
  const relatedArticles = scopeOrYear ? scopedArticles : activeArticles;
  const scopedAuthors = new Map(); const scopedJournals = new Map(); const scopedKeywords = new Map(); const scopedTopics = new Map();
  const addRelated = (map, id, article) => { const key = String(id || ''); if (!key) return; if (!map.has(key)) map.set(key, new Map()); map.get(key).set(articleId(article), article); };
  for (const article of relatedArticles) {
    addRelated(scopedJournals, article.journal_id, article);
    for (const id of article.author_ids || []) addRelated(scopedAuthors, id, article);
    for (const id of article.keyword_ids || []) addRelated(scopedKeywords, id, article);
    for (const id of [...(article.topic_ids || []), article.primary_topic, article.topic_id].filter(Boolean)) addRelated(scopedTopics, id, article);
  }
  const publisherById = new Map(publishers.map(row => [String(row.publisher_id || row.id), row]));

  const categoryById = new Map(subjectCategories.map(row => [String(row.subject_category_id || row.id), row]));
  const areaById = new Map(subjectAreas.map(row => [String(row.subject_area_id || row.id), row]));
  const institutionById = new Map(institutions.map(row => [String(row.institution_id || row.id), row]));
  const institutionAuthorIds = new Map();
  for (const link of institutionAuthors) { const key = String(link.institution_id); if (!institutionAuthorIds.has(key)) institutionAuthorIds.set(key, new Set()); institutionAuthorIds.get(key).add(String(link.author_id)); }
  const entityRows = { article: scopedArticles, journal: journals, author: authors, institution: institutions, keyword: keywords, topic: topics };
  const candidateRows = [];
  for (const type of types) {
    const [, fields] = typeMap[type];
    const rows = entityRows[type];
    for (const row of rows) {
      if (isDeleted(row)) continue;
      const id = entityId(row, type);
      let linked = [];
      if (type === 'journal') linked = [...(scopedJournals.get(id)?.values() || [])];
      else if (type === 'author') linked = [...(scopedAuthors.get(id)?.values() || [])];
      else if (type === 'keyword') linked = [...(scopedKeywords.get(id)?.values() || [])];
      else if (type === 'topic') linked = [...(scopedTopics.get(id)?.values() || [])];
      else if (type === 'institution') {
        const authorIds = institutionAuthorIds.get(id) || new Set();
        linked = relatedArticles.filter(article => (article.author_ids || []).some(authorId => authorIds.has(String(authorId))));
      }
      if (scopeOrYear && type !== 'article' && !linked.length) continue;
      const publisher = publisherById.get(String(row.publisher_id || ''));
      const category = categoryById.get(String(row.subject_category_id || ''));
      const area = areaById.get(String(category?.subject_area_id || row.subject_area_id || ''));
      const searchValues = [...fields.map(field => row[field]),
        ...(type === 'article' ? [row.author_names, row.keyword_names] : []),
        ...(type === 'journal' ? [publisher?.display_name, publisher?.name] : []),
        ...(type === 'topic' ? [category?.display_name, category?.name, area?.display_name, area?.name] : []),
      ].filter(value => value !== undefined && value !== null);
      if (!searchValues.some(value => Array.isArray(value) ? value.some(contains) : contains(value))) continue;
      const title = String(row.display_name || row.title || row.name || row.full_name || row.keyword || '');
      const score = exact(title) ? 100 : starts(title) ? 85 : contains(title) ? 70
        : type === 'article' && contains(row.doi) ? 65
          : type === 'journal' && contains(row.issn) ? 60
            : type === 'author' && contains(row.orcid) ? 60
              : type === 'journal' && (contains(publisher?.display_name) || contains(publisher?.name)) ? 45
                : type === 'topic' && (contains(category?.display_name) || contains(category?.name) || contains(area?.display_name) || contains(area?.name)) ? 45
                  : type === 'article' && (contains(row.journal_name) || (row.author_names || []).some(contains) || (row.keyword_names || []).some(contains)) ? 50
                    : type === 'article' && contains(row.abstract) ? 30 : 30;
      const aId = id;
      const metadata = type === 'article' ? {
        doi: row.doi || null, journalId: row.journal_id || null, journalName: row.journal_name || null,
        referenceCount: row.reference_count ?? null, influentialCitationCount: row.semantic_influential_citation_count ?? null,
        semanticScholarId: row.semantic_scholar_id || null, tldr: typeof row.semantic_tldr === 'string' ? row.semantic_tldr : row.semantic_tldr?.text || row.semantic_tldr?.description || row.semantic_tldr?.summary || null,
        authors: (row.authors || []).map(author => ({ id: String(author.author_id || author.id || ""), name: author.display_name || author.name || author.full_name || "" })).filter(author => author.name).sort((a, b) => a.name.localeCompare(b.name)), keywords: (row.keywords || []).map(keyword => typeof keyword === "string" ? keyword : keyword?.display_name || keyword?.name || keyword?.keyword).filter(Boolean),
      } : type === 'journal' ? {
        sourceId: row.source_id || null, publisherId: row.publisher_id || null, publisher: publisher?.display_name || publisher?.name || null,
        publisherImageUrl: publisher?.image_url || null, country: row.country || null, region: row.region || null,
        journalType: row.type || null, isOpenAccess: Boolean(row.is_open_access), isOaDiamond: Boolean(row.is_oa_diamond), issn: row.issn || null,
        articleCount: linked.length, latestQuartile: null,
      } : type === 'author' ? {
        orcid: row.orcid || null, openalexId: row.openalex_id || null, urlImage: row.url_image || null,
        worksCount: number(row.works_count), citedByCount: number(row.cited_by_count), hIndex: number(row.h_index), i10Index: number(row.i10_index),
        lastKnownInstitution: row.last_known_institution || null, lastKnownInstitutionId: row.last_known_institution_id || null, articleCount: linked.length,
        institutions: [...institutionAuthorIds].filter(([, ids]) => ids.has(id)).slice(0, 5).map(([institutionId]) => { const item = institutionById.get(institutionId); return item ? { id: institutionId, name: item.display_name || item.name, countryCode: item.country_code } : null; }).filter(Boolean),
      } : type === 'institution' ? {
        openalexId: null, countryCode: row.country_code || null, institutionType: row.type || null, authorCount: (institutionAuthorIds.get(id) || new Set()).size, articleCount: linked.length,
      } : type === 'keyword' ? { articleCount: linked.length }
        : { score: number(row.score), subjectCategoryId: row.subject_category_id || null, subjectCategoryName: category?.display_name || category?.name || null, subjectAreaId: area?.subject_area_id || area?.id || null, subjectAreaName: area?.display_name || area?.name || null, articleCount: linked.length };
      const detailPath = `/${type === 'author' ? 'authors' : `${type}s`}/${aId}`;
      candidateRows.push({ id: aId, type, title, description: type === 'article' ? row.abstract || null : type === 'journal' ? (publisher?.display_name || publisher?.name || null) : type === 'author' ? row.orcid || null : type === 'institution' ? row.country_code || null : type === 'topic' ? (category?.display_name || category?.name || null) : null, publicationYear: type === 'article' && row.publication_year != null ? number(row.publication_year, null) : null, citationCount: type === 'article' ? number(row.citation_count) : 0, score, metadata, ...searchItemUi(type, { row, metadata, title, linked, publisher, category, area }) });
    }
  }
  const compareNullsLast = (a, b, descending = true) => a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : a === b ? 0 : descending ? (a > b ? -1 : 1) : (a < b ? -1 : 1);
  const compareTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''));
  candidateRows.sort((a, b) => {
    if (sort === 'year_desc') return compareNullsLast(a.publicationYear, b.publicationYear) || compareNullsLast(a.score, b.score) || compareNullsLast(a.citationCount, b.citationCount) || compareTitle(a, b);
    if (sort === 'citations_desc') return compareNullsLast(a.citationCount, b.citationCount) || compareNullsLast(a.score, b.score) || compareNullsLast(a.publicationYear, b.publicationYear) || compareTitle(a, b);
    if (sort === 'name_asc') return compareTitle(a, b) || compareNullsLast(a.score, b.score) || compareNullsLast(a.publicationYear, b.publicationYear);
    return compareNullsLast(a.score, b.score) || compareNullsLast(a.citationCount, b.citationCount) || compareNullsLast(a.publicationYear, b.publicationYear) || compareTitle(a, b);
  });
  const total = candidateRows.length; const offset = (pageNumber - 1) * pageLimit;
  let items = candidateRows.slice(offset, offset + pageLimit).map((item, index) => ({ ...item, rank: offset + index + 1 }));
  if (wantsJournal && items.some(item => item.type === 'journal')) {
    const journalById = new Map(journals.map(row => [String(row.journal_id || row.id), row]));
    const normalizeIssn = value => String(value || '').replace(/[^0-9X]/gi, '').toUpperCase();
    const journalIssnById = new Map();
    const rankingIds = [];
    for (const item of items.filter(row => row.type === 'journal')) {
      const journal = journalById.get(String(item.id));
      const issn = normalizeIssn(item.metadata?.issn || journal?.issn);
      if (!issn) continue;
      journalIssnById.set(String(item.id), issn);
      rankingIds.push(`scimago_${issn}`);
    }
    const pageRankings = await journalRankingsForJournals(ctx.db, rankingIds);
    const quartileMetricIds = new Set(rankingMetrics.filter(row => ['SJR_BEST_QUARTILE', 'QUARTILE'].includes(String(row.code || '').toUpperCase())).map(row => String(row.metric_id || row.id)));
    const quartileByIssn = new Map();
    for (const ranking of pageRankings) {
      const match = String(ranking.journal_id || '').match(/^scimago_(.+)$/i);
      const issn = normalizeIssn(match?.[1]);
      if (!issn || !quartileMetricIds.has(String(ranking.metric_id)) || ranking.value_txt == null) continue;
      const prior = quartileByIssn.get(issn);
      if (!prior || number(ranking.year) > number(prior.year)) quartileByIssn.set(issn, ranking);
    }
    items = items.map(item => {
      if (item.type !== 'journal') return item;
      const journal = journalById.get(String(item.id));
      const metadata = { ...item.metadata, latestQuartile: quartileByIssn.get(journalIssnById.get(String(item.id)))?.value_txt || null };
      const publisher = publisherById.get(String(journal?.publisher_id || ''));
      const linked = [...(scopedJournals.get(String(item.id))?.values() || [])];
      return { ...item, metadata, ...searchItemUi('journal', { row: journal || {}, metadata, title: item.title, linked, publisher }) };
    });
  }
  const counts = Object.fromEntries(types.map(type => [type, candidateRows.filter(row => row.type === type).length]));
  return { code: 200, message: 'Fetch search results successfully', data: { query: q, type: selectedType, projectId, page: pageNumber, limit: pageLimit, total, totalPages: total > 0 ? Math.ceil(total / pageLimit) : 0, counts, items } };
}

async function articlesGraphSearch(ctx) {
  const rawKeyword = String(ctx.query.keyword ?? ctx.query.q ?? '').trim();
  if (!rawKeyword) throw new HttpError(400, 'Missing query param: keyword', 'VALIDATION_ERROR');
  let keyword;
  try { keyword = decodeURIComponent(rawKeyword).trim(); }
  catch { throw new HttpError(400, 'keyword is invalid', 'VALIDATION_ERROR'); }
  if (!keyword) throw new HttpError(400, 'Missing query param: keyword', 'VALIDATION_ERROR');
  const rawLimit = ctx.query.limit === undefined ? 50 : Number(ctx.query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit <= 0) throw new HttpError(400, 'limit must be a positive number.', 'VALIDATION_ERROR');
  const limit = Math.min(rawLimit, 500);
  const graph = await searchOpenAlexWorkGraph(ctx, keyword, limit);
  return ok(graph, 'Search articles graph completed successfully');
}

function keywordCounts(articles) {
  const map = new Map();
  for (const article of articles) {
    const keywords = Array.isArray(article.keywords) ? article.keywords : String(article.keywords || article.keyword_names || '').split(',');
    for (const item of keywords) { const keyword = String(item?.name || item).trim(); if (keyword) map.set(keyword, (map.get(keyword) || 0) + 1); }
  }
  return [...map].map(([name, count]) => ({ name, keyword: name, count, value: count })).sort((a, b) => b.count - a.count);
}
async function frontierTopics(ctx) {
  const [graphNodes, graphEdges, topics] = await Promise.all([all(ctx.db, 'graphNodes'), all(ctx.db, 'graphEdges'), all(ctx.db, 'topics')]);
  const topicNameById = new Map(topics.map(row => [String(row.topic_id || row.id), row.display_name || row.name || 'Unknown']));
  const selectedTopicNames = Array.isArray(ctx.query.topicNames) ? ctx.query.topicNames.map(String) : String(ctx.query.topicNames || '').split(',').map(value => value.trim()).filter(Boolean);
  const subjectArea = String(ctx.query.subjectArea || '').trim().toLowerCase();
  const byTopic = new Map();
  const articleNodes = new Map(graphNodes.filter(node => (node.labels || []).includes('Article') && !isDeleted(node.properties || node)).map(node => [String(node.id), node]));
  // Source Cypher excludes deleted articles, but does not filter deleted Topic nodes.
  const topicNodes = new Map(graphNodes.filter(node => (node.labels || []).includes('Topic')).map(node => [String(node.id), node]));
  const hasGraphSource = articleNodes.size > 0 && graphEdges.length > 0;
  if (hasGraphSource) {
    const articleTopics = new Map(); const citingCounts = new Map();
    for (const edge of graphEdges) {
      const type = String(edge.type || '').toUpperCase(); const from = String(edge.source_id || edge.from || ''); const to = String(edge.target_id || edge.to || '');
      if (type === 'HAS_TOPIC' && articleNodes.has(from) && topicNodes.has(to)) {
        if (!articleTopics.has(to)) articleTopics.set(to, new Set()); articleTopics.get(to).add(from);
      } else if (type === 'REFERENCES' && articleNodes.has(from) && articleNodes.has(to)) citingCounts.set(to, (citingCounts.get(to) || 0) + 1);
    }
    for (const [topicId, ids] of articleTopics) {
      const node = topicNodes.get(topicId); const name = String(node.properties?.name || node.name || node.display_name || topicNameById.get(String(node.properties?.topic_id || node.topic_id)) || 'Unknown');
      if (subjectArea && name.toLowerCase() !== subjectArea || selectedTopicNames.length && !selectedTopicNames.includes(name)) continue;
      byTopic.set(name, { articleCount: ids.size, citationCount: [...ids].reduce((sum, id) => sum + (citingCounts.get(id) || 0), 0) });
    }
  } else {
    const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
    const articles = (await hydrateArticles(ctx.db, await all(ctx.db, 'articles'))).filter(row => !isDeleted(row));
    for (const article of articles) {
      const ids = [...new Set([...(article.topic_ids || []), article.primary_topic, article.topic_id].filter(Boolean).map(String))];
      for (const id of ids) {
        const topic = topicById.get(id); const name = String(topic?.display_name || topic?.name || article.topic_name || 'Unknown');
        if (subjectArea && name.toLowerCase() !== subjectArea || selectedTopicNames.length && !selectedTopicNames.includes(name)) continue;
        const aggregate = byTopic.get(name) || { articleCount: 0, citationCount: 0 };
        aggregate.articleCount += 1; aggregate.citationCount += number(article.citation_count); byTopic.set(name, aggregate);
      }
    }
  }
  const records = [...byTopic].filter(([, value]) => value.articleCount > 0).map(([topic, value]) => ({ topic, rawIF: value.citationCount / value.articleCount, rawVelocity: value.citationCount }))
    .sort((a, b) => b.rawIF - a.rawIF).slice(0, 10);
  if (!records.length) return [];
  const maxIF = Math.max(...records.map(row => row.rawIF), 1);
  const velocities = records.map(row => row.rawVelocity).filter(value => value > 0).sort((a, b) => a - b);
  return records.map(row => {
    const impactFactor = Math.round(Math.max(0, row.rawIF * 10 / maxIF) * 10) / 10;
    const velocityIndex = velocities.indexOf(row.rawVelocity);
    const rank = row.rawVelocity > 0 ? (velocities.length > 1 ? velocityIndex / (velocities.length - 1) : 1) : null;
    const citationVelocity = Math.round((rank === null ? 0 : 3 + rank * 6.5) * 10) / 10;
    return { topic: row.topic, impactFactor, citationVelocity, status: impactFactor >= 3 && citationVelocity >= 5 ? 'FRONTIER' : 'EMERGING' };
  });
}
function authorList(row) { return (row.author_names || row.authors || (row.author_name ? [row.author_name] : [])).map(item => String(item?.name || item)); }
function collaborationNetwork(articles, authors, limit) {
  const authorIdName = new Map(authors.map(row => [String(row.id || row.author_id), entityName(row)]));
  const nodes = new Map(); const edges = new Map();
  for (const article of articles) {
    const list = authorList(article); if (Array.isArray(article.author_ids)) list.push(...article.author_ids.map(id => authorIdName.get(String(id)) || String(id)));
    const unique = [...new Set(list)].filter(Boolean);
    for (const name of unique) nodes.set(name, (nodes.get(name) || 0) + 1);
    for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) { const key = [unique[i], unique[j]].sort().join('::'); edges.set(key, (edges.get(key) || 0) + 1); }
  }
  return { nodes: [...nodes].map(([id, publications]) => ({ id, name: id, publications })).slice(0, limit), links: [...edges].map(([key, weight]) => { const [source, target] = key.split('::'); return { source, target, weight }; }).sort((a, b) => b.weight - a.weight).slice(0, limit) };
}
async function collaborationScopedArticles(ctx, { summary = false } = {}) {
  requireProjectAnalytics(ctx.query);
  const project = await requireProject(ctx, ctx.query.project_id);
  const [scope] = await loadProjectResearchScopes(ctx.db, [project]);
  if (!scope) return [];

  const yearFilter = ctx.query.from_year || ctx.query.to_year
    ? ctx.query.from_year && ctx.query.to_year
      ? `publication_year:${ctx.query.from_year}-${ctx.query.to_year}`
      : ctx.query.from_year
        ? `publication_year:>${Number(ctx.query.from_year) - 1}`
        : `publication_year:<${Number(ctx.query.to_year) + 1}`
    : null;
  const explicitKeywords = String(ctx.query.keywords || '').split(',').map(value => value.trim()).filter(Boolean);
  const terms = explicitKeywords.length ? explicitKeywords : scope.keywordTerms;
  const select = (summary
    ? ['id', 'display_name', 'publication_year', 'publication_date', 'cited_by_count', 'primary_location', 'authorships']
    : [
      'id', 'display_name', 'publication_year', 'publication_date', 'type', 'doi', 'cited_by_count',
      'referenced_works_count', 'referenced_works', 'ids', 'language', 'primary_location', 'authorships',
      'primary_topic', 'topics', 'keywords', 'abstract_inverted_index',
    ]).join(',');
  const requests = [];
  for (const filter of scope.filters.slice(0, 4)) {
    requests.push(openAlexRequest(ctx, 'works', {
      filter: [filter, yearFilter].filter(Boolean).join(','), per_page: 100, select,
    }));
  }
  for (const search of terms.slice(0, 6)) {
    requests.push(openAlexRequest(ctx, 'works', {
      search, ...(yearFilter ? { filter: yearFilter } : {}), per_page: 100, select,
    }));
  }
  const results = await Promise.all(requests);
  const worksById = new Map();
  for (const result of results) {
    for (const work of result.results || []) {
      const id = String(work.id || '');
      if (id) worksById.set(id, openAlexWorkToLegacy(work));
    }
  }
  return [...worksById.values()].sort((a, b) => number(b.publication_year) - number(a.publication_year));
}
function collaborationEntities(articles, authors, institutions, authorLinks, institutionLinks) {
  const articleById = new Map(articles.map(article => [String(article.article_id || article.id), article]));
  const authorById = new Map(authors.map(author => [String(author.author_id || author.id), author]));
  const institutionById = new Map(institutions.map(institution => [String(institution.institution_id || institution.id), institution]));
  const authorsByArticle = new Map(); const articlesByAuthor = new Map();
  const institutionsByArticle = new Map(); const articlesByInstitution = new Map();
  const institutionsByAuthorYear = new Map();
  const add = (map, key, value) => {
    if (key == null || key === '' || value == null || value === '') return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };
  for (const link of authorLinks) {
    const articleId = String(link.article_id || ''); const authorId = String(link.author_id || '');
    if (!articleById.has(articleId) || !authorId) continue;
    add(authorsByArticle, articleId, authorId); add(articlesByAuthor, authorId, articleId);
  }
  for (const article of articles) {
    const articleId = String(article.article_id || article.id); const year = yearOf(article);
    for (const author of article.authors || []) {
      const authorId = String(author.author_id || author.id || author.openalex_id || '');
      if (!authorId) continue;
      add(authorsByArticle, articleId, authorId); add(articlesByAuthor, authorId, articleId);
      if (!authorById.has(authorId)) authorById.set(authorId, author);
      for (const institution of author.institutions || []) {
        const institutionId = String(institution.institution_id || institution.id || institution.openalex_id || '');
        if (!institutionId) continue;
        if (!institutionById.has(institutionId)) institutionById.set(institutionId, institution);
        add(institutionsByArticle, articleId, institutionId);
        add(articlesByInstitution, institutionId, articleId);
        if (year != null) add(institutionsByAuthorYear, `${year}:${authorId}`, institutionId);
      }
    }
  }
  for (const link of institutionLinks) {
    const year = String(link.year || ''); const authorId = String(link.author_id || '');
    if (!year || !authorId) continue;
    add(institutionsByAuthorYear, `${year}:${authorId}`, String(link.institution_id || ''));
  }
  for (const [articleId, authorIds] of authorsByArticle) {
    const year = yearOf(articleById.get(articleId));
    for (const authorId of authorIds) {
      for (const institutionId of institutionsByAuthorYear.get(`${year}:${authorId}`) || []) {
        add(institutionsByArticle, articleId, institutionId);
        add(articlesByInstitution, institutionId, articleId);
      }
    }
  }
  return { articleById, authorById, institutionById, authorsByArticle, articlesByAuthor, institutionsByArticle, articlesByInstitution };
}
async function globalCollaborationNetwork(ctx, scopedArticles = null) {
  const articles = scopedArticles || await collaborationScopedArticles(ctx);
  for (const key of ['limit_nodes', 'min_weight']) {
    if (ctx.query[key] !== undefined) {
      const value = Number(ctx.query[key]);
      if (!Number.isInteger(value) || value < 1) throw new HttpError(400, `${key} must be a positive integer`, 'VALIDATION_ERROR');
    }
  }
  const [authors, institutions, authorLinks, institutionLinks] = await Promise.all([
    all(ctx.db, 'authors'), all(ctx.db, 'institutions'), all(ctx.db, 'author_articles'), all(ctx.db, 'institution_authors'),
  ]);
  const { authorById, institutionById, authorsByArticle, articlesByAuthor, institutionsByArticle } = collaborationEntities(articles, authors, institutions, authorLinks, institutionLinks);
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); };
  const institutionAuthorCounts = new Map(); const authorInstitutionArticles = new Map();
  for (const [articleId, institutionIds] of institutionsByArticle) for (const authorId of authorsByArticle.get(articleId) || []) {
    for (const institutionId of institutionIds) {
      if (isDeleted(authorById.get(authorId)) || isDeleted(institutionById.get(institutionId))) continue;
      add(institutionAuthorCounts, institutionId, authorId);
      add(authorInstitutionArticles, `${authorId}|${institutionId}`, articleId);
    }
  }
  const authorNodes = [...articlesByAuthor].map(([authorId, ids]) => {
    const author = authorById.get(authorId) || {};
    if (isDeleted(author)) return null;
    const count = ids.size;
    return { id: `auth_${authorId}`, label: author.display_name || author.full_name || 'Unknown Author', type: 'AUTHOR', size: 12 + Math.min(count * 2, 20), color: '#FF6B00', metricValue: count, score: count };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  const institutionNodes = [...institutionAuthorCounts].map(([institutionId, ids]) => {
    const institution = institutionById.get(institutionId) || {};
    if (isDeleted(institution)) return null;
    const count = ids.size;
    return { id: `inst_${institutionId}`, label: institution.display_name || institution.name || 'Unknown Institution', type: 'INSTITUTION', size: 12 + Math.min(count * 2, 20), color: '#1A202C', metricValue: count, score: count };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  const limit = Math.max(1, number(ctx.query.limit_nodes, 50));
  const half = Math.floor(limit / 2); let authorLimit = Math.min(authorNodes.length, half); let institutionLimit = Math.min(institutionNodes.length, half);
  if (authorLimit < half) institutionLimit = Math.min(institutionNodes.length, limit - authorLimit);
  else if (institutionLimit < half) authorLimit = Math.min(authorNodes.length, limit - institutionLimit);
  const nodes = [...authorNodes.slice(0, authorLimit), ...institutionNodes.slice(0, institutionLimit)];
  const visible = new Set(nodes.map(node => node.id)); const edgeMap = new Map();
  const appendEdge = (from, to, weight, label) => {
    if (!visible.has(from) || !visible.has(to) || weight < Math.max(1, number(ctx.query.min_weight, 1))) return;
    const key = `${from}>${to}`; const prior = edgeMap.get(key) || { from, to, weight: 0, label: '' };
    prior.weight += weight; prior.label = `${prior.weight} ${label}`; edgeMap.set(key, prior);
  };
  const authorPairArticles = new Map();
  for (const [articleId, authorIds] of authorsByArticle) {
    const ids = [...authorIds].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) add(authorPairArticles, `${ids[i]}|${ids[j]}`, articleId);
  }
  for (const [pair, ids] of authorPairArticles) { const [a, b] = pair.split('|'); appendEdge(`auth_${a}`, `auth_${b}`, ids.size, 'joint ventures'); }
  for (const [pair, ids] of authorInstitutionArticles) { const [authorId, institutionId] = pair.split('|'); appendEdge(`auth_${authorId}`, `inst_${institutionId}`, ids.size, 'affiliations'); }
  return { nodes: nodes.map(({ score, ...node }) => node), edges: [...edgeMap.values()].sort((a, b) => b.weight - a.weight) };
}
async function countriesByArticle(ctx, articles) {
  const [authorLinks, institutionLinks, institutions, zones] = await Promise.all([
    all(ctx.db, 'author_articles'), all(ctx.db, 'institution_authors'), all(ctx.db, 'institutions'), all(ctx.db, 'zones'),
  ]);
  const articleIds = new Set(articles.map(row => String(row.article_id || row.id)));
  const articleById = new Map(articles.map(row => [String(row.article_id || row.id), row]));
  const authorIdsByArticle = new Map();
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); };
  for (const link of authorLinks) if (articleIds.has(String(link.article_id))) add(authorIdsByArticle, String(link.article_id), String(link.author_id));
  const institutionById = new Map(institutions.map(row => [String(row.institution_id || row.id), row]));
  const countryByCode = new Map(zones.filter(row => String(row.type || '').toUpperCase() === 'COUNTRY').map(row => [String(row.code || row.iso_code || '').toUpperCase(), row]));
  const affiliations = new Map();
  for (const link of institutionLinks) {
    const key = `${link.year}:${String(link.author_id)}`;
    if (!affiliations.has(key)) affiliations.set(key, new Set());
    affiliations.get(key).add(String(link.institution_id));
  }
  const countries = new Map();
  for (const [articleId, authorIds] of authorIdsByArticle) {
    const article = articleById.get(articleId); const year = yearOf(article); const countryNames = new Set();
    for (const authorId of authorIds) for (const institutionId of affiliations.get(`${year}:${authorId}`) || []) {
      const institution = institutionById.get(institutionId); const code = String(institution?.country_code || '').toUpperCase();
      const country = countryByCode.get(code); if (country?.name) countryNames.add(String(country.name).toUpperCase());
    }
    if (countryNames.size) countries.set(articleId, countryNames);
  }
  return countries;
}
function buildCountryPairs(countryMap) {
  const pairs = new Map();
  for (const countries of countryMap.values()) {
    const list = [...countries].sort();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const key = `${list[i]}::${list[j]}`; pairs.set(key, (pairs.get(key) || 0) + 1);
    }
  }
  return [...pairs].map(([key, coAuthorshipValue]) => { const [source, target] = key.split('::'); return { source, target, coAuthorshipValue }; });
}
async function countryChord(ctx, articles) {
  requireProjectAnalytics(ctx.query);
  const currentPairs = buildCountryPairs(await countriesByArticle(ctx, articles));
  if (!currentPairs.length) return [];
  const limitCountries = number(ctx.query.limit_countries, 10);
  const minValue = number(ctx.query.min_value, 1);
  if (!Number.isInteger(limitCountries) || limitCountries < 1 || limitCountries > 30 || !Number.isInteger(minValue) || minValue < 1) throw new HttpError(400, 'Invalid chord limits', 'VALIDATION_ERROR');
  const strengths = new Map();
  for (const pair of currentPairs) { strengths.set(pair.source, (strengths.get(pair.source) || 0) + pair.coAuthorshipValue); strengths.set(pair.target, (strengths.get(pair.target) || 0) + pair.coAuthorshipValue); }
  const topCountries = new Set([...strengths].sort((a, b) => b[1] - a[1]).slice(0, limitCountries).map(([country]) => country));
  const filtered = currentPairs.filter(pair => pair.coAuthorshipValue >= minValue && topCountries.has(pair.source) && topCountries.has(pair.target));
  let previousPairs = new Map();
  const from = number(ctx.query.from_year, 0); const to = number(ctx.query.to_year, 0);
  if (from && to) {
    const duration = to - from + 1;
    const previousCtx = { ...ctx, query: { ...ctx.query, from_year: from - duration, to_year: from - 1 } };
    const previousArticles = await collaborationScopedArticles(previousCtx);
    previousPairs = new Map(buildCountryPairs(await countriesByArticle(ctx, previousArticles)).map(pair => [`${pair.source}__${pair.target}`, pair.coAuthorshipValue]));
  }
  return filtered.sort((a, b) => b.coAuthorshipValue - a.coAuthorshipValue).map(pair => {
    const prior = previousPairs.get(`${pair.source}__${pair.target}`) || 0;
    const growth = prior ? Math.round((pair.coAuthorshipValue - prior) / prior * 100) : 100;
    return { ...pair, growth: `${growth >= 0 ? '+' : ''}${growth}%` };
  });
}
async function collaborationInsights(ctx, articles) {
  const chord = await countryChord(ctx, articles);
  let topPair = null;
  for (const pair of chord) { const value = Number.parseInt(String(pair.growth || '').replace('%', ''), 10); if (Number.isFinite(value) && (!topPair || value > topPair.growthValue)) topPair = { ...pair, growthValue: value }; }
  const formatCountry = value => value.toLowerCase() === 'united states' ? 'US' : value.toLowerCase() === 'european union' ? 'the EU' : value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  const topPairText = topPair ? `${formatCountry(topPair.source)} and ${formatCountry(topPair.target)}` : null;
  const growth = topPair ? `${topPair.growth.startsWith('+') ? topPair.growth : `+${topPair.growth}`} YoY` : null;
  let emergingKeyword = ''; let criticalKeyword = '';
  try {
    const vectors = await keywordVectors({ ...ctx, query: { ...ctx.query, limit: 3 } }, articles);
    emergingKeyword = vectors[0]?.keyword || vectors[0]?.name || '';
    criticalKeyword = vectors[1]?.keyword || vectors[1]?.name || '';
  } catch { /* source endpoint falls back silently when keyword analysis is unavailable */ }
  return {
    description: topPairText && growth ? `Global research output has shifted significantly towards multi-national clusters, with ${topPairText} showing the highest reciprocal citation growth of ${growth}.` : 'No international collaboration trends detected for this project during the selected timeframe.',
    emergingLink: emergingKeyword ? `BRICS + ${emergingKeyword}` : 'No emerging links',
    criticalNode: criticalKeyword || 'N/A',
  };
}
async function collaborationMetrics(ctx, articles) {
  requireProjectAnalytics(ctx.query);
  const [journals, issues, volumes, subTopics] = await Promise.all([
    all(ctx.db, 'journals'), all(ctx.db, 'issues'), all(ctx.db, 'volumes'), all(ctx.db, 'sub_topics'),
  ]);
  const institutionLinks = await all(ctx.db, 'institution_authors');
  const authorLinks = await all(ctx.db, 'author_articles');
  const authorIdsByArticle = new Map(); const articleById = new Map(articles.map(row => [String(row.article_id || row.id), row]));
  for (const link of authorLinks) if (articleById.has(String(link.article_id))) { const key = String(link.article_id); if (!authorIdsByArticle.has(key)) authorIdsByArticle.set(key, new Set()); authorIdsByArticle.get(key).add(String(link.author_id)); }
  for (const article of articles) for (const authorId of article.author_ids || []) { const key = String(article.article_id || article.id); if (!authorIdsByArticle.has(key)) authorIdsByArticle.set(key, new Set()); authorIdsByArticle.get(key).add(String(authorId)); }
  const instByAuthorYear = new Map();
  for (const link of institutionLinks) { const key = `${link.year}:${link.author_id}`; if (!instByAuthorYear.has(key)) instByAuthorYear.set(key, new Set()); instByAuthorYear.get(key).add(String(link.institution_id)); }
  const jointByYear = new Map(); const institutionPairs = new Set(); const journalById = new Map(journals.map(row => [String(row.journal_id || row.id), row]));
  for (const [articleId, authors] of authorIdsByArticle) {
    const article = articleById.get(articleId); const year = yearOf(article); const insts = new Set();
    for (const authorId of authors) for (const institutionId of instByAuthorYear.get(`${year}:${authorId}`) || []) insts.add(institutionId);
    if (insts.size > 1) jointByYear.set(year, (jointByYear.get(year) || 0) + 1);
    const list = [...insts].sort(); for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) institutionPairs.add(`${list[i]}|${list[j]}`);
  }
  const years = [...jointByYear.keys()].sort((a, b) => b - a); const current = years.length ? jointByYear.get(years[0]) : 0; const previous = years.length ? jointByYear.get(years[0] - 1) || 0 : 0;
  const growth = previous > 0 ? (current / previous).toFixed(1) + 'x' : current > 0 ? current.toFixed(1) + 'x' : '0.0x';
  const topicArticleIds = new Set(subTopics.map(row => String(row.article_id)));
  const crossover = articles.filter(row => topicArticleIds.has(String(row.article_id || row.id)) || (row.topic_ids || []).length > 0).length;
  const crossoverRate = articles.length ? (crossover / articles.length * 100).toFixed(1) + '%' : '0.0%';
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row])); const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  let oaTotal = 0; let oaCount = 0;
  for (const article of articles) {
    const issue = issueById.get(String(article.issue_id)); const volume = volumeById.get(String(article.volume_id || issue?.volume_id));
    const journal = journalById.get(String(article.journal_id || issue?.journal_id || volume?.journal_id));
    if (!journal) continue; oaTotal += 1; if (journal.is_open_access === true || article.is_open_access === true) oaCount += 1;
  }
  const oaRate = oaTotal ? `${Math.round(oaCount / oaTotal * 100)}%` : '0%';
  return { subtitle: `Aggregate metrics across ${institutionPairs.size.toLocaleString()} institutional collaborations.`, metrics: [
    { value: growth, label: 'AVG GROWTH IN JOINT VENTURES' },
    { value: crossoverRate, label: 'INTER-DISCIPLINARY CROSS-OVER' },
    { value: oaRate, label: 'OPEN ACCESS RATE' },
  ] };
}
async function sourceCollaborationMetrics(ctx, scopedArticles = null) {
  const articles = scopedArticles || await collaborationScopedArticles(ctx);
  const [authors, institutions, authorLinks, institutionLinks, subTopics, journals, issues, volumes] = await Promise.all([
    all(ctx.db, 'authors'), all(ctx.db, 'institutions'), all(ctx.db, 'author_articles'), all(ctx.db, 'institution_authors'), all(ctx.db, 'sub_topics'),
    all(ctx.db, 'journals'), all(ctx.db, 'issues'), all(ctx.db, 'volumes'),
  ]);
  const { articleById, authorsByArticle, institutionsByArticle } = collaborationEntities(articles, authors, institutions, authorLinks, institutionLinks);
  const jointByYear = new Map(); const collaborations = new Set();
  for (const [articleId, authorIds] of authorsByArticle) {
    const year = yearOf(articleById.get(articleId)); const institutionIds = [...(institutionsByArticle.get(articleId) || [])];
    if (institutionIds.length > 1) jointByYear.set(year, (jointByYear.get(year) || 0) + 1);
    const ids = institutionIds.sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) collaborations.add(`${ids[i]}|${ids[j]}`);
  }
  const years = [...jointByYear.keys()].sort((a, b) => b - a);
  const current = years.length ? jointByYear.get(years[0]) : 0;
  const previous = years.length ? jointByYear.get(years[0] - 1) || 0 : 0;
  const growth = previous > 0 ? (current / previous).toFixed(1) + 'x' : current > 0 ? current.toFixed(1) + 'x' : '0.0x';
  const articleIdsWithSubTopic = new Set(subTopics.map(row => String(row.article_id || '')));
  const crossover = articles.filter(row => articleIdsWithSubTopic.has(String(row.article_id || row.id)) || (row.topic_ids || []).length > 1 || (row.topics || []).length > 1).length;
  const crossoverRate = articles.length ? `${(crossover / articles.length * 100).toFixed(1)}%` : '0.0%';
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  const journalById = new Map(journals.map(row => [String(row.journal_id || row.id), row]));
  let oaTotal = 0; let oaCount = 0;
  for (const article of articles) {
    const issue = issueById.get(String(article.issue_id));
    const volume = volumeById.get(String(issue?.volume_id));
    const journal = journalById.get(String(volume?.journal_id));
    if (!journal) continue;
    oaTotal++;
    if (journal.is_open_access === true) oaCount++;
  }
  const oaRate = oaTotal ? `${Math.round(oaCount / oaTotal * 100)}%` : '0%';
  return { subtitle: `Aggregate metrics across ${collaborations.size.toLocaleString()} institutional collaborations.`, metrics: [
    { value: growth, label: 'AVG GROWTH IN JOINT VENTURES' },
    { value: crossoverRate, label: 'INTER-DISCIPLINARY CROSS-OVER' },
    { value: oaRate, label: 'OPEN ACCESS RATE' },
  ] };
}
async function sourceTopology(ctx) {
  requireProjectAnalytics(ctx.query);
  const articles = await collaborationScopedArticles(ctx);
  const networkType = String(ctx.query.network_type || 'all').toLowerCase();
  if (!['all', 'conceptual', 'collaboration'].includes(networkType)) throw new HttpError(400, 'network_type must be all, conceptual, or collaboration', 'VALIDATION_ERROR');
  const limitNodes = number(ctx.query.limit_nodes, 50); const minWeight = number(ctx.query.min_weight, 0.1);
  if (!Number.isInteger(limitNodes) || limitNodes < 1 || limitNodes > 150 || !Number.isFinite(minWeight) || minWeight < 0) throw new HttpError(400, 'Invalid network limits', 'VALIDATION_ERROR');
  const [authors, keywords, authorLinks, keywordLinks] = await Promise.all([
    all(ctx.db, 'authors'), all(ctx.db, 'keywords'), all(ctx.db, 'author_articles'), all(ctx.db, 'keyword_articles'),
  ]);
  const authorById = new Map(authors.map(row => [String(row.author_id || row.id), row]));
  const keywordById = new Map(keywords.map(row => [String(row.keyword_id || row.id), row]));
  const articleIds = new Set(articles.map(row => String(row.article_id || row.id)));
  const keywordsByArticle = new Map(); const authorsByArticle = new Map();
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); };
  for (const link of keywordLinks) if (articleIds.has(String(link.article_id))) add(keywordsByArticle, String(link.article_id), String(link.keyword_id));
  for (const link of authorLinks) if (articleIds.has(String(link.article_id))) add(authorsByArticle, String(link.article_id), String(link.author_id));
  const nodes = []; const edges = [];
  if (networkType === 'all' || networkType === 'conceptual') {
    const counts = new Map(); const pairs = new Map();
    for (const articleId of articleIds) {
      const ids = [...(keywordsByArticle.get(articleId) || [])].sort();
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.set(`${ids[i]}|${ids[j]}`, (pairs.get(`${ids[i]}|${ids[j]}`) || 0) + 1);
    }
    for (const [id, size] of counts) nodes.push({ id: `kw_${id}`, label: keywordById.get(id)?.display_name || 'Unknown', type: 'KEYWORD', size });
    for (const [pair, weight] of pairs) { const [from, to] = pair.split('|'); edges.push({ from: `kw_${from}`, to: `kw_${to}`, type: 'CONCEPTUAL_PROXIMITY', weight }); }
  }
  if (networkType === 'all' || networkType === 'collaboration') {
    const counts = new Map(); const pairs = new Map();
    for (const articleId of articleIds) {
      const ids = [...(authorsByArticle.get(articleId) || [])].sort();
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.set(`${ids[i]}|${ids[j]}`, (pairs.get(`${ids[i]}|${ids[j]}`) || 0) + 1);
    }
    for (const [id, size] of counts) nodes.push({ id: `auth_${id}`, label: authorById.get(id)?.display_name || 'Unknown', type: 'AUTHOR', size });
    for (const [pair, weight] of pairs) { const [from, to] = pair.split('|'); edges.push({ from: `auth_${from}`, to: `auth_${to}`, type: 'CO_AUTHORSHIP', weight }); }
  }
  if (!nodes.length) return { nodes: [], edges: [] };
  nodes.sort((a, b) => b.size - a.size);
  const topNodes = nodes.slice(0, limitNodes); const allowed = new Set(topNodes.map(node => node.id));
  const validEdges = edges.filter(edge => allowed.has(edge.from) && allowed.has(edge.to));
  const maxSize = Math.max(...topNodes.map(node => node.size)); const minSize = Math.min(...topNodes.map(node => node.size));
  for (const node of topNodes) node.size = maxSize === minSize ? 20 : Math.round((10 + (node.size - minSize) / (maxSize - minSize) * 30) * 100) / 100;
  const maxWeight = Math.max(0, ...validEdges.map(edge => edge.weight));
  const finalEdges = validEdges.map(edge => {
    const weight = maxWeight ? Math.round(edge.weight / maxWeight * 100) / 100 : 0;
    return { ...edge, weight, label: String(weight) };
  }).filter(edge => edge.weight >= minWeight).sort((a, b) => b.weight - a.weight);
  return { nodes: topNodes, edges: finalEdges };
}
async function sourceCrossLinks(ctx) {
  requireProjectAnalytics(ctx.query);
  const articles = await collaborationScopedArticles(ctx);
  const [topics, categories] = await Promise.all([all(ctx.db, 'topics'), all(ctx.db, 'subjectCategories')]);
  const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
  const categoryById = new Map(categories.map(row => [String(row.subject_category_id || row.id), row]));
  let crossArticles = 0;
  for (const article of articles) {
    const topic = topicById.get(String(article.primary_topic || ''));
    const categoryId = topic?.subject_category_id;
    if (categoryId != null && new Set([String(categoryId)]).size > 1) crossArticles++;
  }
  const totalArticles = articles.length;
  const linkage = totalArticles ? Math.round(crossArticles / totalArticles * 100) : 74;
  let transferRate = 12;
  const from = number(ctx.query.from_year, 0); const to = number(ctx.query.to_year, 0);
  if (from && to) {
    const duration = to - from + 1;
    const previousArticles = await collaborationScopedArticles({ ...ctx, query: { ...ctx.query, from_year: from - duration, to_year: from - 1 } });
    const previousCross = previousArticles.filter(article => {
      const categoryId = topicById.get(String(article.primary_topic || ''))?.subject_category_id;
      return categoryId != null && new Set([String(categoryId)]).size > 1;
    }).length;
    transferRate = previousCross > 0 ? Math.round((crossArticles - previousCross) / previousCross * 100) : crossArticles > 0 ? 100 : 0;
  }
  const globalArticles = (await all(ctx.db, 'articles')).filter(row => !isDeleted(row));
  const globalCounts = new Map();
  for (const article of globalArticles) {
    const topic = topicById.get(String(article.primary_topic || '')); const categoryId = topic?.subject_category_id;
    if (categoryId == null) continue;
    const category = categoryById.get(String(categoryId));
    const label = category?.display_name || category?.name;
    if (label) globalCounts.set(String(label), (globalCounts.get(String(label)) || 0) + 1);
  }
  const topCategories = [...globalCounts].sort((a, b) => b[1] - a[1]).slice(0, 2);
  const cat1 = topCategories[0]?.[0] || 'Physics'; const cat2 = topCategories[1]?.[0] || 'Financial Engineering';
  return { interDisciplinaryLinkage: linkage, transferRate: `${transferRate >= 0 ? '+' : ''}${transferRate}%`, description: `${cat1} methodologies rapidly colonizing ${cat2} domains.` };
}
async function sourceTemporalShift(ctx) {
  requireProjectAnalytics(ctx.query);
  const project = await requireProject(ctx, ctx.query.project_id);
  const [areas, categories, projectKeywords] = await Promise.all([
    all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories'),
    find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.query.project_id), { limit: Infinity }),
  ]);
  const area = projectAreaFor(project, areas);
  const categoryIds = new Set(categories.filter(row => !isDeleted(row) && String(row.subject_area_id) === String(area?.subject_area_id || area?.id))
    .map(row => String(row.subject_category_id || row.id)));
  if (!categoryIds.size && !projectKeywords.length) return { heatmap: [], driftEntropy: 'LOW', description: 'No data available.' };

  const articles = await collaborationScopedArticles(ctx);
  const latestYear = articles.reduce((max, row) => Math.max(max, yearOf(row) || 0), 0) || new Date().getFullYear();
  const startYear = latestYear - 7; const endYear = latestYear;
  const articleIds = new Set(articles.filter(row => yearOf(row) >= startYear && yearOf(row) <= endYear).map(row => String(row.article_id || row.id)));
  const [keywords, keywordLinks, topics] = await Promise.all([all(ctx.db, 'keywords'), all(ctx.db, 'keyword_articles'), all(ctx.db, 'topics')]);
  const keywordById = new Map(keywords.map(row => [String(row.keyword_id || row.id), row]));
  const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
  const articleById = new Map(articles.map(row => [String(row.article_id || row.id), row]));
  const keywordCounts = new Map(); const volumes = new Map();
  for (const link of keywordLinks) {
    const articleId = String(link.article_id || ''); const keywordId = String(link.keyword_id || '');
    if (!articleIds.has(articleId) || !keywordById.has(keywordId)) continue;
    keywordCounts.set(keywordId, (keywordCounts.get(keywordId) || 0) + 1);
    const article = articleById.get(articleId);
    const year = yearOf(article); const key = `${keywordId}:${year}`;
    volumes.set(key, (volumes.get(key) || 0) + 1);
  }
  const topKeywords = [...keywordCounts].sort((a, b) => b[1] - a[1]).slice(0, 7);
  const maxVolume = Math.max(0, ...topKeywords.flatMap(([keywordId]) => Array.from({ length: 8 }, (_, index) => volumes.get(`${keywordId}:${startYear + index}`) || 0)));
  const heatmap = [];
  if (topKeywords.length) {
    for (let row = 0; row < 7; row++) for (let col = 0; col < 8; col++) {
      const count = topKeywords[row] ? volumes.get(`${topKeywords[row][0]}:${startYear + col}`) || 0 : 0;
      const intensity = maxVolume ? 0.1 + count / maxVolume * 0.9 : 0.1;
      heatmap.push({ id: row * 8 + col, intensity: Math.round(intensity * 100) / 100 });
    }
  } else {
    for (let id = 0; id < 56; id++) heatmap.push({ id, intensity: Math.round((0.1 + Math.random() * 0.9) * 100) / 100 });
  }
  const categoryCounts = new Map();
  for (const article of articles) {
    const topic = topicById.get(String(article.primary_topic || '')); const categoryId = String(topic?.subject_category_id || '');
    if (!categoryId) continue;
    const category = categories.find(row => String(row.subject_category_id || row.id) === categoryId);
    if (category) categoryCounts.set(categoryId, { name: category.display_name || category.name, count: (categoryCounts.get(categoryId)?.count || 0) + 1 });
  }
  const topCategories = [...categoryCounts.values()].sort((a, b) => b.count - a.count).slice(0, 2);
  const cat1 = topCategories[0]?.name || 'Green Hydrogen'; const cat2 = topCategories[1]?.name || 'Carbon Capture';
  let driftEntropy = 'LOW';
  if (topCategories.length > 1) {
    const ratio = topCategories[0].count / (topCategories[1].count || 1);
    driftEntropy = ratio > 2 ? 'LOW' : ratio > 1.2 ? 'MEDIUM' : 'HIGH';
  }
  return { heatmap, driftEntropy, description: `Clusters are stabilizing around ${cat1} and ${cat2} techs.` };
}
async function sourceCuratedArticles(ctx) {
  requireProjectAnalytics(ctx.query);
  await requireProject(ctx, ctx.query.project_id);
  const page = number(ctx.query.page, 1); const limit = number(ctx.query.limit, 10);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'Invalid pagination parameters', 'VALIDATION_ERROR');
  const [articles, scopeLinks, projectKeywords, categories, areas, topics, subTopics, keywordLinks, keywords, authorLinks, authors, issues, volumes, journals] = await Promise.all([
    all(ctx.db, 'articles'), find(ctx.db, 'project_article_scopes', row => String(row.project_id) === String(ctx.query.project_id), { limit: Infinity }),
    find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.query.project_id), { limit: Infinity }),
    all(ctx.db, 'subjectCategories'), all(ctx.db, 'subjectAreas'), all(ctx.db, 'topics'), all(ctx.db, 'sub_topics'),
    all(ctx.db, 'keyword_articles'), all(ctx.db, 'keywords'), all(ctx.db, 'author_articles'), all(ctx.db, 'authors'),
    all(ctx.db, 'issues'), all(ctx.db, 'volumes'), all(ctx.db, 'journals'),
  ]);
  const scopeIds = new Set(scopeLinks.map(row => String(row.article_id || '')));
  const project = await byId(ctx.db, 'projects', ctx.query.project_id);
  const area = projectAreaFor(project, areas);
  const scopeCategoryIds = new Set(categories.filter(row => !isDeleted(row) && String(row.subject_area_id) === String(area?.subject_area_id || area?.id))
    .map(row => String(row.subject_category_id || row.id)));
  const scopeTopicIds = new Set(topics.filter(row => scopeCategoryIds.has(String(row.subject_category_id))).map(row => String(row.topic_id || row.id)));
  const scopeKeywordIds = new Set(projectKeywords.map(row => String(row.keyword_id || '')).filter(Boolean));
  const topicLinksByArticle = new Map(); const keywordIdsByArticle = new Map();
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); };
  for (const link of subTopics) add(topicLinksByArticle, String(link.article_id), String(link.topic_id));
  for (const link of keywordLinks) add(keywordIdsByArticle, String(link.article_id), String(link.keyword_id));
  const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
  const requestedArea = String(ctx.query.subject_area || '').trim().toLowerCase();
  const requestedKeywords = String(ctx.query.keywords || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const keywordById = new Map(keywords.map(row => [String(row.keyword_id || row.id), row]));
  const requestedYearFrom = ctx.query.from_year ? number(ctx.query.from_year, NaN) : undefined;
  const requestedYearTo = ctx.query.to_year ? number(ctx.query.to_year, NaN) : undefined;
  for (const [key, value] of [['from_year', requestedYearFrom], ['to_year', requestedYearTo]]) {
    if (value !== undefined && !Number.isInteger(value)) throw new HttpError(400, `${key} must be an integer`, 'VALIDATION_ERROR');
  }
  if (requestedYearFrom !== undefined && requestedYearTo !== undefined && requestedYearFrom > requestedYearTo) throw new HttpError(400, 'Invalid year range: from_year cannot be greater than to_year', 'VALIDATION_ERROR');
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  const journalById = new Map(journals.map(row => [String(row.journal_id || row.id), row]));
  let rows = articles.filter(article => {
    if (isDeleted(article)) return false;
    const id = String(article.article_id || article.id);
    if (scopeLinks.length) { if (!scopeIds.has(id)) return false; }
    else {
      const topicMatches = scopeTopicIds.has(String(article.primary_topic || '')) || [...(topicLinksByArticle.get(id) || [])].some(topicId => scopeTopicIds.has(topicId));
      const keywordMatches = [...(keywordIdsByArticle.get(id) || [])].some(keywordId => scopeKeywordIds.has(keywordId));
      if (!topicMatches && !keywordMatches) return false;
    }
    if (requestedArea) {
      const topicIds = new Set([String(article.primary_topic || ''), ...(topicLinksByArticle.get(id) || [])]);
      const matches = [...topicIds].some(topicId => {
        const categoryId = topicById.get(topicId)?.subject_category_id;
        const category = categories.find(row => String(row.subject_category_id || row.id) === String(categoryId));
        const subjectArea = areas.find(row => String(row.subject_area_id || row.id) === String(category?.subject_area_id));
        return String(subjectArea?.display_name || '').toLowerCase() === requestedArea;
      });
      if (!matches) return false;
    }
    if (requestedKeywords.length && ![...(keywordIdsByArticle.get(id) || [])].some(keywordId => requestedKeywords.includes(String(keywordById.get(keywordId)?.display_name || '').toLowerCase()))) return false;
    const year = yearOf(article);
    if (requestedYearFrom && (year == null || year < requestedYearFrom)) return false;
    if (requestedYearTo && (year == null || year > requestedYearTo)) return false;
    if (ctx.query.is_open_access === 'true' || ctx.query.is_open_access === true) {
      const issue = issueById.get(String(article.issue_id)); const volume = volumeById.get(String(issue?.volume_id)); const journal = journalById.get(String(volume?.journal_id));
      if (journal?.is_open_access !== true) return false;
    }
    return true;
  });
  const articleAuthors = new Map();
  for (const link of authorLinks) add(articleAuthors, String(link.article_id), String(link.author_id));
  const authorById = new Map(authors.map(row => [String(row.author_id || row.id), row]));
  rows.sort((a, b) => {
    const yearA = yearOf(a); const yearB = yearOf(b);
    if (yearA !== yearB) return yearB == null ? 1 : yearA == null ? -1 : yearB - yearA;
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
  const total = rows.length; const totalPages = Math.ceil(total / limit);
  const items = rows.slice((page - 1) * limit, page * limit).map(article => {
    const id = String(article.article_id || article.id); const issue = issueById.get(String(article.issue_id)); const volume = volumeById.get(String(issue?.volume_id)); const journal = journalById.get(String(volume?.journal_id));
    const authorNames = [...(articleAuthors.get(id) || [])].map(authorId => authorById.get(authorId)?.display_name).filter(Boolean);
    const keywordNames = [...(keywordIdsByArticle.get(id) || [])].map(keywordId => keywordById.get(keywordId)?.display_name).filter(Boolean);
    return { id: article.article_id || article.id, title: article.title, description: article.abstract, publishedYear: article.publication_year, isOpenAccess: journal?.is_open_access === true, authors: authorNames.join(', ') || 'Unknown Authors', keywords: keywordNames.join(', '), isBookmarked: false };
  });
  return { total, totalPages, currentPage: page, items };
}
async function sourceInfluentialRankings(ctx, scopedArticles = null) {
  requireProjectAnalytics(ctx.query);
  const articles = scopedArticles || await collaborationScopedArticles(ctx);
  const limit = ctx.query.limit === undefined ? 10 : number(ctx.query.limit, NaN);
  if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, 'limit must be a positive integer', 'VALIDATION_ERROR');
  const [authors, institutions, authorLinks, institutionLinks] = await Promise.all([
    all(ctx.db, 'authors'), all(ctx.db, 'institutions'), all(ctx.db, 'author_articles'), all(ctx.db, 'institution_authors'),
  ]);
  const { articleById, authorById, institutionById, articlesByAuthor, articlesByInstitution } = collaborationEntities(articles, authors, institutions, authorLinks, institutionLinks);
  const authorsRaw = [];
  for (const [authorId, ids] of articlesByAuthor) {
    const author = authorById.get(authorId);
    const name = author.display_name;
    if (!ids?.size || isDeleted(author) || !name) continue;
    const citations = [...ids].reduce((sum, id) => sum + number(articleById.get(id)?.citation_count), 0);
    authorsRaw.push({ name, rawScore: ids.size * 0.3 + citations * 0.5 + number(author.h_index) * 0.2, metric: 'Impact Score' });
  }
  const institutionsRaw = [];
  for (const [institutionId, ids] of articlesByInstitution) {
    const institution = institutionById.get(institutionId); const name = institution?.display_name;
    if (!name || isDeleted(institution)) continue;
    const citations = [...ids].reduce((sum, id) => sum + number(articleById.get(id)?.citation_count), 0);
    institutionsRaw.push({ name, rawScore: ids.size * 0.4 + citations * 0.6, metric: 'Citations' });
  }
  const normalize = rows => {
    if (!rows.length) return [];
    const scores = rows.map(row => row.rawScore); const min = Math.min(...scores); const max = Math.max(...scores);
    return rows.map(({ rawScore, ...row }) => ({ ...row, score: max === min ? (max > 0 ? 100 : 0) : Math.round((rawScore - min) / (max - min) * 1000) / 10 }))
      .filter(row => row.name != null && String(row.name).trim() && Number.isFinite(row.score))
      .sort((a, b) => b.score - a.score).slice(0, limit).map((row, index) => ({ rank: index + 1, name: String(row.name).trim(), score: row.score, metric: row.metric }));
  };
  return { authors: normalize(authorsRaw), institutions: normalize(institutionsRaw) };
}
async function sourceProductivityMatrix(ctx, scopedArticles = null) {
  requireProjectAnalytics(ctx.query);
  const limit = ctx.query.limit === undefined ? 50 : number(ctx.query.limit, NaN);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'limit must be a positive integer no greater than 200', 'VALIDATION_ERROR');
  const fromSupplied = ctx.query.from_year !== undefined && ctx.query.from_year !== '';
  const toSupplied = ctx.query.to_year !== undefined && ctx.query.to_year !== '';
  const fromYear = fromSupplied ? number(ctx.query.from_year, NaN) : undefined;
  const toYear = toSupplied ? number(ctx.query.to_year, NaN) : undefined;
  if (fromSupplied && !Number.isInteger(fromYear) || toSupplied && !Number.isInteger(toYear)) throw new HttpError(400, 'from_year and to_year must be integers', 'VALIDATION_ERROR');
  if (fromSupplied && toSupplied && fromYear > toYear) throw new HttpError(400, 'Invalid year range: from_year cannot be greater than to_year', 'VALIDATION_ERROR');
  const articles = scopedArticles || await collaborationScopedArticles(ctx);
  const [authors, authorLinks] = await Promise.all([all(ctx.db, 'authors'), all(ctx.db, 'author_articles')]);
  const { articleById, authorById, articlesByAuthor } = collaborationEntities(articles, authors, [], authorLinks, []);
  const byAuthor = new Map();
  for (const [authorId, articleIds] of articlesByAuthor) {
    const years = new Map();
    for (const articleId of articleIds) {
      const year = yearOf(articleById.get(articleId)); const yearKey = year == null ? null : year;
      if (!years.has(yearKey)) years.set(yearKey, new Set());
      years.get(yearKey).add(articleId);
    }
    byAuthor.set(authorId, years);
  }
  let openAlexAuthors = [];
  try {
    const authorIds = [
      ...articles.flatMap(article => (article.authors || []).map(author => author.openalex_id || author.author_id || author.id)),
      ...[...byAuthor.keys()].map(authorId => authorById.get(authorId)?.openalex_id || authorId),
    ];
    openAlexAuthors = await getOpenAlexAuthorsByIds(ctx, authorIds);
  } catch (error) {
    console.warn('[analytics] OpenAlex author metrics unavailable for productivity matrix:', error?.message || error);
  }
  const hIndexByAuthorId = new Map(openAlexAuthors.map(author => {
    const openAlexId = String(author.id || '').split('/').pop().toUpperCase();
    const numericId = openAlexId.match(/^A(\d+)$/)?.[1];
    return [numericId || openAlexId, number(author.summary_stats?.h_index)];
  }));
  const points = [];
  for (const [authorId, years] of byAuthor) {
    const author = authorById.get(authorId);
    if (!author || isDeleted(author)) continue;
    let yearlyOutput;
    if (fromSupplied && toSupplied) {
      const count = [...years].filter(([year]) => year != null && year >= fromYear && year <= toYear).reduce((sum, [, ids]) => sum + ids.size, 0);
      yearlyOutput = Math.round(count / (toYear - fromYear + 1));
    } else {
      const orderedYears = [...years.keys()].sort((a, b) => a == null ? -1 : b == null ? 1 : b - a);
      yearlyOutput = years.get(orderedYears[0])?.size || 0;
    }
    const hIndex = hIndexByAuthorId.get(authorId) ?? number(author.h_index);
    if (yearlyOutput > 0 && hIndex >= 0) points.push({ authorId: String(author.author_id || author.id), authorName: author.display_name || null, yearlyOutput, hIndex });
  }
  return points.sort((a, b) => b.hIndex - a.hIndex || b.yearlyOutput - a.yearlyOutput).slice(0, limit);
}
async function sourceTopicIntensityMatrix(ctx, scopedArticles = null) {
  requireProjectAnalytics(ctx.query);
  const rowType = String(ctx.query.row_type || 'author').trim().toLowerCase();
  const rowLimit = number(ctx.query.limit_rows, 10); const topicLimit = number(ctx.query.limit_topics, 8);
  const from = ctx.query.from_year !== undefined && ctx.query.from_year !== '' ? number(ctx.query.from_year, NaN) : undefined;
  const to = ctx.query.to_year !== undefined && ctx.query.to_year !== '' ? number(ctx.query.to_year, NaN) : undefined;
  if (!['author', 'institution'].includes(rowType)) throw new HttpError(400, 'row_type must be author or institution', 'VALIDATION_ERROR');
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 50 || !Number.isInteger(topicLimit) || topicLimit < 1 || topicLimit > 30) throw new HttpError(400, 'Invalid matrix limits', 'VALIDATION_ERROR');
  if (from !== undefined && !Number.isInteger(from) || to !== undefined && !Number.isInteger(to)) throw new HttpError(400, 'from_year and to_year must be integers', 'VALIDATION_ERROR');
  if (from && to && from > to) throw new HttpError(400, 'Invalid year range', 'VALIDATION_ERROR');
  const articles = scopedArticles || await collaborationScopedArticles(ctx);
  const [authors, institutions, authorLinks, institutionLinks, subTopics, topics] = await Promise.all([
    all(ctx.db, 'authors'), all(ctx.db, 'institutions'), all(ctx.db, 'author_articles'), all(ctx.db, 'institution_authors'), all(ctx.db, 'sub_topics'), all(ctx.db, 'topics'),
  ]);
  const { articleById, authorById, institutionById, authorsByArticle, institutionsByArticle } = collaborationEntities(articles, authors, institutions, authorLinks, institutionLinks);
  const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
  const topicsByArticle = new Map(); const topicNameById = new Map(topics.map(row => [String(row.topic_id || row.id), row.display_name]));
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); };
  for (const link of subTopics) if (articleById.has(String(link.article_id))) add(topicsByArticle, String(link.article_id), String(link.topic_id));
  for (const article of articles) {
    const articleId = String(article.article_id || article.id);
    if (article.primary_topic != null) add(topicsByArticle, articleId, String(article.primary_topic));
    for (const topic of article.topics || []) {
      const topicId = String(topic.topic_id || topic.id || '');
      if (!topicId) continue;
      add(topicsByArticle, articleId, topicId);
      if (topic.display_name) topicNameById.set(topicId, topic.display_name);
    }
    for (const topicId of article.topic_ids || []) add(topicsByArticle, articleId, String(topicId));
  }
  const rowArticles = new Map(); const topicArticles = new Map(); const rowTopicArticles = new Map(); const rowNames = new Map();
  for (const [articleId, article] of articleById) {
    const topicIds = topicsByArticle.get(articleId) || new Set();
    for (const topicId of topicIds) add(topicArticles, topicId, articleId);
    const authorsForArticle = authorsByArticle.get(articleId) || new Set(); const rowsForArticle = new Set();
    if (rowType === 'author') {
      for (const authorId of authorsForArticle) {
        if (!authorById.has(authorId)) continue;
        rowsForArticle.add(authorId);
        rowNames.set(authorId, authorById.get(authorId)?.display_name || 'Unknown Author');
      }
    } else {
      for (const institutionId of institutionsByArticle.get(articleId) || []) {
        const institution = institutionById.get(institutionId);
        if (!institution || isDeleted(institution)) continue;
        rowsForArticle.add(institutionId);
        rowNames.set(institutionId, institution?.display_name || 'Unknown Institution');
      }
    }
    for (const rowId of rowsForArticle) {
      add(rowArticles, rowId, articleId);
      for (const topicId of topicIds) add(rowTopicArticles, `${rowId}|${topicId}`, articleId);
    }
  }
  const selectedRows = [...rowArticles].sort((a, b) => b[1].size - a[1].size).slice(0, rowLimit).map(([id]) => id);
  const selectedTopics = [...topicArticles].sort((a, b) => b[1].size - a[1].size).slice(0, topicLimit).map(([id]) => id);
  if (!selectedRows.length || !selectedTopics.length) return [];
  let maxCount = 0;
  for (const rowId of selectedRows) for (const topicId of selectedTopics) maxCount = Math.max(maxCount, rowTopicArticles.get(`${rowId}|${topicId}`)?.size || 0);
  const result = [];
  for (const rowId of selectedRows) for (const topicId of selectedTopics) {
    const count = rowTopicArticles.get(`${rowId}|${topicId}`)?.size || 0;
    result.push({ rowName: rowNames.get(rowId), topic: topicNameById.get(topicId) || topicById.get(topicId)?.display_name || 'Unknown Topic', intensity: maxCount ? Number((count / maxCount).toFixed(3)) : 0 });
  }
  return result;
}
async function sourceJournalMigration(ctx) {
  const query = ctx.query;
  const hasProject = Boolean(query.project_id && !['undefined', 'null'].includes(String(query.project_id)));
  if (hasProject) {
    const projectArticles = await sourceJournalArticles(ctx, 'ranking');
    const sources = await getOpenAlexSourcesByIds(ctx, projectArticles.map(article => article.journal_source_id || article.journal_openalex_id));
    const normalizeSourceId = value => {
      const id = String(value || '').trim().replace(/\/+$/, '').split('/').pop().toUpperCase();
      return /^\d+$/.test(id) ? `S${id}` : id;
    };
    const sourceById = new Map(sources.map(row => [normalizeSourceId(row.id), row]));
    const accessByJournal = new Map();
    for (const article of projectArticles) {
      const id = normalizeSourceId(article.journal_source_id || article.journal_openalex_id || article.journal_id);
      if (!id) continue;
      const source = sourceById.get(id);
      const access = source?.is_oa;
      if (typeof access === 'boolean') accessByJournal.set(id, access);
    }
    const includeLegacy = query.include_legacy === undefined || !['false', '0'].includes(String(query.include_legacy).toLowerCase());
    const openAccessCount = [...accessByJournal.values()].filter(Boolean).length;
    const closedCount = [...accessByJournal.values()].filter(value => !value).length;
    const flows = [
      { source: 'SUBSCRIPTION', target: 'FULL_OPEN_ACCESS', value: openAccessCount },
      { source: 'SUBSCRIPTION', target: 'LEGACY_MODEL', value: closedCount },
    ].filter(flow => includeLegacy || flow.target === 'FULL_OPEN_ACCESS');
    const totalCount = flows.reduce((sum, flow) => sum + flow.value, 0);
    return { totalCount, transitionRate: totalCount ? Math.round(openAccessCount / totalCount * 1000) / 10 : 0, flows };
  }
  const [areas, categories, topics, articles, topicLinks, issues, volumes, journals] = await Promise.all([
    all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories'), all(ctx.db, 'topics'), all(ctx.db, 'articles'),
    all(ctx.db, 'sub_topics'), all(ctx.db, 'issues'), all(ctx.db, 'volumes'), all(ctx.db, 'journals'),
  ]);
  let mappedDomain = 'all'; let categoryIds = [];
  if (hasProject) {
    const project = await requireProject(ctx, query.project_id);
    const area = projectAreaFor(project, areas);
    if (!area || isDeleted(area)) throw new HttpError(404, 'Project not found or has no associated subject area', 'NOT_FOUND');
    mappedDomain = String(area.display_name || area.name || 'all');
    categoryIds = categories.filter(row => !isDeleted(row) && String(row.subject_area_id) === String(area.subject_area_id || area.id))
      .map(row => String(row.subject_category_id || row.id));
  }
  const filterCategory = String(query.keywords || '').trim();
  const filterArea = String(query.subject_area || '').trim();
  const categoryActive = filterCategory && !['all', 'all categories', 'all domains'].includes(filterCategory.toLowerCase());
  const areaActive = filterArea && !['all', 'all areas', 'all domains'].includes(filterArea.toLowerCase());
  if (categoryActive) {
    const category = categories.find(row => !isDeleted(row) && (String(row.subject_category_id || row.id) === filterCategory || String(row.display_name || row.name || '').toLowerCase() === filterCategory.toLowerCase()));
    categoryIds = category ? [String(category.subject_category_id || category.id)] : [];
    if (category) {
      const parent = areas.find(row => String(row.subject_area_id || row.id) === String(category.subject_area_id));
      mappedDomain = String(parent?.display_name || parent?.name || mappedDomain);
    }
  } else if (areaActive) {
    const area = areas.find(row => !isDeleted(row) && (String(row.subject_area_id || row.id) === filterArea || String(row.display_name || row.name || '').toLowerCase() === filterArea.toLowerCase()));
    if (area) {
      mappedDomain = String(area.display_name || area.name || 'all');
      categoryIds = categories.filter(row => !isDeleted(row) && String(row.subject_area_id) === String(area.subject_area_id || area.id))
        .map(row => String(row.subject_category_id || row.id));
    } else if (!hasProject) { mappedDomain = 'all'; categoryIds = []; }
  }
  const topicIds = new Set(topics.filter(row => categoryIds.length ? categoryIds.includes(String(row.subject_category_id))
    : mappedDomain !== 'all' ? String(categories.find(category => String(category.subject_category_id || category.id) === String(row.subject_category_id))?.subject_area_id || '') === String(areas.find(area => String(area.display_name || area.name || '').toLowerCase() === mappedDomain.toLowerCase())?.subject_area_id || '__none__')
      : true).map(row => String(row.topic_id || row.id)));
  const applyTopicScope = categoryIds.length > 0 || mappedDomain !== 'all';
  const topicIdsByArticle = new Map();
  for (const link of topicLinks) addTopicId(topicIdsByArticle, String(link.article_id || ''), String(link.topic_id || ''));
  const matchedArticleIds = new Set();
  for (const article of articles) {
    if (isDeleted(article)) continue;
    const id = String(article.article_id || article.id);
    if (!applyTopicScope || topicIds.has(String(article.primary_topic || '')) || [...(topicIdsByArticle.get(id) || [])].some(topicId => topicIds.has(topicId))) matchedArticleIds.add(id);
  }
  const issueById = new Map(issues.map(row => [String(row.issue_id || row.id), row]));
  const volumeById = new Map(volumes.map(row => [String(row.volume_id || row.id), row]));
  const journalById = new Map(journals.map(row => [String(row.journal_id || row.id), row]));
  const journalIds = new Set();
  for (const article of articles) {
    if (!matchedArticleIds.has(String(article.article_id || article.id))) continue;
    const issue = issueById.get(String(article.issue_id)); const volume = volumeById.get(String(issue?.volume_id));
    if (volume?.journal_id != null) journalIds.add(String(volume.journal_id));
  }
  const includeLegacy = query.include_legacy === undefined || !['false', '0'].includes(String(query.include_legacy).toLowerCase());
  const flows = new Map([['SUBSCRIPTION->FULL_OPEN_ACCESS', 0], ['HYBRID->FULL_OPEN_ACCESS', 0], ['SUBSCRIPTION->LEGACY_MODEL', 0], ['HYBRID->LEGACY_MODEL', 0]]);
  for (const id of journalIds) {
    const journal = journalById.get(id); if (!journal || isDeleted(journal)) continue;
    const key = `SUBSCRIPTION->${journal.is_open_access === true ? 'FULL_OPEN_ACCESS' : 'LEGACY_MODEL'}`;
    flows.set(key, (flows.get(key) || 0) + 1);
  }
  const outputFlows = [...flows].map(([key, value]) => { const [source, target] = key.split('->'); return { source, target, value }; })
    .filter(flow => includeLegacy || flow.target === 'FULL_OPEN_ACCESS');
  const totalCount = outputFlows.reduce((sum, flow) => sum + flow.value, 0);
  const openAccessCount = outputFlows.filter(flow => flow.target === 'FULL_OPEN_ACCESS').reduce((sum, flow) => sum + flow.value, 0);
  return { totalCount, transitionRate: totalCount ? Math.round(openAccessCount / totalCount * 1000) / 10 : 0, flows: outputFlows };
}
async function sourceKeywordVectors(ctx) {
  requireProjectAnalytics(ctx.query);
  const parseYear = key => ctx.query[key] ? number(ctx.query[key], NaN) : undefined;
  const fromYear = parseYear('from_year'); const toYear = parseYear('to_year');
  if (fromYear !== undefined && !Number.isFinite(fromYear)) throw new HttpError(400, 'Invalid from_year parameter', 'VALIDATION_ERROR');
  if (toYear !== undefined && !Number.isFinite(toYear)) throw new HttpError(400, 'Invalid to_year parameter', 'VALIDATION_ERROR');
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) throw new HttpError(400, 'Invalid year range', 'VALIDATION_ERROR');
  const windowMonths = ctx.query.window_months === undefined ? 12 : number(ctx.query.window_months, NaN);
  const limit = ctx.query.limit === undefined ? 10 : number(ctx.query.limit, NaN);
  if (!Number.isFinite(windowMonths) || windowMonths <= 0 || windowMonths > 36) throw new HttpError(400, 'Invalid window_months', 'VALIDATION_ERROR');
  if (!Number.isFinite(limit) || limit <= 0) throw new HttpError(400, 'Invalid limit', 'VALIDATION_ERROR');
  const boundedLimit = Math.min(50, limit);
  const query = { ...ctx.query, keywords: ctx.query.keywords || ctx.query.keyword };
  const articles = await collaborationScopedArticles({ ...ctx, query });
  const vectors = await keywordVectors({ ...ctx, query: { ...query, limit: boundedLimit, window_months: windowMonths } }, articles);
  return vectors.slice(0, boundedLimit);
}
function addTopicId(map, articleId, topicId) { if (!map.has(articleId)) map.set(articleId, new Set()); map.get(articleId).add(topicId); }
async function authorProductivityMatrix(ctx, articles) {
  requireProjectAnalytics(ctx.query);
  const authors = await all(ctx.db, 'authors');
  const authorById = new Map(authors.filter(row => !isDeleted(row)).map(row => [String(row.author_id || row.id), row]));
  const rowsByAuthor = new Map();
  for (const article of articles) {
    const year = yearOf(article);
    const ids = new Set([...(article.author_ids || []).map(String), ...(Array.isArray(article.authors) ? article.authors.map(row => String(row.author_id || row.id || '')) : [])].filter(Boolean));
    for (const authorId of ids) {
      if (!rowsByAuthor.has(authorId)) rowsByAuthor.set(authorId, []);
      rowsByAuthor.get(authorId).push({ articleId, year });
    }
  }
  const rangeSupplied = ctx.query.from_year !== undefined && ctx.query.from_year !== '' && ctx.query.to_year !== undefined && ctx.query.to_year !== '';
  const yearCount = rangeSupplied ? number(ctx.query.to_year) - number(ctx.query.from_year) + 1 : null;
  if (rangeSupplied && yearCount <= 0) throw new HttpError(400, 'from_year cannot be greater than to_year', 'VALIDATION_ERROR');
  const points = [...rowsByAuthor].flatMap(([authorId, rows]) => {
    const author = authorById.get(authorId); if (!author) return [];
    let yearlyOutput;
    if (rangeSupplied) yearlyOutput = Math.round(rows.length / yearCount);
    else {
      const latest = Math.max(...rows.map(row => row.year || 0));
      yearlyOutput = rows.filter(row => row.year === latest).length;
    }
    const hIndex = number(author.h_index);
    return yearlyOutput > 0 && hIndex >= 0 ? [{ authorId, authorName: author.display_name || author.full_name || [author.first_name, author.last_name].filter(Boolean).join(' ') || null, yearlyOutput, hIndex }] : [];
  });
  return points.sort((a, b) => b.hIndex - a.hIndex || b.yearlyOutput - a.yearlyOutput).slice(0, Math.min(500, Math.max(1, number(ctx.query.limit, 50))));
}
async function topicIntensityMatrix(ctx, articles) {
  requireProjectAnalytics(ctx.query);
  const rowType = String(ctx.query.row_type || 'author').toLowerCase();
  if (!['author', 'institution'].includes(rowType)) throw new HttpError(400, 'row_type must be author or institution', 'VALIDATION_ERROR');
  const rowLimit = number(ctx.query.limit_rows, 10); const topicLimit = number(ctx.query.limit_topics, 8);
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 50 || !Number.isInteger(topicLimit) || topicLimit < 1 || topicLimit > 30) throw new HttpError(400, 'Invalid matrix limits', 'VALIDATION_ERROR');
  const [authors, institutions, institutionLinks, subTopics, topics] = await Promise.all([
    all(ctx.db, 'authors'), all(ctx.db, 'institutions'), all(ctx.db, 'institution_authors'), all(ctx.db, 'sub_topics'), all(ctx.db, 'topics'),
  ]);
  const authorById = new Map(authors.map(row => [String(row.author_id || row.id), row]));
  const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
  const institutionById = new Map(institutions.map(row => [String(row.institution_id || row.id), row]));
  const topicsByArticle = new Map(); const add = (map, key, value) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); };
  for (const link of subTopics) add(topicsByArticle, String(link.article_id), String(link.topic_id));
  for (const article of articles) {
    const articleId = String(article.article_id || article.id);
    for (const topicId of [...(article.topic_ids || []), article.primary_topic, article.topic_id].filter(Boolean)) add(topicsByArticle, articleId, String(topicId));
  }
  const rows = new Map(); const institutionByAuthorYear = new Map();
  for (const link of institutionLinks) {
    const key = `${link.year}:${String(link.author_id)}`;
    if (!institutionByAuthorYear.has(key)) institutionByAuthorYear.set(key, new Set());
    institutionByAuthorYear.get(key).add(String(link.institution_id));
  }
  const articleSetsByRowTopic = new Map(); const articleCountsByRow = new Map(); const topicArticleCounts = new Map();
  for (const article of articles) {
    const articleId = String(article.article_id || article.id); const year = yearOf(article);
    const topicIds = topicsByArticle.get(articleId) || new Set();
    for (const topicId of topicIds) topicArticleCounts.set(topicId, (topicArticleCounts.get(topicId) || new Set()).add(articleId));
    let rowIds;
    if (rowType === 'author') rowIds = new Set((article.author_ids || []).map(String));
    else {
      rowIds = new Set();
      for (const authorId of article.author_ids || []) for (const institutionId of institutionByAuthorYear.get(`${year}:${String(authorId)}`) || []) rowIds.add(institutionId);
    }
    for (const rowId of rowIds) {
      if (!rows.has(rowId)) rows.set(rowId, { id: rowId, name: rowType === 'author' ? authorById.get(rowId)?.display_name || 'Unknown Author' : institutionById.get(rowId)?.display_name || institutionById.get(rowId)?.name || 'Unknown Institution', articles: new Set() });
      rows.get(rowId).articles.add(articleId);
      for (const topicId of topicIds) {
        const key = `${rowId}|${topicId}`;
        if (!articleSetsByRowTopic.has(key)) articleSetsByRowTopic.set(key, new Set());
        articleSetsByRowTopic.get(key).add(articleId);
      }
    }
  }
  const selectedRows = [...rows.values()].sort((a, b) => b.articles.size - a.articles.size).slice(0, rowLimit);
  const selectedTopics = [...topicArticleCounts].sort((a, b) => b[1].size - a[1].size).slice(0, topicLimit).map(([id]) => id);
  if (!selectedRows.length || !selectedTopics.length) return [];
  let globalMax = 0;
  for (const row of selectedRows) for (const topicId of selectedTopics) globalMax = Math.max(globalMax, articleSetsByRowTopic.get(`${row.id}|${topicId}`)?.size || 0);
  const result = [];
  for (const row of selectedRows) for (const topicId of selectedTopics) {
    const count = articleSetsByRowTopic.get(`${row.id}|${topicId}`)?.size || 0;
    result.push({ rowName: row.name, topic: topicById.get(topicId)?.display_name || topicById.get(topicId)?.name || 'Unknown Topic', intensity: globalMax ? Number((count / globalMax).toFixed(3)) : 0 });
  }
  return result;
}
function journalMigration(articles, journals, query) {
  const journalIds = new Set(articles.map(row => String(row.journal_id || '')).filter(Boolean));
  const includeLegacy = query.include_legacy === undefined || !['false', '0'].includes(String(query.include_legacy).toLowerCase());
  const flows = new Map([
    ['SUBSCRIPTION->FULL_OPEN_ACCESS', 0], ['HYBRID->FULL_OPEN_ACCESS', 0],
    ['SUBSCRIPTION->LEGACY_MODEL', 0], ['HYBRID->LEGACY_MODEL', 0],
  ]);
  for (const journal of journals) {
    const journalId = String(journal.journal_id || journal.id || '');
    if (!journalIds.has(journalId) || isDeleted(journal)) continue;
    const target = Boolean(journal.is_open_access) ? 'FULL_OPEN_ACCESS' : 'LEGACY_MODEL';
    if (!includeLegacy && target !== 'FULL_OPEN_ACCESS') continue;
    const key = `SUBSCRIPTION->${target}`;
    flows.set(key, (flows.get(key) || 0) + 1);
  }
  const mappedFlows = [...flows].map(([key, value]) => {
    const [source, target] = key.split('->');
    return { source, target, value };
  }).filter(flow => includeLegacy || flow.target === 'FULL_OPEN_ACCESS');
  const totalCount = mappedFlows.reduce((sum, flow) => sum + flow.value, 0);
  const openAccessCount = mappedFlows.filter(flow => flow.target === 'FULL_OPEN_ACCESS').reduce((sum, flow) => sum + flow.value, 0);
  return { totalCount, transitionRate: totalCount ? Math.round(openAccessCount / totalCount * 1000) / 10 : 0, flows: mappedFlows };
}
const ANALYTICS_DIRECTORY_CACHE_TTL_MS = 5 * 60 * 1000;
let zoneDirectoryCache = null;
let zoneDirectoryPending = null;
let subjectAreasCache = new Map();
let subjectAreasPending = new Map();

async function zoneDirectory(db) {
  if (zoneDirectoryCache && zoneDirectoryCache.expiresAt > Date.now()) return zoneDirectoryCache.value;
  if (zoneDirectoryPending) return zoneDirectoryPending;
  zoneDirectoryPending = (async () => {
    const [zones, journals] = await Promise.all([all(db, 'zones'), all(db, 'journals')]);
    const counts = { REGION: new Map(), COUNTRY: new Map() };
    for (const journal of journals) {
      const region = String(journal.region || '');
      const country = String(journal.country || '');
      if (region) counts.REGION.set(region, (counts.REGION.get(region) || 0) + 1);
      if (country) counts.COUNTRY.set(country, (counts.COUNTRY.get(country) || 0) + 1);
    }
    const format = type => zones
      .filter(zone => String(zone.type || '').toUpperCase() === type)
      .map(zone => {
        const idValue = zone.zone_id || zone.id;
        const journalCount = counts[type].get(String(idValue)) || 0;
        return {
          zone_id: Number(idValue) || idValue,
          code: zone.code || zone.iso_code || null,
          name: zone.name || zone.display_name || '',
          type,
          journal_count: journalCount,
        };
      })
      .filter(row => row.journal_count > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const value = { regions: format('REGION'), countries: format('COUNTRY') };
    zoneDirectoryCache = { value, expiresAt: Date.now() + ANALYTICS_DIRECTORY_CACHE_TTL_MS };
    return value;
  })();
  try {
    return await zoneDirectoryPending;
  } finally {
    zoneDirectoryPending = null;
  }
}

async function activeTopicIdsWithArticles(db, topics) {
  const analyticsRows = await all(db, 'analytics_topic_year');
  const articleTopics = new Set(analyticsRows.filter(row => Number(row.article_count) > 0).map(row => String(row.topic_id)));
  const knownTopics = new Set(topics.map(row => String(row.topic_id || row.id)));
  return new Set([...articleTopics].filter(topicId => knownTopics.has(topicId)));
}
function projectAreaFor(project, areas) {
  const value = String(project.subject_area || project.subject_area_id || '');
  return areas.find(row => String(row.subject_area_id || row.id) === value || String(row.display_name || row.name || '').toLowerCase() === value.toLowerCase()) || null;
}
async function projectSubjectCategories(ctx) {
  const project = requireFound(await byId(ctx.db, 'projects', ctx.query.project_id), 'Project not found or has no associated subject area');
  const [areas, categories, topics] = await Promise.all([all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories'), all(ctx.db, 'topics')]);
  const area = projectAreaFor(project, areas);
  if (!area || isDeleted(area)) throw new HttpError(404, 'Project not found or has no associated subject area', 'NOT_FOUND');
  const areaId = String(area.subject_area_id || area.id);
  const topicIds = await activeTopicIdsWithArticles(ctx.db, topics);
  const categoryRows = categories.filter(category => !isDeleted(category) && String(category.subject_area_id || '') === areaId && topics.some(topic => String(topic.subject_category_id || '') === String(category.subject_category_id || category.id) && topicIds.has(String(topic.topic_id || topic.id))))
    .map(category => ({ subject_category_id: Number(category.subject_category_id || category.id), display_name: category.display_name || category.name || '', description: category.description || null }))
    .filter(category => !ctx.query.search || category.display_name.toLowerCase().includes(String(ctx.query.search).toLowerCase()))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  const page = Math.max(1, Number(ctx.query.page) || 1);
  const limit = Math.min(1000, Math.max(1, Number(ctx.query.limit) || 1000));
  return {
    subject_area: { id: Number(areaId) || areaId, name: area.display_name || area.name || '' },
    items: categoryRows.slice((page - 1) * limit, page * limit),
    pagination: { page, limit, total: categoryRows.length, total_pages: Math.ceil(categoryRows.length / limit) },
  };
}
async function subjectAreasHierarchy(ctx) {
  const projectId = ctx.query.project_id && ctx.query.project_id !== 'default-id' && Number.isFinite(Number(ctx.query.project_id)) ? String(ctx.query.project_id) : null;
  const cacheKey = projectId || 'all';
  const cached = subjectAreasCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (subjectAreasPending.has(cacheKey)) return subjectAreasPending.get(cacheKey);

  const pending = (async () => {
  const [areas, categories] = await Promise.all([all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories')]);
  let projectArea = null;
  if (projectId) {
    const project = await byId(ctx.db, 'projects', projectId);
    const area = project && projectAreaFor(project, areas);
    if (area && !isDeleted(area)) projectArea = { id: Number(area.subject_area_id || area.id) || area.subject_area_id || area.id, name: area.display_name || area.name || '' };
  }

  const areaById = new Map(areas
    .filter(area => !isDeleted(area))
    .map(area => [String(area.subject_area_id || area.id), area]));
  const areaMap = new Map();
  for (const category of categories) {
    if (isDeleted(category)) continue;
    const areaId = String(category.subject_area_id || '');
    const area = areaById.get(areaId);
    if (!area) continue;
    const idValue = area.subject_area_id || area.id;
    if (!areaMap.has(String(idValue))) areaMap.set(String(idValue), { id: Number(idValue) || idValue, name: area.display_name || area.name || '', categories: [] });
    areaMap.get(String(idValue)).categories.push({ id: Number(category.subject_category_id || category.id) || category.subject_category_id || category.id, name: category.display_name || category.name || '' });
  }
  const items = [...areaMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) item.categories.sort((a, b) => a.name.localeCompare(b.name));
  const value = { projectArea, items };
  subjectAreasCache.set(cacheKey, { value, expiresAt: Date.now() + ANALYTICS_DIRECTORY_CACHE_TTL_MS });
  return value;
  })();
  subjectAreasPending.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    subjectAreasPending.delete(cacheKey);
  }
}

async function journalMigrationData(ctx, journals) {
  requireProjectAnalytics(ctx.query);
  const project = requireFound(await byId(ctx.db, 'projects', ctx.query.project_id), 'Project not found');
  const [rawArticles, areas, categories, topics, subTopics] = await Promise.all([
    all(ctx.db, 'articles'), all(ctx.db, 'subjectAreas'), all(ctx.db, 'subjectCategories'), all(ctx.db, 'topics'), all(ctx.db, 'sub_topics'),
  ]);
  const areaValue = String(ctx.query.subject_area || project.subject_area || project.subject_area_id || '');
  const projectAreaValue = String(project.subject_area || project.subject_area_id || '');
  const area = areas.find(row => String(row.subject_area_id || row.id) === areaValue || String(row.display_name || row.name || '').toLowerCase() === areaValue.toLowerCase())
    || areas.find(row => String(row.subject_area_id || row.id) === projectAreaValue || String(row.display_name || row.name || '').toLowerCase() === projectAreaValue.toLowerCase());
  const areaId = String(area?.subject_area_id || area?.id || '');
  let scopedCategories = categories.filter(row => !isDeleted(row) && String(row.subject_area_id || '') === areaId);
  const categoryFilter = String(ctx.query.keywords || ctx.query.subject_category || '').split(',').map(value => value.trim()).filter(Boolean);
  if (categoryFilter.length) {
    const matched = scopedCategories.filter(row => categoryFilter.some(value => String(row.subject_category_id || row.id) === value || String(row.display_name || row.name || '').toLowerCase() === value.toLowerCase()));
    if (matched.length) scopedCategories = matched;
  }
  const categoryIds = new Set(scopedCategories.map(row => String(row.subject_category_id || row.id)));
  const topicIds = new Set(topics.filter(row => categoryIds.has(String(row.subject_category_id || ''))).map(row => String(row.topic_id || row.id)));
  const subTopicsByArticle = new Map();
  for (const link of subTopics) {
    const articleId = String(link.article_id || '');
    if (!subTopicsByArticle.has(articleId)) subTopicsByArticle.set(articleId, new Set());
    subTopicsByArticle.get(articleId).add(String(link.topic_id || ''));
  }
  const articles = (await hydrateArticles(ctx.db, rawArticles)).filter(article => {
    if (isDeleted(article)) return false;
    if (!categoryIds.size) return !areaId;
    const articleId = String(article.article_id || article.id);
    return topicIds.has(String(article.primary_topic || '')) || [...(article.topic_ids || []), ...(subTopicsByArticle.get(articleId) || [])].some(topicId => topicIds.has(String(topicId)));
  });
  return journalMigration(articles, journals, ctx.query);
}
async function topology(ctx, articles) {
  requireProjectAnalytics(ctx.query);
  const networkType = String(ctx.query.network_type || 'all').toLowerCase();
  if (!['all', 'conceptual', 'collaboration'].includes(networkType)) throw new HttpError(400, 'network_type must be all, conceptual, or collaboration', 'VALIDATION_ERROR');
  const [authors, keywords] = await Promise.all([all(ctx.db, 'authors'), all(ctx.db, 'keywords')]);
  const authorById = new Map(authors.map(row => [String(row.author_id || row.id), row]));
  const keywordById = new Map(keywords.map(row => [String(row.keyword_id || row.id), row]));
  const allNodes = []; const allEdges = [];
  if (networkType === 'all' || networkType === 'conceptual') {
    const keywordArticleCounts = new Map(); const keywordPairs = new Map();
    for (const article of articles) {
      const ids = [...new Set((article.keyword_ids || []).map(String))];
      for (const id of ids) keywordArticleCounts.set(id, (keywordArticleCounts.get(id) || 0) + 1);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const [from, to] = [ids[i], ids[j]].sort(); const key = `${from}|${to}`;
        keywordPairs.set(key, (keywordPairs.get(key) || 0) + 1);
      }
    }
    for (const [id, size] of keywordArticleCounts) allNodes.push({ id: `kw_${id}`, label: keywordById.get(id)?.display_name || keywordById.get(id)?.name || 'Unknown', type: 'KEYWORD', size });
    for (const [pair, weight] of keywordPairs) { const [from, to] = pair.split('|'); allEdges.push({ from: `kw_${from}`, to: `kw_${to}`, type: 'CONCEPTUAL_PROXIMITY', weight }); }
  }
  if (networkType === 'all' || networkType === 'collaboration') {
    const authorArticleCounts = new Map(); const authorPairs = new Map();
    for (const article of articles) {
      const ids = [...new Set((article.author_ids || []).map(String))];
      for (const id of ids) authorArticleCounts.set(id, (authorArticleCounts.get(id) || 0) + 1);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const [from, to] = [ids[i], ids[j]].sort(); const key = `${from}|${to}`;
        authorPairs.set(key, (authorPairs.get(key) || 0) + 1);
      }
    }
    for (const [id, size] of authorArticleCounts) allNodes.push({ id: `auth_${id}`, label: authorById.get(id)?.display_name || authorById.get(id)?.full_name || 'Unknown', type: 'AUTHOR', size });
    for (const [pair, weight] of authorPairs) { const [from, to] = pair.split('|'); allEdges.push({ from: `auth_${from}`, to: `auth_${to}`, type: 'CO_AUTHORSHIP', weight }); }
  }
  if (!allNodes.length) return { nodes: [], edges: [] };
  allNodes.sort((a, b) => b.size - a.size);
  const nodes = allNodes.slice(0, Math.min(500, Math.max(1, number(ctx.query.limit_nodes, 50))));
  const allowed = new Set(nodes.map(node => node.id)); const edges = allEdges.filter(edge => allowed.has(edge.from) && allowed.has(edge.to));
  const sizes = nodes.map(node => node.size); const maxSize = Math.max(...sizes); const minSize = Math.min(...sizes);
  for (const node of nodes) node.size = maxSize === minSize ? 20 : Math.round((10 + (node.size - minSize) / (maxSize - minSize) * 30) * 100) / 100;
  const maxWeight = Math.max(0, ...edges.map(edge => edge.weight));
  const minWeight = Math.max(0, number(ctx.query.min_weight, 0.1));
  const normalizedEdges = edges.map(edge => ({ ...edge, weight: maxWeight ? Math.round(edge.weight / maxWeight * 100) / 100 : 0 }))
    .filter(edge => edge.weight >= minWeight).map(edge => ({ ...edge, label: String(edge.weight) })).sort((a, b) => b.weight - a.weight);
  return { nodes, edges: normalizedEdges };
}
async function keywordVectors(ctx, scopedArticles = null) {
  const articles = scopedArticles || await filteredArticles(ctx);
  const vector = ctx.query.vector ? String(ctx.query.vector).split(',').map(Number) : null;
  if (vector?.length && vector.every(Number.isFinite)) {
    try {
      const rows = await ctx.db.query('articles', { findNearest: { field: 'embedding', vector, limit: number(ctx.query.limit, 20), distanceResultField: 'distance' } });
      const scopedIds = new Set(articles.map(row => String(row.article_id || row.id)));
      return rows.filter(row => scopedIds.has(String(row.article_id || row.id))).map(row => ({ ...row, similarity: 1 - number(row.distance) }));
    } catch (error) { console.warn('[analytics] Firestore vector search unavailable; using keyword growth vectors', error.message); }
  }
  requireProjectAnalytics(ctx.query);
  if (!articles.length) return [];
  const latestYear = Math.max(...articles.map(yearOf).filter(Boolean), 0);
  if (!latestYear) return [];
  const windowYears = Math.min(20, Math.max(1, Math.ceil(number(ctx.query.window_months || ctx.query.windowMonths, 12) / 12)));
  const currentYears = new Set(Array.from({ length: windowYears }, (_, index) => latestYear - index));
  const previousYears = new Set(Array.from({ length: windowYears }, (_, index) => latestYear - windowYears - index));
  const [keywords, links] = await Promise.all([all(ctx.db, 'keywords'), all(ctx.db, 'keyword_articles')]);
  const keywordById = new Map(keywords.map(row => [String(row.keyword_id || row.id), row]));
  const articlesById = new Map(articles.map(row => [String(row.article_id || row.id), row]));
  const counts = new Map();
  for (const link of links) {
    const article = articlesById.get(String(link.article_id)); const keywordId = String(link.keyword_id || '');
    if (!article || !keywordId || !keywordById.has(keywordId)) continue;
    const year = yearOf(article); const item = counts.get(keywordId) || { current: new Set(), previous: new Set() };
    if (currentYears.has(year)) item.current.add(String(link.article_id));
    if (previousYears.has(year)) item.previous.add(String(link.article_id));
    counts.set(keywordId, item);
  }
  const result = [...counts].map(([keywordId, item]) => {
    const volume = item.current.size; const previous = item.previous.size;
    const growth = previous === 0 ? (volume > 0 ? 100 : 0) : (volume - previous) / previous * 100;
    const keyword = keywordById.get(keywordId);
    return { keyword: String(keyword.display_name || keyword.name || keyword.keyword || '').trim(), volume, growth: Math.round(growth * 10) / 10 };
  }).filter(row => row.keyword && row.volume > 0 && Number.isFinite(row.growth));
  return result.sort((a, b) => b.growth - a.growth || b.volume - a.volume).slice(0, Math.min(100, Math.max(1, number(ctx.query.limit, 10))));
}
async function crossLinks(ctx, articles) {
  const links = await all(ctx.db, 'graphEdges');
  return links.length ? links : collaborationNetwork(articles, [], 500).links;
}
function temporalShift(articles) {
  const recentYear = Math.max(...articles.map(yearOf).filter(Boolean), 0); const midpoint = recentYear - 5;
  const old = keywordCounts(articles.filter(row => (yearOf(row) || 0) <= midpoint)); const recent = keywordCounts(articles.filter(row => (yearOf(row) || 0) > midpoint));
  const oldMap = new Map(old.map(row => [row.keyword, row.count])); const recentMap = new Map(recent.map(row => [row.keyword, row.count]));
  return [...new Set([...oldMap.keys(), ...recentMap.keys()])].map(keyword => ({ keyword, earlier: oldMap.get(keyword) || 0, recent: recentMap.get(keyword) || 0, change: (recentMap.get(keyword) || 0) - (oldMap.get(keyword) || 0) })).sort((a, b) => b.change - a.change).slice(0, 100);
}
const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
function collaborationReportCsv(projectId, rankings, metrics, network) {
  let csv = '\uFEFF--- KEY INSIGHTS ---\nMetric,Value\n';
  if (metrics?.metrics?.length) for (const metric of metrics.metrics) csv += `${csvCell(metric.label)},${csvCell(metric.value)}\n`;
  else csv += 'No insights data available,\n';
  csv += '\n--- TOP INFLUENTIAL AUTHORS ---\nRank,Name,Impact Score\n';
  if (rankings?.authors?.length) for (const author of rankings.authors) csv += `${author.rank},${csvCell(author.name)},${author.score}\n`;
  else csv += 'No top authors available,,\n';
  csv += '\n--- LEADING INSTITUTIONS ---\nRank,Name,Citations\n';
  if (rankings?.institutions?.length) for (const institution of rankings.institutions) csv += `${institution.rank},${csvCell(institution.name)},${institution.score}\n`;
  else csv += 'No leading institutions available,,\n';
  csv += '\n--- GLOBAL COLLABORATION NETWORK ---\nName,Type,Articles/Affiliations,Label\n';
  if (network?.nodes?.length) for (const node of network.nodes) csv += `${csvCell(node.id)},${node.type === 'AUTHOR' ? 'Author' : 'Institution'},${node.size || node.val || 0},${csvCell(node.label || node.id)}\n`;
  else csv += 'No network nodes available,,,\n';
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="collaboration_analytics_report_${projectId}.csv"` } });
}
function countryChordCsv(rows) {
  let csv = '\uFEFFSource Country,Target Country,Co-Authorship Count,Growth Rate\n';
  for (const row of rows || []) csv += `${csvCell(row.source)},${csvCell(row.target)},${row.coAuthorshipValue || 0},${csvCell(row.growth || '+0%')}\n`;
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="country_collaboration_matrix.csv"' } });
}
function csvResponse(rows, filename) { const list = Array.isArray(rows) ? rows : Object.entries(rows).map(([key, value]) => ({ key, value: JSON.stringify(value) })); const columns = [...new Set(list.flatMap(row => Object.keys(row)))]; const csv = [columns.join(','), ...list.map(row => columns.map(col => `"${String(row[col] ?? '').replaceAll('"', '""')}"`).join(','))].join('\r\n'); return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` } }); }

async function projectKeywords(ctx) {
  const projectId = String(ctx.query.project_id || ctx.body.project_id || ''); if (!projectId) throw new HttpError(400, 'project_id is required', 'VALIDATION_ERROR');
  await requireProject(ctx, projectId);
  if (ctx.request.method === 'GET') {
    const [links, keywords] = await Promise.all([
      find(ctx.db, 'project_keywords', row => String(row.project_id) === projectId, { limit: Infinity }), all(ctx.db, 'keywords'),
    ]);
    const keywordById = new Map(keywords.map(row => [String(row.keyword_id || row.id), row]));
    return ok(links.flatMap(link => {
      const keyword = keywordById.get(String(link.keyword_id || ''));
      return keyword ? [{ id: keyword.keyword_id || keyword.id, label: keyword.display_name || keyword.name || keyword.keyword }] : [];
    }), 'Fetch project keywords successfully');
  }
  if (ctx.request.method === 'POST') {
    const name = String(ctx.body.keyword || '').trim(); if (!name) throw new HttpError(400, 'keyword is required', 'VALIDATION_ERROR');
    const keywordRows = await all(ctx.db, 'keywords');
    let keyword = keywordRows.find(row => String(row.display_name || row.name || row.keyword || '').toLowerCase() === name.toLowerCase());
    if (!keyword) {
      const maxId = Math.max(0, ...keywordRows.map(row => Number(row.keyword_id || row.id)).filter(Number.isFinite));
      const keywordId = maxId + 1; const key = String(keywordId);
      keyword = { id: key, keyword_id: keywordId, display_name: name, created_at: nowIso() };
      await ctx.db.set('keywords', key, keyword);
    }
    const keywordId = String(keyword.keyword_id || keyword.id);
    const existing = await find(ctx.db, 'project_keywords', row => String(row.project_id) === projectId && String(row.keyword_id) === keywordId, { limit: 1 });
    if (!existing.length) {
      const linkId = `${projectId}_${keywordId}`;
      await ctx.db.set('project_keywords', linkId, { id: linkId, project_id: projectId, keyword_id: keyword.keyword_id || keyword.id, keyword: keyword.display_name || name, created_at: nowIso() });
    }
    return ok({ id: keyword.keyword_id || keyword.id, label: name }, 'Add project keyword successfully');
  }
  return { success: true, message: 'Remove project keyword successfully' };
}
async function trackedJournals(ctx) {
  const projectId = String(ctx.query.project_id || '');
  if (!projectId) throw new HttpError(400, 'project_id is required', 'VALIDATION_ERROR');
  await requireProject(ctx, projectId);
  const [works, metricRows] = await Promise.all([
    collaborationScopedArticles({ ...ctx, query: { ...ctx.query, project_id: projectId } }, { summary: true }),
    all(ctx.db, 'ranking_metrics'),
  ]);
  const normalizeIssn = value => String(value || '').replace(/[^0-9X]/gi, '').toUpperCase();
  const sources = await getOpenAlexSourcesByIds(ctx, works.map(work => work.journal_openalex_id || work.journal_source_id || work.journal_id));
  const sourceById = new Map(sources.map(row => [String(row.id || '').split('/').pop(), row]));
  const journalCounts = new Map();
  for (const work of works) {
    const sourceId = String(work.journal_openalex_id || work.journal_source_id || work.journal_id || '');
    if (!sourceId) continue;
    const source = sourceById.get(sourceId.split('/').pop()) || {};
    const issn = normalizeIssn(work.journal_issn || source.issn_l || source.issn?.[0]);
    const key = issn || sourceId;
    const journal = journalCounts.get(key) || {
      id: sourceId, name: work.journal_name || source.display_name || source.title || sourceId,
      publisher: work.publisher_name || source.host_organization_name || 'Unknown Publisher',
      issn: issn || null, articleCount: 0, citationCount: 0,
    };
    journal.articleCount += 1;
    journal.citationCount += number(work.citation_count);
    journalCounts.set(key, journal);
  }

  const rankingJournalIds = [...journalCounts.values()].map(journal => journal.issn ? `scimago_${journal.issn}` : journal.id);
  const rankings = await journalRankingsForJournals(ctx.db, rankingJournalIds);
  const metricById = new Map(metricRows.map(row => [String(row.metric_id || row.id), row]));
  const metricCode = row => String(metricById.get(String(row.metric_id || ''))?.code || metricById.get(String(row.metric_id || ''))?.name || '').toUpperCase();
  const rankingsByIssn = new Map();
  for (const row of rankings) {
    const match = String(row.journal_id || '').match(/^scimago_(.+)$/i);
    const issn = normalizeIssn(match?.[1]);
    if (!issn) continue;
    const entry = rankingsByIssn.get(issn) || { sjr: null, sjrYear: -Infinity, quartile: null, quartileYear: -Infinity, trend: [] };
    const code = metricCode(row);
    const year = number(row.year, 0);
    if (code === 'SJR' && row.value_float != null) {
      const value = number(row.value_float, null);
      if (value !== null) entry.trend.push({ year, value });
      if (value !== null && year >= entry.sjrYear) { entry.sjr = value; entry.sjrYear = year; }
    }
    if ((code.includes('QUARTILE') || String(metricById.get(String(row.metric_id || ''))?.metric_type || '').toUpperCase() === 'QUARTILE')
      && /^Q[1-4]$/i.test(String(row.value_txt || row.value || '')) && year >= entry.quartileYear) {
      entry.quartile = String(row.value_txt || row.value).toUpperCase(); entry.quartileYear = year;
    }
    rankingsByIssn.set(issn, entry);
  }
  const rows = [...journalCounts.values()].map(journal => {
    const ranking = rankingsByIssn.get(normalizeIssn(journal.issn)) || {};
    return { ...journal, impactFactor: ranking.sjr ?? null, sjrRank: ranking.quartile ?? null,
      trend: (ranking.trend || []).sort((a, b) => a.year - b.year).map(row => row.value) };
  }).sort((a, b) => (b.impactFactor ?? -1) - (a.impactFactor ?? -1) || b.articleCount - a.articleCount || a.name.localeCompare(b.name));

  const page = Math.max(1, number(ctx.query.page, 1));
  const limit = Math.min(100, Math.max(1, number(ctx.query.limit, 10)));
  const ranked = rows.filter(row => row.impactFactor != null);
  const currentAverage = ranked.length ? ranked.reduce((sum, row) => sum + row.impactFactor, 0) / ranked.length : null;
  const previousRows = rows.map(row => rankingsByIssn.get(normalizeIssn(row.issn))?.trend || [])
    .map(trend => trend.slice().sort((a, b) => b.year - a.year)[1]?.value).filter(value => value != null);
  const previousAverage = previousRows.length ? previousRows.reduce((sum, value) => sum + value, 0) / previousRows.length : null;
  const percentageChange = currentAverage == null || previousAverage == null || previousAverage === 0
    ? null : `${((currentAverage - previousAverage) / previousAverage >= 0 ? '+' : '')}${((currentAverage - previousAverage) / previousAverage * 100).toFixed(1)}%`;
  return ok({
    journals: rows.slice((page - 1) * limit, page * limit),
    pagination: { totalCount: rows.length, page, limit, totalPages: Math.ceil(rows.length / limit) },
    summary: { averageImpactFactor: currentAverage == null ? null : Math.round(currentAverage * 100) / 100,
      percentageChange, trackedCount: rows.length, limit: 150 },
  }, 'Fetch tracked journals successfully');
}

const analyticsPaths = ['trends','journals/impact-matrix','frontier','distribution','forecast','top-entities','geo-distribution','journals/quartiles','journals/ranking','network/collaboration','network/collaboration-dashboard','rankings','matrix/productivity','network/chord','journals/migration','network/topology','keywords/vectors','matrix/intensity','development-trends','subject-categories','subject-areas','zones','network/collab-insights','network/collab-metrics','network/collab-report/export','network/chord/export','network/cross-links','network/temporal-shift','curated-articles','project-keywords','tracked-journals'];
export const researchRoutes = defineRoutes([
  ...analyticsPaths.map(path => ({ method: 'GET', path: `/analytics/${path}`, auth: true, handler: analytics })),
  { method: 'POST', path: '/analytics/project-keywords', auth: true, handler: analytics },
  { method: 'DELETE', path: '/analytics/project-keywords/:keyword_id', auth: true, handler: async ctx => { const projectId = String(ctx.query.project_id || ''); await requireProject(ctx, projectId); const rows = await find(ctx.db, 'project_keywords', row => String(row.project_id) === projectId && String(row.keyword_id) === String(ctx.params.keyword_id), { limit: 1 }); if (rows[0]) await ctx.db.delete('project_keywords', rows[0].id); return ok(undefined, 'Project keyword removed successfully'); } },
  { method: 'GET', path: '/analytics/jobs/:id', auth: true, handler: async ctx => {
    const job = await byId(ctx.db, 'analyticsJobs', ctx.params.id);
    if (!job) throw new HttpError(404, 'Job not found', 'NOT_FOUND');
    return { success: true, data: Object.fromEntries(['job_id','job_type','status','progress','result','error','created_at','started_at','completed_at'].filter(key => job[key] !== undefined).map(key => [key, job[key]])) };
  } },
  { method: 'GET', path: '/articles/search', auth: true, handler: articlesGraphSearch },
  { method: 'GET', path: '/search', auth: true, handler: searchEntities },
  { method: 'GET', path: '/dashboard/stats', auth: true, handler: dashboardStats },
  { method: 'GET', path: '/dashboard/search', auth: true, handler: dashboardSearch },
  { method: 'GET', path: '/dashboard/trending-keywords', auth: true, handler: dashboardTrendingKeywords },
]);

async function dashboardTrendingKeywords(ctx) {
  const userId = String(ctx.user.user_id || ctx.user.id);
  const metric = ctx.query.metric || 'articleCount';
  if (!['articleCount', 'citationCount', 'avgScore'].includes(metric)) throw new HttpError(400, 'metric is invalid', 'BAD_REQUEST');
  const limit = ctx.query.limit === undefined ? 10 : Number(ctx.query.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, 'limit must be a positive integer', 'BAD_REQUEST');
  const parseYear = key => {
    if (ctx.query[key] === undefined) return undefined;
    if (!/^-?\d+$/.test(String(ctx.query[key]))) throw new HttpError(400, key + ' must be an integer', 'BAD_REQUEST');
    return Number(ctx.query[key]);
  };
  const fromYear = parseYear('fromYear');
  const toYear = parseYear('toYear');
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) throw new HttpError(400, 'Invalid year range', 'BAD_REQUEST');
  const allProjects = (await all(ctx.db, 'projects')).filter(row => !isDeleted(row) && String(row.user_id || row.owner_id || row.created_by) === userId);
  const requestedProjectId = ctx.query.projectId || ctx.query.project_id;
  const projects = requestedProjectId ? allProjects.filter(row => String(row.project_id || row.id) === String(requestedProjectId)) : allProjects;
  if (requestedProjectId && !projects.length) throw new HttpError(403, 'Project does not exist or is not owned by this user', 'FORBIDDEN');
  const scopes = await loadProjectResearchScopes(ctx.db, projects);
  const data = await openAlexTrendingKeywords(ctx, scopes, { fromYear, toYear, limit, metric });
  return ok(data, 'Trending keyword chart data retrieved successfully');
}
