import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import {
  AGENT_PROVIDERS,
  AgentProviderSchema,
  AppearanceSettingsSchema,
  type AgentProvider,
  type AppearanceSettings,
  type RemoteAccessSettings
} from '@agent-pulse/shared';

export type HelperSettings = {
  port: number;
  lanEnabled: boolean;
  mobileSendEnabled: boolean;
  enabledProviders?: AgentProvider[];
  appearance?: AppearanceSettings;
  remoteAccess: RemoteAccessSettings;
};

export class HelperSettingsStore {
  constructor(
    private readonly settingsPath = path.join(
      homedir(),
      'Library',
      'Application Support',
      'Agent Pulse',
      'settings.json'
    )
  ) {}

  async load(): Promise<HelperSettings> {
    const primary = await this.readMergedSettings(this.settingsPath);
    if (primary) {
      await this.save(primary);
      return primary;
    }

    const backup = await this.readMergedSettings(this.backupPath());
    if (backup) {
      await this.save(backup);
      return backup;
    }

    const settings = await defaultSettings(this.settingsPath);
    await this.save(settings);
    return settings;
  }

  async save(settings: HelperSettings): Promise<void> {
    const serialized = `${JSON.stringify(settings, null, 2)}\n`;
    await this.writeAtomic(this.settingsPath, serialized);
    await this.writeAtomic(this.backupPath(), serialized);
  }

  private backupPath(): string {
    return `${this.settingsPath}.bak`;
  }

  private async readMergedSettings(targetPath: string): Promise<HelperSettings | undefined> {
    try {
      const content = await readFile(targetPath, 'utf8');
      return mergeSettings(JSON.parse(content) as Partial<HelperSettings>, this.settingsPath);
    } catch {
      return undefined;
    }
  }

  private async writeAtomic(targetPath: string, content: string): Promise<void> {
    await mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, targetPath);
  }
}

async function mergeSettings(
  stored: Partial<HelperSettings>,
  settingsPath: string
): Promise<HelperSettings> {
  const defaults = await defaultSettings(settingsPath);
  return {
    ...defaults,
    ...stored,
    appearance: normalizeAppearanceSettings(stored.appearance),
    enabledProviders: normalizeEnabledProviders(stored.enabledProviders),
    remoteAccess: {
      ...defaults.remoteAccess,
      ...(stored.remoteAccess ?? {}),
      checklist: {
        ...defaults.remoteAccess.checklist,
        ...(stored.remoteAccess?.checklist ?? {})
      }
    }
  };
}

async function defaultSettings(settingsPath: string): Promise<HelperSettings> {
  const metricsPort = await pickFreeHighPort();
  return {
    port: await pickFreeHighPort(),
    lanEnabled: false,
    mobileSendEnabled: false,
    enabledProviders: [...AGENT_PROVIDERS],
    appearance: defaultAppearanceSettings(),
    remoteAccess: {
      enabled: false,
      provider: 'cloudflare',
      mode: 'quick',
      tunnelProtocol: 'auto',
      hostname: '',
      publicUrl: '',
      tunnelName: 'agent-pulse',
      tunnelId: '',
      configPath: path.join(path.dirname(settingsPath), 'cloudflared', 'config.yml'),
      metricsUrl: `http://127.0.0.1:${metricsPort}/metrics`,
      status: 'off',
      lastError: '',
      lastStartedAt: null,
      lastStoppedAt: null,
      lastCheckedAt: null,
      checklist: {
        dependencyInstalled: false,
        authenticated: false,
        configured: false,
        tunnelRunning: false,
        hostnameAssigned: false
      }
    }
  };
}

export function normalizeEnabledProviders(input: unknown): AgentProvider[] {
  if (!Array.isArray(input)) {
    return [...AGENT_PROVIDERS];
  }

  const providers = input
    .map((provider) => AgentProviderSchema.safeParse(provider))
    .filter((result): result is { success: true; data: AgentProvider } => result.success)
    .map((result) => result.data);
  const uniqueProviders = [...new Set(providers)];

  return uniqueProviders.length > 0 ? uniqueProviders : [...AGENT_PROVIDERS];
}

export function defaultAppearanceSettings(): AppearanceSettings {
  return {
    codexThemes: {},
    themePreference: 'system'
  };
}

export function normalizeAppearanceSettings(input: unknown): AppearanceSettings {
  return AppearanceSettingsSchema.catch(defaultAppearanceSettings()).parse(input);
}

export async function pickFreeHighPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address?.port) {
          resolve(address.port);
          return;
        }

        reject(new Error('Could not find a free port.'));
      });
    });
    server.on('error', reject);
  });
}
