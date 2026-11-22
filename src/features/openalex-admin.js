import { HttpError } from '../core/http.js';
import { defineRoutes } from '../core/router.js';
import { clearOpenAlexKey, openAlexKeyStatus, readOpenAlexKey, saveOpenAlexKey } from '../openalex/key-store.js';

async function validateOpenAlexKey(value) {
  let response;
  try {
    response = await fetch('https://api.openalex.org/works?per-page=1', {
      headers: { accept: 'application/json', authorization: `Bearer ${value}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HttpError(502, 'Không thể kết nối OpenAlex để kiểm tra key.', 'OPENALEX_VALIDATION_UNAVAILABLE');
  }
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(422, 'OpenAlex không chấp nhận key này. Kiểm tra key rồi thử lại.', 'OPENALEX_KEY_INVALID');
  }
  if (response.status === 429) {
    throw new HttpError(503, 'OpenAlex đang giới hạn yêu cầu. Vui lòng thử lại sau.', 'OPENALEX_VALIDATION_RATE_LIMITED');
  }
  throw new HttpError(502, 'OpenAlex chưa thể kiểm tra key lúc này.', 'OPENALEX_VALIDATION_FAILED');
}

function encryptionReady(ctx) {
  return String(ctx.env.OPENALEX_CONFIG_ENCRYPTION_KEY || '').length >= 32;
}

export const openAlexAdminRoutes = defineRoutes([
  {
    method: 'GET', path: '/admin/integrations/openalex', auth: true, admin: true,
    handler: async ctx => {
      try {
        const keyState = await readOpenAlexKey(ctx);
        return { success: true, data: openAlexKeyStatus(ctx, keyState, encryptionReady(ctx)) };
      } catch (error) {
        if (!['OPENALEX_KEY_DECRYPT_FAILED', 'OPENALEX_ENCRYPTION_NOT_CONFIGURED'].includes(error.code)) throw error;
        const stored = await ctx.db.get('system_settings', 'openalex_api_key');
        return {
          success: true,
          data: {
            configured: Boolean(stored?.enabled),
            source: stored?.enabled ? 'admin' : 'none',
            maskedSuffix: null,
            updatedAt: stored?.updated_at || null,
            encryptionReady: encryptionReady(ctx),
            keyUnreadable: true,
          },
        };
      }
    },
  },
  {
    method: 'PUT', path: '/admin/integrations/openalex', auth: true, admin: true,
    handler: async ctx => {
      const value = String(ctx.body.api_key || '').trim();
      if (value.length < 8 || value.length > 512) throw new HttpError(400, 'Nhập OpenAlex key hợp lệ.', 'OPENALEX_KEY_INVALID');
      if (!encryptionReady(ctx)) throw new HttpError(503, 'BE chưa cấu hình OPENALEX_CONFIG_ENCRYPTION_KEY.', 'OPENALEX_ENCRYPTION_NOT_CONFIGURED');
      await validateOpenAlexKey(value);
      const stored = await saveOpenAlexKey(ctx, value);
      const keyState = { value, source: 'admin', stored };
      return { success: true, message: 'OpenAlex key đã được kiểm tra và cập nhật.', data: openAlexKeyStatus(ctx, keyState, true) };
    },
  },
  {
    method: 'DELETE', path: '/admin/integrations/openalex', auth: true, admin: true,
    handler: async ctx => {
      await clearOpenAlexKey(ctx);
      const keyState = await readOpenAlexKey(ctx);
      return { success: true, message: 'Đã xóa key quản trị; hệ thống quay về key trong Worker environment nếu có.', data: openAlexKeyStatus(ctx, keyState, encryptionReady(ctx)) };
    },
  },
]);
