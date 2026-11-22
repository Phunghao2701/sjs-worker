import { HttpError, handleError, json, readJson } from './http.js';
import { authenticate } from './session.js';

const compile = (path) => {
  const keys = [];
  const source = path.split('/').map(part => {
    if (part.startsWith(':')) { keys.push(part.slice(1)); return '([^/]+)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { keys, regex: new RegExp(`^${source}/?$`) };
};

export const defineRoutes = (definitions) => definitions
  .map(route => ({ ...route, ...compile(route.path) }))
  .sort((a, b) => b.path.split('/').filter(part => !part.startsWith(':')).length - a.path.split('/').filter(part => !part.startsWith(':')).length);

export async function dispatch(request, env, db, routes) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env, request) });
  const originalPath = url.pathname.replace(/\/{2,}/g, '/');
  const path = originalPath === '/api/v1' ? '/' : originalPath.startsWith('/api/v1/') ? originalPath.slice(7) : originalPath;
  const route = routes.find(item => item.method === request.method && item.regex.test(path));
  if (!route) return json({ success: false, code: 'NOT_FOUND', message: 'Route not found' }, 404, corsHeaders(env, request));

  const match = path.match(route.regex);
  const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
  const query = Object.fromEntries(url.searchParams.entries());
  for (const [key, value] of Object.entries(query)) {
    if (value === 'undefined' || value === 'null') delete query[key];
  }
  let body = {};
  if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('content-length') !== '0' && request.headers.get('content-type')?.includes('application/json')) body = await readJson(request);
  const user = route.auth ? await authenticate(request, env, db, route.admin) : null;
  const context = { request, env, db, url, path, originalPath, params, query, body, user, route };
  const response = await route.handler(context);
  if (response instanceof Response) return withCors(response, env, request);
  return json(response?.body ?? response ?? {}, response?.status || 200, { ...corsHeaders(env, request), ...(response?.headers || {}) });
}

export const ok = (data, message = 'Success', code = 200, extra = {}) => ({ success: true, code, message, ...(data === undefined ? {} : { data }), ...extra });
export const fail = (status, code, message, details) => { throw new HttpError(status, message, code, details); };

export const corsHeaders = (env, request) => {
  const configured = [env.CORS_ORIGINS, env.CORS_ORIGIN, env.FRONTEND_URL, env.FRONTEND_URL_TRENDING]
    .filter(Boolean)
    .flatMap(value => {
      let cleaned = String(value).trim();
      if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) cleaned = cleaned.slice(1, -1).trim();
      if (cleaned.startsWith('[') && cleaned.endsWith(']')) cleaned = cleaned.slice(1, -1).trim();
      return cleaned.split(',').map(origin => origin.trim().replace(/^['"]|['"]$/g, '').replace(/\/+$/, '')).filter(Boolean);
    });
  const origins = new Set(['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175']);
  for (const origin of configured) {
    origins.add(origin);
    try {
      const parsed = new URL(origin);
      if (parsed.hostname.startsWith('www.')) origins.add(`${parsed.protocol}//${parsed.hostname.slice(4)}${parsed.port ? `:${parsed.port}` : ''}`);
      else if (!parsed.hostname.includes('localhost') && !/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) origins.add(`${parsed.protocol}//www.${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`);
    } catch { /* Ignore malformed origin entries. */ }
  }
  const wildcard = origins.has('*');
  const requestOrigin = request?.headers.get('origin')?.replace(/\/$/, '');
  const allowed = wildcard || (requestOrigin && origins.has(requestOrigin));
  const headers = {
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-requested-with, x-refresh-token',
  };
  if (wildcard) headers['access-control-allow-origin'] = '*';
  else if (allowed) {
    headers['access-control-allow-origin'] = requestOrigin;
    headers['access-control-allow-credentials'] = 'true';
    headers.vary = 'Origin';
  } else if (requestOrigin) headers.vary = 'Origin';
  return headers;
};

export const withCors = (response, env, request) => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(env, request))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

export const handleRequestError = (error) => handleError(error);
