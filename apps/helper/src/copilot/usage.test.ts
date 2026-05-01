import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCopilotToken } from './usage';

const tempHomes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempHomes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempCopilotHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'agent-pulse-copilot-usage-'));
  tempHomes.push(home);
  return home;
}

async function writeCopilotConfig(copilotHome: string, json: string): Promise<void> {
  await writeFile(path.join(copilotHome, 'config.json'), json);
}

describe('resolveCopilotToken', () => {
  it('reads plaintext tokens from the OpenAssist Copilot config shape', async () => {
    const copilotHome = await tempCopilotHome();
    const execFileImpl = vi.fn(async () => {
      throw new Error('unexpected process execution');
    });
    await writeCopilotConfig(
      copilotHome,
      JSON.stringify({
        store_token_plaintext: true,
        last_logged_in_user: {
          host: 'https://github.com',
          login: 'monalisa'
        },
        copilot_tokens: {
          'https://github.com:monalisa': 'config-token'
        }
      })
    );

    await expect(resolveCopilotToken(copilotHome, { env: {}, execFileImpl })).resolves.toBe('config-token');
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('prefers GitHub CLI before falling back to the security command', async () => {
    const copilotHome = await tempCopilotHome();
    const execFileImpl = vi.fn(async (file: string) => {
      if (file === 'gh') {
        return { stdout: 'gh-token\n', stderr: '' };
      }
      throw new Error('security should not run when gh already has a token');
    });
    await writeCopilotConfig(
      copilotHome,
      JSON.stringify({
        last_logged_in_user: {
          host: 'https://github.com',
          login: 'monalisa'
        },
        logged_in_users: [{ host: 'https://github.com', login: 'monalisa' }]
      })
    );

    await expect(resolveCopilotToken(copilotHome, { env: {}, execFileImpl })).resolves.toBe('gh-token');
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(execFileImpl).toHaveBeenCalledWith('gh', ['auth', 'token', '--hostname', 'github.com'], {
      timeout: 2500
    });
  });

  it('uses the stored OpenAssist account key when it must fall back to Keychain', async () => {
    const copilotHome = await tempCopilotHome();
    const execFileImpl = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'gh') {
        throw new Error('gh unavailable');
      }
      if (file === 'security' && args.includes('https://github.com:monalisa')) {
        return { stdout: 'keychain-token\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    });
    await writeCopilotConfig(
      copilotHome,
      JSON.stringify({
        last_logged_in_user: {
          host: 'https://github.com',
          login: 'monalisa'
        }
      })
    );

    await expect(resolveCopilotToken(copilotHome, { env: {}, execFileImpl })).resolves.toBe('keychain-token');
    expect(execFileImpl).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['auth', 'token', '--hostname', 'github.com'],
      { timeout: 2500 }
    );
    expect(execFileImpl).toHaveBeenNthCalledWith(
      2,
      'security',
      ['find-generic-password', '-w', '-s', 'copilot-cli', '-a', 'https://github.com:monalisa'],
      { timeout: 2500 }
    );
  });
});