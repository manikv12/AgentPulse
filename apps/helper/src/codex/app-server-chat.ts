import type {
  ChatAttachment,
  ChatMessage,
  Thread,
  ThreadMessageResponse,
  ThreadSendState,
  ThreadTranscript
} from '@agent-pulse/shared';
import { ThreadMessageResponseSchema, ThreadSchema, ThreadTranscriptSchema } from '@agent-pulse/shared';
import { workspaceNameFromCwd } from './thread-reader';

export type CodexAppServerTransport = {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  isConnected(): boolean;
  recentStderr?(): string;
};

type AppServerThreadResponse = {
  thread: AppServerThread;
  // The desktop's `thread/resume` response also surfaces the current model + effort at the
  // top level. We hand these through onto the transcript so the tablet's chip stays in sync
  // with what the user (or another window) selected — without relying on the broadcast.
  model?: string;
  reasoningEffort?: string;
};

type AppServerThreadTurnsListResponse = {
  data: AppServerTurn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};

type AppServerConfigReadResponse = {
  config?: Record<string, unknown> | null;
};

type AppServerThreadStartParams = {
  cwd: string;
  model: string;
  modelProvider: string | null;
  approvalPolicy: unknown;
  sandbox: 'danger-full-access' | 'read-only' | 'workspace-write';
  config: Record<string, unknown>;
  developerInstructions: string | null;
  personality: string | null;
  ephemeral: boolean;
  dynamicTools: null;
  experimentalRawEvents: false;
  persistExtendedHistory: true;
  serviceTier: string | null;
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
  constructor(private readonly transport: CodexAppServerTransport) {}

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  recentStderr(): string {
    return this.transport.recentStderr?.() ?? '';
  }

  async readTranscript(threadId: string): Promise<ThreadTranscript> {
    const thread = await this.loadExistingThread(threadId);
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

  async sendMessage(
    threadId: string,
    text: string,
    options: { model?: string; effort?: string } = {}
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
      return this.steerActiveTurn(threadId, trimmed, transcript.activeTurnId);
    }

    // turn/start accepts `model` and `effort` directly. We pass the user's queued overrides
    // here so the model picker on the tablet can change models even when no Codex window is
    // currently the conversation owner (the IPC follower path requires ownership; this doesn't).
    const response = await this.transport.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: userTextInput(trimmed),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {})
    });
    const updatedTranscript = await this.readTranscript(threadId).catch((error) => {
      if (isUnmaterializedDraftError(error)) {
        return startedDraftTranscript(threadId, trimmed, response.turn.id);
      }
      throw error;
    });
    return ThreadMessageResponseSchema.parse({
      ok: true,
      mode: 'start',
      turnId: response.turn.id,
      transcript: updatedTranscript
    });
  }

  async startThread(cwd: string): Promise<Thread> {
    let response: AppServerThreadResponse;
    try {
      response = await this.callThreadStart(cwd);
    } catch (error) {
      if (!isAppServerDisconnectedError(error)) {
        throw this.withRecentStderr(error);
      }
      try {
        response = await this.callThreadStart(cwd);
      } catch (retryError) {
        throw this.withRecentStderr(retryError);
      }
    }
    if (!response || typeof response !== 'object' || !response.thread) {
      const stderr = this.recentStderr();
      throw new Error(
        `Codex thread/start returned an unexpected response: ${JSON.stringify(response)}${
          stderr ? ` — codex stderr: ${stderr}` : ''
        }`
      );
    }
    return mapAppServerThreadToSummary(response.thread, cwd);
  }

  private async callThreadStart(cwd: string): Promise<AppServerThreadResponse> {
    return this.transport.request<AppServerThreadResponse>(
      'thread/start',
      await this.buildThreadStartParams(cwd)
    );
  }

  private withRecentStderr(error: unknown): Error {
    const stderr = this.recentStderr();
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(stderr ? `${detail} — codex stderr: ${stderr}` : detail);
  }

  private async buildThreadStartParams(cwd: string): Promise<AppServerThreadStartParams> {
    const config = await this.readCodexConfig(cwd);
    const sandbox = sandboxFromConfig(config);
    return {
      cwd,
      model: stringField(config, 'model') ?? 'gpt-5.5',
      modelProvider: stringField(config, 'model_provider') ?? null,
      approvalPolicy: approvalPolicyFromConfig(config, sandbox),
      sandbox,
      config: threadStartConfigFromCodexConfig(config),
      developerInstructions: stringField(config, 'developer_instructions') ?? null,
      personality: stringField(config, 'personality') ?? null,
      ephemeral: false,
      dynamicTools: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      serviceTier: stringField(config, 'service_tier') ?? stringField(config, 'model_service_tier') ?? null
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
    activeTurnId: string | null
  ): Promise<ThreadMessageResponse> {
    if (!activeTurnId) {
      throw new SendBlockedError(
        'missing_active_turn',
        'Codex is running but Agent Pulse cannot find the active turn.'
      );
    }

    try {
      return await this.callTurnSteer(threadId, text, activeTurnId);
    } catch {
      const refreshed = await this.loadExistingThread(threadId);
      const refreshedTranscript = mapThreadToTranscript(refreshed);
      ensureCanSend(refreshedTranscript.sendState);

      if (refreshedTranscript.activeTurnId && refreshedTranscript.activeTurnId !== activeTurnId) {
        return this.callTurnSteer(threadId, text, refreshedTranscript.activeTurnId);
      }

      throw new SendBlockedError('thread_changed', 'Thread changed. Try again.');
    }
  }

  private async callTurnSteer(
    threadId: string,
    text: string,
    expectedTurnId: string
  ): Promise<ThreadMessageResponse> {
    const response = await this.transport.request<{ turnId: string }>('turn/steer', {
      threadId,
      input: userTextInput(text),
      expectedTurnId
    });
    const updatedTranscript = await this.readTranscript(threadId);
    return ThreadMessageResponseSchema.parse({
      ok: true,
      mode: 'steer',
      turnId: response.turnId,
      transcript: updatedTranscript
    });
  }

  private async startTurnWithoutReadableHistory(
    threadId: string,
    text: string,
    options: { model?: string; effort?: string }
  ): Promise<ThreadMessageResponse> {
    const response = await this.transport.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: userTextInput(text),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {})
    });
    const transcript = await this.readTranscript(threadId).catch((error) => {
      if (isUnmaterializedDraftError(error)) {
        return startedDraftTranscript(threadId, text, response.turn.id);
      }
      throw error;
    });
    return ThreadMessageResponseSchema.parse({
      ok: true,
      mode: 'start',
      turnId: response.turn.id,
      transcript
    });
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
      return {
        ...resumeResponse.thread,
        turns,
        model: resumeResponse.model ?? resumeResponse.thread.model ?? null,
        reasoningEffort: resumeResponse.reasoningEffort ?? resumeResponse.thread.reasoningEffort ?? null
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
        reasoningEffort: response.reasoningEffort ?? response.thread.reasoningEffort ?? null
      };
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
}

function mapAppServerThreadToSummary(thread: AppServerThread, fallbackCwd?: string): Thread {
  if (!thread.id || typeof thread.id !== 'string') {
    throw new Error(`Codex thread/start response missing thread id: ${JSON.stringify(thread)}`);
  }
  const cwd = thread.cwd ?? fallbackCwd ?? 'Unknown workspace';
  const updatedAt = thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000;

  return ThreadSchema.parse({
    threadId: thread.id,
    title: thread.name || thread.preview || 'New thread',
    workspace: workspaceNameFromCwd(cwd),
    status: mapAppServerStatus(thread.status),
    lastActivityAt: new Date(updatedAt * 1000).toISOString(),
    lastTurnSummary: ''
  });
}

function mapAppServerStatus(status: AppServerThreadStatus | undefined): Thread['status'] {
  switch (status?.type) {
    case 'active':
      return status.activeFlags.includes('waitingOnApproval') ? 'waiting_approval' : 'running';
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
    activeTurnId: turnId,
    sendState: {
      canSend: false,
      reason: 'missing_active_turn',
      label: 'Codex is working'
    },
    messages: [
      {
        id: `${turnId}:user`,
        role: 'user',
        kind: 'message',
        text,
        createdAt: new Date().toISOString()
      }
    ]
  });
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

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
