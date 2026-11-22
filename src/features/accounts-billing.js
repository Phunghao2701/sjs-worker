import bcrypt from 'bcryptjs';
import { HttpError, setCookie } from '../core/http.js';
import { defineRoutes, ok } from '../core/router.js';
import { all, byId, collectionFor, find, id, isDeleted, nowIso, paginate, requireFound } from '../firestore/repository.js';

const uid = user => String(user.user_id || user.id);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const withoutPassword = ({ password, password_hash, ...user }) => user;
const adminUserFields = ['user_id', 'email', 'type', 'status', 'role', 'first_name', 'last_name', 'url_image', 'date_of_birth', 'gender'];
const selectAdminUser = row => Object.fromEntries(adminUserFields.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
const profileFields = new Set(['first_name', 'last_name', 'date_of_birth', 'gender', 'url_image']);
function profilePatch(body) {
  const patch = Object.fromEntries(Object.entries(body || {}).filter(([key]) => profileFields.has(key)));
  if (!Object.keys(patch).length) throw new HttpError(400, 'No valid profile fields were provided', 'VALIDATION_ERROR');
  for (const key of ['first_name', 'last_name', 'url_image']) if (patch[key] !== undefined && typeof patch[key] !== 'string') throw new HttpError(400, `${key} must be a string`, 'VALIDATION_ERROR');
  if (patch.gender !== undefined && typeof patch.gender !== 'boolean') throw new HttpError(400, 'gender must be a boolean', 'VALIDATION_ERROR');
  if (patch.date_of_birth !== undefined) {
    const text = String(patch.date_of_birth);
    const parsed = new Date(`${text}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw new HttpError(400, 'date_of_birth must be a valid date', 'VALIDATION_ERROR');
    patch.date_of_birth = parsed;
  }
  return patch;
}
const walletIdFor = async (db, userId) => {
  const direct = await db.get('wallets', userId);
  if (direct) return userId;
  const found = (await find(db, 'wallets', row => String(row.user_id) === String(userId), { limit: 1 }))[0];
  return found?.id || userId;
};

export async function spendCoins(db, userId, amount, description) {
  const tx = await db.beginTransaction();
  try {
    const walletId = await walletIdFor(db, userId);
    const currentWallet = await db.get('wallets', walletId, tx);
    const wallet = currentWallet || { id: walletId, user_id: String(userId), balance: 0, coins: 0 };
    const balance = Number(wallet.balance ?? wallet.coins ?? 0);
    if (balance < amount) throw new HttpError(409, 'Insufficient balance', 'INSUFFICIENT_BALANCE');
    const next = balance - amount;
    const transactionId = id();
    const createdAt = nowIso();
    const walletNext = { ...wallet, balance: next, coins: next, total_spent: Number(wallet.total_spent || 0) + amount, updated_at: createdAt };
    const transaction = { id: transactionId, wallet_id: wallet.wallet_id || wallet.id, user_id: String(userId), type: 'spend', amount: -amount, balance_before: balance, balance_after: next, description: description || null, created_at: createdAt };
    await db.commit([
      { update: { name: db.documentName('wallets', walletId), fields: (await import('../firestore/codec.js')).encodeFields(walletNext), currentDocument: { exists: Boolean(currentWallet) } } },
      { update: { name: db.documentName('wallet_transactions', transactionId), fields: (await import('../firestore/codec.js')).encodeFields(transaction), currentDocument: { exists: false } } },
    ], tx);
    return { wallet: walletNext, transaction };
  } catch (error) {
    await db.commit([], tx).catch(() => {});
    throw error;
  }
}

async function getMe(ctx) {
  const user = requireFound(await byId(ctx.db, 'users', uid(ctx.user)), 'User not found');
  return ok(withoutPassword(user), 'User profile fetched successfully');
}
async function updateMe(ctx) {
  const current = requireFound(await byId(ctx.db, 'users', uid(ctx.user)), 'User not found');
  const safe = profilePatch(ctx.body);
  const result = { ...current, ...safe, updated_at: nowIso() };
  await ctx.db.merge('users', current.id || uid(ctx.user), { ...safe, updated_at: result.updated_at });
  return ok(withoutPassword(result), 'User profile updated successfully');
}
async function deleteMe(ctx) {
  const current = requireFound(await byId(ctx.db, 'users', uid(ctx.user)), 'User not found');
  await hardDeleteUser(ctx.db, current);
  const configuredDomain = String(ctx.env.COOKIE_DOMAIN || '').trim();
  const domain = ['localhost', '127.0.0.1'].includes(configuredDomain.toLowerCase()) ? undefined : configuredDomain || undefined;
  const cookieOptions = { maxAge: 0, secure: ctx.env.COOKIE_SECURE !== 'false', sameSite: ctx.env.COOKIE_SAMESITE || 'None', domain };
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  headers.append('set-cookie', setCookie('access_token', '', cookieOptions));
  headers.append('set-cookie', setCookie('refresh_token', '', cookieOptions));
  return new Response(JSON.stringify({ success: true, message: `XÃ³a tÃ i khoáº£n ${current.email} thÃ nh cÃ´ng!`, data: { user_id: uid(ctx.user) } }), { headers });
}

async function hardDeleteUser(db, user) {
  const userId = String(user.user_id || user.id);
  const userKey = String(user.id || user.user_id);
  const [projects, resetTokens, memberships, bookmarks, messages, payments, wallets, walletTransactions, logs] = await Promise.all([
    find(db, 'projects', row => String(row.user_id || '') === userId, { limit: Infinity }),
    find(db, 'password_reset_tokens', row => String(row.user_id || '') === userId, { limit: Infinity }),
    find(db, 'project_members', row => String(row.user_id || '') === userId || String(row.invited_by || '') === userId, { limit: Infinity }),
    find(db, 'project_article_bookmarks', row => String(row.user_id || '') === userId, { limit: Infinity }),
    find(db, 'chat_messages', row => String(row.user_id || '') === userId, { limit: Infinity }),
    find(db, 'payments', row => String(row.user_id || '') === userId, { limit: Infinity }),
    find(db, 'wallets', row => String(row.user_id || '') === userId, { limit: Infinity }),
    find(db, 'wallet_transactions', row => String(row.user_id || '') === userId, { limit: Infinity }),
    find(db, 'logs', row => String(row.user_id || '') === userId, { limit: Infinity }),
  ]);
  const blockingInvitations = memberships.filter(row => String(row.invited_by || '') === userId && String(row.user_id || '') !== userId);
  if (projects.length || resetTokens.length || blockingInvitations.length) {
    throw new HttpError(409, 'Account is still referenced by restricted records', 'USER_DELETE_RESTRICTED', {
      projects: projects.length, password_reset_tokens: resetTokens.length, invitations: blockingInvitations.length,
    });
  }
  const deletes = [
    ['project_members', memberships.filter(row => String(row.user_id || '') === userId)],
    ['project_article_bookmarks', bookmarks], ['chat_messages', messages], ['payments', payments],
    ['wallet_transactions', walletTransactions], ['wallets', wallets],
  ];
  const { encodeFields } = await import('../firestore/codec.js');
  const writes = [];
  for (const [collection, rows] of deletes) for (const row of rows) {
    if (row.id) writes.push({ delete: db.documentName(collection, row.id), currentDocument: { exists: true } });
  }
  for (const log of logs) if (log.id) writes.push({
    update: { name: db.documentName('logs', log.id), fields: encodeFields({ user_id: null }) },
    updateMask: { fieldPaths: ['user_id'] }, currentDocument: { exists: true },
  });
  writes.push({ delete: db.documentName('users', userKey), currentDocument: { exists: true } });
  if (writes.length <= 450) {
    const transaction = await db.beginTransaction();
    try {
      if (!await db.get('users', userKey, transaction)) throw new HttpError(404, 'User not found', 'NOT_FOUND');
      await db.commit(writes, transaction);
    } catch (error) {
      await db.commit([], transaction).catch(() => {});
      throw error;
    }
    return;
  }
  for (const [collection, rows] of deletes) await db.batchDelete(collection, rows.map(row => row.id).filter(Boolean));
  for (const log of logs) if (log.id) await db.merge('logs', log.id, { user_id: null });
  await db.delete('users', userKey);
}

async function updateUser(ctx) {
  const targetId = ctx.params.id;
  if (String(uid(ctx.user)) !== String(targetId)) throw new HttpError(403, 'User update permission required', 'FORBIDDEN');
  const current = requireFound(await byId(ctx.db, 'users', targetId), 'User not found');
  const patch = profilePatch(ctx.body);
  const updated = { ...current, ...patch, updated_at: nowIso() };
  await ctx.db.merge('users', current.id || targetId, { ...patch, updated_at: updated.updated_at });
  return ok(withoutPassword(updated), 'User updated successfully');
}

export async function ensureWallet(db, userId) {
  const key = await walletIdFor(db, userId);
  const transaction = await db.beginTransaction();
  try {
    const existing = await db.get('wallets', key, transaction);
    if (existing) {
      await db.commit([], transaction);
      return existing;
    }
    const createdAt = nowIso();
    const wallet = { id: key, wallet_id: id(), user_id: String(userId), balance: 0, coins: 0, total_deposit: 0, total_spent: 0, created_at: createdAt, updated_at: createdAt };
    const { encodeFields } = await import('../firestore/codec.js');
    await db.commit([{ update: { name: db.documentName('wallets', key), fields: encodeFields(wallet), currentDocument: { exists: false } } }], transaction);
    return wallet;
  } catch (error) {
    await db.commit([], transaction).catch(() => {});
    const concurrentlyCreated = await db.get('wallets', key).catch(() => null);
    if (concurrentlyCreated) return concurrentlyCreated;
    throw error;
  }
}

async function getWallet(ctx) {
  return ok(await ensureWallet(ctx.db, uid(ctx.user)), 'Wallet fetched successfully');
}
async function walletTransactions(ctx, admin = false) {
  const target = admin ? ctx.query.userId || ctx.query.user_id : uid(ctx.user);
  let rows = await find(ctx.db, 'wallet_transactions', row => (!target || String(row.user_id) === String(target)) && (!ctx.query.type || row.type === ctx.query.type), { limit: Infinity, sort: 'created_at', descending: true });
  const page = paginate(rows, ctx.query, 50, 200);
  return { success: true, code: admin ? 'GET_ADMIN_WALLET_TRANSACTIONS_SUCCESS' : 'GET_WALLET_TRANSACTIONS_SUCCESS', message: 'Wallet transactions fetched successfully', data: page.items, pagination: { total: page.total, page: page.page, limit: page.limit, totalPages: page.totalPages } };
}
async function spend(ctx) {
  const amount = Number(ctx.body.amount || ctx.body.coins);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'amount must be positive', 'VALIDATION_ERROR');
  const result = await spendCoins(ctx.db, uid(ctx.user), amount, ctx.body.description || 'Usage');
  return ok(result, 'Coins spent successfully');
}

async function packages(ctx, admin = false) {
  let rows = await all(ctx.db, 'coinPackages');
  if (!admin) rows = rows.filter(row => row.is_active !== false && String(row.status || 'ACTIVE').toUpperCase() !== 'INACTIVE');
  else if (ctx.query.isActive !== undefined) rows = rows.filter(row => Boolean(row.is_active) === (String(ctx.query.isActive) === 'true'));
  const page = paginate(rows, ctx.query, 50, 200);
  if (!admin) return { success: true, code: 'GET_COIN_PACKAGES_SUCCESS', message: 'Coin packages fetched successfully', data: rows };
  return { success: true, code: 'GET_ADMIN_COIN_PACKAGES_SUCCESS', message: 'Coin packages fetched successfully', data: page.items, pagination: { total: page.total, page: page.page, limit: page.limit, totalPages: page.totalPages } };
}
async function createPackage(ctx) {
  if (!ctx.body.name || Number(ctx.body.coin_amount) <= 0 || Number(ctx.body.price) < 0) throw new HttpError(400, 'name, coin_amount and price are required', 'VALIDATION_ERROR');
  const idValue = String(ctx.body.id || id());
  const data = { ...ctx.body, id: idValue, package_id: ctx.body.package_id || idValue, bonus_coin: Number(ctx.body.bonus_coin || 0), currency: ctx.body.currency || 'VND', is_active: ctx.body.is_active ?? true, created_at: nowIso() };
  await ctx.db.create('coin_packages', idValue, data);
  return ok(data, 'Coin package created successfully');
}
async function updatePackage(ctx) {
  const row = requireFound(await byId(ctx.db, 'coinPackages', ctx.params.packageId), 'Coin package not found');
  const next = { ...row, ...ctx.body, updated_at: nowIso() };
  await ctx.db.set('coin_packages', row.id || ctx.params.packageId, next);
  return ok(next, 'Coin package updated successfully');
}
async function disablePackage(ctx) {
  const row = requireFound(await byId(ctx.db, 'coinPackages', ctx.params.packageId), 'Coin package not found');
  const updated = { ...row, is_active: false, updated_at: nowIso() };
  await ctx.db.set('coin_packages', row.id || ctx.params.packageId, updated);
  return ok(updated, 'Coin package disabled successfully', 'DELETE_COIN_PACKAGE_SUCCESS');
}

async function createPayment(ctx) {
  const packageId = ctx.body.packageId || ctx.body.package_id;
  if (!ctx.body.packageId || !ctx.body.paymentMethod || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(ctx.body.packageId))) throw new HttpError(400, 'packageId must be a UUID and paymentMethod is required', 'VALIDATION_ERROR');
  const supportedMethods = new Set(['payos', 'vnpay', 'momo', 'bank_transfer', 'stripe', 'paypal']);
  if (!supportedMethods.has(String(ctx.body.paymentMethod).toLowerCase())) throw new HttpError(400, 'paymentMethod is invalid', 'VALIDATION_ERROR');
  const packageRow = packageId ? await byId(ctx.db, 'coinPackages', packageId) : null;
  if (!packageRow || packageRow.is_active === false) throw new HttpError(404, 'Coin package not found', 'COIN_PACKAGE_NOT_FOUND');
  const coinAmount = Number(packageRow.coin_amount || 0); const bonusCoin = Number(packageRow.bonus_coin || 0); const totalCoin = coinAmount + bonusCoin;
  const amount = Number(packageRow.price || 0);
  if (!(amount > 0) || !(totalCoin > 0)) throw new HttpError(400, 'Coin package is invalid', 'VALIDATION_ERROR');
  const paymentId = id(); const orderCode = Number(`${String(Date.now()).slice(-9)}${Math.floor(100 + Math.random() * 900)}`);
  const paymentMethod = String(ctx.body.paymentMethod).toLowerCase();
  const row = { id: paymentId, transaction_id: paymentId, user_id: uid(ctx.user), package_id: packageRow.package_id || packageRow.id, amount, currency: packageRow.currency || 'VND', coin_amount: coinAmount, bonus_coin: bonusCoin, total_coin: totalCoin, payment_method: paymentMethod, payment_status: 'pending', status: 'pending', order_code: orderCode, created_at: nowIso() };
  await ctx.db.create('payments', paymentId, row);
  let paymentUrl = `${ctx.env.BASE_URL || ''}/api/v1/payments/${encodeURIComponent(paymentId)}`;
  if (paymentMethod === 'payos') {
    if (!ctx.env.PAYOS_CLIENT_ID || !ctx.env.PAYOS_API_KEY || !ctx.env.PAYOS_CHECKSUM_KEY) throw new HttpError(503, 'PayOS is not configured', 'PAYOS_NOT_CONFIGURED');
    const frontend = String(ctx.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    const payload = { orderCode, amount: Math.round(amount), description: `NAPCOIN ${orderCode}`.slice(0, 25), returnUrl: ctx.body.returnUrl || ctx.env.PAYOS_RETURN_URL || `${frontend}/wallet/payment/result`, cancelUrl: ctx.body.cancelUrl || ctx.env.PAYOS_CANCEL_URL || `${frontend}/wallet/top-up?cancel=true`, items: [{ name: String(packageRow.name || 'Coin package').slice(0, 50), quantity: 1, price: Math.round(amount) }] };
    const signature = await hmacHex(ctx.env.PAYOS_CHECKSUM_KEY, `${payload.amount}|${payload.cancelUrl}|${payload.description}|${payload.orderCode}|${payload.returnUrl}`);
    const response = await fetch('https://api-merchant.payos.vn/v2/payment-requests', { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-id': ctx.env.PAYOS_CLIENT_ID, 'x-api-key': ctx.env.PAYOS_API_KEY }, body: JSON.stringify({ ...payload, signature }) });
    const data = await response.json();
    if (!response.ok || data.code !== '00') throw new HttpError(502, 'Could not create PayOS checkout', 'PAYOS_FAILED');
    paymentUrl = data.data.checkoutUrl;
    await ctx.db.merge('payments', paymentId, { checkout_url: paymentUrl, payment_link_id: data.data.paymentLinkId });
  }
  return { body: { success: true, code: 'CREATE_PAYMENT_SUCCESS', message: 'Payment created successfully', data: { transactionId: paymentId, transaction_id: paymentId, orderCode, order_code: orderCode, paymentUrl, payment_url: paymentUrl, payment: row } }, status: 201 };
}

async function paymentList(ctx, admin = false) {
  const rows = await find(ctx.db, 'payments', row => (admin || String(row.user_id) === uid(ctx.user)) && (!ctx.query.status || String(row.payment_status || row.status) === String(ctx.query.status)) && (!ctx.query.userId && !ctx.query.user_id || String(row.user_id) === String(ctx.query.userId || ctx.query.user_id)) && (!ctx.query.paymentMethod || row.payment_method === ctx.query.paymentMethod), { limit: Infinity, sort: 'created_at', descending: true });
  const page = paginate(rows, ctx.query, 50, 200);
  return { success: true, code: admin ? 'GET_ADMIN_PAYMENTS_SUCCESS' : 'GET_MY_PAYMENTS_SUCCESS', message: 'Payments fetched successfully', data: page.items, pagination: { total: page.total, page: page.page, limit: page.limit, totalPages: page.totalPages } };
}
async function getPayment(ctx) {
  let row = requireFound(await byId(ctx.db, 'payments', ctx.params.transactionId), 'Payment not found');
  if (String(row.user_id) !== uid(ctx.user) && !['ADMIN', 'ADMINISTRATOR', 'SUPER_ADMIN'].includes(String(ctx.user.role).toUpperCase())) throw new HttpError(403, 'Payment access denied', 'FORBIDDEN');
  row = await syncPayosPayment(ctx, row);
  return ok(row, 'Payment fetched successfully');
}
async function getPaymentByOrder(ctx) {
  let row = requireFound((await find(ctx.db, 'payments', item => String(item.order_code) === String(ctx.params.orderCode), { limit: 1 }))[0], 'Payment not found');
  row = await syncPayosPayment(ctx, row);
  return ok(row, 'Payment fetched successfully', 'GET_PAYMENT_SUCCESS');
}
async function syncPayosPayment(ctx, payment) {
  if (String(payment.payment_status || payment.status).toLowerCase() !== 'pending' || !payment.order_code || !ctx.env.PAYOS_CLIENT_ID || !ctx.env.PAYOS_API_KEY) return payment;
  try {
    const response = await fetch(`https://api-merchant.payos.vn/v2/payment-requests/${encodeURIComponent(payment.order_code)}`, { headers: { 'x-client-id': ctx.env.PAYOS_CLIENT_ID, 'x-api-key': ctx.env.PAYOS_API_KEY } });
    const result = await response.json(); const state = result.data?.status;
    if (response.ok && state === 'PAID') await completePayment(ctx.db, payment, result.data.transactions?.[0]?.reference || String(payment.order_code));
    else if (response.ok && state === 'CANCELLED') await failPayment(ctx.db, payment, String(payment.order_code), result.data.cancellationReason || 'PayOS payment cancelled');
    return await byId(ctx.db, 'payments', payment.id) || payment;
  } catch (error) { console.warn('[PayOS sync] payment status lookup failed', error.message); return payment; }
}
async function payosWebhook(ctx) {
  const data = ctx.body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Invalid webhook data', 'INVALID_WEBHOOK_DATA');
  if (!ctx.env.PAYOS_CHECKSUM_KEY || !ctx.body.signature) throw new HttpError(400, 'PayOS signature is invalid', 'INVALID_SIGNATURE');
  const canonical = Object.keys(data).sort().map(key => {
    let value = data[key];
    if (Array.isArray(value)) value = JSON.stringify(value.map(item => item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(nestedKey => [nestedKey, item[nestedKey]])) : item));
    if ([null, undefined, 'undefined', 'null'].includes(value)) value = '';
    return `${key}=${value}`;
  }).join('&');
  const expected = await hmacHex(ctx.env.PAYOS_CHECKSUM_KEY, canonical);
  if (!constantTimeEqual(expected, String(ctx.body.signature))) throw new HttpError(400, 'Invalid PayOS signature', 'INVALID_SIGNATURE');
  if (data.description === 'Ma xac thuc webhook' || Number(data.orderCode) === 123) return { error: 0, message: 'Webhook verified', data: { success: true, message: 'Webhook verified' } };
  const payment = (await find(ctx.db, 'payments', row => String(row.order_code) === String(data.orderCode), { limit: 1 }))[0];
  if (!payment) return { error: -1, message: 'Payment not found', data: { success: false, message: 'Payment not found' } };
  if (Number(data.amount) !== Math.round(Number(payment.amount))) return { error: -1, message: 'Invalid amount', data: { success: false, message: 'Invalid amount' } };
  if (data.code === '00' || data.desc === 'success') await completePayment(ctx.db, payment, data.reference || String(data.orderCode));
  else await failPayment(ctx.db, payment, data.reference || String(data.orderCode), `PayOS payment failed with code ${data.code || ''}`);
  return { error: 0, message: 'Ok', data: { success: true, message: 'Payment status updated' } };
}
async function momoIpn(ctx) {
  const body = ctx.body;
  if (!body.orderId && !body.requestId || body.amount === undefined || body.resultCode === undefined) return { success: false, code: 'INVALID_IPN_DATA', message: 'Invalid IPN data' };
  if (!ctx.env.MOMO_SECRET_KEY || !body.signature) return { success: false, code: 'INVALID_SIGNATURE', message: 'Invalid signature' };
  const canonical = Object.keys(body).filter(key => key !== 'signature' && body[key] !== undefined && body[key] !== null).sort().map(key => `${key}=${body[key]}`).join('&');
  if (!constantTimeEqual(await hmacHex(ctx.env.MOMO_SECRET_KEY, canonical), String(body.signature).toLowerCase())) return { success: false, code: 'INVALID_SIGNATURE', message: 'Invalid signature' };
  const paymentKey = String(body.orderId || body.requestId);
  const payment = await byId(ctx.db, 'payments', paymentKey) || (await find(ctx.db, 'payments', row => String(row.transaction_id || row.id) === paymentKey, { limit: 1 }))[0];
  if (!payment) return { success: false, code: 'PAYMENT_NOT_FOUND', message: 'Payment not found' };
  if (Number(body.amount) !== Number(payment.amount)) return { success: false, code: 'INVALID_AMOUNT', message: 'Invalid amount' };
  if (Number(body.resultCode) === 0) { await completePayment(ctx.db, payment, body.transId || null); return { success: true, code: 'CONFIRMED_SUCCESS_PAYMENT', message: 'Payment success confirmed' }; }
  await failPayment(ctx.db, payment, body.transId || null, `MoMo failed with code ${body.resultCode}`);
  return { success: true, code: 'CONFIRMED_FAILED_PAYMENT', message: 'Payment failure confirmed' };
}

async function completePayment(db, payment, providerTransactionCode = null) {
  const tx = await db.beginTransaction();
  try {
    const current = await db.get('payments', payment.id, tx);
    if (!current) throw new HttpError(404, 'Payment not found', 'PAYMENT_NOT_FOUND');
    const paymentStatus = String(current.payment_status || '').toLowerCase();
    if (paymentStatus === 'success') { await db.commit([], tx); return; }
    if (paymentStatus !== 'pending') throw new HttpError(409, 'Payment is no longer pending', 'INVALID_PAYMENT_STATUS');
    const walletId = await walletIdFor(db, payment.user_id);
    const currentWallet = await db.get('wallets', walletId, tx);
    const createdAt = nowIso();
    const wallet = currentWallet || { id: walletId, wallet_id: id(), user_id: payment.user_id, balance: 0, coins: 0, total_deposit: 0, total_spent: 0, created_at: createdAt, updated_at: createdAt };
    const coinCredit = Number(payment.total_coin ?? payment.coins ?? payment.coin_amount ?? 0) + (payment.total_coin === undefined ? Number(payment.bonus_coin || 0) : 0);
    const before = Number(wallet.balance ?? wallet.coins ?? 0); const balance = before + coinCredit;
    const { encodeFields } = await import('../firestore/codec.js');
    const transactionId = id();
    await db.commit([
      { update: { name: db.documentName('wallets', walletId), fields: encodeFields({ ...wallet, balance, coins: balance, total_deposit: Number(wallet.total_deposit || 0) + coinCredit, updated_at: createdAt }), currentDocument: { exists: Boolean(currentWallet) } } },
      { update: { name: db.documentName('wallet_transactions', transactionId), fields: encodeFields({ id: transactionId, wallet_id: wallet.wallet_id || wallet.id, user_id: payment.user_id, payment_transaction_id: payment.transaction_id || payment.id, amount: coinCredit, type: 'deposit', balance_before: before, balance_after: balance, description: `Deposit ${coinCredit} coins from transaction ${payment.transaction_id || payment.id}`, created_at: createdAt }), currentDocument: { exists: false } } },
      { update: { name: db.documentName('payments', payment.id), fields: encodeFields({ ...current, status: 'success', payment_status: 'success', provider_transaction_code: providerTransactionCode || current.provider_transaction_code || null, paid_at: createdAt }), currentDocument: { exists: true } } },
    ], tx);
  } catch (error) { await db.commit([], tx).catch(() => {}); throw error; }
}

async function failPayment(db, payment, providerTransactionCode, note) {
  const tx = await db.beginTransaction();
  try {
    const current = await db.get('payments', payment.id, tx);
    if (String(current?.payment_status || '').toLowerCase() !== 'pending') {
      await db.commit([], tx);
      return;
    }
    const failed = { ...current, status: 'failed', payment_status: 'failed', note: note || current.note };
    if (providerTransactionCode) failed.provider_transaction_code = providerTransactionCode;
    const { encodeFields } = await import('../firestore/codec.js');
    await db.commit([{ update: { name: db.documentName('payments', payment.id), fields: encodeFields(failed), currentDocument: { exists: true } } }], tx);
  } catch (error) {
    await db.commit([], tx).catch(() => {});
    throw error;
  }
}

async function adminUsers(ctx) {
  validatePositiveIntegerQuery(ctx, ['page', 'limit']);
  const search = String(ctx.query.search ?? ctx.query.q ?? '').toLocaleLowerCase();
  const rows = (await all(ctx.db, 'users')).filter(row => {
    const matchesSearch = !search || `${row.email || ''} ${row.first_name || ''} ${row.last_name || ''}`.toLocaleLowerCase().includes(search);
    return matchesSearch && (!ctx.query.role || String(row.role) === String(ctx.query.role)) && (!ctx.query.status || String(row.status) === String(ctx.query.status));
  });
  const allowedSortFields = new Set(['email', 'first_name', 'last_name', 'role', 'status', 'created_at']);
  const sortBy = allowedSortFields.has(ctx.query.sortBy) ? ctx.query.sortBy : 'email';
  const descending = String(ctx.query.sortOrder || 'desc').toLowerCase() !== 'asc';
  rows.sort((a, b) => String(a[sortBy] ?? '').localeCompare(String(b[sortBy] ?? ''), undefined, { sensitivity: 'base' }) * (descending ? -1 : 1));
  const page = Math.max(1, Math.trunc(number(ctx.query.page, 1)));
  const limit = Math.max(1, Math.trunc(number(ctx.query.limit, 10)));
  const start = (page - 1) * limit;
  return { success: true, data: rows.slice(start, start + limit).map(withoutPassword), pagination: { total: rows.length, page, limit, totalPages: Math.ceil(rows.length / limit) } };
}
async function adminUserDetail(ctx) {
  const row = requireFound(await byId(ctx.db, 'users', ctx.params.id));
  return { success: true, data: selectAdminUser(row) };
}
async function adminCreateUser(ctx) {
  const email = String(ctx.body.email || '').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof ctx.body.password !== 'string') throw new HttpError(400, 'Valid email and password are required', 'VALIDATION_ERROR');
  if ((await find(ctx.db, 'users', row => String(row.email).toLowerCase() === email, { limit: 1 })).length) throw new HttpError(409, 'Email already exists', 'EMAIL_EXISTS');
  if (ctx.body.role && !['STUDENT', 'LECTURER', 'RESEARCHER', 'ADMINISTRATOR'].includes(ctx.body.role)) throw new HttpError(400, 'Invalid user role', 'VALIDATION_ERROR');
  if (ctx.body.status && !['INACTIVE', 'ACTIVE', 'BANNED'].includes(ctx.body.status)) throw new HttpError(400, 'Invalid user status', 'VALIDATION_ERROR');
  if (ctx.body.gender !== undefined && typeof ctx.body.gender !== 'boolean') throw new HttpError(400, 'Invalid gender', 'VALIDATION_ERROR');
  if (ctx.body.date_of_birth && Number.isNaN(new Date(ctx.body.date_of_birth).getTime())) throw new HttpError(400, 'Invalid date_of_birth', 'VALIDATION_ERROR');
  const key = id(); const row = { id: key, user_id: key, email, password: await bcrypt.hash(String(ctx.body.password || crypto.randomUUID()), 10), type: 'LOCAL', first_name: ctx.body.first_name || null, last_name: ctx.body.last_name || null, role: ctx.body.role || 'RESEARCHER', status: ctx.body.status || 'ACTIVE', date_of_birth: ctx.body.date_of_birth || null, gender: ctx.body.gender ?? null, created_at: nowIso() };
  await ctx.db.create('users', key, row); return { body: { success: true, data: selectAdminUser(row) }, status: 201 };
}
async function adminUpdateUser(ctx) {
  const row = requireFound(await byId(ctx.db, 'users', ctx.params.id));
  const allowed = ['email', 'password', 'first_name', 'last_name', 'role', 'status', 'type', 'date_of_birth', 'gender', 'url_image'];
  const patch = Object.fromEntries(allowed.filter(key => ctx.body[key] !== undefined).map(key => [key, ctx.body[key]]));
  if (patch.role && !['STUDENT', 'LECTURER', 'RESEARCHER', 'ADMINISTRATOR'].includes(patch.role)) throw new HttpError(400, 'Invalid user role', 'VALIDATION_ERROR');
  if (patch.status && !['INACTIVE', 'ACTIVE', 'BANNED'].includes(patch.status)) throw new HttpError(400, 'Invalid user status', 'VALIDATION_ERROR');
  if (patch.type && !['LOCAL', 'GOOGLE', 'GITHUB'].includes(patch.type)) throw new HttpError(400, 'Invalid user type', 'VALIDATION_ERROR');
  if (patch.email) {
    patch.email = String(patch.email).trim().toLowerCase();
    const duplicate = await find(ctx.db, 'users', user => String(user.email).toLowerCase() === patch.email && String(user.user_id || user.id) !== String(row.user_id || row.id), { limit: 1 });
    if (duplicate.length) throw new HttpError(409, 'Email already exists', 'EMAIL_EXISTS');
  }
  if (patch.password) patch.password = await bcrypt.hash(String(patch.password), 10);
  if (patch.date_of_birth) {
    const date = new Date(patch.date_of_birth);
    if (Number.isNaN(date.getTime())) throw new HttpError(400, 'Invalid date_of_birth', 'VALIDATION_ERROR');
    patch.date_of_birth = date.toISOString();
  }
  patch.updated_at = nowIso();
  const next = { ...row, ...patch }; await ctx.db.set('users', row.id || ctx.params.id, next); return ok(selectAdminUser(next), 'User updated successfully');
}
async function adminAdjustWallet(ctx) {
  const amount = Number(ctx.body.amount || ctx.body.coins); if (!Number.isFinite(amount) || amount === 0) throw new HttpError(400, 'Adjustment amount is invalid', 'VALIDATION_ERROR');
  const walletId = await walletIdFor(ctx.db, ctx.params.userId); const wallet = await ctx.db.get('wallets', walletId) || { id: walletId, user_id: ctx.params.userId, balance: 0, coins: 0 };
  const before = Number(wallet.balance ?? wallet.coins ?? 0); const balance = before + amount; if (balance < 0) throw new HttpError(409, 'Adjustment would make wallet negative', 'INSUFFICIENT_BALANCE');
  const transactionId = id(); const createdAt = nowIso();
  const walletNext = { ...wallet, balance, coins: balance, updated_at: createdAt };
  const transaction = { id: transactionId, wallet_id: wallet.wallet_id || wallet.id, user_id: ctx.params.userId, amount, type: 'admin_adjust', description: ctx.body.description || null, created_by: uid(ctx.user), balance_before: before, balance_after: balance, created_at: createdAt };
  await ctx.db.set('wallets', walletId, walletNext); await ctx.db.set('wallet_transactions', transactionId, transaction);
  return ok({ wallet: walletNext, transaction }, 'Wallet adjusted successfully', 'ADJUST_WALLET_SUCCESS');
}

function validateIntegerQuery(ctx, key) {
  if (ctx.query[key] !== undefined && !/^-?\d+$/.test(String(ctx.query[key]))) throw new HttpError(400, `${key} must be an integer`, 'VALIDATION_ERROR');
}
function validatePositiveIntegerQuery(ctx, keys) {
  for (const key of keys) {
    if (ctx.query[key] === undefined) continue;
    const value = Number(ctx.query[key]);
    if (!Number.isInteger(value) || value < 1) throw new HttpError(400, `${key} must be a positive integer`, 'VALIDATION_ERROR');
  }
}

async function adminSummary(ctx) {
  const [users, articles, journals] = await Promise.all(['users', 'articles', 'journals'].map(name => all(ctx.db, name)));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const createdToday = row => row.created_at && new Date(row.created_at).getTime() >= today.getTime();
  const activeArticles = articles.filter(row => row.is_deleted === false);
  const activeJournals = journals.filter(row => row.is_deleted === false);
  const activeUsers = users.filter(row => String(row.status).toUpperCase() === 'ACTIVE');
  return ok({
    total_journals: activeJournals.length,
    journal_growth: activeJournals.filter(createdToday).length,
    total_articles: activeArticles.length,
    article_growth: activeArticles.filter(createdToday).length,
    pending_reviews: 0,
    active_users: activeUsers.length,
  }, 'Láº¥y sá»‘ liá»‡u thá»‘ng kÃª tá»•ng quan thÃ nh cÃ´ng', 'GET_SUMMARY_SUCCESS');
}
async function adminPublicationTrends(ctx) {
  validateIntegerQuery(ctx, 'year');
  validatePositiveIntegerQuery(ctx, ['limit']);
  const targetYear = Math.trunc(number(ctx.query.year, new Date().getFullYear()));
  const limit = Math.max(1, Math.trunc(number(ctx.query.limit, 5)));
  const articles = (await all(ctx.db, 'articles')).filter(row => row.is_deleted === false);
  const items = Array.from({ length: limit }, (_, index) => {
    const year = targetYear - limit + 1 + index;
    return { year, manuscripts: articles.filter(row => number(row.publication_year) === year).length, published: 0 };
  });
  return ok({ target_year: targetYear, items }, 'Láº¥y dá»¯ liá»‡u biá»ƒu Ä‘á»“ xu hÆ°á»›ng xuáº¥t báº£n thÃ nh cÃ´ng', 'GET_PUBLICATION_TRENDS_SUCCESS');
}
async function adminVolumeIssueStatus(ctx) {
  if (!ctx.path.endsWith('/export')) validatePositiveIntegerQuery(ctx, ['page', 'limit']);
  const [volumes, issues, journals] = await Promise.all([all(ctx.db, 'volumes'), all(ctx.db, 'issues'), all(ctx.db, 'journals')]);
  const journalById = new Map(journals.map(row => [String(row.journal_id || row.id), row]));
  const issueCounts = new Map();
  for (const issue of issues) {
    if (issue.is_deleted !== false) continue;
    const volumeId = String(issue.volume_id || '');
    if (volumeId) issueCounts.set(volumeId, (issueCounts.get(volumeId) || 0) + 1);
  }
  const rows = volumes.filter(row => row.is_deleted === false).map(volume => {
    const volumeId = String(volume.volume_id || volume.id);
    const journal = journalById.get(String(volume.journal_id || ''));
    const volumeNumber = number(volume.volume_number);
    return {
      volume_id: volume.volume_id || volume.id,
      volume_number: volume.volume_number,
      publication_year: volume.publication_year,
      journal_name: journal?.display_name ?? null,
      total_issues: issueCounts.get(volumeId) || 0,
      status: 'PUBLISHED',
      progress: (volumeNumber % 10) * 10 + 10,
    };
  }).sort((a, b) => number(b.publication_year) - number(a.publication_year) || number(b.volume_number) - number(a.volume_number));
  if (ctx.path.endsWith('/export')) {
    const headers = ['volume_id', 'volume_number', 'publication_year', 'journal_name', 'total_issues', 'status', 'progress'];
    const quote = value => value == null ? '""' : `"${String(value).replaceAll('"', '""')}"`;
    const csv = rows.length
      ? `\uFEFF${headers.join(',')}\n${rows.map(row => headers.map(key => quote(row[key])).join(',')).join('\n')}`
      : `${headers.join(',')}\n`;
    return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="volume_issue_status.csv"' } });
  }
  const page = Math.max(1, Math.trunc(number(ctx.query.page, 1)));
  const limit = Math.max(1, Math.trunc(number(ctx.query.limit, 10)));
  const start = (page - 1) * limit;
  return ok(rows.slice(start, start + limit), 'Láº¥y danh sÃ¡ch Volume & Issue Status thÃ nh cÃ´ng', 'GET_VOLUME_ISSUE_STATUS_SUCCESS', {
    pagination: { total: rows.length, page, limit, totalPages: Math.ceil(rows.length / limit) },
  });
}
async function adminJournalSummary(ctx) {
  const journal = requireFound(await byId(ctx.db, 'journals', ctx.params.journalId));
  const [volumes, issues, articles] = await Promise.all([all(ctx.db, 'volumes'), all(ctx.db, 'issues'), all(ctx.db, 'articles')]);
  const journalId = String(journal.journal_id || journal.id || ctx.params.journalId);
  const journalVolumes = volumes.filter(row => String(row.journal_id) === journalId);
  const journalVolumeIds = new Set(journalVolumes.map(row => String(row.volume_id || row.id)));
  const journalIssues = issues.filter(row => journalVolumeIds.has(String(row.volume_id || '')));
  const activeIssues = journalIssues.filter(row => row.is_deleted === false);
  const issueIds = new Set(journalIssues.map(row => String(row.issue_id || row.id)));
  const currentYear = new Date().getFullYear();
  const nextRelease = activeIssues.map(row => number(row.publication_year)).filter(year => year > currentYear).sort((a, b) => a - b)[0] ?? null;
  const totalPublications = articles.filter(row => row.is_deleted === false && issueIds.has(String(row.issue_id || ''))).length;
  return ok({ total_volumes: journalVolumes.filter(row => row.is_deleted === false).length, active_issues: activeIssues.length, total_publications: totalPublications, next_release: nextRelease }, 'Láº¥y dá»¯ liá»‡u tá»•ng quan cá»§a kho lÆ°u trá»¯ thÃ nh cÃ´ng');
}
async function recentActivities(ctx) {
  validatePositiveIntegerQuery(ctx, ['page', 'limit']);
  return ok(paginate(await find(ctx.db, 'logs', () => true, { limit: Infinity, sort: 'created_at', descending: true }), ctx.query), 'Recent activities fetched successfully');
}
const toCsv = rows => { const keys = [...new Set(rows.flatMap(row => Object.keys(row)))]; return [keys.join(','), ...rows.map(row => keys.map(key => `"${String(row[key] ?? '').replaceAll('"', '""')}"`).join(','))].join('\r\n'); };

const hmacHex = async (secret, value) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
};
const constantTimeEqual = (a, b) => { if (a.length !== b.length) return false; let value = 0; for (let i = 0; i < a.length; i++) value |= a.charCodeAt(i) ^ b.charCodeAt(i); return value === 0; };

export const accountBillingRoutes = defineRoutes([
  { method: 'GET', path: '/users/me', auth: true, handler: getMe },
  { method: 'PUT', path: '/users/me', auth: true, handler: updateMe },
  { method: 'DELETE', path: '/users/me', auth: true, handler: deleteMe },
  { method: 'PUT', path: '/users/:id', auth: true, handler: updateUser },
  { method: 'GET', path: '/admin/dashboard/summary', auth: true, admin: true, handler: adminSummary },
  { method: 'GET', path: '/admin/dashboard/publication-trends', auth: true, admin: true, handler: adminPublicationTrends },
  { method: 'GET', path: '/admin/dashboard/volume-issue-status', auth: true, admin: true, handler: adminVolumeIssueStatus },
  { method: 'GET', path: '/admin/dashboard/volume-issue-status/export', auth: true, admin: true, handler: adminVolumeIssueStatus },
  { method: 'GET', path: '/admin/dashboard/recent-activities', auth: true, admin: true, handler: recentActivities },
  { method: 'GET', path: '/admin/users', auth: true, admin: true, handler: adminUsers },
  { method: 'POST', path: '/admin/users', auth: true, admin: true, handler: adminCreateUser },
  { method: 'GET', path: '/admin/users/:id', auth: true, admin: true, handler: adminUserDetail },
  { method: 'PUT', path: '/admin/users/:id', auth: true, admin: true, handler: adminUpdateUser },
  { method: 'GET', path: '/admin/repositories/journals/:journalId/summary', auth: true, admin: true, handler: adminJournalSummary },
]);

