import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import { FirestoreClient } from '../src/firestore/client.js';
import { find } from '../src/firestore/repository.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(scriptDir, '..');
const workspaceDir = resolve(apiDir, '..');
const apiVarsPath = resolve(apiDir, '.dev.vars');
const frontendEnvPath = resolve(workspaceDir, 'sjs-fe-v2', '.env');
const apiVarsText = await readFile(apiVarsPath, 'utf8').catch(() => '');
const frontendEnvText = await readFile(frontendEnvPath, 'utf8').catch(() => {
  throw new Error(`FE .env not found: ${frontendEnvPath}`);
});

function readEnvValue(text, name) {
  const line = text.split(/\r?\n/).find((item) => item.trim().startsWith(`${name}=`));
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') : '';
}

const projectId = readEnvValue(apiVarsText, 'FIREBASE_PROJECT_ID');
const databaseId = readEnvValue(apiVarsText, 'FIRESTORE_DATABASE_ID') || '(default)';
const emulatorHost = readEnvValue(apiVarsText, 'FIRESTORE_EMULATOR_HOST');
if (projectId !== 'demo-sjs') throw new Error('Seed stopped: FIREBASE_PROJECT_ID must be demo-sjs.');
if (!emulatorHost) throw new Error('Seed stopped: FIRESTORE_EMULATOR_HOST is missing from sjs-api/.dev.vars.');

const hostUrl = new URL(emulatorHost.includes('://') ? emulatorHost : `http://${emulatorHost}`);
if (!['localhost', '127.0.0.1', '::1'].includes(hostUrl.hostname) || hostUrl.port !== '43878') {
  throw new Error('Seed stopped: only the local Firestore Emulator on port 43878 is allowed.');
}

const accountDefinitions = [
  {
    id: 'dev-quick-user',
    emailKey: 'VITE_DEV_USER_EMAIL',
    passwordKey: 'VITE_DEV_USER_PASSWORD',
    defaultEmail: 'dev.user@local.test',
    role: 'STUDENT',
    firstName: 'Dev User',
  },
  {
    id: 'dev-quick-admin',
    emailKey: 'VITE_DEV_ADMIN_EMAIL',
    passwordKey: 'VITE_DEV_ADMIN_PASSWORD',
    defaultEmail: 'dev.admin@local.test',
    role: 'ADMINISTRATOR',
    firstName: 'Dev Admin',
  },
];

const accounts = accountDefinitions.map((definition) => {
  const configuredEmail = readEnvValue(frontendEnvText, definition.emailKey);
  if (configuredEmail && configuredEmail.toLowerCase() !== definition.defaultEmail) {
    throw new Error(`Seed stopped: ${definition.emailKey} must be ${definition.defaultEmail} for the reserved emulator seed account.`);
  }
  return {
    ...definition,
    email: definition.defaultEmail,
    password: readEnvValue(frontendEnvText, definition.passwordKey) || randomBytes(32).toString('base64url'),
  };
});

const db = new FirestoreClient({
  FIREBASE_PROJECT_ID: projectId,
  FIRESTORE_DATABASE_ID: databaseId,
  FIRESTORE_EMULATOR_HOST: hostUrl.host,
});

for (const account of accounts) {
  const matchingUsers = await find(db, 'users', (user) => String(user.email || '').toLowerCase() === account.email);
  const conflict = matchingUsers.find((user) => String(user.id || user.user_id) !== account.id);
  if (conflict) throw new Error(`Seed stopped: ${account.email} already belongs to a different emulator user record.`);
}

for (const account of accounts) {
  const existing = await db.get('users', account.id);
  const passwordHash = await bcrypt.hash(account.password, 10);
  await db.merge('users', account.id, {
    id: account.id,
    user_id: account.id,
    email: account.email,
    password: passwordHash,
    first_name: account.firstName,
    last_name: 'Account',
    role: account.role,
    status: 'ACTIVE',
    email_verified: true,
    created_at: existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

const updates = new Map();
for (const account of accounts) {
  updates.set(account.emailKey, account.email);
  updates.set(account.passwordKey, account.password);
}
const lines = frontendEnvText.replace(/^\uFEFF/, '').split(/\r?\n/);
const seen = new Set();
const updatedLines = lines.map((line) => {
  const separator = line.indexOf('=');
  if (separator < 0) return line;
  const key = line.slice(0, separator).trim();
  if (!updates.has(key)) return line;
  seen.add(key);
  return `${key}=${updates.get(key)}`;
});
for (const [key, value] of updates) if (!seen.has(key)) updatedLines.push(`${key}=${value}`);
await writeFile(frontendEnvPath, `${updatedLines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');

console.log('Seeded local Firestore Emulator accounts:');
for (const account of accounts) console.log(`- ${account.email} (${account.role})`);
console.log(`Quick-login credentials are stored in ${frontendEnvPath}; restart Vite to load them.`);
