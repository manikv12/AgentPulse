import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs';
import { readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  CatalogModelSchema,
  ChatMessageSchema,
  ProjectSchema,
  ThreadMessageResponseSchema,
  ThreadSchema,
  ThreadTranscriptSchema,
  ThreadUsageSchema,
  type ChatAttachment,
  type ChatMessage,
  type CatalogModel,
  type LiveEvent,
  type PendingApprovalRequest,
  type Project,
  type Thread,
  type ThreadMessageResponse,
  type ThreadTranscript,
  type ThreadUsage
} from '@agent-pulse/shared';
import { workspaceNameFromCwd, projectIdForPath } from '../codex/thread-reader';
import { ClaudeCodeUsageReader } from './usage';

const CLAUDE_PROVIDER = 'claude-code' as const;
const THREAD_PREFIX = `${CLAUDE_PROVIDER}:`;
const MAX_SESSIONS = 5_000;
const MAX_IDLE_THREADS_PER_PROJECT = 8;
const CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;
const CLAUDE_DEFAULT_REASONING_EFFORT = 'medium';
const CLAUDE_DEFAULT_PERMISSION_MODE = 'auto';
const CLAUDE_REASONING_LEVELS = [
  { effort: 'low', description: 'Fastest Claude Code reasoning.' },
  { effort: 'medium', description: 'Balanced Claude Code reasoning.' },
  { effort: 'high', description: 'Deeper Claude Code reasoning.' },
  { effort: 'xhigh', description: 'Extra-deep Claude Code reasoning.' },
  { effort: 'max', description: 'Maximum Claude Code reasoning.' }
];

type SpawnProcess = typeof spawn;

type ClaudeCodeProviderOptions = {
  claudeHome?: string;
  executable?: string;
  spawnProcess?: SpawnProcess;
  now?: () => Date;
  usageReader?: { readUsage(): Promise<ThreadUsage | undefined> };
};

type ClaudeThreadListOptions = {
  defaultLimit?: number;
  groupLimits?: Map<string, number> | Record<string, number>;
};

type ParsedClaudeSession = {
  nativeSessionId: string;
  threadId: string;
  filePath: string;
  title: string;
  workspacePath: string;
  lastActivityAt: string;
  lastTurnSummary: string;
  model?: string;
  reasoningEffort?: string;
  usage?: ThreadUsage;
  messages: ChatMessage[];
};

type LiveClaudeSession = {
  nativeSessionId: string;
  threadId: string;
  cwd: string;
  process: ChildProcessWithoutNullStreams;
  processAlive: boolean;
  launchMode: 'new' | 'resume';
  resumeRecoveryAttempted: boolean;
  activeTurnId: string;
  messages: ChatMessage[];
  lastInputPayload?: Record<string, unknown>;
  pendingRequests: Map<string, PendingApprovalRequest>;
  toolInputs: Map<number, { id: string; name: string; inputJSON: string }>;
  assistantMessageId?: string;
  assistantText: string;
  stdoutBuffer: string;
  stderrBuffer: string;
  isStreaming: boolean;
  isNewSession: boolean;
  startedAt: string;
  model?: string;
  reasoningEffort?: string;
  usage?: ThreadUsage;
};

type DraftClaudeThread = {
  nativeSessionId: string;
  cwd: string;
  thread: Thread;
};

export class ClaudeCodeProvider {
  private readonly claudeHome: string;
  private readonly executable: string;
  private readonly spawnProcess: SpawnProcess;
  private readonly now: () => Date;
  private readonly usageReader: { readUsage(): Promise<ThreadUsage | undefined> };
  private readonly liveSessions = new Map<string, LiveClaudeSession>();
  private readonly retainedMessages = new Map<string, ChatMessage[]>();
  private readonly drafts = new Map<string, DraftClaudeThread>();
  private readonly modelOverrides = new Map<string, string>();
  private readonly effortOverrides = new Map<string, string>();
  private readonly threadCwds = new Map<string, string>();
  private readonly liveListeners = new Set<(event: LiveEvent) => void>();
  private readonly liveStateListeners = new Set<(threadId: string) => void>();

  constructor(options: ClaudeCodeProviderOptions = {}) {
    this.claudeHome = options.claudeHome ?? path.join(homedir(), '.claude');
    this.executable = options.executable ?? (options.spawnProcess ? 'claude' : resolveClaudeExecutable());
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? (() => new Date());
    this.usageReader = options.usageReader ?? new ClaudeCodeUsageReader();
  }

  onLiveEvent(listener: (event: LiveEvent) => void): () => void {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  }

  onLiveStateChange(listener: (threadId: string) => void): () => void {
    this.liveStateListeners.add(listener);
    return () => this.liveStateListeners.delete(listener);
  }

  async listThreads(options: ClaudeThreadListOptions = {}): Promise<Thread[]> {
    const sessions = await this.readSessions(options);
    const threads = sessions.map((session) => this.threadFromSession(session));
    for (const draft of this.drafts.values()) {
      if (!threads.some((thread) => thread.threadId === draft.thread.threadId)) {
        threads.unshift(draft.thread);
      }
    }
    return limitIdleClaudeThreads(
      threads,
      options.defaultLimit ?? MAX_IDLE_THREADS_PER_PROJECT,
      options.groupLimits
    );
  }

  async listProjects(): Promise<Project[]> {
    const paths = new Set<string>();
    for (const session of await this.readSessions({ defaultLimit: MAX_SESSIONS })) {
      paths.add(session.workspacePath);
    }
    for (const draft of this.drafts.values()) {
      paths.add(draft.cwd);
    }
    for (const cwd of this.threadCwds.values()) {
      paths.add(cwd);
    }
    return [...paths]
      .sort((a, b) => workspaceNameFromCwd(a).localeCompare(workspaceNameFromCwd(b)))
      .map((workspacePath) =>
        ProjectSchema.parse({
          projectId: projectIdForPath(workspacePath),
          name: workspaceNameFromCwd(workspacePath),
          path: workspacePath,
          providers: [CLAUDE_PROVIDER]
        })
      );
  }

  async startThread(cwd: string, options: { model?: string; reasoningEffort?: string } = {}): Promise<Thread> {
    const nativeSessionId = randomUUID();
    const threadId = threadIdForClaudeSession(nativeSessionId);
    const now = this.now().toISOString();
    const model = normalizeClaudeModelAlias(options.model);
    const reasoningEffort = normalizeClaudeEffort(options.reasoningEffort);
    const thread = ThreadSchema.parse({
      threadId,
      provider: CLAUDE_PROVIDER,
      providerThreadId: nativeSessionId,
      title: 'New Claude chat',
      workspace: workspaceNameFromCwd(cwd),
      workspacePath: cwd,
      status: 'idle',
      lastActivityAt: now,
      lastTurnSummary: '',
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    });
    this.drafts.set(threadId, { nativeSessionId, cwd, thread });
    this.threadCwds.set(threadId, cwd);
    if (model) {
      this.modelOverrides.set(threadId, model);
    }
    if (reasoningEffort) {
      this.effortOverrides.set(threadId, reasoningEffort);
    }
    return thread;
  }

  discardDraftThread(threadId: string): boolean {
    const draft = this.drafts.get(threadId);
    if (!draft) {
      return false;
    }
    this.drafts.delete(threadId);
    this.threadCwds.delete(threadId);
    this.modelOverrides.delete(threadId);
    this.effortOverrides.delete(threadId);
    return true;
  }

  async readTranscript(threadId: string): Promise<ThreadTranscript> {
    const nativeSessionId = nativeSessionIdFromThreadId(threadId);
    const session = await this.readSessionByNativeId(nativeSessionId);
    const live = this.liveSessions.get(threadId);
    const draft = this.drafts.get(threadId);
    const retainedMessages = this.retainedMessages.get(threadId) ?? [];
    const baseMessages = retainedMessages.length > 0
      ? mergeLiveMessages(session?.messages ?? [], retainedMessages)
      : session?.messages ?? [];
    if (retainedMessages.length > 0 && retainedMessagesConfirmed(retainedMessages, session?.messages ?? [])) {
      this.retainedMessages.delete(threadId);
    }
    const messages = live
      ? mergeLiveMessages(baseMessages, live.messages)
      : mergeMessages(baseMessages, []);
    const usage = mergeUsage(
      live?.usage ?? session?.usage,
      await this.usageReader.readUsage().catch(() => undefined)
    );
    const pending = live?.pendingRequests.size ?? 0;
    const activeTurnId = live && (live.isStreaming || pending > 0) ? live.activeTurnId : null;
    const sendState = pending > 0
      ? { canSend: false, reason: 'waiting_on_approval' as const, label: 'Claude needs approval' }
      : live?.isStreaming
        ? { canSend: false, reason: 'thread_changed' as const, label: 'Claude is working' }
        : { canSend: true, reason: 'ready' as const, label: 'Send' };

    return ThreadTranscriptSchema.parse({
      threadId,
      provider: CLAUDE_PROVIDER,
      providerThreadId: nativeSessionId,
      activeTurnId,
      sendState,
      messages,
      ...(usage ? { usage } : {}),
      ...(this.modelForThread(threadId, session, draft, live)
        ? { model: this.modelForThread(threadId, session, draft, live) }
        : {}),
      ...(this.effortForThread(threadId, session, draft, live)
        ? { reasoningEffort: this.effortForThread(threadId, session, draft, live) }
        : {})
    });
  }

  async readFullTranscript(threadId: string): Promise<ThreadTranscript> {
    return this.readTranscript(threadId);
  }

  async sendMessage(
    threadId: string,
    text: string,
    options: { model?: string; effort?: string; attachments?: ChatAttachment[] } = {}
  ): Promise<ThreadMessageResponse> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Message is required.');
    }
    const nativeSessionId = nativeSessionIdFromThreadId(threadId);
    const cwd = await this.cwdForThread(threadId, nativeSessionId);
    const selectedModel = await this.modelForSend(threadId, nativeSessionId, options.model);
    const selectedEffort = await this.effortForSend(threadId, nativeSessionId, options.effort);
    const live = await this.ensureLiveSession(threadId, nativeSessionId, cwd, selectedModel, selectedEffort);
    if (live.isStreaming) {
      throw new Error('Claude is still working on this chat.');
    }
    live.activeTurnId = `claude-turn-${randomUUID()}`;
    live.assistantMessageId = undefined;
    live.assistantText = '';
    const turnId = live.activeTurnId;
    const userMessage = ChatMessageSchema.parse({
      id: `claude-user:${turnId}:${Date.now()}`,
      role: 'user',
      kind: 'message',
      text: trimmed,
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      createdAt: this.now().toISOString()
    });
    live.messages.push(userMessage);
    live.lastInputPayload = claudeUserMessagePayload(trimmed, nativeSessionId, options.attachments ?? []);
    live.isStreaming = true;
    this.emitThreadWorking(threadId);
    try {
      this.writeInput(live, live.lastInputPayload);
    } catch (error) {
      this.failLiveSession(live, error);
      throw new Error(claudeRuntimeErrorMessage(error));
    }
    const transcript = await this.readTranscript(threadId);
    return ThreadMessageResponseSchema.parse({
      ok: true,
      mode: 'start',
      turnId,
      transcript
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    const live = this.liveSessions.get(threadId);
    if (!live) {
      throw new Error('Claude is not running for this thread.');
    }
    live.process.kill('SIGTERM');
    this.finishLiveSession(live, 'interrupted');
  }

  async deleteThread(threadId: string): Promise<void> {
    const nativeSessionId = nativeSessionIdFromThreadId(threadId);
    const session = await this.readSessionByNativeId(nativeSessionId);
    const hadDraft = this.drafts.delete(threadId);
    const live = this.liveSessions.get(threadId);
    if (live) {
      this.liveSessions.delete(threadId);
      live.process.kill('SIGTERM');
    }

    this.modelOverrides.delete(threadId);
    this.effortOverrides.delete(threadId);
    this.threadCwds.delete(threadId);

    if (!session) {
      if (hadDraft || live) {
        return;
      }
      throw new Error('Claude session was not found.');
    }

    await unlink(session.filePath);
    await rm(path.join(this.claudeHome, 'image-cache', nativeSessionId), {
      recursive: true,
      force: true
    }).catch(() => undefined);
  }

  async listModels(): Promise<CatalogModel[]> {
    return [
      CatalogModelSchema.parse({
        slug: 'opus',
        displayName: 'Claude Opus',
        provider: CLAUDE_PROVIDER,
        description: 'Higher-capability Claude Code model alias.',
        defaultReasoningLevel: CLAUDE_DEFAULT_REASONING_EFFORT,
        supportedReasoningLevels: CLAUDE_REASONING_LEVELS,
        visibility: 'visible',
        priority: 10
      }),
      CatalogModelSchema.parse({
        slug: 'sonnet',
        displayName: 'Claude Sonnet',
        provider: CLAUDE_PROVIDER,
        description: 'Balanced Claude Code model alias.',
        defaultReasoningLevel: CLAUDE_DEFAULT_REASONING_EFFORT,
        supportedReasoningLevels: CLAUDE_REASONING_LEVELS,
        visibility: 'visible',
        priority: 20
      })
    ];
  }

  async setModel(threadId: string, model: string, reasoningEffort?: string): Promise<void> {
    const normalizedModel = normalizeClaudeModelAlias(model);
    const normalizedEffort = normalizeClaudeEffort(reasoningEffort);
    if (!normalizedModel) {
      throw new Error('Claude model is required.');
    }
    if (reasoningEffort && !normalizedEffort) {
      throw new Error('Claude reasoning effort is not supported.');
    }

    const draft = this.drafts.get(threadId);
    if (draft) {
      draft.thread = ThreadSchema.parse({
        ...draft.thread,
        model: normalizedModel,
        ...(normalizedEffort ? { reasoningEffort: normalizedEffort } : {})
      });
    }
    this.modelOverrides.set(threadId, normalizedModel);
    if (normalizedEffort) {
      this.effortOverrides.set(threadId, normalizedEffort);
    }

    const live = this.liveSessions.get(threadId);
    if (live?.isStreaming || (live?.pendingRequests.size ?? 0) > 0) {
      throw new Error('Claude is still working. Change the model after this turn finishes.');
    }
    if (
      live &&
      (live.model !== normalizedModel ||
        (normalizedEffort !== undefined && live.reasoningEffort !== normalizedEffort))
    ) {
      live.process.kill('SIGTERM');
      this.finishLiveSession(live, 'completed');
    } else {
      this.emitTranscript(threadId);
    }
  }

  async respondToApproval(
    threadId: string,
    requestId: string,
    method: string,
    response: unknown
  ): Promise<void> {
    const live = this.liveSessions.get(threadId);
    if (!live) {
      throw new Error('Claude is not running for this thread.');
    }
    const pending = live.pendingRequests.get(requestId);
    if (!pending) {
      throw new Error('Claude approval request is no longer pending.');
    }

    const controlResponse =
      method === 'claudeCode/elicitation'
        ? claudeElicitationResponse(requestId, response)
        : claudeToolApprovalResponse(requestId, pending, response);
    live.pendingRequests.delete(requestId);
    this.writeInput(live, controlResponse);
    this.broadcast({ type: 'thread/pending-approvals/changed', payload: { threadId, requests: [...live.pendingRequests.values()] } });
    this.emitStatus(threadId, live.isStreaming ? 'running' : 'idle');
  }

  getPendingApprovalRequests(threadId: string): PendingApprovalRequest[] {
    return [...(this.liveSessions.get(threadId)?.pendingRequests.values() ?? [])];
  }

  isThreadStreaming(threadId: string): boolean {
    return this.liveSessions.get(threadId)?.isStreaming === true;
  }

  isThreadWaitingForApproval(threadId: string): boolean {
    return this.getPendingApprovalRequests(threadId).length > 0;
  }

  dispose(): void {
    for (const live of this.liveSessions.values()) {
      live.process.kill('SIGTERM');
    }
    this.liveSessions.clear();
  }

  private async readSessions(options: ClaudeThreadListOptions = {}): Promise<ParsedClaudeSession[]> {
    const projectsDir = path.join(this.claudeHome, 'projects');
    let dirs;
    try {
      dirs = await readdir(projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const sessions: ParsedClaudeSession[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(projectsDir, dir.name);
      let files;
      try {
        files = await readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      const fileCandidates: Array<{ filePath: string; mtimeMs: number }> = [];
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const filePath = path.join(dirPath, file.name);
        const fileStat = await stat(filePath).catch(() => undefined);
        if (!fileStat) continue;
        fileCandidates.push({ filePath, mtimeMs: fileStat.mtimeMs });
      }
      const fallbackWorkspacePath = fallbackPathFromProjectName(dir.name);
      const projectLimit = threadGroupLimit(
        fallbackWorkspacePath,
        options.defaultLimit ?? MAX_SESSIONS,
        options.groupLimits,
        MAX_SESSIONS
      );
      for (const { filePath } of fileCandidates
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, projectLimit)) {
        const parsed = await parseClaudeSessionFile(filePath, dir.name).catch(() => undefined);
        if (parsed) {
          sessions.push(parsed);
        }
        if (sessions.length >= MAX_SESSIONS) {
          return sessions.sort(sortSessions);
        }
      }
    }
    return sessions.sort(sortSessions);
  }

  private async readSessionByNativeId(nativeSessionId: string): Promise<ParsedClaudeSession | undefined> {
    const sessionFile = await this.findSessionFileByNativeId(nativeSessionId);
    if (!sessionFile) {
      return undefined;
    }
    return parseClaudeSessionFile(sessionFile.filePath, sessionFile.encodedProjectName);
  }

  private async findSessionFileByNativeId(
    nativeSessionId: string
  ): Promise<{ filePath: string; encodedProjectName: string } | undefined> {
    const projectsDir = path.join(this.claudeHome, 'projects');
    let dirs;
    try {
      dirs = await readdir(projectsDir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    const fileName = `${nativeSessionId}.jsonl`;
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const filePath = path.join(projectsDir, dir.name, fileName);
      const fileStat = await stat(filePath).catch(() => undefined);
      if (fileStat?.isFile()) {
        return { filePath, encodedProjectName: dir.name };
      }
    }

    return undefined;
  }

  private threadFromSession(session: ParsedClaudeSession): Thread {
    this.threadCwds.set(session.threadId, session.workspacePath);
    const live = this.liveSessions.get(session.threadId);
    const pending = live?.pendingRequests.size ?? 0;
    return ThreadSchema.parse({
      threadId: session.threadId,
      provider: CLAUDE_PROVIDER,
      providerThreadId: session.nativeSessionId,
      title: session.title,
      workspace: workspaceNameFromCwd(session.workspacePath),
      workspacePath: session.workspacePath,
      status: pending > 0 ? 'waiting_approval' : live?.isStreaming ? 'running' : 'idle',
      lastActivityAt: live?.startedAt ?? session.lastActivityAt,
      lastTurnSummary: session.lastTurnSummary,
      ...(this.modelForThread(session.threadId, session, undefined, live)
        ? { model: this.modelForThread(session.threadId, session, undefined, live) }
        : {}),
      ...(this.effortForThread(session.threadId, session, undefined, live)
        ? { reasoningEffort: this.effortForThread(session.threadId, session, undefined, live) }
        : {})
    });
  }

  private async cwdForThread(threadId: string, nativeSessionId: string): Promise<string> {
    const draft = this.drafts.get(threadId);
    if (draft) {
      return draft.cwd;
    }
    const rememberedCwd = this.threadCwds.get(threadId);
    if (rememberedCwd) {
      return rememberedCwd;
    }
    const session = await this.readSessionByNativeId(nativeSessionId);
    if (!session?.workspacePath || !path.isAbsolute(session.workspacePath)) {
      throw new Error('Claude session is missing a workspace folder.');
    }
    return session.workspacePath;
  }

  private async ensureLiveSession(
    threadId: string,
    nativeSessionId: string,
    cwd: string,
    model?: string,
    effort?: string
  ): Promise<LiveClaudeSession> {
    const requestedModel = normalizeClaudeModelAlias(model);
    const requestedEffort = normalizeClaudeEffort(effort);
    const existing = this.liveSessions.get(threadId);
    if (existing && existing.processAlive && !existing.process.killed) {
      const modelChanged = requestedModel !== undefined && existing.model !== requestedModel;
      const effortChanged = requestedEffort !== undefined && existing.reasoningEffort !== requestedEffort;
      if (modelChanged || effortChanged) {
        if (existing.isStreaming || existing.pendingRequests.size > 0) {
          throw new Error('Claude is still working. Change the model after this turn finishes.');
        }
        existing.process.kill('SIGTERM');
        this.finishLiveSession(existing, 'completed');
      } else {
        return existing;
      }
    }
    if (requestedModel) {
      this.modelOverrides.set(threadId, requestedModel);
    }
    if (requestedEffort) {
      this.effortOverrides.set(threadId, requestedEffort);
    }
    const draft = this.drafts.get(threadId);
    const launchMode: LiveClaudeSession['launchMode'] = draft ? 'new' : 'resume';
    this.threadCwds.set(threadId, cwd);
    const child = this.spawnClaudeChild(nativeSessionId, cwd, requestedModel, requestedEffort, launchMode);
    const live: LiveClaudeSession = {
      nativeSessionId,
      threadId,
      cwd,
      process: child,
      processAlive: true,
      launchMode,
      resumeRecoveryAttempted: false,
      activeTurnId: `claude-turn-${randomUUID()}`,
      messages: [],
      pendingRequests: new Map(),
      toolInputs: new Map(),
      assistantText: '',
      stdoutBuffer: '',
      stderrBuffer: '',
      isStreaming: false,
      isNewSession: launchMode === 'new',
      startedAt: this.now().toISOString(),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedEffort ? { reasoningEffort: requestedEffort } : {})
    };
    this.liveSessions.set(threadId, live);
    await this.attachClaudeChild(live, child);
    this.drafts.delete(threadId);
    return live;
  }

  private spawnClaudeChild(
    nativeSessionId: string,
    cwd: string,
    model: string | undefined,
    effort: string | undefined,
    launchMode: LiveClaudeSession['launchMode']
  ): ChildProcessWithoutNullStreams {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-mode',
      CLAUDE_DEFAULT_PERMISSION_MODE,
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      ...(launchMode === 'new' ? ['--session-id', nativeSessionId] : ['--resume', nativeSessionId])
    ];
    try {
      return this.spawnProcess(this.executable, args, {
        cwd,
        env: process.env,
        stdio: 'pipe'
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new Error(claudeStartErrorMessage(error, this.executable));
    }
  }

  private async attachClaudeChild(
    live: LiveClaudeSession,
    child: ChildProcessWithoutNullStreams
  ): Promise<void> {
    live.process = child;
    live.processAlive = true;
    const started = this.waitForProcessStart(live);
    child.stdout.on('data', (chunk) => this.handleStdout(live, chunk));
    child.stderr.on('data', (chunk) => {
      live.stderrBuffer += chunk.toString('utf8');
    });
    child.stdin.on('error', (error) => {
      if (live.process === child) {
        this.failLiveSession(live, error);
      }
    });
    child.on('error', (error) => {
      if (live.process === child) {
        this.failLiveSession(live, error);
      }
    });
    child.on('exit', (code) => {
      if (live.process !== child) {
        return;
      }
      live.processAlive = false;
      this.finishLiveSession(live, code === 0 ? 'completed' : 'failed');
    });
    await started.catch((error) => {
      this.failLiveSession(live, error);
      throw new Error(claudeStartErrorMessage(error, this.executable));
    });
  }

  private waitForProcessStart(live: LiveClaudeSession): Promise<void> {
    if (typeof live.process.pid === 'number') {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        live.process.off('spawn', onSpawn);
        live.process.off('error', onError);
        callback();
      };
      const onSpawn = () => settle(resolve);
      const onError = (error: Error) => settle(() => reject(error));
      live.process.once('spawn', onSpawn);
      live.process.once('error', onError);
    });
  }

  private handleStdout(live: LiveClaudeSession, chunk: Buffer): void {
    live.stdoutBuffer += chunk.toString('utf8');
    let newlineIndex = live.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = live.stdoutBuffer.slice(0, newlineIndex).trim();
      live.stdoutBuffer = live.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(live, line);
      }
      newlineIndex = live.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(live: LiveClaudeSession, line: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = stringField(payload, 'type')?.toLowerCase();
    if (type === 'assistant') {
      const message = recordField(payload, 'message');
      live.model = normalizeClaudeModelAlias(stringField(message, 'model')) ?? live.model;
      live.usage = mergeUsage(live.usage, usageFromClaudeMessage(message));
      const parts = extractClaudeMessageParts(payload.message, `claude-assistant:${live.activeTurnId}`);
      if (parts.text || parts.attachments.length > 0) {
        this.installAssistantMessage(live, parts.text, parts.attachments, 'commentary');
      }
    } else if (type === 'stream_event') {
      this.handleStreamEvent(live, recordField(payload, 'event'));
    } else if (type === 'control_request') {
      this.handleControlRequest(live, payload);
    } else if (type === 'control_cancel_request') {
      const requestId = stringField(payload, 'request_id') ?? stringField(payload, 'requestId');
      if (requestId) {
        live.pendingRequests.delete(requestId);
        this.broadcast({ type: 'thread/pending-approvals/changed', payload: { threadId: live.threadId, requests: [...live.pendingRequests.values()] } });
      }
    } else if (type === 'result') {
      const parts = extractClaudeResultParts(payload, `claude-assistant:${live.activeTurnId}`);
      if (parts.text || parts.attachments.length > 0) {
        this.installAssistantMessage(live, parts.text, parts.attachments, 'final_answer');
      } else {
        this.finalizeAssistantMessage(live, 'final_answer');
      }
      this.finishTurn(live);
    }
  }

  private handleStreamEvent(live: LiveClaudeSession, event: Record<string, unknown> | undefined): void {
    if (!event) return;
    const type = stringField(event, 'type')?.toLowerCase();
    if (type === 'content_block_start') {
      const block = recordField(event, 'content_block');
      if (stringField(block, 'type') === 'tool_use') {
        const index = numberField(event, 'index');
        const name = stringField(block, 'name') ?? 'Using tool';
        const id = stringField(block, 'id') ?? `claude-tool-${index ?? Date.now()}`;
        const inputJSON = stringifyJSON(block?.input);
        if (index !== undefined) {
          live.toolInputs.set(index, { id, name, inputJSON });
        }
        this.upsertToolMessage(live, id, name, inputJSON);
        this.maybeUpsertPlan(live, id, name, inputJSON);
      }
    } else if (type === 'content_block_delta') {
      const delta = recordField(event, 'delta');
      const deltaType = stringField(delta, 'type')?.toLowerCase();
      if (deltaType === 'text_delta') {
        const text = stringField(delta, 'text') ?? '';
        if (text) {
          this.appendAssistantDelta(live, text);
        }
      } else if (deltaType === 'input_json_delta') {
        const index = numberField(event, 'index');
        const partial = stringField(delta, 'partial_json') ?? '';
        const tool = index === undefined ? undefined : live.toolInputs.get(index);
        if (tool) {
          tool.inputJSON += partial;
          this.upsertToolMessage(live, tool.id, tool.name, tool.inputJSON);
          this.maybeUpsertPlan(live, tool.id, tool.name, tool.inputJSON);
        }
      }
    } else if (type === 'message_delta') {
      const stopReason = stringField(recordField(event, 'delta'), 'stop_reason')?.toLowerCase();
      if (stopReason === 'tool_use') {
        live.isStreaming = true;
        this.emitStatus(live.threadId, 'running');
      }
    }
  }

  private handleControlRequest(live: LiveClaudeSession, payload: Record<string, unknown>): void {
    const requestId = stringField(payload, 'request_id') ?? stringField(payload, 'requestId');
    const request = recordField(payload, 'request');
    const subtype = stringField(request, 'subtype')?.toLowerCase();
    if (!requestId || !request || !subtype) {
      return;
    }
    const method = subtype === 'elicitation' ? 'claudeCode/elicitation' : 'claudeCode/canUseTool';
    const input = recordField(request, 'input') ?? {};
    const pending = PendingApprovalRequestForClaude({
      id: requestId,
      method,
      params: {
        title: stringField(request, 'display_name') ?? stringField(request, 'title') ?? stringField(request, 'tool_name') ?? 'Claude needs approval',
        message: stringField(request, 'message') ?? stringField(request, 'description') ?? stringField(request, 'decision_reason'),
        toolName: stringField(request, 'tool_name'),
        toolUseId: stringField(request, 'tool_use_id'),
        input,
        mode: stringField(request, 'mode'),
        url: stringField(request, 'url'),
        requestedSchema: recordField(request, 'requested_schema'),
        availableDecisions: subtype === 'elicitation' ? ['accept', 'decline', 'cancel'] : ['accept', 'decline']
      }
    });
    live.pendingRequests.set(requestId, pending);
    live.isStreaming = true;
    this.broadcast({ type: 'thread/pending-approvals/changed', payload: { threadId: live.threadId, requests: [...live.pendingRequests.values()] } });
    this.emitStatus(live.threadId, 'waiting_approval');
  }

  private installAssistantText(live: LiveClaudeSession, text: string): void {
    this.installAssistantMessage(live, text, [], 'commentary');
  }

  private installAssistantMessage(
    live: LiveClaudeSession,
    text: string,
    attachments: ChatAttachment[],
    phase: 'commentary' | 'final_answer'
  ): void {
    live.assistantText = text;
    const id = live.assistantMessageId ?? `claude-assistant:${live.activeTurnId}`;
    live.assistantMessageId = id;
    const previousAttachments =
      live.messages.find((message) => message.id === id)?.attachments ?? [];
    const nextAttachments = mergeAttachments(previousAttachments, attachments);
    upsertMessage(live.messages, ChatMessageSchema.parse({
      id,
      role: 'assistant',
      kind: 'message',
      text,
      phase,
      createdAt: this.now().toISOString(),
      ...(nextAttachments.length > 0 ? { attachments: nextAttachments } : {})
    }));
    this.emitTranscript(live.threadId);
  }

  private finalizeAssistantMessage(
    live: LiveClaudeSession,
    phase: 'commentary' | 'final_answer'
  ): void {
    const id = live.assistantMessageId;
    if (!id) {
      return;
    }
    const existing = live.messages.find((message) => message.id === id);
    if (!existing || existing.role !== 'assistant' || existing.kind !== 'message') {
      return;
    }
    upsertMessage(live.messages, ChatMessageSchema.parse({
      ...existing,
      phase,
      createdAt: this.now().toISOString()
    }));
    this.emitTranscript(live.threadId);
  }

  private appendAssistantDelta(live: LiveClaudeSession, text: string): void {
    if (!text) return;
    this.installAssistantText(live, `${live.assistantText}${text}`);
    // After installAssistantText runs, assistantMessageId is guaranteed to be
    // set. Emit a per-token delta so the tablet can render the partial text
    // immediately instead of waiting for the next transcript snapshot.
    const messageId = live.assistantMessageId;
    if (messageId) {
      this.broadcast({
        type: 'thread/assistant/text-delta',
        payload: { threadId: live.threadId, messageId, delta: text }
      });
    }
  }

  private upsertToolMessage(live: LiveClaudeSession, id: string, name: string, inputJSON: string): void {
    upsertMessage(live.messages, ChatMessageSchema.parse({
      id: `claude-tool:${id}`,
      role: 'activity',
      kind: 'tool',
      text: inputJSON ? `${name}\n${inputJSON}` : name,
      createdAt: this.now().toISOString()
    }));
    this.emitTranscript(live.threadId);
  }

  private maybeUpsertPlan(live: LiveClaudeSession, id: string, name: string, inputJSON: string): void {
    if (!['todowrite', 'update_plan'].includes(name.toLowerCase())) {
      return;
    }
    const text = extractPlanText(inputJSON);
    if (!text) {
      return;
    }
    upsertMessage(live.messages, ChatMessageSchema.parse({
      id: `claude-plan:${id}`,
      role: 'assistant',
      kind: 'plan',
      text,
      createdAt: this.now().toISOString()
    }));
    this.emitTranscript(live.threadId);
  }

  private finishTurn(live: LiveClaudeSession): void {
    live.isStreaming = false;
    live.pendingRequests.clear();
    live.toolInputs.clear();
    const closingMessageId = live.assistantMessageId;
    live.assistantMessageId = undefined;
    live.assistantText = '';
    if (closingMessageId) {
      this.broadcast({
        type: 'thread/assistant/text-end',
        payload: { threadId: live.threadId, messageId: closingMessageId }
      });
    }
    this.broadcast({ type: 'thread/pending-approvals/changed', payload: { threadId: live.threadId, requests: [] } });
    this.emitStatus(live.threadId, 'idle');
    this.broadcast({ type: 'thread/streaming-changed', payload: { threadId: live.threadId, isStreaming: false } });
    this.emitTranscript(live.threadId);
  }

  private finishLiveSession(live: LiveClaudeSession, status: 'completed' | 'interrupted' | 'failed'): void {
    if (this.liveSessions.get(live.threadId) !== live) {
      return;
    }
    live.processAlive = false;
    if (status === 'failed' && this.canRecoverMissingConversation(live)) {
      void this.recoverMissingConversation(live);
      return;
    }
    if (status !== 'completed' && live.messages.length > 0) {
      this.installFailureMessage(live, status);
    }
    if (live.messages.length > 0) {
      this.retainedMessages.set(live.threadId, mergeLiveMessages(
        this.retainedMessages.get(live.threadId) ?? [],
        live.messages
      ));
    }
    live.isStreaming = false;
    live.pendingRequests.clear();
    this.liveSessions.delete(live.threadId);
    this.broadcast({ type: 'thread/pending-approvals/changed', payload: { threadId: live.threadId, requests: [] } });
    this.emitStatus(live.threadId, status === 'failed' ? 'error' : 'idle');
    this.broadcast({ type: 'thread/streaming-changed', payload: { threadId: live.threadId, isStreaming: false } });
    this.emitTranscript(live.threadId);
  }

  private emitThreadWorking(threadId: string): void {
    this.emitStatus(threadId, 'running');
    this.broadcast({ type: 'thread/streaming-changed', payload: { threadId, isStreaming: true } });
    this.emitTranscript(threadId);
  }

  private emitStatus(threadId: string, status: Thread['status']): void {
    this.broadcast({ type: 'thread/status/changed', payload: { threadId, status } });
    this.emitLiveStateChange(threadId);
  }

  private emitTranscript(threadId: string): void {
    void this.readTranscript(threadId)
      .then((transcript) => this.broadcast({ type: 'thread/transcript/changed', payload: transcript }))
      .catch(() => undefined);
    this.emitLiveStateChange(threadId);
  }

  private emitLiveStateChange(threadId: string): void {
    for (const listener of this.liveStateListeners) {
      listener(threadId);
    }
  }

  private broadcast(event: LiveEvent): void {
    for (const listener of this.liveListeners) {
      listener(event);
    }
  }

  private writeInput(live: LiveClaudeSession, payload: Record<string, unknown>): void {
    if (!live.processAlive || live.process.stdin.destroyed) {
      throw new Error('Claude Code is not accepting input.');
    }
    live.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private failLiveSession(live: LiveClaudeSession, error: unknown): void {
    if (this.liveSessions.get(live.threadId) !== live) {
      return;
    }
    if (live.stderrBuffer.trim().length === 0) {
      live.stderrBuffer = error instanceof Error ? error.message : String(error);
    }
    this.finishLiveSession(live, 'failed');
  }

  private installFailureMessage(
    live: LiveClaudeSession,
    status: 'interrupted' | 'failed'
  ): void {
    const text =
      status === 'interrupted'
        ? 'Claude Code was stopped.'
        : claudeRuntimeErrorMessage(live.stderrBuffer || 'Claude Code stopped before finishing.');
    this.installAssistantMessage(live, text, [], 'final_answer');
  }

  private canRecoverMissingConversation(live: LiveClaudeSession): boolean {
    return (
      live.launchMode === 'resume' &&
      !live.resumeRecoveryAttempted &&
      Boolean(live.lastInputPayload) &&
      noConversationFoundError(live.stderrBuffer)
    );
  }

  private async recoverMissingConversation(live: LiveClaudeSession): Promise<void> {
    live.resumeRecoveryAttempted = true;
    live.launchMode = 'new';
    live.isNewSession = true;
    live.stderrBuffer = '';
    try {
      const child = this.spawnClaudeChild(
        live.nativeSessionId,
        live.cwd,
        live.model,
        live.reasoningEffort,
        'new'
      );
      await this.attachClaudeChild(live, child);
      if (live.lastInputPayload) {
        this.writeInput(live, live.lastInputPayload);
      }
      this.emitThreadWorking(live.threadId);
    } catch (error) {
      this.failLiveSession(live, error);
    }
  }

  private async modelForSend(
    threadId: string,
    nativeSessionId: string,
    requestedModel: string | undefined
  ): Promise<string | undefined> {
    const explicit = normalizeClaudeModelAlias(requestedModel);
    if (explicit) {
      return explicit;
    }
    const override = this.modelOverrides.get(threadId);
    if (override) {
      return override;
    }
    const draftModel = normalizeClaudeModelAlias(this.drafts.get(threadId)?.thread.model);
    if (draftModel) {
      return draftModel;
    }
    const session = await this.readSessionByNativeId(nativeSessionId);
    return normalizeClaudeModelAlias(session?.model);
  }

  private async effortForSend(
    threadId: string,
    nativeSessionId: string,
    requestedEffort: string | undefined
  ): Promise<string | undefined> {
    const explicit = normalizeClaudeEffort(requestedEffort);
    if (explicit) {
      return explicit;
    }
    if (requestedEffort) {
      throw new Error('Claude reasoning effort is not supported.');
    }
    const override = this.effortOverrides.get(threadId);
    if (override) {
      return override;
    }
    const draftEffort = normalizeClaudeEffort(this.drafts.get(threadId)?.thread.reasoningEffort);
    if (draftEffort) {
      return draftEffort;
    }
    const session = await this.readSessionByNativeId(nativeSessionId);
    return normalizeClaudeEffort(session?.reasoningEffort);
  }

  private modelForThread(
    threadId: string,
    session?: ParsedClaudeSession,
    draft?: DraftClaudeThread,
    live?: LiveClaudeSession
  ): string | undefined {
    return (
      normalizeClaudeModelAlias(live?.model) ??
      this.modelOverrides.get(threadId) ??
      normalizeClaudeModelAlias(draft?.thread.model) ??
      normalizeClaudeModelAlias(session?.model)
    );
  }

  private effortForThread(
    threadId: string,
    session?: ParsedClaudeSession,
    draft?: DraftClaudeThread,
    live?: LiveClaudeSession
  ): string | undefined {
    return (
      normalizeClaudeEffort(live?.reasoningEffort) ??
      this.effortOverrides.get(threadId) ??
      normalizeClaudeEffort(draft?.thread.reasoningEffort) ??
      normalizeClaudeEffort(session?.reasoningEffort)
    );
  }
}

export function isClaudeThreadId(threadId: string): boolean {
  return threadId.startsWith(THREAD_PREFIX);
}

export function threadIdForClaudeSession(sessionId: string): string {
  return `${THREAD_PREFIX}${sessionId}`;
}

function nativeSessionIdFromThreadId(threadId: string): string {
  return isClaudeThreadId(threadId) ? threadId.slice(THREAD_PREFIX.length) : threadId;
}

async function parseClaudeSessionFile(filePath: string, encodedProjectName: string): Promise<ParsedClaudeSession | undefined> {
  const fileStat = await stat(filePath);
  const content = await readFile(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const nativeSessionId = path.basename(filePath, '.jsonl');
  const messages: ChatMessage[] = [];
  let title = '';
  let workspacePath = '';
  let lastActivityAt = fileStat.mtime.toISOString();
  let lastTurnSummary = '';
  let model: string | undefined;
  let usage: ThreadUsage | undefined;
  const noteVisibleActivity = (createdAt: string) => {
    lastActivityAt = createdAt;
  };

  for (const [index, line] of lines.entries()) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp = stringField(payload, 'timestamp');
    const createdAt = timestampToIso(timestamp, fileStat.mtime);
    const cwd = stringField(payload, 'cwd');
    if (cwd && path.isAbsolute(cwd)) {
      workspacePath = cwd;
    }
    const payloadSessionId = stringField(payload, 'sessionId') ?? stringField(payload, 'session_id');
    const type = stringField(payload, 'type');
    if (type === 'last-prompt') {
      title = title || compactTitle(stringField(payload, 'lastPrompt') ?? '');
      continue;
    }
    if (type === 'user') {
      const { text, attachments } = extractClaudeMessageParts(payload.message, `claude-user:${payloadSessionId ?? nativeSessionId}:${index}`);
      if (!text && attachments.length === 0) continue;
      title = title || compactTitle(text);
      messages.push(ChatMessageSchema.parse({
        id: stringField(payload, 'uuid') ?? `claude-user:${payloadSessionId ?? nativeSessionId}:${index}`,
        role: 'user',
        kind: 'message',
        text,
        createdAt,
        ...(attachments.length > 0 ? { attachments } : {})
      }));
      noteVisibleActivity(createdAt);
    } else if (type === 'assistant') {
      const message = recordField(payload, 'message');
      model = normalizeClaudeModelAlias(stringField(message, 'model')) ?? model;
      usage = mergeUsage(usage, usageFromClaudeMessage(message));
      const { text, attachments } = extractClaudeMessageParts(message, `claude-assistant:${payloadSessionId ?? nativeSessionId}:${index}`);
      if (text || attachments.length > 0) {
        lastTurnSummary = compactSummary(text);
        messages.push(ChatMessageSchema.parse({
          id: stringField(payload, 'uuid') ?? `claude-assistant:${payloadSessionId ?? nativeSessionId}:${index}`,
          role: 'assistant',
          kind: 'message',
          text,
          createdAt,
          ...(attachments.length > 0 ? { attachments } : {})
        }));
        noteVisibleActivity(createdAt);
      }
      const plans = extractPlanMessagesFromClaudeMessage(message, index, createdAt);
      for (const plan of plans) {
        messages.push(plan);
      }
      if (plans.length > 0) {
        noteVisibleActivity(createdAt);
      }
    }
  }

  workspacePath = workspacePath || fallbackPathFromProjectName(encodedProjectName);
  if (!workspacePath || messages.length === 0) {
    return undefined;
  }
  return {
    nativeSessionId,
    threadId: threadIdForClaudeSession(nativeSessionId),
    filePath,
    title: title || 'Claude chat',
    workspacePath,
    lastActivityAt,
    lastTurnSummary,
    model,
    usage,
    messages
  };
}

function PendingApprovalRequestForClaude(input: PendingApprovalRequest): PendingApprovalRequest {
  return input;
}

function sortSessions(a: ParsedClaudeSession, b: ParsedClaudeSession): number {
  return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
}

function limitIdleClaudeThreads(
  threads: Thread[],
  defaultLimit = MAX_IDLE_THREADS_PER_PROJECT,
  groupLimits: Map<string, number> | Record<string, number> = {}
): Thread[] {
  const idleCounts = new Map<string, number>();
  return threads.filter((thread) => {
    if (thread.status !== 'idle' && thread.status !== 'unknown') {
      return true;
    }
    const key = thread.workspacePath ?? thread.workspace;
    const limit = threadGroupLimit(key, defaultLimit, groupLimits, MAX_SESSIONS);
    const count = idleCounts.get(key) ?? 0;
    if (count >= limit) {
      return false;
    }
    idleCounts.set(key, count + 1);
    return true;
  });
}

function threadGroupLimit(
  groupKey: string,
  defaultLimit: number,
  groupLimits: Map<string, number> | Record<string, number> = {},
  maxLimit = MAX_SESSIONS
): number {
  const explicitLimit =
    groupLimits instanceof Map
      ? groupLimits.get(groupKey)
      : Object.prototype.hasOwnProperty.call(groupLimits, groupKey)
        ? groupLimits[groupKey]
        : undefined;
  const limit = explicitLimit ?? defaultLimit;
  return Number.isFinite(limit) && limit > 0
    ? Math.min(maxLimit, Math.floor(limit))
    : Math.min(maxLimit, defaultLimit);
}

function mergeMessages(base: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of base) byId.set(message.id, message);
  for (const message of live) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function mergeLiveMessages(base: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  if (live.length === 0) {
    return mergeMessages(base, live);
  }

  const liveIds = new Set(live.map((message) => message.id));
  const liveSignatures = new Map<string, number>();
  for (const message of live) {
    const signature = messageContentSignature(message);
    liveSignatures.set(signature, (liveSignatures.get(signature) ?? 0) + 1);
  }

  // While Claude is streaming, the JSONL file can already contain the current user
  // message using a different id and a newer file timestamp. Keep the in-memory live
  // turn as the authoritative tail so progress stays under the message that triggered it.
  const baseWithoutLiveEchoes: ChatMessage[] = [];
  for (let index = base.length - 1; index >= 0; index -= 1) {
    const message = base[index]!;
    const signature = messageContentSignature(message);
    const duplicateCount = liveSignatures.get(signature) ?? 0;
    if (liveIds.has(message.id) || duplicateCount > 0) {
      if (duplicateCount > 0) {
        liveSignatures.set(signature, duplicateCount - 1);
      }
      continue;
    }
    baseWithoutLiveEchoes.unshift(message);
  }

  const byId = new Map<string, ChatMessage>();
  for (const message of baseWithoutLiveEchoes) byId.set(message.id, message);
  for (const message of live) byId.set(message.id, message);
  return [...byId.values()];
}

function retainedMessagesConfirmed(retained: ChatMessage[], base: ChatMessage[]): boolean {
  if (retained.length === 0 || base.length === 0) {
    return false;
  }
  const baseIds = new Set(base.map((message) => message.id));
  const baseSignatures = new Set(base.map(messageContentSignature));
  return retained.every(
    (message) => baseIds.has(message.id) || baseSignatures.has(messageContentSignature(message))
  );
}

function messageContentSignature(message: ChatMessage): string {
  return [
    message.role,
    message.kind,
    message.phase ?? '',
    message.text.trim(),
    (message.attachments ?? [])
      .map((attachment) => `${attachment.kind}:${attachment.url ?? ''}:${attachment.sourcePath ?? ''}`)
      .join('|')
  ].join('\u001f');
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage): void {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index >= 0) {
    messages[index] = message;
  } else {
    messages.push(message);
  }
}

function claudeUserMessagePayload(
  content: string,
  sessionId: string,
  attachments: ChatAttachment[] = []
): Record<string, unknown> {
  return {
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: claudeMessageContent(content, attachments)
    },
    parent_tool_use_id: null
  };
}

function claudeMessageContent(content: string, attachments: ChatAttachment[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [{ type: 'text', text: content }];
  for (const attachment of attachments) {
    const image = dataImageFromAttachment(attachment);
    if (!image) continue;
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType,
        data: image.data
      }
    });
  }
  return blocks;
}

function dataImageFromAttachment(attachment: ChatAttachment): { mimeType: string; data: string } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/iu.exec(attachment.url);
  if (!match) return undefined;
  return {
    mimeType: match[1]!.toLowerCase(),
    data: match[2]!.replace(/\s/gu, '')
  };
}

function claudeToolApprovalResponse(
  requestId: string,
  pending: PendingApprovalRequest,
  response: unknown
): Record<string, unknown> {
  const decision = typeof response === 'string' ? response : stringField(response as Record<string, unknown>, 'decision');
  const params = pending.params ?? {};
  const toolUseId = stringField(params, 'toolUseId');
  const input = recordField(params, 'input') ?? {};
  const isAccept = ['accept', 'approve', 'allow', 'allow_once'].includes((decision ?? '').toLowerCase());
  const isCancel = ['cancel', 'cancel_turn'].includes((decision ?? '').toLowerCase());
  const payload: Record<string, unknown> = isAccept
    ? { behavior: 'allow', updatedInput: input }
    : {
        behavior: 'deny',
        message: isCancel ? 'The user canceled this turn.' : 'The user declined this request.',
        ...(isCancel ? { interrupt: true } : {})
      };
  if (toolUseId) {
    payload.toolUseID = toolUseId;
  }
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: payload
    }
  };
}

function claudeElicitationResponse(requestId: string, response: unknown): Record<string, unknown> {
  const decision = typeof response === 'string' ? response : stringField(response as Record<string, unknown>, 'action');
  const action = decision && ['decline', 'cancel'].includes(decision.toLowerCase()) ? decision.toLowerCase() : 'accept';
  const content = typeof response === 'object' && response !== null
    ? (response as Record<string, unknown>).content ?? response
    : {};
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        action,
        ...(action === 'accept' ? { content } : {})
      }
    }
  };
}

function extractClaudeMessageText(message: unknown): string {
  return extractClaudeMessageParts(message, 'claude-message').text;
}

function extractClaudeMessageParts(
  message: unknown,
  ownerId: string
): { text: string; attachments: ChatAttachment[] } {
  const record = recordField({ message }, 'message');
  if (!record) {
    return { text: '', attachments: [] };
  }
  const content = record.content;
  if (typeof content === 'string') {
    return textWithLocalImageAttachments(content, ownerId);
  }
  if (!Array.isArray(content)) {
    return { text: '', attachments: [] };
  }
  const attachments: ChatAttachment[] = [];
  const text = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const entry = block as Record<string, unknown>;
      if (stringField(entry, 'type') === 'text') {
        const parts = textWithLocalImageAttachments(stringField(entry, 'text') ?? '', `${ownerId}:${attachments.length}`);
        attachments.push(...parts.attachments);
        return parts.text;
      }
      const image = localImageAttachmentFromRecord(entry, `${ownerId}:block:${attachments.length + 1}`);
      if (image) {
        attachments.push(image);
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return { text, attachments };
}

function extractClaudeResultText(payload: Record<string, unknown>): string {
  return extractClaudeResultParts(payload, 'claude-result').text;
}

function extractClaudeResultParts(
  payload: Record<string, unknown>,
  ownerId: string
): { text: string; attachments: ChatAttachment[] } {
  return textWithLocalImageAttachments(
    stringField(payload, 'result') ?? stringField(payload, 'response') ?? '',
    ownerId
  );
}

const LOCAL_IMAGE_MARKER_PATTERN =
  /\[\s*Image(?:\s*#[^\]:]+)?\s*:\s*source\s*:\s*([^\]\n]+?\.(?:png|jpe?g|gif|webp|bmp|tiff?))\s*\]/gi;

function textWithLocalImageAttachments(
  rawText: string,
  ownerId: string
): { text: string; attachments: ChatAttachment[] } {
  const attachments: ChatAttachment[] = [];
  const text = rawText.replace(LOCAL_IMAGE_MARKER_PATTERN, (_match, sourcePath: string) => {
    const cleanPath = sourcePath.trim();
    attachments.push({
      id: `${ownerId}-image-${attachments.length + 1}`,
      kind: 'image',
      url: `agent-pulse-local-image:${ownerId}-image-${attachments.length + 1}`,
      alt: `Image ${attachments.length + 1}`,
      sourcePath: cleanPath
    });
    return '';
  });
  return {
    text: text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    attachments
  };
}

function localImageAttachmentFromRecord(
  record: Record<string, unknown>,
  ownerId: string
): ChatAttachment | undefined {
  const type = stringField(record, 'type')?.toLowerCase() ?? '';
  const sourcePath =
    stringField(record, 'source') ??
    stringField(record, 'sourcePath') ??
    stringField(record, 'path') ??
    stringField(record, 'filePath');
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    return undefined;
  }
  if (!type.includes('image') && !/\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i.test(sourcePath)) {
    return undefined;
  }
  return {
    id: `${ownerId}-image-1`,
    kind: 'image',
    url: `agent-pulse-local-image:${ownerId}-image-1`,
    alt: stringField(record, 'alt') ?? stringField(record, 'title') ?? 'Image',
    sourcePath
  };
}

function mergeAttachments(
  existing: ChatAttachment[],
  incoming: ChatAttachment[]
): ChatAttachment[] {
  const byKey = new Map<string, ChatAttachment>();
  for (const attachment of [...existing, ...incoming]) {
    byKey.set(attachment.sourcePath ?? attachment.url, attachment);
  }
  return [...byKey.values()];
}

function resolveClaudeExecutable(): string {
  const explicit = [
    process.env.AGENT_PULSE_CLAUDE_EXECUTABLE,
    process.env.CLAUDE_CODE_EXECUTABLE,
    process.env.CLAUDE_CODE_PATH,
    process.env.CLAUDE_PATH
  ].find((candidate) => candidate?.trim());
  if (explicit) {
    return explicit.trim();
  }

  return firstExistingExecutable(collectClaudeExecutableCandidates()) ?? 'claude';
}

function collectClaudeExecutableCandidates(): string[] {
  const home = homedir();
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.local', 'share', 'claude', 'latest'),
    ...collectClaudeAppCandidates(path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code')),
    ...collectClaudeExtensionCandidates(path.join(home, '.vscode-insiders', 'extensions')),
    ...collectClaudeExtensionCandidates(path.join(home, '.vscode', 'extensions')),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ];
}

function collectClaudeAppCandidates(root: string): string[] {
  return readDirectoryEntries(root)
    .map((entry) => path.join(root, entry, 'claude.app', 'Contents', 'MacOS', 'claude'));
}

function collectClaudeExtensionCandidates(root: string): string[] {
  return readDirectoryEntries(root)
    .filter((entry) => entry.includes('anthropic.claude-code'))
    .map((entry) => path.join(root, entry, 'resources', 'native-binary', 'claude'));
}

function readDirectoryEntries(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

function firstExistingExecutable(candidates: string[]): string | undefined {
  const unique = [...new Set(candidates)];
  const executableCandidates = unique
    .map((candidate) => {
      try {
        accessSync(candidate, fsConstants.X_OK);
        return { candidate, mtimeMs: statSync(candidate).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { candidate: string; mtimeMs: number } => Boolean(entry))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return executableCandidates[0]?.candidate;
}

function claudeStartErrorMessage(error: unknown, executable: string): string {
  const details = error instanceof Error ? error.message : String(error);
  return `Claude Code could not start from Agent Pulse. The helper tried "${executable}" but it failed: ${details}`;
}

function claudeRuntimeErrorMessage(error: unknown): string {
  const details = typeof error === 'string'
    ? error.trim()
    : error instanceof Error
      ? error.message
      : String(error);
  return details
    ? `Claude Code stopped before finishing: ${details}`
    : 'Claude Code stopped before finishing.';
}

function noConversationFoundError(text: string): boolean {
  return /no conversation found with session id/i.test(text);
}

function extractPlanMessagesFromClaudeMessage(message: Record<string, unknown> | undefined, index: number, createdAt: string): ChatMessage[] {
  const content = Array.isArray(message?.content) ? message.content : [];
  const messages: ChatMessage[] = [];
  for (const [blockIndex, block] of content.entries()) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    const type = stringField(record, 'type');
    if (type !== 'tool_use') continue;
    const name = stringField(record, 'name') ?? stringField(record, 'tool_name') ?? '';
    if (!['todowrite', 'update_plan'].includes(name.toLowerCase())) continue;
    const text = extractPlanText(stringifyJSON(record.input));
    if (!text) continue;
    messages.push(ChatMessageSchema.parse({
      id: `claude-plan:${index}:${blockIndex}`,
      role: 'assistant',
      kind: 'plan',
      text,
      createdAt
    }));
  }
  return messages;
}

function extractPlanText(inputJSON: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJSON);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') {
    return '';
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.todos)) {
    return record.todos
      .map((todo) => {
        if (!todo || typeof todo !== 'object') return '';
        const item = todo as Record<string, unknown>;
        const content = stringField(item, 'content') ?? stringField(item, 'text') ?? '';
        const status = stringField(item, 'status') ?? 'pending';
        return content ? `[${status}] ${content}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (Array.isArray(record.plan)) {
    return record.plan.map(String).join('\n');
  }
  return '';
}

function fallbackPathFromProjectName(encoded: string): string {
  if (!encoded.startsWith('-')) {
    return '';
  }
  return `/${encoded.slice(1).split('-').join('/')}`;
}

function compactTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
}

function compactSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

function timestampToIso(timestamp: string | undefined, fallback: Date): string {
  return timestamp && !Number.isNaN(Date.parse(timestamp))
    ? new Date(timestamp).toISOString()
    : fallback.toISOString();
}

function stringifyJSON(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function recordField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeClaudeModelAlias(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'opus' || lower.includes('opus')) {
    return 'opus';
  }
  if (lower === 'sonnet' || lower.includes('sonnet')) {
    return 'sonnet';
  }
  return trimmed;
}

function normalizeClaudeEffort(effort: string | undefined): string | undefined {
  const trimmed = effort?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return CLAUDE_REASONING_LEVELS.some((entry) => entry.effort === trimmed)
    ? trimmed
    : undefined;
}

function usageFromClaudeMessage(message: Record<string, unknown> | undefined): ThreadUsage | undefined {
  const usage = recordField(message, 'usage');
  if (!usage) {
    return undefined;
  }
  const inputTokens = numberField(usage, 'input_tokens') ?? 0;
  const cacheCreationTokens = numberField(usage, 'cache_creation_input_tokens') ?? 0;
  const cacheReadTokens = numberField(usage, 'cache_read_input_tokens') ?? 0;
  const outputTokens = numberField(usage, 'output_tokens') ?? 0;
  const contextTokens = inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens;
  if (contextTokens <= 0) {
    return undefined;
  }
  return ThreadUsageSchema.parse({
    contextTokens,
    contextWindow: CLAUDE_CONTEXT_WINDOW_TOKENS,
    contextUsedPercent: Math.min(
      100,
      Math.round((contextTokens / CLAUDE_CONTEXT_WINDOW_TOKENS) * 100)
    )
  });
}

function mergeUsage(
  primary: ThreadUsage | undefined,
  secondary: ThreadUsage | undefined
): ThreadUsage | undefined {
  if (!primary && !secondary) {
    return undefined;
  }
  return ThreadUsageSchema.parse({
    ...(primary ?? {}),
    ...(secondary ?? {}),
    contextTokens: primary?.contextTokens ?? secondary?.contextTokens,
    contextWindow: primary?.contextWindow ?? secondary?.contextWindow,
    contextUsedPercent: primary?.contextUsedPercent ?? secondary?.contextUsedPercent
  });
}
