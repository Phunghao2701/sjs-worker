const encoder = new TextEncoder();

const encodeBase64Url = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};

const decodeBase64Url = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
};

const decodeJsonPart = (value) => JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));

export async function signJwt(payload, secret, expiresInSeconds = 3600) {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = encodeBase64Url(encoder.encode(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSeconds })));
  const input = `${header}.${body}`;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input)));
  return `${input}.${encodeBase64Url(signature)}`;
}

export async function verifyJwt(token, secret) {
  if (!secret || typeof token !== 'string') throw new Error('Invalid token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const header = decodeJsonPart(parts[0]);
  if (header.alg !== 'HS256') throw new Error('Unsupported token algorithm');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, decodeBase64Url(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error('Invalid token signature');
  const payload = decodeJsonPart(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) throw new Error('Token expired');
  if (payload.nbf && now < payload.nbf) throw new Error('Token not active');
  return payload;
}
