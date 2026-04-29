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

  it('derives streaming from Codex desktop snapshot state', async () => {
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const onStreamingChange = vi.fn();
    const mirror = createCodexMirror({ ipc, reader, onStreamingChange });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-snapshot',
      change: {
        type: 'snapshot',
        conversationState: {
          threadRuntimeStatus: { type: 'idle' },
          turns: [
            { status: 'completed', items: [] },
            { status: 'inProgress', items: [{ type: 'commandExecution', status: 'completed' }] }
          ]
        }
      }
    });

    expect(mirror.isThreadStreaming('thread-snapshot')).toBe(true);
    expect(onStreamingChange).toHaveBeenLastCalledWith({
      threadId: 'thread-snapshot',
      isStreaming: true
    });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-snapshot',
      change: {
        type: 'snapshot',
        conversationState: {
          threadRuntimeStatus: { type: 'idle' },
          turns: [
            { status: 'completed', items: [] },
            { status: 'completed', items: [{ type: 'commandExecution', status: 'completed' }] }
          ]
        }
      }
    });

    expect(mirror.isThreadStreaming('thread-snapshot')).toBe(false);
    expect(onStreamingChange).toHaveBeenLastCalledWith({
      threadId: 'thread-snapshot',
      isStreaming: false
    });
    mirror.dispose();
  });

  it('keeps a thread streaming while Codex desktop patches a command as in progress', async () => {
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const onStreamingChange = vi.fn();
    const mirror = createCodexMirror({ ipc, reader, onStreamingChange });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-patches',
      change: {
        type: 'patches',
        patches: [
          {
            op: 'add',
            path: ['turns', 0, 'items', 0],
            value: { id: 'cmd-1', type: 'commandExecution', status: 'inProgress' }
          }
        ]
      }
    });

    expect(mirror.isThreadStreaming('thread-patches')).toBe(true);
    expect(onStreamingChange).toHaveBeenLastCalledWith({
      threadId: 'thread-patches',
      isStreaming: true
    });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-patches',
      change: {
        type: 'patches',
        patches: [
          {
            op: 'replace',
            path: ['turns', 0, 'items', 0, 'status'],
            value: 'completed'
          }
        ]
      }
    });

    expect(mirror.isThreadStreaming('thread-patches')).toBe(false);
    expect(onStreamingChange).toHaveBeenLastCalledWith({
      threadId: 'thread-patches',
      isStreaming: false
    });
    mirror.dispose();
  });

  it('tracks waiting approval from Codex desktop request patches', async () => {
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const onStreamingChange = vi.fn();
    const mirror = createCodexMirror({ ipc, reader, onStreamingChange });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-approval',
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
                reason: 'Allow Codex to use Microsoft Teams?'
              }
            }
          }
        ]
      }
    });

    expect(mirror.isThreadWaitingForApproval('thread-approval')).toBe(true);
    expect(mirror.isThreadStreaming('thread-approval')).toBe(true);

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-approval',
      change: {
        type: 'patches',
        patches: [
          {
            op: 'replace',
            path: ['conversationState', 'requests', 0, 'isCompleted'],
            value: true
          }
        ]
      }
    });

    expect(mirror.isThreadWaitingForApproval('thread-approval')).toBe(false);
    expect(mirror.isThreadStreaming('thread-approval')).toBe(false);
    expect(onStreamingChange).toHaveBeenLastCalledWith({
      threadId: 'thread-approval',
      isStreaming: false
    });
    mirror.dispose();
  });

  it('exposes pending approval payloads via onPendingApprovalsChange and getPendingApprovalRequests', () => {
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const onPendingApprovalsChange = vi.fn();
    const mirror = createCodexMirror({ ipc, reader, onPendingApprovalsChange });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-approval',
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
                turnId: 'turn-7',
                reason: 'Allow Codex to use Microsoft Teams?',
                permissions: { network: { enabled: true } }
              }
            }
          }
        ]
      }
    });

    expect(onPendingApprovalsChange).toHaveBeenCalledWith({
      threadId: 'thread-approval',
      requests: [
        {
          id: 'permission-request-1',
          method: 'item/permissions/requestApproval',
          params: {
            turnId: 'turn-7',
            reason: 'Allow Codex to use Microsoft Teams?',
            permissions: { network: { enabled: true } }
          },
          turnId: 'turn-7'
        }
      ]
    });

    expect(mirror.getPendingApprovalRequests('thread-approval')).toEqual([
      expect.objectContaining({
        id: 'permission-request-1',
        method: 'item/permissions/requestApproval',
        turnId: 'turn-7'
      })
    ]);

    // Once Codex marks the request completed, the helper should fire an empty
    // change and the getter should return [] — that's how the tablet learns
    // to clear the approval card.
    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-approval',
      change: {
        type: 'patches',
        patches: [
          {
            op: 'replace',
            path: ['conversationState', 'requests', 0, 'isCompleted'],
            value: true
          }
        ]
      }
    });

    expect(onPendingApprovalsChange).toHaveBeenLastCalledWith({
      threadId: 'thread-approval',
      requests: []
    });
    expect(mirror.getPendingApprovalRequests('thread-approval')).toEqual([]);
    mirror.dispose();
  });

  it('exposes pending MCP elicitation approvals from Computer Use', () => {
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const onPendingApprovalsChange = vi.fn();
    const mirror = createCodexMirror({ ipc, reader, onPendingApprovalsChange });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-approval',
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
                threadId: 'thread-approval',
                turnId: 'turn-7',
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
    });

    expect(mirror.isThreadWaitingForApproval('thread-approval')).toBe(true);
    expect(onPendingApprovalsChange).toHaveBeenCalledWith({
      threadId: 'thread-approval',
      requests: [
        expect.objectContaining({
          id: 'mcp-approval-1',
          method: 'mcpServer/elicitation/request',
          turnId: 'turn-7'
        })
      ]
    });
    expect(mirror.getPendingApprovalRequests('thread-approval')).toEqual([
      expect.objectContaining({
        id: 'mcp-approval-1',
        method: 'mcpServer/elicitation/request',
        turnId: 'turn-7'
      })
    ]);
    mirror.dispose();
  });

  it('does not mark ready when a command completes but the latest turn is still active', async () => {
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const onStreamingChange = vi.fn();
    const mirror = createCodexMirror({ ipc, reader, onStreamingChange });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-active-turn',
      change: {
        type: 'snapshot',
        conversationState: {
          turns: [{ status: 'inProgress', items: [{ type: 'commandExecution', status: 'inProgress' }] }]
        }
      }
    });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-active-turn',
      change: {
        type: 'patches',
        patches: [
          {
            op: 'replace',
            path: ['turns', 0, 'items', 0, 'status'],
            value: 'completed'
          }
        ]
      }
    });

    expect(mirror.isThreadStreaming('thread-active-turn')).toBe(true);
    expect(onStreamingChange).toHaveBeenCalledTimes(1);

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'local',
      conversationId: 'thread-active-turn',
      change: {
        type: 'patches',
        patches: [
          {
            op: 'replace',
            path: ['turns', 0, 'status'],
            value: 'completed'
          }
        ]
      }
    });

    expect(mirror.isThreadStreaming('thread-active-turn')).toBe(false);
    expect(onStreamingChange).toHaveBeenLastCalledWith({
      threadId: 'thread-active-turn',
      isStreaming: false
    });
    mirror.dispose();
  });

  it('expires stale unowned streaming when Codex desktop stops broadcasting updates', async () => {
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    let now = 1_000;
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const onStreamingChange = vi.fn();
    const mirror = createCodexMirror({
      ipc,
      reader,
      onStreamingChange,
      now: () => now,
      unownedStreamingStaleMs: 10_000
    } as Parameters<typeof createCodexMirror>[0] & {
      now: () => number;
      unownedStreamingStaleMs: number;
    });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'desktop-host',
      conversationId: 'thread-stale',
      change: { isStreaming: true, streamRole: { role: 'follower' } }
    });

    expect(mirror.isThreadStreaming('thread-stale')).toBe(true);

    now += 10_001;

    expect(mirror.isThreadStreaming('thread-stale')).toBe(false);
    expect(onStreamingChange).toHaveBeenLastCalledWith({
      threadId: 'thread-stale',
      isStreaming: false
    });
    mirror.dispose();
  });

  it('keeps owned streaming alive even when the last broadcast is older than the stale window', async () => {
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    let now = 1_000;
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({
      ipc,
      reader,
      now: () => now,
      unownedStreamingStaleMs: 10_000
    } as Parameters<typeof createCodexMirror>[0] & {
      now: () => number;
      unownedStreamingStaleMs: number;
    });

    emitBroadcast('thread-stream-state-changed', {
      hostId: 'desktop-host',
      conversationId: 'thread-owned',
      change: { isStreaming: true, streamRole: { role: 'owner' } }
    });

    now += 30_000;

    expect(mirror.isThreadStreaming('thread-owned')).toBe(true);
    mirror.dispose();
  });

  it('tracks Codex desktop compaction as an active thread state', async () => {
    const { ipc, setReady, emitBroadcast } = createMockIpc();
    setReady(true);
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const onStreamingChange = vi.fn();
    const mirror = createCodexMirror({ ipc, reader, onStreamingChange });
    const mirrorWithCompaction = mirror as typeof mirror & {
      isThreadCompacting(threadId: string): boolean;
    };

    emitBroadcast('thread/status/changed', {
      threadId: 'thread-compact',
      status: { type: 'compacting', label: 'Automatically compacting context' }
    });

    expect(mirrorWithCompaction.isThreadCompacting('thread-compact')).toBe(true);
    expect(mirror.isThreadStreaming('thread-compact')).toBe(true);
    expect(onStreamingChange).toHaveBeenLastCalledWith({
      threadId: 'thread-compact',
      isStreaming: true
    });

    emitBroadcast('thread/compacted', {
      threadId: 'thread-compact'
    });

    expect(mirrorWithCompaction.isThreadCompacting('thread-compact')).toBe(false);
    expect(mirror.isThreadStreaming('thread-compact')).toBe(false);
    expect(onStreamingChange).toHaveBeenLastCalledWith({
      threadId: 'thread-compact',
      isStreaming: false
    });
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

  it('sends MCP elicitation approval responses through the Codex follower IPC method', async () => {
    const { ipc, setReady, sendRequest } = createMockIpc();
    setReady(true);
    sendRequest.mockResolvedValueOnce({ ok: true });
    const reader = { readTranscript: vi.fn(async () => transcriptStub) };
    const mirror = createCodexMirror({ ipc, reader });

    await mirror.respondToApproval(
      'thread-abc',
      'mcp-approval-1',
      'mcpServer/elicitation/request',
      { action: 'accept', content: {}, _meta: null }
    );

    expect(sendRequest).toHaveBeenCalledWith(
      'thread-follower-submit-mcp-server-elicitation-response',
      {
        conversationId: 'thread-abc',
        requestId: 'mcp-approval-1',
        response: { action: 'accept', content: {}, _meta: null }
      }
    );
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
