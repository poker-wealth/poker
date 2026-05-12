#!/usr/bin/env node
// Boot local MongoDB 7.0 single-node Replica Set + Redis via docker compose,
// then initiate the RS so transactions work.
//
// Idempotent: re-running checks current RS status before initiating.

import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const composeDir = resolve(__dirname, '..', '..'); // poker/

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: composeDir, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
}

function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: composeDir, ...opts });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function dockerComposeAvailable() {
  const r = runCapture('docker', ['compose', 'version']);
  return r.code === 0;
}

function waitForHealthy(container, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = runCapture('docker', ['inspect', '-f', '{{.State.Health.Status}}', container]);
    const status = r.stdout.trim();
    if (status === 'healthy') return;
    if (status === 'unhealthy') throw new Error(`${container} is unhealthy`);
    spawnSync(process.platform === 'win32' ? 'powershell' : 'sh', [
      process.platform === 'win32' ? '-Command' : '-c',
      'Start-Sleep -Milliseconds 1000',
    ]);
  }
  throw new Error(`Timed out waiting for ${container} to become healthy`);
}

function rsAlreadyInitiated() {
  const r = runCapture('docker', [
    'exec',
    'fairplay-mongo',
    'mongosh',
    '--quiet',
    '--eval',
    'try { rs.status().ok } catch (e) { 0 }',
  ]);
  return r.stdout.trim() === '1';
}

function initiateReplicaSet() {
  const initCmd = `rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] })`;
  execFileSync(
    'docker',
    ['exec', 'fairplay-mongo', 'mongosh', '--quiet', '--eval', initCmd],
    { stdio: 'inherit', cwd: composeDir },
  );
}

function main() {
  if (!dockerComposeAvailable()) {
    console.error(
      'Docker Compose not found. Install Docker Desktop (https://www.docker.com/products/docker-desktop/)',
      'then re-run `npm run mongo:rs:start`.',
    );
    process.exit(1);
  }

  console.error('▶ docker compose up -d mongodb redis');
  run('docker', ['compose', 'up', '-d', 'mongodb', 'redis']);

  console.error('▶ waiting for mongo healthcheck …');
  waitForHealthy('fairplay-mongo');

  if (rsAlreadyInitiated()) {
    console.error('✓ replica set rs0 already initiated');
  } else {
    console.error('▶ initiating replica set rs0');
    initiateReplicaSet();
    // give mongo a moment to elect primary
    spawnSync(process.platform === 'win32' ? 'powershell' : 'sh', [
      process.platform === 'win32' ? '-Command' : '-c',
      'Start-Sleep -Seconds 2',
    ]);
    console.error('✓ replica set initiated');
  }

  console.error('');
  console.error('Connection strings:');
  console.error('  MONGO_URI=mongodb://127.0.0.1:27017/fairplay-fc?replicaSet=rs0&directConnection=true');
  console.error('  REDIS_URL=redis://127.0.0.1:6379');
}

main();
