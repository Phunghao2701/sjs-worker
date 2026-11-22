import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const emulator = spawn(command, [
  'firebase-tools', 'emulators:start', '--only', 'firestore', '--project', 'demo-sjs',
], {
  cwd: projectDir,
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true,
  shell: process.platform === 'win32',
});

let startupOutput = '';
let seeding = false;
let stopping = false;

function forwardOutput(stream, destination) {
  stream.on('data', chunk => {
    destination.write(chunk);
    startupOutput = `${startupOutput}${chunk.toString()}`.slice(-12000);
    if (!seeding && /All emulators ready!/i.test(startupOutput)) {
      seeding = true;
      void seedAccounts();
    }
  });
}

function runSeed() {
  return new Promise((resolvePromise, rejectPromise) => {
    const seed = spawn(process.execPath, [resolve(projectDir, 'scripts/seed-dev-accounts.mjs')], {
      cwd: projectDir,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    seed.once('error', rejectPromise);
    seed.once('exit', code => code === 0 ? resolvePromise() : rejectPromise(new Error(`Seed process exited with code ${code ?? 'unknown'}.`)));
  });
}

async function seedAccounts() {
  try {
    await runSeed();
    process.stdout.write('[emulator] Development accounts are ready.\n');
  } catch (error) {
    process.stderr.write(`[emulator] Automatic account seeding failed: ${error.message}\n`);
    process.exitCode = 1;
    stopEmulator();
  }
}

function stopEmulator() {
  if (stopping) return;
  stopping = true;
  emulator.kill('SIGINT');
}

process.once('SIGINT', stopEmulator);
process.once('SIGTERM', stopEmulator);
forwardOutput(emulator.stdout, process.stdout);
forwardOutput(emulator.stderr, process.stderr);

emulator.once('error', error => {
  process.stderr.write(`[emulator] Could not start Firebase Emulator: ${error.message}\n`);
  process.exitCode = 1;
});
emulator.once('exit', (code, signal) => {
  if (code !== 0 && code !== null) process.exitCode = code;
  if (signal && !stopping) process.exitCode = 1;
});
