import { HttpError } from '../core/http.js';
import { appGet, appSet } from '../firestore/app-d1.js';

const settingId = 'openalex_api_key';
const encoder = new TextEncoder();

async function getStoredKeyRecord(db) {
  return appGet({ RANKINGS_DB: db }, 'system_settings', settingId);
}

async function setStoredKeyRecord(db, record) {
  await appSet({ RANKINGS_DB: db }, 'system_settings', settingId, record);
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function encryptionKey(env) {
  const secret = String(env.OPENALEX_CONFIG_ENCRYPTION_KEY || '');
  if (secret.length < 32) {
    throw new HttpError(503, 'OpenAlex key encryption is not configured', 'OPENALEX_ENCRYPTION_NOT_CONFIGURED');
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function readOpenAlexKey(ctx, { fallbackOnDecryptFailure = false } = {}) {
  let stored = null;
  try { stored = await getStoredKeyRecord(ctx.env.RANKINGS_DB); }
  catch (error) {
    const missingAppStore = error?.code === 'APPLICATION_D1_NOT_CONFIGURED' || /no such table:\s*app_documents/i.test(String(error?.message || ''));
    if (!missingAppStore) throw error;
  }
  if (stored?.enabled && stored?.ciphertext && stored?.iv) {
    try {
      const key = await encryptionKey(ctx.env);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(stored.iv) },
        key,
        fromBase64(stored.ciphertext),
      );
      return { value: new TextDecoder().decode(plaintext), source: 'admin', stored };
    } catch (error) {
      if (fallbackOnDecryptFailure && ['OPENALEX_ENCRYPTION_NOT_CONFIGURED', 'OPENALEX_KEY_DECRYPT_FAILED'].includes(error.code)) {
        const environmentKey = String(ctx.env.OPENALEX_API_KEY || '');
        return { value: environmentKey, source: environmentKey ? 'environment' : 'none', stored: null, keyOverrideUnreadable: true };
      }
      if (error.code === 'OPENALEX_ENCRYPTION_NOT_CONFIGURED') {
        throw new HttpError(503, 'Stored OpenAlex key cannot be decrypted', 'OPENALEX_KEY_DECRYPT_FAILED');
      }
      throw new HttpError(503, 'Stored OpenAlex key cannot be decrypted', 'OPENALEX_KEY_DECRYPT_FAILED');
    }
  }
  const environmentKey = String(ctx.env.OPENALEX_API_KEY || '');
  return { value: environmentKey, source: environmentKey ? 'environment' : 'none', stored: null };
}

export async function saveOpenAlexKey(ctx, value) {
  const key = await encryptionKey(ctx.env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value));
  const record = {
    enabled: true,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    last_four: value.slice(-4),
    updated_at: new Date().toISOString(),
    updated_by: String(ctx.user?.user_id || ctx.user?.id || ''),
  };
  await setStoredKeyRecord(ctx.env.RANKINGS_DB, record);
  return record;
}

export async function clearOpenAlexKey(ctx) {
  await setStoredKeyRecord(ctx.env.RANKINGS_DB, {
    enabled: false,
    iv: null,
    ciphertext: null,
    last_four: null,
    updated_at: new Date().toISOString(),
    updated_by: String(ctx.user?.user_id || ctx.user?.id || ''),
  });
}

export function openAlexKeyStatus(ctx, keyState, encryptionReady) {
  return {
    configured: Boolean(keyState.value),
    source: keyState.source,
    maskedSuffix: keyState.value ? keyState.value.slice(-4) : null,
    updatedAt: keyState.stored?.updated_at || null,
    encryptionReady,
  };
}
