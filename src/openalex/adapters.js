import { HttpError } from '../core/http.js';
import { openAlexRequest } from './client.js';

const entityConfig = {
  articles: { endpoint: 'works', select: 'id,doi,display_name,publication_year,publication_date,type,authorships,primary_location,locations,referenced_works,referenced_works_count,cited_by_count,primary_topic,topics,keywords,open_access,biblio,created_date,updated_date,ids,abstract_inverted_index,language' },
  // h_index/i10_index are not valid fields in OpenAlex search select clauses.
  // Keep these lists limited to fields accepted by the search endpoint.
  authors: { endpoint: 'authors', select: 'id,orcid,display_name,works_count,cited_by_count,last_known_institutions,updated_date,created_date,ids,summary_stats,counts_by_year,topics,affiliations,topic_share' },
  institutions: { endpoint: 'institutions', select: 'id,display_name,country_code,type,works_count,cited_by_count,ror,homepage_url,updated_date,created_date' },
  journals: { endpoint: 'sources', select: 'id,display_name,issn_l,issn,type,is_oa,is_in_doaj,country_code,host_organization,host_organization_name,summary_stats,works_count,cited_by_count,counts_by_year,updated_date,created_date,ids,first_publication_year,last_publication_year,topic_share,topics' },
  publishers: { endpoint: 'publishers', select: 'id,display_name,alternate_titles,country_codes,hierarchy_level,works_count,updated_date,created_date,ids' },
  keywords: { endpoint: 'keywords', select: 'id,display_name,works_count,cited_by_count,updated_date,created_date' },
  topics: { endpoint: 'topics', select: 'id,display_name,description,keywords,works_count,cited_by_count,subfield,field,domain,updated_date,created_date' },
  subjectAreas: { endpoint: 'domains', select: 'id,display_name,description,fields,works_count,updated_date' },
  subjectCategories: { endpoint: 'fields', select: 'id,display_name,description,domain,subfields,works_count,updated_date' },
};

const suffix = value => String(value || '').replace(/\/+$/, '').split('/').pop() || null;
const numericSuffix = value => {
  const match = suffix(value)?.match(/^[A-Z]+(\d+)$/i);
  return match ? Number(match[1]) : Number.isFinite(Number(suffix(value))) ? Number(suffix(value)) : null;
};
const openAlexId = value => {
  const id = suffix(value);
  return id ? (id.match(/^[A-Z]/i) ? id.toUpperCase() : id) : null;
};
const toOpenAlexId = (kind, value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (kind === 'keywords') {
    if (/^https?:\/\//i.test(raw)) {
      try { return decodeURIComponent(new URL(raw).pathname.split('/').filter(Boolean).pop() || '').toLowerCase(); }
      catch { return raw; }
    }
    if (/^K\d+$/i.test(raw)) return raw.toUpperCase();
    if (/^\d+$/.test(raw)) return `K${raw}`;
    return raw.toLowerCase();
  }
  if (/^https?:\/\//i.test(raw) || /^[A-Z]+\d+$/i.test(raw)) return raw;
  const prefix = ({ articles: 'W', authors: 'A', journals: 'S', publishers: 'P', keywords: 'K', topics: 'T', subjectAreas: 'domains/', subjectCategories: 'fields/' })[kind];
  return prefix ? `${prefix}${raw}` : raw;
};

function abstractFromIndex(index) {
  if (!index || typeof index !== 'object') return null;
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) if (Number.isInteger(position) && position >= 0 && position < 100000) words[position] = word;
  }
  return words.length ? words.map(word => word || '').join(' ').trim() : null;
}

export function openAlexWorkToLegacy(work) {
  const primary = work.primary_location?.source || work.locations?.find(location => location.is_primary)?.source || null;
  const host = primary?.host_organization || null;
  const authorships = Array.isArray(work.authorships) ? work.authorships : [];
  const authors = authorships.map(item => item.author ? {
    author_id: numericSuffix(item.author.id), openalex_id: item.author.id,
    display_name: item.author.display_name || null, orcid: item.author.orcid || null,
    institutions: (item.institutions || []).map(institution => ({
      institution_id: numericSuffix(institution.id), openalex_id: institution.id,
      display_name: institution.display_name || null, country_code: institution.country_code || null,
      type: institution.type || null, ror: institution.ror || null,
    })),
  } : null).filter(Boolean);
  const topics = Array.isArray(work.topics) ? work.topics : [];
  const keywords = Array.isArray(work.keywords) ? work.keywords : [];
  const topic = work.primary_topic || null;
  const articleId = numericSuffix(work.id);
  return {
    article_id: articleId ?? openAlexId(work.id), openalex_id: openAlexId(work.id), openalex_url: work.id || null,
    title: work.display_name || null, abstract: abstractFromIndex(work.abstract_inverted_index),
    publication_year: work.publication_year ?? null, publication_date: work.publication_date || null,
    type: work.type || null, doi: work.doi || null, citation_count: work.cited_by_count ?? 0,
    cited_by_count: work.cited_by_count ?? 0, reference_count: work.referenced_works_count ?? (work.referenced_works || []).length,
    references: work.referenced_works || [], semantic_external_ids: work.ids || {}, language: work.language || null,
    primary_topic: numericSuffix(topic?.id), topic_id: numericSuffix(topic?.id), topic_name: topic?.display_name || null,
    primary_topic_domain: topic?.domain?.display_name || null,
    primary_topic_field: topic?.field?.display_name || null,
    primary_topic_subfield: topic?.subfield?.display_name || null,
    topic_ids: topics.map(item => numericSuffix(item.id)).filter(value => value !== null),
    topics: topics.map(item => ({
      topic_id: numericSuffix(item.id), openalex_id: openAlexId(item.id), display_name: item.display_name,
      domain: item.domain?.display_name || null, field: item.field?.display_name || null,
      subfield: item.subfield?.display_name || null, score: item.score ?? null,
    })),
    keywords: keywords.map(item => item.display_name).filter(Boolean),
    keyword_names: keywords.map(item => item.display_name).filter(Boolean).join(', '),
    keyword_objects: keywords.map(item => ({ keyword_id: numericSuffix(item.id), openalex_id: openAlexId(item.id), display_name: item.display_name, score: item.score ?? null })),
    authors, author_ids: authors.map(item => item.author_id).filter(value => value !== null),
    author_names: authors.map(item => item.display_name).filter(Boolean),
    author_name: authors.map(item => item.display_name).filter(Boolean).join(', '),
    institution_ids: [...new Set(authorships.flatMap(item => (item.institutions || []).map(institution => numericSuffix(institution.id)).filter(value => value !== null)))],
    journal_id: numericSuffix(primary?.id), journal_openalex_id: openAlexId(primary?.id),
    journal_name: primary?.display_name || null, journal_issn: primary?.issn_l || primary?.issn?.[0] || null,
    journal_country: primary?.country_code || null, country_code: primary?.country_code || null,
    publisher_id: numericSuffix(host), publisher_openalex_id: openAlexId(host),
    publisher_name: primary?.host_organization_name || null,
    is_open_access: work.open_access?.is_oa === true, open_access: work.open_access || null,
    issue_number: work.biblio?.issue || null, volume_number: work.biblio?.volume || null,
    created_at: work.created_date || null, updated_date: work.updated_date || null,
    is_deleted: false,
  };
}

export async function getOpenAlexWorksByIds(ctx, values) {
  const ids = [...new Set((values || []).map(value => String(value || '').trim().replace(/^https?:\/\/openalex\.org\//i, '').replace(/\/+$/, '').split('/').pop().toUpperCase()).filter(value => /^W\d+$/.test(value)))];
  const works = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const result = await openAlexRequest(ctx, 'works', {
      filter: `ids.openalex:${batch.join('|')}`,
      per_page: batch.length,
      select: entityConfig.articles.select,
    });
    works.push(...(result.results || []));
  }
  return works;
}

export async function getOpenAlexSourcesByIds(ctx, values) {
  const ids = [...new Set((values || []).map(value => String(value || '').trim().replace(/^https?:\/\/openalex\.org\//i, '').replace(/\/+$/, '').split('/').pop().toUpperCase()).filter(value => /^S\d+$/.test(value)))];
  const sources = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const result = await openAlexRequest(ctx, 'sources', { filter: `ids.openalex:${batch.join('|')}`, per_page: batch.length, select: entityConfig.journals.select });
    sources.push(...(result.results || []));
  }
  return sources;
}

export async function getOpenAlexAuthorsByIds(ctx, values) {
  const ids = [...new Set((values || []).map(value => String(value || '').trim().replace(/^https?:\/\/openalex\.org\//i, '').replace(/\/+$/, '').split('/').pop().toUpperCase()).filter(value => /^A\d+$/.test(value)))];
  const authors = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const result = await openAlexRequest(ctx, 'authors', {
      filter: `ids.openalex:${batch.join('|')}`,
      per_page: batch.length,
      select: 'id,display_name,summary_stats,works_count,cited_by_count',
    });
    authors.push(...(result.results || []));
  }
  return authors;
}

function toLegacyEntity(kind, item) {
  const id = numericSuffix(item.id) ?? openAlexId(item.id);
  const common = { openalex_id: openAlexId(item.id), openalex_url: item.id || null, updated_date: item.updated_date || null, is_deleted: false };
  if (kind === 'articles') return openAlexWorkToLegacy(item);
  if (kind === 'authors') {
    const institution = item.last_known_institutions?.[0] || null;
    const hIndex = item.summary_stats?.h_index ?? item.h_index ?? 0;
    const i10Index = item.summary_stats?.i10_index ?? item.i10_index ?? 0;
    const meanCitedness = item.summary_stats?.['2yr_mean_citedness'] ?? 0;

    // Build affiliations list from OpenAlex data
    const affiliationsList = (item.affiliations || []).map((aff, idx) => ({
      id: numericSuffix(aff.institution?.id) || idx,
      institution: aff.institution?.display_name || 'Unknown',
      institution_id: numericSuffix(aff.institution?.id),
      country_code: aff.institution?.country_code || null,
      type: aff.institution?.type || null,
      ror: aff.institution?.ror || null,
      years: aff.years || [],
    }));

    // Build topics/interests from OpenAlex topics
    const topicsList = (item.topics || []).map(t => ({
      id: numericSuffix(t.id),
      display_name: t.display_name || null,
      count: t.count ?? 0,
      subfield: t.subfield?.display_name || null,
      field: t.field?.display_name || null,
      domain: t.domain?.display_name || null,
    }));

    // Derive subject areas from topics (unique domains)
    const domainMap = {};
    (item.topics || []).forEach(t => {
      const domain = t.domain?.display_name;
      if (domain) {
        if (!domainMap[domain]) domainMap[domain] = { name: domain, count: 0 };
        domainMap[domain].count += (t.count ?? 1);
      }
    });
    const subjectAreas = Object.values(domainMap);

    // Derive topic_share based research areas with percentages
    const topicShareAreas = (item.topic_share || []).map(ts => ({
      id: numericSuffix(ts.id),
      display_name: ts.display_name || null,
      value: ts.value ?? 0,
      domain: ts.domain?.display_name || null,
      field: ts.field?.display_name || null,
      subfield: ts.subfield?.display_name || null,
    }));

    return { ...common, author_id: id, orcid: item.orcid || null, display_name: item.display_name || null,
      works_count: item.works_count ?? 0, cited_by_count: item.cited_by_count ?? 0,
      h_index: hIndex, i10_index: i10Index, mean_citedness: meanCitedness,
      last_known_institution: institution?.display_name || null,
      last_known_institution_id: numericSuffix(institution?.id), url_image: null,
      counts_by_year: item.counts_by_year || [],
      affiliations: affiliationsList,
      topics: topicsList,
      topic_share: topicShareAreas,
      subject_areas: subjectAreas,
      last_known_institutions: (item.last_known_institutions || []).map(inst => ({
        id: numericSuffix(inst.id),
        display_name: inst.display_name || null,
        country_code: inst.country_code || null,
        type: inst.type || null,
        ror: inst.ror || null,
      })),
    };
  }
  if (kind === 'institutions') return { ...common, institution_id: id, display_name: item.display_name || null,
    country_code: item.country_code || null, type: item.type || null, works_count: item.works_count ?? 0,
    cited_by_count: item.cited_by_count ?? 0, h_index: item.h_index ?? 0, ror: item.ror || null, homepage_url: item.homepage_url || null };
  if (kind === 'journals') {
    const printIssn = item.issn_l || item.issn?.[0] || null;
    const allIssns = Array.isArray(item.issn) ? item.issn : [];
    const eIssn = allIssns.find(i => i !== printIssn) || allIssns[1] || null;

    let countryName = item.country_code || null;
    if (item.country_code && /^[A-Z]{2}$/i.test(item.country_code)) {
      try {
        const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
        countryName = displayNames.of(item.country_code.toUpperCase()) || item.country_code;
      } catch {
        countryName = item.country_code;
      }
    }

    let coverage = null;
    const startYr = item.first_publication_year;
    const endYr = item.last_publication_year;
    if (startYr && endYr) {
      coverage = startYr === endYr ? String(startYr) : `${startYr} - ${endYr}`;
    } else if (Array.isArray(item.counts_by_year) && item.counts_by_year.length) {
      const years = item.counts_by_year.map(c => Number(c.year)).filter(Boolean);
      if (years.length) {
        const minY = Math.min(...years);
        const maxY = Math.max(...years);
        coverage = minY === maxY ? String(minY) : `${minY} - ${maxY}`;
      }
    }

    const primaryTopic = item.topic_share?.[0];
    const topTopic = item.topics?.[0];
    const areaName = primaryTopic?.domain?.display_name || topTopic?.domain?.display_name || primaryTopic?.field?.display_name || topTopic?.display_name || null;

    return {
      ...common,
      journal_id: id,
      display_name: item.display_name || null,
      issn: printIssn,
      eissn: eIssn,
      issns: allIssns,
      type: item.type || null,
      country_code: item.country_code || null,
      country: countryName || item.country_code || null,
      country_name: countryName,
      region_name: areaName,
      subject_area_name: areaName,
      coverage,
      first_publication_year: item.first_publication_year ?? null,
      last_publication_year: item.last_publication_year ?? null,
      publisher_id: numericSuffix(item.host_organization),
      publisher_name: item.host_organization_name || null,
      is_open_access: item.is_oa === true,
      summary_stats: item.summary_stats || {},
      counts_by_year: item.counts_by_year || [],
      works_count: item.works_count ?? 0,
      cited_by_count: item.cited_by_count ?? 0,
      is_in_doaj: item.is_in_doaj ?? false,
    };
  }
  if (kind === 'publishers') return { ...common, publisher_id: id, display_name: item.display_name || null, alternate_titles: item.alternate_titles || [], country_codes: item.country_codes || [], hierarchy_level: item.hierarchy_level ?? null, works_count: item.works_count ?? 0 };
  if (kind === 'keywords') {
    const rawName = item.display_name || item.name || '';
    const cleanName = rawName.replace(/^["']+|["']+$/g, '').trim();
    return {
      ...common,
      keyword_id: id,
      display_name: cleanName || rawName || null,
      name: cleanName || rawName || null,
      works_count: item.works_count ?? 0,
      article_count: item.works_count ?? 0,
      cited_by_count: item.cited_by_count ?? 0,
    };
  }
  if (kind === 'topics') return { ...common, topic_id: id, display_name: item.display_name || null, description: item.description || null, keywords: item.keywords || [],
    subject_area_id: numericSuffix(item.domain?.id), subject_area_name: item.domain?.display_name || null,
    subject_category_id: numericSuffix(item.field?.id), subject_category_name: item.field?.display_name || null,
    works_count: item.works_count ?? 0, cited_by_count: item.cited_by_count ?? 0 };
  if (kind === 'subjectAreas') return { ...common, subject_area_id: id, display_name: item.display_name || null, description: item.description || null,
    openalex_domains: item.fields || [], works_count: item.works_count ?? 0 };
  if (kind === 'subjectCategories') return { ...common, subject_category_id: id, display_name: item.display_name || null, description: item.description || null,
    subject_area_id: numericSuffix(item.domain?.id), subject_area_name: item.domain?.display_name || null,
    openalex_subfields: item.subfields || [], works_count: item.works_count ?? 0 };
  return { ...common, id };
}

function filterValues(kind, query) {
  const filters = [];
  const add = (field, value) => { if (value !== undefined && value !== null && value !== '') filters.push(`${field}:${value}`); };
  if (kind === 'articles') {
    add('publication_year', query.publication_year ?? query.year);
    add('from_publication_date', query.from_year ? `${query.from_year}-01-01` : undefined);
    add('to_publication_date', query.to_year ? `${query.to_year}-12-31` : undefined);
    add('primary_location.source.id', query.journal_id || query.journal ? toOpenAlexId('journals', query.journal_id ?? query.journal) : undefined);
    add('topics.id', query.topic_id || query.topic ? toOpenAlexId('topics', query.topic_id ?? query.topic) : undefined);
    add('authorships.author.id', query.author_id ? toOpenAlexId('authors', query.author_id) : undefined);
    add('authorships.institutions.id', query.institution_id ? toOpenAlexId('institutions', query.institution_id) : undefined);
    add('primary_location.source.host_organization.id', query.publisher_id ? toOpenAlexId('publishers', query.publisher_id) : undefined);
    const access = String(query.is_open_access ?? query.access ?? '').toLowerCase();
    if (['true', 'oa'].includes(access)) add('open_access.is_oa', 'true');
    if (['false', 'closed', 'non-oa'].includes(access)) add('open_access.is_oa', 'false');
    add('type', query.type);
    const countryCode = query.country_code ?? query.country_id;
    if (countryCode) add('primary_location.source.country_code', String(countryCode).toUpperCase());
    const keywordIds = String(query.keyword_ids || '').split('|').map(value => value.trim()).filter(value => /^[a-z0-9_-]+$/i.test(value));
    if (keywordIds.length) add('keywords.id', keywordIds.map(value => toOpenAlexId('keywords', value)).join('|'));
    else if (query.keyword_id) add('keywords.id', toOpenAlexId('keywords', query.keyword_id));
    else if (query.keywords) add('keywords.search', query.keywords);
  } else if (kind === 'journals') {
    const rawIssn = query.issn;
    if (rawIssn) {
      const clean = String(rawIssn).replace(/[^0-9xX]/gi, '').toUpperCase();
      const formatted = clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : rawIssn;
      add('issn', formatted);
    }
    const countryCode = query.country_code ?? query.country ?? query.country_ids ?? query.country_id;
    if (countryCode) add('country_code', String(countryCode).toUpperCase());
    add('type', query.type || (query.search ? undefined : 'journal'));
    add('host_organization.id', query.publisher_id ? toOpenAlexId('publishers', query.publisher_id) : undefined);
    if (String(query.is_open_access ?? query.is_oa ?? '').toLowerCase() === 'true') add('is_oa', 'true');
    const topicFilter = getTopicFilterForSubjectArea(
      query.subject_area_ids ?? query.subject_area_id ?? query.area_id,
      query.subject_category_ids ?? query.subject_category_id ?? query.cat_id
    );
    if (topicFilter) {
      const [filterKey, filterVal] = topicFilter.split(':');
      add(`topics.${filterKey}`, filterVal);
    }
  } else if (kind === 'authors') {
    add('orcid', query.orcid);
    add('last_known_institutions.id', query.institution_id ? toOpenAlexId('institutions', query.institution_id) : undefined);
    const topicFilter = getTopicFilterForSubjectArea(
      query.subject_area_ids ?? query.subject_area_id ?? query.area_id ?? query.subject_area,
      query.subject_category_ids ?? query.subject_category_id ?? query.cat_id
    );
    if (topicFilter) {
      const [filterKey, filterVal] = topicFilter.split(':');
      add(`topics.${filterKey}`, filterVal);
    }
  } else if (kind === 'publishers') {
    add('country_codes', query.country_code ?? query.country);
  } else if (kind === 'keywords' || kind === 'topics' || kind === 'subjectAreas' || kind === 'subjectCategories') {
    add('works_count', query.min_works_count ? `>${query.min_works_count}` : undefined);
    if (kind === 'topics') {
      const topicFilter = getTopicFilterForSubjectArea(query.subject_area_id, query.subject_category_id);
      if (topicFilter) {
        const [filterKey, filterVal] = topicFilter.split(':');
        add(filterKey, filterVal);
      }
    }
    if (kind === 'subjectCategories' && query.subject_area_id) {
      const areaNum = numericSuffix(query.subject_area_id);
      if (areaNum) add('domain.id', areaNum);
    }
  }
  return filters.join(',');
}

export function getTopicFilterForSubjectArea(subjectAreaId, subjectCategoryId) {
  if (subjectCategoryId) {
    const catNum = numericSuffix(subjectCategoryId);
    if (catNum) return `field.id:${catNum}`;
  }
  if (!subjectAreaId) return null;
  const areaRaw = String(subjectAreaId).trim();
  const num = numericSuffix(areaRaw);
  if (num !== null) {
    if (num <= 4) {
      return `domain.id:${num}`;
    }
    if (num >= 10 && num <= 36) {
      return `field.id:${num}`;
    }
  }
  const lower = areaRaw.toLowerCase();
  if (lower.includes('physical')) return 'domain.id:3';
  if (lower.includes('life')) return 'domain.id:1';
  if (lower.includes('health') || lower.includes('medicin')) return 'domain.id:4';
  if (lower.includes('social')) return 'domain.id:2';
  return null;
}

function openAlexSort(kind, query) {
  const sort = String(query.sort || query.sort_by || '').toLowerCase();
  if (kind === 'articles') {
    if (['citations_desc', 'cited_by_count:desc', '-citation_count'].includes(sort)) return 'cited_by_count:desc';
    if (['title', 'name_asc', 'display_name:asc'].includes(sort)) return 'display_name:asc';
    if (sort.includes('asc')) return 'publication_year:asc';
    return 'publication_year:desc';
  }
  if (['metric', 'citations', 'impact', 'h_index', 'cited_by_count', 'citations_desc', 'cited_by_count:desc', 'sjr'].includes(sort)) return 'cited_by_count:desc';
  if (['works_count', 'articles', 'publications', 'works'].includes(sort)) return 'works_count:desc';
  if (kind === 'keywords') return 'works_count:desc';
  return 'display_name:asc';
}

export async function listOpenAlexEntity(ctx, kind) {
  const config = entityConfig[kind];
  if (!config) return null;
  const page = Number(ctx.query.page || 1);
  const requestedLimit = Number(ctx.query.limit || (kind === 'publishers' ? 100 : 10));
  if (!Number.isInteger(page) || page < 1) throw new HttpError(400, 'page must be a positive integer', 'VALIDATION_ERROR');
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new HttpError(400, 'limit must be a positive integer', 'VALIDATION_ERROR');
  const perPage = Math.min(requestedLimit, 100);
  const search = String(ctx.query.search || ctx.query.q || ctx.query.keyword || '').trim();

  // When kind is keywords and subject_area_id or subject_category_id is provided,
  // query OpenAlex topics to return high-relevance research keywords matching that field
  if (kind === 'keywords' && (ctx.query.subject_area_id || ctx.query.subject_category_id)) {
    const topicFilter = getTopicFilterForSubjectArea(ctx.query.subject_area_id, ctx.query.subject_category_id);
    if (topicFilter) {
      const topicParams = {
        select: 'id,display_name,keywords,works_count,cited_by_count,subfield,field,domain',
        per_page: perPage,
        page,
        filter: topicFilter,
      };
      if (search) topicParams.search = search;

      const topicResult = await openAlexRequest(ctx, 'topics', topicParams);
      const total = Number(topicResult.meta?.count || 0);
      const pagination = { page, limit: perPage, total, total_pages: Math.ceil(total / perPage) };

      const items = [];
      const seenNames = new Set();

      for (const topic of topicResult.results || []) {
        const rawTopicName = (topic.display_name || '').trim();
        const cleanTopicName = rawTopicName.replace(/^["']+|["']+$/g, '').trim();
        if (cleanTopicName && !seenNames.has(cleanTopicName.toLowerCase())) {
          seenNames.add(cleanTopicName.toLowerCase());
          items.push({
            keyword_id: numericSuffix(topic.id) ?? openAlexId(topic.id),
            topic_id: numericSuffix(topic.id) ?? openAlexId(topic.id),
            openalex_id: openAlexId(topic.id),
            openalex_url: topic.id || null,
            display_name: cleanTopicName,
            name: cleanTopicName,
            works_count: topic.works_count ?? 0,
            article_count: topic.works_count ?? 0,
            cited_by_count: topic.cited_by_count ?? 0,
            is_topic: true,
            subfield: topic.subfield?.display_name || null,
            field: topic.field?.display_name || null,
            domain: topic.domain?.display_name || null,
          });
        }

        // If search was provided, also check if any sub-keywords within the topic match
        if (search && Array.isArray(topic.keywords)) {
          for (const kw of topic.keywords) {
            const rawKwName = (kw.display_name || '').trim();
            const cleanKwName = rawKwName.replace(/^["']+|["']+$/g, '').trim();
            if (
              cleanKwName &&
              cleanKwName.length >= 2 &&
              cleanKwName.toLowerCase().includes(search.toLowerCase()) &&
              !seenNames.has(cleanKwName.toLowerCase())
            ) {
              seenNames.add(cleanKwName.toLowerCase());
              items.push({
                keyword_id: numericSuffix(kw.id) ?? openAlexId(kw.id),
                openalex_id: openAlexId(kw.id),
                openalex_url: kw.id || null,
                display_name: cleanKwName,
                name: cleanKwName,
                works_count: topic.works_count ?? 0,
                article_count: topic.works_count ?? 0,
                is_topic: false,
              });
            }
          }
        }
      }

      // If search yielded no topics, fallback to OpenAlex keywords search
      if (items.length === 0 && search) {
        const kwParams = {
          select: config.select,
          per_page: perPage,
          page,
          search,
          sort: 'works_count:desc',
        };
        const kwResult = await openAlexRequest(ctx, config.endpoint, kwParams);
        const kwItems = (kwResult.results || [])
          .map(item => toLegacyEntity(kind, item))
          .filter(item => item.display_name);
        if (kwItems.length > 0) {
          const kwTotal = Number(kwResult.meta?.count || kwItems.length);
          return {
            success: true,
            code: 'KEYWORD_LIST_FETCHED',
            message: 'Lấy danh sách keyword thành công',
            data: kwItems,
            pagination: { page, limit: perPage, total: kwTotal, total_pages: Math.ceil(kwTotal / perPage) },
          };
        }
      }

      return {
        success: true,
        code: 'KEYWORD_LIST_FETCHED',
        message: 'Lấy danh sách keyword từ Topics thành công',
        data: items,
        pagination,
      };
    }
  }

  // Handle special identifier patterns in general search
  const isIssn = (v) => /^\d{4}-?\d{3}[\dxX]$/i.test(v);
  const isJournalIssnSearch = kind === 'journals' && isIssn(search);
  let formattedIssn = null;
  if (isJournalIssnSearch) {
    const clean = search.replace(/[^0-9xX]/gi, '').toUpperCase();
    formattedIssn = `${clean.slice(0, 4)}-${clean.slice(4)}`;
  }

  const isDoi = (v) => /^(https?:\/\/doi\.org\/)?(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)$/i.test(v);
  const isArticleDoiSearch = kind === 'articles' && isDoi(search);
  let cleanDoi = null;
  if (isArticleDoiSearch) {
    const match = search.match(/(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/i);
    cleanDoi = match ? match[1] : search;
  }

  const bypassSearch = isJournalIssnSearch || isArticleDoiSearch;

  // Resolve institution name to ID for authors if passed as text
  if (kind === 'authors' && ctx.query.institution && !ctx.query.institution_id) {
    try {
      const instLookup = await openAlexRequest(ctx, 'institutions', {
        search: ctx.query.institution,
        per_page: 1,
        select: 'id,display_name',
      });
      if (instLookup.results?.[0]?.id) {
        ctx.query.institution_id = openAlexId(instLookup.results[0].id) || numericSuffix(instLookup.results[0].id);
      }
    } catch {}
  }

  const params = { select: config.select, per_page: perPage, page, ...(!search || bypassSearch || ctx.query.sort || ctx.query.sort_by ? { sort: openAlexSort(kind, ctx.query) } : {}) };
  if (search && !bypassSearch) params.search = search;
  
  let filter = filterValues(kind, ctx.query);
  if (isJournalIssnSearch && formattedIssn) {
    filter = filter ? `${filter},issn:${formattedIssn}` : `issn:${formattedIssn}`;
  } else if (isArticleDoiSearch && cleanDoi) {
    filter = filter ? `${filter},doi:${cleanDoi}` : `doi:${cleanDoi}`;
  }
  if (filter) params.filter = filter;
  const result = await openAlexRequest(ctx, config.endpoint, params);
  let items = result.results.map(item => toLegacyEntity(kind, item));
  let total = Number(result.meta?.count || 0);

  // Smart Author & Affiliation Search: If search term also matches an institution, augment with its top researchers
  if (kind === 'authors' && search && page === 1 && !ctx.query.institution_id) {
    try {
      const instResult = await openAlexRequest(ctx, 'institutions', {
        search,
        per_page: 1,
        select: 'id,display_name,works_count',
      });
      const topInst = instResult.results?.[0];
      if (topInst && topInst.id) {
        const instId = openAlexId(topInst.id) || numericSuffix(topInst.id);
        if (instId) {
          const instAuthorParams = {
            select: config.select,
            per_page: perPage,
            page: 1,
            filter: `last_known_institutions.id:${instId}`,
            sort: 'cited_by_count:desc',
          };
          const instAuthorRes = await openAlexRequest(ctx, 'authors', instAuthorParams);
          const instAuthorItems = (instAuthorRes.results || []).map(item => toLegacyEntity(kind, item));
          const instAuthorTotal = Number(instAuthorRes.meta?.count || 0);

          const qLower = search.toLowerCase();
          const directNameMatches = items.filter(a => (a.display_name || '').toLowerCase().includes(qLower));

          const merged = [];
          const seen = new Set();
          const addItem = (it) => {
            const key = it.author_id || it.openalex_id;
            if (!key || seen.has(key)) return;
            seen.add(key);
            merged.push(it);
          };

          if (directNameMatches.length >= 3) {
            directNameMatches.forEach(addItem);
            items.forEach(addItem);
            instAuthorItems.forEach(addItem);
          } else {
            instAuthorItems.forEach(addItem);
            items.forEach(addItem);
          }

          items = merged.slice(0, perPage);
          total = Math.max(total, instAuthorTotal);
        }
      }
    } catch (instErr) {
      console.warn('[openalex] institution search resolution failed:', instErr?.message || instErr);
    }
  }
  const pagination = { page, limit: perPage, total, total_pages: Math.ceil(total / perPage) };
  if (kind === 'articles') {
    return { success: true, code: 'ARTICLES_GET_SUCCESS', message: 'Láº¥y danh sÃ¡ch bÃ i bÃ¡o thÃ nh cÃ´ng!', data: {
      articles: items, items, pagination, stats: {
        totalArticles: total,
        openAccessCount: items.filter(item => item.open_access?.is_oa === true).length,
        authorsCount: new Set(items.flatMap(item => (item.authors || []).map(author => author.openalex_id || author.author_id).filter(Boolean))).size,
        topicsCount: new Set(items.flatMap(item => item.topic_ids || []).filter(Boolean)).size,
      },
    } };
  }
  if (kind === 'journals' || kind === 'topics' || kind === 'subjectAreas' || kind === 'subjectCategories') {
    return { success: true, code: kind === 'journals' ? undefined : `GET_${kind.toUpperCase()}_SUCCESS`, message: `Fetched ${kind} from OpenAlex`, data: { items, pagination: { page, limit: perPage, total } } };
  }
  const codes = { authors: ['AUTHOR_LIST_FETCHED', 'Láº¥y danh sÃ¡ch tÃ¡c giáº£ thÃ nh cÃ´ng'], publishers: [undefined, 'Láº¥y danh sÃ¡ch nhÃ  xuáº¥t báº£n thÃ nh cÃ´ng'], keywords: ['KEYWORD_LIST_FETCHED', 'Láº¥y danh sÃ¡ch keyword thÃ nh cÃ´ng'] };
  const [code, message] = codes[kind] || [];
  return { success: true, ...(code ? { code } : {}), message, data: items, pagination };
}

export async function getOpenAlexEntity(ctx, kind) {
  const config = entityConfig[kind];
  if (!config) return null;
  const endpointId = toOpenAlexId(kind, ctx.params.id);
  const result = await openAlexRequest(ctx, `${config.endpoint}/${endpointId}`, { select: config.select });
  return toLegacyEntity(kind, result);
}

const SEARCH_ENTITY_TYPES = new Map([
  ['article', 'articles'], ['author', 'authors'], ['institution', 'institutions'],
  ['journal', 'journals'], ['keyword', 'keywords'], ['topic', 'topics'],
]);

function searchCard(kind, row, sourceRank) {
  const id = row[`${kind === 'article' ? 'article' : kind}_id`] ?? row.id;
  const title = kind === 'article' ? row.title : row.display_name;
  const description = kind === 'article' ? row.abstract : kind === 'author' ? row.orcid
    : kind === 'institution' ? row.country_code : kind === 'journal' ? row.publisher_name
      : kind === 'topic' ? row.description : null;
  return {
    id: String(id ?? ''), type: kind, title: title || '', description: description || null,
    publicationYear: kind === 'article' ? row.publication_year ?? null : null,
    citationCount: kind === 'article' ? row.citation_count ?? 0 : 0,
    metadata: kind === 'article' ? { doi: row.doi || null, openalex_id: row.openalex_id } : { openalex_id: row.openalex_id },
    __sourceRank: sourceRank,
  };
}

export async function searchOpenAlexEntities(ctx, { q, type = 'all', page = 1, limit = 10 } = {}) {
  const kinds = type === 'all' ? [...SEARCH_ENTITY_TYPES.keys()] : [type];
  if (kinds.some(kind => !SEARCH_ENTITY_TYPES.has(kind))) throw new HttpError(400, 'type must be all, article, author, institution, journal, keyword, or topic', 'VALIDATION_ERROR');
  const perPage = Math.min(100, Math.max(limit, page * limit));
  const entityResults = await Promise.all(kinds.map(async kind => {
    const collection = SEARCH_ENTITY_TYPES.get(kind);
    const config = entityConfig[collection];
    const result = await openAlexRequest(ctx, config.endpoint, { search: q, per_page: perPage, select: config.select });
    return { kind, count: Number(result.meta?.count || 0), items: result.results.map((item, index) => searchCard(kind, toLegacyEntity(collection, item), index)) };
  }));
  const counts = Object.fromEntries(entityResults.map(result => [result.kind, result.count]));
  const candidates = [];
  const maxIndex = Math.max(0, ...entityResults.map(result => result.items.length));
  for (let index = 0; index < maxIndex; index += 1) {
    for (const result of entityResults) if (result.items[index]) candidates.push(result.items[index]);
  }
  const total = entityResults.reduce((sum, result) => sum + result.count, 0);
  const offset = (page - 1) * limit;
  const items = candidates.slice(offset, offset + limit).map(({ __sourceRank, ...item }, index) => ({ ...item, rank: offset + index + 1 }));
  return { code: 200, message: 'Fetch search results successfully', data: {
    query: q, type, projectId: ctx.query.project_id || null, page, limit, total,
    totalPages: total > 0 ? Math.ceil(total / limit) : 0, counts, items,
  } };
}

export async function searchOpenAlexWorkGraph(ctx, keyword, limit = 50) {
  const config = entityConfig.articles;
  const works = [];
  let cursor = '*';
  let pageCount = 0;
  while (works.length < limit && cursor && pageCount < Math.ceil(limit / 100)) {
    const perPage = Math.min(100, limit - works.length);
    const result = await openAlexRequest(ctx, 'works', { search: keyword, per_page: perPage, cursor, select: config.select });
    works.push(...result.results);
    cursor = result.meta?.next_cursor || null;
    pageCount += 1;
  }
  const nodes = new Map();
  const relationships = new Map();
  const addNode = (id, labels, properties) => {
    if (!id) return;
    nodes.set(String(id), { id: String(id), labels, properties });
  };
  const addEdge = (start, type, end, properties = {}) => {
    if (!start || !end) return;
    const id = `${start}:${type}:${end}`;
    relationships.set(id, { id, type, start: String(start), end: String(end), properties });
  };
  for (const raw of works) {
    const article = openAlexWorkToLegacy(raw);
    const workId = article.openalex_id;
    addNode(workId, ['Article'], article);
    for (const author of article.authors || []) {
      addNode(author.openalex_id, ['Author'], author);
      addEdge(workId, 'AUTHORED_BY', author.openalex_id);
    }
    if (article.journal_openalex_id) {
      addNode(article.journal_openalex_id, ['Journal'], { journal_id: article.journal_id, display_name: article.journal_name });
      addEdge(workId, 'PUBLISHED_IN', article.journal_openalex_id);
    }
    for (const topic of article.topics || []) {
      addNode(topic.openalex_id, ['Topic'], topic);
      addEdge(workId, 'HAS_TOPIC', topic.openalex_id, { score: topic.score });
    }
    for (const keyword of article.keyword_objects || []) {
      addNode(keyword.openalex_id, ['Keyword'], keyword);
      addEdge(workId, 'HAS_KEYWORD', keyword.openalex_id, { score: keyword.score });
    }
    for (const reference of (article.references || []).slice(0, 30)) {
      const referenceId = openAlexId(reference);
      if (!referenceId) continue;
      addNode(referenceId, ['Article'], { openalex_id: referenceId });
      addEdge(workId, 'REFERENCES', referenceId);
    }
  }
  return { source: 'openalex', keyword, nodes: [...nodes.values()], relationships: [...relationships.values()] };
}
