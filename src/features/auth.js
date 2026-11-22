import bcrypt from 'bcryptjs';
import { HttpError, json, requestToken, setCookie } from '../core/http.js';
import { signJwt } from '../core/jwt.js';
import { all, byId, collectionFor, find, id, nowIso } from '../firestore/repository.js';
import { decodeSession } from '../core/session.js';

const publicUser = user => {
  if (!user) return null;
  const { password, password_hash, ...safe } = user;
  return safe;
};
const durationSeconds = (value, fallback) => {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (!match) return fallback;
  const scale = { s: 1, m: 60, h: 3600, d: 86400 }[match[2].toLowerCase()];
  return Math.max(1, Math.floor(Number(match[1]) * scale));
};
const tokenPair = async (user, env) => ({
  token: await signJwt({ user_id: String(user.user_id || user.id), role: user.role, email: user.email }, env.JWT_SECRET || env.JWT_ACCESS_SECRET, Number(env.JWT_ACCESS_TTL_SECONDS) || durationSeconds(env.JWT_EXPIRES_IN, 3600)),
  refreshToken: await signJwt({ user_id: String(user.user_id || user.id) }, env.JWT_REFRESH_SECRET || 'secret_refresh', Number(env.JWT_REFRESH_TTL_SECONDS) || durationSeconds(env.JWT_REFRESH_EXPIRES_IN, 2592000)),
});
const responseWithCookies = (data, pair, env, status = 200, clear = false, remember = true) => {
  const secure = env.COOKIE_SECURE !== 'false';
  const configuredDomain = String(env.COOKIE_DOMAIN || '').trim();
  const domain = ['localhost', '127.0.0.1'].includes(configuredDomain.toLowerCase()) ? undefined : configuredDomain || undefined;
  const accessMaxAge = Number(env.COOKIE_ACCESS_MAX_AGE_SECONDS) || Math.floor((Number(env.COOKIE_ACCESS_MAX_AGE) || 3600000) / 1000);
  const refreshMaxAge = Number(env.COOKIE_REFRESH_MAX_AGE_SECONDS) || Math.floor((Number(env.COOKIE_REFRESH_MAX_AGE) || 2592000000) / 1000);
  const opts = { secure, sameSite: env.COOKIE_SAMESITE || (secure ? 'None' : 'Lax'), maxAge: clear ? 0 : accessMaxAge, domain };
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  headers.append('set-cookie', setCookie('access_token', clear ? '' : pair?.token || '', opts));
  headers.append('set-cookie', setCookie('refresh_token', clear ? '' : pair?.refreshToken || '', { ...opts, maxAge: clear ? 0 : remember ? refreshMaxAge : null }));
  return new Response(JSON.stringify(data), { status, headers });
};
const requireSecret = env => { if (!env.JWT_SECRET && !env.JWT_ACCESS_SECRET) throw new HttpError(500, 'JWT_SECRET is not configured', 'AUTH_CONFIG_MISSING'); };

export async function authRoute(ctx) {
  const { db, env, request, body, query, path } = ctx;
  const route = path.replace(/^\/api\/v1/, '').replace(/^\//, '');
  if (route === 'auth/register' && request.method === 'POST') {
    requireSecret(env);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const validDate = body.date_of_birth === undefined || /^\d{4}-\d{2}-\d{2}$/.test(String(body.date_of_birth)) && !Number.isNaN(Date.parse(`${body.date_of_birth}T00:00:00Z`));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 6 || typeof body.first_name !== 'string' || typeof body.last_name !== 'string' || body.gender !== undefined && typeof body.gender !== 'boolean' || !validDate || body.role !== undefined && typeof body.role !== 'string') throw new HttpError(400, 'Registration data is invalid', 'VALIDATION_ERROR');
    if ((await find(db, 'users', row => String(row.email || '').toLowerCase() === email, { limit: 1 })).length) throw new HttpError(409, 'Email already registered', 'EMAIL_EXISTS');
    const userId = id();
    const user = { id: userId, user_id: userId, email, password: await bcrypt.hash(password, 10), first_name: body.first_name || '', last_name: body.last_name || '', date_of_birth: body.date_of_birth || null, gender: body.gender ?? null, role: body.role || 'STUDENT', status: 'INACTIVE', email_verified: false, created_at: nowIso() };
    await db.create(collectionFor('users'), userId, user);
    const activationToken = await signJwt({ user_id: userId, email }, env.JWT_SECRET || env.JWT_ACCESS_SECRET, 86400);
    const activationUrl = `${env.FRONTEND_URL || ''}/verify?token=${encodeURIComponent(activationToken)}`;
    let sent = false;
    try { sent = await sendEmail(env, { to: email, template: 'account-activation', token: activationToken, link: activationUrl, first_name: user.first_name }); }
    catch (error) { console.warn('[auth] activation email could not be sent', error.message); }
    return { body: { success: true, message: 'Đăng ký thành công', data: { user_id: userId, email, first_name: user.first_name, last_name: user.last_name, ...(sent || env.NODE_ENV === 'production' ? {} : { activation_token: activationToken }) } }, status: 201 };
  }
  if (route === 'auth/login' && request.method === 'POST') {
    requireSecret(env);
    const email = String(body.email || '').trim().toLowerCase();
    const users = await find(db, 'users', row => String(row.email || '').toLowerCase() === email, { limit: 1 });
    const user = users[0];
    const hash = user?.password || user?.password_hash;
    if (!user || !hash || !await bcrypt.compare(String(body.password || ''), hash)) throw new HttpError(401, 'Email or password is incorrect', 'INVALID_CREDENTIALS');
    if (user.status !== 'ACTIVE') throw new HttpError(401, 'Account is inactive', 'ACCOUNT_INACTIVE');
    const pair = await tokenPair(user, env);
    return responseWithCookies({ success: true, message: 'Login successful', data: { token: pair.token, refresh_token: pair.refreshToken, remember: Boolean(body.remember), user: { user_id: user.user_id || user.id, email: user.email, role: user.role, status: user.status } } }, pair, env, 200, false, Boolean(body.remember));
  }
  if (route === 'auth/sso/session' && request.method === 'POST') {
    requireSecret(env);
    const accessToken = body.accessToken;
    if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 8192) throw new HttpError(401, 'SSO identity could not be verified', 'SSO_IDENTITY_REJECTED');
    let providerUrl;
    try { providerUrl = new URL(env.HYPERDATALAB_SSO_BASE_URL); } catch { throw new HttpError(503, 'SSO provider is not configured', 'SSO_PROVIDER_NOT_CONFIGURED'); }
    if (providerUrl.protocol !== 'https:' && !(['localhost', '127.0.0.1', '[::1]'].includes(providerUrl.hostname) && providerUrl.protocol === 'http:')) throw new HttpError(503, 'SSO provider is not configured', 'SSO_PROVIDER_NOT_CONFIGURED');
    let profileResponse;
    try { profileResponse = await fetch(new URL('/oauth/userinfo', providerUrl), { headers: { authorization: `Bearer ${accessToken}` } }); }
    catch { throw new HttpError(503, 'SSO provider is unavailable', 'SSO_PROVIDER_UNAVAILABLE'); }
    if (profileResponse.status === 401 || profileResponse.status === 403) throw new HttpError(401, 'SSO identity could not be verified', 'SSO_IDENTITY_REJECTED');
    if (!profileResponse.ok) throw new HttpError(503, 'SSO provider is unavailable', 'SSO_PROVIDER_UNAVAILABLE');
    const profile = await profileResponse.json().catch(() => null);
    if (!profile || typeof profile.sub !== 'string' || !profile.sub.trim() || profile.sub.length > 512 || typeof profile.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email) || profile.email_verified !== true) throw new HttpError(403, 'SSO profile is incomplete', 'SSO_PROFILE_INCOMPLETE');
    const subject = profile.sub.trim();
    const email = profile.email.trim().toLowerCase();
    const matches = await find(db, 'users', row => row.sso_sub === subject || String(row.email || '').toLowerCase() === email, { limit: 1 });
    let user = matches[0];
    if (user?.sso_sub && user.sso_sub !== subject) throw new HttpError(409, 'This email is linked to another SSO identity', 'SSO_IDENTITY_CONFLICT');
    if (user && ['BLOCKED', 'INACTIVE', 'DELETED'].includes(String(user.status || '').toUpperCase())) throw new HttpError(403, 'Account is inactive', 'ACCOUNT_INACTIVE');
    if (!user) {
      const userId = id();
      const name = typeof profile.name === 'string' ? profile.name.trim().slice(0, 256) : '';
      const nameParts = name.split(/\s+/).filter(Boolean);
      user = { id: userId, user_id: userId, sso_sub: subject, email, first_name: nameParts[0] || '', last_name: nameParts.slice(1).join(' '), display_name: name || email, role: 'STUDENT', status: 'ACTIVE', email_verified: true, type: 'SSO', created_at: nowIso() };
      await db.create(collectionFor('users'), userId, user);
    } else if (!user.sso_sub) {
      user = { ...user, sso_sub: subject, email_verified: true, updated_at: nowIso() };
      await db.set(collectionFor('users'), user.id || user.user_id, user);
    }
    const pair = await tokenPair(user, env);
    const safeUser = { user_id: user.user_id || user.id, email: user.email, role: user.role || 'STUDENT', status: user.status || 'ACTIVE', first_name: user.first_name || '', last_name: user.last_name || '', display_name: user.display_name || '' };
    return responseWithCookies({ success: true, message: 'SSO login successful', data: { token: pair.token, refresh_token: pair.refreshToken, remember: false, user: safeUser } }, pair, env, 200, false, false);
  }
  if (route === 'auth/check-auth' && request.method === 'GET') {
    const claims = await decodeSession(requestToken(request), env);
    return { success: true, authenticated: true, user: claims };
  }
  if (route === 'auth/refresh' && ['GET', 'POST'].includes(request.method)) {
    requireSecret(env);
    const refresh = body.refreshToken || body.refresh_token || request.headers.get('x-refresh-token') || cookie(request, 'refresh_token') || query.refresh_token;
    const claims = await decodeSession(refresh, { ...env, JWT_SECRET: env.JWT_REFRESH_SECRET || 'secret_refresh' });
    const user = await byId(db, 'users', claims.user_id || claims.uid || claims.sub);
    if (!user) throw new HttpError(401, 'User no longer exists', 'UNAUTHORIZED');
    if (user.status !== 'ACTIVE') throw new HttpError(401, 'Account is inactive', 'ACCOUNT_INACTIVE');
    const pair = await tokenPair(user, env);
    return responseWithCookies({ success: true, message: 'Access token refreshed successfully', data: { token: pair.token, refresh_token: pair.refreshToken, user: { user_id: user.user_id || user.id, email: user.email, role: user.role, status: user.status } } }, pair, env);
  }
  if (route === 'auth/logout' && request.method === 'POST') return responseWithCookies({ success: true, message: 'Logged out successfully' }, null, env, 200, true);
  if (route === 'auth/google' && request.method === 'POST') return googleLogin(ctx);
  if (route === 'auth/verify' && request.method === 'GET') return verifyEmail(ctx, query);
  if (route === 'auth/forgot-password' && request.method === 'POST') return forgotPassword(ctx);
  if (route === 'auth/reset-password' && request.method === 'POST') return resetPassword(ctx);
  return null;
}

function cookie(request, key) {
  const item = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${key}=`));
  return item ? decodeURIComponent(item.slice(key.length + 1)) : null;
}

async function sendEmail(env, payload) {
  if (!env.EMAIL_API_URL) return false;
  const response = await fetch(env.EMAIL_API_URL, { method: 'POST', headers: { 'content-type': 'application/json', ...(env.EMAIL_API_KEY ? { authorization: `Bearer ${env.EMAIL_API_KEY}` } : {}) }, body: JSON.stringify(payload) });
  if (!response.ok) throw new HttpError(502, 'Could not send email', 'EMAIL_SEND_FAILED');
  return true;
}

async function forgotPassword({ db, body, env }) {
  const email = String(body.email || '').toLowerCase();
  const users = await find(db, 'users', row => String(row.email || '').toLowerCase() === email, { limit: 1 });
  if (!users.length) return { success: true, message: 'If this account exists, a reset link has been sent.' };
  if (users[0].type && users[0].type !== 'LOCAL') throw new HttpError(403, 'This account does not support email password reset', 'PASSWORD_RESET_UNSUPPORTED');
  const token = randomToken(); const tokenHash = await hashToken(token);
  await db.set('password_reset_tokens', tokenHash, { id: tokenHash, token_hash: tokenHash, user_id: users[0].user_id || users[0].id, expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), used_at: null });
  let sent = false;
  try { sent = await sendEmail(env, { to: email, template: 'password-reset', token }); }
  catch (error) { throw new HttpError(502, 'Could not send password reset email', 'EMAIL_SEND_FAILED'); }
  return { success: true, message: 'If this account exists, a reset link has been sent.', ...(sent || env.NODE_ENV === 'production' ? {} : { data: { token } }) };
}

async function resetPassword({ db, body }) {
  if (!body.new_password || String(body.new_password).length < 6) throw new HttpError(400, 'New password must contain at least 6 characters', 'VALIDATION_ERROR');
  const tokenHash = await hashToken(String(body.token || ''));
  const row = await db.get('password_reset_tokens', tokenHash) || (await find(db, 'password_reset_tokens', item => String(item.token_hash || '') === tokenHash, { limit: 1 }))[0];
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) throw new HttpError(400, 'Reset token is invalid or expired', 'RESET_TOKEN_INVALID');
  const user = await byId(db, 'users', row.user_id);
  if (!user) throw new HttpError(400, 'Reset token is invalid', 'RESET_TOKEN_INVALID');
  const tokenKey = row.id || tokenHash;
  const userKey = user.id || user.user_id;
  const passwordHash = await bcrypt.hash(String(body.new_password), 10);
  const transaction = await db.beginTransaction();
  try {
    const currentToken = await db.get('password_reset_tokens', tokenKey, transaction);
    const currentUser = await db.get(collectionFor('users'), userKey, transaction);
    if (!currentToken || currentToken.token_hash && currentToken.token_hash !== tokenHash || currentToken.used_at || new Date(currentToken.expires_at) <= new Date() || !currentUser) {
      throw new HttpError(400, 'Reset token is invalid or expired', 'RESET_TOKEN_INVALID');
    }
    const { encodeFields } = await import('../firestore/codec.js');
    const userUpdated = { ...currentUser, password: passwordHash, updated_at: nowIso() };
    const tokenUpdated = { ...currentToken, used_at: nowIso() };
    await db.commit([
      { update: { name: db.documentName(collectionFor('users'), userKey), fields: encodeFields(userUpdated), currentDocument: { exists: true } } },
      { update: { name: db.documentName('password_reset_tokens', tokenKey), fields: encodeFields(tokenUpdated), currentDocument: { exists: true } } },
    ], transaction);
  } catch (error) {
    await db.commit([], transaction).catch(() => {});
    throw error;
  }
  return { success: true, message: 'Password reset successful' };
}

async function verifyEmail({ db, env }, query) {
  if (query.token) {
    const claims = await decodeSession(query.token, env);
    const user = await byId(db, 'users', claims.user_id || claims.uid || claims.sub);
    if (!user) throw new HttpError(400, 'Account does not exist', 'VERIFY_TOKEN_INVALID');
    if (String(user.status).toUpperCase() !== 'ACTIVE') await db.merge(collectionFor('users'), user.id || user.user_id, { status: 'ACTIVE', email_verified: true, updated_at: nowIso() });
    return { success: true, message: String(user.status).toUpperCase() === 'ACTIVE' ? 'Account was already activated' : 'Account activated successfully' };
  }
  const token = await db.get('email_verification_tokens', String(query.token || ''));
  if (!token || token.used_at || new Date(token.expires_at) <= new Date()) throw new HttpError(400, 'Verification token is invalid or expired', 'VERIFY_TOKEN_INVALID');
  const user = await byId(db, 'users', token.user_id);
  if (user) await db.merge('users', user.id || user.user_id, { email_verified: true, status: 'ACTIVE' });
  await db.merge('email_verification_tokens', token.id || String(query.token), { used_at: nowIso() });
  return { success: true, message: 'Email verified successfully' };
}

const randomToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
const hashToken = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

async function googleLogin({ db, env, body }) {
  if (!body.code) throw new HttpError(400, 'Authorization code is required', 'MISSING_CODE');
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError(501, 'Google OAuth is not configured', 'GOOGLE_OAUTH_NOT_CONFIGURED');
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: body.code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: 'postmessage', grant_type: 'authorization_code' }) });
  const tokens = await response.json();
  if (!response.ok || !tokens.id_token) throw new HttpError(401, 'Could not verify Google login', 'GOOGLE_LOGIN_FAILED');
  const infoResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`);
  const info = await infoResponse.json();
  if (!infoResponse.ok || info.aud !== env.GOOGLE_CLIENT_ID || !info.email_verified) throw new HttpError(401, 'Google account is invalid', 'GOOGLE_LOGIN_FAILED');
  const users = await find(db, 'users', row => String(row.email || '').toLowerCase() === String(info.email).toLowerCase(), { limit: 1 });
  const isNewUser = !users.length;
  const user = users[0] || { id: id(), email: String(info.email).toLowerCase(), first_name: info.given_name || '', last_name: info.family_name || '', avatar: info.picture || null, role: 'STUDENT', status: 'ACTIVE', email_verified: true };
  if (isNewUser) await db.create('users', user.id, { ...user, user_id: user.id, created_at: nowIso() });
  const pair = await tokenPair(user, env);
  return responseWithCookies({ success: true, code: 'GOOGLE_LOGIN_SUCCESS', message: isNewUser ? 'Registration and login successful' : 'Login successful', data: { token: pair.token, refresh_token: pair.refreshToken, user: publicUser(user), isNewUser } }, pair, env, 200, false, true);
}
