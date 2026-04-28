import { describe, expect, it, vi } from 'vitest';
import type { ThreadTranscript } from '@agent-pulse/shared';
import { createCodexMirror } from './codex-mirror';
import { SendBlockedError } from './app-server-chat';
import type { IpcClient } from './ipc-client';

type MockBroadcastHandler = (event: { method: string; sourceClientId: string; params: unknown; type: 'broadcast'; version: number }) => void | Promise<void>;

function createMockIpc(): {
  ipc: IpcClient;
  emitBroadcast(method: string, params: unknown, sourceClientId?: string): void;
  setReady(ready: boolean): void;
  sendRequest: ReturnType<typeof vi.fn>;
} {
  let ready = false;
  const broadcastHandlers = new Map<string, MockBroadcastHandler>();
  const anyHandlers = new Set<MockBroadcastHandler>();
  const sendRequest = vi.fn(async () => ({ result: { turn: { id: 'turn-1' } } }));

  const ipc: IpcClient = {
    connect: vi.fn(),
    dispose: vi.fn(),
    isReady: () => ready,
    getClientId: () => (ready ? 'client-x' : undefined),
    sendRequest: sendRequest as unknown as IpcClient['sendRequest'],
    sendBroadcast: vi.fn(),
    addBroadcastHandler(method, handler) {
      broadcastHandlers.set(method, handler);
      return () => {
        if (broadcastHandlers.get(method) === handler) {
          broadcastHandlers.delete(method);
        }
      };
    },
    addAnyBroadcastHandler(handler) {
      anyHandlers.add(handler);
      return () => {
        anyHandlers.delete(handler);
      };
    },
    addRequestHandler: vi.fn(() => () => undefined)
  };

  return {
    ipc,
    sendRequest,
    emitBroadcast(method, params, sourceClientId = 'desktop') {
      const event = { method, sourceClientId, params, type: 'broadcast' as const, version: 0 };
      const dedicated = broadcastHandlers.get(method);
      if (dedicated) {
        void dedicated(event);
      }
      for (const handler of anyHandlers) {
        void handler(event);
      }
    },
    setReady(value) {
      ready = value;
    }
  };
}

const transcriptStub: ThreadTranscript = {
  threadId: 'thread-1',
  activeTurnId: null,
  sendState: { canSend: true, reason: 'ready', label: 'Ready' },
  messages: []
};

describe('codex mirror', () => {
  it('sends thread-follower-start-turn when no streaming state is known', async () => {
    const { ipc, sendRequest, setReady } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    sendRequest.mockResolvedValueOnce({ result: { turn: { id: 'turn-99' } } });

    const response = await mirror.sendMessage('thread-1', 'hello from phone');
    expect(response.mode).toBe('start');
    expect(response.turnId).toBe('turn-99');
    expect(sendRequest).toHaveBeenCalledWith('thread-follower-start-turn', {
      conversationId: 'thread-1',
      turnStartParams: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'hello from phone', text_elements: [] }]
      }
    });
    expect(reader.readTranscript).toHaveBeenCalledWith('thread-1');
    mirror.dispose();
  });

  it('switches to thread-follower-steer-turn when the thread is currently streaming', async () => {
    const { ipc, sendRequest, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-1',
      change: { isStreaming: true }
    });

    sendRequest.mockResolvedValueOnce({ result: { turn: { id: 'steer-turn-7' } } });

    const response = await mirror.sendMessage('thread-1', 'follow up');
    expect(response.mode).toBe('steer');
    expect(response.turnId).toBe('steer-turn-7');
    expect(sendRequest).toHaveBeenCalledWith('thread-follower-steer-turn', {
      conversationId: 'thread-1',
      input: [{ type: 'text', text: 'follow up', text_elements: [] }],
      attachments: [],
      restoreMessage: null
    });
    mirror.dispose();
  });

  it('falls back to start when streaming flips off via broadcast', async () => {
    const { ipc, sendRequest, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-1',
      change: { isStreaming: true }
    });
    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-1',
      change: { isStreaming: false }
    });

    sendRequest.mockResolvedValueOnce({ result: { turn: { id: 'turn-z' } } });
    const response = await mirror.sendMessage('thread-1', 'next');
    expect(response.mode).toBe('start');
    mirror.dispose();
  });

  it('sends thread-follower-interrupt-turn when stopping the current Codex turn', async () => {
    const { ipc, sendRequest, setReady } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    sendRequest.mockResolvedValueOnce({ result: { ok: true } });

    await (mirror as unknown as { interruptTurn(threadId: string): Promise<void> }).interruptTurn('thread-1');

    expect(sendRequest).toHaveBeenCalledWith('thread-follower-interrupt-turn', {
      conversationId: 'thread-1'
    });
    mirror.dispose();
  });

  it('blocks sending when ipc is not ready', async () => {
    const { ipc, setReady } = createMockIpc();
    setReady(false);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    await expect(mirror.sendMessage('t', 'x')).rejects.toBeInstanceOf(SendBlockedError);
    mirror.dispose();
  });

  it('translates "no-client-found" into a SendBlockedError suggesting the user open Codex', async () => {
    const { ipc, sendRequest, setReady } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    sendRequest.mockRejectedValueOnce(new Error('no-client-found'));

    await expect(mirror.sendMessage('thread-1', 'hi')).rejects.toBeInstanceOf(SendBlockedError);
    mirror.dispose();
  });

  it('forwards every IPC broadcast to onBroadcast', async () => {
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const onBroadcast = vi.fn();
    const mirror = createCodexMirror({ ipc, reader, onBroadcast });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-1',
      change: { isStreaming: true }
    });
    emitBroadcast('thread-queued-followups-changed', { conversationId: 'thread-1', messages: [] });

    expect(onBroadcast).toHaveBeenCalledTimes(2);
    expect(onBroadcast.mock.calls[0][0].method).toBe('thread-stream-state-changed');
    expect(onBroadcast.mock.calls[1][0].method).toBe('thread-queued-followups-changed');
    mirror.dispose();
  });

  it('accepts streamRole broadcasts from any host id', async () => {
    // Regression: Codex windows broadcast with their own connector/host id (a per-session UUID),
    // not the literal 'local'. Filtering by hostId === 'local' silently dropped every ownership
    // flip and made set-model / approvals fail with `client-cannot-handle-request`.
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    expect(mirror.isThreadOwned('thread-7')).toBe(false);

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'da2e8439-8708-491c-afaa-29d95e8724a8', // a real Codex connector id
      conversationId: 'thread-7',
      change: { isStreaming: true, streamRole: { role: 'owner' } }
    });

    expect(mirror.isThreadOwned('thread-7')).toBe(true);
    mirror.dispose();
  });

  it('sends thread-follower-set-model-and-reasoning with {conversationId, model, reasoningEffort}', async () => {
    // Regression test: Codex desktop's IPC handler destructures `{conversationId, model, reasoningEffort}`.
    // If we ever rename the wire keys (e.g. `model -> modelSlug`), the desktop falls back to "Custom".
    const { ipc, setReady, sendRequest } = createMockIpc();
    setReady(true);
    sendRequest.mockResolvedValueOnce({ ok: true });
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    await mirror.setModelAndReasoning('thread-abc', 'gpt-5.5', 'high');

    expect(sendRequest).toHaveBeenCalledWith('thread-follower-set-model-and-reasoning', {
      conversationId: 'thread-abc',
      model: 'gpt-5.5',
      reasoningEffort: 'high'
    });
    mirror.dispose();
  });

  it('omits reasoningEffort when not supplied', async () => {
    const { ipc, setReady, sendRequest } = createMockIpc();
    setReady(true);
    sendRequest.mockResolvedValueOnce({ ok: true });
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    await mirror.setModelAndReasoning('thread-abc', 'gpt-5.5');

    expect(sendRequest).toHaveBeenCalledWith('thread-follower-set-model-and-reasoning', {
      conversationId: 'thread-abc',
      model: 'gpt-5.5'
    });
    mirror.dispose();
  });

  it('tracks ownership from streamRole broadcasts and resolves waitForOwnership', async () => {
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    expect(mirror.isThreadOwned('thread-abc')).toBe(false);

    const waitPromise = mirror.waitForOwnership('thread-abc', 1_000);

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-abc',
      change: { isStreaming: true, streamRole: { role: 'owner' } }
    });

    await expect(waitPromise).resolves.toBe(true);
    expect(mirror.isThreadOwned('thread-abc')).toBe(true);

    // ownership lost when role flips to follower
    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-abc',
      change: { isStreaming: true, streamRole: { role: 'follower' } }
    });
    expect(mirror.isThreadOwned('thread-abc')).toBe(false);

    mirror.dispose();
  });

  it('waitForOwnership resolves false on timeout when ownership never arrives', async () => {
    const { ipc, setReady } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    await expect(mirror.waitForOwnership('thread-never', 50)).resolves.toBe(false);
    mirror.dispose();
  });
});
