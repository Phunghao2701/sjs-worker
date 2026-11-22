export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
});

export const success = (data, message = 'Success', status = 200, code = status) =>
  json({ success: true, code, message, data }, status);

export const readJson = async (request) => {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body', 'INVALID_JSON');
  }
};

export const requireString = (value, field, { min = 1, max = 10000 } = {}) => {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new HttpError(400, `${field} is invalid`, 'VALIDATION_ERROR');
  }
  return value;
};

export const handleError = (error) => {
  if (error instanceof HttpError) {
    const body = { success: false, code: error.code || 'REQUEST_FAILED', message: error.message };
    if (error.details !== undefined) body.details = error.details;
    return json(body, error.status);
  }
  console.error('[worker] request failed', error);
  return json({ success: false, code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' }, 500);
};

export const getCookie = (request, name) => {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return part.slice(index + 1).trim(); }
    }
  }
  return null;
};

export const requestToken = (request) => {
  const authorization = request.headers.get('authorization') || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
  return getCookie(request, 'access_token');
};

export const setCookie = (name, value, { maxAge = 3600, httpOnly = true, secure = true, sameSite = 'None', path = '/', domain } = {}) => {
  const fields = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, ...(maxAge === null ? [] : [`Max-Age=${maxAge}`]), `SameSite=${sameSite}`];
  if (domain) fields.push(`Domain=${domain}`);
  if (httpOnly) fields.push('HttpOnly');
  if (secure) fields.push('Secure');
  return fields.join('; ');
};
