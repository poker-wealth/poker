#!/usr/bin/env node
// Stop local MongoDB + Redis. Data persists in named volumes; use
// `docker compose down -v` to wipe volumes.

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const composeDir = resolve(__dirname, '..', '..');

const r = spawnSync('docker', ['compose', 'down'], { stdio: 'inherit', cwd: composeDir });
process.exit(r.status ?? 1);
