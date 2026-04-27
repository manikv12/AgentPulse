// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadTranscript } from '@agent-pulse/shared';
import { App, extractLatestModel, extractLatestReasoningEffort } from './App';
import { Dashboard } from './Dashboard';

describe('Agent Pulse tablet UI', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('extracts model changes from Codex stream-state broadcast shapes', () => {
    expect(
      extractLatestModel({
        change: {
          conversationState: {
            latestModel: 'gpt-5.5',
            latestReasoningEffort: 'xhigh'
          }
        }
      })
    ).toBe('gpt-5.5');
    expect(
      extractLatestReasoningEffort({
        change: {
          conversationState: {
            latestModel: 'gpt-5.5',
            latestReasoningEffort: 'xhigh'
          }
        }
      })
    ).toBe('xhigh');

    expect(
      extractLatestModel({
        change: {
          latestCollaborationMode: {
            settings: {
              model: 'gpt-5.4',
              reasoning_effort: 'high'
            }
          }
        }
      })
    ).toBe('gpt-5.4');
    expect(
      extractLatestReasoningEffort({
        change: {
          latestCollaborationMode: {
            settings: {
              model: 'gpt-5.4',
              reasoning_effort: 'high'
            }
          }
        }
      })
    ).toBe('high');

    expect(
      extractLatestModel({
        change: {
          settings: {
            model: 'gpt-5.3-codex',
            reasoningEffort: 'medium'
          }
        }
      })
    ).toBe('gpt-5.3-codex');
    expect(
      extractLatestReasoningEffort({
        change: {
          settings: {
            model: 'gpt-5.3-codex',
            reasoningEffort: 'medium'
          }
        }
      })
    ).toBe('medium');
  });

  it('turns off auto-capitalization for admin and pairing inputs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              codexAppServer: 'connected',
              version: '0.1.0',
              uptimeSec: 60
            })
          };
        }

        if (url === '/device/options') {
          return {
            ok: true,
            json: async () => ({ devices: [] })
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    const adminButton = screen.getByText('Admin mode').closest('button');
    if (!adminButton) {
      throw new Error('Admin chooser button not found.');
    }
    fireEvent.click(adminButton);
    const adminPasscodeInput = await screen.findByLabelText('Admin passcode');
    expect(adminPasscodeInput).toHaveAttribute('autocapitalize', 'off');
    expect(adminPasscodeInput).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const connectButton = screen.getByText('Connect a device').closest('button');
    if (!connectButton) {
      throw new Error('Connect chooser button not found.');
    }
    fireEvent.click(connectButton);
    expect(await screen.findByLabelText('Device name')).toHaveAttribute('autocapitalize', 'off');
  });

  it('shows saved pairing devices in a dropdown and lets the user switch back to a new name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              codexAppServer: 'connected',
              version: '0.1.0',
              uptimeSec: 60
            })
          };
        }

        if (url === '/device/options') {
          return {
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
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    const connectButton = screen.getByText('Connect a device').closest('button');
    if (!connectButton) {
      throw new Error('Connect chooser button not found.');
    }
    fireEvent.click(connectButton);

    const savedDeviceSelect = await screen.findByRole('combobox', { name: 'Saved device' });
    await waitFor(() =>
      expect(within(savedDeviceSelect).getByRole('option', { name: 'Desk tablet' })).toBeInTheDocument()
    );
    expect(screen.getByLabelText('Device name')).toBeInTheDocument();

    fireEvent.change(savedDeviceSelect, { target: { value: 'device-1' } });

    expect(screen.queryByLabelText('Device name')).not.toBeInTheDocument();
    expect(screen.getByText(/Using the saved name "Desk tablet"/)).toBeInTheDocument();

    fireEvent.change(savedDeviceSelect, { target: { value: '' } });

    expect(screen.getByLabelText('Device name')).toBeInTheDocument();
  });

  it('shows reconnect pins for paired devices in admin settings', async () => {
    sessionStorage.setItem('agent-pulse-admin-token', 'admin-token');
    window.location.hash = '#/settings';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              codexAppServer: 'connected',
              version: '0.1.0',
              uptimeSec: 60
            })
          };
        }

        if (url === '/settings/get') {
          return {
            ok: true,
            json: async () => ({
              settings: {
                lanEnabled: false,
                mobileSendEnabled: false
              },
              devices: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Desk tablet'
                }
              ],
              pairingPins: [
                {
                  pin: '123456',
                  expiresAt: '2026-04-27T10:00:00Z',
                  deviceId: 'device-1'
                }
              ]
            })
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    expect(await screen.findByText(/Reconnect PIN 123456/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh PIN' })).toBeInTheDocument();
  });

  it('lets admin choose a saved device before generating a reconnect PIN', async () => {
    sessionStorage.setItem('agent-pulse-admin-token', 'admin-token');
    window.location.hash = '#/settings';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/health/get') {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            codexAppServer: 'connected',
            version: '0.1.0',
            uptimeSec: 60
          })
        };
      }

      if (url === '/settings/get') {
        return {
          ok: true,
          json: async () => ({
            settings: {
              lanEnabled: false,
              mobileSendEnabled: false
            },
            devices: [
              {
                deviceId: 'device-1',
                deviceName: 'Desk tablet'
              }
            ],
            pairingPins: []
          })
        };
      }

      if (url === '/settings/pairing-pin') {
        expect(init?.body).toBe(JSON.stringify({ deviceId: 'device-1' }));
        return {
          ok: true,
          json: async () => ({
            pin: '654321',
            expiresAt: '2026-04-27T10:00:00Z',
            deviceId: 'device-1'
          })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const savedDeviceSelect = await screen.findByRole('combobox', { name: 'Saved device' });
    fireEvent.change(savedDeviceSelect, { target: { value: 'device-1' } });
    fireEvent.click(screen.getByTitle('Generate reconnect PIN'));

    expect(await screen.findByText('654321')).toBeInTheDocument();
  });

  it('shows remote access setup state in admin settings', async () => {
    sessionStorage.setItem('agent-pulse-admin-token', 'admin-token');
    window.location.hash = '#/settings';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              codexAppServer: 'connected',
              version: '0.1.0',
              uptimeSec: 60
            })
          };
        }

        if (url === '/settings/get') {
          return {
            ok: true,
            json: async () => ({
              settings: {
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
                }
              },
              devices: [],
              pairingPins: []
            })
          };
        }

        if (url === '/settings/remote-access') {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              remoteAccess: {
                enabled: false,
                provider: 'cloudflare',
                mode: 'quick',
                tunnelProtocol: 'http2',
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
              }
            })
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Remote access' })).toBeInTheDocument();
    expect(screen.getByText('Install cloudflared first.')).toBeInTheDocument();
    expect(screen.getByText('No domain needed. Agent Pulse will ask Cloudflare for a temporary public URL.')).toBeInTheDocument();
    expect(screen.getByLabelText('Tunnel protocol')).toHaveValue('auto');
    expect(screen.getByTitle(/Auto lets Cloudflare choose/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Cloudflare hostname')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check setup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on remote access' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Tunnel protocol'), { target: { value: 'http2' } });
    await waitFor(() =>
      expect(screen.getByLabelText('Tunnel protocol')).toHaveValue('http2')
    );
  });

  it('stores the selected thread in the URL while browsing the dashboard', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'token-1234567890',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );

    class MockWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(readonly url: string | URL) {}

      close(): void {}
    }

    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              codexAppServer: 'connected',
              version: '0.1.0',
              uptimeSec: 60
            })
          };
        }

        if (url === '/threads/list') {
          return {
            ok: true,
            json: async () => ({
              threads: [
                {
                  threadId: 'running-1',
                  title: 'Implement mobile chat',
                  workspace: 'Agent Pulse',
                  status: 'running',
                  lastActivityAt: '2026-04-25T16:18:00Z',
                  lastTurnSummary: 'Working on mobile chat'
                }
              ]
            })
          };
        }

        if (url === '/projects/list') {
          return { ok: true, json: async () => ({ projects: [] }) };
        }

        if (url === '/catalog/plugins') {
          return { ok: true, json: async () => ({ plugins: [] }) };
        }

        if (url === '/catalog/skills') {
          return { ok: true, json: async () => ({ skills: [] }) };
        }

        if (url === '/catalog/commands') {
          return { ok: true, json: async () => ({ commands: [] }) };
        }

        if (url === '/catalog/models') {
          return { ok: true, json: async () => ({ models: [] }) };
        }

        if (url === '/threads/running-1/transcript?limit=40') {
          return {
            ok: true,
            json: async () => ({
              threadId: 'running-1',
              activeTurnId: null,
              sendState: {
                canSend: true,
                reason: 'ready',
                label: 'Ready'
              },
              messages: [
                {
                  id: 'assistant-1',
                  role: 'assistant',
                  kind: 'message',
                  text: 'I am working on it.',
                  createdAt: '2026-04-25T16:14:00Z'
                }
              ]
            })
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Implement mobile chat/ }));

    expect(await screen.findByTestId('thread-chat-drawer')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/threads/running-1');

    fireEvent.click(screen.getByRole('button', { name: 'Close thread chat' }));

    await waitFor(() => expect(window.location.hash).toBe(''));
  });

  it('shows working in real time from Codex stream broadcasts even when the transcript still says ready', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'token-1234567890',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );

    const sockets: MockWebSocket[] = [];
    class MockWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(readonly url: string | URL) {
        sockets.push(this);
      }

      close(): void {}
    }

    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              codexAppServer: 'connected',
              version: '0.1.0',
              uptimeSec: 60
            })
          };
        }

        if (url === '/threads/list') {
          return {
            ok: true,
            json: async () => ({
              threads: [
                {
                  threadId: 'thread-live',
                  title: 'Fix Mac helper sync',
                  workspace: 'CodexPulse',
                  status: 'idle',
                  lastActivityAt: '2026-04-27T18:10:00Z',
                  lastTurnSummary: ''
                }
              ]
            })
          };
        }

        if (url === '/projects/list') {
          return { ok: true, json: async () => ({ projects: [] }) };
        }

        if (url === '/catalog/plugins') {
          return { ok: true, json: async () => ({ plugins: [] }) };
        }

        if (url === '/catalog/skills') {
          return { ok: true, json: async () => ({ skills: [] }) };
        }

        if (url === '/catalog/commands') {
          return { ok: true, json: async () => ({ commands: [] }) };
        }

        if (url === '/catalog/models') {
          return { ok: true, json: async () => ({ models: [] }) };
        }

        if (url === '/threads/thread-live/transcript?limit=40') {
          return {
            ok: true,
            json: async () => ({
              threadId: 'thread-live',
              activeTurnId: null,
              sendState: {
                canSend: true,
                reason: 'ready',
                label: 'Ready'
              },
              messages: []
            })
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix Mac helper sync/ }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'codex/broadcast',
            payload: {
              method: 'thread-stream-state-changed',
              sourceClientId: 'desktop',
              params: {
                conversationId: 'thread-live',
                change: { isStreaming: true }
              }
            }
          })
        })
      );
    });

    expect(await screen.findByText('Codex is working')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'codex/broadcast',
            payload: {
              method: 'thread-stream-state-changed',
              sourceClientId: 'desktop',
              params: {
                conversationId: 'thread-live',
                change: { isStreaming: false }
              }
            }
          })
        })
      );
    });

    expect(screen.getByText('Codex is working')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop Codex' })).toBeInTheDocument();
  });

  it('uses transcript updates to clear a stale working state when a stop broadcast is missed', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'token-1234567890',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );

    const sockets: MockWebSocket[] = [];
    class MockWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(readonly url: string | URL) {
        sockets.push(this);
      }

      close(): void {}
    }

    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              codexAppServer: 'connected',
              version: '0.1.0',
              uptimeSec: 60
            })
          };
        }

        if (url === '/threads/list') {
          return {
            ok: true,
            json: async () => ({
              threads: [
                {
                  threadId: 'thread-live',
                  title: 'Fix Mac helper sync',
                  workspace: 'CodexPulse',
                  status: 'idle',
                  lastActivityAt: '2026-04-27T18:10:00Z',
                  lastTurnSummary: ''
                }
              ]
            })
          };
        }

        if (url === '/projects/list') {
          return { ok: true, json: async () => ({ projects: [] }) };
        }

        if (url === '/catalog/plugins') {
          return { ok: true, json: async () => ({ plugins: [] }) };
        }

        if (url === '/catalog/skills') {
          return { ok: true, json: async () => ({ skills: [] }) };
        }

        if (url === '/catalog/commands') {
          return { ok: true, json: async () => ({ commands: [] }) };
        }

        if (url === '/catalog/models') {
          return { ok: true, json: async () => ({ models: [] }) };
        }

        if (url === '/threads/thread-live/transcript?limit=40') {
          return {
            ok: true,
            json: async () => ({
              threadId: 'thread-live',
              activeTurnId: null,
              sendState: {
                canSend: true,
                reason: 'ready',
                label: 'Ready'
              },
              messages: []
            })
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix Mac helper sync/ }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'codex/broadcast',
            payload: {
              method: 'thread-stream-state-changed',
              sourceClientId: 'desktop',
              params: {
                conversationId: 'thread-live',
                change: { isStreaming: true }
              }
            }
          })
        })
      );
    });

    expect(await screen.findByText('Codex is working')).toBeInTheDocument();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/transcript/changed',
            payload: {
              threadId: 'thread-live',
              activeTurnId: null,
              sendState: {
                canSend: true,
                reason: 'ready',
                label: 'Ready'
              },
              messages: [
                {
                  id: 'assistant-1',
                  role: 'assistant',
                  kind: 'message',
                  text: 'Done.',
                  createdAt: '2026-04-27T18:11:00Z'
                }
              ]
            }
          })
        })
      );
    });

    expect(await screen.findByText('Done.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Codex is working')).not.toBeInTheDocument());
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('keeps usage badges stable when live transcript updates do not include usage', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'token-1234567890',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );

    const sockets: MockWebSocket[] = [];
    class MockWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(readonly url: string | URL) {
        sockets.push(this);
      }

      close(): void {}
    }

    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              codexAppServer: 'connected',
              version: '0.1.0',
              uptimeSec: 60
            })
          };
        }

        if (url === '/threads/list') {
          return {
            ok: true,
            json: async () => ({
              threads: [
                {
                  threadId: 'thread-live',
                  title: 'Fix usage bounce',
                  workspace: 'CodexPulse',
                  status: 'running',
                  lastActivityAt: '2026-04-27T18:10:00Z',
                  lastTurnSummary: ''
                }
              ]
            })
          };
        }

        if (url === '/projects/list') {
          return { ok: true, json: async () => ({ projects: [] }) };
        }

        if (url === '/catalog/plugins') {
          return { ok: true, json: async () => ({ plugins: [] }) };
        }

        if (url === '/catalog/skills') {
          return { ok: true, json: async () => ({ skills: [] }) };
        }

        if (url === '/catalog/commands') {
          return { ok: true, json: async () => ({ commands: [] }) };
        }

        if (url === '/catalog/models') {
          return { ok: true, json: async () => ({ models: [] }) };
        }

        if (url === '/threads/thread-live/transcript?limit=40') {
          return {
            ok: true,
            json: async () => ({
              threadId: 'thread-live',
              activeTurnId: 'turn-1',
              sendState: {
                canSend: false,
                reason: 'thread_changed',
                label: 'Codex is working'
              },
              usage: {
                contextUsedPercent: 72,
                primaryWindow: {
                  usedPercent: 14,
                  windowMinutes: 300
                }
              },
              messages: []
            })
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix usage bounce/ }));
    expect(await screen.findByText('Context')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/transcript/changed',
            payload: {
              threadId: 'thread-live',
              activeTurnId: 'turn-1',
              sendState: {
                canSend: false,
                reason: 'thread_changed',
                label: 'Codex is working'
              },
              messages: [
                {
                  id: 'assistant-1',
                  role: 'assistant',
                  kind: 'message',
                  text: 'Still working.',
                  createdAt: '2026-04-27T18:10:01Z'
                }
              ]
            }
          })
        })
      );
    });

    expect(screen.getByText('Still working.')).toBeInTheDocument();
    expect(screen.getByText('Context')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
  });

  it('lets the remote client stop a running Codex turn', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'token-1234567890',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );

    class MockWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(readonly url: string | URL) {}

      close(): void {}
    }

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/health/get') {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            codexAppServer: 'connected',
            version: '0.1.0',
            uptimeSec: 60
          })
        };
      }

      if (url === '/threads/list') {
        return {
          ok: true,
          json: async () => ({
            threads: [
              {
                threadId: 'thread-live',
                title: 'Fix Mac helper sync',
                workspace: 'CodexPulse',
                status: 'running',
                lastActivityAt: '2026-04-27T18:10:00Z',
                lastTurnSummary: ''
              }
            ]
          })
        };
      }

      if (url === '/projects/list') {
        return { ok: true, json: async () => ({ projects: [] }) };
      }

      if (url === '/catalog/plugins') {
        return { ok: true, json: async () => ({ plugins: [] }) };
      }

      if (url === '/catalog/skills') {
        return { ok: true, json: async () => ({ skills: [] }) };
      }

      if (url === '/catalog/commands') {
        return { ok: true, json: async () => ({ commands: [] }) };
      }

      if (url === '/catalog/models') {
        return { ok: true, json: async () => ({ models: [] }) };
      }

      if (url === '/threads/thread-live/transcript?limit=40') {
        return {
          ok: true,
          json: async () => ({
            threadId: 'thread-live',
            activeTurnId: 'turn-1',
            sendState: {
              canSend: true,
              reason: 'ready',
              label: 'Ready'
            },
            messages: []
          })
        };
      }

      if (url === '/threads/thread-live/stop') {
        expect(init?.method).toBe('POST');
        return {
          ok: true,
          json: async () => ({ ok: true })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix Mac helper sync/ }));
    expect(await screen.findByText('Codex is working')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop Codex' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/threads/thread-live/stop',
        expect.objectContaining({ method: 'POST' })
      )
    );
    await waitFor(() => expect(screen.queryByText('Codex is working')).not.toBeInTheDocument());
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('keeps the stop button visible when the thread list says running but the transcript is stale', async () => {
    const staleReadyTranscript: ThreadTranscript = {
      threadId: 'running-1',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'Older ready state.',
          createdAt: '2026-04-25T16:14:00Z'
        }
      ]
    };
    const fetchTranscript = vi.fn(async () => staleReadyTranscript);
    const stopWork = vi.fn(async () => undefined);

    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={[
          {
            threadId: 'running-1',
            title: 'Fix Mac helper sync',
            workspace: 'CodexPulse',
            status: 'running',
            lastActivityAt: '2026-04-27T19:14:17.599Z',
            lastTurnSummary: ''
          }
        ]}
        fetchTranscript={fetchTranscript}
        stopWork={stopWork}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Open chat for Fix Mac helper sync/ }));
    expect(await screen.findByText('Older ready state.')).toBeInTheDocument();

    expect(screen.getByText('Codex is working')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop Codex' })).toBeInTheDocument();
  });

  it('restores the active chat from the URL and cached transcript before refresh requests finish', async () => {
    const session = {
      token: 'token-1234567890',
      deviceId: 'device-1',
      fingerprint: 'browser-fingerprint',
      deviceName: 'Desk tablet'
    };
    const cachedThread = {
      threadId: 'running-1',
      title: 'Implement mobile chat',
      workspace: 'Agent Pulse',
      status: 'running',
      lastActivityAt: '2026-04-25T16:18:00Z',
      lastTurnSummary: 'Working on mobile chat'
    };
    const cachedTranscript = {
      threadId: 'running-1',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'Cached response.',
          createdAt: '2026-04-25T16:14:00Z'
        }
      ]
    };
    localStorage.setItem('agent-pulse-session', JSON.stringify(session));
    localStorage.setItem(`agent-pulse:threads-cache:${session.deviceId}`, JSON.stringify([cachedThread]));
    localStorage.setItem(
      `agent-pulse:transcripts-cache:${session.deviceId}`,
      JSON.stringify({ 'running-1': cachedTranscript })
    );
    sessionStorage.setItem('agent-pulse:active-thread', 'running-1');
    window.location.hash = '#/threads/running-1';

    let resolveThreads: ((value: unknown) => void) | undefined;
    let resolveTranscript: ((value: unknown) => void) | undefined;
    const threadsPromise = new Promise((resolve) => {
      resolveThreads = resolve;
    });
    const transcriptPromise = new Promise((resolve) => {
      resolveTranscript = resolve;
    });

    class MockWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(readonly url: string | URL) {}

      close(): void {}
    }

    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/health/get') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              status: 'ok',
              codexAppServer: 'connected',
              version: '0.1.0',
              uptimeSec: 60
            })
          });
        }

        if (url === '/threads/list') {
          return threadsPromise as Promise<Response>;
        }

        if (url === '/threads/running-1/transcript?limit=40') {
          return transcriptPromise as Promise<Response>;
        }

        if (url === '/projects/list') {
          return Promise.resolve({ ok: true, json: async () => ({ projects: [] }) });
        }

        if (url === '/catalog/plugins') {
          return Promise.resolve({ ok: true, json: async () => ({ plugins: [] }) });
        }

        if (url === '/catalog/skills') {
          return Promise.resolve({ ok: true, json: async () => ({ skills: [] }) });
        }

        if (url === '/catalog/commands') {
          return Promise.resolve({ ok: true, json: async () => ({ commands: [] }) });
        }

        if (url === '/catalog/models') {
          return Promise.resolve({ ok: true, json: async () => ({ models: [] }) });
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    expect(await screen.findByTestId('thread-chat-drawer')).toBeInTheDocument();
    expect(screen.getByText('Cached response.')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/threads/running-1');

    resolveThreads?.({
      ok: true,
      json: async () => ({ threads: [cachedThread] })
    });
    resolveTranscript?.({
      ok: true,
      json: async () => ({
        ...cachedTranscript,
        messages: [
          {
            id: 'assistant-2',
            role: 'assistant',
            kind: 'message',
            text: 'Fresh response.',
            createdAt: '2026-04-25T16:15:00Z'
          }
        ]
      })
    });

    expect(await screen.findByText('Fresh response.')).toBeInTheDocument();
  });

  it('renders the Codex-style sidebar with project groups and thread rows', () => {
    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={[
          {
            threadId: 'running-1',
            title: 'Implement dashboard grouping',
            workspace: 'Agent Pulse',
            status: 'running',
            lastActivityAt: '2026-04-25T16:18:00Z',
            lastTurnSummary: 'Working on the tablet UI'
          },
          {
            threadId: 'waiting-1',
            title: 'Review permission request',
            workspace: 'OpenAssist',
            status: 'waiting_approval',
            lastActivityAt: '2026-04-25T16:14:00Z',
            lastTurnSummary: 'Needs approval before continuing'
          },
          {
            threadId: 'idle-1',
            title: 'Write docs',
            workspace: 'Agent Pulse',
            status: 'idle',
            lastActivityAt: '2026-04-25T15:50:00Z',
            lastTurnSummary: ''
          }
        ]}
        projects={[
          {
            projectId: 'project-agent-pulse',
            name: 'Agent Pulse',
            path: '/Users/me/projects/AgentPulse'
          },
          {
            projectId: 'project-openassist',
            name: 'OpenAssist',
            path: '/Users/me/projects/OpenAssist'
          }
        ]}
      />
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Agent Pulse' })).toBeInTheDocument();
    const sidebar = screen.getByTestId('codex-sidebar');
    expect(within(sidebar).getByText('Threads')).toBeInTheDocument();
    expect(within(sidebar).getByLabelText('Thread list')).toBeInTheDocument();
    expect(within(sidebar).getAllByText('Agent Pulse').length).toBeGreaterThanOrEqual(1);
    expect(within(sidebar).getByText('v0.1.0')).toBeInTheDocument();
    expect(within(sidebar).getByText('OpenAssist')).toBeInTheDocument();
    expect(
      within(sidebar).getByRole('button', { name: /Open chat for Implement dashboard grouping/ })
    ).toBeInTheDocument();
    expect(
      within(sidebar).getByRole('button', { name: 'Open chat for Review permission request' })
    ).toBeInTheDocument();
    expect(
      within(sidebar).getByRole('button', { name: 'Open chat for Write docs' })
    ).toBeInTheDocument();
  });

  it('opens a chat drawer, disables send when mobile sending is off, and sends when ready', async () => {
    const firstTranscript: ThreadTranscript = {
      threadId: 'running-1',
      activeTurnId: null,
      sendState: {
        canSend: false,
        reason: 'mobile_send_disabled',
        label: 'Mobile sending is off on the Mac.'
      },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'I am working on it.',
          createdAt: '2026-04-25T16:14:00Z'
        }
      ]
    };
    const readyTranscript: ThreadTranscript = {
      ...firstTranscript,
      activeTurnId: 'turn-1',
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      }
    };
    const afterSendTranscript: ThreadTranscript = {
      ...readyTranscript,
      messages: [
        ...readyTranscript.messages,
        {
          id: 'user-1',
          role: 'user',
          kind: 'message',
          text: 'Hello from phone.',
          createdAt: '2026-04-25T16:15:00Z'
        }
      ]
    };
    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce(firstTranscript)
      .mockResolvedValueOnce(readyTranscript);
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'steer',
      turnId: 'turn-1',
      transcript: afterSendTranscript
    });
    const openThreadInCodex = vi.fn(async () => undefined);

    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={[
          {
            threadId: 'running-1',
            title: 'Implement mobile chat',
            workspace: 'Agent Pulse',
            status: 'running',
            lastActivityAt: '2026-04-25T16:18:00Z',
            lastTurnSummary: 'Working on mobile chat'
          }
        ]}
        fetchTranscript={fetchTranscript}
        sendMessage={sendMessage}
        onOpenThreadInCodex={openThreadInCodex}
        projects={[
          {
            projectId: 'project-agent-pulse',
            name: 'Agent Pulse',
            path: '/Users/me/projects/AgentPulse'
          }
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Open chat for Implement mobile chat/ }));

    const drawer = await screen.findByTestId('thread-chat-drawer');
    expect(fetchTranscript).toHaveBeenNthCalledWith(1, 'running-1', { messageLimit: 40 });
    expect(within(drawer).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Open in Codex' }));
    await waitFor(() => expect(openThreadInCodex).toHaveBeenCalledWith('running-1'));
    expect(within(drawer).queryByText('Sync')).not.toBeInTheDocument();
    expect(await screen.findByText('I am working on it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.getByText('Mobile sending is off on the Mac.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close thread chat' }));
    fireEvent.click(screen.getByRole('button', { name: /Open chat for Implement mobile chat/ }));

    await screen.findByText('Codex is working');
    expect(fetchTranscript).toHaveBeenNthCalledWith(2, 'running-1', { messageLimit: 40 });
    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Hello from phone.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('running-1', 'Hello from phone.'));
    expect(await screen.findByText('Hello from phone.')).toBeInTheDocument();
  });

  it('restores the previously open chat after a reload once threads finish loading', async () => {
    const fetchTranscript = vi.fn().mockResolvedValue({
      threadId: 'running-1',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'I am working on it.',
          createdAt: '2026-04-25T16:14:00Z'
        }
      ]
    } satisfies ThreadTranscript);
    const thread = {
      threadId: 'running-1',
      title: 'Implement mobile chat',
      workspace: 'Agent Pulse',
      status: 'running' as const,
      lastActivityAt: '2026-04-25T16:18:00Z',
      lastTurnSummary: 'Working on mobile chat'
    };
    const health = {
      status: 'ok' as const,
      codexAppServer: 'connected' as const,
      version: '0.1.0',
      uptimeSec: 60
    };

    const firstRender = render(
      <Dashboard health={health} threads={[thread]} fetchTranscript={fetchTranscript} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Open chat for Implement mobile chat/ }));

    expect(await screen.findByTestId('thread-chat-drawer')).toBeInTheDocument();
    expect(sessionStorage.getItem('agent-pulse:active-thread')).toBe('running-1');

    firstRender.unmount();
    fetchTranscript.mockClear();

    const secondRender = render(
      <Dashboard health={health} threads={[]} threadsLoaded={false} fetchTranscript={fetchTranscript} />
    );

    expect(screen.queryByTestId('thread-chat-drawer')).not.toBeInTheDocument();

    secondRender.rerender(
      <Dashboard
        health={health}
        threads={[thread]}
        threadsLoaded={true}
        fetchTranscript={fetchTranscript}
      />
    );

    expect(await screen.findByTestId('thread-chat-drawer')).toBeInTheDocument();
    expect(fetchTranscript).toHaveBeenCalledWith('running-1', { messageLimit: 40 });
  });

  it('clears the attention dot after the user opens and leaves a thread', async () => {
    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={[
          {
            threadId: 'attention-1',
            title: 'Implement mobile chat',
            workspace: 'Agent Pulse',
            status: 'waiting_approval',
            lastActivityAt: '2026-04-25T16:18:00Z',
            lastTurnSummary: 'Approval needed'
          }
        ]}
        projects={[
          {
            projectId: 'project-agent-pulse',
            name: 'Agent Pulse',
            path: '/Users/me/projects/AgentPulse'
          }
        ]}
      />
    );

    const row = screen.getByRole('button', { name: /Open chat for Implement mobile chat/ });
    expect(row.querySelector('.codex-sidebar-thread-dot')).not.toBeNull();

    fireEvent.click(row);
    expect(await screen.findByTestId('thread-chat-drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close thread chat' }));

    expect(
      screen
        .getByRole('button', { name: /Open chat for Implement mobile chat/ })
        .querySelector('.codex-sidebar-thread-dot')
    ).toBeNull();
  });

  it('keeps the working dot visible while the agent is running, even after the thread is viewed', async () => {
    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={[
          {
            threadId: 'running-1',
            title: 'Implement mobile chat',
            workspace: 'Agent Pulse',
            status: 'running',
            lastActivityAt: '2026-04-25T16:18:00Z',
            lastTurnSummary: 'Working on mobile chat'
          }
        ]}
        projects={[
          {
            projectId: 'project-agent-pulse',
            name: 'Agent Pulse',
            path: '/Users/me/projects/AgentPulse'
          }
        ]}
      />
    );

    const row = screen.getByRole('button', { name: /Open chat for Implement mobile chat/ });
    expect(row.querySelector('.codex-sidebar-thread-dot')).not.toBeNull();

    fireEvent.click(row);
    expect(await screen.findByTestId('thread-chat-drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close thread chat' }));

    expect(
      screen
        .getByRole('button', { name: /Open chat for Implement mobile chat/ })
        .querySelector('.codex-sidebar-thread-dot')
    ).not.toBeNull();
  });

  it('keeps refreshing the open chat after a phone send so Codex activity appears', async () => {
    vi.useFakeTimers();
    const readyTranscript: ThreadTranscript = {
      threadId: 'running-1',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: []
    };
    const afterSendTranscript: ThreadTranscript = {
      ...readyTranscript,
      activeTurnId: 'turn-1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          kind: 'message',
          text: 'Hello from phone.',
          createdAt: '2026-04-25T16:15:00Z'
        }
      ]
    };
    const refreshedTranscript: ThreadTranscript = {
      ...afterSendTranscript,
      activeTurnId: null,
      messages: [
        ...afterSendTranscript.messages,
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'I received the phone message and started working.',
          createdAt: '2026-04-25T16:15:05Z'
        }
      ]
    };
    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce(readyTranscript)
      .mockResolvedValue(refreshedTranscript);
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'start',
      turnId: 'turn-1',
      transcript: afterSendTranscript
    });

    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={[
          {
            threadId: 'running-1',
            title: 'Implement mobile chat',
            workspace: 'Agent Pulse',
            status: 'idle',
            lastActivityAt: '2026-04-25T16:18:00Z',
            lastTurnSummary: 'Working on mobile chat'
          }
        ]}
        fetchTranscript={fetchTranscript}
        sendMessage={sendMessage}
        projects={[
          {
            projectId: 'project-agent-pulse',
            name: 'Agent Pulse',
            path: '/Users/me/projects/AgentPulse'
          }
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Open chat for Implement mobile chat/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Ready')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Hello from phone.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Codex is working')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByText('I received the phone message and started working.')).toBeInTheDocument();
  });

  it('groups agent work between chat messages and expands screenshots on demand', async () => {
    const transcript: ThreadTranscript = {
      threadId: 'running-1',
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
          text: 'Something is wrong.',
          createdAt: '2026-04-25T16:14:00Z',
          attachments: [
            {
              id: 'user-1-image-1',
              kind: 'image',
              url: 'data:image/png;base64,user-image',
              alt: 'User screenshot'
            }
          ]
        },
        {
          id: 'assistant-progress-1',
          role: 'assistant',
          kind: 'message',
          text: 'I will inspect the screenshot.\nDetailed private progress that should only show after opening this item.',
          createdAt: '2026-04-25T16:14:05Z',
          phase: 'commentary'
        } as ThreadTranscript['messages'][number],
        {
          id: 'tool-1',
          role: 'activity',
          kind: 'tool',
          text: 'browser.screenshot completed',
          createdAt: '2026-04-25T16:14:10Z',
          attachments: [
            {
              id: 'tool-1-image-1',
              kind: 'image',
              url: 'data:image/png;base64,tool-image',
              alt: 'Browser screenshot'
            }
          ]
        },
        {
          id: 'cmd-1',
          role: 'activity',
          kind: 'command',
          text: 'pnpm test',
          createdAt: '2026-04-25T16:20:53Z'
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'I fixed it.',
          createdAt: '2026-04-25T16:21:00Z',
          phase: 'final_answer'
        } as ThreadTranscript['messages'][number]
      ]
    };
    const fetchTranscript = vi.fn().mockResolvedValue(transcript);

    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={[
          {
            threadId: 'running-1',
            title: 'Fix jumping page',
            workspace: 'Agent Pulse',
            status: 'idle',
            lastActivityAt: '2026-04-25T16:21:00Z',
            lastTurnSummary: ''
          }
        ]}
        fetchTranscript={fetchTranscript}
        projects={[
          {
            projectId: 'project-agent-pulse',
            name: 'Agent Pulse',
            path: '/Users/me/projects/AgentPulse'
          }
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open chat for Fix jumping page' }));

    expect(await screen.findByText('Something is wrong.')).toBeInTheDocument();
    const userScreenshotThumb = screen.getByRole('button', { name: /Open User screenshot/ });
    expect(userScreenshotThumb).toBeInTheDocument();
    expect(screen.getByAltText('User screenshot')).toHaveClass('codex-attachment-thumb-image');
    expect(screen.queryByRole('dialog', { name: 'User screenshot' })).not.toBeInTheDocument();
    fireEvent.click(userScreenshotThumb);
    expect(screen.getByRole('dialog', { name: 'User screenshot' })).toBeInTheDocument();
    expect(screen.getByAltText('User screenshot preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close screenshot preview' }));
    expect(screen.getByText('I fixed it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Worked for 6m 55s/ })).toBeInTheDocument();
    expect(screen.queryByText(/Detailed private progress/)).not.toBeInTheDocument();
    expect(screen.queryByText('browser.screenshot completed')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Worked for 6m 55s/ }));

    const progressRow = screen.getByRole('button', { name: /I will inspect the screenshot/ });
    expect(progressRow).toBeInTheDocument();
    expect(screen.queryByText(/Detailed private progress/)).not.toBeInTheDocument();

    fireEvent.click(progressRow);

    expect(screen.getByText(/Detailed private progress/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /browser.screenshot completed/ }));

    const browserScreenshotThumb = screen.getByRole('button', { name: /Open Browser screenshot/ });
    expect(browserScreenshotThumb).toBeInTheDocument();
    expect(screen.getByAltText('Browser screenshot')).toHaveClass('codex-attachment-thumb-image');
  });

  it('keeps live agent work visible until the final answer arrives', async () => {
    const transcript: ThreadTranscript = {
      threadId: 'running-1',
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
          text: 'Please check this.',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'assistant-progress-1',
          role: 'assistant',
          kind: 'message',
          text: 'I am checking the page now.',
          createdAt: '2026-04-25T16:14:05Z',
          phase: 'commentary'
        } as ThreadTranscript['messages'][number],
        {
          id: 'tool-1',
          role: 'activity',
          kind: 'tool',
          text: 'browser.screenshot completed',
          createdAt: '2026-04-25T16:14:10Z'
        }
      ]
    };
    const fetchTranscript = vi.fn().mockResolvedValue(transcript);

    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={[
          {
            threadId: 'running-1',
            title: 'Live work',
            workspace: 'Agent Pulse',
            status: 'running',
            lastActivityAt: '2026-04-25T16:14:10Z',
            lastTurnSummary: ''
          }
        ]}
        fetchTranscript={fetchTranscript}
        projects={[
          {
            projectId: 'project-agent-pulse',
            name: 'Agent Pulse',
            path: '/Users/me/projects/AgentPulse'
          }
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Open chat for Live work/ }));

    expect(await screen.findByText('Please check this.')).toBeInTheDocument();
    // Live work (commentary + tool) is grouped under a collapsible "Agent work" toggle
    // until a non-commentary final answer arrives, mirroring the desktop UI.
    const workToggle = screen.getByRole('button', { name: /Agent work|Worked for/ });
    expect(workToggle).toBeInTheDocument();
    fireEvent.click(workToggle);
    expect(await screen.findByRole('button', { name: /browser.screenshot completed/ })).toBeInTheDocument();
  });

  it('uses a project dropdown before creating a new Codex thread', async () => {
    const newThread = {
      threadId: 'thread-new',
      title: 'New thread',
      workspace: 'CodexPulse',
      status: 'idle' as const,
      lastActivityAt: '2026-04-26T10:00:00Z',
      lastTurnSummary: ''
    };
    const onNewThread = vi.fn(async () => newThread);

    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={[]}
        projects={[
          {
            projectId: 'project-openassist',
            name: 'OpenAssist',
            path: '/Users/me/projects/OpenAssist'
          },
          {
            projectId: 'project-codexpulse',
            name: 'CodexPulse',
            path: '/Users/me/projects/CodexPulse'
          }
        ]}
        onNewThread={onNewThread}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'New thread' }));

    const dialog = await screen.findByRole('dialog', { name: 'New thread' });
    expect(within(dialog).getByText('Choose a project')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Project' }), {
      target: { value: 'project-codexpulse' }
    });
    expect(within(dialog).queryByLabelText('Folder path')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start thread' }));

    await waitFor(() => expect(onNewThread).toHaveBeenCalledWith({ projectId: 'project-codexpulse' }));
    expect(await screen.findByTestId('thread-chat-drawer')).toBeInTheDocument();
  });

  it('shows an empty dropdown state when no Codex projects are listed', async () => {
    const newThread = {
      threadId: 'thread-new',
      title: 'New thread',
      workspace: 'CodexPulse',
      status: 'idle' as const,
      lastActivityAt: '2026-04-26T10:00:00Z',
      lastTurnSummary: ''
    };
    const onNewThread = vi.fn(async () => newThread);

    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={[]}
        projects={[]}
        onNewThread={onNewThread}
      />
    );

    const newThreadButton = screen.getByRole('button', { name: 'New thread' });
    expect(newThreadButton).not.toBeDisabled();
    fireEvent.click(newThreadButton);

    const dialog = await screen.findByRole('dialog', { name: 'New thread' });
    expect(within(dialog).getByText('No saved Codex projects are available yet.')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Folder path')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Start thread' })).toBeDisabled();

    expect(onNewThread).not.toHaveBeenCalled();
  });
});
