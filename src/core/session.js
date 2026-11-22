import { HttpError, requestToken } from './http.js';
import { verifyJwt } from './jwt.js';
import { byId, find } from '../firestore/repository.js';

let firebaseKeys;
let firebaseKeysExpires = 0;

async function verifyFirebaseIdToken(token, env) {
  const projectId = env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error('Firebase project is not configured');
  const [, payloadPart, signaturePart] = token.split('.');
  const [headerPart] = token.split('.');
  const decode = value => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0))));
  const header = decode(headerPart);
  const claims = decode(payloadPart);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported Firebase token');
  if (!firebaseKeys || Date.now() > firebaseKeysExpires) {
    const response = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    if (!response.ok) throw new Error('Could not load Firebase signing keys');
    firebaseKeys = await response.json();
    firebaseKeysExpires = Date.now() + 60 * 60 * 1000;
  }
  const jwk = firebaseKeys.keys.find(key => key.kid === header.kid);
  if (!jwk) throw new Error('Unknown Firebase signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(atob(signaturePart.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - signaturePart.length % 4) % 4)), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${headerPart}.${payloadPart}`));
  const now = Math.floor(Date.now() / 1000);
  if (!valid || claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}` || !claims.sub || claims.exp <= now || claims.iat > now || claims.auth_time > now) throw new Error('Invalid Firebase token');
  return { ...claims, user_id: claims.user_id || claims.sub, role: claims.role || 'STUDENT', firebase: true };
}

export async function decodeSession(token, env) {
  if (!token) throw new HttpError(401, 'Authentication required', 'UNAUTHORIZED');
  try {
    const [headerPart] = token.split('.');
    const header = JSON.parse(atob(headerPart.replace(/-/g, '+').replace(/_/g, '/')));
    if (header.alg === 'HS256') return await verifyJwt(token, env.JWT_SECRET || env.JWT_ACCESS_SECRET);
    if (header.alg === 'RS256') return await verifyFirebaseIdToken(token, env);
  } catch (error) {
    if (error instanceof HttpError) throw error;
  }
  throw new HttpError(401, 'Invalid or expired token', 'UNAUTHORIZED');
}

export async function authenticate(request, env, db, adminOnly = false) {
  const claims = await decodeSession(requestToken(request), env);
  const userId = claims.user_id || claims.uid || claims.sub;
  let user = await byId(db, 'users', userId);
  if (!user && claims.firebase) {
    const matches = await find(db, 'users', row => String(row.email || '').toLowerCase() === String(claims.email || '').toLowerCase(), { limit: 1 });
    user = matches[0] || { id: userId, user_id: userId, email: claims.email, role: claims.role || 'STUDENT', status: 'ACTIVE' };
    if (!matches.length) await db.set('users', userId, { ...user, firebase_uid: userId, created_at: new Date().toISOString() });
  }
  user ||= { ...claims, id: userId, user_id: userId, role: claims.role || 'STUDENT', status: 'ACTIVE' };
  if (['BLOCKED', 'INACTIVE', 'DELETED'].includes(String(user.status || '').toUpperCase())) throw new HttpError(403, 'Account is inactive', 'ACCOUNT_INACTIVE');
  const role = String(user.role || claims.role || '').toUpperCase();
  if (adminOnly && !['ADMIN', 'ADMINISTRATOR', 'SUPER_ADMIN'].includes(role)) throw new HttpError(403, 'Administrator access required', 'FORBIDDEN');
  return { ...claims, ...user, user_id: user.user_id || user.id || userId, role };
}
