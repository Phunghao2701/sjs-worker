import { HttpError } from '../core/http.js';
import { defineRoutes, ok } from '../core/router.js';
import { all, byId, collectionFor, find, id, isDeleted, nowIso, paginate, requireFound, save } from '../firestore/repository.js';
import { openAlexWorkToLegacy } from '../openalex/adapters.js';
import { openAlexRequest } from '../openalex/client.js';
import { enrichProjectsWithOpenAlex, loadProjectResearchScopes } from '../openalex/project-dashboard.js';
import { enqueueProjectKeywordSyncs, normalizeOpenAlexKeywordId, projectOpenAlexSyncStatus } from '../openalex/project-sync.js';

const memberKey = (projectId, userId) => `${projectId}_${userId}`;
const userKey = user => String(user?.user_id || user?.id);

export async function requireProject(ctx, projectId, { includeDeleted = false } = {}) {
  const project = await byId(ctx.db, 'projects', projectId);
  if (!project || (!includeDeleted && isDeleted(project))) throw new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND');
  const uid = userKey(ctx.user);
  const owner = String(project.user_id || project.owner_id || project.created_by || '') === uid;
  const isAcceptedMember = row => row && String(row.project_id) === String(projectId) && String(row.user_id) === uid && row.status === 'ACCEPTED';
  const directMember = await ctx.db.get('project_members', memberKey(projectId, uid));
  const member = isAcceptedMember(directMember) ? directMember : (await find(ctx.db, 'project_members', isAcceptedMember, { limit: 1 }))[0];
  if (!owner && !member) throw new HttpError(403, 'Project access denied', 'FORBIDDEN');
  return { ...project, _isOwner: owner, _membership: member };
}

async function projectList(ctx) {
  const uid = userKey(ctx.user);
  const includeDeleted = ctx.query.includeDeleted === 'true' || ctx.query.status === 'ALL';
  const memberships = await find(ctx.db, 'project_members', row => String(row.user_id) === uid && row.status === 'ACCEPTED', { limit: Infinity });
  const sharedIds = new Set(memberships.map(row => String(row.project_id)));
  const rows = (await all(ctx.db, 'projects')).filter(row => (includeDeleted || !isDeleted(row)) && (String(row.user_id || row.owner_id || row.created_by) === uid || sharedIds.has(String(row.id || row.project_id))));
  const scopes = await loadProjectResearchScopes(ctx.db, rows);
  return ok(await enrichProjectsWithOpenAlex(ctx, scopes), 'Projects fetched successfully', 'SUCCESS_GET_PROJECTS');
}

async function createProject(ctx) {
  if (!ctx.body.title) throw new HttpError(400, 'title is required', 'VALIDATION_ERROR');
  const projectId = String(ctx.body.project_id || ctx.body.id || id());
  const categories = ctx.body.subject_category_ids || [];
  const journals = ctx.body.journal_ids || [];
  const keywords = ctx.body.keyword_ids || ctx.body.keywords || [];
  const row = await save(ctx.db, 'projects', projectId, { ...ctx.body, subject_area: ctx.body.subject_area ?? ctx.body.subject_area_id, subject_category_ids: categories, journal_ids: journals, user_id: userKey(ctx.user), owner_id: userKey(ctx.user), project_id: projectId, status: 'ACTIVE' }, { create: true });
  await Promise.all([
    writeProjectLinks(ctx.db, projectId, 'project_journals', 'journal_id', journals, { replace: false }),
    writeProjectLinks(ctx.db, projectId, 'subject_category_projects', 'subject_category_id', categories, { replace: false }),
    writeProjectLinks(ctx.db, projectId, 'project_keywords', 'keyword_id', keywords, { replace: false }),
  ]);
  if (keywords.length) {
    try {
      await enqueueProjectKeywordSyncs(ctx.env, ctx.db, projectId, keywords);
    } catch (error) {
      console.warn('[openalex sync] project created, but initial sync could not be queued', projectId, error.message);
    }
  }
  return { body: { success: true, code: 'SUCCESS_CREATE_PROJECT', message: 'Táº¡o dá»± Ã¡n thÃ nh cÃ´ng', data: row }, status: 201 };
}

async function getProject(ctx) {
  const { _isOwner, _membership, ...project } = await requireProject(ctx, ctx.params.id);
  const areaId = project.subject_area_id ?? project.subject_area;
  if (areaId != null && (typeof project.subject_area !== 'object' || project.subject_area === null)) {
    const areas = await all(ctx.db, 'subjectAreas');
    const area = areas.find(row => String(row.subject_area_id || row.id) === String(areaId));
    project.subject_area = area ? { ...area } : String(areaId);
  }
  return ok(project, 'Project fetched successfully', 'SUCCESS_GET_PROJECT');
}

async function updateProject(ctx) {
  const current = await requireProject(ctx, ctx.params.id);
  if (!current._isOwner) throw new HttpError(403, 'Only the project owner can update project details', 'FORBIDDEN');
  const { _isOwner, _membership, ...saved } = current;
  const patch = {};
  if (ctx.body.title !== undefined) {
    if (typeof ctx.body.title !== 'string' || !ctx.body.title.trim()) throw new HttpError(400, 'title must be a non-empty string', 'VALIDATION_ERROR');
    patch.title = ctx.body.title.trim();
  }
  if (ctx.body.subject_area !== undefined || ctx.body.subject_area_id !== undefined) patch.subject_area = ctx.body.subject_area ?? ctx.body.subject_area_id;
  if (ctx.body.subject_category_ids !== undefined) {
    if (!Array.isArray(ctx.body.subject_category_ids)) throw new HttpError(400, 'subject_category_ids must be an array', 'VALIDATION_ERROR');
    patch.subject_category_ids = ctx.body.subject_category_ids;
  }
  if (ctx.body.journal_ids !== undefined) {
    if (!Array.isArray(ctx.body.journal_ids)) throw new HttpError(400, 'journal_ids must be an array', 'VALIDATION_ERROR');
    patch.journal_ids = ctx.body.journal_ids;
  }
  const update = await save(ctx.db, 'projects', saved.id || ctx.params.id, patch);
  if (ctx.body.journal_ids !== undefined) await writeProjectLinks(ctx.db, ctx.params.id, 'project_journals', 'journal_id', ctx.body.journal_ids);
  if (ctx.body.subject_category_ids !== undefined) await writeProjectLinks(ctx.db, ctx.params.id, 'subject_category_projects', 'subject_category_id', ctx.body.subject_category_ids);
  if (ctx.body.keyword_ids !== undefined || ctx.body.keywords !== undefined) {
    await writeProjectLinks(ctx.db, ctx.params.id, 'project_keywords', 'keyword_id', ctx.body.keyword_ids || ctx.body.keywords);
    const keywordRows = await find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.params.id), { limit: Infinity });
    await enqueueProjectKeywordSyncs(ctx.env, ctx.db, ctx.params.id, keywordRows.map(row => row.keyword_id));
  }
  return ok(update, 'Project updated successfully', 'SUCCESS_UPDATE_PROJECT');
}

async function writeProjectLinks(db, projectId, collection, field, values, { replace = true } = {}) {
  if (replace) {
    const existing = await find(db, collection, row => String(row.project_id) === String(projectId), { limit: Infinity });
    if (existing.length) await db.batchDelete(collection, existing.map(row => row.id));
  }
  const rows = [...new Set((values || []).map(value => {
    const idValue = value?.[field] ?? value?.keyword_id ?? value?.id;
    const label = value?.label ?? value?.display_name ?? value?.name ?? value?.keyword ?? value?.text;
    if (collection === 'project_keywords' && label && idValue && !/^(?:K\d+|\d+)$/i.test(String(idValue))) return String(label).trim();
    return String(idValue ?? label ?? value).trim();
  }).filter(Boolean))].map(value => {
    const safeKey = String(value).toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 80);
    return {
      id: `${projectId}_${safeKey}`,
      data: {
        project_id: String(projectId),
        [field]: value,
        ...(collection === 'project_keywords' ? { keyword: value } : {}),
      },
    };
  });
  if (rows.length) await db.batchSet(collection, rows);
}

async function removeProject(ctx) {
  const current = await requireProject(ctx, ctx.params.id);
  if (!current._isOwner) throw new HttpError(403, 'Only project owner can delete project', 'FORBIDDEN');
  const { _isOwner, _membership, ...project } = current;
  await ctx.db.merge('projects', project.id || ctx.params.id, { status: 'DELETED', deleted_at: nowIso(), updated_at: nowIso() });
  return ok(undefined, 'Project deleted successfully', 'SUCCESS_DELETE_PROJECT');
}

async function restoreProject(ctx) {
  const project = await requireProject(ctx, ctx.params.id, { includeDeleted: true });
  if (!project._isOwner) throw new HttpError(403, 'Only project owner can restore project', 'FORBIDDEN');
  await ctx.db.merge('projects', project.id || ctx.params.id, { status: 'ACTIVE', deleted_at: null, updated_at: nowIso() });
  return ok({ status: 'ACTIVE' }, 'Project restored successfully', 'SUCCESS_RESTORE_PROJECT');
}

async function activateProject(ctx) {
  const project = await requireProject(ctx, ctx.params.id);
  if (!project._isOwner) throw new HttpError(403, 'Only the project owner can activate project', 'FORBIDDEN');
  await ctx.db.merge('projects', project.id || ctx.params.id, { status: 'ACTIVE', activated_at: project.activated_at || nowIso() });
  return ok({ status: 'ACTIVE' }, 'Project activated for free', 'SUCCESS_ACTIVATE_PROJECT');
}

async function projectArticles(ctx) {
  const project = await requireProject(ctx, ctx.params.id);
  const keywordRows = await find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.params.id), { limit: Infinity });
  const queries = await projectOpenAlexQueries(ctx, project, keywordRows);
  const page = Math.max(1, Number.parseInt(ctx.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(ctx.query.limit, 10) || 10));
  const select = 'id,doi,display_name,publication_year,publication_date,type,authorships,primary_location,locations,referenced_works,referenced_works_count,cited_by_count,primary_topic,topics,keywords,open_access,biblio,created_date,updated_date,ids,abstract_inverted_index,language';
  const pages = await Promise.all(queries.map(query => openAlexRequest(ctx, 'works', {
    ...query, page, per_page: Math.min(100, limit), select, sort: 'publication_date:desc',
  })));
  const seen = new Set();
  const items = pages.flatMap(result => result.results || []).filter(work => {
    const id = String(work.id || work.doi || work.display_name || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return !ctx.query.search || String(work.display_name || '').toLocaleLowerCase().includes(String(ctx.query.search).toLocaleLowerCase());
  }).map(openAlexWorkToLegacy).sort((a, b) => Number(b.publication_year || 0) - Number(a.publication_year || 0) || String(b.publication_date || '').localeCompare(String(a.publication_date || '')));
  const total = pages.reduce((sum, result) => sum + Number(result.meta?.count || 0), 0);
  return ok({ items: items.slice(0, limit), pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }, source: 'openalex' }, 'Related articles fetched directly from OpenAlex', 'SUCCESS_GET_RELATED_ARTICLES');
}

async function projectOverview(ctx) {
  const project = await requireProject(ctx, ctx.params.id);
  const keywords = await find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.params.id), { limit: Infinity });
  const queries = await projectOpenAlexQueries(ctx, project, keywords);
  const [yearPages, domainPages, typePages, sourcePages] = await Promise.all([
    Promise.all(queries.map(query => groupedProjectWorks(ctx, query, 'publication_year'))),
    Promise.all(queries.map(query => groupedProjectWorks(ctx, query, 'primary_topic.domain.id'))),
    Promise.all(queries.map(query => groupedProjectWorks(ctx, query, 'type'))),
    Promise.all(queries.map(query => groupedProjectWorks(ctx, query, 'primary_location.source.id'))),
  ]);
  const publicationTrend = mergeGroups(yearPages, group => String(group.key));
  const subjectAreas = mergeGroups(domainPages, group => group.key_display_name || String(group.key));
  const publicationTypes = mergeGroups(typePages, group => group.key_display_name || String(group.key));
  const journals = mergeGroups(sourcePages, group => group.key_display_name || String(group.key));
  const totalArticles = yearPages.reduce((sum, result) => sum + Number(result.meta?.count || 0), 0);
  const totalJournals = journals.filter(row => row.value > 0).length;
  const countsByYear = new Map(publicationTrend.map(row => [Number(row.name), row.value]).filter(([year]) => Number.isInteger(year)));
  const latestCompleteYear = [...countsByYear.keys()].filter(year => year < new Date().getFullYear()).sort((a, b) => b - a)[0];
  const previousYearCount = latestCompleteYear == null ? 0 : Number(countsByYear.get(latestCompleteYear - 1) || 0);
  const latestYearCount = latestCompleteYear == null ? 0 : Number(countsByYear.get(latestCompleteYear) || 0);
  const growthRate = previousYearCount > 0 ? Math.round((latestYearCount - previousYearCount) / previousYearCount * 1000) / 10 : 0;
  return ok({
    summary: { totalArticles, totalKeywords: keywords.length, totalJournals, growthRate, growthYear: latestCompleteYear ?? null, lastUpdatedAt: new Date().toISOString() },
    charts: {
      publicationTrend: toChart(publicationTrend, 'Number of Articles'),
      subjectAreaDistribution: toChart(subjectAreas, 'Articles'),
      publicationTypeDistribution: toChart(publicationTypes, 'Articles'),
    },
    topKeywords: keywords.slice(0, 10),
    topJournals: journals.sort((a, b) => b.value - a.value).slice(0, 10).map(row => ({ display_name: row.name, article_count: row.value })),
    source: 'openalex',
  }, 'Project overview fetched directly from OpenAlex');
}

async function projectAnalytics(ctx) {
  const project = await requireProject(ctx, ctx.params.id);
  const keywords = await find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.params.id), { limit: Infinity });
  const queries = await projectOpenAlexQueries(ctx, project, keywords);
  const pages = await Promise.all(queries.map(query => groupedProjectWorks(ctx, query, 'publication_year')));
  const publicationsByYear = mergeGroups(pages, group => String(group.key)).map(row => ({ year: Number(row.name), count: row.value }));
  return ok({ publicationsByYear, citationsByYear: [], topKeywords: [], totalArticles: pages.reduce((sum, result) => sum + Number(result.meta?.count || 0), 0), totalCitations: null, citationsUnavailable: true, citationSampleSize: 0, source: 'openalex' }, 'Project analytics fetched directly from OpenAlex', 'SUCCESS_GET_PROJECT_ANALYTICS');
}

async function projectOpenAlexQueries(ctx, project, keywordRows) {
  const values = [...new Set(keywordRows.map(row => String(row.keyword_id || row.keyword || '').trim()).filter(Boolean))].slice(0, 20);
  const queries = values.map(value => {
    const matchingRow = Array.isArray(keywordRows) ? keywordRows.find(row => {
      if (!row) return false;
      if (typeof row === 'string') return row.trim() === value;
      return String(row.keyword || row.keyword_id || row.name || row.id || '').trim() === value;
    }) : null;
    const rawKeyword = (matchingRow && typeof matchingRow === 'object' && matchingRow.keyword)
      ? matchingRow.keyword
      : (typeof value === 'string' && !value.startsWith('TEXT_') ? value : '');
    const normalizedId = normalizeOpenAlexKeywordId(value);
    if (normalizedId.startsWith('TEXT_')) {
      let term = rawKeyword && !rawKeyword.startsWith('TEXT_')
        ? String(rawKeyword).trim()
        : normalizedId.slice(5).replace(/^_+|_+$/g, '').replace(/_+/g, ' ').trim();
      try { term = decodeURIComponent(term); } catch { /* Preserve malformed legacy values as searchable text. */ }
      return term ? { search: term } : null;
    }
    return { filter: `keywords.id:${normalizedId}` };
  }).filter(Boolean);
  if (queries.length) return queries;

  const projectId = String(project.project_id || project.id);
  const [journalLinks, categoryLinks] = await Promise.all([
    find(ctx.db, 'project_journals', row => String(row.project_id) === projectId, { limit: Infinity }),
    find(ctx.db, 'subject_category_projects', row => String(row.project_id) === projectId, { limit: Infinity }),
  ]);
  const journalValues = [...(project.journal_ids || []), ...journalLinks.map(row => row.journal_id)];
  const categoryValues = [...(project.subject_category_ids || []), ...categoryLinks.map(row => row.subject_category_id)];
  const journalIds = [...new Set(journalValues.map(value => String(value?.id ?? value).trim()).filter(value => /^[A-Z]?\d+$/i.test(value)).map(value => /^\d+$/.test(value) ? `S${value}` : value.toUpperCase()))];
  const categoryIds = [...new Set(categoryValues.map(value => String(value?.id ?? value).trim()).filter(value => /^[A-Z]?\d+$/i.test(value)).map(value => /^\d+$/.test(value) ? `F${value}` : value.toUpperCase()))];
  const area = String(project.subject_area_id || project.subject_area || '').trim();
  const domainId = /^(?:domains\/)?\d+$/i.test(area) ? `primary_topic.domain.id:${area.toLowerCase().startsWith('domains/') ? area : `domains/${area}`}` : null;
  const filters = [journalIds.length ? `primary_location.source.id:${journalIds.join('|')}` : null, categoryIds.length ? `primary_topic.field.id:${categoryIds.join('|')}` : null, domainId].filter(Boolean);
  return filters.length ? [{ filter: filters.join(',') }] : [{ search: String(project.title || '').trim() }].filter(query => query.search);
}

async function groupedProjectWorks(ctx, query, groupBy) {
  if (!query.search && !query.filter) return { meta: { count: 0 }, group_by: [] };
  return openAlexRequest(ctx, 'works', { ...query, group_by: groupBy, per_page: 200 });
}

function mergeGroups(pages, getName) {
  const groups = new Map();
  for (const page of pages) for (const group of page.group_by || []) {
    const name = getName(group);
    if (!name || name === 'unknown') continue;
    groups.set(name, (groups.get(name) || 0) + Number(group.count || 0));
  }
  return [...groups].map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name));
}

function toChart(rows, label) {
  return { labels: rows.map(row => row.name), datasets: [{ label, data: rows.map(row => row.value) }] };
}
async function projectKeywordIds(ctx, projectId) {
  const rows = await find(ctx.db, 'project_keywords', row => String(row.project_id) === String(projectId), { limit: Infinity });
  return [...new Set(rows.map(row => String(row.keyword_id || row.keyword || '').trim()).filter(Boolean))].slice(0, 100);
}

async function projectOpenAlexArticles(db, projectId, keywordIds) {
  const links = [];
  let offset = 0;
  while (true) {
    const page = await db.query('openalex_project_works', { filters: [{ field: 'project_id', value: String(projectId) }], limit: 1000, offset });
    links.push(...page);
    if (page.length < 1000) break;
    offset += page.length;
  }
  const watchedIds = new Set(keywordIds.map(normalizeOpenAlexKeywordId));
  const workIds = [...new Set(links.filter(row => watchedIds.has(normalizeOpenAlexKeywordId(row.keyword_id))).map(row => String(row.work_id || '')).filter(Boolean))];
  const documents = await Promise.all(workIds.map(workId => db.get('openalex_works', workId)));
  const articles = documents.filter(row => row?.data).map(row => openAlexWorkToLegacy(row.data));
  articles.sort((a, b) => Number(b.publication_year || 0) - Number(a.publication_year || 0) || String(b.publication_date || '').localeCompare(String(a.publication_date || '')));
  return articles;
}

async function projectScopedArticles(ctx, project) {
  const projectId = String(project.project_id || project.id);
  const [journalLinks, categoryLinks, articleScopes] = await Promise.all([
    find(ctx.db, 'project_journals', row => String(row.project_id) === projectId, { limit: Infinity }),
    find(ctx.db, 'subject_category_projects', row => String(row.project_id) === projectId, { limit: Infinity }),
    find(ctx.db, 'project_article_scopes', row => String(row.project_id) === projectId, { limit: Infinity }),
  ]);
  const journals = new Set([...(project.journal_ids || []), ...journalLinks.map(row => row.journal_id)].map(String));
  const categories = new Set([...(project.subject_category_ids || []), ...categoryLinks.map(row => row.subject_category_id)].map(String));
  const areas = new Set((project.subject_area_ids || (project.subject_area || project.subject_area_id ? [project.subject_area || project.subject_area_id] : [])).map(String));
  const scopedArticleIds = new Set(articleScopes.map(row => String(row.article_id)));
  return (await all(ctx.db, 'articles')).filter(row => !isDeleted(row) && (scopedArticleIds.has(String(row.article_id || row.id)) || journals.has(String(row.journal_id)) || categories.has(String(row.subject_category_id)) || areas.has(String(row.subject_area_id))));
}

async function members(ctx) {
  await requireProject(ctx, ctx.params.projectId);
  const rows = await find(ctx.db, 'project_members', row => String(row.project_id) === String(ctx.params.projectId), { limit: Infinity });
  return ok(rows, 'Project members fetched successfully');
}

async function invite(ctx) {
  const project = await requireProject(ctx, ctx.params.projectId);
  const email = String(ctx.body.email || '').trim().toLowerCase();
  if (!email.includes('@')) throw new HttpError(400, 'Valid email is required', 'VALIDATION_ERROR');
  const users = await find(ctx.db, 'users', row => String(row.email || '').toLowerCase() === email, { limit: 1 });
  const token = id();
  const invite = { id: token, token, project_id: String(ctx.params.projectId), email, user_id: users[0]?.user_id || users[0]?.id || null, role: ['EDITOR', 'VIEWER'].includes(ctx.body.role) ? ctx.body.role : 'VIEWER', invited_by: userKey(ctx.user), status: 'PENDING', created_at: nowIso(), expires_at: new Date(Date.now() + 7 * 86400000).toISOString() };
  await ctx.db.create('project_invites', token, invite);
  const link = `${ctx.env.APP_URL || ''}/project-invite/accept?token=${encodeURIComponent(token)}`;
  if (ctx.env.EMAIL_API_URL) await fetch(ctx.env.EMAIL_API_URL, { method: 'POST', headers: { 'content-type': 'application/json', ...(ctx.env.EMAIL_API_KEY ? { authorization: `Bearer ${ctx.env.EMAIL_API_KEY}` } : {}) }, body: JSON.stringify({ to: email, template: 'project-invite', link, project: project.title }) });
  return ok({ invite_id: token, ...(ctx.env.NODE_ENV === 'production' ? {} : { token, link }) }, 'Invitation sent successfully');
}

async function acceptInvite(ctx) {
  const token = String(ctx.query.token || '');
  const invite = requireFound(await ctx.db.get('project_invites', token), 'Invitation not found');
  if (invite.status !== 'PENDING' || new Date(invite.expires_at) <= new Date()) throw new HttpError(400, 'Invitation is expired or already used', 'INVITE_INVALID');
  if (ctx.user && String(ctx.user.email).toLowerCase() !== invite.email) throw new HttpError(403, 'Invitation belongs to another account', 'FORBIDDEN');
  const invitedUser = !ctx.user && !invite.user_id ? (await find(ctx.db, 'users', row => String(row.email || '').toLowerCase() === String(invite.email).toLowerCase(), { limit: 1 }))[0] : null;
  const userId = ctx.user ? userKey(ctx.user) : invite.user_id || invitedUser?.user_id || invitedUser?.id;
  if (!userId) throw new HttpError(401, 'Sign in with the invited account first', 'UNAUTHORIZED');
  await ctx.db.set('project_members', memberKey(invite.project_id, userId), { id: memberKey(invite.project_id, userId), project_id: invite.project_id, user_id: userId, email: invite.email, role: invite.role, status: 'ACCEPTED', invited_by: invite.invited_by, invited_at: invite.created_at, accepted_at: nowIso(), joined_at: nowIso() });
  await ctx.db.merge('project_invites', invite.id || token, { status: 'ACCEPTED', accepted_at: nowIso(), user_id: userId });
  return ok(undefined, 'Invitation accepted successfully');
}

async function updateMember(ctx) {
  const project = await requireProject(ctx, ctx.params.projectId);
  if (!project._isOwner) throw new HttpError(403, 'Only the owner can manage members', 'FORBIDDEN');
  const key = memberKey(ctx.params.projectId, ctx.params.userId);
  const member = requireFound(await ctx.db.get('project_members', key), 'Project member not found');
  const role = String(ctx.body.role || '').toUpperCase();
  if (!['OWNER', 'EDITOR', 'VIEWER'].includes(role)) throw new HttpError(400, 'Invalid member role', 'VALIDATION_ERROR');
  await ctx.db.merge('project_members', key, { role, updated_at: nowIso() });
  return ok({ ...member, role }, 'Member role updated successfully');
}

async function removeMember(ctx) {
  const project = await requireProject(ctx, ctx.params.projectId);
  if (!project._isOwner && userKey(ctx.user) !== String(ctx.params.userId)) throw new HttpError(403, 'Only the owner can remove members', 'FORBIDDEN');
  await ctx.db.delete('project_members', memberKey(ctx.params.projectId, ctx.params.userId));
  return ok(undefined, 'Member removed successfully');
}

async function listProjectKeywords(ctx) {
  await requireProject(ctx, ctx.params.projectId);
  const rows = await find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.params.projectId), { limit: Infinity });
  return ok(rows, 'Project keywords fetched successfully');
}

async function watchKeywords(ctx, replace = false) {
  await requireProject(ctx, ctx.params.projectId);
  const requestedValues = Array.isArray(ctx.body.keyword_ids) ? [...new Set(ctx.body.keyword_ids.map(String))] : [];
  const keywordRows = await all(ctx.db, 'keywords');
  const localKeywords = new Map(keywordRows.map(row => [normalizeOpenAlexKeywordId(row.keyword_id || row.id), row]));
  const resolvedKeywords = await Promise.all(requestedValues.map(async keywordId => {
    const normalizedId = normalizeOpenAlexKeywordId(keywordId);
    const local = localKeywords.get(normalizedId);
    if (local) return { keywordId: normalizedId, normalizedId, keyword: local };
    const cached = await ctx.db.get('openalex_keywords', normalizedId) || await ctx.db.get('openalex_keywords', normalizedId.toUpperCase());
    return cached?.data ? { keywordId: normalizedId, normalizedId, keyword: cached.data } : null;
  }));
  const validKeywords = resolvedKeywords.filter(Boolean);
  const values = [...new Set(validKeywords.map(row => row.keywordId))];
  if (replace) {
    const prior = await find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.params.projectId), { limit: Infinity });
    await ctx.db.batchDelete('project_keywords', prior.map(row => row.id));
  } else {
    const normalizedValues = new Set(values.map(normalizeOpenAlexKeywordId));
    const existing = await find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.params.projectId) && normalizedValues.has(normalizeOpenAlexKeywordId(row.keyword_id)), { limit: Infinity });
    if (existing.length) throw new HttpError(400, 'Some keywords are already watched', 'ERROR_KEYWORDS_ALREADY_WATCHED');
  }
  const docs = validKeywords.map(({ keywordId, keyword }) => {
    return { id: `${ctx.params.projectId}_${keywordId}`, data: { project_id: String(ctx.params.projectId), keyword_id: keywordId, keyword: keyword?.display_name || keyword?.name || keyword?.keyword || keywordId, created_by: userKey(ctx.user), created_at: nowIso() } };
  });
  await ctx.db.batchSet('project_keywords', docs);
  await enqueueProjectKeywordSyncs(ctx.env, ctx.db, ctx.params.projectId, docs.map(row => row.data.keyword_id));
  return replace ? { success: true, code: 'SUCCESS_UPDATE_WATCHED_KEYWORD', message: 'Watched keywords updated successfully' } : { body: { success: true, code: 'SUCCESS_CREATE_WATCHED_KEYWORDS', message: `Added ${docs.length} keyword(s) to watchlist` }, status: 201 };
}

async function unwatchKeyword(ctx) {
  const project = await requireProject(ctx, ctx.params.projectId);
  if (!project._isOwner) throw new HttpError(403, 'Only the project owner can remove watched keywords', 'ERROR_FORBIDDEN_DELETE_WATCHED_KEYWORD');
  const key = `${ctx.params.projectId}_${ctx.params.keywordId}`;
  const existing = await ctx.db.get('project_keywords', key);
  if (!existing) throw new HttpError(404, 'Keyword is not on the project watchlist', 'ERROR_KEYWORD_NOT_FOUND');
  await ctx.db.delete('project_keywords', key);
  return { success: true, code: 'SUCCESS_DELETE_WATCHED_KEYWORD', message: 'Keyword removed from project successfully' };
}

async function trendingKeywords(ctx) {
  await requireProject(ctx, ctx.params.projectId);
  const watched = await find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.params.projectId), { limit: Infinity });
  const keywordIds = new Set(watched.map(row => String(row.keyword_id)));
  const limit = Math.min(100, Math.max(1, Number.parseInt(ctx.query.limit, 10) || 20));
  const requestedSort = ctx.query.sort_by;
  const sortBy = ['count', 'score'].includes(requestedSort) ? requestedSort : 'count';
  const [keywords, links] = await Promise.all([all(ctx.db, 'keywords'), all(ctx.db, 'keyword_articles')]);
  const keywordById = new Map(keywords.map(row => [String(row.keyword_id || row.id), row]));
  const groups = new Map();
  for (const link of links) {
    const key = String(link.keyword_id);
    if (!keywordIds.has(key)) continue;
    const keyword = keywordById.get(key);
    if (!keyword) continue;
    if (!groups.has(key)) groups.set(key, { id: keyword.keyword_id || keyword.id, keyword: keyword.display_name || keyword.name || keyword.keyword, count: 0, score: 0, scoreCount: 0 });
    const group = groups.get(key); const score = Number(link.score || 0);
    group.count++; group.score += score; group.scoreCount++;
  }
  const rows = [...groups.values()].map(row => ({ id: String(row.id), keyword: row.keyword, count: row.count, avg_score: row.scoreCount ? Math.round((row.score / row.scoreCount) * 100) / 100 : 0, total_score: Math.round(row.score * 100) / 100 }));
  rows.sort((a, b) => sortBy === 'score' ? b.avg_score - a.avg_score || b.count - a.count : b.count - a.count || b.avg_score - a.avg_score);
  const result = rows.slice(0, limit);
  return { success: true, message: 'Trending keywords fetched successfully', data: { total: result.length, ...(result.length ? { sort_by: sortBy } : {}), keywords: result } };
}

async function watchedArticles(ctx) {
  const project = await requireProject(ctx, ctx.params.projectId);
  const keywordRows = await find(ctx.db, 'project_keywords', row => String(row.project_id) === String(ctx.params.projectId), { limit: Infinity });
  const queries = await projectOpenAlexQueries(ctx, project, keywordRows);
  const page = Math.max(1, Number.parseInt(ctx.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(ctx.query.limit, 10) || 10));
  const select = 'id,doi,display_name,publication_year,publication_date,type,authorships,primary_location,locations,referenced_works,referenced_works_count,cited_by_count,primary_topic,topics,keywords,open_access,biblio,created_date,updated_date,ids,abstract_inverted_index,language';
  const results = await Promise.all(queries.map(query => openAlexRequest(ctx, 'works', {
    ...query, page, per_page: Math.min(100, limit), select, sort: 'publication_date:desc',
  })));
  const byId = new Map();
  results.forEach((result, queryIndex) => {
    const matchedKeyword = keywordRows[queryIndex]?.keyword || keywordRows[queryIndex]?.keyword_id;
    for (const work of result.results || []) {
      const article = openAlexWorkToLegacy(work);
      const key = String(article.openalex_id || article.doi || article.article_id || article.title);
      if (!key) continue;
      const existing = byId.get(key) || { ...article, matched_keywords: [], matched_areas: [], journal_name: article.journal_name || null };
      if (matchedKeyword && !existing.matched_keywords.includes(String(matchedKeyword))) existing.matched_keywords.push(String(matchedKeyword));
      byId.set(key, existing);
    }
  });
  const data = [...byId.values()].sort((a, b) => Number(b.publication_year || 0) - Number(a.publication_year || 0) || String(b.publication_date || '').localeCompare(String(a.publication_date || ''))).slice(0, limit);
  const total = results.reduce((sum, result) => sum + Number(result.meta?.count || 0), 0);
  return { success: true, message: 'Watched keyword articles fetched directly from OpenAlex', data, pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }, source: 'openalex' };
}

const groupYears = (rows, field = null) => Object.entries(rows.reduce((acc, row) => { const year = row.publication_year || row.year || 'unknown'; acc[year] = (acc[year] || 0) + (field ? Number(row[field] || 0) : 1); return acc; }, {})).map(([year, count]) => ({ year: Number(year) || year, count })).sort((a, b) => Number(a.year) - Number(b.year));

export const projectRoutes = defineRoutes([
  { method: 'GET', path: '/projects', auth: true, handler: projectList },
  { method: 'POST', path: '/projects', auth: true, handler: createProject },
  { method: 'GET', path: '/projects/project-invite/accept', auth: false, handler: acceptInvite },
  { method: 'GET', path: '/projects/:projectId/members', auth: true, handler: members },
  { method: 'POST', path: '/projects/:projectId/members/invite', auth: true, handler: invite },
  { method: 'PUT', path: '/projects/:projectId/members/:userId/role', auth: true, handler: updateMember },
  { method: 'DELETE', path: '/projects/:projectId/members/:userId', auth: true, handler: removeMember },
  { method: 'GET', path: '/projects/:projectId/keywords/trending', auth: true, handler: trendingKeywords },
  { method: 'GET', path: '/projects/:projectId/keywords/watch/articles', auth: true, handler: watchedArticles },
  { method: 'POST', path: '/projects/:projectId/keywords/watch', auth: true, handler: ctx => watchKeywords(ctx) },
  { method: 'PUT', path: '/projects/:projectId/keywords/watch', auth: true, handler: ctx => watchKeywords(ctx, true) },
  { method: 'DELETE', path: '/projects/:projectId/keywords/watch/:keywordId', auth: true, handler: unwatchKeyword },
  { method: 'GET', path: '/projects/:id/related-articles', auth: true, handler: projectArticles },
  { method: 'POST', path: '/projects/:projectId/openalex-sync', auth: true, handler: async ctx => {
    await requireProject(ctx, ctx.params.projectId);
    const keywordIds = await projectKeywordIds(ctx, ctx.params.projectId);
    const result = await enqueueProjectKeywordSyncs(ctx.env, ctx.db, ctx.params.projectId, keywordIds);
    return { body: { success: true, data: { ...result, sync: await projectOpenAlexSyncStatus(ctx.db, ctx.params.projectId, keywordIds) } }, status: 202 };
  } },
  { method: 'GET', path: '/projects/:projectId/openalex-sync', auth: true, handler: async ctx => {
    await requireProject(ctx, ctx.params.projectId);
    const keywordIds = await projectKeywordIds(ctx, ctx.params.projectId);
    return ok(await projectOpenAlexSyncStatus(ctx.db, ctx.params.projectId, keywordIds), 'OpenAlex project sync status fetched');
  } },
  { method: 'GET', path: '/projects/:id/overview', auth: true, handler: projectOverview },
  { method: 'GET', path: '/projects/:id/analytics', auth: true, handler: projectAnalytics },
  { method: 'PUT', path: '/projects/:id/restore', auth: true, handler: restoreProject },
  { method: 'PUT', path: '/projects/:id/activate', auth: true, handler: activateProject },
  { method: 'GET', path: '/projects/:id', auth: true, handler: getProject },
  { method: 'PUT', path: '/projects/:id', auth: true, handler: updateProject },
  { method: 'DELETE', path: '/projects/:id', auth: true, handler: removeProject },
  { method: 'GET', path: '/projects/:projectId/keywords', auth: true, handler: listProjectKeywords },
  { method: 'GET', path: '/keywords/project/:id/trending', auth: true, handler: ctx => { ctx.params.projectId = ctx.params.id; return trendingKeywords(ctx); } },
  { method: 'GET', path: '/keywords/project/:id/watch/articles', auth: true, handler: ctx => { ctx.params.projectId = ctx.params.id; return watchedArticles(ctx); } },
  { method: 'POST', path: '/keywords/project/:id/watch', auth: true, handler: ctx => { ctx.params.projectId = ctx.params.id; return watchKeywords(ctx); } },
  { method: 'PUT', path: '/keywords/project/:id/watch', auth: true, handler: ctx => { ctx.params.projectId = ctx.params.id; return watchKeywords(ctx, true); } },
  { method: 'DELETE', path: '/keywords/project/:id/watch/:keywordId', auth: true, handler: ctx => { ctx.params.projectId = ctx.params.id; return unwatchKeyword(ctx); } },
]);









