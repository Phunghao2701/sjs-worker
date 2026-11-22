import { FirestoreClient } from './firestore/client.js';
import { corsHeaders, defineRoutes, dispatch, handleRequestError, ok, withCors } from './core/router.js';
import { HttpError, json } from './core/http.js';
import { authRoute } from './features/auth.js';
import { recordRoutes } from './features/records.js';
import { projectRoutes } from './features/projects.js';
import { accountBillingRoutes } from './features/accounts-billing.js';
import { researchRoutes } from './features/research.js';
import { chatRoutes } from './features/chat.js';
import { openAlexAdminRoutes } from './features/openalex-admin.js';
import { scimagoImportRoutes } from './features/scimago-import.js';
import { id, nowIso } from './firestore/repository.js';
import { processAnalyticsJob } from './features/research.js';
import { ChatRateLimiter } from './core/chat-rate-limiter.js';
import { ChatResultCache } from './core/chat-result-cache.js';
import { enqueueScheduledOpenAlexSyncs, processOpenAlexProjectSync } from './openalex/project-sync.js';

export { ChatRateLimiter, ChatResultCache };

let swaggerSpec;
const baseRoutes = [
  { method: 'GET', path: '/api-docs.json', handler: async () => swaggerSpec },
  { method: 'GET', path: '/api-docs', handler: async () => new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Scientific Journal System API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'/api-docs.json',dom_id:'#swagger-ui'});</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
  { method: 'GET', path: '/', handler: async () => ok({ service: 'Scientific Journal System API', runtime: 'cloudflare-workers', database: 'firestore' }, 'Worker API is running') },
  { method: 'GET', path: '/health', handler: async () => ({ success: true, status: 'ok', runtime: 'cloudflare-workers' }) },
  { method: 'GET', path: '/debug-auth', handler: async ctx => {
    if (ctx.env.NODE_ENV !== 'development') return { body: { success: false, code: 'NOT_FOUND', message: 'Route not found' }, status: 404 };
    const cookie = ctx.request.headers.get('cookie') || '';
    return ok({
      headerNames: [...ctx.request.headers.keys()],
      hasAuthorization: Boolean(ctx.request.headers.get('authorization')),
      hasCookies: Boolean(cookie),
      cookieNames: cookie.split(';').map(part => part.trim().split('=')[0]).filter(Boolean),
    }, 'Auth request diagnostics');
  } },
  ...['login','register','forgot-password','reset-password','verify','refresh','check-auth','logout','google','sso/session'].flatMap(name => name === 'refresh' ? ['GET','POST'].map(method => ({ method, path: `/auth/${name}`, handler: authRoute })) : [{ method: name === 'verify' || name === 'check-auth' ? 'GET' : 'POST', path: `/auth/${name}`, handler: authRoute }]),
  { method: 'POST', path: '/analytics/jobs', auth: true, handler: async ctx => {
    const jobId = id();
    const jobType = ctx.body.job_type || ctx.body.type || 'analytics-refresh';
    if (!['network-analysis','topology-analysis','collab-insights','impact-matrix','rankings','keyword-vectors','analytics-refresh'].includes(jobType)) throw new HttpError(400, `Unsupported analytics job type: ${jobType}`, 'UNSUPPORTED_ANALYTICS_JOB');
    const query = ctx.body.query || ctx.body.params || {};
    const job = { id: jobId, job_id: jobId, job_type: jobType, type: jobType, status: 'PENDING', progress: 0, requested_by: ctx.user.user_id, query, params: query, created_at: nowIso() };
    await ctx.db.create('analytics_jobs', jobId, job);
    if (ctx.env.ANALYTICS_QUEUE) await ctx.env.ANALYTICS_QUEUE.send({ job_id: jobId, type: jobType, query });
    else await ctx.db.merge('analytics_jobs', jobId, { status: 'ERROR', error: 'Queue binding is not configured', completed_at: nowIso() });
    return { body: { success: true, data: job }, status: 202 };
  } },
];

const routes = defineRoutes([...baseRoutes, ...recordRoutes, ...projectRoutes, ...accountBillingRoutes, ...researchRoutes, ...chatRoutes, ...openAlexAdminRoutes, ...scimagoImportRoutes]);
const openApiPaths = {};
for (const route of routes) {
  if (route.path.startsWith('/api-docs')) continue;
  const path = route.path.replace(/:([^/]+)/g, '{$1}');
  for (const documentedPath of new Set([path, path === '/' ? '/api/v1' : `/api/v1${path}`])) {
    openApiPaths[documentedPath] ||= {};
    const operation = {
      summary: `${route.method} ${documentedPath}`,
      responses: { '200': { description: 'Successful response' }, '4XX': { description: 'Request error' } },
      ...(route.auth ? { security: [{ bearerAuth: [] }] } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(route.method) ? { requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } } : {}),
    };
    openApiPaths[documentedPath][route.method.toLowerCase()] = operation;
  }
}
swaggerSpec = {
  openapi: '3.0.0',
  info: { title: 'Scientific Journal System API', version: '1.0.0' },
  servers: [{ url: '/' }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  paths: openApiPaths,
};

async function handleFetch(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env, request) });
  if (['/', '/health', '/api/v1', '/api/v1/', '/api/v1/health'].includes(url.pathname)) {
    const payload = url.pathname.includes('health') ? { success: true, status: 'ok', runtime: 'cloudflare-workers' } : { success: true, code: 200, message: 'Worker API is running', data: { service: 'Scientific Journal System API', runtime: 'cloudflare-workers', database: 'firestore' } };
    return withCors(json(payload, 200), env, request);
  }
  try {
    const db = new FirestoreClient(env);
    const response = await dispatch(request, env, db, routes);
    const routePath = url.pathname.replace(/^\/api\/v1/, '') || '/';
    const isScimagoImportRoute = /^\/admin\/imports\/scimago(?:\/|$)/.test(routePath);
    if (!isScimagoImportRoute && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const actor = response.status < 400 ? 'request' : 'failed request';
      try {
        await db.create('logs', id(), { action: request.method, entity: routePath.split('/').filter(Boolean)[0] || 'system', message: `${actor}: ${request.method} ${routePath}`, metadata: { status: response.status }, created_at: nowIso() });
      } catch (error) { console.warn('[audit] could not persist request log', error.message); }
    }
    return response;
  } catch (error) {
    return withCors(handleRequestError(error), env, request);
  }
}

async function handleQueue(batch, env) {
  const db = new FirestoreClient(env);
  for (const message of batch.messages) {
    if (message.body?.type === 'openalex-project-sync') {
      try {
        await processOpenAlexProjectSync(db, env, message.body, env.OPENALEX_SYNC_QUEUE || env.ANALYTICS_QUEUE);
        message.ack();
      } catch (error) {
        console.error('[openalex sync queue] job failed', message.body?.project_id, message.body?.keyword_id, error);
        message.retry();
      }
      continue;
    }
    const jobId = message.body?.job_id;
    try {
      if (!jobId) throw new Error('Queue message is missing job_id');
      await db.merge('analytics_jobs', jobId, { status: 'PROCESSING', progress: 0, started_at: nowIso(), error: null });
      const result = await processAnalyticsJob(db, message.body.type || message.body.job_type, message.body.query || message.body.params || {});
      await db.merge('analytics_jobs', jobId, { status: 'COMPLETED', progress: 100, result, completed_at: nowIso(), error: null });
      message.ack();
    } catch (error) {
      console.error('[analytics queue] job failed', jobId, error);
      if (jobId) await db.merge('analytics_jobs', jobId, { status: 'ERROR', error: error.message, completed_at: nowIso() }).catch(() => {});
      message.retry();
    }
  }
}

async function handleScheduled(_event, env) {
  const db = new FirestoreClient(env);
  const queued = await enqueueScheduledOpenAlexSyncs(env, db);
  console.info('[openalex sync schedule] queued project keyword syncs', queued);
}

export default { fetch: handleFetch, queue: handleQueue, scheduled: handleScheduled };
