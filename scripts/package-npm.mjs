#!/usr/bin/env node

import { access, chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const rootPackagePath = path.join(repoRoot, 'package.json');
const helperPackagePath = path.join(repoRoot, 'apps', 'helper', 'package.json');
const sharedPackagePath = path.join(repoRoot, 'packages', 'shared', 'package.json');
const helperDistDir = path.join(repoRoot, 'apps', 'helper', 'dist');
const tabletDistDir = path.join(repoRoot, 'apps', 'tablet', 'dist');
const stageDir = path.join(repoRoot, 'dist', 'npm', 'agent-pulse-helper');
const releaseDir = path.join(repoRoot, 'dist', 'release');

const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'));
const helperPackage = JSON.parse(await readFile(helperPackagePath, 'utf8'));
const sharedPackage = JSON.parse(await readFile(sharedPackagePath, 'utf8'));
const packageName = process.env.AGENT_PULSE_PACKAGE_NAME || '@agent-pulse/helper';
const version = process.env.AGENT_PULSE_PACKAGE_VERSION || rootPackage.version || helperPackage.version;
const releaseRepository = process.env.AGENT_PULSE_RELEASE_REPOSITORY || 'manikv12/AgentPulse';

await assertExists(path.join(helperDistDir, 'dev-server.js'), 'Run pnpm build before packaging.');
await assertExists(path.join(tabletDistDir, 'index.html'), 'Run pnpm build before packaging.');

await rm(stageDir, { recursive: true, force: true });
await mkdir(path.join(stageDir, 'bin'), { recursive: true });
await mkdir(path.join(stageDir, 'apps', 'helper'), { recursive: true });
await mkdir(path.join(stageDir, 'apps', 'tablet'), { recursive: true });
await mkdir(releaseDir, { recursive: true });

await cp(helperDistDir, path.join(stageDir, 'apps', 'helper', 'dist'), { recursive: true });
await cp(tabletDistDir, path.join(stageDir, 'apps', 'tablet', 'dist'), { recursive: true });

const binPath = path.join(stageDir, 'bin', 'agent-pulse.js');
await writeFile(
  binPath,
  "#!/usr/bin/env node\n\nimport '../apps/helper/dist/dev-server.js';\n",
  'utf8'
);
await chmod(binPath, 0o755);

const packageJson = {
  name: packageName,
  version,
  description:
    rootPackage.description || 'Agent Pulse helper for local coding agent supervision.',
  type: 'module',
  main: './apps/helper/dist/dev-server.js',
  bin: {
    'agent-pulse': './bin/agent-pulse.js'
  },
  files: ['apps/', 'bin/', 'README.md'],
  scripts: {
    start: 'agent-pulse'
  },
  engines: {
    node: '>=22.0.0'
  },
  os: ['darwin', 'win32'],
  license: rootPackage.license || helperPackage.license || 'UNLICENSED',
  keywords: ['agent-pulse', 'codex', 'claude-code', 'local-first', 'helper'],
  dependencies: withoutWorkspaceDependencies({
    ...sharedPackage.dependencies,
    ...helperPackage.dependencies
  })
};

await writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
await writeFile(
  path.join(stageDir, 'README.md'),
  packageReadme(packageName, version, releaseRepository),
  'utf8'
);

const packOutput = await run('npm', ['pack', stageDir, '--pack-destination', releaseDir, '--json']);
const packed = JSON.parse(packOutput)[0];
const tarballPath = path.resolve(releaseDir, packed.filename);

console.log('');
console.log('Created Agent Pulse npm package:');
console.log(`  ${path.relative(repoRoot, tarballPath)}`);
console.log('');
console.log('Local install test:');
console.log(`  npm install -g ./${path.relative(repoRoot, tarballPath)}`);
console.log('  agent-pulse');
console.log('');
console.log('GitHub Release install example:');
console.log(
  `  npm install -g https://github.com/${releaseRepository}/releases/download/v${version}/${packed.filename}`
);
console.log('  agent-pulse');

async function assertExists(filePath, helpText) {
  try {
    await access(filePath, constants.F_OK);
  } catch {
    throw new Error(`Missing ${path.relative(repoRoot, filePath)}. ${helpText}`);
  }
}

function withoutWorkspaceDependencies(dependencies = {}) {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([, versionRange]) => {
      return !String(versionRange).startsWith('workspace:');
    })
  );
}

function packageReadme(name, packageVersion, repository) {
  const tarballName = `${name.replace('@', '').replace('/', '-')}-${packageVersion}.tgz`;
  return `# Agent Pulse Helper

This is the npm release package for the Agent Pulse helper.

## Install From A GitHub Release

\`\`\`bash
npm install -g https://github.com/${repository}/releases/download/v${packageVersion}/${tarballName}
agent-pulse
\`\`\`

The helper runs on macOS and Windows. It prints the local settings URL after it starts.

## Single Instance Behavior

Only one Agent Pulse helper should run at a time. If another copy is already running, this command exits and prints the existing process id.

Default lock file locations:

\`\`\`text
macOS: ~/Library/Application Support/Agent Pulse/helper.lock
Windows: %APPDATA%\\Agent Pulse\\helper.lock
\`\`\`
`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: process.platform === 'win32'
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}
