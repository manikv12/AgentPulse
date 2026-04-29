import type {
  ChatMessage,
  PendingApprovalRequest,
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
  // Fires whenever the set of pending approval requests for a thread changes,
  // including when it becomes empty. Used by the helper server to push a
  // replayable `thread/pending-approvals/changed` live event to the tablet so
  // the approval card renders even after a reconnect.
  onPendingApprovalsChange?: (event: {
    threadId: string;
    requests: PendingApprovalRequest[];
  }) => void;
  hostId?: string;
  followerRequestTimeoutMs?: number;
  now?: () => number;
  unownedStreamingStaleMs?: number;
};

export type CodexMirrorSendOptions = {
  collaborationMode?: 'default' | 'plan';
  // Used to populate the `settings` block of the collaborationMode payload —
  // Codex expects the active model + reasoning effort alongside the mode flag,
  // matching what its own UI sends when you press Shift+Tab. The caller can
  // omit them when collaborationMode is undefined.
  model?: string;
  effort?: string;
};

export type CodexMirror = {
  sendMessage(
    threadId: string,
    text: string,
    options?: CodexMirrorSendOptions
  ): Promise<ThreadMessageResponse>;
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
  isThreadCompacting(threadId: string): boolean;
  isThreadWaitingForApproval(threadId: string): boolean;
  // Returns the set of approval requests Codex has surfaced for this thread,
  // with their full payloads (id, method, params). Used by the server to seed
  // the tablet on reconnect via `thread/upsert`.
  getPendingApprovalRequests(threadId: string): PendingApprovalRequest[];
  isThreadOwned(threadId: string): boolean;
  waitForOwnership(threadId: string, timeoutMs: number): Promise<boolean>;
  isConnected(): boolean;
  dispose(): void;
};

export type ApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'mcpServer/elicitation/request';

export type ApprovalResponse = 'accept' | 'acceptForSession' | 'decline' | unknown;

const DEFAULT_HOST_ID = 'local';
const DEFAULT_UNOWNED_STREAMING_STALE_MS = 20_000;
const ACTIVE_STATUSES = new Set(['active', 'inProgress', 'in_progress', 'pending']);
const APPROVAL_REQUEST_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request'
]);

type AppThreadStreamState = {
  activeItemKeys: Set<string>;
  // Keyed by patch path (e.g. `requests.0` or `turns.3.items.5`) so we can
  // remove the right entry when Codex emits a `remove`/`isCompleted` patch.
  // The value is the full request payload — not just the id — so the helper
  // can replay it to the tablet on reconnect.
  approvalRequestsByKey: Map<string, PendingApprovalRequest>;
  latestTurnIndex: number | null;
  latestTurnStatus: string | null;
  runtimeStatusType: string | null;
  isCompactingContext: boolean;
  lastUpdatedAtMs: number;
};

type JsonRecord = Record<string, unknown>;

export function createCodexMirror(options: CodexMirrorOptions): CodexMirror {
  const ipc = options.ipc;
  const hostId = options.hostId ?? DEFAULT_HOST_ID;
  const onBroadcast = options.onBroadcast;
  const now = options.now ?? (() => Date.now());
  const unownedStreamingStaleMs =
    options.unownedStreamingStaleMs ?? DEFAULT_UNOWNED_STREAMING_STALE_MS;

  const streamingThreads = new Set<string>();
  const streamingUpdatedAtMs = new Map<string, number>();
  const appThreadStreamStates = new Map<string, AppThreadStreamState>();
  // Last set of pending approval requests we've emitted to onPendingApprovalsChange,
  // keyed by conversation id. Used to deduplicate notifications so the helper
  // server only broadcasts when the visible-to-tablet list actually changes.
  const lastEmittedPendingApprovals = new Map<string, PendingApprovalRequest[]>();
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
      streamingUpdatedAtMs.set(conversationId, now());
    } else {
      streamingThreads.delete(conversationId);
      streamingUpdatedAtMs.delete(conversationId);
    }
    if (isStreaming !== wasStreaming) {
      try {
        options.onStreamingChange?.({ threadId: conversationId, isStreaming });
      } catch {
        // ignore listener errors
      }
    }
  }

  function updateThreadStreamingFromState(conversationId: string): boolean {
    const state = appThreadStreamStates.get(conversationId);
    const isStreaming = state ? isActiveAppThreadState(state) : false;
    setStreamingState(conversationId, isStreaming);
    notifyPendingApprovalsIfChanged(conversationId);
    return isStreaming;
  }

  function clearThreadState(conversationId: string): void {
    appThreadStreamStates.delete(conversationId);
    setStreamingState(conversationId, false);
    notifyPendingApprovalsIfChanged(conversationId);
  }

  function notifyPendingApprovalsIfChanged(conversationId: string): void {
    const state = appThreadStreamStates.get(conversationId);
    const requests = state ? pendingApprovalsFromState(state) : [];
    const previous = lastEmittedPendingApprovals.get(conversationId) ?? [];
    if (arraysOfRequestsEqual(previous, requests)) {
      return;
    }
    if (requests.length === 0) {
      lastEmittedPendingApprovals.delete(conversationId);
    } else {
      lastEmittedPendingApprovals.set(conversationId, requests);
    }
    try {
      options.onPendingApprovalsChange?.({ threadId: conversationId, requests });
    } catch {
      // ignore listener errors
    }
  }

  function updateStreamingFromAppChange(conversationId: string, change: JsonRecord): boolean | null {
    const explicitStreaming = change.isStreaming;
    if (typeof explicitStreaming === 'boolean') {
      if (!explicitStreaming) {
        clearThreadState(conversationId);
        return false;
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
      state.lastUpdatedAtMs = now();
      appThreadStreamStates.set(conversationId, state);
      return updateThreadStreamingFromState(conversationId);
    }

    if (changeType === 'patches') {
      const patches = Array.isArray(change.patches) ? change.patches : [];
      if (patches.length === 0) {
        return null;
      }
      const state = appThreadStreamStates.get(conversationId) ?? emptyAppThreadStreamState(now());
      for (const patch of patches) {
        applyStreamPatch(state, patch);
      }
      state.lastUpdatedAtMs = now();
      appThreadStreamStates.set(conversationId, state);
      return updateThreadStreamingFromState(conversationId);
    }

    return null;
  }

  function handleThreadStatusChanged(params: unknown): void {
    const object = asObject(params);
    const conversationId = threadIdFromParams(object);
    if (!conversationId) {
      return;
    }
    const state = appThreadStreamStates.get(conversationId) ?? emptyAppThreadStreamState(now());
    const status = object?.status ?? object?.threadRuntimeStatus ?? object;
    state.runtimeStatusType = statusType(status);
    state.isCompactingContext = statusLooksCompacting(status);
    if (!state.isCompactingContext && !isActiveStatus(state.runtimeStatusType)) {
      state.activeItemKeys.clear();
      state.latestTurnStatus = null;
    }
    state.lastUpdatedAtMs = now();
    appThreadStreamStates.set(conversationId, state);
    updateThreadStreamingFromState(conversationId);
  }

  function handleThreadCompacted(params: unknown): void {
    const conversationId = threadIdFromParams(asObject(params));
    if (!conversationId) {
      return;
    }
    const state = appThreadStreamStates.get(conversationId);
    if (state) {
      state.isCompactingContext = false;
      state.runtimeStatusType = null;
      state.activeItemKeys.clear();
      state.latestTurnStatus = null;
      state.lastUpdatedAtMs = now();
      appThreadStreamStates.set(conversationId, state);
      updateThreadStreamingFromState(conversationId);
      return;
    }
    setStreamingState(conversationId, false);
  }

  function expireStaleUnownedStreaming(threadId: string): void {
    if (!streamingThreads.has(threadId) || ownedThreads.has(threadId)) {
      return;
    }
    const state = appThreadStreamStates.get(threadId);
    if (state && hasPendingApprovalRequest(state)) {
      return;
    }
    const lastUpdatedAtMs = state?.lastUpdatedAtMs ?? streamingUpdatedAtMs.get(threadId);
    if (lastUpdatedAtMs == null || now() - lastUpdatedAtMs <= unownedStreamingStaleMs) {
      return;
    }
    appThreadStreamStates.delete(threadId);
    setStreamingState(threadId, false);
    notifyPendingApprovalsIfChanged(threadId);
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
      if (event.method === 'thread/status/changed') {
        handleThreadStatusChanged(event.params);
      }
      if (event.method === 'thread/compacted') {
        handleThreadCompacted(event.params);
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

  async function startTurn(
    threadId: string,
    text: string,
    sendOptions?: CodexMirrorSendOptions
  ): Promise<{ turn: { id: string } }> {
    // Codex's thread-follower-start-turn takes the same payload shape as the
    // app-server's turn/start. When the user has Plan mode toggled on the
    // tablet (or pressed Shift+Tab in the desktop UI, which sets the same
    // flag), we pass collaborationMode through so the desktop window enters
    // plan mode for this turn — matching the local Codex experience exactly.
    const collaborationModePayload =
      sendOptions?.collaborationMode
        ? {
            mode: sendOptions.collaborationMode,
            settings: {
              model: sendOptions.model ?? null,
              reasoning_effort: sendOptions.effort ?? null,
              developer_instructions: null
            }
          }
        : undefined;
    const response = await sendFollowerRequest<{ result: { turn: { id: string } } }>(
      'thread-follower-start-turn',
      {
        conversationId: threadId,
        turnStartParams: {
          threadId,
          input: userTextInput(text),
          ...(collaborationModePayload ? { collaborationMode: collaborationModePayload } : {})
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

  async function sendMessage(
    threadId: string,
    text: string,
    options?: CodexMirrorSendOptions
  ): Promise<ThreadMessageResponse> {
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

    const isStreaming = isThreadStreaming(threadId);
    const result = isStreaming
      ? await steerTurn(threadId, trimmed)
      : await startTurn(threadId, trimmed, options);

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
    if (method === 'mcpServer/elicitation/request') {
      await sendFollowerRequest('thread-follower-submit-mcp-server-elicitation-response', {
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
    expireStaleUnownedStreaming(threadId);
    return streamingThreads.has(threadId);
  }

  function isThreadCompacting(threadId: string): boolean {
    expireStaleUnownedStreaming(threadId);
    const state = appThreadStreamStates.get(threadId);
    return state?.isCompactingContext === true;
  }

  function isThreadWaitingForApproval(threadId: string): boolean {
    const state = appThreadStreamStates.get(threadId);
    return state ? hasPendingApprovalRequest(state) : false;
  }

  function getPendingApprovalRequests(threadId: string): PendingApprovalRequest[] {
    const state = appThreadStreamStates.get(threadId);
    return state ? pendingApprovalsFromState(state) : [];
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
    isThreadCompacting,
    isThreadWaitingForApproval,
    getPendingApprovalRequests,
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
      streamingUpdatedAtMs.clear();
      appThreadStreamStates.clear();
      lastEmittedPendingApprovals.clear();
      ownedThreads.clear();
      ownershipWaiters.clear();
    }
  };
}

function emptyAppThreadStreamState(lastUpdatedAtMs = Date.now()): AppThreadStreamState {
  return {
    activeItemKeys: new Set(),
    approvalRequestsByKey: new Map(),
    latestTurnIndex: null,
    latestTurnStatus: null,
    runtimeStatusType: null,
    isCompactingContext: false,
    lastUpdatedAtMs
  };
}

function hasPendingApprovalRequest(state: AppThreadStreamState): boolean {
  return state.approvalRequestsByKey.size > 0;
}

function pendingApprovalsFromState(state: AppThreadStreamState): PendingApprovalRequest[] {
  // Deduplicate by request id — Codex sometimes surfaces the same approval as
  // both a top-level `requests` entry and a turn-level `permissionRequest`
  // item. We keep the first occurrence (which iterates in insertion order, so
  // it matches the order Codex emitted them).
  const byId = new Map<string, PendingApprovalRequest>();
  for (const request of state.approvalRequestsByKey.values()) {
    if (!byId.has(request.id)) {
      byId.set(request.id, request);
    }
  }
  return [...byId.values()];
}

function arraysOfRequestsEqual(
  a: PendingApprovalRequest[],
  b: PendingApprovalRequest[]
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.id !== b[i]!.id || a[i]!.method !== b[i]!.method) {
      return false;
    }
  }
  return true;
}

function isActiveAppThreadState(state: AppThreadStreamState): boolean {
  return (
    isActiveStatus(state.runtimeStatusType) ||
    state.isCompactingContext ||
    isActiveStatus(state.latestTurnStatus) ||
    state.activeItemKeys.size > 0 ||
    hasPendingApprovalRequest(state)
  );
}

function isActiveStatus(status: unknown): boolean {
  return typeof status === 'string' && ACTIVE_STATUSES.has(status);
}

function statusType(status: unknown): string | null {
  if (typeof status === 'string') {
    return status;
  }
  return stringField(asObject(status), 'type') ?? stringField(asObject(status), 'status');
}

function statusLooksCompacting(status: unknown): boolean {
  return collectStatusStrings(status).some((value) => {
    const normalized = value.toLowerCase();
    return normalized.includes('compact') && !normalized.includes('compacted');
  });
}

function collectStatusStrings(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (depth >= 2) {
    return [];
  }
  const object = asObject(value);
  if (!object) {
    return [];
  }
  const fields = [
    object.type,
    object.status,
    object.state,
    object.phase,
    object.kind,
    object.label,
    object.message
  ];
  return fields.flatMap((field) => collectStatusStrings(field, depth + 1));
}

function threadIdFromParams(params: JsonRecord | null): string | null {
  const threadId = params?.threadId ?? params?.conversationId;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

function streamStateFromConversationState(conversationState: JsonRecord): AppThreadStreamState {
  const state = emptyAppThreadStreamState();
  const runtimeStatus = objectField(conversationState, 'threadRuntimeStatus');
  state.runtimeStatusType = statusType(runtimeStatus);
  state.isCompactingContext = statusLooksCompacting(runtimeStatus);

  trackApprovalRequests(state, arrayField(conversationState, 'requests'));

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
    trackApprovalRequestsForTurn(state, turn, turnIndex);
  });
  return state;
}

function applyStreamPatch(state: AppThreadStreamState, rawPatch: unknown): void {
  const patch = asObject(rawPatch);
  if (!patch) {
    return;
  }
  const op = typeof patch.op === 'string' ? patch.op : null;
  const path = conversationStatePatchPath(normalizedPatchPath(patch.path));
  if (path.length === 0) {
    return;
  }

  if (path[0] === 'requests') {
    applyApprovalRequestsPatch(state, path, patch.value, op);
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
    state.approvalRequestsByKey = rebuilt.approvalRequestsByKey;
    state.latestTurnIndex = rebuilt.latestTurnIndex;
    state.latestTurnStatus = rebuilt.latestTurnStatus;
    state.isCompactingContext = rebuilt.isCompactingContext;
    return;
  }

  const turnIndex = numericPathPart(path[1]);
  if (turnIndex == null) {
    return;
  }

  if (path.length === 2) {
    if (op === 'remove') {
      removeActiveItemKeysForTurn(state, turnIndex);
      removeApprovalRequestsForTurn(state, turnIndex);
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
    removeApprovalRequestsForTurn(state, turnIndex);
    trackInProgressItemsForTurn(state, turn, turnIndex);
    trackApprovalRequestsForTurn(state, turn, turnIndex);
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
    removeApprovalRequestsForTurn(state, turnIndex);
    patch.value.forEach((item, itemIndex) => {
      updateActiveItemKeyFromItem(state, turnIndex, itemIndex, item);
      updateApprovalRequestKeyFromItem(state, turnIndex, itemIndex, item);
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
      deleteApprovalRequestKey(state, itemKey);
      return;
    }
    updateActiveItemKeyFromItem(state, turnIndex, itemIndex, patch.value);
    updateApprovalRequestKeyFromItem(state, turnIndex, itemIndex, patch.value);
    return;
  }

  if (path[4] === 'status') {
    if (isActiveStatus(patch.value)) {
      state.activeItemKeys.add(itemKey);
    } else {
      state.activeItemKeys.delete(itemKey);
    }
  }
  if (path[4] === 'completed' && patch.value === true) {
    deleteApprovalRequestKey(state, itemKey);
  }
}

function applyRuntimeStatusPatch(
  state: AppThreadStreamState,
  path: unknown[],
  value: unknown
): void {
  if (path.length === 1) {
    state.runtimeStatusType = statusType(value);
    state.isCompactingContext = statusLooksCompacting(value);
    return;
  }
  if (path[1] === 'type') {
    state.runtimeStatusType = typeof value === 'string' ? value : null;
    state.isCompactingContext = statusLooksCompacting(value);
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

function trackApprovalRequests(state: AppThreadStreamState, requests: unknown[]): void {
  requests.forEach((request, requestIndex) => {
    const key = `requests.${requestIndex}`;
    const summary = pendingApprovalFromRequest(request);
    if (summary) {
      state.approvalRequestsByKey.set(key, summary);
    }
  });
}

function applyApprovalRequestsPatch(
  state: AppThreadStreamState,
  path: unknown[],
  value: unknown,
  op: string | null
): void {
  if (path.length === 1) {
    removeApprovalRequestKeysWithPrefix(state, 'requests.');
    if (Array.isArray(value)) {
      trackApprovalRequests(state, value);
    }
    return;
  }

  const requestIndex = numericPathPart(path[1]);
  if (requestIndex == null) {
    return;
  }
  const key = `requests.${requestIndex}`;

  if (path.length === 2) {
    if (op === 'remove') {
      deleteApprovalRequestKey(state, key);
      return;
    }
    const summary = pendingApprovalFromRequest(value);
    if (summary) {
      state.approvalRequestsByKey.set(key, summary);
    } else {
      deleteApprovalRequestKey(state, key);
    }
    return;
  }

  if ((path[2] === 'isCompleted' || path[2] === 'completed') && value === true) {
    deleteApprovalRequestKey(state, key);
  }
}

function trackApprovalRequestsForTurn(
  state: AppThreadStreamState,
  turn: JsonRecord,
  turnIndex: number
): void {
  const items = arrayField(turn, 'items');
  items.forEach((item, itemIndex) => {
    updateApprovalRequestKeyFromItem(state, turnIndex, itemIndex, item);
  });
}

function updateApprovalRequestKeyFromItem(
  state: AppThreadStreamState,
  turnIndex: number,
  itemIndex: number,
  item: unknown
): void {
  const key = activeItemKey(turnIndex, itemIndex);
  const summary = pendingApprovalFromItem(item, turnIndex);
  if (summary) {
    state.approvalRequestsByKey.set(key, summary);
  } else {
    deleteApprovalRequestKey(state, key);
  }
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

function removeApprovalRequestsForTurn(state: AppThreadStreamState, turnIndex: number): void {
  removeApprovalRequestKeysWithPrefix(state, `turns.${turnIndex}.items.`);
}

function removeApprovalRequestKeysWithPrefix(
  state: AppThreadStreamState,
  prefix: string
): void {
  for (const key of [...state.approvalRequestsByKey.keys()]) {
    if (key.startsWith(prefix)) {
      state.approvalRequestsByKey.delete(key);
    }
  }
}

function deleteApprovalRequestKey(state: AppThreadStreamState, key: string): void {
  state.approvalRequestsByKey.delete(key);
}

function pendingApprovalFromRequest(request: unknown): PendingApprovalRequest | null {
  const object = asObject(request);
  if (!object) {
    return null;
  }
  const method = typeof object.method === 'string' ? object.method : null;
  const id = typeof object.id === 'string' ? object.id : null;
  const isCompleted = object.isCompleted === true || object.completed === true;
  if (!method || !id || isCompleted || !APPROVAL_REQUEST_METHODS.has(method)) {
    return null;
  }
  const params = asObject(object.params) ?? undefined;
  const itemId =
    typeof params?.itemId === 'string'
      ? params.itemId
      : typeof params?.callId === 'string'
        ? params.callId
        : undefined;
  return {
    id,
    method,
    ...(params ? { params } : {}),
    ...(itemId ? { itemId } : {}),
    ...(typeof params?.turnId === 'string' ? { turnId: params.turnId } : {})
  };
}

function pendingApprovalFromItem(
  item: unknown,
  turnIndex: number
): PendingApprovalRequest | null {
  const object = asObject(item);
  if (!object) {
    return null;
  }
  const type = stringField(object, 'type') ?? stringField(object, 'action');
  if (type !== 'permissionRequest' && type !== 'permission-request') {
    return null;
  }
  if (object.completed === true) {
    return null;
  }
  const id = stringField(object, 'requestId') ?? stringField(object, 'id');
  if (!id) {
    return null;
  }
  // Items don't always carry a `turnId` field, but we know which turn they
  // came from, so we still need to surface params so the tablet can render
  // permissions/reason exactly like the request-array form.
  const reason = stringField(object, 'reason');
  const permissions = asObject(object.permissions) ?? undefined;
  const itemTurnId = stringField(object, 'turnId') ?? `turn-${turnIndex}`;
  const params: Record<string, unknown> = {
    turnId: itemTurnId,
    ...(reason ? { reason } : {}),
    ...(permissions ? { permissions } : {})
  };
  return {
    id,
    method: 'item/permissions/requestApproval',
    params,
    turnId: itemTurnId
  };
}

function activeItemKey(turnIndex: number, itemIndex: number): string {
  return `turns.${turnIndex}.items.${itemIndex}`;
}

function normalizedPatchPath(rawPath: unknown): unknown[] {
  if (Array.isArray(rawPath)) {
    return rawPath;
  }
  if (typeof rawPath !== 'string') {
    return [];
  }
  return rawPath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function conversationStatePatchPath(path: unknown[]): unknown[] {
  if (path[0] === 'conversationState') {
    return path.slice(1);
  }
  if (path[0] === 'snapshot' && path[1] === 'conversationState') {
    return path.slice(2);
  }
  if (path[0] === 'state' && path[1] === 'conversationState') {
    return path.slice(2);
  }
  return path;
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
