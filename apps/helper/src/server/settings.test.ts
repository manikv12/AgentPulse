import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HelperSettingsStore } from './settings';

describe('HelperSettingsStore remote access settings', () => {
  it('adds remote access defaults when creating settings', async () => {
    const store = new HelperSettingsStore(await tempSettingsPath());

    const settings = await store.load();

    expect(settings.remoteAccess).toMatchObject({
      enabled: false,
      provider: 'cloudflare',
      mode: 'quick',
      hostname: '',
      publicUrl: '',
      tunnelName: 'agent-pulse',
      tunnelId: '',
      status: 'off',
      checklist: {
        dependencyInstalled: false,
        authenticated: false,
        configured: false,
        tunnelRunning: false,
        hostnameAssigned: false
      }
    });
    expect(settings.appearance).toEqual({
      codexThemes: {},
      themePreference: 'system'
    });
    expect(settings.remoteAccess.configPath).toContain('cloudflared/config.yml');
    expect(settings.remoteAccess.metricsUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/metrics$/);
  });

  it('migrates older settings without losing LAN or mobile-send preferences', async () => {
    const settingsPath = await tempSettingsPath();
    await writeFile(
      settingsPath,
      `${JSON.stringify({ port: 54123, lanEnabled: true, mobileSendEnabled: true })}\n`,
      'utf8'
    );
    const store = new HelperSettingsStore(settingsPath);

    const settings = await store.load();

    expect(settings.port).toBe(54123);
    expect(settings.lanEnabled).toBe(true);
    expect(settings.mobileSendEnabled).toBe(true);
    expect(settings.appearance?.themePreference).toBe('system');
    expect(settings.remoteAccess.provider).toBe('cloudflare');
    expect(settings.remoteAccess.mode).toBe('quick');
    expect(settings.remoteAccess.enabled).toBe(false);

    const saved = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      appearance?: { themePreference?: string };
      remoteAccess?: { provider?: string };
    };
    expect(saved.appearance?.themePreference).toBe('system');
    expect(saved.remoteAccess?.provider).toBe('cloudflare');
  });

  it('recovers from an empty settings file by rewriting valid defaults', async () => {
    const settingsPath = await tempSettingsPath();
    await writeFile(settingsPath, '', 'utf8');
    const store = new HelperSettingsStore(settingsPath);

    const settings = await store.load();

    expect(settings.port).toBeGreaterThan(0);
    expect(settings.remoteAccess.provider).toBe('cloudflare');

    const saved = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      port?: number;
      remoteAccess?: { provider?: string };
    };
    expect(saved.port).toBe(settings.port);
    expect(saved.remoteAccess?.provider).toBe('cloudflare');
  });

  it('allows overlapping saves without corrupting the settings file', async () => {
    const settingsPath = await tempSettingsPath();
    const store = new HelperSettingsStore(settingsPath);
    const base = await store.load();

    await Promise.all([
      store.save({ ...base, mobileSendEnabled: true }),
      store.save({ ...base, lanEnabled: true })
    ]);

    const saved = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      port?: number;
      lanEnabled?: boolean;
      mobileSendEnabled?: boolean;
    };

    expect(saved.port).toBe(base.port);
    expect(typeof saved.lanEnabled).toBe('boolean');
    expect(typeof saved.mobileSendEnabled).toBe('boolean');
  });

  it('restores settings from the backup file when the primary file is invalid', async () => {
    const settingsPath = await tempSettingsPath();
    const store = new HelperSettingsStore(settingsPath);
    const base = await store.load();
    const savedSettings = {
      ...base,
      port: 55110,
      lanEnabled: true,
      remoteAccess: {
        ...base.remoteAccess,
        enabled: true,
        mode: 'named' as const,
        hostname: 'pulse.developingadventures.com',
        publicUrl: 'https://pulse.developingadventures.com',
        tunnelId: 'c222ba6a-fe12-410a-bca6-22f2bba7422f'
      }
    };
    await store.save(savedSettings);
    await writeFile(settingsPath, '', 'utf8');

    const loaded = await store.load();

    expect(loaded.port).toBe(55110);
    expect(loaded.lanEnabled).toBe(true);
    expect(loaded.remoteAccess.enabled).toBe(true);
    expect(loaded.remoteAccess.mode).toBe('named');

    const rewritten = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      port?: number;
      remoteAccess?: { enabled?: boolean; mode?: string };
    };
    expect(rewritten.port).toBe(55110);
    expect(rewritten.remoteAccess?.enabled).toBe(true);
    expect(rewritten.remoteAccess?.mode).toBe('named');
  });
});

async function tempSettingsPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-pulse-settings-'));
  return path.join(dir, 'settings.json');
}
