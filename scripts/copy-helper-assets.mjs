#!/usr/bin/env node

import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(
  repoRoot,
  'apps',
  'helper',
  'src',
  'codex',
  'scripts',
  'codex-refresh.applescript'
);
const target = path.join(
  repoRoot,
  'apps',
  'helper',
  'dist',
  'codex',
  'scripts',
  'codex-refresh.applescript'
);

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);
