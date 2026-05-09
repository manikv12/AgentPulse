import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { HelperSettingsStore } from './settings';
import { CloudflareTunnelSupervisor } from './cloudflare-tunnel';
import type { HelperSettings } from './settings';

describe('CloudflareTunnelSupervisor', () => {
  it('reports cloudflared as missing without starting a tunnel', async () => {
    const settings = await createSettings();
    const store = createSettingsStore();
    const supervisor = new CloudflareTunnelSupervisor({
      settings,
      settingsStore: store,
      helperPort: settings.port,
      execFile: vi.fn((_file, _args, callback) => {
        callback(new Error('not found'));
      }),
      spawn: vi.fn()
    });

    const checked = await supervisor.check();

    expect(checked.checklist.dependencyInstalled).toBe(false);
    expect(checked.status).toBe('off');
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ remoteAccess: checked }));
  });

  it('treats quick tunnels as configured without Cloudflare login or hostname', async () => {
    const settings = await createSettings({ mode: 'quick' });
    const store = createSettingsStore();
    const supervisor = new CloudflareTunnelSupervisor({
      settings,
      settingsStore: store,
      helperPort: settings.port,
      execFile: successfulExecFile,
      certPath: path.join(tmpdir(), 'missing-cert.pem'),
      spawn: vi.fn()
    });

    const checked = await supervisor.check();

    expect(checked.checklist).toMatchObject({
      dependencyInstalled: true,
      authenticated: true,
      configured: true,
      hostnameAssigned: false,
      tunnelRunning: false
    });
    expect(checked.lastError).toBe('');
  });

  it('starts a quick tunnel and captures the random trycloudflare URL', async () => {
    const settings = await createSettings({ enabled: true, mode: 'quick', tunnelProtocol: 'http2' });
    const child = createChildProcess();
    const spawn = vi.fn(() => child);
    const supervisor = new CloudflareTunnelSupervisor({
      settings,
      settingsStore: createSettingsStore(),
      helperPort: settings.port,
      execFile: successfulExecFile,
      spawn
    });

    const startedPromise = supervisor.setEnabled(true);
    await Promise.resolve();
    await Promise.resolve();
    child.stderr.emit('data', 'Your quick Tunnel has been created! https://gentle-river.trycloudflare.com');
    const started = await startedPromise;

    expect(spawn).toHaveBeenCalledWith('cloudflared', [
      'tunnel',
      '--protocol',
      'http2',
      '--metrics',
      '127.0.0.1:60123',
      '--url',
      'http://127.0.0.1:54123'
    ], expect.objectContaining({ stdio: expect.any(Array) }));
    expect(started).toMatchObject({
      status: 'healthy',
      publicUrl: 'https://gentle-river.trycloudflare.com',
      hostname: 'gentle-river.trycloudflare.com',
      checklist: {
        dependencyInstalled: true,
        authenticated: true,
        configured: true,
        tunnelRunning: true,
        hostnameAssigned: true
      }
    });
  });

  it('reads the assigned quick tunnel URL from metrics when startup output omits it', async () => {
    const settings = await createSettings({ enabled: true, mode: 'quick' });
    const child = createChildProcess();
    const supervisor = new CloudflareTunnelSupervisor({
      settings,
      settingsStore: createSettingsStore(),
      helperPort: settings.port,
      execFile: successfulExecFile,
      spawn: vi.fn(() => child),
      quickUrlTimeoutMs: 0,
      fetchText: vi.fn(async () =>
        [
          '# HELP cloudflared_tunnel_user_hostnames_counts Which user hostnames cloudflared is serving',
          'cloudflared_tunnel_user_hostnames_counts{userHostname="https://shade-alleged-earrings-rick.trycloudflare.com"} 1'
        ].join('\n')
      )
    });

    const startedPromise = supervisor.setEnabled(true);
    await Promise.resolve();
    await Promise.resolve();
    const started = await startedPromise;

    expect(started.publicUrl).toBe('https://shade-alleged-earrings-rick.trycloudflare.com');
    expect(started.checklist.hostnameAssigned).toBe(true);
  });

  it('writes a Cloudflare ingress config for the helper loopback port', async () => {
    const settings = await createSettings({
      mode: 'named',
      hostname: 'pulse.example.com',
      publicUrl: 'https://pulse.example.com',
      tunnelName: 'agent-pulse',
      tunnelId: '11111111-2222-3333-4444-555555555555'
    });
    const supervisor = new CloudflareTunnelSupervisor({
      settings,
      settingsStore: createSettingsStore(),
      helperPort: settings.port,
      execFile: successfulExecFile,
      spawn: vi.fn()
    });

    await supervisor.writeConfig();

    await expect(readFile(settings.remoteAccess.configPath, 'utf8')).resolves.toContain(
      'service: http://127.0.0.1:54123'
    );
    await expect(readFile(settings.remoteAccess.configPath, 'utf8')).resolves.toContain(
      'hostname: pulse.example.com'
    );
    await expect(readFile(settings.remoteAccess.configPath, 'utf8')).resolves.toContain(
      'service: http_status:404'
    );
  });

  it('starts cloudflared with config and metrics arguments', async () => {
    const settings = await createSettings({
      enabled: true,
      mode: 'named',
      tunnelProtocol: 'quic',
      hostname: 'pulse.example.com',
      publicUrl: 'https://pulse.example.com',
      tunnelName: 'agent-pulse',
      tunnelId: '11111111-2222-3333-4444-555555555555'
    });
    const child = createChildProcess();
    const spawn = vi.fn(() => child);
    const supervisor = new CloudflareTunnelSupervisor({
      settings,
      settingsStore: createSettingsStore(),
      helperPort: settings.port,
      execFile: successfulExecFile,
      spawn
    });

    const started = await supervisor.setEnabled(true);

    expect(started.status).toBe('healthy');
    expect(spawn).toHaveBeenCalledWith('cloudflared', [
      'tunnel',
      '--protocol',
      'quic',
      '--config',
      settings.remoteAccess.configPath,
      '--metrics',
      '127.0.0.1:60123',
      'run',
      'agent-pulse'
    ], expect.objectContaining({ stdio: expect.any(Array) }));
  });

  it('ignores informational stderr logs for named tunnels', async () => {
    const settings = await createSettings({
      enabled: true,
      mode: 'named',
      hostname: 'pulse.example.com',
      publicUrl: 'https://pulse.example.com',
      tunnelName: 'agent-pulse',
      tunnelId: '11111111-2222-3333-4444-555555555555'
    });
    const child = createChildProcess();
    const supervisor = new CloudflareTunnelSupervisor({
      settings,
      settingsStore: createSettingsStore(),
      helperPort: settings.port,
      execFile: successfulExecFile,
      spawn: vi.fn(() => child)
    });

    await supervisor.setEnabled(true);
    child.stderr.emit('data', '2026-04-27T01:48:39Z INF Registered tunnel connection connIndex=3');
    await Promise.resolve();

    expect(supervisor.getStatus()).toMatchObject({
      status: 'healthy',
      lastError: ''
    });
  });

  it('keeps named tunnels healthy when clients cancel long requests', async () => {
    const settings = await createSettings({
      enabled: true,
      mode: 'named',
      hostname: 'pulse.example.com',
      publicUrl: 'https://pulse.example.com',
      tunnelName: 'agent-pulse',
      tunnelId: '11111111-2222-3333-4444-555555555555'
    });
    const child = createChildProcess();
    const supervisor = new CloudflareTunnelSupervisor({
      settings,
      settingsStore: createSettingsStore(),
      helperPort: settings.port,
      execFile: successfulExecFile,
      spawn: vi.fn(() => child)
    });

    await supervisor.setEnabled(true);
    child.stderr.emit(
      'data',
      '2026-05-08T18:59:37Z ERR error="Incoming request ended abruptly: context canceled" type=http'
    );
    await Promise.resolve();

    expect(supervisor.getStatus()).toMatchObject({
      status: 'healthy',
      lastError: ''
    });
  });

  it('stops the running process without turning the saved remote switch off', async () => {
    const settings = await createSettings({
      enabled: true,
      mode: 'named',
      hostname: 'pulse.example.com',
      publicUrl: 'https://pulse.example.com',
      tunnelName: 'agent-pulse',
      tunnelId: '11111111-2222-3333-4444-555555555555'
    });
    const child = createChildProcess();
    const store = createSettingsStore();
    const supervisor = new CloudflareTunnelSupervisor({
      settings,
      settingsStore: store,
      helperPort: settings.port,
      execFile: successfulExecFile,
      spawn: vi.fn(() => child)
    });

    await supervisor.setEnabled(true);
    await supervisor.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(store.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        remoteAccess: expect.objectContaining({
          enabled: true,
          status: 'disconnected'
        })
      })
    );
  });
});

async function createSettings(
  remote: Partial<HelperSettings['remoteAccess']> = {}
): Promise<HelperSettings> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-pulse-cloudflare-'));
  return {
    port: 54123,
    lanEnabled: false,
    mobileSendEnabled: false,
    remoteAccess: {
      enabled: false,
      provider: 'cloudflare',
      mode: 'quick',
      tunnelProtocol: 'auto',
      hostname: '',
      publicUrl: '',
      tunnelName: 'agent-pulse',
      tunnelId: '',
      configPath: path.join(dir, 'cloudflared', 'config.yml'),
      metricsUrl: 'http://127.0.0.1:60123/metrics',
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
      },
      ...remote
    }
  };
}

function createSettingsStore(): HelperSettingsStore {
  return {
    load: vi.fn(),
    save: vi.fn()
  } as unknown as HelperSettingsStore;
}

const successfulExecFile = vi.fn((
  _file: string,
  _args: string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => {
  callback(null, 'cloudflared version 2026.4.0', '');
});

function createChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn<(signal?: string) => boolean>>;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((_: string | undefined = undefined) => {
    child.killed = true;
    return true;
  });
  child.killed = false;
  return child;
}
