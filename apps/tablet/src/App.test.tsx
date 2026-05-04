// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ThreadMessageResponse, ThreadTranscript } from '@agent-pulse/shared';
import { App, extractLatestModel, extractLatestReasoningEffort, extractPendingRequests } from './App';
import { TranscriptFetchTimeoutError } from './api';
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

  const expectCodexStopControl = async () => {
    const stopButton = await screen.findByRole('button', { name: 'Stop Codex' });
    expect(screen.queryByText('Codex is working')).not.toBeInTheDocument();
    return stopButton;
  };

  const installVoiceRecordingMocks = () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: stopTrack }]
    }));

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia }
    });

    class FakeMediaRecorder {
      static isTypeSupported = vi.fn(() => true);

      state: RecordingState = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        if (options?.mimeType) {
          this.mimeType = options.mimeType;
        }
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({
          data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType })
        } as BlobEvent);
        this.onstop?.();
      }
    }

    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);

    return { getUserMedia, stopTrack };
  };

  const voiceThread = {
    threadId: 'voice-thread',
    title: 'Voice composer',
    workspace: 'Agent Pulse',
    status: 'idle',
    lastActivityAt: '2026-04-25T16:18:00Z',
    lastTurnSummary: ''
  } as const;

  const readyVoiceTranscript: ThreadTranscript = {
    threadId: 'voice-thread',
    provider: 'codex',
    activeTurnId: null,
    sendState: {
      canSend: true,
      reason: 'ready',
      label: 'Ready'
    },
    messages: []
  };

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

    fireEvent.click(await screen.findByRole('button', { name: 'Open thread actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete thread' }));

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

  it('repairs a stale saved device token after the live event socket is rejected', async () => {
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
    const sockets: MockWebSocket[] = [];

    class MockWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      readonly close = vi.fn();

      constructor(readonly url: string | URL) {
        sockets.push(this);
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
        const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/, '');
        threadListTokens.push(token);
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
    });

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Agent Pulse' })).toBeInTheDocument();
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(String(sockets[0]?.url)).toContain('token=stale-token');

    act(() => {
      sockets[0]?.onclose?.({} as CloseEvent);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/device/session/recover', expect.anything()));
    await waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2));
    expect(String(sockets.at(-1)?.url)).toContain('token=fresh-token-1234567890');
    expect(JSON.parse(localStorage.getItem('agent-pulse-session') ?? '{}')).toMatchObject({
      token: 'fresh-token-1234567890',
      deviceId: 'device-1'
    });
    expect(threadListTokens).toContain('fresh-token-1234567890');
  });

  it('keeps the dashboard visible when session recovery times out but helper health is reachable', async () => {
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
          return new Response(JSON.stringify({ error: 'invalid' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        }

        if (url === '/device/session/recover') {
          throw new Error('recover timed out');
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Agent Pulse' })).toBeInTheDocument();
    expect(await screen.findByText('Reconnecting to helper...')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Helper offline' })).not.toBeInTheDocument();
    expect(threadListTokens).toEqual(['stale-token']);
    expect(JSON.parse(localStorage.getItem('agent-pulse-session') ?? '{}')).toMatchObject({
      token: 'stale-token',
      deviceId: 'device-1'
    });
    expect(screen.queryByRole('heading', { name: 'How will you use this?' })).not.toBeInTheDocument();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.close).not.toHaveBeenCalled();
  });

  it('lets the offline retry button recover after a temporary helper connection failure', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'token-1234567890',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );

    let healthAttempts = 0;
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
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          healthAttempts += 1;
          if (healthAttempts === 1) {
            throw new Error('temporary tunnel refresh');
          }
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
            json: async () => ({ threads: [], groups: [] })
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Helper offline' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));

    expect(await screen.findByRole('heading', { name: 'Agent Pulse' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Helper offline' })).not.toBeInTheDocument();
    expect(healthAttempts).toBe(2);
    expect(sockets.length).toBeGreaterThanOrEqual(1);
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

    const stopButton = await expectCodexStopControl();
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

  it('keeps working state when a stale ready transcript arrives before idle status', async () => {
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

    await expectCodexStopControl();

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
    expect(screen.getByRole('button', { name: 'Stop Codex' })).toBeInTheDocument();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/status/changed',
            payload: {
              threadId: 'thread-live',
              status: 'idle'
            }
          })
        })
      );
    });

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
    expect(await screen.findByRole('button', { name: /Context 72%/ })).toBeInTheDocument();

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
    expect(screen.getByRole('button', { name: /Context 72%/ })).toBeInTheDocument();

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

    expect(await screen.findByRole('button', { name: /Context 84%/ })).toBeInTheDocument();
    expect(screen.getByText('5h')).toBeInTheDocument();
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

  it('groups the Copilot model picker by vendor and keeps groups collapsed by default', async () => {
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
                  threadId: 'copilot:thread-model',
                  provider: 'copilot',
                  providerThreadId: 'thread-model',
                  title: 'Fix Copilot grouping',
                  workspace: 'CodexPulse',
                  status: 'idle',
                  lastActivityAt: '2026-05-01T17:12:00Z',
                  lastTurnSummary: '',
                  model: 'gpt-5.4'
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
                  slug: 'gpt-5.4',
                  displayName: 'GPT-5.4',
                  provider: 'copilot',
                  visibility: 'visible'
                },
                {
                  slug: 'gpt-5.2',
                  displayName: 'GPT-5.2',
                  provider: 'copilot',
                  visibility: 'visible'
                },
                {
                  slug: 'claude-opus-4.6',
                  displayName: 'Claude Opus 4.6',
                  provider: 'copilot',
                  visibility: 'visible'
                },
                {
                  slug: 'claude-sonnet-4.5',
                  displayName: 'Claude Sonnet 4.5',
                  provider: 'copilot',
                  visibility: 'visible'
                },
                {
                  slug: 'gemini-3-pro-preview',
                  displayName: 'Gemini 3 Pro Preview',
                  provider: 'copilot',
                  visibility: 'visible'
                },
                {
                  slug: 'claude-opus-4.6-1m',
                  displayName: 'Claude Opus 4.6 1M',
                  provider: 'copilot',
                  visibility: 'hidden'
                },
                {
                  slug: 'gpt-5.5',
                  displayName: 'GPT-5.5',
                  provider: 'codex',
                  visibility: 'visible'
                }
              ]
            })
          };
        }

        if (url === '/threads/copilot%3Athread-model/transcript?limit=40') {
          return {
            ok: true,
            json: async () => ({
              threadId: 'copilot:thread-model',
              provider: 'copilot',
              providerThreadId: 'thread-model',
              activeTurnId: null,
              sendState: {
                canSend: true,
                reason: 'ready',
                label: 'Ready'
              },
              messages: [],
              model: 'gpt-5.4'
            })
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Open chat for Fix Copilot grouping/ }));

    const modelChip = await screen.findByRole('button', { name: /GPT-5.4/ });
    fireEvent.click(modelChip);

    expect(await screen.findByRole('button', { name: /OpenAI GPT/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Anthropic Claude/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Google Gemini/ })).toBeInTheDocument();
    expect(screen.queryByText('Claude Opus 4.6')).not.toBeInTheDocument();
    expect(screen.queryByText('Gemini 3 Pro Preview')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude Opus 4.6 1M')).not.toBeInTheDocument();
    expect(screen.queryByText('GPT-5.5')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Anthropic Claude/ }));

    expect(await screen.findByText('Claude Opus 4.6')).toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 4.5')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5.2')).not.toBeInTheDocument();
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
    await expectCodexStopControl();

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
    await expectCodexStopControl();

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

    await expectCodexStopControl();
  });

  it('keeps working through a ready transcript until the live status goes idle', async () => {
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
    await expectCodexStopControl();

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
    expect(screen.getByRole('button', { name: 'Stop Codex' })).toBeInTheDocument();

    await act(async () => {
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'thread/status/changed',
            payload: { threadId: 'thread-live', status: 'idle' }
          })
        })
      );
    });

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

    const stopButton = await expectCodexStopControl();
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

    const stopButton = await expectCodexStopControl();
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
    expect(tile.getAttribute('aria-label')).toMatch(/Review/);
  });

  it('marks review threads with the current time and syncs helper when helper state is older', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T20:00:00.000Z'));
    const onMarkThreadSeen = vi.fn();

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
            title: 'Fix review repeat',
            workspace: 'CodexPulse',
            status: 'idle',
            lastActivityAt: '2026-05-03T19:55:00.000Z',
            lastTurnSummary: ''
          }
        ]}
        seenThreadActivityOverride={{
          'review-1': Date.parse('2026-05-03T19:50:00.000Z')
        }}
        onMarkThreadSeen={onMarkThreadSeen}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Mark all reviewed/i }));

    expect(onMarkThreadSeen).toHaveBeenCalledWith(
      'review-1',
      Date.parse('2026-05-03T20:00:00.000Z')
    );
  });

  it('shows provider hints in recent activity lists', () => {
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
            threadId: 'claude-code:recent-1',
            provider: 'claude-code',
            title: 'Review Claude changes',
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

    expect(tile.classList.contains('provider-claude-code')).toBe(true);
    expect(tile.getAttribute('aria-label')).toMatch(/Claude/);
    expect(
      document.querySelector('.codex-insight-list-row-mark.provider-claude-code')
    ).not.toBeNull();
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
    expect(within(sidebar).getByText('Projects')).toBeInTheDocument();
    expect(within(sidebar).getByText('Chats')).toBeInTheDocument();
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

  it('shows a subtle show more control for project groups with older threads', () => {
    const projectPath = '/Users/me/projects/AgentPulse';
    const onShowMoreThreads = vi.fn();
    const threads = Array.from({ length: 6 }, (_, index) => ({
      threadId: `thread-${index}`,
      title: `Project chat ${index}`,
      workspace: 'Agent Pulse',
      workspacePath: projectPath,
      status: 'idle' as const,
      lastActivityAt: new Date(Date.parse('2026-04-25T16:18:00Z') - index * 60_000).toISOString(),
      lastTurnSummary: ''
    }));

    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={threads}
        threadListGroups={[{ groupKey: projectPath, total: 7, visible: 6 }]}
        projects={[
          {
            projectId: 'project-agent-pulse',
            name: 'Agent Pulse',
            path: projectPath
          }
        ]}
        onShowMoreThreads={onShowMoreThreads}
      />
    );

    const sidebar = screen.getByTestId('codex-sidebar');
    const showMore = within(sidebar).getByRole('button', {
      name: 'Show more chats in Agent Pulse'
    });
    expect(showMore).toHaveTextContent('Show more');

    fireEvent.click(showMore);
    expect(onShowMoreThreads).toHaveBeenCalledWith(projectPath);
  });

  it('shows sidebar loading feedback while threads are loading', () => {
    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={[]}
        threadsLoaded={false}
        projects={[]}
      />
    );

    const sidebar = screen.getByTestId('codex-sidebar');
    expect(within(sidebar).getByRole('status')).toHaveTextContent('Loading chats');
  });

  it('shows loading feedback on the project show more control', () => {
    const projectPath = '/Users/me/projects/AgentPulse';
    const threads = Array.from({ length: 6 }, (_, index) => ({
      threadId: `thread-${index}`,
      title: `Project chat ${index}`,
      workspace: 'Agent Pulse',
      workspacePath: projectPath,
      status: 'idle' as const,
      lastActivityAt: new Date(Date.parse('2026-04-25T16:18:00Z') - index * 60_000).toISOString(),
      lastTurnSummary: ''
    }));

    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={threads}
        threadsLoaded={false}
        loadingThreadGroupKey={projectPath}
        threadListGroups={[{ groupKey: projectPath, total: 7, visible: 6 }]}
        projects={[
          {
            projectId: 'project-agent-pulse',
            name: 'Agent Pulse',
            path: projectPath
          }
        ]}
        onShowMoreThreads={vi.fn()}
      />
    );

    const sidebar = screen.getByTestId('codex-sidebar');
    expect(within(sidebar).getByRole('status')).toHaveTextContent('Loading chats');
  });

  it('shows a show less control for expanded project groups', () => {
    const projectPath = '/Users/me/projects/AgentPulse';
    const onShowLessThreads = vi.fn();
    const threads = Array.from({ length: 8 }, (_, index) => ({
      threadId: `expanded-thread-${index}`,
      title: `Expanded chat ${index}`,
      workspace: 'Agent Pulse',
      workspacePath: projectPath,
      status: 'idle' as const,
      lastActivityAt: new Date(Date.parse('2026-04-25T16:18:00Z') - index * 60_000).toISOString(),
      lastTurnSummary: ''
    }));

    render(
      <Dashboard
        health={{
          status: 'ok',
          codexAppServer: 'connected',
          version: '0.1.0',
          uptimeSec: 60
        }}
        threads={threads}
        expandedThreadGroupKeys={new Set([projectPath])}
        projects={[
          {
            projectId: 'project-agent-pulse',
            name: 'Agent Pulse',
            path: projectPath
          }
        ]}
        onShowLessThreads={onShowLessThreads}
      />
    );

    const sidebar = screen.getByTestId('codex-sidebar');
    const showLess = within(sidebar).getByRole('button', {
      name: 'Show fewer chats in Agent Pulse'
    });
    expect(showLess).toHaveTextContent('Show less');

    fireEvent.click(showLess);
    expect(onShowLessThreads).toHaveBeenCalledWith(projectPath);
  });

  it('fuzzy searches sidebar threads by title and project name', () => {
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
            lastTurnSummary: ''
          },
          {
            threadId: 'waiting-1',
            title: 'Review permission request',
            workspace: 'OpenAssist',
            status: 'waiting_approval',
            lastActivityAt: '2026-04-25T16:14:00Z',
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

    const sidebar = screen.getByTestId('codex-sidebar');
    const search = within(sidebar).getByRole('searchbox', { name: 'Search chats or projects' });

    fireEvent.change(search, { target: { value: 'opn ast' } });
    expect(within(sidebar).getByText('1 thread found')).toBeInTheDocument();
    expect(
      within(sidebar).getByRole('button', { name: 'Open chat for Review permission request' })
    ).toBeInTheDocument();
    expect(
      within(sidebar).queryByRole('button', { name: /Open chat for Implement dashboard grouping/ })
    ).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'impl grp' } });
    expect(
      within(sidebar).getByRole('button', { name: /Open chat for Implement dashboard grouping/ })
    ).toBeInTheDocument();
    expect(
      within(sidebar).queryByRole('button', { name: 'Open chat for Review permission request' })
    ).not.toBeInTheDocument();

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(within(sidebar).queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
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
    fireEvent.click(within(drawer).getByRole('button', { name: 'Open thread actions' }));
    fireEvent.click(within(drawer).getByRole('menuitem', { name: 'Open in Codex' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'Open composer options' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Plan mode/i }));
    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Make a plan before editing.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('running-1', 'Make a plan before editing.', {
        collaborationMode: 'plan'
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open composer options' }));
    expect(screen.getByRole('menuitemcheckbox', { name: /Plan mode/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('keeps follow-up messages in plan mode until the user turns Plan off', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Open composer options' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Plan mode/i }));
    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Make a plan before editing.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenNthCalledWith(1, 'running-1', 'Make a plan before editing.', {
        collaborationMode: 'plan'
      })
    );

    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Revise the plan first.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenNthCalledWith(2, 'running-1', 'Revise the plan first.', {
        collaborationMode: 'plan'
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open composer options' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Plan mode/i }));
    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Leave plan mode now.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenNthCalledWith(3, 'running-1', 'Leave plan mode now.', {
        collaborationMode: 'default'
      })
    );
  });

  it('shows the voice button only when helper transcription is available', () => {
    render(
      <ThreadView
        thread={voiceThread}
        liveTranscript={readyVoiceTranscript}
        sendMessage={vi.fn()}
        transcribeVoiceAudio={vi.fn()}
        voiceTranscriptionAvailable={false}
      />
    );

    expect(screen.queryByRole('button', { name: 'Record voice message' })).not.toBeInTheDocument();

    cleanup();

    render(
      <ThreadView
        thread={voiceThread}
        liveTranscript={readyVoiceTranscript}
        sendMessage={vi.fn()}
        transcribeVoiceAudio={vi.fn()}
        voiceTranscriptionAvailable
      />
    );

    expect(screen.getByRole('button', { name: 'Record voice message' })).toBeEnabled();
  });

  it('records voice, transcribes it, and places editable text in the composer', async () => {
    installVoiceRecordingMocks();
    let resolveTranscript: (value: string) => void = () => undefined;
    const transcriptPromise = new Promise<string>((resolve) => {
      resolveTranscript = resolve;
    });
    const transcribeVoiceAudio = vi.fn(() => transcriptPromise);

    render(
      <ThreadView
        thread={voiceThread}
        liveTranscript={readyVoiceTranscript}
        sendMessage={vi.fn()}
        transcribeVoiceAudio={transcribeVoiceAudio}
        voiceTranscriptionAvailable
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));

    expect(await screen.findByText('Listening')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop and transcribe voice' }));

    expect(await screen.findByText('Transcribing...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop Codex' })).not.toBeInTheDocument();

    resolveTranscript('Please update the streaming code.');

    await waitFor(() =>
      expect(screen.getByLabelText('Message Codex')).toHaveValue('Please update the streaming code.')
    );
    expect(transcribeVoiceAudio).toHaveBeenCalledWith(expect.any(Blob));
    await waitFor(() => expect(screen.getByLabelText('Message Codex')).toHaveFocus());
  });

  it('allows voice transcription while Codex is already working', async () => {
    installVoiceRecordingMocks();
    const workingTranscript: ThreadTranscript = {
      threadId: 'voice-thread',
      provider: 'codex',
      activeTurnId: 'turn-working',
      sendState: {
        canSend: false,
        reason: 'thread_changed',
        label: 'Codex is working'
      },
      messages: []
    };
    const transcribeVoiceAudio = vi.fn(async () => 'Queue this as my next note.');
    const sendMessage = vi.fn(async (): Promise<ThreadMessageResponse> => ({
      ok: true,
      mode: 'steer',
      turnId: 'turn-working',
      transcript: workingTranscript
    }));

    render(
      <ThreadView
        thread={{ ...voiceThread, status: 'running' }}
        liveTranscript={workingTranscript}
        sendMessage={sendMessage}
        stopWork={vi.fn()}
        transcribeVoiceAudio={transcribeVoiceAudio}
        voiceTranscriptionAvailable
      />
    );

    expect(screen.getByRole('button', { name: 'Stop Codex' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));
    expect(await screen.findByText('Listening')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop Codex' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop and transcribe voice' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Message Codex')).toHaveValue('Queue this as my next note.')
    );
    expect(screen.queryByRole('button', { name: 'Stop Codex' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('voice-thread', 'Queue this as my next note.')
    );
  });

  it('supports press-and-hold recording before transcription', async () => {
    installVoiceRecordingMocks();
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const transcribeVoiceAudio = vi.fn(async () => 'Hold recorded draft.');

    render(
      <ThreadView
        thread={voiceThread}
        liveTranscript={readyVoiceTranscript}
        sendMessage={vi.fn()}
        transcribeVoiceAudio={transcribeVoiceAudio}
        voiceTranscriptionAvailable
      />
    );

    const button = screen.getByRole('button', { name: 'Record voice message' });
    fireEvent.pointerDown(button, { button: 0, pointerId: 7 });

    expect(await screen.findByText('Listening')).toBeInTheDocument();

    now = 1_650;
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Stop and transcribe voice' }), {
      pointerId: 7
    });

    await waitFor(() =>
      expect(screen.getByLabelText('Message Codex')).toHaveValue('Hold recorded draft.')
    );
    expect(transcribeVoiceAudio).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous draft safe when voice transcription fails', async () => {
    installVoiceRecordingMocks();
    const transcribeVoiceAudio = vi.fn(async () => {
      throw undefined;
    });

    render(
      <ThreadView
        thread={voiceThread}
        liveTranscript={readyVoiceTranscript}
        sendMessage={vi.fn()}
        transcribeVoiceAudio={transcribeVoiceAudio}
        voiceTranscriptionAvailable
      />
    );

    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Keep this draft.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));
    expect(await screen.findByText('Listening')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop and transcribe voice' }));

    expect(
      await screen.findByText('Could not transcribe audio. Check Codex sign-in and microphone access.')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Message Codex')).toHaveValue('Keep this draft.');
  });

  it('closes thread, composer, and model popups when clicking outside', async () => {
    const transcript: ThreadTranscript = {
      threadId: 'popup-thread',
      provider: 'codex',
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
          text: 'Hello',
          createdAt: '2026-04-25T16:14:00Z'
        }
      ]
    };
    const models: CatalogModel[] = [
      {
        slug: 'gpt-5.5',
        displayName: 'GPT-5.5',
        provider: 'codex',
        defaultReasoningLevel: 'medium',
        supportedReasoningLevels: [
          { effort: 'medium', description: 'Balanced reasoning.' },
          { effort: 'high', description: 'Deeper reasoning.' }
        ],
        visibility: 'visible'
      },
      {
        slug: 'gpt-5.4',
        displayName: 'GPT-5.4',
        provider: 'codex',
        defaultReasoningLevel: 'medium',
        supportedReasoningLevels: [{ effort: 'medium', description: 'Balanced reasoning.' }],
        visibility: 'visible'
      }
    ];
    const sendPopupMessage = vi.fn(
      async (): Promise<ThreadMessageResponse> => ({
        ok: true,
        mode: 'steer',
        turnId: 'turn-1',
        transcript
      })
    );

    render(
      <ThreadView
        thread={{
          threadId: 'popup-thread',
          provider: 'codex',
          title: 'Popup thread',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:18:00Z',
          lastTurnSummary: '',
          model: 'gpt-5.5'
        }}
        liveTranscript={transcript}
        sendMessage={sendPopupMessage}
        deleteThread={vi.fn(async () => undefined)}
        models={models}
        selectedModelSlug="gpt-5.5"
        selectedReasoningEffort="medium"
        onChangeModel={vi.fn(async () => undefined)}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open thread actions' }));
    expect(screen.getByRole('menuitem', { name: 'Delete thread' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menuitem', { name: 'Delete thread' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open composer options' }));
    expect(screen.getByRole('menuitemcheckbox', { name: /Plan mode/i })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menuitemcheckbox', { name: /Plan mode/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /GPT-5.5/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('GPT-5.4')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText('GPT-5.4')).not.toBeInTheDocument();
  });

  it('shows the sent message and Thinking state while waiting for agent startup', async () => {
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
    const sendMessage = vi.fn(
      (): Promise<ThreadMessageResponse> => new Promise<ThreadMessageResponse>(() => undefined)
    );

    render(
      <ThreadView
        thread={{
          threadId: 'running-1',
          title: 'Slow startup',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:18:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
        sendMessage={sendMessage}
      />
    );

    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Please check the slow send.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('running-1', 'Please check the slow send.')
    );
    expect(await screen.findByText('Please check the slow send.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Thinking/ })).toHaveLength(2);
    expect(screen.getByText(/Codex is thinking/i)).toBeInTheDocument();
    expect(screen.queryByText('Beginning of conversation.')).not.toBeInTheDocument();
    expect(screen.queryByText('No visible chat messages yet.')).not.toBeInTheDocument();
  });

  it('stays at the bottom when Thinking is replaced by the final assistant response', async () => {
    const baseTranscript: ThreadTranscript = {
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
          text: 'Old question',
          createdAt: '2026-04-25T16:10:00Z'
        },
        {
          id: 'old-assistant',
          role: 'assistant',
          kind: 'message',
          text: 'Old answer',
          createdAt: '2026-04-25T16:11:00Z'
        }
      ]
    };
    const finalTranscript: ThreadTranscript = {
      ...baseTranscript,
      messages: [
        ...baseTranscript.messages,
        {
          id: 'new-user',
          role: 'user',
          kind: 'message',
          text: 'Please finish this.',
          createdAt: '2026-04-25T16:12:00Z'
        },
        {
          id: 'new-assistant',
          role: 'assistant',
          kind: 'message',
          phase: 'final_answer',
          text: 'Done with the fix.',
          createdAt: '2026-04-25T16:13:00Z'
        }
      ]
    };
    const sendMessage = vi.fn(
      (): Promise<ThreadMessageResponse> => new Promise<ThreadMessageResponse>(() => undefined)
    );
    const { container, rerender } = render(
      <ThreadView
        thread={{
          threadId: 'running-1',
          title: 'Slow startup',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:18:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={baseTranscript}
        sendMessage={sendMessage}
      />
    );

    const scroller = container.querySelector('.codex-thread-messages') as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 300, configurable: true }
    });

    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Please finish this.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Please finish this.')).toBeInTheDocument();
    expect(screen.getByText(/Codex is thinking/i)).toBeInTheDocument();

    scroller.scrollTop = 0;
    rerender(
      <ThreadView
        thread={{
          threadId: 'running-1',
          title: 'Slow startup',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:18:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={finalTranscript}
        sendMessage={sendMessage}
      />
    );

    expect(await screen.findByText('Done with the fix.')).toBeInTheDocument();
    await waitFor(() => expect(scroller.scrollTop).toBe(1000));
  });

  it('keeps unsent composer drafts separated by thread', async () => {
    const transcriptA: ThreadTranscript = {
      threadId: 'thread-a',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: []
    };
    const transcriptB: ThreadTranscript = {
      ...transcriptA,
      threadId: 'thread-b'
    };
    const sendMessage = vi.fn();
    const { rerender } = render(
      <ThreadView
        thread={{
          threadId: 'thread-a',
          title: 'Thread A',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:18:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcriptA}
        sendMessage={sendMessage}
      />
    );

    const textareaA = screen.getByLabelText('Message Codex') as HTMLTextAreaElement;
    fireEvent.change(textareaA, {
      target: { value: 'Draft only for A' }
    });
    expect(textareaA.value).toBe('Draft only for A');

    rerender(
      <ThreadView
        thread={{
          threadId: 'thread-b',
          title: 'Thread B',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:18:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcriptB}
        sendMessage={sendMessage}
      />
    );

    const textareaB = screen.getByLabelText('Message Codex') as HTMLTextAreaElement;
    expect(textareaB.value).toBe('');
    fireEvent.change(textareaB, {
      target: { value: 'Draft only for B' }
    });

    rerender(
      <ThreadView
        thread={{
          threadId: 'thread-a',
          title: 'Thread A',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:18:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcriptA}
        sendMessage={sendMessage}
      />
    );
    expect((screen.getByLabelText('Message Codex') as HTMLTextAreaElement).value).toBe(
      'Draft only for A'
    );
  });

  it('lets the user paste an image and sends it as an attachment', async () => {
    class MockFileReader {
      result: string | ArrayBuffer | null = null;
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL() {
        this.result = 'data:image/png;base64,iVBORw0KGgo=';
        this.onload?.({ target: this } as unknown as ProgressEvent<FileReader>);
      }
    }
    vi.stubGlobal('FileReader', MockFileReader);
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
      transcript: {
        ...transcript,
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
    });

    render(
      <ThreadView
        thread={{
          threadId: 'running-1',
          title: 'Paste image',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:18:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
        sendMessage={sendMessage}
      />
    );

    const textarea = screen.getByLabelText('Message Codex');
    const file = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
      type: 'image/png'
    });
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => file
          }
        ]
      }
    });

    expect(await screen.findByAltText('Pasted image 1')).toBeInTheDocument();
    fireEvent.change(textarea, {
      target: { value: 'See this.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        'running-1',
        'See this.',
        expect.objectContaining({
          attachments: [
            expect.objectContaining({
              kind: 'image',
              url: 'data:image/png;base64,iVBORw0KGgo=',
              alt: 'Pasted image 1',
              mimeType: 'image/png'
            })
          ]
        })
      )
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

    fireEvent.click(screen.getByRole('button', { name: 'Implement plan' }));

    await waitFor(() =>
      expect(onApprovalDecision).toHaveBeenCalledWith(
        'plan-request-1',
        'item/plan/requestImplementation',
        'accept'
      )
    );
  });

  it('does not show an implement popup for normal plan activity', async () => {
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
    const sendMessage = vi.fn();

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

    expect(screen.queryByRole('button', { name: 'Implement plan' })).not.toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
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

  it('keeps the latest two messages as the live tail and auto-loads more history near the top', async () => {
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

    await waitFor(() => expect(fetchOlderMessages).toHaveBeenCalledWith('message-1', 40));
    expect(fetchTranscript).toHaveBeenCalledWith('thread-1', { messageLimit: 40 });
  });

  it('preserves the visible message position when older pages are prepended', async () => {
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
      messages: [
        {
          id: 'message-1',
          role: 'user' as const,
          kind: 'message' as const,
          text: 'Older user message',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'message-2',
          role: 'assistant' as const,
          kind: 'message' as const,
          text: 'Older assistant message',
          createdAt: '2026-04-25T16:15:00Z'
        }
      ],
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
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 400,
      left: 0,
      right: 320,
      width: 320,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect);
    const anchor = screen
      .getByText('Latest user message')
      .closest('[data-scroll-anchor="true"]') as HTMLElement;
    vi.spyOn(anchor, 'getBoundingClientRect')
      .mockReturnValueOnce({
        top: 120,
        bottom: 160,
        left: 0,
        right: 320,
        width: 320,
        height: 40,
        x: 0,
        y: 120,
        toJSON: () => ({})
      } as DOMRect)
      .mockReturnValueOnce({
        top: 120,
        bottom: 160,
        left: 0,
        right: 320,
        width: 320,
        height: 40,
        x: 0,
        y: 120,
        toJSON: () => ({})
      } as DOMRect)
      .mockReturnValue({
        top: 300,
        bottom: 340,
        left: 0,
        right: 320,
        width: 320,
        height: 40,
        x: 0,
        y: 300,
        toJSON: () => ({})
      } as DOMRect);

    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    expect(await screen.findByText('Older assistant message')).toBeInTheDocument();
    await waitFor(() => expect(scroller.scrollTop).toBe(180));
  });

  it('keeps the visible message steady while the older-message loader appears', async () => {
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
    let resolveOlderMessages: ((value: {
      threadId: string;
      messages: ThreadTranscript['messages'];
      hasMore: boolean;
    }) => void) | undefined;
    const fetchOlderMessages = vi.fn(
      () =>
        new Promise<{
          threadId: string;
          messages: ThreadTranscript['messages'];
          hasMore: boolean;
        }>((resolve) => {
          resolveOlderMessages = resolve;
        })
    );
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
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 400,
      left: 0,
      right: 320,
      width: 320,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect);
    const anchor = screen
      .getByText('Latest user message')
      .closest('[data-scroll-anchor="true"]') as HTMLElement;
    vi.spyOn(anchor, 'getBoundingClientRect')
      .mockReturnValueOnce({
        top: 120,
        bottom: 160,
        left: 0,
        right: 320,
        width: 320,
        height: 40,
        x: 0,
        y: 120,
        toJSON: () => ({})
      } as DOMRect)
      .mockReturnValueOnce({
        top: 150,
        bottom: 190,
        left: 0,
        right: 320,
        width: 320,
        height: 40,
        x: 0,
        y: 150,
        toJSON: () => ({})
      } as DOMRect)
      .mockReturnValueOnce({
        top: 150,
        bottom: 190,
        left: 0,
        right: 320,
        width: 320,
        height: 40,
        x: 0,
        y: 150,
        toJSON: () => ({})
      } as DOMRect)
      .mockReturnValue({
        top: 300,
        bottom: 340,
        left: 0,
        right: 320,
        width: 320,
        height: 40,
        x: 0,
        y: 300,
        toJSON: () => ({})
      } as DOMRect);

    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    expect(await screen.findByText('Loading older messages…')).toBeInTheDocument();
    await waitFor(() => expect(scroller.scrollTop).toBe(30));

    await act(async () => {
      resolveOlderMessages?.({
        threadId: 'thread-1',
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
          }
        ],
        hasMore: false
      });
    });

    expect(await screen.findByText('Older assistant message')).toBeInTheDocument();
    await waitFor(() => expect(scroller.scrollTop).toBe(180));
  });

  it('auto-loads older messages when the latest messages do not fill the viewport', async () => {
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

    await waitFor(() => expect(fetchOlderMessages).toHaveBeenCalledWith('message-3', 40));
    expect(await screen.findByText('Beginning of conversation.')).toBeInTheDocument();
  });

  it('keeps the manual older-message control as a fallback', async () => {
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
    scroller.scrollTop = 240;

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));

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
    expect(await screen.findByText('I am still running the command.')).toBeInTheDocument();
    expect(screen.queryByText('Codex is working')).not.toBeInTheDocument();
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

  it('keeps pending sends isolated to their own thread while switching between threads', async () => {
    const transcripts: Record<string, ThreadTranscript> = {
      'thread-a': {
        threadId: 'thread-a',
        activeTurnId: null,
        sendState: { canSend: true, reason: 'ready', label: 'Ready' },
        messages: [
          {
            id: 'a-user-1',
            role: 'user',
            kind: 'message',
            text: 'Old A question',
            createdAt: '2026-04-25T16:14:00Z'
          },
          {
            id: 'a-assistant-1',
            role: 'assistant',
            kind: 'message',
            text: 'Old A answer',
            createdAt: '2026-04-25T16:15:00Z'
          }
        ]
      },
      'thread-b': {
        threadId: 'thread-b',
        activeTurnId: null,
        sendState: { canSend: true, reason: 'ready', label: 'Ready' },
        messages: [
          {
            id: 'b-user-1',
            role: 'user',
            kind: 'message',
            text: 'Old B question',
            createdAt: '2026-04-25T16:16:00Z'
          },
          {
            id: 'b-assistant-1',
            role: 'assistant',
            kind: 'message',
            text: 'Old B answer',
            createdAt: '2026-04-25T16:17:00Z'
          }
        ]
      }
    };
    const fetchTranscript = vi.fn(async (threadId: string) => transcripts[threadId]!);
    const sendMessage = vi.fn(
      () =>
        new Promise<{
          ok: true;
          mode: 'start';
          turnId: string;
          transcript: ThreadTranscript;
        }>(() => undefined)
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
            threadId: 'thread-a',
            title: 'Thread A',
            workspace: 'CodexPulse',
            status: 'idle',
            lastActivityAt: '2026-04-25T16:15:00Z',
            lastTurnSummary: ''
          },
          {
            threadId: 'thread-b',
            title: 'Thread B',
            workspace: 'CodexPulse',
            status: 'idle',
            lastActivityAt: '2026-04-25T16:17:00Z',
            lastTurnSummary: ''
          }
        ]}
        fetchTranscript={fetchTranscript}
        sendMessage={sendMessage}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Open chat for Thread A/ }));
    expect(await screen.findByText('Old A answer')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'Pending only in A' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Pending only in A')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    fireEvent.click(screen.getByRole('button', { name: /Open chat for Thread B/ }));
    expect(await screen.findByText('Old B answer')).toBeInTheDocument();
    expect(screen.queryByText('Pending only in A')).not.toBeInTheDocument();
    expect(screen.queryByText('Sending to Codex...')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    fireEvent.click(screen.getByRole('button', { name: /Open chat for Thread A/ }));
    expect(await screen.findByText('Pending only in A')).toBeInTheDocument();
  });

  it('keeps warm cached messages visible when a transcript refresh times out', async () => {
    const warmTranscript: ThreadTranscript = {
      threadId: 'thread-warm',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: [
        {
          id: 'warm-user',
          role: 'user',
          kind: 'message',
          text: 'Warm cached question',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'warm-assistant',
          role: 'assistant',
          kind: 'message',
          text: 'Warm cached answer',
          createdAt: '2026-04-25T16:15:00Z'
        }
      ]
    };

    render(
      <ThreadView
        thread={{
          threadId: 'thread-warm',
          title: 'Warm thread',
          workspace: 'CodexPulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:15:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={warmTranscript}
        fetchTranscript={vi.fn(async () => {
          throw new TranscriptFetchTimeoutError();
        })}
      />
    );

    expect(await screen.findByText('Warm cached question')).toBeInTheDocument();
    expect(screen.getByText('Warm cached answer')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Conversation is taking too long to load. Try again.')).not.toBeInTheDocument();
    });
  });

  it('does not place old unseen tool calls under a new pending message', async () => {
    const baseTranscript: ThreadTranscript = {
      threadId: 'thread-stale-tools',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: [
        {
          id: 'old-user',
          role: 'user',
          kind: 'message',
          text: 'Old question',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'old-answer',
          role: 'assistant',
          kind: 'message',
          text: 'Old answer',
          createdAt: '2026-04-25T16:15:00Z'
        }
      ]
    };
    const staleTranscript: ThreadTranscript = {
      ...baseTranscript,
      messages: [
        ...baseTranscript.messages,
        {
          id: 'old-unseen-tool',
          role: 'activity',
          kind: 'tool',
          text: 'browser.screenshot completed from old turn',
          createdAt: '2026-04-25T16:14:20Z'
        }
      ]
    };
    const sendMessage = vi.fn(
      () =>
        new Promise<{
          ok: true;
          mode: 'start';
          turnId: string;
          transcript: ThreadTranscript;
        }>(() => undefined)
    );

    const { rerender } = render(
      <ThreadView
        thread={{
          threadId: 'thread-stale-tools',
          title: 'Stale tools',
          workspace: 'CodexPulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:15:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={baseTranscript}
        sendMessage={sendMessage}
      />
    );

    fireEvent.change(screen.getByLabelText('Message Codex'), {
      target: { value: 'New pending message' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('New pending message')).toBeInTheDocument();

    rerender(
      <ThreadView
        thread={{
          threadId: 'thread-stale-tools',
          title: 'Stale tools',
          workspace: 'CodexPulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:15:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={staleTranscript}
        sendMessage={sendMessage}
      />
    );

    await waitFor(() => expect(screen.getByText('New pending message')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /browser.screenshot completed from old turn/ })).not.toBeInTheDocument();
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
      activeTurnId: 'mirror-streaming:running-1',
      sendState: {
        canSend: false,
        reason: 'thread_changed',
        label: 'Codex is working'
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
    expect(workToggle).toHaveClass('is-live');
    expect(workToggle.closest('.codex-activity-group')).toHaveClass('is-live');
    expect(screen.queryByText('Codex is working')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /browser.screenshot completed/ })).toBeInTheDocument();
  });

  it('keeps live Claude updates inside shared progress until the final answer arrives', () => {
    const transcript: ThreadTranscript = {
      threadId: 'claude-code:thread-live',
      provider: 'claude-code',
      activeTurnId: 'claude-turn-live',
      sendState: {
        canSend: false,
        reason: 'thread_changed',
        label: 'Claude is working'
      },
      messages: [
        {
          id: 'user-1',
          role: 'user',
          kind: 'message',
          text: 'Fix the streaming order.',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'assistant-progress-1',
          role: 'assistant',
          kind: 'message',
          text: 'I am tracing the Claude stream now.',
          createdAt: '2026-04-25T16:14:05Z',
          phase: 'commentary'
        } as ThreadTranscript['messages'][number],
        {
          id: 'tool-1',
          role: 'activity',
          kind: 'tool',
          text: 'Bash\n{"command":"pwd"}',
          createdAt: '2026-04-25T16:14:10Z'
        }
      ]
    };

    const { container } = render(
      <ThreadView
        thread={{
          threadId: 'claude-code:thread-live',
          provider: 'claude-code',
          title: 'Claude streaming',
          workspace: 'CodexPulse',
          status: 'running',
          lastActivityAt: '2026-04-25T16:14:10Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
      />
    );

    const workToggle = screen.getByRole('button', { name: /Used 1 tool/ });
    expect(workToggle).toHaveClass('is-live');
    expect(workToggle.closest('.codex-activity-group')).toHaveClass('is-live');
    expect(screen.getByRole('button', { name: /I am tracing the Claude stream now\./ })).toBeInTheDocument();
    expect(container.querySelector('.codex-message--assistant')).toBeNull();
  });

  it('explains that Copilot handoffs start a local Copilot CLI chat', () => {
    const transcript: ThreadTranscript = {
      threadId: 'codex-thread-handoff',
      provider: 'codex',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: []
    };

    render(
      <ThreadView
        thread={{
          threadId: 'codex-thread-handoff',
          provider: 'codex',
          title: 'Handoff target note',
          workspace: 'CodexPulse',
          status: 'idle',
          lastActivityAt: '2026-05-03T10:00:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
        onCreateHandoffSummaryDraft={vi.fn(async () => ({
          sourceThreadId: 'codex-thread-handoff',
          sourceProvider: 'codex' as const,
          targetProvider: 'claude-code' as const,
          workspace: 'CodexPulse',
          userInstruction: 'Investigate the failing handoff.',
          summary: 'Summary',
          prompt: 'Prompt',
          evidence: {
            filesMentioned: [],
            messageCount: 0
          }
        }))}
        onSendHandoff={vi.fn(async () => ({
          handoffId: 'handoff-1',
          sourceThreadId: 'codex-thread-handoff',
          sourceProvider: 'codex' as const,
          targetProvider: 'claude-code' as const,
          targetThreadId: 'claude-code:thread-1',
          targetTitle: 'Claude thread',
          status: 'starting' as const,
          latestProgressSummary: 'Starting handoff.',
          lastActivityAt: '2026-05-03T10:00:00Z',
          blockers: [],
          workspace: 'CodexPulse',
          userInstruction: 'Investigate the failing handoff.',
          summary: 'Summary',
          prompt: 'Prompt',
          createdAt: '2026-05-03T10:00:00Z',
          updatedAt: '2026-05-03T10:00:00Z'
        }))}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open thread actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hand off this task' }));
    fireEvent.change(screen.getByLabelText('Target agent'), {
      target: { value: 'copilot' }
    });

    expect(
      screen.getByText(
        'This starts a GitHub Copilot CLI chat. If Copilot later delegates work to its own cloud flow, that happens inside Copilot, not through a separate Agent Pulse target.'
      )
    ).toBeInTheDocument();
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

    const { container } = render(
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
    const summary = screen.getByRole('button', { name: /Explored the workspace, ran 4 searches/ });
    expect(summary).toBeInTheDocument();
    expect(screen.queryByText(/web_search completed/)).not.toBeInTheDocument();

    const renderedOrder = Array.from(
      container.querySelectorAll('.codex-message--user, .codex-activity-group, .codex-message--assistant')
    ).map((node) =>
      node.classList.contains('codex-message--user')
        ? 'user'
        : node.classList.contains('codex-activity-group')
          ? 'activity'
          : 'assistant'
    );
    expect(renderedOrder).toEqual(['user', 'activity', 'assistant']);

    fireEvent.click(summary);
    expect(screen.getByRole('button', { name: /rg -n "streaming" Sources/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /web_search completed/ })).toHaveLength(4);
    fireEvent.click(summary);
    expect(screen.queryByText(/web_search completed/)).not.toBeInTheDocument();
  });

  it('keeps Codex file changes attached to the agent response that made them', () => {
    const transcript: ThreadTranscript = {
      threadId: 'codex-file-thread',
      provider: 'codex',
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
          text: 'First change',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'file-change-1',
          role: 'activity',
          kind: 'file',
          text: 'File change completed',
          createdAt: '2026-04-25T16:14:10Z'
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'First answer.',
          createdAt: '2026-04-25T16:14:20Z',
          phase: 'final_answer'
        } as ThreadTranscript['messages'][number],
        {
          id: 'user-2',
          role: 'user',
          kind: 'message',
          text: 'Second change',
          createdAt: '2026-04-25T16:15:00Z'
        },
        {
          id: 'file-change-2',
          role: 'activity',
          kind: 'file',
          text: 'File change completed',
          createdAt: '2026-04-25T16:15:10Z'
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          kind: 'message',
          text: 'Second answer.',
          createdAt: '2026-04-25T16:15:20Z',
          phase: 'final_answer'
        } as ThreadTranscript['messages'][number]
      ],
      fileChanges: [
        {
          id: 'turn-1:file-change-1',
          threadId: 'codex-file-thread',
          turnId: 'turn-1',
          itemId: 'file-change-1',
          fileCount: 1,
          linesAdded: 4,
          linesDeleted: 1,
          files: [{ path: 'apps/tablet/src/First.tsx', linesAdded: 4, linesDeleted: 1 }],
          action: 'undo',
          canUseCodexApplyPatch: true
        },
        {
          id: 'turn-2:file-change-2',
          threadId: 'codex-file-thread',
          turnId: 'turn-2',
          itemId: 'file-change-2',
          fileCount: 1,
          linesAdded: 2,
          linesDeleted: 0,
          files: [{ path: 'apps/tablet/src/Second.tsx', linesAdded: 2, linesDeleted: 0 }],
          action: 'undo',
          canUseCodexApplyPatch: true
        }
      ]
    };

    const { container } = render(
      <ThreadView
        thread={{
          threadId: 'codex-file-thread',
          provider: 'codex',
          title: 'File changes',
          workspace: 'CodexPulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:15:20Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
      />
    );

    const renderedOrder = Array.from(
      container.querySelectorAll(
        '.codex-message--user, .codex-activity-group, .codex-message--assistant, .codex-file-change-stack'
      )
    ).map((node) =>
      node.classList.contains('codex-message--user')
        ? 'user'
        : node.classList.contains('codex-activity-group')
          ? 'activity'
          : node.classList.contains('codex-message--assistant')
            ? 'assistant'
            : 'files'
    );
    expect(renderedOrder).toEqual([
      'user',
      'activity',
      'assistant',
      'files',
      'user',
      'activity',
      'assistant',
      'files'
    ]);
    expect(screen.getByText('apps/tablet/src/First.tsx')).toBeInTheDocument();
    expect(screen.getByText('apps/tablet/src/Second.tsx')).toBeInTheDocument();

    fireEvent.click(screen.getAllByLabelText('Hide file changes')[0]!);
    expect(screen.queryByText('apps/tablet/src/First.tsx')).not.toBeInTheDocument();
    expect(screen.getByText('apps/tablet/src/Second.tsx')).toBeInTheDocument();
  });

  it('matches Codex file changes by turn id when item ids differ', () => {
    const transcript: ThreadTranscript = {
      threadId: 'codex-turn-file-thread',
      provider: 'codex',
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
          text: 'Make a change',
          turnId: 'turn-real',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'file-message-real',
          role: 'activity',
          kind: 'file',
          text: 'File change completed',
          turnId: 'turn-real',
          createdAt: '2026-04-25T16:14:10Z'
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'Changed it.',
          turnId: 'turn-real',
          createdAt: '2026-04-25T16:14:20Z',
          phase: 'final_answer'
        } as ThreadTranscript['messages'][number]
      ],
      fileChanges: [
        {
          id: 'turn-real:patch-object-id',
          threadId: 'codex-turn-file-thread',
          turnId: 'turn-real',
          itemId: 'patch-object-id',
          fileCount: 1,
          linesAdded: 1,
          linesDeleted: 0,
          files: [{ path: 'apps/tablet/src/TurnMatch.tsx', linesAdded: 1, linesDeleted: 0 }],
          action: 'undo',
          canUseCodexApplyPatch: true
        }
      ]
    };

    render(
      <ThreadView
        thread={{
          threadId: 'codex-turn-file-thread',
          provider: 'codex',
          title: 'Turn file changes',
          workspace: 'CodexPulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:14:20Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
      />
    );

    expect(screen.getByText('apps/tablet/src/TurnMatch.tsx')).toBeInTheDocument();
  });

  it('shows only collapse and Codex undo actions on file-change cards', async () => {
    const transcript: ThreadTranscript = {
      threadId: 'codex-undo-file-thread',
      provider: 'codex',
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
          text: 'Make a change',
          turnId: 'turn-1',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'file-change-1',
          role: 'activity',
          kind: 'file',
          text: 'File change completed',
          turnId: 'turn-1',
          createdAt: '2026-04-25T16:14:10Z'
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'Changed it.',
          turnId: 'turn-1',
          createdAt: '2026-04-25T16:14:20Z',
          phase: 'final_answer'
        } as ThreadTranscript['messages'][number]
      ],
      fileChanges: [
        {
          id: 'turn-1:file-change-1',
          threadId: 'codex-undo-file-thread',
          turnId: 'turn-1',
          itemId: 'file-change-1',
          fileCount: 1,
          linesAdded: 1,
          linesDeleted: 0,
          files: [{ path: 'apps/tablet/src/UndoOnly.tsx', linesAdded: 1, linesDeleted: 0 }],
          action: 'undo',
          canUseCodexApplyPatch: true
        }
      ]
    };
    const applyFileChangeAction = vi.fn(async () => undefined);
    const openThreadInCodex = vi.fn(async () => undefined);

    render(
      <ThreadView
        thread={{
          threadId: 'codex-undo-file-thread',
          provider: 'codex',
          title: 'Undo file changes',
          workspace: 'CodexPulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:14:20Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
        onApplyFileChangeAction={applyFileChangeAction}
        openThreadInCodex={openThreadInCodex}
      />
    );

    expect(screen.getByRole('button', { name: 'Hide file changes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(applyFileChangeAction).toHaveBeenCalledWith('turn-1:file-change-1', 'undo')
    );
    expect(openThreadInCodex).not.toHaveBeenCalled();
  });

  it('keeps leading live activity attached to the first visible user message', () => {
    const transcript: ThreadTranscript = {
      threadId: 'copilot:thread-live',
      provider: 'copilot',
      activeTurnId: 'copilot-turn-live',
      sendState: {
        canSend: false,
        reason: 'thread_changed',
        label: 'Copilot is working'
      },
      messages: [
        {
          id: 'search-1',
          role: 'activity',
          kind: 'tool',
          text: 'web_search completed',
          createdAt: '2026-04-25T16:14:05Z'
        },
        {
          id: 'assistant-draft',
          role: 'assistant',
          kind: 'message',
          text: 'I found a possible source.',
          createdAt: '2026-04-25T16:14:10Z'
        },
        {
          id: 'user-1',
          role: 'user',
          kind: 'message',
          text: 'Can you check this?',
          createdAt: '2026-04-25T16:14:00Z'
        },
        {
          id: 'browser-1',
          role: 'activity',
          kind: 'tool',
          text: 'browser.open completed',
          createdAt: '2026-04-25T16:14:12Z'
        }
      ]
    };

    const { container } = render(
      <ThreadView
        thread={{
          threadId: 'copilot:thread-live',
          provider: 'copilot',
          title: 'New Copilot chat',
          workspace: 'CodexPulse',
          status: 'running',
          lastActivityAt: '2026-04-25T16:14:12Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
      />
    );

    expect(screen.getByText('Can you check this?')).toBeInTheDocument();
    expect(screen.getByText('I found a possible source.')).toBeInTheDocument();
    expect(container.querySelector('.codex-message--assistant')).toBeNull();

    const renderedOrder = Array.from(
      container.querySelectorAll('.codex-message--user, .codex-activity-group, .codex-message--assistant')
    ).map((node) =>
      node.classList.contains('codex-message--user')
        ? 'user'
        : node.classList.contains('codex-activity-group')
          ? 'activity'
          : 'assistant'
    );
    expect(renderedOrder).toEqual(['user', 'activity']);
  });

  it('keeps activity provider colors and assistant icons for Codex, Claude, and Copilot', () => {
    const cases = [
      { provider: 'codex' as const, tone: 'codex', avatar: '.codex-mark' },
      { provider: 'claude-code' as const, tone: 'claude-code', avatar: '.claude-mark' },
      { provider: 'copilot' as const, tone: 'copilot', avatar: '.copilot-mark' }
    ];

    for (const item of cases) {
      const transcript: ThreadTranscript = {
        threadId: `${item.provider}:thread-provider`,
        provider: item.provider,
        activeTurnId: null,
        sendState: { canSend: true, reason: 'ready', label: 'Ready' },
        messages: [
          {
            id: `user-${item.provider}`,
            role: 'user',
            kind: 'message',
            text: 'Check provider styling.',
            createdAt: '2026-04-25T16:14:00Z'
          },
          {
            id: `tool-${item.provider}`,
            role: 'activity',
            kind: 'tool',
            text: 'Bash pwd',
            createdAt: '2026-04-25T16:14:04Z'
          },
          {
            id: `assistant-${item.provider}`,
            role: 'assistant',
            kind: 'message',
            text: 'Provider reply.',
            createdAt: '2026-04-25T16:15:00Z',
            phase: 'final_answer'
          }
        ]
      };

      const { container, unmount } = render(
        <ThreadView
          thread={{
            threadId: `${item.provider}:thread-provider`,
            provider: item.provider,
            title: 'Provider thread',
            workspace: 'Agent Pulse',
            status: 'idle',
            lastActivityAt: '2026-04-25T16:15:00Z',
            lastTurnSummary: ''
          }}
          liveTranscript={transcript}
        />
      );

      expect(container.querySelector(`.codex-activity-group.provider-${item.tone}`)).not.toBeNull();
      expect(
        container.querySelector(`.codex-message-avatar.provider-${item.tone} ${item.avatar}`)
      ).not.toBeNull();
      unmount();
    }
  });

  it('uses the Claude avatar for Claude assistant replies', () => {
    const transcript: ThreadTranscript = {
      threadId: 'claude-code:thread-avatar',
      provider: 'claude-code',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          text: 'Claude reply.',
          createdAt: '2026-04-25T16:15:00Z'
        }
      ]
    };

    const { container } = render(
      <ThreadView
        thread={{
          threadId: 'claude-code:thread-avatar',
          provider: 'claude-code',
          title: 'Claude thread',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:15:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
      />
    );

    expect(container.querySelector('.codex-message-avatar.provider-claude-code .claude-mark')).not.toBeNull();
    expect(container.querySelector('.codex-message-avatar.provider-claude-code .codex-mark')).toBeNull();
  });

  it('hides Codex plugins, skills, and slash commands in the Claude composer', () => {
    const transcript: ThreadTranscript = {
      threadId: 'claude-code:thread-composer',
      provider: 'claude-code',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: []
    };

    render(
      <ThreadView
        thread={{
          threadId: 'claude-code:thread-composer',
          provider: 'claude-code',
          title: 'Claude thread',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:15:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
        plugins={[
          {
            slug: 'browser-use',
            marketplace: 'openai-bundled',
            qualifiedSlug: 'browser-use@openai-bundled',
            displayName: 'Browser Use',
            shortDescription: 'Open Codex browser pages.',
            enabled: true
          }
        ]}
        skills={[
          {
            slug: 'browser',
            name: 'Browser',
            description: 'Browser skill',
            source: 'user'
          }
        ]}
        commands={[
          {
            slug: 'compact',
            name: 'compact',
            description: 'Compact the Codex context.',
            builtIn: true
          }
        ]}
      />
    );

    const input = screen.getByPlaceholderText('Ask Claude anything');

    fireEvent.change(input, { target: { value: '/', selectionStart: 1 } });
    fireEvent.keyUp(input, { key: '/' });
    expect(screen.queryByText('/compact')).not.toBeInTheDocument();
    expect(screen.queryByText('No matching commands.')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '@browser', selectionStart: 8 } });
    fireEvent.keyUp(input, { key: 'r' });
    expect(screen.queryByText('Browser Use')).not.toBeInTheDocument();
    expect(screen.queryByText('Browser')).not.toBeInTheDocument();
  });

  it('allows deleting a Claude thread from the thread header', async () => {
    const deleteThread = vi.fn(async () => undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const transcript: ThreadTranscript = {
      threadId: 'claude-code:thread-delete',
      provider: 'claude-code',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: []
    };

    render(
      <ThreadView
        thread={{
          threadId: 'claude-code:thread-delete',
          provider: 'claude-code',
          title: 'Claude thread',
          workspace: 'Agent Pulse',
          status: 'idle',
          lastActivityAt: '2026-04-25T16:15:00Z',
          lastTurnSummary: ''
        }}
        liveTranscript={transcript}
        deleteThread={deleteThread}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open thread actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete thread' }));

    await waitFor(() => expect(deleteThread).toHaveBeenCalledWith('claude-code:thread-delete'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/local Claude history/i));
  });

  it('uses shared chats by default before creating a new Codex thread', async () => {
    const newThread = {
      threadId: 'thread-new',
      title: 'New thread',
      workspace: 'Chats',
      workspaceKind: 'chat' as const,
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

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    const dialog = await screen.findByRole('dialog', { name: 'New chat' });
    expect(within(dialog).getByText('Start a new chat')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Chats' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start chat' }));

    await waitFor(() =>
      expect(onNewThread).toHaveBeenCalledWith({
        location: 'chat',
        provider: 'codex'
      })
    );
    expect(await screen.findByTestId('thread-chat-drawer')).toBeInTheDocument();
  });

  it('can still create a new Codex thread in a selected project', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    const dialog = await screen.findByRole('dialog', { name: 'New chat' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Project folder' }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Project' }), {
      target: { value: 'project-codexpulse' }
    });
    expect(within(dialog).queryByLabelText('Folder path')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start chat' }));

    await waitFor(() =>
      expect(onNewThread).toHaveBeenCalledWith({
        projectId: 'project-codexpulse',
        provider: 'codex'
      })
    );
    expect(await screen.findByTestId('thread-chat-drawer')).toBeInTheDocument();
  });

  it('lets a new thread choose any enabled agent and only that agent model', async () => {
    const newThread = {
      threadId: 'claude-code:thread-new',
      provider: 'claude-code' as const,
      title: 'New Claude thread',
      workspace: 'OpenAssist',
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
            path: '/Users/me/projects/OpenAssist',
            providers: ['claude-code']
          }
        ]}
        models={[
          {
            slug: 'gpt-5.5',
            displayName: 'GPT-5.5',
            provider: 'codex'
          },
          {
            slug: 'sonnet',
            displayName: 'Claude Sonnet',
            provider: 'claude-code'
          }
        ]}
        onNewThread={onNewThread}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'New chat in OpenAssist' }));

    const dialog = await screen.findByRole('dialog', { name: 'New chat' });
    expect(within(dialog).getByRole('combobox', { name: 'Project' })).toHaveValue('project-openassist');
    expect(within(dialog).getByRole('radio', { name: 'Codex' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Claude' }));

    const modelSelect = within(dialog).getByRole('combobox', { name: 'Model' });
    expect(within(modelSelect).queryByRole('option', { name: 'GPT-5.5' })).not.toBeInTheDocument();
    expect(within(modelSelect).getByRole('option', { name: 'Claude Sonnet' })).toBeInTheDocument();

    fireEvent.change(modelSelect, { target: { value: 'sonnet' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start chat' }));

    await waitFor(() =>
      expect(onNewThread).toHaveBeenCalledWith({
        projectId: 'project-openassist',
        provider: 'claude-code',
        modelSlug: 'sonnet'
      })
    );
  });

  it('removes an empty newly-created draft thread when closing it', async () => {
    const newThread = {
      threadId: 'thread-new-empty',
      provider: 'codex' as const,
      title: 'New thread',
      workspace: 'CodexPulse',
      status: 'idle' as const,
      lastActivityAt: '2026-04-26T10:00:00Z',
      lastTurnSummary: ''
    };
    const onNewThread = vi.fn(async () => newThread);
    const onDeleteThread = vi.fn(async () => undefined);

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
            projectId: 'project-codexpulse',
            name: 'CodexPulse',
            path: '/Users/me/projects/CodexPulse'
          }
        ]}
        transcriptUpdates={{
          'thread-new-empty': {
            threadId: 'thread-new-empty',
            provider: 'codex',
            activeTurnId: null,
            sendState: { canSend: true, reason: 'ready', label: 'Ready' },
            messages: []
          }
        }}
        onNewThread={onNewThread}
        onDeleteThread={onDeleteThread}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    const dialog = await screen.findByRole('dialog', { name: 'New chat' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start chat' }));

    expect(await screen.findByTestId('thread-chat-drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close thread chat' }));

    await waitFor(() => expect(onDeleteThread).toHaveBeenCalledWith('thread-new-empty'));
    expect(screen.queryByRole('button', { name: /Open chat for New thread/ })).not.toBeInTheDocument();
  });

  it('starts a shared chat even when no saved projects are listed', async () => {
    const newThread = {
      threadId: 'thread-new',
      title: 'New thread',
      workspace: 'Chats',
      workspaceKind: 'chat' as const,
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

    const newThreadButton = screen.getByRole('button', { name: 'New chat' });
    expect(newThreadButton).not.toBeDisabled();
    fireEvent.click(newThreadButton);

    const dialog = await screen.findByRole('dialog', { name: 'New chat' });
    expect(within(dialog).getByRole('radio', { name: 'Project folder' })).toBeDisabled();
    expect(within(dialog).queryByLabelText('Folder path')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Start chat' })).not.toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start chat' }));

    await waitFor(() =>
      expect(onNewThread).toHaveBeenCalledWith({
        location: 'chat',
        provider: 'codex'
      })
    );
  });
});
