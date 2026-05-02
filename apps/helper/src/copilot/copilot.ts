import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  CatalogModelSchema,
  ChatMessageSchema,
  ProjectSchema,
  ThreadMessageResponseSchema,
  ThreadSchema,
  ThreadTranscriptSchema,
  type CatalogModel,
  type ChatAttachment,
  type ChatMessage,
  type LiveEvent,
  type PendingApprovalRequest,
  type Project,
  type Thread,
  type ThreadMessageResponse,
  type ThreadTranscript,
  type ThreadUsage
} from '@agent-pulse/shared';
import { projectIdForPath, workspaceNameFromCwd } from '../codex/thread-reader';
import { CopilotUsageReader } from './usage';

const COPILOT_PROVIDER = 'copilot' as const;
const THREAD_PREFIX = `${COPILOT_PROVIDER}:`;
const MAX_SESSIONS = 5_000;
const DEFAULT_REASONING_EFFORT = 'medium';
const COPILOT_START_GRACE_MS = 800;
// If the Copilot CLI produces no stdout output at all for this long, treat the turn as
// stuck and fail it. This catches the case where the child process is alive but silent
// (e.g. the JSON shape we don't recognise, or the CLI is waiting on input we will never
// send) so the thread doesn't spin on "Running" forever.
const COPILOT_IDLE_TIMEOUT_MS = 5 * 60_000;
const COPILOT_UNAVAILABLE_MODELS_CACHE_TTL_MS = 30_000;
const REASONING_LEVELS = [
  { effort: 'low', description: 'Fast Copilot reasoning.' },
  { effort: 'medium', description: 'Balanced Copilot reasoning.' },
  { effort: 'high', description: 'Deeper Copilot reasoning.' },
  { effort: 'xhigh', description: 'Extra-deep Copilot reasoning.' }
];
const COPILOT_MODELS: Array<{
  slug: string;
  displayName: string;
  description: string;
  priority: number;
}> = [
  {
    slug: 'gpt-5.4',
    displayName: 'GPT-5.4',
    description: 'GitHub Copilot GPT-5.4 model from local Copilot config.',
    priority: 5
  },
  {
    slug: 'claude-sonnet-4.5',
    displayName: 'Claude Sonnet 4.5',
    description: 'Default Claude Sonnet model available through GitHub Copilot.',
    priority: 10
  },
  {
    slug: 'claude-haiku-4.5',
    displayName: 'Claude Haiku 4.5',
    description: 'Fast Claude Haiku model available through GitHub Copilot.',
    priority: 20
  },
  {
    slug: 'claude-opus-4.6',
    displayName: 'Claude Opus 4.6',
    description: 'Higher-capability Claude Opus model available through GitHub Copilot.',
    priority: 30
  },
  {
    slug: 'claude-opus-4.6-fast',
    displayName: 'Claude Opus 4.6 Fast',
    description: 'Faster Claude Opus 4.6 variant available through GitHub Copilot.',
    priority: 40
  },
  {
    slug: 'claude-opus-4.6-1m',
    displayName: 'Claude Opus 4.6 1M',
    description: 'Long-context Claude Opus 4.6 variant available through GitHub Copilot.',
    priority: 50
  },
  {
    slug: 'claude-opus-4.5',
    displayName: 'Claude Opus 4.5',
    description: 'Claude Opus 4.5 model available through GitHub Copilot.',
    priority: 60
  },
  {
    slug: 'claude-sonnet-4',
    displayName: 'Claude Sonnet 4',
    description: 'Claude Sonnet 4 model available through GitHub Copilot.',
    priority: 70
  },
  {
    slug: 'gemini-3-pro-preview',
    displayName: 'Gemini 3 Pro Preview',
    description: 'Gemini model available through GitHub Copilot.',
    priority: 80
  },
  {
    slug: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    description: 'Codex-optimized GPT model available through GitHub Copilot.',
    priority: 90
  },
  {
    slug: 'gpt-5.2-codex',
    displayName: 'GPT-5.2 Codex',
    description: 'Codex-optimized GPT model available through GitHub Copilot.',
    priority: 100
  },
  {
    slug: 'gpt-5.2',
    displayName: 'GPT-5.2',
    description: 'GPT-5.2 model available through GitHub Copilot.',
    priority: 110
  },
  {
    slug: 'gpt-5.1-codex-max',
    displayName: 'GPT-5.1 Codex Max',
    description: 'Maximum-capability GPT-5.1 Codex model available through GitHub Copilot.',
    priority: 120
  },
  {
    slug: 'gpt-5.1-codex',
    displayName: 'GPT-5.1 Codex',
    description: 'Codex-optimized GPT model available through GitHub Copilot.',
    priority: 130
  },
  {
    slug: 'gpt-5.1',
    displayName: 'GPT-5.1',
    description: 'GPT-5.1 model available through GitHub Copilot.',
    priority: 140
  },
  {
    slug: 'gpt-5',
    displayName: 'GPT-5',
    description: 'GPT-5 model available through GitHub Copilot.',
    priority: 150
  },
  {
    slug: 'gpt-5.1-codex-mini',
    displayName: 'GPT-5.1 Codex Mini',
    description: 'Smaller Codex-optimized GPT model available through GitHub Copilot.',
    priority: 160
  },
  {
    slug: 'gpt-5-mini',
    displayName: 'GPT-5 Mini',
    description: 'Small GPT-5 model available through GitHub Copilot.',
    priority: 170
  },
  {
    slug: 'gpt-4.1',
    displayName: 'GPT-4.1',
    description: 'GPT-4.1 model available through GitHub Copilot.',
    priority: 180
  }
];

type SpawnProcess = typeof spawn;

type CopilotProviderOptions = {
  copilotHome?: string;
  executable?: string;
  spawnProcess?: SpawnProcess;
  now?: () => Date;
  usageReader?: { readUsage(): Promise<ThreadUsage | undefined> };
};

type CopilotThreadListOptions = {
  defaultLimit?: number;
  groupLimits?: Map<string, number> | Record<string, number>;
};

type ParsedCopilotSession = {
  nativeSessionId: string;
  threadId: string;
  dirPath: string;
  eventsPath?: string;
  title: string;
  workspacePath: string;
  lastActivityAt: string;
  lastTurnSummary: string;
  model?: string;
  reasoningEffort?: string;
  messages: ChatMessage[];
};

type CopilotSessionCandidate = {
  nativeSessionId: string;
  dirPath: string;
  workspacePath: string;
  lastActivityMs: number;
};

type DraftCopilotThread = {
  nativeSessionId: string;
  cwd: string;
  thread: Thread;
};

type LiveCopilotSession = {
  nativeSessionId: string;
  threadId: string;
  cwd: string;
  process: ChildProcessWithoutNullStreams;
  activeTurnId: string;
  messages: ChatMessage[];
  stdoutBuffer: string;
  stderrBuffer: string;
  isStreaming: boolean;
  startedAt: string;
  model?: string;
  reasoningEffort?: string;
  attachmentTempDir?: string;
  startGate: {
    settled: boolean;
    timer?: NodeJS.Timeout;
    resolve?: () => void;
    reject?: (error: Error) => void;
  };
  idleTimer?: NodeJS.Timeout;
};

type CopilotFailureSummary = {
  message: string;
  unavailableModel?: string;
};

export class CopilotProvider {
  private readonly copilotHome: string;
  private readonly executable: string;
  private readonly spawnProcess: SpawnProcess;
  private readonly now: () => Date;
  private readonly usageReader: { readUsage(): Promise<ThreadUsage | undefined> };
  private readonly drafts = new Map<string, DraftCopilotThread>();
  private readonly liveSessions = new Map<string, LiveCopilotSession>();
  private readonly modelOverrides = new Map<string, string>();
  private readonly effortOverrides = new Map<string, string>();
  private readonly threadCwds = new Map<string, string>();
  private readonly liveListeners = new Set<(event: LiveEvent) => void>();
  private readonly liveStateListeners = new Set<(threadId: string) => void>();
  private readonly unavailableModels = new Set<string>();
  private unavailableModelsLoadedAt = 0;

  constructor(options: CopilotProviderOptions = {}) {
    this.copilotHome = options.copilotHome ?? path.join(homedir(), '.copilot');
    this.executable = options.executable ?? (options.spawnProcess ? 'copilot' : resolveCopilotExecutable());
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? (() => new Date());
    this.usageReader = options.usageReader ?? new CopilotUsageReader({ copilotHome: this.copilotHome });
  }

  onLiveEvent(listener: (event: LiveEvent) => void): () => void {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  }

  onLiveStateChange(listener: (threadId: string) => void): () => void {
    this.liveStateListeners.add(listener);
    return () => this.liveStateListeners.delete(listener);
  }

  async listThreads(options: CopilotThreadListOptions = {}): Promise<Thread[]> {
    const sessions = await this.readSessions(options);
    const threads = sessions.map((session) => this.threadFromSession(session));
    for (const draft of this.drafts.values()) {
      if (!threads.some((thread) => thread.threadId === draft.thread.threadId)) {
        threads.unshift(draft.thread);
      }
    }
    return threads;
  }

  async listProjects(): Promise<Project[]> {
    const paths = new Set<string>();
    for (const workspacePath of await this.readProjectPaths()) {
      paths.add(workspacePath);
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
          providers: [COPILOT_PROVIDER]
        })
      );
  }

  async startThread(cwd: string, options: { model?: string; reasoningEffort?: string } = {}): Promise<Thread> {
    const nativeSessionId = randomUUID();
    const threadId = threadIdForCopilotSession(nativeSessionId);
    const model = normalizeCopilotModel(options.model);
    const reasoningEffort = normalizeCopilotEffort(options.reasoningEffort);
    if (model) {
      await this.refreshUnavailableModels();
      this.assertModelAvailable(model);
    }
    const thread = ThreadSchema.parse({
      threadId,
      provider: COPILOT_PROVIDER,
      providerThreadId: nativeSessionId,
      title: 'New Copilot chat',
      workspace: workspaceNameFromCwd(cwd),
      workspacePath: cwd,
      status: 'idle',
      lastActivityAt: this.now().toISOString(),
      lastTurnSummary: '',
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    });
    this.drafts.set(threadId, { nativeSessionId, cwd, thread });
    this.threadCwds.set(threadId, cwd);
    if (model) this.modelOverrides.set(threadId, model);
    if (reasoningEffort) this.effortOverrides.set(threadId, reasoningEffort);
    return thread;
  }

  discardDraftThread(threadId: string): boolean {
    const draft = this.drafts.get(threadId);
    if (!draft) return false;
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
    const messages = mergeLiveMessages(session?.messages ?? [], live?.messages ?? []);
    const usage = await this.usageReader.readUsage().catch(() => undefined);
    const activeTurnId = live?.isStreaming ? live.activeTurnId : null;
    return ThreadTranscriptSchema.parse({
      threadId,
      provider: COPILOT_PROVIDER,
      providerThreadId: nativeSessionId,
      activeTurnId,
      sendState: live?.isStreaming
        ? { canSend: false, reason: 'thread_changed', label: 'Copilot is working' }
        : { canSend: true, reason: 'ready', label: 'Send' },
      messages,
      ...(usage ? { usage } : {}),
      ...(this.modelForThread(threadId, session, draft, live) ? { model: this.modelForThread(threadId, session, draft, live) } : {}),
      ...(this.effortForThread(threadId, session, draft, live) ? { reasoningEffort: this.effortForThread(threadId, session, draft, live) } : {})
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
    const liveExisting = this.liveSessions.get(threadId);
    if (liveExisting?.isStreaming) {
      throw new Error('Copilot is still working on this chat.');
    }
    const cwd = await this.cwdForThread(threadId, nativeSessionId);
    const model = this.modelForSend(threadId, options.model);
    if (model) {
      await this.refreshUnavailableModels();
      this.assertModelAvailable(model);
    }
    const effort = this.effortForSend(threadId, options.effort);
    const turnId = `copilot-turn-${randomUUID()}`;
    const userMessage = ChatMessageSchema.parse({
      id: `copilot-user:${turnId}`,
      role: 'user',
      kind: 'message',
      text: trimmed,
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      createdAt: this.now().toISOString()
    });
    const promptInput = await copilotPromptWithAttachmentReferences(trimmed, options.attachments ?? []);
    const args = [
      `--resume=${nativeSessionId}`,
      '--prompt',
      promptInput.prompt,
      '--output-format',
      'json',
      '--stream',
      'on',
      '--no-color',
      // Run in autopilot, non-interactive: there is no user terminal attached
      // to the CLI, so any tool that requires per-call approval (which is the
      // default) fails immediately with `code: denied / message: "Permission
      // denied and could not request permission from user"`. The Copilot CLI
      // help text spells this out: --allow-all-tools is "required for
      // non-interactive mode". Without these flags, the agent can read files
      // but every write/patch/shell tool fails silently and the user only sees
      // the agent give up partway.
      //
      // OpenAssist's Copilot integration uses --acp + session/set_mode
      // autopilot to achieve the same effect over the Agent Client Protocol
      // transport. We're on the prompt-based transport, so the equivalent is
      // these CLI flags + --mode autopilot.
      '--mode',
      'autopilot',
      '--allow-all-tools',
      '--allow-all-paths',
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : [])
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(this.executable, args, {
        cwd,
        env: copilotSpawnEnv(),
        stdio: 'pipe'
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      await cleanupCopilotAttachmentTempDirForPrompt(promptInput);
      throw new Error(copilotStartErrorMessage(error, this.executable));
    }
    const live: LiveCopilotSession = {
      nativeSessionId,
      threadId,
      cwd,
      process: child,
      activeTurnId: turnId,
      messages: [userMessage],
      stdoutBuffer: '',
      stderrBuffer: '',
      isStreaming: true,
      startedAt: this.now().toISOString(),
      ...(model ? { model } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(promptInput.tempDir ? { attachmentTempDir: promptInput.tempDir } : {}),
      startGate: {
        settled: false
      }
    };
    this.liveSessions.set(threadId, live);
    const startPromise = this.awaitLiveStart(live);
    this.armIdleWatchdog(live);
    child.stdout.on('data', (chunk) => this.handleStdout(live, chunk));
    child.stderr.on('data', (chunk) => {
      live.stderrBuffer += chunk.toString('utf8');
      this.armIdleWatchdog(live);
    });
    child.stdin.on('error', (error) => {
      if (this.liveSessions.get(threadId) !== live) return;
      live.stderrBuffer = live.stderrBuffer || copilotStartErrorMessage(error, this.executable);
      this.finishLiveSession(live, 'failed');
    });
    child.on('error', (error) => {
      if (this.liveSessions.get(threadId) !== live) return;
      live.stderrBuffer = live.stderrBuffer || copilotStartErrorMessage(error, this.executable);
      this.finishLiveSession(live, 'failed');
    });
    child.on('exit', (code) => this.finishLiveSession(live, code === 0 ? 'completed' : 'failed', code ?? undefined));
    await startPromise;
    this.drafts.delete(threadId);
    this.emitThreadWorking(threadId);
    return ThreadMessageResponseSchema.parse({
      ok: true,
      mode: 'start',
      turnId,
      transcript: await this.readTranscript(threadId)
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    const live = this.liveSessions.get(threadId);
    if (!live) {
      throw new Error('Copilot is not running for this thread.');
    }
    live.process.kill('SIGTERM');
    this.finishLiveSession(live, 'interrupted');
  }

  async deleteThread(threadId: string): Promise<void> {
    const nativeSessionId = nativeSessionIdFromThreadId(threadId);
    const hadDraft = this.drafts.delete(threadId);
    const live = this.liveSessions.get(threadId);
    if (live) {
      this.liveSessions.delete(threadId);
      live.process.kill('SIGTERM');
      cleanupCopilotAttachmentTempDir(live);
    }
    this.modelOverrides.delete(threadId);
    this.effortOverrides.delete(threadId);
    this.threadCwds.delete(threadId);
    const sessionDir = path.join(this.copilotHome, 'session-state', nativeSessionId);
    try {
      await stat(sessionDir);
    } catch {
      if (hadDraft || live) return;
      throw new Error('Copilot session was not found.');
    }
    await rm(sessionDir, { recursive: true, force: true });
  }

  async listModels(): Promise<CatalogModel[]> {
    await this.refreshUnavailableModels();
    return COPILOT_MODELS.map((model) =>
      CatalogModelSchema.parse({
        ...model,
        provider: COPILOT_PROVIDER,
        defaultReasoningLevel: DEFAULT_REASONING_EFFORT,
        supportedReasoningLevels: REASONING_LEVELS,
        visibility: this.unavailableModels.has(model.slug) ? 'hidden' : 'visible'
      })
    );
  }

  async setModel(threadId: string, model: string, reasoningEffort?: string): Promise<void> {
    const normalizedModel = normalizeCopilotModel(model);
    const normalizedEffort = normalizeCopilotEffort(reasoningEffort);
    if (!normalizedModel) {
      throw new Error('Copilot model is required.');
    }
    await this.refreshUnavailableModels();
    this.assertModelAvailable(normalizedModel);
    if (reasoningEffort && !normalizedEffort) {
      throw new Error('Copilot reasoning effort is not supported.');
    }
    const live = this.liveSessions.get(threadId);
    if (live?.isStreaming) {
      throw new Error('Copilot is still working. Change the model after this turn finishes.');
    }
    this.modelOverrides.set(threadId, normalizedModel);
    if (normalizedEffort) {
      this.effortOverrides.set(threadId, normalizedEffort);
    }
    const draft = this.drafts.get(threadId);
    if (draft) {
      draft.thread = ThreadSchema.parse({
        ...draft.thread,
        model: normalizedModel,
        ...(normalizedEffort ? { reasoningEffort: normalizedEffort } : {})
      });
    }
    this.emitTranscript(threadId);
  }

  getPendingApprovalRequests(_threadId: string): PendingApprovalRequest[] {
    return [];
  }

  isThreadStreaming(threadId: string): boolean {
    return this.liveSessions.get(threadId)?.isStreaming === true;
  }

  isThreadWaitingForApproval(_threadId: string): boolean {
    return false;
  }

  dispose(): void {
    for (const live of this.liveSessions.values()) {
      live.process.kill('SIGTERM');
      cleanupCopilotAttachmentTempDir(live);
    }
    this.liveSessions.clear();
  }

  private async readProjectPaths(): Promise<string[]> {
    const candidates = await this.readSessionCandidates();
    return [...new Set(candidates.map((candidate) => candidate.workspacePath))].filter((workspacePath) =>
      path.isAbsolute(workspacePath)
    );
  }

  private async readSessions(options: CopilotThreadListOptions = {}): Promise<ParsedCopilotSession[]> {
    const candidates = await this.readSessionCandidates();
    const selected = limitCopilotSessionCandidates(
      candidates,
      options.defaultLimit ?? MAX_SESSIONS,
      options.groupLimits
    );
    const sessions: ParsedCopilotSession[] = [];
    for (const candidate of selected) {
      const parsed = await parseCopilotSessionDir(candidate.dirPath, candidate.nativeSessionId).catch(
        () => undefined
      );
      if (parsed) {
        sessions.push(parsed);
      }
      if (sessions.length >= MAX_SESSIONS) {
        break;
      }
    }
    return sessions.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  }

  private async readSessionCandidates(): Promise<CopilotSessionCandidate[]> {
    const stateDir = path.join(this.copilotHome, 'session-state');
    let dirs;
    try {
      dirs = await readdir(stateDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const candidates: CopilotSessionCandidate[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(stateDir, dir.name);
      const dirStat = await stat(dirPath).catch(() => undefined);
      if (!dirStat) continue;
      const workspacePath = path.join(dirPath, 'workspace.yaml');
      const workspace = parseSimpleYaml(await readFile(workspacePath, 'utf8').catch(() => ''));
      const cwd = workspace.cwd ?? workspace.git_root ?? '';
      if (!path.isAbsolute(cwd)) continue;
      const lastActivity = Date.parse(
        timestampToIso(workspace.updated_at ?? workspace.created_at, dirStat.mtime)
      );
      candidates.push({
        nativeSessionId: dir.name,
        dirPath,
        workspacePath: cwd,
        lastActivityMs: Number.isFinite(lastActivity) ? lastActivity : dirStat.mtimeMs
      });
      if (candidates.length >= MAX_SESSIONS) {
        break;
      }
    }
    return candidates.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }

  private async readSessionByNativeId(nativeSessionId: string): Promise<ParsedCopilotSession | undefined> {
    const session = await parseCopilotSessionDir(path.join(this.copilotHome, 'session-state', nativeSessionId), nativeSessionId).catch(() => undefined);
    return session;
  }

  private threadFromSession(session: ParsedCopilotSession): Thread {
    this.threadCwds.set(session.threadId, session.workspacePath);
    const live = this.liveSessions.get(session.threadId);
    return ThreadSchema.parse({
      threadId: session.threadId,
      provider: COPILOT_PROVIDER,
      providerThreadId: session.nativeSessionId,
      title: session.title,
      workspace: workspaceNameFromCwd(session.workspacePath),
      workspacePath: session.workspacePath,
      status: live?.isStreaming ? 'running' : 'idle',
      lastActivityAt: live?.startedAt ?? session.lastActivityAt,
      lastTurnSummary: session.lastTurnSummary,
      ...(this.modelForThread(session.threadId, session, undefined, live) ? { model: this.modelForThread(session.threadId, session, undefined, live) } : {}),
      ...(this.effortForThread(session.threadId, session, undefined, live) ? { reasoningEffort: this.effortForThread(session.threadId, session, undefined, live) } : {})
    });
  }

  private async cwdForThread(threadId: string, nativeSessionId: string): Promise<string> {
    const draft = this.drafts.get(threadId);
    if (draft) return draft.cwd;
    const remembered = this.threadCwds.get(threadId);
    if (remembered) return remembered;
    const session = await this.readSessionByNativeId(nativeSessionId);
    if (!session?.workspacePath || !path.isAbsolute(session.workspacePath)) {
      throw new Error('Copilot session is missing a workspace folder.');
    }
    return session.workspacePath;
  }

  private handleStdout(live: LiveCopilotSession, chunk: Buffer): void {
    this.resolveLiveStart(live);
    this.armIdleWatchdog(live);
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

  private handleLine(live: LiveCopilotSession, line: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const data = asRecord(payload.data);
    const text =
      stringField(data, 'content') ??
      stringField(data, 'transformedContent') ??
      stringField(payload, 'content') ??
      stringField(payload, 'text') ??
      stringField(payload, 'message');
    const type = stringField(payload, 'type')?.toLowerCase();
    // The Copilot CLI emits a stream of typed events. The shapes are documented inline in
    // parseCopilotSessionDir below, which is the same parser used to read finished sessions
    // off disk. Keep the two in sync — anything we recognise there should produce a usable
    // live update here too.
    if (type === 'assistant.message' || type?.includes('assistant.message') || (type?.includes('assistant') && text)) {
      const reasoningText = stringField(data, 'reasoningText');
      if (reasoningText) {
        upsertMessage(live.messages, ChatMessageSchema.parse({
          id: `copilot-reasoning:${live.activeTurnId}`,
          role: 'activity',
          kind: 'reasoning',
          text: reasoningText,
          createdAt: this.now().toISOString()
        }));
      }
      if (text) {
        upsertMessage(live.messages, ChatMessageSchema.parse({
          id: `copilot-assistant:${live.activeTurnId}`,
          role: 'assistant',
          kind: 'message',
          phase: 'final_answer',
          text,
          createdAt: this.now().toISOString()
        }));
      }
      if (reasoningText || text) {
        this.emitTranscript(live.threadId);
      }
      return;
    }
    if (type === 'tool.execution_start') {
      const toolCallId = stringField(data, 'toolCallId') ?? `${live.activeTurnId}:${live.messages.length}`;
      const name = stringField(data, 'toolName') ?? 'Using tool';
      const args = stringifyJSON(data?.arguments);
      upsertMessage(live.messages, ChatMessageSchema.parse({
        id: `copilot-tool-start:${toolCallId}`,
        role: 'activity',
        kind: 'tool',
        text: args && args !== '{}' ? `${name}\n${args}` : name,
        createdAt: this.now().toISOString()
      }));
      this.emitTranscript(live.threadId);
      return;
    }
    if (type === 'tool.execution_complete') {
      const toolCallId = stringField(data, 'toolCallId') ?? `${live.activeTurnId}:${live.messages.length}`;
      const name = stringField(data, 'toolName') ?? 'Tool result';
      const result = asRecord(data?.result);
      const resultText = stringField(result, 'content') ?? stringField(result, 'detailedContent') ?? '';
      upsertMessage(live.messages, ChatMessageSchema.parse({
        id: `copilot-tool-complete:${toolCallId}`,
        role: 'activity',
        kind: 'tool',
        text: resultText ? `${name} completed\n${resultText}` : `${name} completed`,
        createdAt: this.now().toISOString()
      }));
      this.emitTranscript(live.threadId);
      return;
    }
  }

  private finishLiveSession(
    live: LiveCopilotSession,
    status: 'completed' | 'interrupted' | 'failed',
    exitCode?: number
  ): void {
    if (this.liveSessions.get(live.threadId) !== live) {
      return;
    }
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = undefined;
    }
    live.isStreaming = false;
    if (status === 'failed') {
      const failure = summarizeCopilotFailure(live, exitCode);
      if (failure.unavailableModel) {
        this.markModelUnavailable(live.threadId, failure.unavailableModel);
      }
      upsertMessage(live.messages, ChatMessageSchema.parse({
        id: `copilot-status:${live.activeTurnId}`,
        role: 'activity',
        kind: 'status',
        text: failure.message,
        createdAt: this.now().toISOString()
      }));
      this.rejectLiveStart(live, new Error(failure.message));
    } else {
      this.resolveLiveStart(live);
    }
    this.liveSessions.delete(live.threadId);
    cleanupCopilotAttachmentTempDir(live);
    this.emitStatus(live.threadId, status === 'failed' ? 'error' : 'idle');
    this.broadcast({ type: 'thread/streaming-changed', payload: { threadId: live.threadId, isStreaming: false } });
    this.emitTranscript(live.threadId);
  }

  private awaitLiveStart(live: LiveCopilotSession): Promise<void> {
    if (live.startGate.settled) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      live.startGate.resolve = resolve;
      live.startGate.reject = reject;
      live.startGate.timer = setTimeout(() => this.resolveLiveStart(live), COPILOT_START_GRACE_MS);
    });
  }

  private resolveLiveStart(live: LiveCopilotSession): void {
    if (live.startGate.settled) {
      return;
    }
    live.startGate.settled = true;
    if (live.startGate.timer) {
      clearTimeout(live.startGate.timer);
      live.startGate.timer = undefined;
    }
    live.startGate.resolve?.();
  }

  private rejectLiveStart(live: LiveCopilotSession, error: Error): void {
    if (live.startGate.settled) {
      return;
    }
    live.startGate.settled = true;
    if (live.startGate.timer) {
      clearTimeout(live.startGate.timer);
      live.startGate.timer = undefined;
    }
    live.startGate.reject?.(error);
  }

  private armIdleWatchdog(live: LiveCopilotSession): void {
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
    }
    live.idleTimer = setTimeout(() => this.handleIdleTimeout(live), COPILOT_IDLE_TIMEOUT_MS);
  }

  private handleIdleTimeout(live: LiveCopilotSession): void {
    if (this.liveSessions.get(live.threadId) !== live) {
      return;
    }
    // Seed stderr with a clear reason so summarizeCopilotFailure surfaces a friendly
    // message in the transcript instead of "exited before the turn started".
    if (!live.stderrBuffer.trim()) {
      live.stderrBuffer = 'GitHub Copilot stopped responding. The turn was cancelled after no output for several minutes.';
    }
    if (!live.process.killed) {
      live.process.kill('SIGTERM');
    }
    this.finishLiveSession(live, 'failed');
  }

  private async refreshUnavailableModels(): Promise<void> {
    const nowMs = this.now().getTime();
    if (nowMs - this.unavailableModelsLoadedAt < COPILOT_UNAVAILABLE_MODELS_CACHE_TTL_MS) {
      return;
    }
    this.unavailableModelsLoadedAt = nowMs;
    const logDir = path.join(this.copilotHome, 'logs');
    const fromLogs = await readUnavailableCopilotModels(logDir);
    for (const model of fromLogs) {
      this.unavailableModels.add(model);
    }
  }

  private assertModelAvailable(model: string): void {
    if (!this.unavailableModels.has(model)) {
      return;
    }
    throw new Error(`Copilot model "${model}" is not available for this account.`);
  }

  private markModelUnavailable(threadId: string, model: string): void {
    this.unavailableModels.add(model);
    if (this.modelOverrides.get(threadId) === model) {
      this.modelOverrides.delete(threadId);
    }
    const draft = this.drafts.get(threadId);
    if (draft && draft.thread.model === model) {
      draft.thread = ThreadSchema.parse({
        ...draft.thread,
        model: undefined,
        reasoningEffort: undefined
      });
    }
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

  private modelForSend(threadId: string, requestedModel: string | undefined): string | undefined {
    return normalizeCopilotModel(requestedModel) ?? this.modelOverrides.get(threadId) ?? normalizeCopilotModel(this.drafts.get(threadId)?.thread.model);
  }

  private effortForSend(threadId: string, requestedEffort: string | undefined): string | undefined {
    const explicit = normalizeCopilotEffort(requestedEffort);
    if (explicit) return explicit;
    if (requestedEffort) {
      throw new Error('Copilot reasoning effort is not supported.');
    }
    return this.effortOverrides.get(threadId) ?? normalizeCopilotEffort(this.drafts.get(threadId)?.thread.reasoningEffort);
  }

  private modelForThread(
    threadId: string,
    session?: ParsedCopilotSession,
    draft?: DraftCopilotThread,
    live?: LiveCopilotSession
  ): string | undefined {
    return normalizeCopilotModel(live?.model) ?? this.modelOverrides.get(threadId) ?? normalizeCopilotModel(draft?.thread.model) ?? normalizeCopilotModel(session?.model);
  }

  private effortForThread(
    threadId: string,
    session?: ParsedCopilotSession,
    draft?: DraftCopilotThread,
    live?: LiveCopilotSession
  ): string | undefined {
    return normalizeCopilotEffort(live?.reasoningEffort) ?? this.effortOverrides.get(threadId) ?? normalizeCopilotEffort(draft?.thread.reasoningEffort) ?? normalizeCopilotEffort(session?.reasoningEffort);
  }
}

export function isCopilotThreadId(threadId: string): boolean {
  return threadId.startsWith(THREAD_PREFIX);
}

export function threadIdForCopilotSession(sessionId: string): string {
  return `${THREAD_PREFIX}${sessionId}`;
}

function nativeSessionIdFromThreadId(threadId: string): string {
  return isCopilotThreadId(threadId) ? threadId.slice(THREAD_PREFIX.length) : threadId;
}

async function parseCopilotSessionDir(dirPath: string, nativeSessionId: string): Promise<ParsedCopilotSession | undefined> {
  const workspacePath = path.join(dirPath, 'workspace.yaml');
  const eventsPath = path.join(dirPath, 'events.jsonl');
  const dirStat = await stat(dirPath);
  const workspace = parseSimpleYaml(await readFile(workspacePath, 'utf8').catch(() => ''));
  const eventsContent = await readFile(eventsPath, 'utf8').catch(() => '');
  const messages: ChatMessage[] = [];
  let cwd = workspace.cwd ?? workspace.git_root ?? '';
  let title = compactTitle(workspace.summary ?? '');
  let lastActivityAt = timestampToIso(workspace.updated_at ?? workspace.created_at, dirStat.mtime);
  let lastTurnSummary = '';
  let model: string | undefined;
  let reasoningEffort: string | undefined;

  const toolNames = new Map<string, string>();
  const toolArguments = new Map<string, string>();
  for (const [index, line] of eventsContent.split('\n').filter(Boolean).entries()) {
    const payload = parseJsonRecord(line);
    if (!payload) continue;
    const type = stringField(payload, 'type');
    const data = asRecord(payload.data);
    const timestamp = timestampToIso(stringField(payload, 'timestamp'), dirStat.mtime);
    lastActivityAt = timestamp;
    if (type === 'session.start') {
      model = normalizeCopilotModel(stringField(data, 'selectedModel')) ?? model;
      const context = asRecord(data?.context);
      cwd = stringField(context, 'cwd') ?? cwd;
      continue;
    }
    if (type === 'user.message') {
      const text = stringField(data, 'content') ?? stringField(data, 'transformedContent') ?? '';
      if (!text) continue;
      title = title || compactTitle(text);
      messages.push(ChatMessageSchema.parse({
        id: stringField(payload, 'id') ?? `copilot-user:${index}`,
        role: 'user',
        kind: 'message',
        text,
        createdAt: timestamp
      }));
      continue;
    }
    if (type === 'assistant.message') {
      const reasoningText = stringField(data, 'reasoningText');
      if (reasoningText) {
        messages.push(ChatMessageSchema.parse({
          id: `copilot-reasoning:${stringField(payload, 'id') ?? index}`,
          role: 'activity',
          kind: 'reasoning',
          text: reasoningText,
          createdAt: timestamp
        }));
      }
      const toolRequests = Array.isArray(data?.toolRequests) ? data.toolRequests : [];
      for (const [toolIndex, tool] of toolRequests.entries()) {
        const record = asRecord(tool);
        const toolCallId = stringField(record, 'toolCallId') ?? `${index}:${toolIndex}`;
        const name = stringField(record, 'name') ?? 'Using tool';
        const args = stringifyJSON(record?.arguments);
        toolNames.set(toolCallId, name);
        toolArguments.set(toolCallId, args);
        messages.push(ChatMessageSchema.parse({
          id: `copilot-tool-request:${toolCallId}`,
          role: 'activity',
          kind: 'tool',
          text: args && args !== '{}' ? `${name}\n${args}` : name,
          createdAt: timestamp
        }));
      }
      const text = stringField(data, 'content') ?? '';
      if (text) {
        lastTurnSummary = compactSummary(text);
        messages.push(ChatMessageSchema.parse({
          id: stringField(data, 'messageId') ?? stringField(payload, 'id') ?? `copilot-assistant:${index}`,
          role: 'assistant',
          kind: 'message',
          // Mark every parsed assistant message as final_answer so the
          // renderer's findFinalResponseIndex (Pass 1) can carve the latest
          // one out as the visible answer bubble. Without this, Copilot turns
          // that emitted multiple `assistant.message` chunks (a Copilot CLI
          // quirk where it streams progress updates as separate assistant
          // messages before the final big answer) end up with NO message
          // matching `phase === 'final_answer'`, so the entire 15 kB final
          // text gets buried inside the activity group as a "progress update"
          // item and the user only sees the collapsed "Used the browser N
          // times" header. Pass 1 walks backward and picks the latest match,
          // so intermediate messages naturally collapse into the group.
          phase: 'final_answer',
          text,
          createdAt: timestamp
        }));
      }
      continue;
    }
    if (type === 'tool.execution_start') {
      const toolCallId = stringField(data, 'toolCallId') ?? `${index}`;
      const name = stringField(data, 'toolName') ?? toolNames.get(toolCallId) ?? 'Using tool';
      const args = stringifyJSON(data?.arguments);
      toolNames.set(toolCallId, name);
      toolArguments.set(toolCallId, args);
      messages.push(ChatMessageSchema.parse({
        id: `copilot-tool-start:${toolCallId}`,
        role: 'activity',
        kind: 'tool',
        text: args && args !== '{}' ? `${name}\n${args}` : name,
        createdAt: timestamp
      }));
      continue;
    }
    if (type === 'tool.execution_complete') {
      const toolCallId = stringField(data, 'toolCallId') ?? `${index}`;
      const name = stringField(data, 'toolName') ?? toolNames.get(toolCallId) ?? 'Tool result';
      const result = asRecord(data?.result);
      const resultText = compactSummary(stringField(result, 'content') ?? stringField(result, 'detailedContent') ?? '');
      messages.push(ChatMessageSchema.parse({
        id: `copilot-tool-complete:${toolCallId}`,
        role: 'activity',
        kind: 'tool',
        text: resultText ? `${name} completed\n${resultText}` : `${name} completed`,
        createdAt: timestamp
      }));
      continue;
    }
    if (type === 'assistant.turn_start') {
      const effort = stringField(data, 'reasoningEffort') ?? stringField(data, 'effort');
      reasoningEffort = normalizeCopilotEffort(effort) ?? reasoningEffort;
    }
  }

  if (!cwd || !path.isAbsolute(cwd)) {
    return undefined;
  }
  return {
    nativeSessionId,
    threadId: threadIdForCopilotSession(nativeSessionId),
    dirPath,
    ...(eventsContent ? { eventsPath } : {}),
    title: title || 'Copilot chat',
    workspacePath: cwd,
    lastActivityAt,
    lastTurnSummary,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    messages
  };
}

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    result[key] = rawValue.replace(/^['"]|['"]$/g, '').trim();
  }
  return result;
}

function limitCopilotSessionCandidates(
  candidates: CopilotSessionCandidate[],
  defaultLimit: number,
  groupLimits: Map<string, number> | Record<string, number> = {}
): CopilotSessionCandidate[] {
  const counts = new Map<string, number>();
  return candidates.filter((candidate) => {
    const limit = threadGroupLimit(candidate.workspacePath, defaultLimit, groupLimits, MAX_SESSIONS);
    const count = counts.get(candidate.workspacePath) ?? 0;
    if (count >= limit) {
      return false;
    }
    counts.set(candidate.workspacePath, count + 1);
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

function mergeLiveMessages(base: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  if (live.length === 0) {
    return sortMessagesByCreatedAt(base);
  }
  const liveSignatures = new Map<string, number>();
  for (const message of live) {
    const signature = messageContentSignature(message);
    liveSignatures.set(signature, (liveSignatures.get(signature) ?? 0) + 1);
  }
  const baseWithoutEchoes: ChatMessage[] = [];
  for (const message of base) {
    const signature = messageContentSignature(message);
    const count = liveSignatures.get(signature) ?? 0;
    if (count > 0) {
      liveSignatures.set(signature, count - 1);
      continue;
    }
    baseWithoutEchoes.push(message);
  }
  return sortMessagesByCreatedAt([...baseWithoutEchoes, ...live]);
}

function messageContentSignature(message: ChatMessage): string {
  return [message.role, message.kind, message.text.trim()].join('\u001f');
}

function sortMessagesByCreatedAt(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const aTime = Date.parse(a.message.createdAt);
      const bTime = Date.parse(b.message.createdAt);
      const safeA = Number.isFinite(aTime) ? aTime : 0;
      const safeB = Number.isFinite(bTime) ? bTime : 0;
      return safeA === safeB ? a.index - b.index : safeA - safeB;
    })
    .map((entry) => entry.message);
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage): void {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index >= 0) {
    messages[index] = message;
  } else {
    messages.push(message);
  }
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

function parseJsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringifyJSON(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeCopilotModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed || undefined;
}

function normalizeCopilotEffort(effort: string | undefined): string | undefined {
  const trimmed = effort?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return REASONING_LEVELS.some((entry) => entry.effort === trimmed) ? trimmed : undefined;
}

async function copilotPromptWithAttachmentReferences(
  prompt: string,
  attachments: ChatAttachment[]
): Promise<{ prompt: string; hasLocalReferences: boolean; tempDir?: string }> {
  let tempDir: string | undefined;
  const references: Array<{ index: number; filePath: string; mimeType?: string }> = [];
  try {
    for (const [index, attachment] of attachments.entries()) {
      const sourcePath = attachment.sourcePath?.trim();
      if (sourcePath) {
        references.push({
          index: index + 1,
          filePath: sourcePath,
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {})
        });
        continue;
      }
      const image = dataImageFromAttachment(attachment);
      if (!image) continue;
      tempDir ??= await mkdtemp(path.join(tmpdir(), 'agent-pulse-copilot-images-'));
      const filePath = path.join(
        tempDir,
        `image-${index + 1}-${randomUUID()}.${extensionForImageMimeType(image.mimeType)}`
      );
      await writeFile(filePath, Buffer.from(image.data, 'base64'));
      references.push({ index: index + 1, filePath, mimeType: image.mimeType });
    }
  } catch (error) {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
  if (!references.length) {
    return { prompt, hasLocalReferences: false, ...(tempDir ? { tempDir } : {}) };
  }
  const attachmentLines = references.map((reference) => {
    const typeLabel = reference.mimeType ? ` (${reference.mimeType})` : '';
    return `- Image ${reference.index}${typeLabel}: ${reference.filePath}`;
  });
  return {
    prompt: [
      prompt,
      '',
      'Attached image files:',
      ...attachmentLines,
      '',
      'Please inspect these image file paths as part of this message.'
    ].join('\n'),
    hasLocalReferences: true,
    ...(tempDir ? { tempDir } : {})
  };
}

function dataImageFromAttachment(attachment: ChatAttachment): { mimeType: string; data: string } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/iu.exec(attachment.url);
  if (!match) return undefined;
  return {
    mimeType: match[1]!.toLowerCase(),
    data: match[2]!.replace(/\s/gu, '')
  };
}

function extensionForImageMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return mimeType.split('/')[1]?.replace(/[^a-z0-9]/giu, '') || 'png';
  }
}

function cleanupCopilotAttachmentTempDir(live: LiveCopilotSession): void {
  const tempDir = live.attachmentTempDir;
  if (!tempDir) return;
  live.attachmentTempDir = undefined;
  void rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}

async function cleanupCopilotAttachmentTempDirForPrompt(
  promptInput: { tempDir?: string }
): Promise<void> {
  if (!promptInput.tempDir) return;
  await rm(promptInput.tempDir, { recursive: true, force: true }).catch(() => undefined);
}

function resolveCopilotExecutable(): string {
  const explicit = [
    process.env.AGENT_PULSE_COPILOT_EXECUTABLE,
    process.env.GITHUB_COPILOT_EXECUTABLE,
    process.env.COPILOT_EXECUTABLE,
    process.env.COPILOT_PATH
  ].find((candidate) => candidate?.trim());
  if (explicit) {
    return explicit.trim();
  }

  return firstExistingExecutable(collectCopilotExecutableCandidates()) ?? 'copilot';
}

function collectCopilotExecutableCandidates(): string[] {
  const home = homedir();
  const pathCandidates = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => [path.join(dir, 'copilot'), path.join(dir, 'github-copilot')]);
  return [
    ...pathCandidates,
    path.join(home, '.npm-global', 'bin', 'copilot'),
    path.join(home, '.local', 'bin', 'copilot'),
    path.join(home, '.yarn', 'bin', 'copilot'),
    path.join(home, '.bun', 'bin', 'copilot'),
    path.join(home, '.volta', 'bin', 'copilot'),
    path.join(home, '.nvm', 'current', 'bin', 'copilot'),
    '/opt/homebrew/bin/copilot',
    '/usr/local/bin/copilot'
  ];
}

function firstExistingExecutable(candidates: string[]): string | undefined {
  const executableCandidates = [...new Set(candidates)]
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

function copilotSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: copilotSpawnPath()
  };
}

function copilotSpawnPath(): string {
  const home = homedir();
  const additions = [
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.yarn', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ];
  return [...new Set([...additions, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)])]
    .join(path.delimiter);
}

function copilotStartErrorMessage(error: unknown, executable: string): string {
  const details = error instanceof Error ? error.message : String(error);
  return `GitHub Copilot could not start from Agent Pulse. The helper tried "${executable}" but it failed: ${details}`;
}

async function readUnavailableCopilotModels(logDir: string): Promise<Set<string>> {
  const unavailable = new Set<string>();
  let entries;
  try {
    entries = await readdir(logDir, { withFileTypes: true });
  } catch {
    return unavailable;
  }
  const logNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 24);
  for (const name of logNames) {
    const content = await readFile(path.join(logDir, name), 'utf8').catch(() => '');
    for (const model of extractUnavailableModels(content)) {
      unavailable.add(model);
    }
  }
  return unavailable;
}

function extractUnavailableModels(content: string): string[] {
  const unavailable: string[] = [];
  const regex = /Model ['"]([^'"\n]+)['"][^\n]* is not available\./gi;
  for (const match of content.matchAll(regex)) {
    const model = normalizeCopilotModel(match[1]);
    if (model) {
      unavailable.push(model);
    }
  }
  return unavailable;
}

function summarizeCopilotFailure(live: LiveCopilotSession, exitCode?: number): CopilotFailureSummary {
  const combined = `${live.stderrBuffer}\n${live.stdoutBuffer}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of combined) {
    const match = /Model ['"]([^'"\n]+)['"][^\n]* is not available\./i.exec(line);
    if (match?.[1]) {
      const unavailableModel = normalizeCopilotModel(match[1]);
      return {
        message: unavailableModel
          ? `Copilot model "${unavailableModel}" is not available for this account.`
          : 'The selected Copilot model is not available for this account.',
        unavailableModel
      };
    }
  }
  for (const line of combined) {
    const cleaned = line.replace(/^\d{4}-\d\d-\d\dT\S+\s+\[(?:ERROR|WARNING|INFO)\]\s*/, '').trim();
    if (cleaned) {
      return { message: cleaned };
    }
  }
  return {
    message:
      exitCode === undefined
        ? 'GitHub Copilot could not start this turn.'
        : `GitHub Copilot exited before the turn started (code ${exitCode}).`
  };
}
