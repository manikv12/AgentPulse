import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ThreadUsageSchema, type ThreadUsage } from '@agent-pulse/shared';

const execFileAsync = promisify(execFile);
const COPILOT_USAGE_URL = 'https://api.github.com/copilot_internal/user';
const CACHE_TTL_MS = 5 * 60_000;

type ExecFileAsyncLike = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number }
) => Promise<{ stdout: string; stderr: string }>;

type CopilotTokenResolverOptions = {
  env?: NodeJS.ProcessEnv;
  execFileImpl?: ExecFileAsyncLike;
};

type CopilotConfigTokenLookup = {
  token?: string;
  keychainAccounts: string[];
};

type CopilotUsageReaderOptions = {
  copilotHome?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
};

export class CopilotUsageReader {
  private readonly copilotHome: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private cached?: { loadedAt: number; value?: ThreadUsage };

  constructor(options: CopilotUsageReaderOptions = {}) {
    this.copilotHome = options.copilotHome ?? path.join(homedir(), '.copilot');
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async readUsage(): Promise<ThreadUsage | undefined> {
    if (this.cached && this.now() - this.cached.loadedAt < CACHE_TTL_MS) {
      return this.cached.value;
    }
    const value = await this.readFreshUsage().catch(() => undefined);
    this.cached = { loadedAt: this.now(), value };
    return value;
  }

  private async readFreshUsage(): Promise<ThreadUsage | undefined> {
    const token = await resolveCopilotToken(this.copilotHome);
    if (!token) {
      return undefined;
    }
    const response = await this.fetchImpl(COPILOT_USAGE_URL, {
      headers: {
        authorization: `token ${token}`,
        accept: 'application/json',
        'editor-version': 'vscode/1.96.2',
        'editor-plugin-version': 'copilot-chat/0.26.7',
        'user-agent': 'GitHubCopilotChat/0.26.7',
        'x-github-api-version': '2025-04-01'
      }
    });
    if (!response.ok) {
      return undefined;
    }
    return usageFromCopilotPayload(await response.json());
  }
}

export async function resolveCopilotToken(
  copilotHome = path.join(homedir(), '.copilot'),
  options: CopilotTokenResolverOptions = {}
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const execFileImpl = options.execFileImpl ?? execFileAsync;
  const envToken = env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (envToken?.trim()) {
    return envToken.trim();
  }

  const configLookup = await readTokenFromCopilotConfig(path.join(copilotHome, 'config.json'));
  if (configLookup.token) {
    return configLookup.token;
  }

  const ghToken = await readTokenFromGhCli(env, execFileImpl);
  if (ghToken) {
    return ghToken;
  }

  const keychainToken = await readTokenFromKeychain(configLookup.keychainAccounts, execFileImpl);
  if (keychainToken) {
    return keychainToken;
  }

  return undefined;
}

function usageFromCopilotPayload(payload: unknown): ThreadUsage | undefined {
  const record = asRecord(payload);
  const snapshots = asRecord(record?.quota_snapshots);
  const premium = quotaWindow(asRecord(snapshots?.premium_interactions), 'Premium');
  const chat = quotaWindow(asRecord(snapshots?.chat), 'Chat');
  if (!premium && !chat) {
    return undefined;
  }
  return ThreadUsageSchema.parse({
    ...(premium ? { primaryWindow: premium } : {}),
    ...(chat ? { secondaryWindow: chat } : {}),
    planType: stringField(record, 'sku') ?? stringField(record, 'plan_type') ?? 'Copilot'
  });
}

function quotaWindow(snapshot: Record<string, unknown> | undefined, label: string) {
  if (!snapshot) {
    return undefined;
  }
  if (snapshot.unlimited === true) {
    return { label, usedPercent: 0 };
  }
  const percentRemaining =
    numberField(snapshot, 'percent_remaining') ??
    numberField(snapshot, 'percentage_remaining') ??
    numberField(snapshot, 'remaining_percent');
  if (percentRemaining !== undefined) {
    return { label, usedPercent: Math.max(0, Math.min(100, Math.round(100 - percentRemaining))) };
  }
  const used = numberField(snapshot, 'used');
  const quota = numberField(snapshot, 'quota') ?? numberField(snapshot, 'limit');
  if (used !== undefined && quota && quota > 0) {
    return { label, usedPercent: Math.max(0, Math.min(100, Math.round((used / quota) * 100))) };
  }
  return undefined;
}

async function readTokenFromCopilotConfig(configPath: string): Promise<CopilotConfigTokenLookup> {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const directToken =
      stringField(parsed, 'github_token') ??
      stringField(parsed, 'githubToken') ??
      stringField(parsed, 'oauth_token') ??
      stringField(parsed, 'token');
    if (directToken) {
      return { token: directToken, keychainAccounts: [] };
    }
    const auth = asRecord(parsed.auth) ?? asRecord(parsed.github);
    const authToken = stringField(auth, 'token') ?? stringField(auth, 'oauth_token');
    if (authToken) {
      return { token: authToken, keychainAccounts: [] };
    }

    const keychainAccounts = storedCopilotAccounts(parsed);
    if (parsed.store_token_plaintext === true) {
      const copilotTokens = asRecord(parsed.copilot_tokens);
      for (const account of keychainAccounts) {
        const token = stringField(copilotTokens, account);
        if (token) {
          return { token, keychainAccounts: [] };
        }
      }
      for (const value of Object.values(copilotTokens ?? {})) {
        if (typeof value === 'string' && value.trim()) {
          return { token: value.trim(), keychainAccounts: [] };
        }
      }
    }

    return { keychainAccounts };
  } catch {
    return { keychainAccounts: [] };
  }
}

async function readTokenFromKeychain(
  keychainAccounts: string[],
  execFileImpl: ExecFileAsyncLike
): Promise<string | undefined> {
  const attempts = dedupeAttempts([
    ...keychainAccounts.map((account) => ['find-generic-password', '-w', '-s', 'copilot-cli', '-a', account]),
    ['find-generic-password', '-w', '-s', 'copilot-cli', '-a', 'github.com'],
    ['find-generic-password', '-w', '-s', 'copilot-cli']
  ]);
  for (const args of attempts) {
    try {
      const { stdout } = await execFileImpl('security', args, { timeout: 2500 });
      const token = stdout.trim();
      if (token) {
        return token;
      }
    } catch {
      // Try the next source.
    }
  }
  return undefined;
}

async function readTokenFromGhCli(env: NodeJS.ProcessEnv, execFileImpl: ExecFileAsyncLike): Promise<string | undefined> {
  try {
    const { stdout } = await execFileImpl('gh', ['auth', 'token', '--hostname', githubHostname(env)], {
      timeout: 2500
    });
    const token = stdout.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function storedCopilotAccounts(config: Record<string, unknown>): string[] {
  const accounts: string[] = [];
  const seen = new Set<string>();

  const append = (value: unknown) => {
    const record = asRecord(value);
    const host = stringField(record, 'host');
    const login = stringField(record, 'login');
    if (!host || !login) {
      return;
    }
    const storageKey = `${host}:${login}`;
    const dedupeKey = storageKey.toLowerCase();
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      accounts.push(storageKey);
    }
  };

  append(config.last_logged_in_user);
  const loggedInUsers = Array.isArray(config.logged_in_users) ? config.logged_in_users : [];
  for (const user of loggedInUsers) {
    append(user);
  }

  return accounts;
}

function githubHostname(env: NodeJS.ProcessEnv): string {
  const rawHost = env.GH_HOST?.trim();
  if (!rawHost) {
    return 'github.com';
  }
  try {
    const parsed = new URL(rawHost);
    return parsed.host || rawHost;
  } catch {
    return rawHost;
  }
}

function dedupeAttempts(attempts: string[][]): string[][] {
  const seen = new Set<string>();
  return attempts.filter((args) => {
    const key = args.join('\u0000');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
