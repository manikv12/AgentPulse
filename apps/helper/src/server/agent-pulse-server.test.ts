import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteAccessSettings, Thread, ThreadTranscript } from '@agent-pulse/shared';
import { WebSocket } from 'ws';
import { AdminAuth } from '../auth/admin';
import { DeviceRegistry, MemoryDeviceStore, PairingManager } from '../auth/pairing';
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
  it('pairs a device, protects thread data, and blocks revoked tokens', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const adminAuth = createAdminAuth();
    await adminAuth.ensureInitialized();
    const adminToken = adminAuth.issueToken().token;
    const thread: Thread = {
      threadId: 'thread-1',
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
            role: 'assistant',
            kind: 'message',
            text: 'First',
            createdAt: '2026-04-25T16:14:00Z'
          },
          {
            id: 'message-2',
            role: 'assistant',
            kind: 'message',
            text: 'Second',
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

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        threadId: 'thread-1',
        activeTurnId: null,
        sendState: {
          canSend: true,
          reason: 'ready',
          label: 'Ready'
        },
        messages: [
          {
            id: 'message-2',
            role: 'assistant',
            kind: 'message',
            text: 'Second',
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

  it('reads transcripts through Codex App Server but blocks sends until mobile sending is enabled', async () => {
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

  it('sends a paired device message and broadcasts the updated transcript when mobile sending is enabled', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry);
    const transcript: ThreadTranscript = {
      threadId: 'thread-1',
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
      sendMessage: vi.fn(async () => ({ ok: true as const, mode: 'steer' as const, turnId: 'turn-1', transcript }))
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
      const sendResponse = await fetch(`${server.url}/threads/thread-1/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders(token, deviceId),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ text: 'Hello from phone.' })
      });

      const sendBody = await sendResponse.json();
      expect(sendBody).toEqual({
        ok: true,
        mode: 'steer',
        turnId: 'turn-1',
        transcript
      });
      expect(sendResponse.status).toBe(200);
      expect(appServer.sendMessage).toHaveBeenCalledWith('thread-1', 'Hello from phone.');
      expect(opener.refreshDesktop).not.toHaveBeenCalled();
      expect(opener.openThread).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('routes sends through the Codex mirror when it is connected', async () => {
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
        throw new Error('appServer.sendMessage should not be called when mirror is connected');
      })
    };
    const mirror = {
      isConnected: () => true,
      sendMessage: vi.fn(async () => ({
        ok: true as const,
        mode: 'start' as const,
        turnId: 'mirror-turn-1',
        transcript
      }))
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
      expect(mirror.sendMessage).toHaveBeenCalledWith('thread-1', 'Hello from phone.');
      expect(appServer.sendMessage).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('falls back to the local app-server send when the mirror is not connected', async () => {
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

      expect(sendResponse.status).toBe(200);
      expect(mirror.sendMessage).not.toHaveBeenCalled();
      expect(appServer.sendMessage).toHaveBeenCalledWith('thread-1', 'Hi.');
    } finally {
      await server.stop();
    }
  });

  it('opens Codex from the tablet open endpoint without refreshing desktop sync', async () => {
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
      expect(opener.openThread).toHaveBeenCalledWith('thread-1');
      expect(opener.revealThread).not.toHaveBeenCalled();
      expect(opener.refreshDesktop).not.toHaveBeenCalled();
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
            path: projectPath
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
            path: projectPath
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
      expect(appServer.startThread).toHaveBeenCalledWith(projectPath);
      expect(opener.openThread).not.toHaveBeenCalled();
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
