import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel, Project, RemoteAccessSettings, Thread, ThreadTranscript } from '@agent-pulse/shared';
import { WebSocket, type RawData } from 'ws';
import { AdminAuth } from '../auth/admin';
import { DeviceRegistry, MemoryDeviceStore, PairingManager } from '../auth/pairing';
import { SendBlockedError } from '../codex/app-server-chat';
import type { CatalogReader } from '../codex/catalog';
import { createThreadOpener } from '../codex/thread-opener';
import { startAgentPulseServer } from './agent-pulse-server';
import { pickFreeHighPort, type HelperSettingsStore } from './settings';

function createAdminAuth(): AdminAuth {
  return new AdminAuth({
    credentialsPath: path.join(
      mkdtempSync(path.join(tmpdir(), 'agent-pulse-admin-')),
      'admin.json'
    )
  });
}

describe('Agent Pulse helper API', () => {
  it('serves helper health from both health routes', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      const canonical = await fetch(`${server.url}/health/get`);
      const alias = await fetch(`${server.url}/health`);

      expect(canonical.status).toBe(200);
      expect(alias.status).toBe(200);
      await expect(canonical.json()).resolves.toMatchObject({ status: 'ok', version: '0.1.0' });
      await expect(alias.json()).resolves.toMatchObject({ status: 'ok', version: '0.1.0' });
    } finally {
      await server.stop();
    }
  });

  it('pairs a device, protects thread data, and blocks revoked tokens', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const adminAuth = createAdminAuth();
    await adminAuth.ensureInitialized();
    const adminToken = adminAuth.issueToken().token;
    const thread: Thread = {
      threadId: 'thread-1',
      provider: 'codex',
      title: 'Review permission request',
      workspace: 'OpenAssist',
      status: 'waiting_approval',
      lastActivityAt: '2026-04-25T16:14:00Z',
      lastTurnSummary: 'Needs approval before continuing'
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth,
      threadProvider: { listThreads: async () => [thread] },
      opener,
      version: '0.1.0'
    });

    try {
      const unpaired = await fetch(`${server.url}/threads/list`);
      expect(unpaired.status).toBe(401);

      const { pin } = pairing.createPin();
      const paired = await fetch(`${server.url}/device/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pin,
          deviceName: 'Desk iPad',
          fingerprint: 'fingerprint-123'
        })
      });
      const pairedBody = (await paired.json()) as { token: string; deviceId: string };

      const authed = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(pairedBody.token, pairedBody.deviceId)
      });
      expect(authed.status).toBe(200);
      await expect(authed.json()).resolves.toEqual({ threads: [thread] });

      const revoked = await fetch(`${server.url}/settings/device/revoke`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ deviceId: pairedBody.deviceId })
      });
      expect(revoked.status).toBe(200);

      const afterRevoke = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(pairedBody.token, pairedBody.deviceId)
      });
      expect(afterRevoke.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  it('hides disabled providers and blocks starting them', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const codexThread: Thread = {
      threadId: 'thread-codex',
      provider: 'codex',
      title: 'Codex thread',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-25T16:14:00Z',
      lastTurnSummary: ''
    };
    const claudeThread: Thread = {
      threadId: 'claude-code:thread-1',
      provider: 'claude-code',
      title: 'Claude thread',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-25T16:15:00Z',
      lastTurnSummary: ''
    };
    const codexProject: Project = {
      projectId: 'codex-project',
      name: 'Codex project',
      path: '/tmp/codex-project',
      providers: ['codex']
    };
    const claudeProject: Project = {
      projectId: 'claude-project',
      name: 'Claude project',
      path: '/tmp/claude-project',
      providers: ['claude-code']
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      enabledProviders: ['claude-code' as const],
      remoteAccess: remoteAccessSettings()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: {
        listThreads: async () => [codexThread],
        listProjects: async () => [codexProject]
      },
      claudeCode: {
        listThreads: async () => [claudeThread],
        listProjects: async () => [claudeProject],
        readTranscript: vi.fn(),
        sendMessage: vi.fn(),
        listModels: async () => [
          {
            slug: 'opus',
            displayName: 'Claude Opus',
            provider: 'claude-code'
          }
        ]
      },
      catalog: {
        listPlugins: async () => [],
        listSkills: async () => [],
        listCommands: async () => [],
        listModels: async () => [
          {
            slug: 'gpt-5.5',
            displayName: 'GPT-5.5',
            provider: 'codex'
          }
        ],
        listProjectFiles: async () => ({ files: [], truncated: false }),
        onChange: () => () => undefined
      } as unknown as CatalogReader,
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);

      const threads = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(token, deviceId)
      });
      await expect(threads.json()).resolves.toEqual({ threads: [claudeThread] });

      const projects = await fetch(`${server.url}/projects/list`, {
        headers: authHeaders(token, deviceId)
      });
      await expect(projects.json()).resolves.toEqual({ projects: [claudeProject] });

      const models = await fetch(`${server.url}/catalog/models`, {
        headers: authHeaders(token, deviceId)
      });
      await expect(models.json()).resolves.toMatchObject({
        models: [{ slug: 'opus', provider: 'claude-code' }]
      });

      const disabledStart = await fetch(`${server.url}/threads/new`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ provider: 'codex', cwd: '/tmp' })
      });
      expect(disabledStart.status).toBe(403);
      await expect(disabledStart.json()).resolves.toEqual({
        error: 'Codex is turned off in Agent Pulse settings.'
      });
    } finally {
      await server.stop();
    }
  });

  it('updates remote access through admin routes without changing LAN mode', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const adminAuth = createAdminAuth();
    await adminAuth.ensureInitialized();
    const { token: adminToken } = adminAuth.issueToken();
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings()
    };
    const remoteAccess = {
      getStatus: vi.fn(() => settings.remoteAccess),
      check: vi.fn(async () => ({
        ...settings.remoteAccess,
        checklist: { ...settings.remoteAccess.checklist, dependencyInstalled: false },
        lastError: 'Install cloudflared first.'
      })),
      setEnabled: vi.fn(async (enabled: boolean) => ({
        ...settings.remoteAccess,
        enabled,
        status: enabled ? 'disconnected' as const : 'off' as const,
        lastError: enabled ? 'Install cloudflared first.' : ''
      })),
      configure: vi.fn(async () => settings.remoteAccess),
      login: vi.fn(async () => settings.remoteAccess)
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const onLanModeChange = vi.fn();
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth,
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      remoteAccess,
      version: '0.1.0',
      onLanModeChange
    });

    try {
      const checkResponse = await fetch(`${server.url}/settings/remote-access/check`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}` }
      });
      expect(checkResponse.status).toBe(200);
      await expect(checkResponse.json()).resolves.toMatchObject({
        remoteAccess: {
          checklist: { dependencyInstalled: false },
          lastError: 'Install cloudflared first.'
        }
      });

      const enableResponse = await fetch(`${server.url}/settings/remote-access`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ enabled: true })
      });

      expect(enableResponse.status).toBe(200);
      expect(remoteAccess.setEnabled).toHaveBeenCalledWith(true);
      expect(onLanModeChange).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('requires an admin token even for local admin routes', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const server = await startAgentPulseServer({
      settings: {
        port: await pickFreeHighPort(),
        lanEnabled: false,
        mobileSendEnabled: false,
        remoteAccess: remoteAccessSettings()
      },
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      const response = await fetch(`${server.url}/settings/get`);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Admin mode required.' });
    } finally {
      await server.stop();
    }
  });

  it('ignores spoofed forwarded IP headers on direct admin login attempts', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const server = await startAgentPulseServer({
      settings: {
        port: await pickFreeHighPort(),
        lanEnabled: false,
        mobileSendEnabled: false,
        remoteAccess: remoteAccessSettings()
      },
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      let response = await fetch(`${server.url}/admin/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.10'
        },
        body: JSON.stringify({ passcode: 'wrong-passcode' })
      });

      for (let index = 0; index < 6; index += 1) {
        response = await fetch(`${server.url}/admin/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `198.51.100.${index + 11}`
          },
          body: JSON.stringify({ passcode: 'wrong-passcode' })
        });
      }

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({
        error: 'Too many admin login attempts. Try again later.'
      });
    } finally {
      await server.stop();
    }
  });

  it('locks remote admin login globally across different public IPs', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const server = await startAgentPulseServer({
      settings: {
        port: await pickFreeHighPort(),
        lanEnabled: false,
        mobileSendEnabled: false,
        remoteAccess: remoteAccessSettings({
          enabled: true,
          hostname: 'pulse.example.com',
          publicUrl: 'https://pulse.example.com'
        })
      },
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      let response = await fetch(`${server.url}/admin/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://pulse.example.com',
          'cf-connecting-ip': '203.0.113.10'
        },
        body: JSON.stringify({ passcode: 'wrong-passcode' })
      });

      for (let index = 0; index < 24; index += 1) {
        response = await fetch(`${server.url}/admin/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://pulse.example.com',
            'cf-connecting-ip': `203.0.113.${index + 11}`
          },
          body: JSON.stringify({ passcode: 'wrong-passcode' })
        });
      }

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({
        error: 'Too many admin login attempts. Try again later.'
      });
    } finally {
      await server.stop();
    }
  });

  it('rejects protected remote browser requests from an untrusted Origin', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings({
        enabled: true,
        hostname: 'pulse.example.com',
        publicUrl: 'https://pulse.example.com'
      })
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(`${server.url}/threads/list`, {
        headers: {
          ...authHeaders(token, deviceId),
          origin: 'https://evil.example.com'
        }
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'Origin is not allowed.' });
    } finally {
      await server.stop();
    }
  });

  it('does not expose saved device names from the public remote origin', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings({
        enabled: true,
        hostname: 'pulse.example.com',
        publicUrl: 'https://pulse.example.com'
      })
    };
    await registry.createDevice('Desk tablet', 'fingerprint-a');
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      const response = await fetch(`${server.url}/device/options`, {
        headers: { origin: 'https://pulse.example.com' }
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ devices: [] });
    } finally {
      await server.stop();
    }
  });

  it('rate limits unauthenticated requests from the public remote origin', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings({
        enabled: true,
        hostname: 'pulse.example.com',
        publicUrl: 'https://pulse.example.com'
      })
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      let response = await fetch(`${server.url}/health/get`, {
        headers: { origin: 'https://pulse.example.com', 'cf-connecting-ip': '203.0.113.50' }
      });

      for (let index = 0; index < 60; index += 1) {
        response = await fetch(`${server.url}/health/get`, {
          headers: { origin: 'https://pulse.example.com', 'cf-connecting-ip': '203.0.113.50' }
        });
      }

      expect(response.status).toBe(429);
    } finally {
      await server.stop();
    }
  });

  it('rate limits authenticated public remote requests by token', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings({
        enabled: true,
        hostname: 'pulse.example.com',
        publicUrl: 'https://pulse.example.com'
      })
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      let response = await fetch(`${server.url}/threads/list`, {
        headers: {
          ...authHeaders(token, deviceId),
          origin: 'https://pulse.example.com'
        }
      });

      for (let index = 0; index < 120; index += 1) {
        response = await fetch(`${server.url}/threads/list`, {
          headers: {
            ...authHeaders(token, deviceId),
            origin: 'https://pulse.example.com'
          }
        });
      }

      expect(response.status).toBe(429);
    } finally {
      await server.stop();
    }
  });

  it('closes active WebSocket connections when a device is revoked', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const adminAuth = createAdminAuth();
    await adminAuth.ensureInitialized();
    const adminToken = adminAuth.issueToken().token;
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth,
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const params = new URLSearchParams({
        token,
        deviceId,
        fingerprint: 'fingerprint-123'
      });
      const websocket = new WebSocket(`${server.url.replace('http:', 'ws:')}/events?${params}`);
      await waitForSocketOpen(websocket);

      const closePromise = waitForSocketClose(websocket);
      const revoke = await fetch(`${server.url}/settings/device/revoke`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ deviceId })
      });

      expect(revoke.status).toBe(200);
      await expect(closePromise).resolves.toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('rejects WebSocket upgrades from an untrusted Origin', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings({
        enabled: true,
        hostname: 'pulse.example.com',
        publicUrl: 'https://pulse.example.com'
      })
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const params = new URLSearchParams({
        token,
        deviceId,
        fingerprint: 'fingerprint-123'
      });
      const websocket = new WebSocket(`${server.url.replace('http:', 'ws:')}/events?${params}`, {
        headers: { origin: 'https://evil.example.com' }
      });

      await expect(waitForSocketRejected(websocket)).resolves.toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('records remote auth failures and revokes in admin activity', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const adminAuth = createAdminAuth();
    await adminAuth.ensureInitialized();
    const { token: adminToken } = adminAuth.issueToken();
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings({
        enabled: true,
        hostname: 'pulse.example.com',
        publicUrl: 'https://pulse.example.com'
      })
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth,
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      await fetch(`${server.url}/threads/list`, {
        headers: {
          authorization: 'Bearer invalid-token',
          'x-agent-pulse-device-id': 'device-1',
          'x-agent-pulse-fingerprint': 'fingerprint-123',
          origin: 'https://pulse.example.com',
          'cf-connecting-ip': '203.0.113.80'
        }
      });

      const { token, deviceId } = await pairForTest(server.url, pairing);
      await fetch(`${server.url}/settings/device/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId })
      });

      const settingsResponse = await fetch(`${server.url}/settings/get`, {
        headers: { authorization: `Bearer ${adminToken}` }
      });
      const payload = (await settingsResponse.json()) as {
        remoteActivity: Array<{ type: string; deviceId?: string; sourceIp?: string; reason: string }>;
      };

      expect(payload.remoteActivity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'auth_failure',
            sourceIp: '203.0.113.80',
            reason: 'missing'
          }),
          expect.objectContaining({
            type: 'revoke',
            deviceId
          })
        ])
      );
      expect(token).toMatch(/^ap_/);
    } finally {
      await server.stop();
    }
  });

  it('does not list a stale paused Codex thread as running when App Server shows no live turn', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const staleThread: Thread = {
      threadId: 'thread-paused',
      provider: 'codex',
      title: 'Plan modern UI implementation',
      workspace: 'CodexPulse',
      status: 'running',
      lastActivityAt: '2026-04-26T17:04:47Z',
      lastTurnSummary: ''
    };
    const staleErrorThread: Thread = {
      ...staleThread,
      threadId: 'thread-stale-error',
      title: 'Fix failed check',
      status: 'error'
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async (): Promise<ThreadTranscript> => ({
        threadId: 'thread-paused',
        activeTurnId: null,
        sendState: {
          canSend: true,
          reason: 'ready',
          label: 'Ready'
        },
        messages: []
      })),
      sendMessage: vi.fn()
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [staleThread, staleErrorThread] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(token, deviceId)
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        threads: [
          {
            ...staleThread,
            status: 'idle'
          },
          {
            ...staleErrorThread,
            status: 'idle'
          }
        ]
      });
      expect(appServer.readTranscript).toHaveBeenCalledWith('thread-paused');
      expect(appServer.readTranscript).toHaveBeenCalledWith('thread-stale-error');
    } finally {
      await server.stop();
    }
  });

  it('does not read old idle transcripts while reconciling stale active states', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const oldIdleThread: Thread = {
      threadId: 'thread-old-idle',
      provider: 'codex',
      title: 'Old idle chat',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-01T10:00:00Z',
      lastTurnSummary: ''
    };
    const staleRunningThread: Thread = {
      threadId: 'thread-stale-running',
      provider: 'codex',
      title: 'Stale running chat',
      workspace: 'CodexPulse',
      status: 'running',
      lastActivityAt: '2026-04-01T11:00:00Z',
      lastTurnSummary: ''
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async (threadId: string): Promise<ThreadTranscript> => ({
        threadId,
        activeTurnId: null,
        sendState: {
          canSend: true,
          reason: 'ready',
          label: 'Ready'
        },
        messages: []
      })),
      sendMessage: vi.fn()
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [oldIdleThread, staleRunningThread] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(token, deviceId)
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        threads: [
          oldIdleThread,
          {
            ...staleRunningThread,
            status: 'idle'
          }
        ]
      });
      expect(appServer.readTranscript).not.toHaveBeenCalledWith('thread-old-idle');
      expect(appServer.readTranscript).toHaveBeenCalledWith('thread-stale-running');
    } finally {
      await server.stop();
    }
  });

  it('reconciles old idle threads when app-server reports them as loaded', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const oldIdleThread: Thread = {
      threadId: 'thread-old-loaded',
      title: 'Old loaded chat',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-01T10:00:00Z',
      lastTurnSummary: ''
    };
    const appServer = {
      isConnected: () => true,
      listLoadedThreadIds: vi.fn(async () => new Set(['thread-old-loaded'])),
      readTranscript: vi.fn(async (threadId: string): Promise<ThreadTranscript> => ({
        threadId,
        activeTurnId: 'turn-running',
        sendState: {
          canSend: false,
          reason: 'thread_changed',
          label: 'Codex is working'
        },
        messages: []
      })),
      sendMessage: vi.fn()
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [oldIdleThread] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(token, deviceId)
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        threads: [
          {
            threadId: 'thread-old-loaded',
            status: 'running'
          }
        ]
      });
      expect(appServer.listLoadedThreadIds).toHaveBeenCalled();
      expect(appServer.readTranscript).toHaveBeenCalledWith('thread-old-loaded');
    } finally {
      await server.stop();
    }
  });

  it('keeps a rollout-running thread running when app-server transcript still says ready', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const runningThread: Thread = {
      threadId: 'thread-rollout-running',
      title: 'Visible running chat',
      workspace: 'CodexPulse',
      status: 'running',
      lastActivityAt: new Date().toISOString(),
      lastTurnSummary: ''
    };
    const appServer = {
      isConnected: () => true,
      listLoadedThreadIds: vi.fn(async () => new Set(['thread-rollout-running'])),
      readTranscript: vi.fn(async (threadId: string): Promise<ThreadTranscript> => ({
        threadId,
        activeTurnId: null,
        sendState: {
          canSend: true,
          reason: 'ready',
          label: 'Ready'
        },
        messages: []
      })),
      sendMessage: vi.fn()
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [runningThread] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(token, deviceId)
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        threads: [
          {
            threadId: 'thread-rollout-running',
            status: 'running'
          }
        ]
      });
    } finally {
      await server.stop();
    }
  });

  it('serves local transcript screenshots through opaque helper URLs', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const screenshotPath = path.join(mkdtempSync(path.join(tmpdir(), 'agent-pulse-shot-')), 'screen.png');
    const screenshotBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    writeFileSync(screenshotPath, screenshotBytes);
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async (): Promise<ThreadTranscript> => ({
        threadId: 'thread-1',
        activeTurnId: null,
        sendState: {
          canSend: true,
          reason: 'ready',
          label: 'Ready'
        },
        messages: [
          {
            id: 'user-1',
            role: 'user',
            kind: 'message',
            text: 'Here is the screenshot.',
            createdAt: '2026-04-25T16:14:00Z',
            attachments: [
              {
                id: 'user-1-image-1',
                kind: 'image',
                url: 'agent-pulse-local-image:user-1-image-1',
                sourcePath: screenshotPath
              }
            ]
          } as ThreadTranscript['messages'][number]
        ]
      })),
      sendMessage: vi.fn()
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(`${server.url}/threads/thread-1/transcript`, {
        headers: authHeaders(token, deviceId)
      });
      const transcript = (await response.json()) as ThreadTranscript;
      const attachment = transcript.messages[0]?.attachments?.[0];

      expect(response.status).toBe(200);
      expect(attachment?.url).toMatch(/^\/attachments\/[a-f0-9]+$/);
      expect('sourcePath' in (attachment ?? {})).toBe(false);

      const imageResponse = await fetch(`${server.url}${attachment?.url}`);
      expect(imageResponse.status).toBe(200);
      expect(imageResponse.headers.get('content-type')).toBe('image/png');
      await expect(imageResponse.arrayBuffer()).resolves.toEqual(screenshotBytes.buffer.slice(
        screenshotBytes.byteOffset,
        screenshotBytes.byteOffset + screenshotBytes.byteLength
      ));
    } finally {
      await server.stop();
    }
  });

  it('can return only the latest transcript messages when a limit is requested', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async (): Promise<ThreadTranscript> => ({
        threadId: 'thread-1',
        activeTurnId: null,
        sendState: {
          canSend: true,
          reason: 'ready',
          label: 'Ready'
        },
        messages: [
          {
            id: 'message-1',
            role: 'user',
            kind: 'message',
            text: 'First user',
            createdAt: '2026-04-25T16:14:00Z'
          },
          {
            id: 'message-2',
            role: 'user',
            kind: 'message',
            text: 'Second user',
            createdAt: '2026-04-25T16:15:00Z'
          },
          {
            id: 'message-3',
            role: 'assistant',
            kind: 'message',
            text: 'Third',
            createdAt: '2026-04-25T16:16:00Z'
          }
        ]
      })),
      sendMessage: vi.fn()
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(`${server.url}/threads/thread-1/transcript?limit=2`, {
        headers: authHeaders(token, deviceId)
      });

      // The raw tail at limit=2 is [message-2, message-3] — only one user message. The
      // limiter walks back to include message-1 so the response carries at least two
      // user messages, giving the dashboard the conversational context it needs.
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        threadId: 'thread-1',
        provider: 'codex',
        activeTurnId: null,
        sendState: {
          canSend: true,
          reason: 'ready',
          label: 'Ready'
        },
        messages: [
          {
            id: 'message-1',
            role: 'user',
            kind: 'message',
            text: 'First user',
            createdAt: '2026-04-25T16:14:00Z'
          },
          {
            id: 'message-2',
            role: 'user',
            kind: 'message',
            text: 'Second user',
            createdAt: '2026-04-25T16:15:00Z'
          },
          {
            id: 'message-3',
            role: 'assistant',
            kind: 'message',
            text: 'Third',
            createdAt: '2026-04-25T16:16:00Z'
          }
        ]
      });
    } finally {
      await server.stop();
    }
  });

  it('returns a clear error when the pairing PIN is wrong', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      pairing.createPin();
      const response = await fetch(`${server.url}/device/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pin: '000000',
          deviceName: 'Desk iPad',
          fingerprint: 'fingerprint-123'
        })
      });

      await expect(response.json()).resolves.toEqual({
        error: 'Pairing PIN is invalid or expired.'
      });
      expect(response.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it('lists saved devices for pairing and reconnects a selected one', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const adminAuth = createAdminAuth();
    await adminAuth.ensureInitialized();
    const { token: adminToken } = adminAuth.issueToken();
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const existing = await registry.createDevice('Desk iPad', 'fingerprint-123');
    const revoked = await registry.createDevice('Kitchen tablet', 'fingerprint-456');
    await registry.revokeDevice(revoked.deviceId);
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth,
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      const devicePinResponse = await fetch(`${server.url}/settings/pairing-pin`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ deviceId: existing.deviceId })
      });

      expect(devicePinResponse.status).toBe(200);
      const devicePin = (await devicePinResponse.json()) as {
        pin: string;
        expiresAt: string;
        deviceId?: string;
      };
      expect(devicePin.deviceId).toBe(existing.deviceId);

      const settingsResponse = await fetch(`${server.url}/settings/get`, {
        headers: { authorization: `Bearer ${adminToken}` }
      });

      expect(settingsResponse.status).toBe(200);
      await expect(settingsResponse.json()).resolves.toEqual({
        settings,
        devices: [
          {
            deviceId: existing.deviceId,
            deviceName: existing.deviceName,
            fingerprint: existing.fingerprint,
            createdAt: existing.createdAt,
            tokenPreview: expect.any(String)
          },
          {
            deviceId: revoked.deviceId,
            deviceName: revoked.deviceName,
            fingerprint: revoked.fingerprint,
            createdAt: revoked.createdAt,
            revokedAt: expect.any(String),
            tokenPreview: expect.any(String)
          }
        ],
        pairingPins: [devicePin],
        remoteActivity: []
      });

      const optionsResponse = await fetch(`${server.url}/device/options`);

      expect(optionsResponse.status).toBe(200);
      await expect(optionsResponse.json()).resolves.toEqual({
        devices: [
          {
            deviceId: existing.deviceId,
            deviceName: 'Desk iPad'
          }
        ]
      });

      const reconnectResponse = await fetch(`${server.url}/device/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pin: devicePin.pin,
          existingDeviceId: existing.deviceId,
          fingerprint: 'fingerprint-789'
        })
      });

      expect(reconnectResponse.status).toBe(200);
      const reconnectBody = (await reconnectResponse.json()) as {
        token: string;
        deviceId: string;
        deviceName: string;
      };
      expect(reconnectBody.deviceId).toBe(existing.deviceId);
      expect(reconnectBody.deviceName).toBe('Desk iPad');

      const authed = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(reconnectBody.token, reconnectBody.deviceId, 'fingerprint-789')
      });
      expect(authed.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('recovers a saved device session when the browser has an older token', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const existing = await registry.createDevice('Desk iPad', 'fingerprint-123');
    const rotated = await registry.reconnectDevice(existing.deviceId, 'fingerprint-123');
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      version: '0.1.0'
    });

    try {
      const stale = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(existing.token, existing.deviceId)
      });
      expect(stale.status).toBe(401);

      const recovered = await fetch(`${server.url}/device/session/recover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: existing.deviceId,
          fingerprint: 'fingerprint-123'
        })
      });

      expect(recovered.status).toBe(200);
      await expect(recovered.json()).resolves.toEqual({
        token: rotated?.token,
        deviceId: existing.deviceId,
        deviceName: 'Desk iPad'
      });

      const authed = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(rotated?.token ?? '', existing.deviceId)
      });
      expect(authed.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('reads transcripts through Codex App Server but blocks sends until mobile sending is enabled', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const transcript: ThreadTranscript = {
      threadId: 'thread-1',
      provider: 'codex',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          kind: 'message',
          text: 'Existing thread response.',
          createdAt: '2026-04-25T16:14:00Z'
        }
      ]
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => transcript),
      sendMessage: vi.fn()
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: false,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const transcriptResponse = await fetch(`${server.url}/threads/thread-1/transcript`, {
        headers: authHeaders(token, deviceId)
      });

      expect(transcriptResponse.status).toBe(200);
      await expect(transcriptResponse.json()).resolves.toEqual({
        ...transcript,
        sendState: {
          canSend: false,
          reason: 'mobile_send_disabled',
          label: 'Mobile sending is off on the Mac.'
        }
      });

      const sendResponse = await fetch(`${server.url}/threads/thread-1/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ text: 'Hello from phone.' })
      });

      expect(sendResponse.status).toBe(403);
      await expect(sendResponse.json()).resolves.toEqual({
        error: 'Mobile sending is off on the Mac.'
      });
      expect(appServer.sendMessage).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('subscribes opened transcripts to the app-server live stream', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const transcript: ThreadTranscript = {
      threadId: 'thread-1',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: []
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => transcript),
      subscribeThread: vi.fn(async () => undefined),
      sendMessage: vi.fn()
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(`${server.url}/threads/thread-1/transcript`, {
        headers: authHeaders(token, deviceId)
      });

      expect(response.status).toBe(200);
      expect(appServer.subscribeThread).toHaveBeenCalledWith('thread-1');
      expect(appServer.readTranscript).toHaveBeenCalledWith('thread-1');
    } finally {
      await server.stop();
    }
  });

  it('loads older messages from full Codex history instead of the recent transcript tail', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const recentTranscript: ThreadTranscript = {
      threadId: 'thread-1',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: [
        {
          id: 'message-3',
          role: 'assistant',
          kind: 'message',
          text: 'Recent message 3',
          createdAt: '2026-04-25T16:16:00Z'
        },
        {
          id: 'message-4',
          role: 'assistant',
          kind: 'message',
          text: 'Recent message 4',
          createdAt: '2026-04-25T16:17:00Z'
        }
      ]
    };
    const fullTranscript: ThreadTranscript = {
      ...recentTranscript,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          kind: 'message',
          text: 'Older message 1',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'message-2',
          role: 'assistant',
          kind: 'message',
          text: 'Older message 2',
          createdAt: '2026-04-25T16:15:00Z'
        },
        ...recentTranscript.messages
      ]
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => recentTranscript),
      readFullTranscript: vi.fn(async () => fullTranscript),
      sendMessage: vi.fn()
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(
        `${server.url}/threads/thread-1/transcript/older?before=message-3&limit=2`,
        { headers: authHeaders(token, deviceId) }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        threadId: 'thread-1',
        messages: fullTranscript.messages.slice(0, 2),
        hasMore: false
      });
      expect(appServer.readFullTranscript).toHaveBeenCalledWith('thread-1');
      expect(appServer.readTranscript).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('uses the app-server live streaming state when the transcript still says ready', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const thread: Thread = {
      threadId: 'thread-1',
      title: 'Fix Mac helper sync',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-27T18:10:00Z',
      lastTurnSummary: ''
    };
    const transcript: ThreadTranscript = {
      threadId: 'thread-1',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: []
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => transcript),
      sendMessage: vi.fn(),
      applyLiveState: (raw: ThreadTranscript, threadId: string) =>
        threadId === 'thread-1'
          ? {
              ...raw,
              activeTurnId: 'app-server-live:thread-1',
              sendState: {
                canSend: false,
                reason: 'thread_changed' as const,
                label: 'Codex is working'
              }
            }
          : raw,
      isThreadStreaming: (threadId: string) => threadId === 'thread-1'
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [thread] },
      opener,
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const transcriptResponse = await fetch(`${server.url}/threads/thread-1/transcript`, {
        headers: authHeaders(token, deviceId)
      });
      expect(transcriptResponse.status).toBe(200);
      await expect(transcriptResponse.json()).resolves.toMatchObject({
        threadId: 'thread-1',
        activeTurnId: 'app-server-live:thread-1',
        sendState: {
          canSend: false,
          reason: 'thread_changed',
          label: 'Codex is working'
        }
      });

      const listResponse = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(token, deviceId)
      });
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toMatchObject({
        threads: [
          {
            threadId: 'thread-1',
            status: 'running'
          }
        ]
      });
    } finally {
      await server.stop();
    }
  });

  it('uses the IPC mirror approval state when Codex is waiting for permission', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const thread: Thread = {
      threadId: 'thread-approval',
      title: 'Check Teams',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-28T13:10:00Z',
      lastTurnSummary: ''
    };
    const transcript: ThreadTranscript = {
      threadId: 'thread-approval',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: []
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => transcript),
      sendMessage: vi.fn(),
      isThreadStreaming: (threadId: string) => threadId === 'thread-approval'
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(),
      isThreadWaitingForApproval: (threadId: string) => threadId === 'thread-approval',
      isThreadOwned: () => true,
      waitForOwnership: async () => true
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [thread] },
      opener,
      appServer,
      mirror,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const transcriptResponse = await fetch(`${server.url}/threads/thread-approval/transcript`, {
        headers: authHeaders(token, deviceId)
      });
      expect(transcriptResponse.status).toBe(200);
      await expect(transcriptResponse.json()).resolves.toMatchObject({
        threadId: 'thread-approval',
        activeTurnId: 'mirror-approval:thread-approval',
        sendState: {
          canSend: false,
          reason: 'waiting_on_approval',
          label: 'Codex is waiting for approval'
        }
      });

      const listResponse = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(token, deviceId)
      });
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toMatchObject({
        threads: [
          {
            threadId: 'thread-approval',
            status: 'waiting_approval'
          }
        ]
      });
    } finally {
      await server.stop();
    }
  });

  it('returns pending approval payloads from the IPC mirror live state', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const thread: Thread = {
      threadId: 'thread-approval',
      title: 'Check Teams',
      workspace: 'CodexPulse',
      status: 'waiting_approval',
      lastActivityAt: '2026-04-28T13:10:00Z',
      lastTurnSummary: ''
    };
    const transcript: ThreadTranscript = {
      threadId: 'thread-approval',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: []
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => transcript),
      sendMessage: vi.fn()
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(),
      getPendingApprovalRequests: (threadId: string) =>
        threadId === 'thread-approval' ? [pendingApproval] : [],
      isThreadOwned: () => true,
      waitForOwnership: async () => true
    };
    const pendingApproval = {
      id: 'permission-request-1',
      method: 'item/permissions/requestApproval',
      params: {
        turnId: 'turn-7',
        reason: 'Allow Codex to use Microsoft Teams?'
      },
      turnId: 'turn-7'
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [thread] },
      opener,
      appServer,
      mirror,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(
        `${server.url}/threads/thread-approval/pending-approvals`,
        { headers: authHeaders(token, deviceId) }
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        threadId: 'thread-approval',
        requests: [pendingApproval]
      });
    } finally {
      await server.stop();
    }
  });

  it('records approval decisions through the IPC mirror', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(),
      sendMessage: vi.fn(),
      respondToApproval: vi.fn(async () => {
        throw new Error('app-server should not be used for approval decisions.');
      })
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(),
      respondToApproval: vi.fn(async () => undefined),
      isThreadOwned: () => true,
      waitForOwnership: async () => true
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      mirror,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(
        `${server.url}/threads/thread-approval/approvals/request-1`,
        {
          method: 'POST',
          headers: {
            ...authHeaders(token, deviceId),
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'item/fileChange/requestApproval',
            decision: 'accept'
          })
        }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(mirror.respondToApproval).toHaveBeenCalledWith(
        'thread-approval',
        'request-1',
        'item/fileChange/requestApproval',
        'accept'
      );
      expect(appServer.respondToApproval).not.toHaveBeenCalled();
      expect(opener.openThread).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('uses the app-server compaction state when Codex is compacting context', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const thread: Thread = {
      threadId: 'thread-compact',
      title: 'Fix Mac helper sync',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-28T13:10:00Z',
      lastTurnSummary: ''
    };
    const transcript: ThreadTranscript = {
      threadId: 'thread-compact',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: []
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => transcript),
      sendMessage: vi.fn(),
      applyLiveState: (raw: ThreadTranscript, threadId: string) =>
        threadId === 'thread-compact'
          ? {
              ...raw,
              activeTurnId: 'app-server-live:thread-compact',
              sendState: {
                canSend: false,
                reason: 'compacting_context' as const,
                label: 'Automatically compacting context'
              }
            }
          : raw,
      isThreadStreaming: (threadId: string) => threadId === 'thread-compact',
      isThreadCompacting: (threadId: string) => threadId === 'thread-compact'
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [thread] },
      opener,
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const transcriptResponse = await fetch(`${server.url}/threads/thread-compact/transcript`, {
        headers: authHeaders(token, deviceId)
      });
      expect(transcriptResponse.status).toBe(200);
      await expect(transcriptResponse.json()).resolves.toMatchObject({
        threadId: 'thread-compact',
        activeTurnId: 'app-server-live:thread-compact',
        sendState: {
          canSend: false,
          reason: 'compacting_context',
          label: 'Automatically compacting context'
        }
      });

      const listResponse = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(token, deviceId)
      });
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toMatchObject({
        threads: [
          {
            threadId: 'thread-compact',
            status: 'compacting'
          }
        ]
      });
    } finally {
      await server.stop();
    }
  });

  it('sends collaboration mode through the IPC mirror and broadcasts the updated transcript', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const transcript: ThreadTranscript = {
      threadId: 'thread-1',
      provider: 'codex',
      activeTurnId: 'turn-1',
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: [
        {
          id: 'user-1',
          role: 'user',
          kind: 'message',
          text: 'Hello from phone.',
          createdAt: '2026-04-25T16:14:00Z'
        }
      ]
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => transcript),
      sendMessage: vi.fn(async () => {
        throw new Error('app-server send must not run when mirror is the source of truth.');
      })
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(async () => ({
        ok: true as const,
        mode: 'steer' as const,
        turnId: 'turn-1',
        transcript
      })),
      isThreadOwned: () => true,
      waitForOwnership: async () => true
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      mirror,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const sendResponse = await fetch(`${server.url}/threads/thread-1/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ text: 'Hello from phone.', collaborationMode: 'plan' })
      });

      const sendBody = await sendResponse.json();
      expect(sendBody).toEqual({
        ok: true,
        mode: 'steer',
        turnId: 'turn-1',
        transcript
      });
      expect(sendResponse.status).toBe(200);
      expect(mirror.sendMessage).toHaveBeenCalledWith('thread-1', 'Hello from phone.', {
        collaborationMode: 'plan'
      });
      expect(appServer.sendMessage).not.toHaveBeenCalled();
      expect(opener.refreshDesktop).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('routes sends through the IPC mirror when it is connected', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const transcript: ThreadTranscript = {
      threadId: 'thread-1',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: []
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => transcript),
      sendMessage: vi.fn(async () => {
        throw new Error('app-server send must not be used when the mirror is connected.');
      })
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(async () => ({
        ok: true as const,
        mode: 'start' as const,
        turnId: 'mirror-turn-1',
        transcript
      })),
      isThreadOwned: () => true,
      waitForOwnership: async () => true
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      mirror,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const sendResponse = await fetch(`${server.url}/threads/thread-1/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ text: 'Hello from phone.' })
      });

      expect(sendResponse.status).toBe(200);
      expect(mirror.sendMessage).toHaveBeenCalledWith('thread-1', 'Hello from phone.', undefined);
      expect(appServer.sendMessage).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('stops Codex work through app-server', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(),
      sendMessage: vi.fn(),
      interruptTurn: vi.fn(async () => undefined)
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(),
      interruptTurn: vi.fn(async () => {
        throw new Error('IPC mirror should not be used for stop.');
      }),
      isThreadOwned: () => true,
      waitForOwnership: async () => true
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const params = new URLSearchParams({
        token,
        deviceId,
        fingerprint: 'fingerprint-123'
      });
      const websocket = new WebSocket(`${server.url.replace('http:', 'ws:')}/events?${params}`);
      await waitForSocketOpen(websocket);
      const streamingStopped = waitForLiveEvent(websocket, (event) => {
        const typed = event as {
          type?: unknown;
          payload?: { threadId?: unknown; isStreaming?: unknown };
        };
        return (
          typed.type === 'thread/streaming-changed' &&
          typed.payload?.threadId === 'thread-1' &&
          typed.payload?.isStreaming === false
        );
      });

      const stopResponse = await fetch(`${server.url}/threads/thread-1/stop`, {
        method: 'POST',
        headers: authHeaders(token, deviceId)
      });

      await expect(stopResponse.json()).resolves.toEqual({ ok: true });
      expect(stopResponse.status).toBe(200);
      expect(appServer.interruptTurn).toHaveBeenCalledWith('thread-1');
      expect(mirror.interruptTurn).not.toHaveBeenCalled();
      await expect(streamingStopped).resolves.toMatchObject({
        type: 'thread/streaming-changed',
        payload: { threadId: 'thread-1', isStreaming: false }
      });
      expect(opener.openThread).not.toHaveBeenCalled();
      websocket.close();
    } finally {
      await server.stop();
    }
  });

  it('broadcasts ready state when stop finds only a stale running turn', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(),
      sendMessage: vi.fn(),
      interruptTurn: vi.fn(async () => {
        throw new SendBlockedError(
          'missing_active_turn',
          'Codex is not currently running this thread.'
        );
      })
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const params = new URLSearchParams({
        token,
        deviceId,
        fingerprint: 'fingerprint-123'
      });
      const websocket = new WebSocket(`${server.url.replace('http:', 'ws:')}/events?${params}`);
      await waitForSocketOpen(websocket);
      const streamingStopped = waitForLiveEvent(websocket, (event) => {
        const typed = event as {
          type?: unknown;
          payload?: { threadId?: unknown; isStreaming?: unknown };
        };
        return (
          typed.type === 'thread/streaming-changed' &&
          typed.payload?.threadId === 'thread-1' &&
          typed.payload?.isStreaming === false
        );
      });
      const statusIdle = waitForLiveEvent(websocket, (event) => {
        const typed = event as {
          type?: unknown;
          payload?: { threadId?: unknown; status?: unknown };
        };
        return (
          typed.type === 'thread/status/changed' &&
          typed.payload?.threadId === 'thread-1' &&
          typed.payload?.status === 'idle'
        );
      });

      const stopResponse = await fetch(`${server.url}/threads/thread-1/stop`, {
        method: 'POST',
        headers: authHeaders(token, deviceId)
      });

      // Stop now reports success even when Codex says there's no active turn —
      // the user's intent ("make this thread quiet") is satisfied because the
      // helper still broadcasts streaming-changed=false + status=idle. Returning
      // a 409 here led to a stuck stop button on the tablet.
      await expect(stopResponse.json()).resolves.toEqual({ ok: true });
      expect(stopResponse.status).toBe(200);
      expect(appServer.interruptTurn).toHaveBeenCalledWith('thread-1');
      await expect(streamingStopped).resolves.toMatchObject({
        type: 'thread/streaming-changed',
        payload: { threadId: 'thread-1', isStreaming: false }
      });
      await expect(statusIdle).resolves.toMatchObject({
        type: 'thread/status/changed',
        payload: { threadId: 'thread-1', status: 'idle' }
      });
      websocket.close();
    } finally {
      await server.stop();
    }
  });

  it('fills missing app-server reasoning metadata from the local model catalog', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(),
      sendMessage: vi.fn(),
      listModels: vi.fn(async () => [
        {
          slug: 'gpt-5.5',
          displayName: 'GPT-5.5',
          visibility: 'visible'
        }
      ] satisfies CatalogModel[])
    };
    const catalogModels: CatalogModel[] = [
      {
        slug: 'gpt-5.5',
        displayName: 'GPT-5.5',
        defaultReasoningLevel: 'medium',
        supportedReasoningLevels: [
          { effort: 'low', description: 'Low' },
          { effort: 'medium', description: 'Medium' },
          { effort: 'high', description: 'High' },
          { effort: 'xhigh', description: 'Extra high' }
        ],
        visibility: 'list'
      }
    ];
    const catalog = {
      onChange: vi.fn(() => () => undefined),
      listModels: vi.fn(async () => catalogModels),
      listPlugins: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listCommands: vi.fn(async () => [])
    } as unknown as import('../codex/catalog').CatalogReader;
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      catalog,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);

      const response = await fetch(`${server.url}/catalog/models`, {
        headers: authHeaders(token, deviceId)
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        models: [
          {
            slug: 'gpt-5.5',
            displayName: 'GPT-5.5',
            defaultReasoningLevel: 'medium',
            supportedReasoningLevels: [
              { effort: 'low', description: 'Low' },
              { effort: 'medium', description: 'Medium' },
              { effort: 'high', description: 'High' },
              { effort: 'xhigh', description: 'Extra high' }
            ],
            visibility: 'visible'
          }
        ]
      });
      expect(appServer.listModels).toHaveBeenCalled();
      expect(catalog.listModels).toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('adds Claude Code models to the provider-aware model catalog', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(),
      sendMessage: vi.fn(),
      listModels: vi.fn(async () => [
        {
          slug: 'gpt-5.5',
          displayName: 'GPT-5.5',
          visibility: 'visible'
        }
      ] satisfies CatalogModel[])
    };
    const claudeCode = {
      listThreads: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      readTranscript: vi.fn(),
      sendMessage: vi.fn(),
      listModels: vi.fn(async () => [
        {
          slug: 'opus',
          displayName: 'Claude Opus',
          provider: 'claude-code' as const,
          description: 'Higher-capability Claude Code model alias.',
          defaultReasoningLevel: 'medium',
          supportedReasoningLevels: [
            { effort: 'low', description: 'Fastest Claude Code reasoning.' },
            { effort: 'medium', description: 'Balanced Claude Code reasoning.' },
            { effort: 'high', description: 'Deeper Claude Code reasoning.' },
            { effort: 'xhigh', description: 'Extra-deep Claude Code reasoning.' },
            { effort: 'max', description: 'Maximum Claude Code reasoning.' }
          ],
          visibility: 'visible',
          priority: 10
        }
      ] satisfies CatalogModel[])
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      claudeCode,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);

      const response = await fetch(`${server.url}/catalog/models`, {
        headers: authHeaders(token, deviceId)
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        models: [
          {
            slug: 'gpt-5.5',
            displayName: 'GPT-5.5',
            visibility: 'visible'
          },
          {
            slug: 'opus',
            displayName: 'Claude Opus',
            provider: 'claude-code',
            description: 'Higher-capability Claude Code model alias.',
            defaultReasoningLevel: 'medium',
            supportedReasoningLevels: [
              { effort: 'low', description: 'Fastest Claude Code reasoning.' },
              { effort: 'medium', description: 'Balanced Claude Code reasoning.' },
              { effort: 'high', description: 'Deeper Claude Code reasoning.' },
              { effort: 'xhigh', description: 'Extra-deep Claude Code reasoning.' },
              { effort: 'max', description: 'Maximum Claude Code reasoning.' }
            ],
            visibility: 'visible',
            priority: 10
          }
        ]
      });
    } finally {
      await server.stop();
    }
  });

  it('applies a model change live via the IPC mirror', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const transcript: ThreadTranscript = {
      threadId: 'thread-1',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: []
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => transcript),
      sendMessage: vi.fn(async () => {
        throw new Error('app-server send must not run when mirror is the source of truth.');
      })
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(async () => ({
        ok: true as const,
        mode: 'start' as const,
        turnId: 'mirror-turn-1',
        transcript
      })),
      setModelAndReasoning: vi.fn(async () => undefined),
      isThreadOwned: () => true,
      waitForOwnership: async () => true
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      mirror,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);

      const modelResponse = await fetch(`${server.url}/threads/thread-1/model`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ modelSlug: 'gpt-5.4', reasoningEffort: 'high' })
      });
      expect(modelResponse.status).toBe(200);
      expect(mirror.setModelAndReasoning).toHaveBeenCalledWith(
        'thread-1',
        'gpt-5.4',
        'high'
      );

      // The next send goes through the mirror without any queued override
      // (since the mirror already applied the model change live).
      const sendResponse = await fetch(`${server.url}/threads/thread-1/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ text: 'Use the new model' })
      });
      expect(sendResponse.status).toBe(200);
      expect(mirror.sendMessage).toHaveBeenCalledWith('thread-1', 'Use the new model', undefined);
      expect(appServer.sendMessage).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('applies a Claude Code model change through the Claude provider', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const claudeCode = {
      listThreads: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      readTranscript: vi.fn(),
      sendMessage: vi.fn(),
      setModel: vi.fn(async () => undefined)
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      claudeCode,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);

      const modelResponse = await fetch(`${server.url}/threads/claude-code%3Asession-1/model`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ modelSlug: 'opus', reasoningEffort: 'high' })
      });

      expect(modelResponse.status).toBe(200);
      expect(claudeCode.setModel).toHaveBeenCalledWith('claude-code:session-1', 'opus', 'high');
      await expect(modelResponse.json()).resolves.toEqual({
        ok: true,
        modelSlug: 'opus',
        reasoningEffort: 'high'
      });
    } finally {
      await server.stop();
    }
  });

  it('returns 503 when the IPC mirror is not connected (single source of truth)', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const transcript: ThreadTranscript = {
      threadId: 'thread-1',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: []
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => transcript),
      sendMessage: vi.fn(async () => ({
        ok: true as const,
        mode: 'start' as const,
        turnId: 'fallback-turn-1',
        transcript
      }))
    };
    const mirror = {
      isConnected: () => false,
      sendMessage: vi.fn()
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      mirror,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const sendResponse = await fetch(`${server.url}/threads/thread-1/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ text: 'Hi.' })
      });

      expect(sendResponse.status).toBe(503);
      expect(mirror.sendMessage).not.toHaveBeenCalled();
      expect(appServer.sendMessage).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('opens Codex from the tablet open endpoint with one mini-window refresh', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings: {
        port: await pickFreeHighPort(),
        lanEnabled: false,
        mobileSendEnabled: true,
        remoteAccess: remoteAccessSettings()
      },
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer: {
        isConnected: () => true,
        readTranscript: vi.fn(),
        sendMessage: vi.fn(),
        startThread: vi.fn()
      },
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(`${server.url}/thread/open`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ threadId: 'thread-1', mode: 'open' })
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(opener.openThread).toHaveBeenCalledWith('thread-1', { refreshMode: 'mini-window' });
      expect(opener.openThread).toHaveBeenCalledTimes(1);
      expect(opener.revealThread).not.toHaveBeenCalled();
      expect(opener.refreshDesktop).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('coalesces rapid duplicate Codex open requests for the same thread', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    let releaseOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const opener = {
      openThread: vi.fn(async () => {
        await openGate;
        return { ok: true as const };
      }),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings: {
        port: await pickFreeHighPort(),
        lanEnabled: false,
        mobileSendEnabled: true,
        remoteAccess: remoteAccessSettings()
      },
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer: {
        isConnected: () => true,
        readTranscript: vi.fn(),
        sendMessage: vi.fn(),
        startThread: vi.fn()
      },
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const request = () =>
        fetch(`${server.url}/thread/open`, {
          method: 'POST',
          headers: {
            ...authHeaders(token, deviceId),
            'content-type': 'application/json'
          },
          body: JSON.stringify({ threadId: 'thread-1', mode: 'open' })
        });

      const first = request();
      const second = request();
      await vi.waitFor(() => expect(opener.openThread).toHaveBeenCalledTimes(1));
      releaseOpen?.();

      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(opener.openThread).toHaveBeenCalledWith('thread-1', { refreshMode: 'mini-window' });
      expect(opener.openThread).toHaveBeenCalledTimes(1);
      expect(opener.refreshDesktop).not.toHaveBeenCalled();
    } finally {
      releaseOpen?.();
      await server.stop();
    }
  });

  it('refreshes an opened Agent Pulse-owned turn once after turn completion', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    let onTurnCompleted: ((event: { threadId: string; turnId: string }) => void) | undefined;
    const transcript: ThreadTranscript = {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      sendState: { canSend: false, reason: 'thread_changed', label: 'Codex is working' },
      messages: []
    };
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      isCodexFrontmost: vi.fn(async () => false),
      dispose: vi.fn()
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => transcript),
      sendMessage: vi.fn(async () => {
        throw new Error('mirror should own sends; app-server is reserved for app-server-only ops.');
      }),
      startThread: vi.fn(),
      onTurnCompleted: vi.fn((listener: (event: { threadId: string; turnId: string }) => void) => {
        onTurnCompleted = listener;
        return vi.fn();
      })
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(async () => ({
        ok: true as const,
        mode: 'start' as const,
        turnId: 'turn-1',
        transcript
      })),
      isThreadOwned: () => true,
      waitForOwnership: async () => true
    };
    const server = await startAgentPulseServer({
      settings: {
        port: await pickFreeHighPort(),
        lanEnabled: false,
        mobileSendEnabled: true,
        remoteAccess: remoteAccessSettings()
      },
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      mirror,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      await fetch(`${server.url}/thread/open`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ threadId: 'thread-1', mode: 'open' })
      });
      opener.openThread.mockClear();

      const sendResponse = await fetch(`${server.url}/threads/thread-1/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ text: 'Do the work.' })
      });
      expect(sendResponse.status).toBe(200);
      expect(opener.openThread).not.toHaveBeenCalled();

      onTurnCompleted?.({ threadId: 'thread-1', turnId: 'turn-1' });
      onTurnCompleted?.({ threadId: 'thread-1', turnId: 'turn-1' });

      await vi.waitFor(
        () =>
          expect(opener.openThread).toHaveBeenCalledWith('thread-1', {
            refreshMode: 'mini-window'
          }),
        { timeout: 1500 }
      );
      expect(opener.openThread).toHaveBeenCalledTimes(1);
      expect(opener.isCodexFrontmost).toHaveBeenCalled();
      expect(opener.refreshDesktop).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('broadcasts a fresh transcript as soon as app-server reports turn completion', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    let onTurnCompleted: ((event: { threadId: string; turnId: string }) => void) | undefined;
    const finalTranscript: ThreadTranscript = {
      threadId: 'thread-1',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: [
        {
          id: 'assistant-final',
          role: 'assistant',
          kind: 'message',
          text: 'Done now.',
          createdAt: '2026-04-29T16:40:00Z'
        }
      ]
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => finalTranscript),
      sendMessage: vi.fn(),
      startThread: vi.fn(),
      onTurnCompleted: vi.fn((listener: (event: { threadId: string; turnId: string }) => void) => {
        onTurnCompleted = listener;
        return vi.fn();
      })
    };
    const server = await startAgentPulseServer({
      settings: {
        port: await pickFreeHighPort(),
        lanEnabled: false,
        mobileSendEnabled: true,
        remoteAccess: remoteAccessSettings()
      },
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener: {
        openThread: vi.fn(async () => ({ ok: true as const })),
        revealThread: vi.fn(async () => ({ ok: true as const })),
        refreshDesktop: vi.fn(),
        dispose: vi.fn()
      },
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const params = new URLSearchParams({
        token,
        deviceId,
        fingerprint: 'fingerprint-123'
      });
      const websocket = new WebSocket(`${server.url.replace('http:', 'ws:')}/events?${params}`);
      await waitForSocketOpen(websocket);
      const transcriptChanged = waitForLiveEvent(websocket, (event) => {
        const typed = event as {
          type?: unknown;
          payload?: { threadId?: unknown; messages?: Array<{ text?: unknown }> };
        };
        return (
          typed.type === 'thread/transcript/changed' &&
          typed.payload?.threadId === 'thread-1' &&
          typed.payload?.messages?.some((message) => message.text === 'Done now.') === true
        );
      });

      onTurnCompleted?.({ threadId: 'thread-1', turnId: 'turn-1' });

      await expect(transcriptChanged).resolves.toMatchObject({
        type: 'thread/transcript/changed',
        payload: {
          threadId: 'thread-1',
          activeTurnId: null,
          sendState: { canSend: true, reason: 'ready', label: 'Ready' },
          messages: [{ id: 'assistant-final', text: 'Done now.' }]
        }
      });
      expect(appServer.readTranscript).toHaveBeenCalledWith('thread-1');
      websocket.close();
    } finally {
      await server.stop();
    }
  });

  it('does not auto-refresh completed turns that were not started from Agent Pulse', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    let onTurnCompleted: ((event: { threadId: string; turnId: string }) => void) | undefined;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      isCodexFrontmost: vi.fn(async () => false),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings: {
        port: await pickFreeHighPort(),
        lanEnabled: false,
        mobileSendEnabled: true,
        remoteAccess: remoteAccessSettings()
      },
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer: {
        isConnected: () => true,
        readTranscript: vi.fn(),
        sendMessage: vi.fn(),
        startThread: vi.fn(),
        onTurnCompleted: vi.fn((listener: (event: { threadId: string; turnId: string }) => void) => {
          onTurnCompleted = listener;
          return vi.fn();
        })
      },
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      await fetch(`${server.url}/thread/open`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ threadId: 'thread-1', mode: 'open' })
      });
      opener.openThread.mockClear();

      onTurnCompleted?.({ threadId: 'thread-1', turnId: 'desktop-turn' });

      await new Promise((resolve) => setTimeout(resolve, 950));
      expect(opener.openThread).not.toHaveBeenCalled();
      expect(opener.isCodexFrontmost).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('skips automatic completion refresh when Codex desktop is frontmost', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    let onTurnCompleted: ((event: { threadId: string; turnId: string }) => void) | undefined;
    const transcript: ThreadTranscript = {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      sendState: { canSend: false, reason: 'thread_changed', label: 'Codex is working' },
      messages: []
    };
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      isCodexFrontmost: vi.fn(async () => true),
      dispose: vi.fn()
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(async () => ({
        ok: true as const,
        mode: 'start' as const,
        turnId: 'turn-1',
        transcript
      })),
      isThreadOwned: () => true,
      waitForOwnership: async () => true
    };
    const server = await startAgentPulseServer({
      settings: {
        port: await pickFreeHighPort(),
        lanEnabled: false,
        mobileSendEnabled: true,
        remoteAccess: remoteAccessSettings()
      },
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer: {
        isConnected: () => true,
        readTranscript: vi.fn(async () => transcript),
        sendMessage: vi.fn(async () => {
          throw new Error('mirror should own sends.');
        }),
        startThread: vi.fn(),
        onTurnCompleted: vi.fn((listener: (event: { threadId: string; turnId: string }) => void) => {
          onTurnCompleted = listener;
          return vi.fn();
        })
      },
      mirror,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      await fetch(`${server.url}/thread/open`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ threadId: 'thread-1', mode: 'open' })
      });
      opener.openThread.mockClear();

      await fetch(`${server.url}/threads/thread-1/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ text: 'Do the work.' })
      });
      onTurnCompleted?.({ threadId: 'thread-1', turnId: 'turn-1' });

      await new Promise((resolve) => setTimeout(resolve, 950));
      expect(opener.isCodexFrontmost).toHaveBeenCalled();
      expect(opener.openThread).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('keeps only the latest eligible completion when multiple chats finish together', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    let onTurnCompleted: ((event: { threadId: string; turnId: string }) => void) | undefined;
    const transcriptFor = (threadId: string, turnId: string): ThreadTranscript => ({
      threadId,
      activeTurnId: turnId,
      sendState: { canSend: false, reason: 'thread_changed', label: 'Codex is working' },
      messages: []
    });
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      isCodexFrontmost: vi.fn(async () => false),
      dispose: vi.fn()
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(),
      sendMessage: vi.fn(async () => {
        throw new Error('mirror should own sends.');
      }),
      startThread: vi.fn(),
      onTurnCompleted: vi.fn((listener: (event: { threadId: string; turnId: string }) => void) => {
        onTurnCompleted = listener;
        return vi.fn();
      })
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(async (threadId: string) => ({
        ok: true as const,
        mode: 'start' as const,
        turnId: `turn-${threadId}`,
        transcript: transcriptFor(threadId, `turn-${threadId}`)
      })),
      isThreadOwned: () => true,
      waitForOwnership: async () => true
    };
    const server = await startAgentPulseServer({
      settings: {
        port: await pickFreeHighPort(),
        lanEnabled: false,
        mobileSendEnabled: true,
        remoteAccess: remoteAccessSettings()
      },
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [] },
      opener,
      appServer,
      mirror,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      for (const threadId of ['thread-1', 'thread-2']) {
        await fetch(`${server.url}/thread/open`, {
          method: 'POST',
          headers: {
            ...authHeaders(token, deviceId),
            'content-type': 'application/json'
          },
          body: JSON.stringify({ threadId, mode: 'open' })
        });
      }
      opener.openThread.mockClear();

      for (const threadId of ['thread-1', 'thread-2']) {
        await fetch(`${server.url}/threads/${threadId}/messages`, {
          method: 'POST',
          headers: {
            ...authHeaders(token, deviceId),
            'content-type': 'application/json'
          },
          body: JSON.stringify({ text: 'Do the work.' })
        });
      }

      onTurnCompleted?.({ threadId: 'thread-1', turnId: 'turn-thread-1' });
      onTurnCompleted?.({ threadId: 'thread-2', turnId: 'turn-thread-2' });

      await vi.waitFor(
        () =>
          expect(opener.openThread).toHaveBeenCalledWith('thread-2', {
            refreshMode: 'mini-window'
          }),
        { timeout: 1500 }
      );
      expect(opener.openThread).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });

  it('lists Codex projects and starts a new thread in the selected project', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const projectPath = mkdtempSync(path.join(tmpdir(), 'agent-pulse-project-'));
    const createdThread: Thread = {
      threadId: 'thread-new',
      provider: 'codex',
      title: 'New thread',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-26T10:00:00Z',
      lastTurnSummary: ''
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(),
      sendMessage: vi.fn(),
      startThread: vi.fn(async () => createdThread)
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: {
        listThreads: async () => [],
        listProjects: async () => [
          {
            projectId: 'project-codexpulse',
            name: 'CodexPulse',
            path: projectPath,
            providers: ['codex']
          }
        ]
      },
      opener,
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const projectsResponse = await fetch(`${server.url}/projects/list`, {
        headers: authHeaders(token, deviceId)
      });

      expect(projectsResponse.status).toBe(200);
      await expect(projectsResponse.json()).resolves.toEqual({
        projects: [
          {
            projectId: 'project-codexpulse',
            name: 'CodexPulse',
            path: projectPath,
            providers: ['codex']
          }
        ]
      });

      const createResponse = await fetch(`${server.url}/threads/new`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ projectId: 'project-codexpulse' })
      });

      expect(createResponse.status).toBe(200);
      await expect(createResponse.json()).resolves.toEqual({ thread: createdThread });
      expect(appServer.startThread).toHaveBeenCalledWith(projectPath, {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(opener.openThread).not.toHaveBeenCalled();

      // Second call: caller passes a model + reasoning effort, helper must
      // forward both to startThread so thread/start picks them up.
      appServer.startThread.mockClear();
      const overrideResponse = await fetch(`${server.url}/threads/new`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          projectId: 'project-codexpulse',
          modelSlug: 'gpt-5.6',
          reasoningEffort: 'high'
        })
      });

      expect(overrideResponse.status).toBe(200);
      expect(appServer.startThread).toHaveBeenCalledWith(projectPath, {
        model: 'gpt-5.6',
        reasoningEffort: 'high'
      });
    } finally {
      await server.stop();
    }
  });

  it('keeps a new project thread visible while Codex still treats it as a draft', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const projectPath = mkdtempSync(path.join(tmpdir(), 'agent-pulse-project-'));
    const draftThread: Thread = {
      threadId: 'thread-draft',
      provider: 'codex',
      title: 'New thread',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-26T10:00:00Z',
      lastTurnSummary: ''
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => {
        throw new Error('thread thread-draft is not materialized yet; includeTurns is unavailable before first user message');
      }),
      sendMessage: vi.fn(async () => {
        throw new Error('mirror should own sends.');
      }),
      startThread: vi.fn(async () => draftThread)
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(
        async (
          _threadId: string,
          text: string
        ): Promise<import('@agent-pulse/shared').ThreadMessageResponse> => ({
          ok: true,
          mode: 'start',
          turnId: 'turn-first',
          transcript: {
            threadId: 'thread-draft',
            activeTurnId: 'turn-first',
            sendState: {
              canSend: false,
              reason: 'missing_active_turn',
              label: 'Codex is working'
            },
            messages: [
              {
                id: 'user-first',
                role: 'user',
                kind: 'message',
                text,
                createdAt: '2026-04-26T10:00:01Z'
              }
            ]
          }
        })
      ),
      isThreadOwned: () => true,
      waitForOwnership: async () => true
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const settingsStore = {
      save: vi.fn(),
      load: vi.fn()
    } as unknown as HelperSettingsStore;
    const opener = {
      openThread: vi.fn(async () => ({ ok: true as const })),
      revealThread: vi.fn(async () => ({ ok: true as const })),
      refreshDesktop: vi.fn(),
      dispose: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: {
        listThreads: async () => [],
        listProjects: async () => [
          {
            projectId: 'project-codexpulse',
            name: 'CodexPulse',
            path: projectPath
          }
        ]
      },
      opener,
      appServer,
      mirror,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const createResponse = await fetch(`${server.url}/threads/new`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ projectId: 'project-codexpulse' })
      });
      expect(createResponse.status).toBe(200);

      const listResponse = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(token, deviceId)
      });
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual({ threads: [draftThread] });

      const transcriptResponse = await fetch(`${server.url}/threads/thread-draft/transcript`, {
        headers: authHeaders(token, deviceId)
      });
      expect(transcriptResponse.status).toBe(200);
      await expect(transcriptResponse.json()).resolves.toEqual({
        threadId: 'thread-draft',
        provider: 'codex',
        activeTurnId: null,
        sendState: {
          canSend: true,
          reason: 'ready',
          label: 'Ready'
        },
        messages: []
      });

      const messageResponse = await fetch(`${server.url}/threads/thread-draft/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ text: 'Start inside this project.' })
      });
      expect(messageResponse.status).toBe(200);
      expect(mirror.sendMessage).toHaveBeenCalledWith(
        'thread-draft',
        'Start inside this project.',
        undefined
      );
      expect(appServer.sendMessage).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('discards a new Codex draft thread without archiving provider history', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const projectPath = mkdtempSync(path.join(tmpdir(), 'agent-pulse-project-'));
    const draftThread: Thread = {
      threadId: 'thread-draft-empty',
      provider: 'codex',
      title: 'New thread',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-26T10:00:00Z',
      lastTurnSummary: ''
    };
    const appServer = {
      isConnected: () => true,
      readTranscript: vi.fn(async () => {
        throw new Error('not materialized');
      }),
      sendMessage: vi.fn(),
      startThread: vi.fn(async () => draftThread),
      archiveThread: vi.fn()
    };
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: {
        listThreads: async () => [],
        listProjects: async () => [
          {
            projectId: 'project-codexpulse',
            name: 'CodexPulse',
            path: projectPath,
            providers: ['codex']
          }
        ]
      },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const createResponse = await fetch(`${server.url}/threads/new`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ projectId: 'project-codexpulse' })
      });
      expect(createResponse.status).toBe(200);

      const deleteResponse = await fetch(`${server.url}/threads/thread-draft-empty`, {
        method: 'DELETE',
        headers: authHeaders(token, deviceId)
      });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual({ ok: true });
      expect(appServer.archiveThread).not.toHaveBeenCalled();

      const listResponse = await fetch(`${server.url}/threads/list`, {
        headers: authHeaders(token, deviceId)
      });
      await expect(listResponse.json()).resolves.toEqual({ threads: [] });
    } finally {
      await server.stop();
    }
  });

  it('deletes a thread by archiving it through Codex app-server', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const thread: Thread = {
      threadId: 'thread-delete',
      title: 'Old thread',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-30T12:00:00Z',
      lastTurnSummary: 'Ready'
    };
    const appServer = {
      isConnected: () => true,
      ensureConnected: vi.fn(async () => undefined),
      archiveThread: vi.fn(async () => undefined),
      readTranscript: vi.fn(async (): Promise<ThreadTranscript> => ({
        threadId: 'thread-delete',
        activeTurnId: null,
        sendState: {
          canSend: true,
          reason: 'ready',
          label: 'Ready'
        },
        messages: []
      })),
      sendMessage: vi.fn()
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [thread] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      appServer,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(`${server.url}/threads/thread-delete`, {
        method: 'DELETE',
        headers: authHeaders(token, deviceId)
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(appServer.archiveThread).toHaveBeenCalledWith('thread-delete');
    } finally {
      await server.stop();
    }
  });

  it('deletes a Claude Code thread through the Claude provider', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const settings = {
      port: await pickFreeHighPort(),
      lanEnabled: false,
      mobileSendEnabled: true,
      remoteAccess: remoteAccessSettings()
    };
    const thread: Thread = {
      threadId: 'claude-code:thread-delete',
      provider: 'claude-code',
      providerThreadId: 'thread-delete',
      title: 'Old Claude thread',
      workspace: 'CodexPulse',
      status: 'idle',
      lastActivityAt: '2026-04-30T12:00:00Z',
      lastTurnSummary: 'Ready'
    };
    const claudeCode = {
      listThreads: vi.fn(async () => [thread]),
      listProjects: vi.fn(async () => []),
      readTranscript: vi.fn(),
      sendMessage: vi.fn(),
      deleteThread: vi.fn(async () => undefined)
    };
    const server = await startAgentPulseServer({
      settings,
      settingsStore: { save: vi.fn(), load: vi.fn() } as unknown as HelperSettingsStore,
      registry,
      pairing,
      adminAuth: createAdminAuth(),
      threadProvider: { listThreads: async () => [thread] },
      opener: createThreadOpener({ execFile: vi.fn((_command, _args, callback) => callback(null)) }),
      claudeCode,
      version: '0.1.0'
    });

    try {
      const { token, deviceId } = await pairForTest(server.url, pairing);
      const response = await fetch(`${server.url}/threads/${encodeURIComponent(thread.threadId)}`, {
        method: 'DELETE',
        headers: authHeaders(token, deviceId)
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(claudeCode.deleteThread).toHaveBeenCalledWith('claude-code:thread-delete');
    } finally {
      await server.stop();
    }
  });
});

async function pairForTest(url: string, pairing: PairingManager) {
  const { pin } = pairing.createPin();
  const response = await fetch(`${url}/device/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pin,
      deviceName: 'Desk iPad',
      fingerprint: 'fingerprint-123'
    })
  });

  return (await response.json()) as { token: string; deviceId: string };
}

function authHeaders(token: string, deviceId: string, fingerprint = 'fingerprint-123') {
  return {
    authorization: `Bearer ${token}`,
    'x-agent-pulse-device-id': deviceId,
    'x-agent-pulse-fingerprint': fingerprint
  };
}

function waitForSocketOpen(websocket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    websocket.once('open', () => resolve());
    websocket.once('error', reject);
  });
}

function waitForSocketClose(websocket: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1_000);
    websocket.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function waitForSocketRejected(websocket: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1_000);
    websocket.once('open', () => {
      clearTimeout(timer);
      websocket.close();
      resolve(false);
    });
    websocket.once('error', () => {
      clearTimeout(timer);
      resolve(true);
    });
    websocket.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function waitForLiveEvent(
  websocket: WebSocket,
  predicate: (event: unknown) => boolean
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      websocket.off('message', onMessage);
    };
    const onMessage = (data: RawData) => {
      try {
        const event = JSON.parse(data.toString());
        if (!predicate(event)) {
          return;
        }
        cleanup();
        resolve(event);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for live event.'));
    }, 1_000);
    websocket.on('message', onMessage);
  });
}

function remoteAccessSettings(overrides: Partial<RemoteAccessSettings> = {}): RemoteAccessSettings {
  return {
    enabled: false,
    provider: 'cloudflare' as const,
    mode: 'quick' as const,
    tunnelProtocol: 'auto' as const,
    hostname: '',
    publicUrl: '',
    tunnelName: 'agent-pulse',
    tunnelId: '',
    configPath: '/tmp/agent-pulse-cloudflared/config.yml',
    metricsUrl: 'http://127.0.0.1:60123/metrics',
    status: 'off' as const,
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
    ...overrides
  };
}
