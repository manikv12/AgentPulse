import type {
  ChatMessage,
  ThreadMessageResponse,
  ThreadSendState,
  ThreadTranscript
} from '@agent-pulse/shared';
import { ThreadMessageResponseSchema } from '@agent-pulse/shared';
import { debugLog } from '../debug';
import { SendBlockedError } from './app-server-chat';
import type { CodexAppServerChat } from './app-server-chat';
import type { IpcClient } from './ipc-client';

export type CodexMirrorBroadcast = {
  method: string;
  params: unknown;
  sourceClientId: string;
};

export type CodexMirrorOptions = {
  ipc: IpcClient;
  reader: Pick<CodexAppServerChat, 'readTranscript'>;
  onBroadcast?: (broadcast: CodexMirrorBroadcast) => void;
  onStreamingChange?: (event: { threadId: string; isStreaming: boolean }) => void;
  hostId?: string;
  followerRequestTimeoutMs?: number;
};

export type CodexMirror = {
  sendMessage(threadId: string, text: string): Promise<ThreadMessageResponse>;
  interruptTurn(threadId: string): Promise<void>;
  readTranscript(threadId: string): Promise<ThreadTranscript>;
  setModelAndReasoning(
    threadId: string,
    modelSlug: string,
    reasoningEffort?: string
  ): Promise<void>;
  respondToApproval(
    threadId: string,
    requestId: string,
    method: ApprovalMethod,
    response: ApprovalResponse
  ): Promise<void>;
  isThreadStreaming(threadId: string): boolean;
  isThreadOwned(threadId: string): boolean;
  waitForOwnership(threadId: string, timeoutMs: number): Promise<boolean>;
  isConnected(): boolean;
  dispose(): void;
};

export type ApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval';

export type ApprovalResponse = 'accept' | 'acceptForSession' | 'decline' | unknown;

const DEFAULT_HOST_ID = 'local';

export function createCodexMirror(options: CodexMirrorOptions): CodexMirror {
  const ipc = options.ipc;
  const hostId = options.hostId ?? DEFAULT_HOST_ID;
  const onBroadcast = options.onBroadcast;

  const streamingThreads = new Set<string>();
  // Threads where a Codex window currently reports streamRole.role === 'owner'.
  // Required for follower IPC methods (set-model-and-reasoning, approval decisions, etc.)
  // to pass the desktop's discovery callback `getThreadRole === 'owner'`.
  const ownedThreads = new Set<string>();
  const ownershipWaiters = new Map<string, Set<() => void>>();
  const detachers: Array<() => void> = [];

  function notifyOwnershipWaiters(conversationId: string): void {
    const waiters = ownershipWaiters.get(conversationId);
    if (!waiters) return;
    ownershipWaiters.delete(conversationId);
    for (const waiter of waiters) {
      try {
        waiter();
      } catch {
        // ignore
      }
    }
  }

  detachers.push(
    ipc.addBroadcastHandler('thread-stream-state-changed', (event) => {
      const params = event.params as {
        conversationId?: unknown;
        hostId?: unknown;
        change?: {
          isStreaming?: unknown;
          streamRole?: { role?: unknown } | null;
        } | null;
      } | null;
      if (!params) {
        return;
      }
      const conversationId = typeof params.conversationId === 'string' ? params.conversationId : null;
      if (!conversationId) {
        return;
      }
      // Note: we used to filter by params.hostId === 'local'. Codex windows broadcast with their
      // own connector/host id (a UUID per session), so that filter dropped every ownership flip.
      // We now accept all hosts and key state purely on conversationId. The local hostId is still
      // used when *we* construct outgoing requests.
      void hostId;
      debugLog('[ownership] broadcast received', {
        conversationId,
        hostId: typeof params.hostId === 'string' ? params.hostId : null,
        isStreaming: Boolean(params.change?.isStreaming),
        role: params.change?.streamRole?.role ?? null
      });
      const isStreaming = Boolean(params.change?.isStreaming);
      const wasStreaming = streamingThreads.has(conversationId);
      if (isStreaming) {
        streamingThreads.add(conversationId);
      } else {
        streamingThreads.delete(conversationId);
      }
      if (isStreaming !== wasStreaming) {
        try {
          options.onStreamingChange?.({ threadId: conversationId, isStreaming });
        } catch {
          // ignore listener errors
        }
      }
      const roleValue = params.change?.streamRole?.role;
      if (typeof roleValue === 'string') {
        const wasOwned = ownedThreads.has(conversationId);
        if (roleValue === 'owner') {
          if (!wasOwned) {
            ownedThreads.add(conversationId);
            debugLog('[ownership] broadcast: thread is now owned', { conversationId });
            notifyOwnershipWaiters(conversationId);
          }
        } else {
          if (wasOwned) {
            debugLog('[ownership] broadcast: thread is no longer owned', {
              conversationId,
              role: roleValue
            });
          }
          ownedThreads.delete(conversationId);
        }
      }
      onBroadcast?.({
        method: event.method,
        params: event.params,
        sourceClientId: event.sourceClientId
      });
    })
  );

  detachers.push(
    ipc.addAnyBroadcastHandler((event) => {
      debugLog('[ipc-broadcast]', { method: event.method, sourceClientId: event.sourceClientId });
      if (event.method === 'thread-stream-state-changed') {
        return;
      }
      onBroadcast?.({
        method: event.method,
        params: event.params,
        sourceClientId: event.sourceClientId
      });
    })
  );

  async function sendFollowerRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!ipc.isReady()) {
      throw new SendBlockedError(
        'thread_unavailable',
        'Not connected to the Codex app — open Codex on this Mac to mirror messages.'
      );
    }
    try {
      return await ipc.sendRequest<T>(method, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ipc-error';
      if (message === 'no-client-found' || message === 'client-not-found' || message === 'client-cannot-handle-request') {
        throw new SendBlockedError(
          'thread_unavailable',
          'Codex could not deliver the request — the thread is not currently focused on the Mac. Try again in a moment.'
        );
      }
      if (message === 'timeout' || message === 'request-timeout') {
        throw new SendBlockedError('thread_unavailable', 'Codex took too long to respond. Try again.');
      }
      throw error;
    }
  }

  async function startTurn(threadId: string, text: string): Promise<{ turn: { id: string } }> {
    const response = await sendFollowerRequest<{ result: { turn: { id: string } } }>(
      'thread-follower-start-turn',
      {
        conversationId: threadId,
        turnStartParams: {
          threadId,
          input: userTextInput(text)
        }
      }
    );
    return response.result;
  }

  async function steerTurn(threadId: string, text: string): Promise<{ turn: { id: string } }> {
    const response = await sendFollowerRequest<{ result: { turn?: { id: string }; turnId?: string } }>(
      'thread-follower-steer-turn',
      {
        conversationId: threadId,
        input: userTextInput(text),
        attachments: [],
        restoreMessage: null
      }
    );
    const result = response.result;
    if ('turn' in result && result.turn) {
      return { turn: result.turn };
    }
    if (result.turnId) {
      return { turn: { id: result.turnId } };
    }
    throw new Error('Codex returned an unexpected response from thread-follower-steer-turn.');
  }

  async function readTranscript(threadId: string): Promise<ThreadTranscript> {
    return options.reader.readTranscript(threadId);
  }

  async function sendMessage(threadId: string, text: string): Promise<ThreadMessageResponse> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new SendBlockedError('ready', 'Cannot send an empty message.');
    }
    if (!ipc.isReady()) {
      throw new SendBlockedError(
        'thread_unavailable',
        'Not connected to the Codex app — open Codex on this Mac to mirror messages.'
      );
    }

    const isStreaming = streamingThreads.has(threadId);
    const result = isStreaming
      ? await steerTurn(threadId, trimmed)
      : await startTurn(threadId, trimmed);

    const transcript = await readTranscript(threadId).catch(() =>
      buildFallbackTranscript(threadId, trimmed, isStreaming, result.turn.id)
    );

    return ThreadMessageResponseSchema.parse({
      ok: true,
      mode: isStreaming ? 'steer' : 'start',
      turnId: result.turn.id,
      transcript
    });
  }

  async function interruptTurn(threadId: string): Promise<void> {
    await sendFollowerRequest('thread-follower-interrupt-turn', {
      conversationId: threadId
    });
  }

  async function setModelAndReasoning(
    threadId: string,
    modelSlug: string,
    reasoningEffort?: string
  ): Promise<void> {
    await sendFollowerRequest('thread-follower-set-model-and-reasoning', {
      conversationId: threadId,
      model: modelSlug,
      ...(reasoningEffort ? { reasoningEffort } : {})
    });
  }

  async function respondToApproval(
    threadId: string,
    requestId: string,
    method: ApprovalMethod,
    response: ApprovalResponse
  ): Promise<void> {
    if (method === 'item/commandExecution/requestApproval') {
      await sendFollowerRequest('thread-follower-command-approval-decision', {
        conversationId: threadId,
        requestId,
        decision: response
      });
      return;
    }
    if (method === 'item/fileChange/requestApproval') {
      await sendFollowerRequest('thread-follower-file-approval-decision', {
        conversationId: threadId,
        requestId,
        decision: response
      });
      return;
    }
    if (method === 'item/permissions/requestApproval') {
      await sendFollowerRequest('thread-follower-permissions-request-approval-response', {
        conversationId: threadId,
        requestId,
        response
      });
      return;
    }
    throw new Error(`Unsupported approval method: ${method}`);
  }

  function isThreadOwned(threadId: string): boolean {
    return ownedThreads.has(threadId);
  }

  function isThreadStreaming(threadId: string): boolean {
    return streamingThreads.has(threadId);
  }

  function waitForOwnership(threadId: string, timeoutMs: number): Promise<boolean> {
    if (ownedThreads.has(threadId)) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiters = ownershipWaiters.get(threadId) ?? new Set<() => void>();
      let settled = false;
      const handle = setTimeout(() => {
        if (settled) return;
        settled = true;
        waiters.delete(onOwn);
        if (waiters.size === 0) {
          ownershipWaiters.delete(threadId);
        }
        resolve(false);
      }, timeoutMs);
      const onOwn = () => {
        if (settled) return;
        settled = true;
        clearTimeout(handle);
        resolve(true);
      };
      waiters.add(onOwn);
      ownershipWaiters.set(threadId, waiters);
    });
  }

  return {
    sendMessage,
    interruptTurn,
    readTranscript,
    setModelAndReasoning,
    respondToApproval,
    isThreadStreaming,
    isThreadOwned,
    waitForOwnership,
    isConnected: () => ipc.isReady(),
    dispose() {
      for (const detach of detachers) {
        try {
          detach();
        } catch {
          // ignore
        }
      }
      streamingThreads.clear();
      ownedThreads.clear();
      ownershipWaiters.clear();
    }
  };
}

function userTextInput(text: string) {
  return [
    {
      type: 'text',
      text,
      text_elements: []
    }
  ];
}

function buildFallbackTranscript(
  threadId: string,
  text: string,
  wasStreaming: boolean,
  turnId: string
): ThreadTranscript {
  const sendState: ThreadSendState = wasStreaming
    ? {
        canSend: false,
        reason: 'missing_active_turn',
        label: 'Codex is running. Wait for it to finish.'
      }
    : {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      };
  const message: ChatMessage = {
    id: `pending-${turnId}`,
    role: 'user',
    kind: 'message',
    text,
    createdAt: new Date().toISOString()
  };
  return {
    threadId,
    activeTurnId: wasStreaming ? turnId : null,
    sendState,
    messages: [message]
  };
}
