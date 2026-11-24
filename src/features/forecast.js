import { HttpError } from '../core/http.js';
import { all, byId, hydrateArticles, isDeleted } from '../firestore/repository.js';
import { projectRows } from '../firestore/project-cache.js';

const round = (value, digits = 1) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : 0;
const divide = (numerator, denominator) => denominator ? numerator / denominator : 0;
const change = (current, previous) => !Number.isFinite(current) || !Number.isFinite(previous)
  ? 0
  : previous === 0 ? (current > 0 ? 100 : 0) : round((current - previous) / previous * 100);
const articleId = row => String(row.article_id || row.id);
const rowYear = row => Number(row.publication_year || row.year) || null;

function fillYears(rows) {
  if (!rows.length) return [];
  const years = new Map();
  for (const row of rows) {
    const year = Number(row.year);
    if (!Number.isFinite(year)) continue;
    const item = years.get(year) || { year, article_count: 0, citation_count: 0 };
    item.article_count += row.article_count;
    item.citation_count += row.citation_count;
    years.set(year, item);
  }
  if (!years.size) return [];
  const min = Math.min(...years.keys()); const max = Math.max(...years.keys());
  return Array.from({ length: Math.min(max - min + 1, 500) }, (_, index) => years.get(min + index) || { year: min + index, article_count: 0, citation_count: 0 });
}

function peak(scope, metrics) {
  const subject = scope.subjectAreaName || 'the relevant research area';
  if (!metrics.length) return {
    type: 'PEAK', title_key: 'forecast.peak.title', insight_key: 'forecast.peak.insufficient_data',
    parameters: { subject, signal: 'insufficient_data', latestYear: null, articleCount: 0, citationCount: 0, growthRate: 0, averageGrowthRate: 0, citationGrowthRate: 0 },
  };
  const latest = metrics.at(-1); const previous = metrics.at(-2);
  const growthRates = metrics.slice(1).map((item, index) => change(item.article_count, metrics[index].article_count));
  const growthRate = previous ? change(latest.article_count, previous.article_count) : 0;
  const citationGrowthRate = previous ? change(latest.citation_count, previous.citation_count) : 0;
  const recent = growthRates.slice(-3);
  const averageGrowthRate = recent.length ? round(recent.reduce((sum, value) => sum + value, 0) / recent.length) : 0;
  const signal = latest.article_count > 0 && (growthRate >= 25 || averageGrowthRate >= 20 || citationGrowthRate >= 30);
  return {
    type: 'PEAK', title_key: 'forecast.peak.title', insight_key: signal ? 'forecast.peak.insight' : 'forecast.peak.no_strong_signal',
    parameters: { subject, signal: signal ? 'emerging_peak' : 'no_strong_peak_signal', latestYear: latest.year, articleCount: latest.article_count, citationCount: latest.citation_count, growthRate, averageGrowthRate, citationGrowthRate },
  };
}

function alert(scope, metrics) {
  const subject = scope.subjectAreaName || 'the relevant research area';
  if (!metrics.length) return {
    type: 'ALERT', title_key: 'forecast.alert.title', insight_key: 'forecast.alert.insufficient_data',
    parameters: { subject, signal: 'insufficient_data', latestYear: null, articleCount: 0, citationPerArticle: 0, citationPerArticleChange: 0, latestGrowthRate: 0, previousGrowthRate: 0, growthSlowdown: 0 },
  };
  const latest = metrics.at(-1); const previous = metrics.at(-2); const beforePrevious = metrics.at(-3);
  const latestGrowthRate = previous ? change(latest.article_count, previous.article_count) : 0;
  const previousGrowthRate = previous && beforePrevious ? change(previous.article_count, beforePrevious.article_count) : 0;
  const growthSlowdown = round(latestGrowthRate - previousGrowthRate);
  const citationPerArticle = round(divide(latest.citation_count, latest.article_count), 2);
  const previousCitationPerArticle = previous ? round(divide(previous.citation_count, previous.article_count), 2) : 0;
  const citationPerArticleChange = previous ? change(citationPerArticle, previousCitationPerArticle) : 0;
  const signal = latest.article_count > 0 && (citationPerArticleChange <= -15 || growthSlowdown <= -20 || (previousGrowthRate >= 20 && latestGrowthRate <= 5));
  return {
    type: 'ALERT', title_key: 'forecast.alert.title', insight_key: signal ? 'forecast.alert.insight' : 'forecast.alert.no_saturation_signal',
    parameters: { subject, signal: signal ? 'saturation_risk' : 'no_saturation_signal', latestYear: latest.year, articleCount: latest.article_count, citationPerArticle, citationPerArticleChange, latestGrowthRate, previousGrowthRate, growthSlowdown },
  };
}

function synergy(scope, keywordMetrics, crossDomainMetrics) {
  const subject = scope.subjectAreaName || 'the relevant research area';
  const topCross = crossDomainMetrics[0];
  const totals = new Map();
  for (const row of keywordMetrics) {
    const current = totals.get(row.keywordId) || { keyword_name: row.keywordName, article_count: 0, citation_count: 0 };
    current.article_count += row.article_count;
    current.citation_count += row.citation_count;
    totals.set(row.keywordId, current);
  }
  const topKeyword = [...totals.values()].sort((a, b) => b.article_count - a.article_count || b.citation_count - a.citation_count)[0];
  if (topCross) return {
    type: 'SYNERGY', title_key: 'forecast.synergy.title', insight_key: 'forecast.synergy.insight',
    parameters: { subject, keyword: topCross.keyword_name, relatedSubject: topCross.related_subject_area, signal: 'cross_domain_synergy', articleCount: topCross.article_count, citationCount: topCross.citation_count },
  };
  return {
    type: 'SYNERGY', title_key: 'forecast.synergy.title', insight_key: topKeyword ? 'forecast.synergy.keyword_only' : 'forecast.synergy.insufficient_data',
    parameters: { subject, keyword: topKeyword?.keyword_name || scope.keywordNames[0] || 'related topics', relatedSubject: null, signal: topKeyword ? 'keyword_activity_detected' : 'insufficient_data', articleCount: topKeyword?.article_count || 0, citationCount: topKeyword?.citation_count || 0 },
  };
}

export async function forecastInsights(db, projectId) {
  if (!projectId) throw new HttpError(400, 'project_id is required', 'VALIDATION_ERROR');
  const [project, areas, categories, topics, keywords, projectKeywords, articleDocs] = await Promise.all([
    byId(db, 'projects', projectId), all(db, 'subjectAreas'), all(db, 'subjectCategories'), all(db, 'topics'), all(db, 'keywords'),
    projectRows(db, 'project_keywords', projectId), all(db, 'articles'),
  ]);
  const articles = await hydrateArticles(db, articleDocs);
  if (!project) throw new HttpError(404, 'Project not found or has no associated subject area', 'NOT_FOUND');
  const areaId = String(project.subject_area_id || project.subject_area || project.subjectAreaId || '');
  const area = areas.find(row => !isDeleted(row) && (String(row.subject_area_id || row.id) === areaId || String(row.display_name || row.name).toLowerCase() === areaId.toLowerCase()));
  if (!area) throw new HttpError(404, 'Project not found or has no associated subject area', 'NOT_FOUND');
  const subjectAreaId = String(area.subject_area_id || area.id);
  const subjectAreaName = area.display_name || area.name;
  const categoryIds = new Set(categories.filter(row => String(row.subject_area_id) === subjectAreaId && !isDeleted(row)).map(row => String(row.subject_category_id || row.id)));
  const keywordIds = new Set(projectKeywords.map(row => String(row.keyword_id)).filter(Boolean));
  const keywordById = new Map(keywords.map(row => [String(row.keyword_id || row.id), row]));
  const keywordNames = [...keywordIds].map(id => keywordById.get(id)?.display_name || keywordById.get(id)?.name).filter(Boolean);
  const topicById = new Map(topics.map(row => [String(row.topic_id || row.id), row]));
  const activeTopicById = new Map(topics.filter(row => !isDeleted(row)).map(row => [String(row.topic_id || row.id), row]));
  const inCategory = article => {
    return [...new Set([article.primary_topic, article.topic_id, ...(article.topic_ids || [])].filter(Boolean).map(String))]
      .some(id => categoryIds.has(String(topicById.get(id)?.subject_category_id)));
  };
  const articleKeywords = article => (article.keyword_ids || []).map(String);
  const inKeywordScope = article => articleKeywords(article).some(id => keywordIds.has(id));
  const activeArticles = articles.filter(article => !isDeleted(article));
  const categoryScoped = activeArticles.filter(inCategory);
  const keywordScoped = activeArticles.filter(inKeywordScope);
  const scopedIds = new Set([...categoryScoped, ...keywordScoped].map(articleId));
  const scoped = activeArticles.filter(article => scopedIds.has(articleId(article)));
  const yearly = new Map();
  for (const article of scoped) {
    const year = rowYear(article); if (!year) continue;
    const row = yearly.get(year) || { year, article_count: 0, citation_count: 0 };
    row.article_count += 1; row.citation_count += Number(article.citation_count || 0); yearly.set(year, row);
  }
  const yearlyMetrics = fillYears([...yearly.values()].sort((a, b) => a.year - b.year));

  const keywordYearly = new Map();
  const keywordMetricArticles = categoryIds.size ? categoryScoped : keywordScoped;
  for (const article of keywordMetricArticles) {
    const year = rowYear(article); if (!year) continue;
    for (const id of articleKeywords(article).filter(id => keywordIds.has(id))) {
      const keyword = keywordById.get(id); const key = `${id}:${year}`;
      const row = keywordYearly.get(key) || { keywordId: id, keywordName: keyword?.display_name || keyword?.name || id, article_count: 0, citation_count: 0 };
      row.article_count += 1; row.citation_count += Number(article.citation_count || 0); keywordYearly.set(key, row);
    }
  }

  const categoryById = new Map(categories.filter(row => !isDeleted(row)).map(row => [String(row.subject_category_id || row.id), row]));
  const cross = new Map();
  for (const article of articles.filter(row => !isDeleted(row) && inKeywordScope(row))) {
    const ids = [...new Set([article.primary_topic, article.topic_id, ...(article.topic_ids || [])].filter(Boolean).map(String))];
    const relatedAreas = new Map();
    for (const id of ids) {
      const topic = activeTopicById.get(id); const category = categoryById.get(String(topic?.subject_category_id));
      const relatedAreaId = String(category?.subject_area_id || '');
      const relatedArea = areas.find(row => !isDeleted(row) && String(row.subject_area_id || row.id) === relatedAreaId);
      if (relatedArea && relatedAreaId !== subjectAreaId) relatedAreas.set(relatedAreaId, relatedArea.display_name || relatedArea.name);
    }
    for (const [relatedAreaId, relatedAreaName] of relatedAreas) for (const id of articleKeywords(article).filter(id => keywordIds.has(id))) {
      const key = `${relatedAreaId}:${id}`;
      const row = cross.get(key) || { related_subject_area: relatedAreaName, keyword_name: keywordById.get(id)?.display_name || keywordById.get(id)?.name || id, article_count: 0, citation_count: 0 };
      row.article_count += 1; row.citation_count += Number(article.citation_count || 0); cross.set(key, row);
    }
  }
  const crossDomainMetrics = [...cross.values()].sort((a, b) => b.article_count - a.article_count || b.citation_count - a.citation_count).slice(0, 1);
  const scope = { subjectAreaName, keywordNames };
  return [peak(scope, yearlyMetrics), alert(scope, yearlyMetrics), synergy(scope, [...keywordYearly.values()], crossDomainMetrics)];
}
