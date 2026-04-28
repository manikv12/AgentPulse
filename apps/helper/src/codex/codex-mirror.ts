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
const ACTIVE_STATUSES = new Set(['active', 'inProgress', 'in_progress', 'pending']);

type AppThreadStreamState = {
  activeItemKeys: Set<string>;
  latestTurnIndex: number | null;
  latestTurnStatus: string | null;
  runtimeStatusType: string | null;
};

type JsonRecord = Record<string, unknown>;

export function createCodexMirror(options: CodexMirrorOptions): CodexMirror {
  const ipc = options.ipc;
  const hostId = options.hostId ?? DEFAULT_HOST_ID;
  const onBroadcast = options.onBroadcast;

  const streamingThreads = new Set<string>();
  const appThreadStreamStates = new Map<string, AppThreadStreamState>();
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

  function setStreamingState(conversationId: string, isStreaming: boolean): void {
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
  }

  function updateStreamingFromAppChange(conversationId: string, change: JsonRecord): boolean | null {
    const explicitStreaming = change.isStreaming;
    if (typeof explicitStreaming === 'boolean') {
      if (!explicitStreaming) {
        appThreadStreamStates.delete(conversationId);
      }
      setStreamingState(conversationId, explicitStreaming);
      return explicitStreaming;
    }

    const changeType = typeof change.type === 'string' ? change.type : null;
    if (changeType === 'snapshot') {
      const conversationState = objectField(change, 'conversationState');
      if (!conversationState) {
        return null;
      }
      const state = streamStateFromConversationState(conversationState);
      appThreadStreamStates.set(conversationId, state);
      const isStreaming = isActiveAppThreadState(state);
      setStreamingState(conversationId, isStreaming);
      return isStreaming;
    }

    if (changeType === 'patches') {
      const patches = Array.isArray(change.patches) ? change.patches : [];
      if (patches.length === 0) {
        return null;
      }
      const state = appThreadStreamStates.get(conversationId) ?? emptyAppThreadStreamState();
      for (const patch of patches) {
        applyStreamPatch(state, patch);
      }
      appThreadStreamStates.set(conversationId, state);
      const isStreaming = isActiveAppThreadState(state);
      setStreamingState(conversationId, isStreaming);
      return isStreaming;
    }

    return null;
  }

  detachers.push(
    ipc.addBroadcastHandler('thread-stream-state-changed', (event) => {
      const params = event.params as {
        conversationId?: unknown;
        hostId?: unknown;
        change?: unknown;
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
      const change = objectField(params, 'change');
      const streamRole = change ? objectField(change, 'streamRole') : null;
      const derivedStreaming = change ? updateStreamingFromAppChange(conversationId, change) : null;
      debugLog('[ownership] broadcast received', {
        conversationId,
        hostId: typeof params.hostId === 'string' ? params.hostId : null,
        changeType: change && typeof change.type === 'string' ? change.type : null,
        isStreaming: derivedStreaming ?? streamingThreads.has(conversationId),
        role: streamRole?.role ?? null
      });
      const roleValue = streamRole?.role;
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
      appThreadStreamStates.clear();
      ownedThreads.clear();
      ownershipWaiters.clear();
    }
  };
}

function emptyAppThreadStreamState(): AppThreadStreamState {
  return {
    activeItemKeys: new Set(),
    latestTurnIndex: null,
    latestTurnStatus: null,
    runtimeStatusType: null
  };
}

function isActiveAppThreadState(state: AppThreadStreamState): boolean {
  return (
    isActiveStatus(state.runtimeStatusType) ||
    isActiveStatus(state.latestTurnStatus) ||
    state.activeItemKeys.size > 0
  );
}

function isActiveStatus(status: unknown): boolean {
  return typeof status === 'string' && ACTIVE_STATUSES.has(status);
}

function streamStateFromConversationState(conversationState: JsonRecord): AppThreadStreamState {
  const state = emptyAppThreadStreamState();
  const runtimeStatus = objectField(conversationState, 'threadRuntimeStatus');
  state.runtimeStatusType = stringField(runtimeStatus, 'type');

  const turns = arrayField(conversationState, 'turns');
  state.latestTurnIndex = turns.length > 0 ? turns.length - 1 : null;
  turns.forEach((rawTurn, turnIndex) => {
    const turn = asObject(rawTurn);
    if (!turn) {
      return;
    }
    if (turnIndex === state.latestTurnIndex) {
      state.latestTurnStatus = stringField(turn, 'status');
    }
    trackInProgressItemsForTurn(state, turn, turnIndex);
  });
  return state;
}

function applyStreamPatch(state: AppThreadStreamState, rawPatch: unknown): void {
  const patch = asObject(rawPatch);
  if (!patch) {
    return;
  }
  const op = typeof patch.op === 'string' ? patch.op : null;
  const path = Array.isArray(patch.path) ? patch.path : [];
  if (path.length === 0) {
    return;
  }

  if (path[0] === 'threadRuntimeStatus') {
    applyRuntimeStatusPatch(state, path, patch.value);
    return;
  }

  if (path[0] !== 'turns') {
    return;
  }

  if (path.length === 1 && Array.isArray(patch.value)) {
    const rebuilt = streamStateFromConversationState({
      turns: patch.value,
      threadRuntimeStatus: state.runtimeStatusType ? { type: state.runtimeStatusType } : undefined
    });
    state.activeItemKeys = rebuilt.activeItemKeys;
    state.latestTurnIndex = rebuilt.latestTurnIndex;
    state.latestTurnStatus = rebuilt.latestTurnStatus;
    return;
  }

  const turnIndex = numericPathPart(path[1]);
  if (turnIndex == null) {
    return;
  }

  if (path.length === 2) {
    if (op === 'remove') {
      removeActiveItemKeysForTurn(state, turnIndex);
      if (state.latestTurnIndex === turnIndex) {
        state.latestTurnStatus = null;
      }
      return;
    }

    const turn = asObject(patch.value);
    if (!turn) {
      return;
    }
    rememberLatestTurnStatus(state, turnIndex, stringField(turn, 'status'));
    removeActiveItemKeysForTurn(state, turnIndex);
    trackInProgressItemsForTurn(state, turn, turnIndex);
    return;
  }

  if (path[2] === 'status') {
    rememberLatestTurnStatus(state, turnIndex, typeof patch.value === 'string' ? patch.value : null);
    return;
  }

  if (path[2] !== 'items') {
    return;
  }

  if (path.length === 3 && Array.isArray(patch.value)) {
    removeActiveItemKeysForTurn(state, turnIndex);
    patch.value.forEach((item, itemIndex) => {
      updateActiveItemKeyFromItem(state, turnIndex, itemIndex, item);
    });
    return;
  }

  const itemIndex = numericPathPart(path[3]);
  if (itemIndex == null) {
    return;
  }
  const itemKey = activeItemKey(turnIndex, itemIndex);

  if (path.length === 4) {
    if (op === 'remove') {
      state.activeItemKeys.delete(itemKey);
      return;
    }
    updateActiveItemKeyFromItem(state, turnIndex, itemIndex, patch.value);
    return;
  }

  if (path[4] === 'status') {
    if (isActiveStatus(patch.value)) {
      state.activeItemKeys.add(itemKey);
    } else {
      state.activeItemKeys.delete(itemKey);
    }
  }
}

function applyRuntimeStatusPatch(
  state: AppThreadStreamState,
  path: unknown[],
  value: unknown
): void {
  if (path.length === 1) {
    state.runtimeStatusType = stringField(asObject(value), 'type');
    return;
  }
  if (path[1] === 'type') {
    state.runtimeStatusType = typeof value === 'string' ? value : null;
  }
}

function rememberLatestTurnStatus(
  state: AppThreadStreamState,
  turnIndex: number,
  status: string | null
): void {
  if (state.latestTurnIndex == null || turnIndex >= state.latestTurnIndex) {
    state.latestTurnIndex = turnIndex;
    state.latestTurnStatus = status;
  }
}

function trackInProgressItemsForTurn(
  state: AppThreadStreamState,
  turn: JsonRecord,
  turnIndex: number
): void {
  const items = arrayField(turn, 'items');
  items.forEach((item, itemIndex) => {
    updateActiveItemKeyFromItem(state, turnIndex, itemIndex, item);
  });
}

function updateActiveItemKeyFromItem(
  state: AppThreadStreamState,
  turnIndex: number,
  itemIndex: number,
  item: unknown
): void {
  const key = activeItemKey(turnIndex, itemIndex);
  const status = stringField(asObject(item), 'status');
  if (isActiveStatus(status)) {
    state.activeItemKeys.add(key);
  } else {
    state.activeItemKeys.delete(key);
  }
}

function removeActiveItemKeysForTurn(state: AppThreadStreamState, turnIndex: number): void {
  const prefix = `turns.${turnIndex}.items.`;
  for (const key of [...state.activeItemKeys]) {
    if (key.startsWith(prefix)) {
      state.activeItemKeys.delete(key);
    }
  }
}

function activeItemKey(turnIndex: number, itemIndex: number): string {
  return `turns.${turnIndex}.items.${itemIndex}`;
}

function numericPathPart(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

function objectField(value: unknown, field: string): JsonRecord | null {
  const object = asObject(value);
  return asObject(object?.[field]);
}

function stringField(value: unknown, field: string): string | null {
  const object = asObject(value);
  const fieldValue = object?.[field];
  return typeof fieldValue === 'string' ? fieldValue : null;
}

function arrayField(value: unknown, field: string): unknown[] {
  const object = asObject(value);
  const fieldValue = object?.[field];
  return Array.isArray(fieldValue) ? fieldValue : [];
}

function asObject(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
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
