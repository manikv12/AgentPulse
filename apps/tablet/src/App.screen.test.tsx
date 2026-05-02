// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

type MockWebSocketInstance = {
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: (() => void) | null;
  onopen: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
};

const sockets: MockWebSocketInstance[] = [];

describe('App screen routing', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    sockets.length = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps settings open when a background live socket closes', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'token-1234567890',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );
    sessionStorage.setItem('agent-pulse-admin-token', 'admin-token');
    window.location.hash = '#/settings';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return jsonResponse({
            status: 'ok',
            codexAppServer: 'connected',
            version: '0.1.0',
            uptimeSec: 60
          });
        }

        if (url === '/threads/list') {
          return jsonResponse({ threads: [] });
        }

        if (url === '/projects/list') {
          return jsonResponse({ projects: [] });
        }

        if (url === '/settings/get') {
          return jsonResponse({
            settings: {
              port: 5173,
              lanEnabled: false,
              mobileSendEnabled: false
            },
            devices: []
          });
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    vi.stubGlobal('WebSocket', createMockWebSocket());

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Agent Pulse settings' })).toBeInTheDocument();

    act(() => {
      sockets[0]?.onclose?.();
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Agent Pulse settings' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Helper offline' })).not.toBeInTheDocument();
  });

  it('keeps the dashboard open and reconnects when the live socket closes', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'token-1234567890',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return jsonResponse({
            status: 'ok',
            codexAppServer: 'connected',
            version: '0.1.0',
            uptimeSec: 60
          });
        }

        if (url === '/threads/list') {
          return jsonResponse({ threads: [] });
        }

        if (url === '/projects/list') {
          return jsonResponse({ projects: [] });
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    vi.stubGlobal('WebSocket', createMockWebSocket());

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Agent Pulse' })).toBeInTheDocument();
    expect(sockets.length).toBe(1);
    vi.useFakeTimers();

    act(() => {
      sockets[0]?.onclose?.();
    });

    expect(screen.queryByRole('heading', { name: 'Helper offline' })).not.toBeInTheDocument();
    expect(screen.getByText('Reconnecting to helper...')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(sockets.length).toBe(2);
  });

  it('returns to admin login instead of dashboard when the saved admin token expires', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'token-1234567890',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );
    sessionStorage.setItem('agent-pulse-admin-token', 'expired-admin-token');
    window.location.hash = '#/settings';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return jsonResponse({
            status: 'ok',
            codexAppServer: 'connected',
            version: '0.1.0',
            uptimeSec: 60
          });
        }

        if (url === '/threads/list') {
          return jsonResponse({
            threads: [
              {
                threadId: 'thread-openassist',
                title: 'OpenAssist work',
                workspace: 'OpenAssist',
                status: 'idle',
                lastActivityAt: '2026-04-26T10:00:00Z',
                lastTurnSummary: ''
              }
            ]
          });
        }

        if (url === '/projects/list') {
          return jsonResponse({ projects: [] });
        }

        if (url === '/settings/get') {
          return new Response(JSON.stringify({ error: 'admin token expired' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    vi.stubGlobal('WebSocket', createMockWebSocket());

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Enter passcode' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Agent Pulse' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem('agent-pulse-admin-token')).toBeNull();
  });

  it('keeps settings open when the device session expires in the background', async () => {
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

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return jsonResponse({
            status: 'ok',
            codexAppServer: 'connected',
            version: '0.1.0',
            uptimeSec: 60
          });
        }

        if (url === '/threads/list') {
          return new Response(JSON.stringify({ error: 'invalid' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        }

        if (url === '/device/session/recover') {
          return new Response(JSON.stringify({ error: 'invalid' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        }

        if (url === '/settings/get') {
          return jsonResponse({
            settings: {
              port: 61482,
              lanEnabled: false,
              mobileSendEnabled: false
            },
            devices: []
          });
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    vi.stubGlobal('WebSocket', createMockWebSocket());

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Agent Pulse settings' })).toBeInTheDocument();
    await waitFor(() => {
      expect(localStorage.getItem('agent-pulse-session')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Agent Pulse settings' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'How will you use this?' })).not.toBeInTheDocument();
  });

  it('keeps settings in the URL when settings is opened from the thread dashboard', async () => {
    localStorage.setItem(
      'agent-pulse-session',
      JSON.stringify({
        token: 'token-1234567890',
        deviceId: 'device-1',
        fingerprint: 'browser-fingerprint',
        deviceName: 'Desk tablet'
      })
    );
    sessionStorage.setItem('agent-pulse-admin-token', 'admin-token');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return jsonResponse({
            status: 'ok',
            codexAppServer: 'connected',
            version: '0.1.0',
            uptimeSec: 60
          });
        }

        if (url === '/threads/list') {
          return jsonResponse({
            threads: [
              {
                threadId: 'thread-openassist',
                title: 'OpenAssist work',
                workspace: 'OpenAssist',
                status: 'idle',
                lastActivityAt: '2026-04-26T10:00:00Z',
                lastTurnSummary: ''
              }
            ]
          });
        }

        if (url === '/projects/list') {
          return jsonResponse({ projects: [] });
        }

        if (url === '/settings/get') {
          return jsonResponse({
            settings: {
              port: 61482,
              lanEnabled: true,
              mobileSendEnabled: true
            },
            devices: []
          });
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    vi.stubGlobal('WebSocket', createMockWebSocket());

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Agent Pulse' })).toBeInTheDocument();
    const settingsButtons = screen.getAllByRole('button', { name: 'Open settings' });

    act(() => {
      settingsButtons[0]?.click();
    });

    expect(await screen.findByRole('heading', { name: 'Agent Pulse settings' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings');
  });

  it('opens admin login when the URL changes to settings without a saved admin token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/health/get') {
          return jsonResponse({
            status: 'ok',
            codexAppServer: 'connected',
            version: '0.1.0',
            uptimeSec: 60
          });
        }

        if (url === '/pairing/devices') {
          return jsonResponse({ devices: [] });
        }

        throw new Error(`Unexpected URL ${url}`);
      })
    );

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'How will you use this?' })).toBeInTheDocument();

    act(() => {
      window.location.hash = '#/settings';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(await screen.findByRole('heading', { name: 'Enter passcode' })).toBeInTheDocument();
  });
});

function createMockWebSocket() {
  return class MockWebSocket {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onopen: (() => void) | null = null;
    close = vi.fn();

    constructor() {
      sockets.push(this);
    }
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body
  } as Response;
}
