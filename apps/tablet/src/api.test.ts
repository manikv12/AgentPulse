// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPairingDevices,
  fetchProjects,
  checkRemoteAccess,
  updateRemoteAccess,
  updateEnabledProviders,
  fetchThreadTranscript,
  getFingerprint,
  deleteThread,
  openThreadInCodex,
  pairDevice,
  sendThreadMessage,
  stopThreadWork,
  startThread,
  AgentPulseApiError
} from './api';

describe('tablet API helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates a stable fingerprint when randomUUID is not available', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Date, 'now').mockReturnValue(123456789);
    vi.spyOn(Math, 'random').mockReturnValue(0.42);

    const first = getFingerprint();
    const second = getFingerprint();

    expect(first).toMatch(/^web-/);
    expect(first).toBe(second);
  });

  it('uses the helper error message when pairing fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Pairing PIN is invalid or expired.' })
      }))
    );

    await expect(
      pairDevice({
        pin: '000000',
        deviceName: 'Desk tablet',
        fingerprint: 'browser-fingerprint'
      })
    ).rejects.toThrow('Pairing PIN is invalid or expired.');
  });

  it('loads saved device options for the pairing screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          devices: [
            {
              deviceId: 'device-1',
              deviceName: 'Desk tablet',
              lastSeenAt: '2026-04-26T10:00:00Z'
            }
          ]
        })
      }))
    );

    await expect(fetchPairingDevices()).resolves.toEqual([
      {
        deviceId: 'device-1',
        deviceName: 'Desk tablet',
        lastSeenAt: '2026-04-26T10:00:00Z'
      }
    ]);
  });

  it('checks and updates remote access through admin routes', async () => {
    const remoteAccess = {
      enabled: false,
      provider: 'cloudflare',
      mode: 'quick',
      tunnelProtocol: 'auto',
      hostname: '',
      publicUrl: '',
      tunnelName: 'agent-pulse',
      tunnelId: '',
      configPath: '/tmp/config.yml',
      metricsUrl: 'http://127.0.0.1:60123/metrics',
      status: 'off',
      lastError: 'Install cloudflared first.',
      lastStartedAt: null,
      lastStoppedAt: null,
      lastCheckedAt: '2026-04-26T10:00:00Z',
      checklist: {
        dependencyInstalled: false,
        authenticated: false,
        configured: false,
        tunnelRunning: false,
        hostnameAssigned: false
      }
    };
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/settings/remote-access/check') {
        return {
          ok: true,
          json: async () => ({ ok: true, remoteAccess })
        };
      }

      if (url === '/settings/remote-access') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            remoteAccess: { ...remoteAccess, enabled: true, status: 'disconnected', tunnelProtocol: 'http2' }
          })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkRemoteAccess('admin-token')).resolves.toEqual(remoteAccess);
    await expect(updateRemoteAccess('admin-token', { enabled: true, tunnelProtocol: 'http2' })).resolves.toMatchObject({
      enabled: true,
      tunnelProtocol: 'http2',
      status: 'disconnected'
    });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      enabled: true,
      tunnelProtocol: 'http2'
    });
  });

  it('updates enabled agent providers through admin routes', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/settings/providers');
      expect(JSON.parse(init?.body as string)).toEqual({ enabledProviders: ['claude-code'] });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          settings: {
            enabledProviders: ['claude-code'],
            lanEnabled: false,
            mobileSendEnabled: true
          }
        })
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateEnabledProviders('admin-token', ['claude-code'])).resolves.toMatchObject({
      enabledProviders: ['claude-code']
    });
  });

  it('pairs with a saved device id and returns the resolved device name', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: 'token-1234567890',
        deviceId: 'device-1',
        deviceName: 'Desk tablet'
      })
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pairDevice({
        pin: '123456',
        existingDeviceId: 'device-1',
        fingerprint: 'browser-fingerprint'
      })
    ).resolves.toEqual({
      token: 'token-1234567890',
      deviceId: 'device-1',
      deviceName: 'Desk tablet'
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/device/pair',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          pin: '123456',
          existingDeviceId: 'device-1',
          fingerprint: 'browser-fingerprint'
        })
      })
    );
  });

  it('reads and sends same-thread chat through authenticated helper routes', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/threads/thread-1/transcript') {
        return {
          ok: true,
          json: async () => ({
            threadId: 'thread-1',
            activeTurnId: null,
            sendState: { canSend: true, reason: 'ready', label: 'Ready' },
            messages: []
          })
        };
      }

      if (url === '/threads/thread-1/messages') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            mode: 'start',
            turnId: 'turn-1',
            transcript: {
              threadId: 'thread-1',
              activeTurnId: 'turn-1',
              sendState: { canSend: true, reason: 'ready', label: 'Ready' },
              messages: [
                {
                  id: 'user-1',
                  role: 'user',
                  kind: 'message',
                  text: 'Hello from phone.',
                  createdAt: '2026-04-25T16:14:00Z'
                }
              ]
            }
          })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };

    const transcript = await fetchThreadTranscript(session, 'thread-1');
    const sendResult = await sendThreadMessage(session, 'thread-1', 'Hello from phone.');

    expect(transcript.threadId).toBe('thread-1');
    expect(sendResult.transcript.messages[0]?.text).toBe('Hello from phone.');
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/threads/thread-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Hello from phone.' })
      })
    );
  });

  it('includes image attachments when sending a tablet message', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/threads/thread-1/messages') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            mode: 'start',
            turnId: 'turn-1',
            transcript: {
              threadId: 'thread-1',
              activeTurnId: null,
              sendState: { canSend: true, reason: 'ready', label: 'Ready' },
              messages: [
                {
                  id: 'user-1',
                  role: 'user',
                  kind: 'message',
                  text: 'See this.',
                  createdAt: '2026-04-25T16:14:00Z',
                  attachments: [
                    {
                      id: 'pasted-image-1',
                      kind: 'image',
                      url: '/attachments/token',
                      alt: 'Pasted image 1'
                    }
                  ]
                }
              ]
            }
          })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };
    const attachment = {
      id: 'pasted-image-1',
      kind: 'image' as const,
      url: 'data:image/png;base64,iVBORw0KGgo=',
      alt: 'Pasted image 1',
      mimeType: 'image/png'
    };

    await sendThreadMessage(session, 'thread-1', 'See this.', {
      attachments: [attachment]
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/threads/thread-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'See this.', attachments: [attachment] })
      })
    );
  });

  it('stops Codex work through the authenticated helper route', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/threads/thread-1/stop') {
        return {
          ok: true,
          json: async () => ({ ok: true })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };

    await expect(stopThreadWork(session, 'thread-1')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/threads/thread-1/stop',
      expect.objectContaining({
        method: 'POST'
      })
    );
  });

  it('keeps the helper stop failure reason for stale running cleanup', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/threads/thread-1/stop') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'Codex is not currently running this thread.',
            reason: 'missing_active_turn'
          })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };

    await expect(stopThreadWork(session, 'thread-1')).rejects.toMatchObject({
      name: 'AgentPulseApiError',
      message: 'Codex is not currently running this thread.',
      status: 409,
      reason: 'missing_active_turn'
    } satisfies Partial<AgentPulseApiError>);
  });

  it('passes a transcript message limit to the helper when requested', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/threads/thread-1/transcript?limit=40') {
        return {
          ok: true,
          json: async () => ({
            threadId: 'thread-1',
            activeTurnId: null,
            sendState: { canSend: true, reason: 'ready', label: 'Ready' },
            messages: []
          })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };

    await expect(fetchThreadTranscript(session, 'thread-1', { messageLimit: 40 })).resolves.toMatchObject({
      threadId: 'thread-1'
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/threads/thread-1/transcript?limit=40',
      expect.objectContaining({
        headers: expect.any(Headers),
        signal: expect.any(AbortSignal)
      })
    );
  });

  it('lists projects and starts a new thread through authenticated helper routes', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/projects/list') {
        return {
          ok: true,
          json: async () => ({
            projects: [
              {
                projectId: 'project-codexpulse',
                name: 'CodexPulse',
                path: '/Users/me/projects/CodexPulse'
              }
            ]
          })
        };
      }

      if (url === '/threads/new') {
        return {
          ok: true,
          json: async () => ({
            thread: {
              threadId: 'thread-new',
              title: 'New thread',
              workspace: 'CodexPulse',
              status: 'idle',
              lastActivityAt: '2026-04-26T10:00:00Z',
              lastTurnSummary: ''
            }
          })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };

    const projects = await fetchProjects(session);
    const result = await startThread(session, 'project-codexpulse');

    expect(projects[0]?.name).toBe('CodexPulse');
    expect(result.thread.threadId).toBe('thread-new');
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/threads/new',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectId: 'project-codexpulse' })
      })
    );
  });

  it('starts a new thread from a manual folder path', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/threads/new') {
        return {
          ok: true,
          json: async () => ({
            thread: {
              threadId: 'thread-new',
              title: 'New thread',
              workspace: 'CodexPulse',
              status: 'idle',
              lastActivityAt: '2026-04-26T10:00:00Z',
              lastTurnSummary: ''
            }
          })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };

    await startThread(session, { cwd: '/Users/me/projects/CodexPulse' });

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/threads/new',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ cwd: '/Users/me/projects/CodexPulse' })
      })
    );
  });

  it('starts a new thread in the shared chat location', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/threads/new') {
        return {
          ok: true,
          json: async () => ({
            thread: {
              threadId: 'claude-code:thread-new',
              provider: 'claude-code',
              title: 'New Claude chat',
              workspace: 'Chats',
              workspaceKind: 'chat',
              status: 'idle',
              lastActivityAt: '2026-04-26T10:00:00Z',
              lastTurnSummary: ''
            }
          })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };

    await startThread(session, { location: 'chat', provider: 'claude-code' });

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/threads/new',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ location: 'chat', provider: 'claude-code' })
      })
    );
  });

  it('opens a thread in Codex through the authenticated helper route', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/thread/open') {
        return {
          ok: true,
          json: async () => ({ ok: true })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };

    await expect(openThreadInCodex(session, 'thread-1')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/thread/open',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ threadId: 'thread-1', mode: 'open' })
      })
    );
  });

  it('deletes a thread through the authenticated helper route', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/threads/thread-1') {
        return {
          ok: true,
          json: async () => ({ ok: true })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };

    await expect(deleteThread(session, 'thread-1')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/threads/thread-1',
      expect.objectContaining({
        method: 'DELETE'
      })
    );
  });

  it('stops waiting when transcript loading hangs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          })
      )
    );

    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };
    const transcriptPromise = fetchThreadTranscript(session, 'thread-1');
    // Swallow the rejection so vitest doesn't flag an unhandled promise while we
    // advance the fake clock past the abort timeout.
    transcriptPromise.catch(() => undefined);
    const expectation = expect(transcriptPromise).rejects.toThrow(
      'Conversation is taking too long to load.'
    );

    await vi.advanceTimersByTimeAsync(30_000);

    await expectation;
  });
});
