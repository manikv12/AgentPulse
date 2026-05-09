import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ThreadUsageSchema, type ThreadUsage } from '@agent-pulse/shared';
import { agentPulseDataPath } from '../platform/paths';

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_USER_AGENT = 'claude-code/2.1.0';
const USAGE_CACHE_TTL_MS = 60_000;
const STALE_WINDOW_GRACE_SEC = 60;

type ClaudeOAuthCredentials = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  rateLimitTier?: string;
  subscriptionType?: string;
};

type StoredCredentialsEnvelope = {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    rateLimitTier?: string;
    subscriptionType?: string;
  };
};

type ClaudeUsageResponse = {
  five_hour?: ClaudeUsageWindow | null;
  seven_day?: ClaudeUsageWindow | null;
  seven_day_sonnet?: ClaudeUsageWindow | null;
  seven_day_opus?: ClaudeUsageWindow | null;
};

type ClaudeUsageWindow = {
  utilization?: number | null;
  resets_at?: string | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

export class ClaudeCodeUsageReader {
  private cached?: { loadedAt: number; value?: ThreadUsage };

  async readUsage(): Promise<ThreadUsage | undefined> {
    if (this.cached && Date.now() - this.cached.loadedAt < USAGE_CACHE_TTL_MS) {
      return this.cached.value;
    }

    const value = await this.readFreshUsage().catch(() => undefined);
    this.cached = { loadedAt: Date.now(), value };
    return value;
  }

  private async readFreshUsage(): Promise<ThreadUsage | undefined> {
    const credentials = await this.resolveCredentials();
    if (credentials) {
      const fresh = await this.fetchUsageWithRefresh(credentials).catch(() => undefined);
      if (fresh) {
        return fresh;
      }
    }

    return this.readCachedUsageResponse();
  }

  private async fetchUsageWithRefresh(credentials: ClaudeOAuthCredentials): Promise<ThreadUsage | undefined> {
    let effectiveCredentials = credentials;
    if (isExpired(credentials) && credentials.refreshToken) {
      effectiveCredentials = await this.refreshCredentials(credentials);
      await this.persistCredentials(effectiveCredentials).catch(() => undefined);
    }

    const fetched = await this.fetchUsage(effectiveCredentials).catch(async (error) => {
      if (!isAuthError(error) || !effectiveCredentials.refreshToken) {
        throw error;
      }
      const refreshed = await this.refreshCredentials(effectiveCredentials);
      await this.persistCredentials(refreshed).catch(() => undefined);
      return this.fetchUsage(refreshed);
    });
    return fetched;
  }

  private async fetchUsage(credentials: ClaudeOAuthCredentials): Promise<ThreadUsage | undefined> {
    const response = await fetch(CLAUDE_USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': CLAUDE_USER_AGENT
      }
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthError();
    }
    if (!response.ok) {
      throw new Error(`Claude usage request failed with ${response.status}.`);
    }
    const payload = (await response.json()) as ClaudeUsageResponse;
    return usageFromResponse(payload, credentials.subscriptionType);
  }

  private async refreshCredentials(credentials: ClaudeOAuthCredentials): Promise<ClaudeOAuthCredentials> {
    if (!credentials.refreshToken) {
      throw new AuthError();
    }

    const response = await fetch(CLAUDE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID
      })
    });
    if (!response.ok) {
      throw new AuthError();
    }
    const payload = (await response.json()) as TokenResponse;
    if (!payload.access_token) {
      throw new AuthError();
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token?.trim() || credentials.refreshToken,
      expiresAt:
        typeof payload.expires_in === 'number'
          ? new Date(Date.now() + Math.max(60, payload.expires_in) * 1000)
          : credentials.expiresAt,
      rateLimitTier: credentials.rateLimitTier,
      subscriptionType: credentials.subscriptionType
    };
  }

  private async resolveCredentials(): Promise<ClaudeOAuthCredentials | undefined> {
    const fileCredentials = await this.readStoredCredentials();
    if (fileCredentials) {
      return fileCredentials;
    }
    return this.readKeychainCredentials();
  }

  private async readStoredCredentials(): Promise<ClaudeOAuthCredentials | undefined> {
    for (const filePath of candidateCredentialPaths()) {
      const parsed = await readCredentialsFile(filePath);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  private async readKeychainCredentials(): Promise<ClaudeOAuthCredentials | undefined> {
    if (platform() !== 'darwin') {
      return undefined;
    }
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 2_000, maxBuffer: 512 * 1024 }
      );
      return parseCredentials(stdout);
    } catch {
      return undefined;
    }
  }

  private async readCachedUsageResponse(): Promise<ThreadUsage | undefined> {
    for (const filePath of candidateUsageCachePaths()) {
      try {
        const payload = JSON.parse(await readFile(filePath, 'utf8')) as ClaudeUsageResponse;
        const usage = usageFromResponse(payload, undefined);
        if (usage) {
          return usage;
        }
      } catch {
        // Try the next known Claude config location.
      }
    }
    return undefined;
  }

  private async persistCredentials(credentials: ClaudeOAuthCredentials): Promise<void> {
    const targetPath = agentPulseCredentialCachePath();
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const envelope: StoredCredentialsEnvelope = {
      claudeAiOauth: {
        accessToken: credentials.accessToken,
        ...(credentials.refreshToken ? { refreshToken: credentials.refreshToken } : {}),
        ...(credentials.expiresAt ? { expiresAt: credentials.expiresAt.getTime() } : {}),
        ...(credentials.rateLimitTier ? { rateLimitTier: credentials.rateLimitTier } : {}),
        ...(credentials.subscriptionType ? { subscriptionType: credentials.subscriptionType } : {})
      }
    };
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    await rename(tempPath, targetPath);
  }
}

function candidateCredentialPaths(): string[] {
  return [
    agentPulseCredentialCachePath(),
    path.join(homedir(), 'Library', 'Application Support', 'OpenAssist', 'ClaudeCodeOAuthCache.json'),
    ...candidateConfigRoots().map((root) => path.join(root, '.credentials.json'))
  ];
}

function candidateUsageCachePaths(): string[] {
  return candidateConfigRoots().map((root) => path.join(root, 'usage-cache.json'));
}

function candidateConfigRoots(): string[] {
  const roots: string[] = [];
  const configuredRoots = process.env.CLAUDE_CONFIG_DIR
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configuredRoots) {
    roots.push(...configuredRoots);
  }
  if (process.env.XDG_CONFIG_HOME?.trim()) {
    roots.push(path.join(process.env.XDG_CONFIG_HOME.trim(), 'claude'));
  }
  roots.push(path.join(homedir(), '.claude'));
  roots.push(path.join(homedir(), '.config', 'claude'));
  return [...new Set(roots)];
}

function agentPulseCredentialCachePath(): string {
  return agentPulseDataPath('ClaudeCodeOAuthCache.json');
}

async function readCredentialsFile(filePath: string): Promise<ClaudeOAuthCredentials | undefined> {
  try {
    return parseCredentials(await readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseCredentials(rawValue: string): ClaudeOAuthCredentials | undefined {
  let envelope: StoredCredentialsEnvelope;
  try {
    envelope = JSON.parse(rawValue) as StoredCredentialsEnvelope;
  } catch {
    return undefined;
  }
  const oauth = envelope.claudeAiOauth;
  const accessToken = oauth?.accessToken?.trim();
  if (!accessToken) {
    return undefined;
  }
  return {
    accessToken,
    ...(oauth?.refreshToken?.trim() ? { refreshToken: oauth.refreshToken.trim() } : {}),
    ...(typeof oauth?.expiresAt === 'number' ? { expiresAt: new Date(oauth.expiresAt) } : {}),
    ...(oauth?.rateLimitTier?.trim() ? { rateLimitTier: oauth.rateLimitTier.trim() } : {}),
    ...(oauth?.subscriptionType?.trim() ? { subscriptionType: oauth.subscriptionType.trim() } : {})
  };
}

function usageFromResponse(
  response: ClaudeUsageResponse,
  planType: string | undefined
): ThreadUsage | undefined {
  const primary = windowFromUsage(response.five_hour, 300);
  const secondary = windowFromUsage(response.seven_day, 10_080);
  if (!primary && !secondary) {
    return undefined;
  }
  return ThreadUsageSchema.parse({
    ...(primary ? { primaryWindow: primary } : {}),
    ...(secondary ? { secondaryWindow: secondary } : {}),
    ...(planType?.trim() ? { planType: planType.trim() } : {})
  });
}

function windowFromUsage(
  window: ClaudeUsageWindow | null | undefined,
  windowMinutes: number
): { usedPercent: number; windowMinutes: number; resetsAt?: number } | undefined {
  if (typeof window?.utilization !== 'number' || !Number.isFinite(window.utilization)) {
    return undefined;
  }
  const resetsAt = parseDateSeconds(window.resets_at);
  if (resetsAt && resetsAt + STALE_WINDOW_GRACE_SEC < Date.now() / 1000) {
    return undefined;
  }
  return {
    usedPercent: Math.max(0, Math.min(100, window.utilization)),
    windowMinutes,
    ...(resetsAt ? { resetsAt } : {})
  };
}

function parseDateSeconds(value: string | null | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? undefined : Math.floor(millis / 1000);
}

function isExpired(credentials: ClaudeOAuthCredentials): boolean {
  return Boolean(credentials.expiresAt && credentials.expiresAt.getTime() <= Date.now() + 60_000);
}

class AuthError extends Error {}

function isAuthError(error: unknown): boolean {
  return error instanceof AuthError;
}
