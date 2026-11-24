import { projectRows } from '../firestore/project-cache.js';
import { openAlexRequest } from './client.js';

const suffix = value => String(value ?? '').trim().replace(/^https?:\/\/(?:www\.)?openalex\.org\//i, '').replace(/\/+$/, '').split('/').pop();
const normalizeId = (value, prefix = '') => {
  const id = suffix(value);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return prefix && /^\d+$/.test(id) ? prefix + id : id.toUpperCase();
};
const keywordScope = value => {
  const raw = String(value ?? '').trim();
  const id = suffix(raw);
  if (/^K\d+$/i.test(id)) return { id: id.toUpperCase() };
  if (/^\d+$/.test(id)) return { id: `K${id}` };
  if (/^TEXT_/i.test(id)) {
    let term = id.slice(5).replace(/^_+|_+$/g, '').replace(/_+/g, ' ').trim();
    try { term = decodeURIComponent(term); } catch { /* Keep malformed legacy text searchable. */ }
    return term ? { term } : null;
  }
  return raw ? { term: raw } : null;
};
const unique = values => [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))];
const normalizeList = (values, prefix) => unique((Array.isArray(values) ? values : []).map(value => normalizeId(value?.id ?? value?.openalex_id ?? value, prefix)).filter(Boolean));
const orFilter = (field, ids) => ids.length ? field + ':' + ids.join('|') : null;
const yearFilter = (fromYear, toYear) => {
  if (fromYear == null && toYear == null) return null;
  if (fromYear != null && toYear != null) return 'publication_year:' + fromYear + '-' + toYear;
  return fromYear != null ? 'publication_year:>' + (fromYear - 1) : 'publication_year:<' + (toYear + 1);
};

export async function loadProjectResearchScopes(db, projects) {
  return Promise.all(projects.map(async project => {
    const id = String(project.project_id || project.id);
    const [journalLinks, keywordLinks, categoryLinks] = await Promise.all([
      projectRows(db, 'project_journals', id),
      projectRows(db, 'project_keywords', id),
      projectRows(db, 'subject_category_projects', id),
    ]);
    const areaIds = normalizeList([project.subject_area, project.subject_area_id].filter(Boolean), 'domains/');
    const categoryIds = unique([
      ...(project.subject_category_ids || []).map(value => normalizeId(value?.id ?? value, 'fields/')).filter(Boolean),
      ...categoryLinks.filter(link => String(link.project_id) === id).map(link => normalizeId(link.subject_category_id, 'fields/')).filter(Boolean),
    ]);
    const keywordValues = unique([
      ...(project.keyword_ids || []).map(value => value?.id ?? value?.keyword_id ?? value?.name ?? value),
      ...keywordLinks.filter(link => String(link.project_id) === id).flatMap(link => [link.keyword_id, link.keyword]),
    ]);
    const keywordScopes = keywordValues.map(keywordScope).filter(Boolean);
    const keywordIds = unique(keywordScopes.filter(value => value.id).map(value => value.id));
    const keywordTerms = unique(keywordScopes.filter(value => value.term).map(value => value.term));
    const journalIds = unique([
      ...(project.journal_ids || []).map(value => normalizeId(value?.id ?? value, 'S')).filter(Boolean),
      ...journalLinks.filter(link => String(link.project_id) === id).map(link => normalizeId(link.journal_id, 'S')).filter(Boolean),
    ]);
    const domainIds = areaIds.map(value => normalizeId(value, 'domains/')).filter(Boolean);
    const filters = [orFilter('keywords.id', keywordIds), orFilter('primary_location.source.id', journalIds), orFilter('primary_topic.domain.id', domainIds), domainIds.length ? null : orFilter('primary_topic.field.id', categoryIds)].filter(Boolean);
    return { project, id, keywordIds, keywordTerms, journalIds, domainIds, categoryIds, filters };
  }));
}

async function groupedWorks(ctx, filter, groupBy) {
  if (!filter) return { meta: { count: 0 }, group_by: [] };
  return openAlexRequest(ctx, 'works', { filter, group_by: groupBy, per_page: 200 });
}

export async function enrichProjectsWithOpenAlex(ctx, scopes) {
  return Promise.all(scopes.map(async scope => {
    const [counts, areaSources, keywordCounts] = await Promise.all([
      Promise.all(scope.filters.map(filter => groupedWorks(ctx, filter, 'publication_year'))),
      Promise.all([
        ...scope.domainIds.map(id => groupedWorks(ctx, 'primary_topic.domain.id:' + id, 'primary_location.source.id')),
        ...(scope.domainIds.length ? [] : scope.categoryIds.map(id => groupedWorks(ctx, 'primary_topic.field.id:' + id, 'primary_location.source.id'))),
      ]),
      Promise.all(scope.keywordTerms.map(search => openAlexRequest(ctx, 'works', { search, group_by: 'publication_year', per_page: 200 }))),
    ]);
    const articleCount = [...counts, ...keywordCounts].reduce((sum, result) => sum + Number(result.meta?.count || 0), 0);
    const areaJournalIds = new Set(areaSources.flatMap(result => (result.group_by || []).map(group => suffix(group.key)).filter(Boolean)));
    return { ...scope.project, keyword_count: scope.keywordIds.length + scope.keywordTerms.length, journal_count: new Set([...scope.journalIds, ...areaJournalIds]).size, article_count: articleCount };
  }));
}

export async function openAlexPublicationTrends(ctx, scopes, { fromYear, toYear } = {}) {
  const yearRange = yearFilter(fromYear, toYear);
  const yearlyCounts = new Map();
  for (const scope of scopes) {
    const results = await Promise.all([
      ...scope.filters.map(filter => groupedWorks(ctx, [filter, yearRange].filter(Boolean).join(','), 'publication_year')),
      ...scope.keywordTerms.map(search => openAlexRequest(ctx, 'works', { search, ...(yearRange ? { filter: yearRange } : {}), group_by: 'publication_year', per_page: 200 })),
    ]);
    for (const result of results) for (const group of result.group_by || []) {
      const year = Number(group.key);
      if (!Number.isInteger(year)) continue;
      yearlyCounts.set(year, (yearlyCounts.get(year) || 0) + Number(group.count || 0));
    }
  }
  return [...yearlyCounts].map(([year, totalPublications]) => ({ year, totalPublications })).sort((a, b) => a.year - b.year);
}

export async function openAlexTrendingKeywords(ctx, scopes, { fromYear, toYear, limit = 10, metric = 'articleCount' } = {}) {
  const yearRange = yearFilter(fromYear, toYear);
  const keywordCounts = new Map();
  for (const scope of scopes) for (const filter of scope.filters) {
    const result = await groupedWorks(ctx, [filter, yearRange].filter(Boolean).join(','), 'keywords.id');
    for (const group of result.group_by || []) {
      const key = suffix(group.key);
      if (!key || key === 'unknown') continue;
      const item = keywordCounts.get(key) || { keyword: group.key_display_name || key, articleCount: 0 };
      item.articleCount += Number(group.count || 0);
      keywordCounts.set(key, item);
    }
  }
  for (const scope of scopes) for (const search of scope.keywordTerms) {
    const result = await openAlexRequest(ctx, 'works', { search, ...(yearRange ? { filter: yearRange } : {}), group_by: 'keywords.id', per_page: 200 });
    for (const group of result.group_by || []) {
      const key = suffix(group.key);
      if (!key || key === 'unknown') continue;
      const item = keywordCounts.get(key) || { keyword: group.key_display_name || key, articleCount: 0 };
      item.articleCount += Number(group.count || 0);
      keywordCounts.set(key, item);
    }
  }
  const rows = [...keywordCounts.values()].sort((a, b) => b.articleCount - a.articleCount || a.keyword.localeCompare(b.keyword)).slice(0, limit);
  const datasetLabel = metric === 'citationCount' ? 'Total Citations' : metric === 'avgScore' ? 'Average Score' : 'Number of Articles';
  return { type: 'horizontal-bar', metric, labels: rows.map(row => row.keyword), datasets: [{ label: datasetLabel, data: rows.map(row => row.articleCount) }] };
}
