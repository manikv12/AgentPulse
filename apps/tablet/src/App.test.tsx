// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadTranscript } from '@agent-pulse/shared';
import { App, extractLatestModel, extractLatestReasoningEffort, extractPendingRequests } from './App';
import { Dashboard } from './Dashboard';
import { ThreadView } from './ThreadView';

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

  it('extracts pending permission requests from Codex patch broadcasts', () => {
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ['/tmp'] }
    };

    expect(
      extractPendingRequests({
        change: {
          type: 'patches',
          patches: [
            {
              op: 'add',
              path: ['conversationState', 'requests', 0],
              value: {
                id: 'permission-request-1',
                method: 'item/permissions/requestApproval',
                params: {
                  turnId: 'turn-1',
                  reason: 'Allow Codex to use Microsoft Teams?',
                  permissions
                }
              }
            },
            {
              op: 'add',
              path: '/conversationState/turns/0/items/0',
              value: {
                type: 'permissionRequest',
                requestId: 'permission-request-from-item',
                turnId: 'turn-1',
                reason: 'Allow Codex to use Slack?',
                permissions
              }
            }
          ]
        }
      })
    ).toEqual([
      expect.objectContaining({
        id: 'permission-request-1',
        method: 'item/permissions/requestApproval',
        kind: 'permissionsApproval',
        title: 'Allow Codex to use Microsoft Teams?',
        turnId: 'turn-1',
        permissions
      }),
      expect.objectContaining({
        id: 'permission-request-from-item',
        method: 'item/permissions/requestApproval',
        kind: 'permissionsApproval',
        title: 'Allow Codex to use Slack?',
        turnId: 'turn-1',
        permissions
      })
    ]);
  });

  it('extracts pending MCP elicitation approvals from Codex patch broadcasts', () => {
    expect(
      extractPendingRequests({
        change: {
          type: 'patches',
          patches: [
            {
              op: 'add',
              path: ['conversationState', 'requests', 0],
              value: {
                id: 'mcp-approval-1',
                method: 'mcpServer/elicitation/request',
                params: {
                  threadId: 'thread-live',
                  turnId: 'turn-1',
                  serverName: 'computer-use',
                  mode: 'form',
                  message: 'Allow Codex to use Microsoft Teams?',
                  _meta: {
                    codex_approval_kind: 'mcp_tool_call',
                    connector_id: 'computer-use',
                    connector_name: 'Computer Use',
                    tool_params: { app: 'Microsoft Teams' },
                    persist: ['session', 'always']
                  },
                  requestedSchema: {
                    type: 'object',
                    properties: {}
                  }
                }
              }
            }
          ]
        }
      })
    ).toEqual([
      expect.objectContaining({
        id: 'mcp-approval-1',
        method: 'mcpServer/elicitation/request',
        kind: 'mcpElicitationApproval',
        title: 'Allow Codex to use Microsoft Teams?',
        body: 'Computer Use wants to use Microsoft Teams.',
        turnId: 'turn-1'
      })
    ]);
  });

  it('sends MCP elicitation approval responses from the approval card', async () => {
    const fetchTranscript = vi.fn(async (): Promise<ThreadTranscript> => ({
      threadId: 'thread-live',
      activeTurnId: 'turn-1',
      sendState: {
        canSend: false,
        reason: 'waiting_on_approval',
        label: 'Codex is waiting for approval'
      },
      messages: []
    }));
    const onApprovalDecision = vi.fn(async () => undefined);

    render(
      <ThreadView
        thread={{
          threadId: 'thread-live',
          title: 'Check Teams',
          workspace: 'CC src',
          status: 'waiting_approval',
          lastActivityAt: '2026-04-28T21:30:00Z',
          lastTurnSummary: 'Needs approval'
        }}
        fetchTranscript={fetchTranscript}
        sendMessage={vi.fn()}
        stopWork={vi.fn()}
        pendingRequests={[
          {
            id: 'mcp-approval-1',
            method: 'mcpServer/elicitation/request',
            kind: 'mcpElicitationApproval',
            title: 'Allow Codex to use Microsoft Teams?',
            body: 'Computer Use wants to use Microsoft Teams.',
            turnId: 'turn-1'
          }
        ]}
        onApprovalDecision={onApprovalDecision}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));

    await waitFor(() =>
      expect(onApprovalDecision).toHaveBeenCalledWith(
        'mcp-approval-1',
        'mcpServer/elicitation/request',
        { action: 'accept', content: {}, _meta: null }
      )
    );
  });

  it('confirms before deleting a thread from the thread header', async () => {
    const fetchTranscript = vi.fn(async (): Promise<ThreadTranscript> => ({
      threadId: 'thread-live',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: []
    }));
    const deleteThread = vi.fn(async () => undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <ThreadView
        thread={{
          threadId: 'thread-live',
          title: 'Old chat',
          workspace: 'CodexPulse',
          status: 'idle',
          lastActivityAt: '2026-04-30T12:00:00Z',
          lastTurnSummary: 'Ready'
        }}
        fetchTranscript={fetchTranscript}
        deleteThread={deleteThread}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Delete thread' }));

    await waitFor(() => expect(deleteThread).toHaveBeenCalledWith('thread-live'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/delete this thread/i));
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

  it('keeps a newly reconnected session when an older thread refresh fails with 401', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'stale-token',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );
    sessionStorage.setItem('agent-pulse-admin-token', 'admin-token');
    window.location.hash = '#/settings';

    const threadListTokens: string[] = [];
    let resolveStaleThreads: ((response: Response) => void) | undefined;
    const staleThreads = new Promise<Response>((resolve) => {
      resolveStaleThreads = resolve;
    });
    const sockets: Array<{ url: string; close: ReturnType<typeof vi.fn> }> = [];

    class MockWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      readonly close = vi.fn();

      constructor(readonly url: string | URL) {
        sockets.push({ url: String(url), close: this.close });
      }
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
        const headers = new Headers(init?.headers);
        const authorization = headers.get('authorization') ?? '';
        const token = authorization.replace(/^Bearer\s+/, '');
        threadListTokens.push(token);

        if (token === 'stale-token') {
          return staleThreads;
        }

        return {
          ok: true,
          json: async () => ({ threads: [] })
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

      if (url === '/settings/get') {
        return {
          ok: true,
          json: async () => ({
            settings: {
              port: 5173,
              lanEnabled: false,
              mobileSendEnabled: false
            },
            devices: [
              {
                deviceId: 'device-1',
                deviceName: 'Desk tablet',
                createdAt: '2026-04-26T10:00:00Z'
              }
            ]
          })
        };
      }

      if (url === '/settings/pairing-pin') {
        return {
          ok: true,
          json: async () => ({
            pin: '123456',
            deviceId: 'device-1',
            expiresAt: '2026-04-28T11:00:00Z'
          })
        };
      }

      if (url === '/device/pair') {
        return {
          ok: true,
          json: async () => ({
            token: 'fresh-token-1234567890',
            deviceId: 'device-1',
            deviceName: 'Desk tablet'
          })
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Agent Pulse settings' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Saved device' }), {
      target: { value: 'device-1' }
    });
    fireEvent.click(screen.getByTitle('Generate reconnect PIN'));

    expect(await screen.findByText('123456')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Connect this device'));

    await waitFor(() => expect(threadListTokens).toContain('fresh-token-1234567890'));
    resolveStaleThreads?.(
      new Response(JSON.stringify({ error: 'invalid' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    );

    expect(await screen.findByRole('heading', { name: 'Agent Pulse' })).toBeInTheDocument();
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('agent-pulse-session') ?? '{}')).toMatchObject({
        token: 'fresh-token-1234567890',
        deviceId: 'device-1'
      });
    });
    expect(screen.queryByRole('heading', { name: 'How will you use this?' })).not.toBeInTheDocument();
    expect(sockets.at(-1)?.url).toContain('token=fresh-token-1234567890');
    expect(sockets.at(-1)?.close).not.toHaveBeenCalled();
  });

  it('repairs a stale saved device token on refresh instead of returning to pairing', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'stale-token',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );

    const threadListTokens: string[] = [];
    const sockets: Array<{ url: string; close: ReturnType<typeof vi.fn> }> = [];

    class MockWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      readonly close = vi.fn();

      constructor(readonly url: string | URL) {
        sockets.push({ url: String(url), close: this.close });
      }
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
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
          const headers = new Headers(init?.headers);
          const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/, '');
          threadListTokens.push(token);
          if (token === 'stale-token') {
            return new Response(JSON.stringify({ error: 'invalid' }), {
              status: 401,
              headers: { 'content-type': 'application/json' }
            });
          }
          return {
            ok: true,
            json: async () => ({ threads: [] })
          };
        }

        if (url === '/device/session/recover') {
          expect(init?.body).toBe(
            JSON.stringify({ deviceId: 'device-1', fingerprint: 'browser-fingerprint' })
          );
          return {
            ok: true,
            json: async () => ({
              token: 'fresh-token-1234567890',
              deviceId: 'device-1',
              deviceName: 'Desk tablet'
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

        throw new Error(`Unexpected URL ${url}`);
      })
    );
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Agent Pulse' })).toBeInTheDocument();
    await waitFor(() => expect(threadListTokens).toContain('fresh-token-1234567890'));
    expect(JSON.parse(localStorage.getItem('agent-pulse-session') ?? '{}')).toMatchObject({
      token: 'fresh-token-1234567890',
      deviceId: 'device-1'
    });
    expect(screen.queryByRole('heading', { name: 'How will you use this?' })).not.toBeInTheDocument();
    expect(sockets.at(-1)?.url).toContain('token=fresh-token-1234567890');
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
    const fetchMock = vi.fn(async (url: string) => {
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
    });
    vi.stubGlobal('fetch', fetchMock);

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
    const fetchMock = vi.fn(async (url: string) => {
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
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix Mac helper sync/ }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/streaming-changed',
            payload: {
              threadId: 'thread-live',
              isStreaming: true
            }
          })
        })
      );
    });

    expect(await screen.findByText('Codex is working')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
    const stopButton = screen.getByRole('button', { name: 'Stop Codex' });
    expect(stopButton.closest('.codex-composer')).not.toBeNull();
    expect(stopButton.closest('.codex-thread-actions')).toBeNull();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/streaming-changed',
            payload: {
              threadId: 'thread-live',
              isStreaming: false
            }
          })
        })
      );
    });

    await waitFor(() => expect(screen.queryByText('Codex is working')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Stop Codex' })).not.toBeInTheDocument();
  });

  it('shows Codex permission requests from live patches and sends the permission response shape', async () => {
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

    let approvalBody: unknown;
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
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
                  title: 'Check Teams',
                  workspace: 'CodexPulse',
                  status: 'idle',
                  lastActivityAt: '2026-04-28T13:10:00Z',
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

        if (url === '/threads/thread-live/approvals/permission-request-1') {
          approvalBody = init?.body ? JSON.parse(String(init.body)) : undefined;
          return { ok: true, json: async () => ({ ok: true }) };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Check Teams/ }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/pending-approvals/changed',
            payload: {
              threadId: 'thread-live',
              requests: [
                {
                  id: 'permission-request-1',
                  method: 'item/permissions/requestApproval',
                  params: {
                    turnId: 'turn-1',
                    reason: 'Allow Codex to use Microsoft Teams?',
                    permissions: { network: { enabled: true } }
                  }
                }
              ]
            }
          })
        })
      );
    });

    expect(await screen.findByText('Allow Codex to use Microsoft Teams?')).toBeInTheDocument();
    expect(screen.getByText('Codex needs permission')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));

    await waitFor(() =>
      expect(approvalBody).toEqual({
        method: 'item/permissions/requestApproval',
        decision: {
          permissions: { network: { enabled: true } },
          scope: 'turn'
        }
      })
    );
  });

  it('clears working state when a live transcript says the thread is ready', async () => {
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
    const fetchMock = vi.fn(async (url: string) => {
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
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix Mac helper sync/ }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/status/changed',
            payload: {
              threadId: 'thread-live',
              status: 'running'
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
    expect(screen.queryByRole('button', { name: 'Stop Codex' })).not.toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('keeps a newer live answer when the follow-up transcript refresh is stale', async () => {
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

        if (url === '/threads/thread-live/transcript') {
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
                  id: 'assistant-final',
                  role: 'assistant',
                  kind: 'message',
                  text: 'Latest answer from live event.',
                  createdAt: '2026-04-27T18:11:00Z'
                }
              ]
            }
          })
        })
      );
    });

    expect(await screen.findByText('Latest answer from live event.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Latest answer from live event.')).toBeInTheDocument());
  });

  it('refreshes again after Codex becomes ready so the final assistant message appears', async () => {
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

    let liveTranscriptFetches = 0;
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
                  lastActivityAt: '2026-04-27T18:00:00Z',
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

        if (url === '/threads/thread-live/transcript') {
          liveTranscriptFetches += 1;
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
              messages:
                liveTranscriptFetches >= 2
                  ? [
                      {
                        id: 'assistant-final',
                        role: 'assistant',
                        kind: 'message',
                        text: 'Final answer is now visible.',
                        phase: 'final_answer',
                        createdAt: '2026-04-27T18:11:00Z'
                      }
                    ]
                  : []
            })
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix Mac helper sync/ }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    liveTranscriptFetches = 0;
    vi.useFakeTimers();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/streaming-changed',
            payload: {
              threadId: 'thread-live',
              isStreaming: false
            }
          })
        })
      );
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('Final answer is now visible.')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });

    expect(screen.getByText('Final answer is now visible.')).toBeInTheDocument();
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
    let resolveFreshTranscript: ((value: {
      ok: true;
      json: () => Promise<unknown>;
    }) => void) | undefined;
    const freshTranscript = new Promise<{
      ok: true;
      json: () => Promise<unknown>;
    }>((resolve) => {
      resolveFreshTranscript = resolve;
    });

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

        if (url === '/threads/thread-live/transcript') {
          return freshTranscript;
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

    await act(async () => {
      resolveFreshTranscript?.({
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
            contextUsedPercent: 84,
            primaryWindow: {
              usedPercent: 15,
              windowMinutes: 300
            }
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
        })
      });
    });

    expect(await screen.findByText('84%')).toBeInTheDocument();
    expect(screen.getByText('15%')).toBeInTheDocument();
  });

  it('shows thread-list reasoning effort before transcript metadata arrives', async () => {
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
                  threadId: 'thread-model',
                  title: 'Fix model chip',
                  workspace: 'CodexPulse',
                  status: 'idle',
                  lastActivityAt: '2026-04-27T18:10:00Z',
                  lastTurnSummary: '',
                  model: 'gpt-5.5',
                  reasoningEffort: 'high'
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
          return {
            ok: true,
            json: async () => ({
              models: [
                {
                  slug: 'gpt-5.5',
                  displayName: 'GPT-5.5',
                  defaultReasoningLevel: 'medium',
                  supportedReasoningLevels: [
                    { effort: 'medium', description: 'Medium' },
                    { effort: 'high', description: 'High' }
                  ],
                  visibility: 'visible'
                }
              ]
            })
          };
        }

        if (url === '/threads/thread-model/transcript?limit=40') {
          return {
            ok: true,
            json: async () => ({
              threadId: 'thread-model',
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

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix model chip/ }));

    expect(await screen.findByText('GPT-5.5')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();
  });

  it('shows the Claude Code model picker with only Claude models', async () => {
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
                  threadId: 'claude-code:thread-model',
                  provider: 'claude-code',
                  providerThreadId: 'thread-model',
                  title: 'Fix Claude chip',
                  workspace: 'CodexPulse',
                  status: 'idle',
                  lastActivityAt: '2026-04-27T18:10:00Z',
                  lastTurnSummary: '',
                  model: 'claude-opus-4-7'
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
          return {
            ok: true,
            json: async () => ({
              models: [
                {
                  slug: 'gpt-5.5',
                  displayName: 'GPT-5.5',
                  provider: 'codex',
                  defaultReasoningLevel: 'medium',
                  supportedReasoningLevels: [
                    { effort: 'medium', description: 'Medium' },
                    { effort: 'high', description: 'High' }
                  ],
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
                  visibility: 'visible'
                },
                {
                  slug: 'sonnet',
                  displayName: 'Claude Sonnet',
                  provider: 'claude-code',
                  description: 'Balanced Claude Code model alias.',
                  defaultReasoningLevel: 'medium',
                  supportedReasoningLevels: [
                    { effort: 'low', description: 'Fastest Claude Code reasoning.' },
                    { effort: 'medium', description: 'Balanced Claude Code reasoning.' },
                    { effort: 'high', description: 'Deeper Claude Code reasoning.' },
                    { effort: 'xhigh', description: 'Extra-deep Claude Code reasoning.' },
                    { effort: 'max', description: 'Maximum Claude Code reasoning.' }
                  ],
                  visibility: 'visible'
                }
              ]
            })
          };
        }

        if (url === '/threads/claude-code%3Athread-model/transcript?limit=40') {
          return {
            ok: true,
            json: async () => ({
              threadId: 'claude-code:thread-model',
              provider: 'claude-code',
              providerThreadId: 'thread-model',
              activeTurnId: null,
              sendState: {
                canSend: true,
                reason: 'ready',
                label: 'Ready'
              },
              messages: [],
              model: 'claude-opus-4-7'
            })
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix Claude chip/ }));

    const modelChip = await screen.findByRole('button', { name: /Claude Opus/ });
    fireEvent.click(modelChip);

    expect(await screen.findByText('Claude Sonnet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /High/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Max/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText('GPT-5.5')).not.toBeInTheDocument();
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
    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/streaming-changed',
            payload: {
              threadId: 'thread-live',
              isStreaming: true
            }
          })
        })
      );
    });
    expect(await screen.findByText('Codex is working')).toBeInTheDocument();

    const stopButton = screen.getByRole('button', { name: 'Stop Codex' });
    expect(stopButton.closest('.codex-composer')).not.toBeNull();
    expect(stopButton.closest('.codex-thread-actions')).toBeNull();
    fireEvent.click(stopButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/threads/thread-live/stop',
        expect.objectContaining({ method: 'POST' })
      )
    );
    await waitFor(() => expect(screen.queryByText('Codex is working')).not.toBeInTheDocument());
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('clears stale working state when stop says Codex has no active turn', async () => {
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

    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix Mac helper sync/ }));
    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/streaming-changed',
            payload: {
              threadId: 'thread-live',
              isStreaming: true
            }
          })
        })
      );
    });
    expect(await screen.findByText('Codex is working')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop Codex' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/threads/thread-live/stop',
        expect.objectContaining({ method: 'POST' })
      )
    );
    expect(await screen.findByText('Codex is not currently running this thread.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Codex is working')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Stop Codex' })).not.toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('keeps stop controls visible when the fresh thread list says a turn is running', async () => {
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

      close(): void {}
    }

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
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix Mac helper sync/ }));

    expect(await screen.findByText('Codex is working')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop Codex' })).toBeInTheDocument();
  });

  it('uses a fresh ready transcript as the live stream done signal', async () => {
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
              sendState: { canSend: true, reason: 'ready', label: 'Ready' },
              messages: []
            })
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix Mac helper sync/ }));
    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/streaming-changed',
            payload: { threadId: 'thread-live', isStreaming: true }
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
              sendState: { canSend: true, reason: 'ready', label: 'Ready' },
              messages: [
                {
                  id: 'assistant-done',
                  role: 'assistant',
                  kind: 'message',
                  text: 'Done now.',
                  createdAt: '2026-04-28T15:17:00Z'
                }
              ]
            }
          })
        })
      );
    });

    expect(await screen.findByText('Done now.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Codex is working')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Stop Codex' })).not.toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('keeps the stop button visible when the Codex stream source says working and the transcript is stale', async () => {
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
            status: 'idle',
            lastActivityAt: '2026-04-27T19:14:17.599Z',
            lastTurnSummary: ''
          }
        ]}
        fetchTranscript={fetchTranscript}
        stopWork={stopWork}
        streamingThreadIds={new Set(['running-1'])}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Open chat for Fix Mac helper sync/ }));
    expect(await screen.findByText('Older ready state.')).toBeInTheDocument();

    expect(screen.getByText('Codex is working')).toBeInTheDocument();
    const stopButton = screen.getByRole('button', { name: 'Stop Codex' });
    expect(stopButton).toBeInTheDocument();
    expect(stopButton.closest('.codex-composer')).not.toBeNull();
  });

  it('shows the stop button when the transcript carries the IPC mirror working state', async () => {
    const workingTranscript: ThreadTranscript = {
      threadId: 'running-1',
      activeTurnId: 'mirror-streaming:running-1',
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
          text: 'Still running a command.',
          createdAt: '2026-04-25T16:14:00Z'
        }
      ]
    };
    const fetchTranscript = vi.fn(async () => workingTranscript);
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
            status: 'idle',
            lastActivityAt: '2026-04-27T19:14:17.599Z',
            lastTurnSummary: ''
          }
        ]}
        fetchTranscript={fetchTranscript}
        stopWork={stopWork}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Open chat for Fix Mac helper sync/ }));

    expect(await screen.findByText('Codex is working')).toBeInTheDocument();
    const stopButton = screen.getByRole('button', { name: 'Stop Codex' });
    expect(stopButton.closest('.codex-composer')).not.toBeNull();
  });

  it('shows compaction as its own active state', async () => {
    const compactingTranscript = {
      threadId: 'running-1',
      activeTurnId: 'mirror-streaming:running-1',
      sendState: {
        canSend: false,
        reason: 'compacting_context',
        label: 'Automatically compacting context'
      },
      messages: [
        {
          id: 'status-1',
          role: 'activity',
          kind: 'status',
          text: 'Automatically compacting context',
          createdAt: '2026-04-28T15:17:00Z'
        }
      ]
    } as ThreadTranscript;

    render(
      <ThreadView
        thread={{
          threadId: 'running-1',
          title: 'Fix Mac helper sync',
          workspace: 'CodexPulse',
          status: 'compacting' as never,
          lastActivityAt: '2026-04-28T15:17:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={compactingTranscript}
        stopWork={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getByText('Compacting')).toBeInTheDocument();
    expect(screen.getAllByText('Automatically compacting context').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Stop Codex' })).toBeInTheDocument();
  });

  it('does not show the stop button from app-server-only working state', async () => {
    const appServerOnlyTranscript: ThreadTranscript = {
      threadId: 'running-1',
      activeTurnId: 'app-server-active:running-1',
      sendState: {
        canSend: false,
        reason: 'missing_active_turn',
        label: 'Codex is working'
      },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'App-server thinks this is running.',
          createdAt: '2026-04-25T16:14:00Z'
        }
      ]
    };
    const fetchTranscript = vi.fn(async () => appServerOnlyTranscript);
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
            status: 'idle',
            lastActivityAt: '2026-04-27T19:14:17.599Z',
            lastTurnSummary: ''
          }
        ]}
        fetchTranscript={fetchTranscript}
        stopWork={stopWork}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Open chat for Fix Mac helper sync/ }));

    expect(await screen.findByText('App-server thinks this is running.')).toBeInTheDocument();
    expect(screen.queryByText('Codex is working')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop Codex' })).not.toBeInTheDocument();
  });

  it('does not show working from the old thread-list running status alone', async () => {
    const readyTranscript: ThreadTranscript = {
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
    const fetchTranscript = vi.fn(async () => readyTranscript);

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
      />
    );

    const row = screen.getByRole('button', { name: /Open chat for Fix Mac helper sync/ });
    expect(row.querySelector('.codex-sidebar-thread-dot')).toBeNull();
    fireEvent.click(row);
    expect(await screen.findByText('Older ready state.')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Codex is working')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop Codex' })).not.toBeInTheDocument();
  });

  it('shows unseen idle threads as review items in recent activity', () => {
    localStorage.setItem(
      'agent-pulse:seen-thread-activity',
      JSON.stringify({ 'review-1': Date.parse('2026-04-27T19:10:00.000Z') })
    );

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
            threadId: 'review-1',
            title: 'Fix Mac helper sync',
            workspace: 'CodexPulse',
            status: 'idle',
            lastActivityAt: '2026-04-27T19:14:17.599Z',
            lastTurnSummary: ''
          }
        ]}
      />
    );

    const tile = document.querySelector('.codex-home-tile');
    if (!(tile instanceof HTMLElement)) {
      throw new Error('Expected recent activity tile to render.');
    }
    expect(within(tile).getByText('Review')).toBeInTheDocument();
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
    expect(within(sidebar).getByText('OpenAssist')).toBeInTheDocument();
    expect(
      within(sidebar).getByRole('button', { name: /Open chat for Implement dashboard grouping/ })
    ).toBeInTheDocument();
    expect(
      within(sidebar).getByRole('button', { name: 'Open chat for Review permission request' })
    ).toBeInTheDocument();
    expect(within(sidebar).getByText('Awaiting approval')).toBeInTheDocument();
    expect(
      within(sidebar).getByRole('button', { name: 'Open chat for Write docs' })
    ).toBeInTheDocument();
  });

  it('shows waiting approval instead of working when the thread status is approval-blocked', async () => {
    const fetchTranscript = vi.fn(async (): Promise<ThreadTranscript> => ({
      threadId: 'waiting-1',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: []
    }));

    render(
      <ThreadView
        thread={{
          threadId: 'waiting-1',
          title: 'Review permission request',
          workspace: 'OpenAssist',
          status: 'waiting_approval',
          lastActivityAt: '2026-04-25T16:14:00Z',
          lastTurnSummary: 'Needs approval before continuing'
        }}
        fetchTranscript={fetchTranscript}
        sendMessage={vi.fn()}
        stopWork={vi.fn()}
      />
    );

    expect(await screen.findAllByText('Codex is waiting for approval')).toHaveLength(2);
    expect(screen.getByText('Approval')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask Codex anything')).toBeDisabled();
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
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

    await screen.findByText('Ready');
    expect(fetchTranscript).toHaveBeenNthCalledWith(2, 'running-1', { messageLimit: 40 });
    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Hello from phone.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('running-1', 'Hello from phone.'));
    expect(await screen.findByText('Hello from phone.')).toBeInTheDocument();
  });

  it('passes plan collaboration mode when the Plan button is active', async () => {
    const transcript: ThreadTranscript = {
      threadId: 'running-1',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: []
    };
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'start',
      turnId: 'turn-1',
      transcript
    });

    render(
      <ThreadView
        thread={{
          threadId: 'running-1',
          title: 'Plan work',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:18:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
        sendMessage={sendMessage}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Make a plan before editing.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('running-1', 'Make a plan before editing.', {
        collaborationMode: 'plan'
      })
    );
  });

  it('lets the user start implementation from a plan request card', async () => {
    const transcript: ThreadTranscript = {
      threadId: 'running-1',
      activeTurnId: 'turn-1',
      sendState: {
        canSend: false,
        reason: 'waiting_on_approval',
        label: 'Codex is waiting for approval'
      },
      messages: []
    };
    const onApprovalDecision = vi.fn(async () => undefined);

    render(
      <ThreadView
        thread={{
          threadId: 'running-1',
          title: 'Plan work',
          workspace: 'Agent Pulse',
          status: 'waiting_approval',
          lastActivityAt: '2026-04-25T16:18:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
        pendingRequests={[
          {
            id: 'plan-request-1',
            method: 'item/plan/requestImplementation',
            kind: 'plan',
            title: 'Implement this plan?',
            body: '[ ] Read the code\n[ ] Make the change',
            turnId: 'turn-1'
          }
        ]}
        onApprovalDecision={onApprovalDecision}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Implement' }));

    await waitFor(() =>
      expect(onApprovalDecision).toHaveBeenCalledWith(
        'plan-request-1',
        'item/plan/requestImplementation',
        'accept'
      )
    );
  });

  it('offers an app-server fallback to implement a visible plan', async () => {
    const afterSendTranscript: ThreadTranscript = {
      threadId: 'running-1',
      activeTurnId: 'turn-2',
      sendState: {
        canSend: false,
        reason: 'thread_changed',
        label: 'Codex is working'
      },
      messages: []
    };
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
          id: 'plan-1',
          role: 'activity',
          kind: 'plan',
          text: '[x] Read the code\n[ ] Make the change',
          createdAt: '2026-04-25T16:18:00Z'
        }
      ]
    };
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'start',
      turnId: 'turn-2',
      transcript: afterSendTranscript
    });

    render(
      <ThreadView
        thread={{
          threadId: 'running-1',
          title: 'Plan work',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:18:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
        sendMessage={sendMessage}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Implement plan' }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('running-1', 'Please implement this plan.')
    );
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

  it('keeps the latest two messages as the live tail and requires a hard top pull for more history', async () => {
    const fetchTranscript = vi.fn(async (): Promise<ThreadTranscript> => ({
      threadId: 'thread-1',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          kind: 'message',
          text: 'Older user message',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'message-2',
          role: 'assistant',
          kind: 'message',
          text: 'Older assistant message',
          createdAt: '2026-04-25T16:15:00Z'
        },
        {
          id: 'message-3',
          role: 'user',
          kind: 'message',
          text: 'Latest user message',
          createdAt: '2026-04-25T16:16:00Z'
        },
        {
          id: 'message-4',
          role: 'assistant',
          kind: 'message',
          text: 'Newest assistant message',
          createdAt: '2026-04-25T16:17:00Z'
        }
      ]
    }));
    const fetchOlderMessages = vi.fn(async () => ({
      threadId: 'thread-1',
      messages: [],
      hasMore: false
    }));
    const { container } = render(
      <ThreadView
        thread={{
          threadId: 'thread-1',
          title: 'Thread',
          workspace: 'CodexPulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:17:00Z',
          lastTurnSummary: ''
        }}
        fetchTranscript={fetchTranscript}
        fetchOlderMessages={fetchOlderMessages}
      />
    );

    expect(await screen.findByText('Newest assistant message')).toBeInTheDocument();
    expect(screen.getByText('Older user message')).toBeInTheDocument();

    const scroller = container.querySelector('.codex-thread-messages') as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 400, configurable: true }
    });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    expect(fetchOlderMessages).not.toHaveBeenCalled();
    fireEvent.wheel(scroller, { deltaY: -30 });
    expect(fetchOlderMessages).not.toHaveBeenCalled();
    fireEvent.wheel(scroller, { deltaY: -70 });

    await waitFor(() => expect(fetchOlderMessages).toHaveBeenCalledWith('message-1', 40));
    expect(fetchTranscript).toHaveBeenCalledWith('thread-1', { messageLimit: 40 });
  });

  it('does not auto-load older pages when the latest two messages do not fill the viewport', async () => {
    const fetchTranscript = vi.fn(async (): Promise<ThreadTranscript> => ({
      threadId: 'thread-1',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: [
        {
          id: 'message-3',
          role: 'user',
          kind: 'message',
          text: 'Latest user message',
          createdAt: '2026-04-25T16:16:00Z'
        },
        {
          id: 'message-4',
          role: 'assistant',
          kind: 'message',
          text: 'Newest assistant message',
          createdAt: '2026-04-25T16:17:00Z'
        }
      ]
    }));
    const fetchOlderMessages = vi.fn(async () => ({
      threadId: 'thread-1',
      messages: [],
      hasMore: false
    }));
    const { container } = render(
      <ThreadView
        thread={{
          threadId: 'thread-1',
          title: 'Thread',
          workspace: 'CodexPulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:17:00Z',
          lastTurnSummary: ''
        }}
        fetchTranscript={fetchTranscript}
        fetchOlderMessages={fetchOlderMessages}
      />
    );

    expect(await screen.findByText('Newest assistant message')).toBeInTheDocument();

    const scroller = container.querySelector('.codex-thread-messages') as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 240, configurable: true },
      clientHeight: { value: 640, configurable: true }
    });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    expect(fetchOlderMessages).not.toHaveBeenCalled();
  });

  it('loads older pages from a hard touch pull at the top', async () => {
    const fetchTranscript = vi.fn(async (): Promise<ThreadTranscript> => ({
      threadId: 'thread-1',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          kind: 'message',
          text: 'Older user message',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'message-2',
          role: 'user',
          kind: 'message',
          text: 'Latest user message',
          createdAt: '2026-04-25T16:16:00Z'
        },
        {
          id: 'message-3',
          role: 'assistant',
          kind: 'message',
          text: 'Newest assistant message',
          createdAt: '2026-04-25T16:17:00Z'
        }
      ]
    }));
    const fetchOlderMessages = vi.fn(async () => ({
      threadId: 'thread-1',
      messages: [],
      hasMore: false
    }));
    const { container } = render(
      <ThreadView
        thread={{
          threadId: 'thread-1',
          title: 'Thread',
          workspace: 'CodexPulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:17:00Z',
          lastTurnSummary: ''
        }}
        fetchTranscript={fetchTranscript}
        fetchOlderMessages={fetchOlderMessages}
      />
    );

    expect(await screen.findByText('Newest assistant message')).toBeInTheDocument();

    const scroller = container.querySelector('.codex-thread-messages') as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 400, configurable: true }
    });
    scroller.scrollTop = 0;
    fireEvent.touchStart(scroller, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(scroller, { touches: [{ clientY: 175 }] });

    await waitFor(() => expect(fetchOlderMessages).toHaveBeenCalledWith('message-1', 40));
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
            status: 'error',
            lastActivityAt: '2026-04-25T16:18:00Z',
            lastTurnSummary: 'Needs attention'
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

  it('keeps the working dot visible while the Codex stream source says the agent is running', async () => {
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
        projects={[
          {
            projectId: 'project-agent-pulse',
            name: 'Agent Pulse',
            path: '/Users/me/projects/AgentPulse'
          }
        ]}
        streamingThreadIds={new Set(['running-1'])}
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

  it('allows a follow-up message while the Codex stream source says the agent is working', async () => {
    const liveTranscript: ThreadTranscript = {
      threadId: 'running-1',
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
          text: 'I am still running the command.',
          createdAt: '2026-04-25T16:15:05Z'
        }
      ]
    };
    const afterSendTranscript: ThreadTranscript = {
      ...liveTranscript,
      messages: [
        ...liveTranscript.messages,
        {
          id: 'user-1',
          role: 'user',
          kind: 'message',
          text: 'Add one more detail.',
          createdAt: '2026-04-25T16:16:00Z'
        }
      ]
    };
    const fetchTranscript = vi.fn().mockResolvedValue(liveTranscript);
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'steer',
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
        streamingThreadIds={new Set(['running-1'])}
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
    expect(await screen.findByText('Codex is working')).toBeInTheDocument();
    expect(screen.getByText('I am still running the command.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Add one more detail.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('running-1', 'Add one more detail.'));
    expect(await screen.findByText('Add one more detail.')).toBeInTheDocument();
  });

  it('keeps a just-sent follow-up below the old final answer instead of replaying the old turn', async () => {
    const previousTranscript: ThreadTranscript = {
      threadId: 'running-1',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: [
        {
          id: 'old-user',
          role: 'user',
          kind: 'message',
          text: 'What are you doing?',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'old-tool',
          role: 'activity',
          kind: 'tool',
          text: 'browser.screenshot completed',
          createdAt: '2026-04-25T16:14:10Z'
        },
        {
          id: 'old-assistant',
          role: 'assistant',
          kind: 'message',
          text: 'Here is the previous answer.',
          createdAt: '2026-04-25T16:14:20Z'
        }
      ]
    };
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'start',
      turnId: 'new-turn',
      transcript: previousTranscript
    });

    render(
      <ThreadView
        thread={{
          threadId: 'running-1',
          title: 'Hi',
          workspace: 'CC src',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:14:20Z',
          lastTurnSummary: ''
        }}
        liveTranscript={previousTranscript}
        sendMessage={sendMessage}
      />
    );

    expect(await screen.findByText('Here is the previous answer.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: '2' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('running-1', '2'));
    expect(await screen.findByText('2')).toBeInTheDocument();
    expect(screen.queryByText('Here is the previous answer.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /browser.screenshot completed/ })).not.toBeInTheDocument();
  });

  it('does not accept an old transcript just because it contains the same short reply text', async () => {
    const previousTranscript: ThreadTranscript = {
      threadId: 'running-1',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: [
        {
          id: 'old-user-choice',
          role: 'user',
          kind: 'message',
          text: '2',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'old-work',
          role: 'activity',
          kind: 'tool',
          text: 'Worked for 2m 51s',
          createdAt: '2026-04-25T16:14:05Z'
        },
        {
          id: 'old-answer',
          role: 'assistant',
          kind: 'message',
          text: 'This is the previous answer for option 2.',
          createdAt: '2026-04-25T16:14:20Z'
        }
      ]
    };
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'start',
      turnId: 'new-turn',
      transcript: previousTranscript
    });

    render(
      <ThreadView
        thread={{
          threadId: 'running-1',
          title: 'Hi',
          workspace: 'CC src',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:14:20Z',
          lastTurnSummary: ''
        }}
        liveTranscript={previousTranscript}
        sendMessage={sendMessage}
      />
    );

    expect(await screen.findByText('This is the previous answer for option 2.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: '2' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('running-1', '2'));
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('This is the previous answer for option 2.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Worked for 2m 51s/ })).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: /Explored the workspace, used the browser/ })).toBeInTheDocument();
    expect(screen.queryByText(/Detailed private progress/)).not.toBeInTheDocument();
    expect(screen.queryByText('browser.screenshot completed')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Explored the workspace, used the browser/ }));

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
    const workToggle = screen.getByRole('button', { name: /Used the browser/ });
    expect(workToggle).toBeInTheDocument();
    fireEvent.click(workToggle);
    expect(await screen.findByRole('button', { name: /browser.screenshot completed/ })).toBeInTheDocument();
  });

  it('summarizes hidden exploration and searches like OpenAssist', async () => {
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
          text: 'Check how this works.',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'cmd-1',
          role: 'activity',
          kind: 'command',
          text: 'rg -n "streaming" Sources',
          createdAt: '2026-04-25T16:14:04Z'
        },
        ...[1, 2, 3, 4].map((index) => ({
          id: `search-${index}`,
          role: 'activity' as const,
          kind: 'tool' as const,
          text: `web_search completed: query ${index}`,
          createdAt: `2026-04-25T16:14:0${index + 4}Z`
        })),
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'Here is the final answer.',
          createdAt: '2026-04-25T16:15:00Z',
          phase: 'final_answer'
        } as ThreadTranscript['messages'][number]
      ]
    };

    render(
      <ThreadView
        thread={{
          threadId: 'running-1',
          title: 'Streaming behavior',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:15:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
      />
    );

    expect(screen.getByText('Here is the final answer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Explored the workspace, ran 4 searches/ })).toBeInTheDocument();
    expect(screen.queryByText(/web_search completed/)).not.toBeInTheDocument();
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
    expect(within(dialog).getByText('Start a new thread')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Project' }), {
      target: { value: 'project-codexpulse' }
    });
    expect(within(dialog).queryByLabelText('Folder path')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start thread' }));

    await waitFor(() =>
      expect(onNewThread).toHaveBeenCalledWith({
        projectId: 'project-codexpulse',
        provider: 'codex'
      })
    );
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
    expect(within(dialog).getByText('No saved projects are available yet.')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Folder path')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Start thread' })).toBeDisabled();

    expect(onNewThread).not.toHaveBeenCalled();
  });
});
