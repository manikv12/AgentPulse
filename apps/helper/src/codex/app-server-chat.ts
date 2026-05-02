import type {
  CatalogModel,
  ChatAttachment,
  ChatMessage,
  CollaborationModeKind,
  LiveEvent,
  PendingApprovalRequest,
  Thread,
  ThreadMessageResponse,
  ThreadSendState,
  ThreadTranscript
} from '@agent-pulse/shared';
import {
  ChatMessageSchema,
  CatalogModelSchema,
  ThreadMessageResponseSchema,
  ThreadSchema,
  ThreadTranscriptSchema
} from '@agent-pulse/shared';
import { workspaceNameFromCwd } from './thread-reader';

export type CodexAppServerTransport = {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  isConnected(): boolean;
  ensureConnected?(): Promise<void>;
  recentStderr?(): string;
  onNotification?(listener: (notification: AppServerNotification) => void): () => void;
  onServerRequest?(listener: (request: AppServerServerRequest) => void): () => void;
  onConnectionChange?(listener: (connected: boolean) => void): () => void;
  respondToServerRequest?(id: number | string, result: unknown): Promise<void>;
};

export type AppServerNotification = {
  method: string;
  params?: unknown;
};

export type AppServerServerRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

export type ThreadStartOptions = {
  /** Override the model selected for this thread. Falls back to the project's
   *  config value, then to the codex default ('gpt-5.5'). */
  model?: string;
  /** Override the reasoning effort (e.g. 'low' | 'medium' | 'high' | 'xhigh').
   *  Sent as `model_reasoning_effort` inside the thread/start `config` blob. */
  reasoningEffort?: string;
};

type TurnStartOptions = {
  model?: string;
  effort?: string;
  collaborationMode?: CollaborationModeKind;
  attachments?: ChatAttachment[];
};

type AppServerCollaborationMode = {
  mode: CollaborationModeKind;
  settings: {
    model: string;
    reasoning_effort: string | null;
    developer_instructions: null;
  };
};

type AppServerThreadResponse = {
  thread: AppServerThread;
  // The desktop's `thread/resume` response also surfaces the current model + effort at the
  // top level. We hand these through onto the transcript so the tablet's chip stays in sync
  // with what the user (or another window) selected — without relying on the broadcast.
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  permissionProfile?: unknown;
  sandbox?: unknown;
  serviceTier?: unknown;
};

type AppServerThreadTurnsListResponse = {
  data: AppServerTurn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};

type AppServerThreadLoadedListResponse = {
  data?: string[];
  // openai/codex#11786 added a parallel `statuses` array carrying the runtime
  // status for each loaded thread. Older Codex builds simply omit it, in which
  // case we fall back to the in-memory state we maintain from notifications.
  statuses?: Array<AppServerThreadStatus | undefined>;
  nextCursor?: string | null;
};

type AppServerConfigReadResponse = {
  config?: Record<string, unknown> | null;
};

type AppServerModelListResponse = {
  data?: AppServerModel[];
  nextCursor?: string | null;
};

type AppServerModel = {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: Array<{
    effort?: string;
    description?: string | null;
  }>;
  defaultReasoningEffort?: string;
  supported_reasoning_efforts?: Array<{
    effort?: string;
    description?: string | null;
  }>;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string | null;
  }>;
  default_reasoning_effort?: string;
  default_reasoning_level?: string;
};

// Mirrors the canonical `thread/start` payload that the Codex desktop app sends
// (see Hp(...) in Codex.app's vscode-api bundle). Fields that the desktop omits
// when unset (serviceTier, developerInstructions, baseInstructions) are also
// omitted here — sending them as `null` causes some Codex builds to reject the
// request during schema validation.
type AppServerThreadStartParams = {
  cwd: string;
  model: string;
  modelProvider: string | null;
  approvalsReviewer: 'user' | 'auto_review' | 'guardian_subagent';
  approvalPolicy: unknown;
  sandbox: 'danger-full-access' | 'read-only' | 'workspace-write';
  config: Record<string, unknown>;
  personality: string | null;
  ephemeral: null;
  mockExperimentalField: null;
  dynamicTools: null;
  experimentalRawEvents: false;
  persistExtendedHistory: true;
  // Optional fields — present only when the project config supplies a value.
  serviceTier?: string;
  developerInstructions?: string;
};

type AppServerThread = {
  id: string;
  status: AppServerThreadStatus;
  turns: AppServerTurn[];
  cwd?: string;
  name?: string | null;
  preview?: string;
  updatedAt?: number;
  createdAt?: number;
  // Threads created via thread/resume also carry the model + reasoning effort directly on
  // the thread object in some Codex builds.
  model?: string | null;
  reasoningEffort?: string | null;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  permissionProfile?: unknown;
  sandboxPolicy?: unknown;
  serviceTier?: unknown;
};

type AppServerThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: AppServerThreadActiveFlag[] };

type AppServerThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';

type AppServerTurn = {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  items: AppServerThreadItem[];
  startedAt: number | null;
  completedAt: number | null;
};

type AppServerThreadItem =
  | {
      type: 'userMessage';
      id: string;
      content: AppServerContentPart[];
    }
  | {
      type: 'agentMessage';
      id: string;
      text: string;
      phase?: string | null;
    }
  | {
      type: 'plan';
      id: string;
      text: string;
    }
  | {
      type: 'reasoning';
      id: string;
      summary: string[];
      content: string[];
    }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      status: string;
    }
  | {
      type: 'fileChange';
      id: string;
      status: string;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: string;
      result?: unknown;
      output?: unknown;
      content?: unknown;
    };

type AppServerLiveThreadState = {
  activeTurnId: string | null;
  isStreaming: boolean;
  isCompacting: boolean;
  pendingRequests: Map<string, PendingApprovalRequest>;
  liveMessages: Map<string, ChatMessage>;
  lastStreaming: boolean;
};

type AppServerThreadExecutionSettings = {
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  permissionProfile?: unknown;
  sandboxPolicy?: unknown;
  serviceTier?: unknown;
};

export type AppServerTurnCompletedEvent = {
  threadId: string;
  turnId: string;
};

const APP_SERVER_LIVE_TURN_PREFIX = 'app-server-live:';

function appServerLiveTurnId(threadId: string): string {
  return `${APP_SERVER_LIVE_TURN_PREFIX}${threadId}`;
}

type AppServerContentPart = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export class SendBlockedError extends Error {
  constructor(
    readonly reason: ThreadSendState['reason'],
    message: string
  ) {
    super(message);
    this.name = 'SendBlockedError';
  }
}

export class CodexAppServerChat {
  private readonly liveThreads = new Map<string, AppServerLiveThreadState>();
  private readonly threadExecutionSettings = new Map<string, AppServerThreadExecutionSettings>();
  private readonly pendingServerRequests = new Map<
    string,
    {
      rpcId: number | string;
      threadId: string;
      method: string;
      params: Record<string, unknown>;
    }
  >();
  private readonly liveEventListeners = new Set<(event: LiveEvent) => void>();
  private readonly liveStateListeners = new Set<(threadId: string) => void>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private readonly turnCompletedListeners = new Set<(event: AppServerTurnCompletedEvent) => void>();

  constructor(private readonly transport: CodexAppServerTransport) {
    this.transport.onNotification?.((notification) => this.handleNotification(notification));
    this.transport.onServerRequest?.((request) => this.handleServerRequest(request));
    this.transport.onConnectionChange?.((connected) => this.emitConnectionChange(connected));
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  recentStderr(): string {
    return this.transport.recentStderr?.() ?? '';
  }

  async ensureConnected(): Promise<void> {
    await this.transport.ensureConnected?.();
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  onLiveEvent(listener: (event: LiveEvent) => void): () => void {
    this.liveEventListeners.add(listener);
    return () => this.liveEventListeners.delete(listener);
  }

  onLiveStateChange(listener: (threadId: string) => void): () => void {
    this.liveStateListeners.add(listener);
    return () => this.liveStateListeners.delete(listener);
  }

  onTurnCompleted(listener: (event: AppServerTurnCompletedEvent) => void): () => void {
    this.turnCompletedListeners.add(listener);
    return () => this.turnCompletedListeners.delete(listener);
  }

  async readTranscript(threadId: string): Promise<ThreadTranscript> {
    const thread = await this.readThreadSnapshot(threadId);
    return mapThreadToTranscript(thread);
  }

  async readFullTranscript(threadId: string): Promise<ThreadTranscript> {
    const response = await this.transport.request<AppServerThreadResponse>('thread/read', {
      threadId,
      includeTurns: true
    });
    return mapThreadToTranscript(
      {
        ...response.thread,
        model: response.model ?? response.thread.model ?? null,
        reasoningEffort: response.reasoningEffort ?? response.thread.reasoningEffort ?? null
      },
      { messageLimit: null }
    );
  }

  async subscribeThread(threadId: string): Promise<void> {
    await this.loadExistingThread(threadId);
  }

  async listLoadedThreadIds(): Promise<Set<string>> {
    const { ids } = await this.listLoadedThreadInfo();
    return ids;
  }

  // Returns the live runtime status for every loaded thread, sourced from the
  // app-server's own `statuses` field on thread/loaded/list (openai/codex#11786).
  // Older Codex builds don't include the field — we fall back to the in-memory
  // notification-derived state in those cases (see liveStatusFor).
  async listLoadedThreadStatuses(): Promise<Map<string, Thread['status']>> {
    const { ids, statuses } = await this.listLoadedThreadInfo();
    const result = new Map<string, Thread['status']>();
    for (const threadId of ids) {
      const remote = statuses.get(threadId);
      const live = this.liveStatusFor(threadId);
      // Prefer in-memory live state when active — notifications are pushed in
      // real time and beat the snapshot returned by thread/loaded/list. The
      // remote status is a backstop for cases where we missed an event.
      result.set(threadId, live ?? (remote ? mapAppServerStatus(remote) : 'idle'));
    }
    return result;
  }

  private async listLoadedThreadInfo(): Promise<{
    ids: Set<string>;
    statuses: Map<string, AppServerThreadStatus>;
  }> {
    const ids = new Set<string>();
    const statuses = new Map<string, AppServerThreadStatus>();
    let cursor: string | null | undefined = null;
    do {
      const response: AppServerThreadLoadedListResponse =
        await this.transport.request<AppServerThreadLoadedListResponse>(
          'thread/loaded/list',
          { cursor: cursor ?? null }
        );
      const data = response.data ?? [];
      const remoteStatuses = response.statuses ?? [];
      data.forEach((threadId, index) => {
        if (!threadId.trim()) {
          return;
        }
        ids.add(threadId);
        const remote = remoteStatuses[index];
        if (remote && typeof remote === 'object' && 'type' in remote) {
          statuses.set(threadId, remote);
        }
      });
      cursor = response.nextCursor;
    } while (cursor);
    return { ids, statuses };
  }

  private liveStatusFor(threadId: string): Thread['status'] | undefined {
    if (this.isThreadWaitingForApproval(threadId)) {
      return 'waiting_approval';
    }
    if (this.isThreadCompacting(threadId)) {
      return 'compacting';
    }
    if (this.isThreadStreaming(threadId)) {
      return 'running';
    }
    return undefined;
  }

  async sendMessage(
    threadId: string,
    text: string,
    options: TurnStartOptions = {}
  ): Promise<ThreadMessageResponse> {
    const trimmed = text.trim();
    let thread: AppServerThread | undefined;
    try {
      thread = await this.loadExistingThread(threadId);
    } catch (error) {
      if (!isUnmaterializedDraftError(error)) {
        throw error;
      }
    }

    if (!thread) {
      return this.startTurnWithoutReadableHistory(threadId, trimmed, options);
    }

    const transcript = mapThreadToTranscript(thread);
    ensureCanSend(transcript.sendState);

    if (thread.status.type === 'active' && transcript.activeTurnId) {
      return this.steerActiveTurn(threadId, trimmed, transcript.activeTurnId, options.attachments);
    }

    // turn/start accepts `model` and `effort` directly. We pass the user's queued overrides
    // here so the model picker on the tablet can change models without needing a Codex
    // desktop window to own the conversation.
    const response = await this.transport.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: userTextInput(trimmed, options.attachments),
      ...turnStartOverrides(options, thread)
    });
    this.markLiveTurnStarted(threadId, response.turn.id, trimmed);
    const updatedTranscript = await this.readTranscriptAfterAcceptedSend(threadId).catch((error) => {
      if (isUnmaterializedDraftError(error)) {
        return startedDraftTranscript(threadId, trimmed, response.turn.id);
      }
      return startedDraftTranscript(threadId, trimmed, response.turn.id);
    });
    const visibleTranscript = this.applyLiveState(updatedTranscript, threadId);
    return ThreadMessageResponseSchema.parse({
      ok: true,
      mode: 'start',
      turnId: response.turn.id,
      transcript: visibleTranscript
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    const liveTurnId = this.liveThreads.get(threadId)?.activeTurnId;
    const transcriptTurnId = liveTurnId ?? (await this.readTranscript(threadId)).activeTurnId;
    if (
      !transcriptTurnId ||
      transcriptTurnId.startsWith(APP_SERVER_LIVE_TURN_PREFIX) ||
      transcriptTurnId.startsWith(APP_SERVER_ACTIVE_TURN_PREFIX)
    ) {
      throw new SendBlockedError('missing_active_turn', 'Codex is not currently running this thread.');
    }
    await this.transport.request('turn/interrupt', {
      threadId,
      turnId: transcriptTurnId
    });
    const state = this.stateForThread(threadId);
    state.activeTurnId = null;
    state.isStreaming = false;
    state.isCompacting = false;
    this.emitThreadStateChanged(threadId);
  }

  // Triggers Codex's history-compaction pipeline for the given thread. The RPC
  // is fire-and-forget — Codex emits the usual item/started + item/completed
  // notifications for the contextCompaction item, and our existing handlers
  // flip isCompacting on/off so the tablet's "Compacting" badge appears
  // automatically. Added in openai/codex#10445.
  async compactThread(threadId: string): Promise<void> {
    await this.transport.request('thread/compact/start', { threadId });
    // Optimistically flip the live state so the tablet sees the badge before
    // the server's item/started notification round-trips. handleNotification
    // will reconcile when the real notification lands.
    const state = this.stateForThread(threadId);
    state.isCompacting = true;
    state.isStreaming = true;
    this.emitThreadStateChanged(threadId);
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.transport.request('thread/archive', { threadId });
    this.liveThreads.delete(threadId);
    this.threadExecutionSettings.delete(threadId);
    this.emitLiveEvent({ type: 'thread/remove', payload: { threadId } });
    this.emitLiveStateChange(threadId);
  }

  // Kick off Codex's automated reviewer for the active branch. The response
  // shape mirrors turn/start — Codex emits the same item/started + item/completed
  // stream, so the tablet's existing transcript machinery picks the review up
  // for free.
  async startReview(threadId: string): Promise<void> {
    await this.transport.request('review/start', { threadId });
    const state = this.stateForThread(threadId);
    state.isStreaming = true;
    this.emitThreadStateChanged(threadId);
  }

  getPendingApprovalRequests(threadId: string): PendingApprovalRequest[] {
    return [...(this.liveThreads.get(threadId)?.pendingRequests.values() ?? [])];
  }

  isThreadStreaming(threadId: string): boolean {
    return this.liveThreads.get(threadId)?.isStreaming === true;
  }

  isThreadCompacting(threadId: string): boolean {
    return this.liveThreads.get(threadId)?.isCompacting === true;
  }

  isThreadWaitingForApproval(threadId: string): boolean {
    return this.getPendingApprovalRequests(threadId).length > 0;
  }

  applyLiveState(transcript: ThreadTranscript, threadId: string): ThreadTranscript {
    const state = this.liveThreads.get(threadId);
    if (!state) {
      return transcript;
    }

    const syntheticTurnId = state.activeTurnId ?? appServerLiveTurnId(threadId);
    const existingMessageIds = new Set(transcript.messages.map((message) => message.id));
    const liveMessages = [...state.liveMessages.values()].filter(
      (message) => !existingMessageIds.has(message.id) && !transcriptConfirmsLiveMessage(message, transcript.messages)
    );
    const messages = [...transcript.messages, ...liveMessages];

    if (state.pendingRequests.size > 0) {
      return ThreadTranscriptSchema.parse({
        ...transcript,
        activeTurnId: transcript.activeTurnId ?? syntheticTurnId,
        sendState: {
          canSend: false,
          reason: 'waiting_on_approval',
          label: 'Codex is waiting for approval'
        },
        messages
      });
    }

    if (state.isCompacting) {
      return ThreadTranscriptSchema.parse({
        ...transcript,
        activeTurnId: transcript.activeTurnId ?? syntheticTurnId,
        sendState: {
          canSend: false,
          reason: 'compacting_context',
          label: 'Automatically compacting context'
        },
        messages
      });
    }

    if (state.isStreaming) {
      return ThreadTranscriptSchema.parse({
        ...transcript,
        activeTurnId: transcript.activeTurnId ?? syntheticTurnId,
        sendState: transcript.activeTurnId
          ? transcript.sendState
          : {
              canSend: false,
              reason: 'thread_changed',
              label: 'Codex is working'
            },
        messages
      });
    }

    if (messages.length !== transcript.messages.length) {
      return ThreadTranscriptSchema.parse({
        ...transcript,
        messages
      });
    }

    return transcript;
  }

  async respondToApproval(
    threadId: string,
    requestId: string,
    method: string,
    response: unknown
  ): Promise<void> {
    const pending = this.pendingServerRequests.get(requestId);
    if (!pending || pending.threadId !== threadId) {
      throw new SendBlockedError(
        'thread_unavailable',
        'This approval request expired. Try the action again.'
      );
    }
    if (pending.method !== method) {
      throw new Error(`Approval method changed from ${pending.method} to ${method}.`);
    }
    if (!this.transport.respondToServerRequest) {
      throw new Error('Codex app-server transport cannot answer approval requests.');
    }

    await this.transport.respondToServerRequest(
      pending.rpcId,
      approvalResponseForServerRequest(method, response, pending.params)
    );
    this.pendingServerRequests.delete(requestId);
    this.stateForThread(threadId).pendingRequests.delete(requestId);
    this.emitThreadStateChanged(threadId);
  }

  async listModels(): Promise<CatalogModel[]> {
    const models: CatalogModel[] = [];
    let cursor: string | null | undefined = null;
    do {
      const response: AppServerModelListResponse =
        await this.transport.request<AppServerModelListResponse>('model/list', {
        cursor: cursor ?? null,
        includeHidden: false
      });
      for (const model of response.data ?? []) {
        const modelRecord = model as Record<string, unknown>;
        const slug = model.model?.trim() || model.id?.trim();
        if (!slug) {
          continue;
        }
        const defaultReasoningLevel =
          model.defaultReasoningEffort ??
          stringField(modelRecord, 'defaultReasoningEffort') ??
          model.default_reasoning_effort ??
          model.default_reasoning_level;
        const supportedReasoningLevels = normalizeReasoningEfforts(
          model.supportedReasoningEfforts ??
            model.supported_reasoning_efforts ??
            model.supported_reasoning_levels ??
            arrayField(modelRecord, 'supportedReasoningEfforts') ??
            arrayField(modelRecord, 'supported_reasoning_efforts') ??
            arrayField(modelRecord, 'supported_reasoning_levels')
        );
        models.push(
          CatalogModelSchema.parse({
            slug,
            displayName: model.displayName || slug,
            ...(model.description ? { description: model.description } : {}),
            ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
            supportedReasoningLevels,
            visibility: model.hidden ? 'hidden' : 'visible'
          })
        );
      }
      cursor = response.nextCursor;
    } while (cursor);
    return models;
  }

  async startThread(cwd: string, options: ThreadStartOptions = {}): Promise<Thread> {
    let params = await this.buildThreadStartParams(cwd, options);
    let response: AppServerThreadResponse;
    try {
      response = await this.callThreadStart(params);
    } catch (error) {
      if (!isAppServerDisconnectedError(error)) {
        throw this.withThreadStartContext(error, params);
      }
      // The subprocess died — re-read config and rebuild params for the retry.
      params = await this.buildThreadStartParams(cwd, options);
      try {
        response = await this.callThreadStart(params);
      } catch (retryError) {
        throw this.withThreadStartContext(retryError, params);
      }
    }
    if (!response || typeof response !== 'object' || !response.thread) {
      const stderr = this.recentStderr();
      throw new Error(
        `Codex thread/start returned an unexpected response: ${JSON.stringify(response)}${
          stderr ? ` — codex stderr: ${stderr}` : ''
        } — params: ${JSON.stringify(params)}`
      );
    }
    this.cacheThreadExecutionSettings(response);
    return mapAppServerThreadToSummary(response.thread, cwd);
  }

  private async callThreadStart(
    params: AppServerThreadStartParams
  ): Promise<AppServerThreadResponse> {
    return this.transport.request<AppServerThreadResponse>('thread/start', params);
  }

  private withThreadStartContext(error: unknown, params: AppServerThreadStartParams): Error {
    const stderr = this.recentStderr();
    const detail = error instanceof Error ? error.message : String(error);
    const stderrPart = stderr ? ` — codex stderr: ${stderr}` : '';
    return new Error(`${detail}${stderrPart} — thread/start params: ${JSON.stringify(params)}`);
  }

  private async buildThreadStartParams(
    cwd: string,
    options: ThreadStartOptions = {}
  ): Promise<AppServerThreadStartParams> {
    const config = await this.readCodexConfig(cwd);
    const sandbox = sandboxFromConfig(config);
    const developerInstructions = stringField(config, 'developer_instructions');
    const serviceTier =
      stringField(config, 'service_tier') ?? stringField(config, 'model_service_tier');
    const model = options.model?.trim() || stringField(config, 'model') || 'gpt-5.5';
    const threadConfig = threadStartConfigFromCodexConfig(config);
    if (options.reasoningEffort?.trim()) {
      threadConfig.model_reasoning_effort = options.reasoningEffort.trim();
    }
    return {
      cwd,
      model,
      modelProvider: stringField(config, 'model_provider') ?? null,
      approvalsReviewer: 'user',
      approvalPolicy: approvalPolicyFromConfig(config, sandbox),
      sandbox,
      config: threadConfig,
      personality: stringField(config, 'personality') ?? null,
      ephemeral: null,
      mockExperimentalField: null,
      dynamicTools: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      ...(serviceTier ? { serviceTier } : {}),
      ...(developerInstructions ? { developerInstructions } : {})
    };
  }

  private async readCodexConfig(cwd: string): Promise<Record<string, unknown>> {
    try {
      const response = await this.transport.request<AppServerConfigReadResponse>('config/read', {
        includeLayers: false,
        cwd
      });
      return recordField(response, 'config') ?? {};
    } catch {
      return {};
    }
  }

  private async steerActiveTurn(
    threadId: string,
    text: string,
    activeTurnId: string | null,
    attachments: ChatAttachment[] | undefined
  ): Promise<ThreadMessageResponse> {
    if (!activeTurnId) {
      throw new SendBlockedError(
        'missing_active_turn',
        'Codex is running but Agent Pulse cannot find the active turn.'
      );
    }

    try {
      return await this.callTurnSteer(threadId, text, activeTurnId, attachments);
    } catch {
      const refreshed = await this.loadExistingThread(threadId);
      const refreshedTranscript = mapThreadToTranscript(refreshed);
      ensureCanSend(refreshedTranscript.sendState);

      if (refreshedTranscript.activeTurnId && refreshedTranscript.activeTurnId !== activeTurnId) {
        return this.callTurnSteer(threadId, text, refreshedTranscript.activeTurnId, attachments);
      }

      throw new SendBlockedError('thread_changed', 'Thread changed. Try again.');
    }
  }

  private async callTurnSteer(
    threadId: string,
    text: string,
    expectedTurnId: string,
    attachments: ChatAttachment[] | undefined
  ): Promise<ThreadMessageResponse> {
    const response = await this.transport.request<{ turnId: string }>('turn/steer', {
      threadId,
      input: userTextInput(text, attachments),
      expectedTurnId
    });
    const updatedTranscript = await this.readTranscriptAfterAcceptedSend(threadId).catch(() =>
      startedDraftTranscript(threadId, text, response.turnId)
    );
    return ThreadMessageResponseSchema.parse({
      ok: true,
      mode: 'steer',
      turnId: response.turnId,
      transcript: this.applyLiveState(updatedTranscript, threadId)
    });
  }

  private async startTurnWithoutReadableHistory(
    threadId: string,
    text: string,
    options: TurnStartOptions
  ): Promise<ThreadMessageResponse> {
    const response = await this.transport.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: userTextInput(text, options.attachments),
      ...turnStartOverrides(options, undefined, this.threadExecutionSettings.get(threadId))
    });
    this.markLiveTurnStarted(threadId, response.turn.id, text);
    const transcript = await this.readTranscriptAfterAcceptedSend(threadId).catch((error) => {
      if (isUnmaterializedDraftError(error)) {
        return startedDraftTranscript(threadId, text, response.turn.id);
      }
      return startedDraftTranscript(threadId, text, response.turn.id);
    });
    return ThreadMessageResponseSchema.parse({
      ok: true,
      mode: 'start',
      turnId: response.turn.id,
      transcript: this.applyLiveState(transcript, threadId)
    });
  }

  private async readTranscriptAfterAcceptedSend(threadId: string): Promise<ThreadTranscript> {
    return promiseWithTimeout(
      this.readTranscript(threadId),
      1_500,
      'Codex accepted the message, but transcript refresh was slow.'
    );
  }

  private async loadExistingThread(threadId: string): Promise<AppServerThread> {
    try {
      const [resumeResponse, turns] = await Promise.all([
        this.transport.request<AppServerThreadResponse>('thread/resume', {
          threadId,
          excludeTurns: true,
          persistExtendedHistory: true
        }),
        this.loadRecentTurns(threadId).catch(() => [] as AppServerTurn[])
      ]);
      // The current model/effort are returned at the response level (alongside `thread`).
      // We bake them onto the thread object so mapThreadToTranscript can surface them.
      this.cacheThreadExecutionSettings(resumeResponse);
      return {
        ...resumeResponse.thread,
        turns,
        model: resumeResponse.model ?? resumeResponse.thread.model ?? null,
        reasoningEffort: resumeResponse.reasoningEffort ?? resumeResponse.thread.reasoningEffort ?? null,
        ...executionSettingsFromThreadResponse(resumeResponse)
      };
    } catch {
      const response = await this.transport.request<AppServerThreadResponse>('thread/read', {
        threadId,
        includeTurns: true
      });
      return {
        ...response.thread,
        turns: recentTurns(response.thread.turns),
        model: response.model ?? response.thread.model ?? null,
        reasoningEffort: response.reasoningEffort ?? response.thread.reasoningEffort ?? null,
        ...this.threadExecutionSettings.get(threadId)
      };
    }
  }

  private async readThreadSnapshot(threadId: string): Promise<AppServerThread> {
    const response = await this.transport.request<AppServerThreadResponse>('thread/read', {
      threadId,
      includeTurns: true
    });
    return {
      ...response.thread,
      turns: recentTurns(response.thread.turns),
      model: response.model ?? response.thread.model ?? null,
      reasoningEffort: response.reasoningEffort ?? response.thread.reasoningEffort ?? null,
      ...this.threadExecutionSettings.get(threadId)
    };
  }

  private cacheThreadExecutionSettings(response: AppServerThreadResponse): void {
    const threadId = response.thread?.id;
    if (!threadId) {
      return;
    }
    const settings = executionSettingsFromThreadResponse(response);
    if (Object.keys(settings).length > 0) {
      this.threadExecutionSettings.set(threadId, settings);
    }
  }

  private async loadRecentTurns(threadId: string): Promise<AppServerTurn[]> {
    const response = await this.transport.request<AppServerThreadTurnsListResponse>('thread/turns/list', {
      threadId,
      limit: 24,
      sortDirection: 'desc'
    });
    return recentTurns(response.data);
  }

  private handleNotification(notification: AppServerNotification): void {
    const params = recordFromUnknown(notification.params);
    const threadId = this.threadIdForNotification(params);
    if (!threadId) {
      return;
    }

    const state = this.stateForThread(threadId);
    if (notification.method === 'turn/started') {
      const turn = recordFromUnknown(params.turn);
      this.markLiveTurnStarted(
        threadId,
        stringField(turn, 'id') ?? state.activeTurnId ?? appServerLiveTurnId(threadId)
      );
      return;
    }

    if (notification.method === 'turn/completed') {
      const turn = recordFromUnknown(params.turn);
      const turnId = stringField(params, 'turnId') ?? stringField(turn, 'id') ?? state.activeTurnId;
      state.activeTurnId = null;
      state.isStreaming = false;
      state.isCompacting = false;
      // Clear the live-messages buffer once the turn is fully persisted.
      // Without this, messages from an earlier turn keep getting re-appended
      // by applyLiveState onto every later turn's transcript — visible as a
      // duplicate previous assistant reply showing up under the new user
      // message.
      state.liveMessages.clear();
      this.emitThreadStateChanged(threadId);
      if (turnId) {
        this.emitTurnCompleted({ threadId, turnId });
      }
      return;
    }

    if (notification.method === 'thread/status/changed') {
      const status = recordFromUnknown(params.status);
      const type = stringField(status, 'type');
      const activeFlags = arrayField(status, 'activeFlags')
        .filter((flag): flag is string => typeof flag === 'string');
      // thread/status/changed is the only notification that should toggle isStreaming
      // off — short-lived events like item/completed and serverRequest/resolved happen
      // many times inside one turn, and using them to clear isStreaming makes the
      // tablet's working badge flicker. Any active flag (running, waitingOnApproval,
      // waitingOnUserInput) keeps the thread in a working state.
      const shouldKeepActiveTurn = type !== 'active' && state.activeTurnId !== null;
      state.isStreaming = type === 'active' || shouldKeepActiveTurn;
      if (type !== 'active' && !shouldKeepActiveTurn) {
        state.activeTurnId = null;
        state.isCompacting = false;
      }
      const visibleType = shouldKeepActiveTurn ? 'active' : type;
      this.emitLiveEvent({
        type: 'thread/status/changed',
        payload: {
          threadId,
          status: mapAppServerStatus({ type: visibleType, activeFlags } as AppServerThreadStatus)
        }
      });
      this.emitThreadStateChanged(threadId);
      return;
    }

    if (notification.method === 'serverRequest/resolved') {
      const requestId = String(params.requestId ?? '');
      if (requestId) {
        state.pendingRequests.delete(requestId);
        this.pendingServerRequests.delete(requestId);
        // Don't drop isStreaming here — resolving an approval request mid-turn
        // doesn't mean Codex stopped working; it's about to keep going. The next
        // thread/status/changed will tell us when work actually ends.
        this.emitThreadStateChanged(threadId);
      }
      return;
    }

    if (notification.method === 'thread/compacted') {
      state.isCompacting = false;
      this.emitThreadStateChanged(threadId);
      return;
    }

    if (notification.method === 'thread/archived') {
      this.liveThreads.delete(threadId);
      this.threadExecutionSettings.delete(threadId);
      this.emitLiveEvent({ type: 'thread/remove', payload: { threadId } });
      this.emitLiveStateChange(threadId);
      return;
    }

    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      this.handleItemNotification(threadId, notification.method, params);
      return;
    }

    if (
      notification.method === 'item/agentMessage/delta' ||
      notification.method === 'item/plan/delta' ||
      notification.method === 'item/commandExecution/outputDelta' ||
      notification.method === 'command/exec/outputDelta' ||
      notification.method === 'item/fileChange/outputDelta'
    ) {
      this.handleTextDeltaNotification(threadId, notification.method, params);
      return;
    }

    if (
      notification.method === 'item/fileChange/patchUpdated' ||
      notification.method === 'turn/diff/updated'
    ) {
      this.emitLiveStateChange(threadId);
      return;
    }

    if (notification.method === 'turn/plan/updated') {
      this.handlePlanUpdatedNotification(threadId, params);
    }
  }

  private threadIdForNotification(params: Record<string, unknown>): string | undefined {
    const threadId = stringField(params, 'threadId');
    if (threadId) {
      return threadId;
    }
    const conversationId = stringField(params, 'conversationId');
    if (conversationId) {
      return conversationId;
    }
    const turnId = stringField(params, 'turnId');
    if (!turnId) {
      return undefined;
    }
    for (const [candidateThreadId, state] of this.liveThreads.entries()) {
      if (state.activeTurnId === turnId) {
        return candidateThreadId;
      }
    }
    return undefined;
  }

  private handleServerRequest(request: AppServerServerRequest): void {
    const params = recordFromUnknown(request.params);
    const threadId = stringField(params, 'threadId') ?? stringField(params, 'conversationId');
    if (!threadId) {
      return;
    }
    const requestId = String(request.id);
    const itemId = stringField(params, 'itemId') ?? stringField(params, 'callId');
    const turnId = stringField(params, 'turnId');
    const pending = {
      id: requestId,
      method: request.method,
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(itemId ? { itemId } : {}),
      ...(turnId ? { turnId } : {})
    };
    const parsed = pending as PendingApprovalRequest;
    this.pendingServerRequests.set(requestId, {
      rpcId: request.id,
      threadId,
      method: request.method,
      params
    });
    const state = this.stateForThread(threadId);
    state.pendingRequests.set(requestId, parsed);
    state.activeTurnId = stringField(params, 'turnId') ?? state.activeTurnId ?? appServerLiveTurnId(threadId);
    state.isStreaming = true;
    this.emitThreadStateChanged(threadId);
  }

  private handleItemNotification(
    threadId: string,
    method: 'item/started' | 'item/completed',
    params: Record<string, unknown>
  ): void {
    const item = recordFromUnknown(params.item);
    if (!item) {
      return;
    }
    const state = this.stateForThread(threadId);
    state.activeTurnId = stringField(params, 'turnId') ?? state.activeTurnId ?? appServerLiveTurnId(threadId);
    state.isStreaming = true;

    if (stringField(item, 'type') === 'contextCompaction') {
      state.isCompacting = method === 'item/started';
      this.emitThreadStateChanged(threadId);
      return;
    }

    const message = messageFromAppServerItem(item, new Date().toISOString());
    if (message) {
      state.liveMessages.set(message.id, message);
    }
    this.emitThreadStateChanged(threadId);
  }

  private handleTextDeltaNotification(
    threadId: string,
    method: string,
    params: Record<string, unknown>
  ): void {
    const itemId = stringField(params, 'itemId');
    const delta = stringField(params, 'delta');
    if (!itemId || !delta) {
      return;
    }
    const state = this.stateForThread(threadId);
    state.activeTurnId = stringField(params, 'turnId') ?? state.activeTurnId ?? appServerLiveTurnId(threadId);
    state.isStreaming = true;
    const existing = state.liveMessages.get(itemId);
    const kind =
      method === 'item/agentMessage/delta'
        ? 'message'
        : method === 'item/plan/delta'
          ? 'plan'
          : method.includes('fileChange')
            ? 'file'
            : 'command';
    const role = kind === 'message' ? 'assistant' : 'activity';
    state.liveMessages.set(
      itemId,
      ChatMessageSchema.parse({
        id: itemId,
        role,
        kind,
        text: `${existing?.text ?? ''}${delta}`,
        createdAt: existing?.createdAt ?? new Date().toISOString()
      })
    );
    this.emitThreadStateChanged(threadId);
  }

  private handlePlanUpdatedNotification(
    threadId: string,
    params: Record<string, unknown>
  ): void {
    const state = this.stateForThread(threadId);
    const turnId = stringField(params, 'turnId') ?? state.activeTurnId ?? appServerLiveTurnId(threadId);
    const text = planTextFromUpdatedNotification(params);
    if (!text) {
      this.emitLiveStateChange(threadId);
      return;
    }

    state.activeTurnId = turnId;
    state.isStreaming = true;
    state.liveMessages.set(
      `plan:${turnId}`,
      ChatMessageSchema.parse({
        id: `plan:${turnId}`,
        role: 'activity',
        kind: 'plan',
        text,
        createdAt: new Date().toISOString()
      })
    );
    this.emitThreadStateChanged(threadId);
  }

  private markLiveTurnStarted(threadId: string, turnId: string, userText?: string): void {
    const state = this.stateForThread(threadId);
    state.activeTurnId = turnId;
    state.isStreaming = true;
    if (userText?.trim()) {
      state.liveMessages.set(`user:${turnId}`, userMessageForStartedTurn(turnId, userText));
    }
    this.emitThreadStateChanged(threadId);
  }

  private stateForThread(threadId: string): AppServerLiveThreadState {
    const existing = this.liveThreads.get(threadId);
    if (existing) {
      return existing;
    }
    const created: AppServerLiveThreadState = {
      activeTurnId: null,
      isStreaming: false,
      isCompacting: false,
      pendingRequests: new Map(),
      liveMessages: new Map(),
      lastStreaming: false
    };
    this.liveThreads.set(threadId, created);
    return created;
  }

  private emitThreadStateChanged(threadId: string): void {
    const state = this.stateForThread(threadId);
    if (state.lastStreaming !== state.isStreaming) {
      state.lastStreaming = state.isStreaming;
      this.emitLiveEvent({
        type: 'thread/streaming-changed',
        payload: { threadId, isStreaming: state.isStreaming }
      });
    }
    this.emitLiveEvent({
      type: 'thread/pending-approvals/changed',
      payload: { threadId, requests: this.getPendingApprovalRequests(threadId) }
    });
    this.emitLiveStateChange(threadId);
  }

  private emitLiveEvent(event: LiveEvent): void {
    for (const listener of this.liveEventListeners) {
      listener(event);
    }
  }

  private emitLiveStateChange(threadId: string): void {
    for (const listener of this.liveStateListeners) {
      listener(threadId);
    }
  }

  private emitConnectionChange(connected: boolean): void {
    for (const listener of this.connectionListeners) {
      listener(connected);
    }
  }

  private emitTurnCompleted(event: AppServerTurnCompletedEvent): void {
    for (const listener of this.turnCompletedListeners) {
      listener(event);
    }
  }
}

function normalizeReasoningEfforts(
  efforts: Array<{ effort?: string; description?: string | null }> | unknown[]
): Array<{ effort: string; description?: string }> {
  return efforts
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return undefined;
      }
      const record = entry as Record<string, unknown>;
      const effort = stringField(record, 'effort');
      if (!effort) {
        return undefined;
      }
      const description = stringField(record, 'description');
      return description ? { effort, description } : { effort };
    })
    .filter((entry): entry is { effort: string; description?: string } => Boolean(entry));
}

function mapAppServerThreadToSummary(thread: AppServerThread, fallbackCwd?: string): Thread {
  if (!thread.id || typeof thread.id !== 'string') {
    throw new Error(`Codex thread/start response missing thread id: ${JSON.stringify(thread)}`);
  }
  const cwd = thread.cwd ?? fallbackCwd ?? 'Unknown workspace';
  const updatedAt = thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000;

  return ThreadSchema.parse({
    threadId: thread.id,
    provider: 'codex',
    providerThreadId: thread.id,
    title: thread.name || thread.preview || 'New thread',
    workspace: workspaceNameFromCwd(cwd),
    workspacePath: cwd,
    status: mapAppServerStatus(thread.status),
    lastActivityAt: new Date(updatedAt * 1000).toISOString(),
    lastTurnSummary: ''
  });
}

function mapAppServerStatus(status: AppServerThreadStatus | undefined): Thread['status'] {
  switch (status?.type) {
    case 'active':
      // Codex emits two "blocked but still active" flags. We surface both as
      // waiting_approval so the tablet shows the attention badge and disables the
      // composer, matching what sendStateForThread already does for the transcript
      // path. waitingOnUserInput means Codex needs the user to answer something on
      // the Mac (e.g. an MCP elicitation), waitingOnApproval means it needs an
      // approval click for a tool/file/permission change.
      return status.activeFlags.includes('waitingOnApproval') ||
        status.activeFlags.includes('waitingOnUserInput')
        ? 'waiting_approval'
        : 'running';
    case 'systemError':
      return 'error';
    case 'idle':
      return 'idle';
    case 'notLoaded':
    default:
      return 'idle';
  }
}

function ensureCanSend(sendState: ThreadSendState): void {
  if (!sendState.canSend) {
    throw new SendBlockedError(sendState.reason, sendState.label);
  }
}

function isUnmaterializedDraftError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('not materialized yet') ||
    message.includes('no rollout found for thread id')
  );
}

function isAppServerDisconnectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Codex App Server disconnected');
}

function startedDraftTranscript(threadId: string, text: string, turnId: string): ThreadTranscript {
  return ThreadTranscriptSchema.parse({
    threadId,
    provider: 'codex',
    providerThreadId: threadId,
    activeTurnId: turnId,
    sendState: {
      canSend: false,
      reason: 'missing_active_turn',
      label: 'Codex is working'
    },
    messages: [userMessageForStartedTurn(turnId, text)]
  });
}

function userMessageForStartedTurn(turnId: string, text: string): ChatMessage {
  return ChatMessageSchema.parse({
    id: `user:${turnId}`,
    role: 'user',
    kind: 'message',
    text,
    createdAt: new Date().toISOString()
  });
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function transcriptConfirmsLiveMessage(liveMessage: ChatMessage, transcriptMessages: ChatMessage[]): boolean {
  if (liveMessage.role !== 'user') {
    return false;
  }
  const liveCreatedAt = Date.parse(liveMessage.createdAt);
  const minCreatedAt = Number.isFinite(liveCreatedAt) ? liveCreatedAt - 10_000 : 0;
  const liveText = liveMessage.text.trim();
  if (!liveText) {
    return false;
  }
  return transcriptMessages.some((message) => {
    if (message.role !== 'user' || message.text.trim() !== liveText) {
      return false;
    }
    const messageCreatedAt = Date.parse(message.createdAt);
    return !Number.isFinite(messageCreatedAt) || messageCreatedAt >= minCreatedAt;
  });
}

function userTextInput(text: string, attachments: ChatAttachment[] = []) {
  const input: Record<string, unknown>[] = [];
  if (text.trim()) {
    input.push({
      type: 'text',
      text,
      text_elements: []
    });
  }
  for (const attachment of attachments) {
    if (!attachment.url) {
      continue;
    }
    input.push({
      type: 'input_image',
      image_url: {
        url: attachment.url
      }
    });
  }
  return input.length > 0
    ? input
    : [
        {
          type: 'text',
          text,
          text_elements: []
        }
      ];
}

function turnStartOverrides(
  options: TurnStartOptions,
  thread?: AppServerThread,
  fallbackSettings: AppServerThreadExecutionSettings = {}
): Record<string, unknown> {
  const model = options.model?.trim() || stringFieldFromMaybe(thread?.model) || 'gpt-5.5';
  const effort = options.effort?.trim() || stringFieldFromMaybe(thread?.reasoningEffort) || null;
  const settings = thread ? executionSettingsFromThread(thread) : fallbackSettings;
  return {
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...turnStartPermissionOverrides(settings),
    ...(options.collaborationMode
      ? { collaborationMode: collaborationModePayload(options.collaborationMode, model, effort) }
      : {})
  };
}

function executionSettingsFromThread(thread: AppServerThread): AppServerThreadExecutionSettings {
  return {
    approvalPolicy: thread.approvalPolicy,
    approvalsReviewer: thread.approvalsReviewer,
    permissionProfile: thread.permissionProfile,
    sandboxPolicy: thread.sandboxPolicy,
    serviceTier: thread.serviceTier
  };
}

function executionSettingsFromThreadResponse(
  response: AppServerThreadResponse
): AppServerThreadExecutionSettings {
  return {
    ...(valueIsPresent(response.approvalPolicy)
      ? { approvalPolicy: response.approvalPolicy }
      : {}),
    ...(valueIsPresent(response.approvalsReviewer)
      ? { approvalsReviewer: response.approvalsReviewer }
      : {}),
    ...(valueIsPresent(response.permissionProfile)
      ? { permissionProfile: response.permissionProfile }
      : {}),
    ...(valueIsPresent(response.permissionProfile) ? {} : sandboxPolicyOverride(response.sandbox)),
    ...(valueIsPresent(response.serviceTier) ? { serviceTier: response.serviceTier } : {})
  };
}

function turnStartPermissionOverrides(
  settings: AppServerThreadExecutionSettings
): Record<string, unknown> {
  return {
    ...(valueIsPresent(settings.approvalPolicy)
      ? { approvalPolicy: settings.approvalPolicy }
      : {}),
    ...(valueIsPresent(settings.approvalsReviewer)
      ? { approvalsReviewer: settings.approvalsReviewer }
      : {}),
    ...(valueIsPresent(settings.permissionProfile)
      ? { permissionProfile: settings.permissionProfile }
      : {}),
    ...(valueIsPresent(settings.permissionProfile) || !valueIsPresent(settings.sandboxPolicy)
      ? {}
      : { sandboxPolicy: settings.sandboxPolicy }),
    ...(valueIsPresent(settings.serviceTier) ? { serviceTier: settings.serviceTier } : {})
  };
}

function sandboxPolicyOverride(sandbox: unknown): AppServerThreadExecutionSettings {
  const sandboxPolicy = sandboxPolicyFromUnknown(sandbox);
  return valueIsPresent(sandboxPolicy) ? { sandboxPolicy } : {};
}

function sandboxPolicyFromUnknown(sandbox: unknown): unknown {
  if (sandbox && typeof sandbox === 'object' && !Array.isArray(sandbox)) {
    return sandbox;
  }
  if (typeof sandbox !== 'string') {
    return undefined;
  }
  switch (sandbox) {
    case 'danger-full-access':
    case 'dangerFullAccess':
    case 'danger_full_access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
    case 'readOnly':
    case 'read_only':
      return { type: 'readOnly' };
    case 'workspace-write':
    case 'workspaceWrite':
    case 'workspace_write':
      return { type: 'workspaceWrite' };
    default:
      return undefined;
  }
}

function valueIsPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function collaborationModePayload(
  mode: CollaborationModeKind,
  model: string,
  effort: string | null
): AppServerCollaborationMode {
  return {
    mode,
    settings: {
      model,
      reasoning_effort: effort,
      developer_instructions: null
    }
  };
}

function stringFieldFromMaybe(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function planTextFromUpdatedNotification(params: Record<string, unknown>): string {
  const lines: string[] = [];
  const explanation = stringField(params, 'explanation');
  if (explanation) {
    lines.push(explanation);
  }

  const planLines = arrayField(params, 'plan')
    .map((entry) => recordFromUnknown(entry))
    .map((entry) => {
      const step = stringField(entry, 'step');
      if (!step) {
        return undefined;
      }
      const status = stringField(entry, 'status') ?? 'pending';
      const marker =
        status === 'completed'
          ? 'x'
          : status === 'inProgress' || status === 'in_progress'
            ? '*'
            : ' ';
      return `[${marker}] ${step}`;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length > 0 && planLines.length > 0) {
    lines.push('');
  }
  lines.push(...planLines);
  return lines.join('\n').trim();
}

function sandboxFromConfig(config: Record<string, unknown>): AppServerThreadStartParams['sandbox'] {
  const raw = stringField(config, 'sandbox_mode');
  switch (raw) {
    case 'danger-full-access':
    case 'dangerFullAccess':
    case 'danger_full_access':
      return 'danger-full-access';
    case 'read-only':
    case 'readOnly':
    case 'read_only':
      return 'read-only';
    case 'workspace-write':
    case 'workspaceWrite':
    case 'workspace_write':
      return 'workspace-write';
    default:
      return 'workspace-write';
  }
}

function approvalPolicyFromConfig(
  config: Record<string, unknown>,
  sandbox: AppServerThreadStartParams['sandbox']
): unknown {
  const raw = config.approval_policy;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }
  return sandbox === 'danger-full-access' ? 'never' : 'on-request';
}

function threadStartConfigFromCodexConfig(config: Record<string, unknown>): Record<string, unknown> {
  const threadConfig: Record<string, unknown> = {};
  const reasoningEffort = stringField(config, 'model_reasoning_effort');
  if (reasoningEffort) {
    threadConfig.model_reasoning_effort = reasoningEffort;
  }
  const webSearch = stringField(config, 'web_search');
  if (webSearch) {
    threadConfig.web_search = webSearch;
  }
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('features.') && typeof value === 'boolean') {
      threadConfig[key] = value;
    }
  }
  return threadConfig;
}

type TranscriptMapOptions = {
  messageLimit?: number | null;
};

const APP_SERVER_ACTIVE_TURN_PREFIX = 'app-server-active:';

function appServerActiveTurnId(threadId: string): string {
  return `${APP_SERVER_ACTIVE_TURN_PREFIX}${threadId}`;
}

function mapThreadToTranscript(
  thread: AppServerThread,
  options: TranscriptMapOptions = {}
): ThreadTranscript {
  const inProgressTurn = thread.turns.find((turn) => turn.status === 'inProgress') ?? null;
  const activeTurnId =
    inProgressTurn?.id ?? (thread.status.type === 'active' ? appServerActiveTurnId(thread.id) : null);
  const sendState = sendStateForThread(thread, inProgressTurn);
  const allMessages = thread.turns.flatMap((turn) => mapTurnMessages(turn));
  const messageLimit = options.messageLimit === undefined ? 180 : options.messageLimit;
  const messages = messageLimit === null ? allMessages : allMessages.slice(-messageLimit);
  const model = typeof thread.model === 'string' && thread.model.trim() ? thread.model.trim() : undefined;
  const reasoningEffort =
    typeof thread.reasoningEffort === 'string' && thread.reasoningEffort.trim()
      ? thread.reasoningEffort.trim()
      : undefined;

  return ThreadTranscriptSchema.parse({
    threadId: thread.id,
    provider: 'codex',
    providerThreadId: thread.id,
    activeTurnId,
    sendState,
    messages,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  });
}

function sendStateForThread(thread: AppServerThread, activeTurn: AppServerTurn | null): ThreadSendState {
  if (thread.status.type === 'systemError') {
    return {
      canSend: false,
      reason: 'thread_unavailable',
      label: 'Codex thread is unavailable.'
    };
  }

  if (thread.status.type === 'active') {
    if (thread.status.activeFlags.includes('waitingOnApproval')) {
      return {
        canSend: false,
        reason: 'waiting_on_approval',
        label: 'Approve on Mac to continue.'
      };
    }

    if (thread.status.activeFlags.includes('waitingOnUserInput')) {
      return {
        canSend: false,
        reason: 'waiting_on_user_input',
        label: 'Codex needs input on the Mac.'
      };
    }

    if (!activeTurn) {
      return {
        canSend: false,
        reason: 'missing_active_turn',
        label: 'Codex is working'
      };
    }
  }

  return {
    canSend: true,
    reason: 'ready',
    label: 'Ready'
  };
}

function recentTurns(turns: AppServerTurn[]): AppServerTurn[] {
  return [...turns]
    .sort((left, right) => turnTimestamp(left) - turnTimestamp(right))
    .slice(-12);
}

function turnTimestamp(turn: AppServerTurn): number {
  return turn.startedAt ?? turn.completedAt ?? 0;
}

function mapTurnMessages(turn: AppServerTurn): ChatMessage[] {
  const createdAt = timestampFromTurn(turn);
  return turn.items
    .map((item): ChatMessage | undefined => {
      if (item.type === 'userMessage') {
        const attachments = imageAttachmentsFromUnknown(item.content, item.id, 'Attached screenshot');
        return withAttachments({
          id: item.id,
          role: 'user',
          kind: 'message',
          text: item.content
            .filter(
              (content) =>
                (content.type === 'text' || content.type === 'input_text') &&
                typeof content.text === 'string'
            )
            .map((content) => content.text)
            .join('\n'),
          createdAt
        }, attachments);
      }

      if (item.type === 'agentMessage') {
        return {
          id: item.id,
          role: 'assistant',
          kind: 'message',
          text: item.text,
          ...(item.phase ? { phase: item.phase } : {}),
          createdAt
        };
      }

      if (item.type === 'plan') {
        return {
          id: item.id,
          role: 'activity',
          kind: 'plan',
          text: item.text,
          createdAt
        };
      }

      if (item.type === 'reasoning') {
        return {
          id: item.id,
          role: 'activity',
          kind: 'reasoning',
          text: [...item.summary, ...item.content].join('\n'),
          createdAt
        };
      }

      if (item.type === 'commandExecution') {
        return {
          id: item.id,
          role: 'activity',
          kind: 'command',
          text: item.command,
          createdAt
        };
      }

      if (item.type === 'fileChange') {
        return {
          id: item.id,
          role: 'activity',
          kind: 'file',
          text: `File change ${item.status}`,
          createdAt
        };
      }

      if (item.type === 'mcpToolCall') {
        const attachments = imageAttachmentsFromUnknown(
          [item.result, item.output, item.content],
          item.id,
          `${item.server}.${item.tool} screenshot`
        );
        return withAttachments({
          id: item.id,
          role: 'activity',
          kind: 'tool',
          text: `${item.server}.${item.tool} ${item.status}`,
          createdAt
        }, attachments);
      }

      return undefined;
    })
    .filter(
      (message): message is ChatMessage =>
        Boolean(message && (message.text.trim() || (message.attachments?.length ?? 0) > 0))
    );
}

function messageFromAppServerItem(
  item: Record<string, unknown>,
  createdAt: string
): ChatMessage | undefined {
  const id = stringField(item, 'id');
  const type = stringField(item, 'type');
  if (!id || !type) {
    return undefined;
  }

  if (type === 'agentMessage') {
    return ChatMessageSchema.parse({
      id,
      role: 'assistant',
      kind: 'message',
      text: stringField(item, 'text') ?? '',
      ...(stringField(item, 'phase') ? { phase: stringField(item, 'phase') } : {}),
      createdAt
    });
  }

  if (type === 'plan') {
    return ChatMessageSchema.parse({
      id,
      role: 'activity',
      kind: 'plan',
      text: stringField(item, 'text') ?? '',
      createdAt
    });
  }

  if (type === 'reasoning') {
    return ChatMessageSchema.parse({
      id,
      role: 'activity',
      kind: 'reasoning',
      text: [
        ...arrayField(item, 'summary').filter((entry): entry is string => typeof entry === 'string'),
        ...arrayField(item, 'content').filter((entry): entry is string => typeof entry === 'string')
      ].join('\n'),
      createdAt
    });
  }

  if (type === 'commandExecution') {
    return ChatMessageSchema.parse({
      id,
      role: 'activity',
      kind: 'command',
      text: stringField(item, 'command') ?? stringField(item, 'aggregatedOutput') ?? 'Command running',
      createdAt
    });
  }

  if (type === 'fileChange') {
    return ChatMessageSchema.parse({
      id,
      role: 'activity',
      kind: 'file',
      text: `File change ${stringField(item, 'status') ?? 'running'}`,
      createdAt
    });
  }

  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const server = stringField(item, 'server') ?? stringField(item, 'namespace') ?? 'tool';
    const tool = stringField(item, 'tool') ?? 'call';
    const status = stringField(item, 'status') ?? 'running';
    return ChatMessageSchema.parse({
      id,
      role: 'activity',
      kind: 'tool',
      text: `${server}.${tool} ${status}`,
      createdAt
    });
  }

  return undefined;
}

function approvalResponseForServerRequest(
  method: string,
  response: unknown,
  params: Record<string, unknown>
): unknown {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return reviewDecisionResponseForAppServerApproval(response);
  }
  if (method === 'item/commandExecution/requestApproval') {
    return { decision: response };
  }
  if (method === 'item/fileChange/requestApproval') {
    return { decision: response };
  }
  if (method === 'item/permissions/requestApproval') {
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      return response;
    }
    const scope = response === 'acceptForSession' ? 'session' : 'turn';
    return {
      permissions: response === 'decline' || response === 'cancel' ? {} : recordField(params, 'permissions') ?? {},
      scope
    };
  }
  if (method === 'mcpServer/elicitation/request') {
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      return response;
    }
    return {
      action: response === 'decline' || response === 'cancel' ? response : 'accept',
      content: null,
      _meta: null
    };
  }
  if (method === 'item/tool/requestUserInput') {
    return response && typeof response === 'object' && !Array.isArray(response)
      ? response
      : { answers: {} };
  }
  if (method === 'item/plan/requestImplementation') {
    return { decision: response };
  }
  return response;
}

function reviewDecisionResponseForAppServerApproval(response: unknown): unknown {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    if ('decision' in response) {
      return response;
    }
    return { decision: response };
  }
  return { decision: reviewDecisionFromUiResponse(response) };
}

function reviewDecisionFromUiResponse(response: unknown): string {
  if (response === 'acceptForSession') {
    return 'approved_for_session';
  }
  if (response === 'decline') {
    return 'denied';
  }
  if (response === 'cancel') {
    return 'abort';
  }
  return 'approved';
}

function timestampFromTurn(turn: AppServerTurn): string {
  const seconds = turn.startedAt ?? turn.completedAt ?? 0;
  return new Date(seconds * 1000).toISOString();
}

function withAttachments(message: Omit<ChatMessage, 'attachments'>, attachments: ChatAttachment[]): ChatMessage {
  if (attachments.length === 0) {
    return message;
  }
  return {
    ...message,
    attachments
  };
}

function imageAttachmentsFromUnknown(value: unknown, ownerId: string, fallbackAlt: string): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];
  const seenObjects = new Set<object>();
  const seenUrls = new Set<string>();

  function add(
    image: { url?: string; sourcePath?: string } | undefined,
    alt: string | undefined
  ): void {
    if (!image || attachments.length >= 12) {
      return;
    }
    const attachmentId = `${ownerId}-image-${attachments.length + 1}`;
    const url = image.url ?? (image.sourcePath ? `agent-pulse-local-image:${attachmentId}` : undefined);
    if (!url || seenUrls.has(url)) {
      return;
    }
    seenUrls.add(url);
    attachments.push({
      id: attachmentId,
      kind: 'image',
      url,
      alt: alt || fallbackAlt,
      ...(image.sourcePath ? { sourcePath: image.sourcePath } : {})
    });
  }

  function visit(candidate: unknown): void {
    if (attachments.length >= 12 || candidate == null) {
      return;
    }

    if (typeof candidate === 'string') {
      add(imageFromString(candidate), undefined);
      return;
    }

    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }

    if (typeof candidate !== 'object') {
      return;
    }

    if (seenObjects.has(candidate)) {
      return;
    }
    seenObjects.add(candidate);

    const record = candidate as Record<string, unknown>;
    const alt = stringField(record, 'alt') ?? stringField(record, 'title') ?? stringField(record, 'name');
    add(imageUrlFromRecord(record), alt);

    Object.values(record).forEach(visit);
  }

  visit(value);
  return attachments;
}

function imageUrlFromRecord(record: Record<string, unknown>): { url?: string; sourcePath?: string } | undefined {
  const type = stringField(record, 'type')?.toLowerCase() ?? '';
  const mime = stringField(record, 'mime_type') ?? stringField(record, 'mimeType') ?? stringField(record, 'media_type');
  const isImageLike = type.includes('image') || Boolean(mime?.startsWith('image/')) || 'image_url' in record;

  if (type === 'localimage') {
    const sourcePath = stringField(record, 'path') ?? stringField(record, 'filePath');
    return sourcePath ? { sourcePath } : undefined;
  }

  const imageUrl = record.image_url;
  if (typeof imageUrl === 'string') {
    return imageFromString(imageUrl, mime);
  }
  if (imageUrl && typeof imageUrl === 'object') {
    const nestedUrl = stringField(imageUrl as Record<string, unknown>, 'url');
    return imageFromString(nestedUrl, mime);
  }

  if (!isImageLike) {
    return undefined;
  }

  return (
    imageFromString(stringField(record, 'url'), mime) ??
    imageFromString(stringField(record, 'src'), mime) ??
    imageFromString(stringField(record, 'data'), mime) ??
    imageFromString(stringField(record, 'image'), mime)
  );
}

function imageFromString(value: string | undefined, mime?: string): { url: string } | undefined {
  if (!value) {
    return undefined;
  }

  if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value) || value.startsWith('blob:')) {
    return { url: value };
  }

  if (mime?.startsWith('image/') && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
    return { url: `data:${mime};base64,${value.replace(/\s+/g, '')}` };
  }

  return undefined;
}

function recordField(record: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = record[field];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function arrayField(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field];
  return Array.isArray(value) ? value : [];
}
