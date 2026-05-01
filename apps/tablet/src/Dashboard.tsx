import type {
  CatalogCommand,
  CatalogModel,
  CatalogPlugin,
  CatalogSkill,
  CollaborationModeKind,
  AgentProvider,
  HelperHealth,
  OlderThreadMessagesResponse,
  Project,
  Thread,
  ThreadMessageResponse,
  ThreadTranscript
} from '@agent-pulse/shared';
import { CheckCheck, Menu, MessagesSquare, X } from 'lucide-react';
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { FetchThreadTranscriptOptions } from './api';
import { DashboardInsights } from './DashboardInsights';
import { ProviderMark } from './ProviderMark';
import { Sidebar } from './Sidebar';
import { Spinner } from './Spinner';
import { ThreadView, type ApprovalMethodForUi } from './ThreadView';
import { providerForModel, providerLabel, providerTone } from './providers';
import { relativeTime, statusLabels, statusTone, isAttentionStatus, threadNeedsReview } from './status';

const SEEN_ACTIVITY_KEY = 'agent-pulse:seen-thread-activity';
const ACTIVE_THREAD_KEY = 'agent-pulse:active-thread';

export type DashboardProps = {
  health: HelperHealth;
  threads: Thread[];
  threadsLoaded?: boolean;
  activeThreadId?: string | null;
  onActiveThreadIdChange?: (threadId: string | undefined) => void;
  projects?: Project[];
  onNewThread?: (target: NewThreadTarget) => Promise<Thread>;
  onOpenThreadInCodex?: (threadId: string) => Promise<void>;
  onDeleteThread?: (threadId: string) => Promise<void>;
  onOpenSettings?: () => void;
  fetchTranscript?: (
    threadId: string,
    options?: FetchThreadTranscriptOptions
  ) => Promise<ThreadTranscript>;
  sendMessage?: (
    threadId: string,
    text: string,
    options?: { collaborationMode?: CollaborationModeKind }
  ) => Promise<ThreadMessageResponse>;
  stopWork?: (threadId: string) => Promise<void>;
  fetchOlderMessages?: (
    threadId: string,
    beforeMessageId: string,
    limit?: number
  ) => Promise<OlderThreadMessagesResponse>;
  transcriptUpdates?: Record<string, ThreadTranscript>;
  threadModels?: Record<string, string>;
  threadReasoningEfforts?: Record<string, string>;
  threadPendingRequests?: Record<string, PendingRequest[]>;
  streamingThreadIds?: Set<string>;
  // When provided, this is the canonical "user has reviewed this thread" map
  // synced via the helper. Dashboard falls back to its localStorage-backed
  // copy when undefined (offline / unauthenticated paths).
  seenThreadActivityOverride?: Record<string, number>;
  onMarkThreadSeen?: (threadId: string, seenAt: number) => void;
  plugins?: CatalogPlugin[];
  skills?: CatalogSkill[];
  commands?: CatalogCommand[];
  models?: CatalogModel[];
  fetchProjectFiles?: (
    projectId: string,
    query: string
  ) => Promise<{ path: string; relativePath: string }[]>;
  onChangeThreadModel?: (
    threadId: string,
    modelSlug: string,
    reasoningEffort?: string
  ) => Promise<void>;
  onApprovalDecision?: (
    threadId: string,
    requestId: string,
    method: ApprovalMethodForUi,
    decision: string | Record<string, unknown>
  ) => Promise<void>;
};

export type PendingRequest = {
  id: string;
  method: string;
  title: string;
  body?: string;
  itemId?: string;
  turnId?: string;
  permissions?: Record<string, unknown>;
  availableDecisions?: unknown[];
  proposedExecpolicyAmendment?: string[];
  kind?:
    | 'question'
    | 'plan'
    | 'commandApproval'
    | 'fileApproval'
    | 'permissionsApproval'
    | 'mcpElicitationApproval';
};

export type NewThreadTarget =
  | { projectId: string; provider?: AgentProvider; modelSlug?: string; reasoningEffort?: string }
  | { cwd: string; provider?: AgentProvider; modelSlug?: string; reasoningEffort?: string };

export function Dashboard({
  health,
  threads,
  threadsLoaded = true,
  activeThreadId: controlledActiveThreadId,
  onActiveThreadIdChange,
  projects = [],
  onNewThread,
  onOpenThreadInCodex,
  onDeleteThread,
  onOpenSettings,
  fetchTranscript,
  sendMessage,
  stopWork,
  fetchOlderMessages,
  transcriptUpdates = {},
  threadModels = {},
  threadReasoningEfforts = {},
  threadPendingRequests = {},
  streamingThreadIds,
  plugins = [],
  skills = [],
  commands = [],
  models = [],
  fetchProjectFiles,
  onChangeThreadModel,
  onApprovalDecision,
  seenThreadActivityOverride,
  onMarkThreadSeen
}: DashboardProps) {
  const [internalActiveThreadId, setInternalActiveThreadId] = useState<string | undefined>(() => readActiveThreadId());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [createdThreads, setCreatedThreads] = useState<Thread[]>([]);
  const [touchedCreatedThreadIds, setTouchedCreatedThreadIds] = useState<Set<string>>(
    () => new Set()
  );
  const [newThreadDialogOpen, setNewThreadDialogOpen] = useState(false);
  const [newThreadInitialProjectId, setNewThreadInitialProjectId] = useState<string | undefined>();
  const [newThreadError, setNewThreadError] = useState('');
  const [creatingProjectId, setCreatingProjectId] = useState<string | undefined>();
  const [localSeenThreadActivity, setLocalSeenThreadActivity] = useState<Record<string, number>>(
    () => readSeenThreadActivity()
  );
  // Helper-synced state takes precedence; we merge so optimistic local marks
  // (just-tapped threads) keep showing as seen even if the helper's broadcast
  // hasn't echoed back yet.
  const seenThreadActivity = useMemo(() => {
    if (!seenThreadActivityOverride) {
      return localSeenThreadActivity;
    }
    const merged: Record<string, number> = { ...seenThreadActivityOverride };
    for (const [threadId, seenAt] of Object.entries(localSeenThreadActivity)) {
      const remote = merged[threadId] ?? 0;
      if (seenAt > remote) {
        merged[threadId] = seenAt;
      }
    }
    return merged;
  }, [localSeenThreadActivity, seenThreadActivityOverride]);
  const setSeenThreadActivity: Dispatch<SetStateAction<Record<string, number>>> = (action) => {
    setLocalSeenThreadActivity((current) => {
      const next = typeof action === 'function' ? (action as (prev: Record<string, number>) => Record<string, number>)(current) : action;
      // Push any newly-changed entries to the helper so other devices learn
      // about them. The handler is responsible for de-duping & broadcasting.
      if (onMarkThreadSeen) {
        for (const [threadId, seenAt] of Object.entries(next)) {
          if ((current[threadId] ?? 0) < seenAt) {
            onMarkThreadSeen(threadId, seenAt);
          }
        }
      }
      return next;
    });
  };

  const activeThreadId =
    controlledActiveThreadId !== undefined
      ? (controlledActiveThreadId ?? undefined)
      : internalActiveThreadId;

  const baseVisibleThreads = useMemo(
    () => [
      ...createdThreads,
      ...threads.filter(
        (thread) => !createdThreads.some((created) => created.threadId === thread.threadId)
      )
    ],
    [createdThreads, threads]
  );

  const visibleThreads = useMemo(
    () =>
      baseVisibleThreads.map((thread) =>
        (threadPendingRequests[thread.threadId] ?? []).length > 0 &&
        thread.status !== 'waiting_approval'
          ? { ...thread, status: 'waiting_approval' as const }
          : thread
      ),
    [baseVisibleThreads, threadPendingRequests]
  );

  const activeThread = useMemo(
    () => visibleThreads.find((thread) => thread.threadId === activeThreadId),
    [activeThreadId, visibleThreads]
  );

  const workingThreadIds = useMemo(() => {
    const ids = new Set<string>();
    if (streamingThreadIds) {
      for (const id of streamingThreadIds) {
        ids.add(id);
      }
    }
    return ids;
  }, [streamingThreadIds]);

  const updateActiveThreadId = (threadId: string | undefined) => {
    if (controlledActiveThreadId === undefined) {
      setInternalActiveThreadId(threadId);
    }
    onActiveThreadIdChange?.(threadId);
  };

  useEffect(() => {
    if (threadsLoaded && activeThreadId && !activeThread) {
      updateActiveThreadId(undefined);
    }
  }, [activeThreadId, activeThread, threadsLoaded]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (activeThreadId) {
      window.sessionStorage.setItem(ACTIVE_THREAD_KEY, activeThreadId);
      return;
    }

    window.sessionStorage.removeItem(ACTIVE_THREAD_KEY);
  }, [activeThreadId]);

  useEffect(() => {
    window.localStorage.setItem(SEEN_ACTIVITY_KEY, JSON.stringify(localSeenThreadActivity));
  }, [localSeenThreadActivity]);

  useEffect(() => {
    if (activeThread) {
      markThreadSeen(activeThread, setSeenThreadActivity);
    }
  }, [activeThread?.threadId, activeThread?.lastActivityAt]);

  const handleSelectThread = (thread: Thread) => {
    markThreadSeen(thread, setSeenThreadActivity);
    updateActiveThreadId(thread.threadId);
    setSidebarOpen(false);
  };

  const handleCloseThread = () => {
    if (activeThread) {
      markThreadSeen(activeThread, setSeenThreadActivity);
      const isLocalDraft = createdThreads.some((thread) => thread.threadId === activeThread.threadId);
      const transcript = transcriptUpdates[activeThread.threadId];
      const hasUserInput = touchedCreatedThreadIds.has(activeThread.threadId);
      const isEmptyDraft =
        isLocalDraft && !hasUserInput && (!transcript || transcript.messages.length === 0);
      if (isEmptyDraft && onDeleteThread) {
        void onDeleteThread(activeThread.threadId).catch(() => undefined);
        setCreatedThreads((current) =>
          current.filter((thread) => thread.threadId !== activeThread.threadId)
        );
        setTouchedCreatedThreadIds((current) => {
          if (!current.has(activeThread.threadId)) {
            return current;
          }
          const next = new Set(current);
          next.delete(activeThread.threadId);
          return next;
        });
      }
    }
    updateActiveThreadId(undefined);
  };

  const handleNewThread = (projectId?: string) => {
    setNewThreadInitialProjectId(projectId);
    setNewThreadDialogOpen(true);
    setNewThreadError('');
  };

  const handleMarkAllReviewed = () => {
    const reviewThreads = visibleThreads.filter((thread) =>
      threadNeedsReview(thread, seenThreadActivity)
    );
    if (reviewThreads.length === 0) {
      return;
    }

    setSeenThreadActivity((current) => {
      let changed = false;
      const next = { ...current };
      for (const thread of reviewThreads) {
        const activityAt = Date.parse(thread.lastActivityAt);
        if (!Number.isFinite(activityAt) || (next[thread.threadId] ?? 0) >= activityAt) {
          continue;
        }
        next[thread.threadId] = activityAt;
        changed = true;
      }
      return changed ? next : current;
    });
  };

  const createThread = async (target: NewThreadTarget): Promise<boolean> => {
    if (!onNewThread) {
      return false;
    }

    setNewThreadError('');
    setCreatingProjectId('projectId' in target ? target.projectId : target.cwd);
    try {
      const thread = await onNewThread(target);
      setCreatedThreads((current) => [
        thread,
        ...current.filter((candidate) => candidate.threadId !== thread.threadId)
      ]);
      setTouchedCreatedThreadIds((current) => {
        if (!current.has(thread.threadId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(thread.threadId);
        return next;
      });
      updateActiveThreadId(thread.threadId);
      setSidebarOpen(false);
      setNewThreadDialogOpen(false);
      return true;
    } catch (error) {
      setNewThreadError(error instanceof Error ? error.message : 'Could not create a new thread.');
      setNewThreadDialogOpen(true);
      return false;
    } finally {
      setCreatingProjectId(undefined);
    }
  };

  return (
    <div className="codex-shell" data-route={activeThread ? 'thread' : 'home'}>
      {sidebarOpen ? (
        <div
          className="codex-sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <Sidebar
        threads={visibleThreads}
        projects={projects}
        activeThreadId={activeThreadId}
        seenThreadActivity={seenThreadActivity}
        workingThreadIds={workingThreadIds}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
        onOpenSettings={onOpenSettings}
        onGoHome={handleCloseThread}
        health={health}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="codex-main">
        {activeThread ? (
          <ThreadView
            thread={activeThread}
            onClose={handleCloseThread}
            onOpenSidebar={() => setSidebarOpen(true)}
            fetchTranscript={fetchTranscript}
            sendMessage={
              sendMessage
                ? async (threadId, text, options) => {
                    if (createdThreads.some((thread) => thread.threadId === threadId)) {
                      setTouchedCreatedThreadIds((current) => {
                        if (current.has(threadId)) {
                          return current;
                        }
                        const next = new Set(current);
                        next.add(threadId);
                        return next;
                      });
                    }
                    return options === undefined
                      ? sendMessage(threadId, text)
                      : sendMessage(threadId, text, options);
                  }
                : undefined
            }
            stopWork={stopWork}
            deleteThread={onDeleteThread}
            fetchOlderMessages={
              fetchOlderMessages
                ? (beforeMessageId: string, limit?: number) =>
                    fetchOlderMessages(activeThread.threadId, beforeMessageId, limit)
                : undefined
            }
            openThreadInCodex={onOpenThreadInCodex}
            liveTranscript={transcriptUpdates[activeThread.threadId]}
            modelName={threadModels[activeThread.threadId] ?? activeThread.model}
            selectedModelSlug={threadModels[activeThread.threadId] ?? activeThread.model}
            selectedReasoningEffort={
              threadReasoningEfforts[activeThread.threadId] ?? activeThread.reasoningEffort
            }
            pendingRequests={threadPendingRequests[activeThread.threadId] ?? []}
            forceWorking={workingThreadIds.has(activeThread.threadId)}
            plugins={plugins}
            skills={skills}
            commands={commands}
            models={models}
            fetchProjectFiles={
              fetchProjectFiles
                ? (query: string) =>
                    fetchProjectFiles(projectIdForActiveThread(activeThread, projects), query)
                : undefined
            }
            onChangeModel={
              onChangeThreadModel
                ? (modelSlug: string, reasoningEffort?: string) =>
                    onChangeThreadModel(activeThread.threadId, modelSlug, reasoningEffort)
                : undefined
            }
            onApprovalDecision={
              onApprovalDecision
                ? (requestId, method, decision) =>
                    onApprovalDecision(activeThread.threadId, requestId, method, decision)
                : undefined
            }
          />
        ) : (
          <EmptyMain
            threads={visibleThreads}
            onSelectThread={handleSelectThread}
            onOpenSidebar={() => setSidebarOpen(true)}
            isLoading={!threadsLoaded}
            seenThreadActivity={seenThreadActivity}
            onMarkAllReviewed={handleMarkAllReviewed}
            workingThreadIds={workingThreadIds}
          />
        )}
      </main>
      {!activeThread ? (
        <DashboardInsights
          threads={visibleThreads}
          projects={projects}
          health={health}
          threadModels={threadModels}
        />
      ) : null}
      {newThreadDialogOpen ? (
        <NewThreadDialog
          key={newThreadInitialProjectId ?? 'new-thread'}
          projects={projects}
          models={models}
          initialProjectId={newThreadInitialProjectId}
          creatingProjectId={creatingProjectId}
          error={newThreadError}
          onClose={() => setNewThreadDialogOpen(false)}
          onCreate={(target) => void createThread(target)}
        />
      ) : null}
    </div>
  );
}

function projectIdForActiveThread(thread: Thread, projects: Project[]): string {
  const match = projects.find((project) => project.name === thread.workspace);
  return match?.projectId ?? '';
}

function readSeenThreadActivity(): Record<string, number> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEEN_ACTIVITY_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )
    );
  } catch {
    return {};
  }
}

function readActiveThreadId(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const stored = window.sessionStorage.getItem(ACTIVE_THREAD_KEY);
  if (!stored) {
    return undefined;
  }

  const trimmed = stored.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function markThreadSeen(
  thread: Thread,
  setSeenThreadActivity: Dispatch<SetStateAction<Record<string, number>>>
): void {
  const activityAt = Date.parse(thread.lastActivityAt);
  if (!Number.isFinite(activityAt)) {
    return;
  }

  setSeenThreadActivity((current) => {
    if ((current[thread.threadId] ?? 0) >= activityAt) {
      return current;
    }
    return {
      ...current,
      [thread.threadId]: activityAt
    };
  });
}

function NewThreadDialog({
  projects,
  models,
  initialProjectId,
  creatingProjectId,
  error,
  onClose,
  onCreate
}: {
  projects: Project[];
  models: CatalogModel[];
  initialProjectId?: string;
  creatingProjectId?: string;
  error: string;
  onClose: () => void;
  onCreate: (target: NewThreadTarget) => void;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState(() =>
    initialProjectId && projects.some((project) => project.projectId === initialProjectId)
      ? initialProjectId
      : projects[0]?.projectId ?? ''
  );
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>('codex');
  // Empty `selectedModelSlug` means "use the project's default model from
  // ~/.codex/config.toml". The user can override here for one-off threads.
  const [selectedModelSlug, setSelectedModelSlug] = useState<string>('');
  const [selectedEffort, setSelectedEffort] = useState<string>('');
  const creating = creatingProjectId !== undefined;
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId);
  const availableProviders = useMemo<AgentProvider[]>(() => {
    const providers = [
      ...models.map((model) => providerForModel(model)),
      ...projects.flatMap((project) => project.providers ?? [])
    ];
    const uniqueProviders = [...new Set(providers)];
    return uniqueProviders.length > 0 ? uniqueProviders : ['codex'];
  }, [models, projects]);
  const providerModels = useMemo(
    () => models.filter((model) => providerForModel(model) === selectedProvider && model.visibility !== 'hidden'),
    [models, selectedProvider]
  );
  const selectedModel = providerModels.find((model) => model.slug === selectedModelSlug);
  const efforts = selectedModel?.supportedReasoningLevels ?? [];

  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProjectId('');
      return;
    }

    if (!projects.some((project) => project.projectId === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.projectId ?? '');
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (!availableProviders.includes(selectedProvider)) {
      setSelectedProvider(availableProviders[0] ?? 'codex');
    }
  }, [availableProviders, selectedProvider]);

  useEffect(() => {
    if (selectedModelSlug && !providerModels.some((model) => model.slug === selectedModelSlug)) {
      setSelectedModelSlug('');
      setSelectedEffort('');
    }
  }, [providerModels, selectedModelSlug]);

  // When the user picks a different model, drop any effort that isn't valid
  // for the new model. If the new model has a default effort, prefer that.
  useEffect(() => {
    if (!selectedModel) {
      setSelectedEffort('');
      return;
    }
    const supported = selectedModel.supportedReasoningLevels ?? [];
    if (supported.length === 0) {
      setSelectedEffort('');
      return;
    }
    if (!supported.some((entry) => entry.effort === selectedEffort)) {
      setSelectedEffort(selectedModel.defaultReasoningLevel ?? '');
    }
  }, [selectedModelSlug, selectedModel, selectedEffort]);

  return (
    <div className="new-thread-backdrop" role="presentation" onClick={onClose}>
      <section
        className="new-thread-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New thread"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="new-thread-header">
          <div>
            <h2>Start a new thread</h2>
            <p>Pick the folder and agent provider for this chat.</p>
          </div>
          <button
            className="new-thread-close"
            type="button"
            onClick={onClose}
            aria-label="Close new thread"
          >
            <X size={18} />
          </button>
        </header>

        <form
          className="new-thread-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedProjectId || creating) {
              return;
            }
            const target: NewThreadTarget = {
              projectId: selectedProjectId,
              provider: selectedProvider,
              ...(selectedModelSlug ? { modelSlug: selectedModelSlug } : {}),
              ...(selectedEffort ? { reasoningEffort: selectedEffort } : {})
            };
            onCreate(target);
          }}
        >
          <label className="new-thread-label" htmlFor="new-thread-project">
            Project
          </label>
          <select
            id="new-thread-project"
            className="new-thread-select"
            value={selectedProjectId}
            onChange={(event) => setSelectedProjectId(event.target.value)}
            disabled={creating || projects.length === 0}
          >
            {projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.name}
              </option>
            ))}
          </select>
          {selectedProject ? (
            <p className="new-thread-selected-path">{selectedProject.path}</p>
          ) : (
            <p className="new-thread-empty">No saved projects are available yet.</p>
          )}

          {selectedProject && availableProviders.length > 0 ? (
            <>
              <span className="new-thread-label">Agent</span>
              <div className="new-thread-provider-row" role="radiogroup" aria-label="Provider">
                {availableProviders.map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    role="radio"
                    aria-checked={selectedProvider === provider}
                    className={`new-thread-provider-pick provider-${providerTone(provider)} ${
                      selectedProvider === provider ? 'is-selected' : ''
                    }`}
                    onClick={() => setSelectedProvider(provider)}
                    disabled={creating}
                  >
                    <span className="new-thread-provider-dot" aria-hidden="true" />
                    <span className="provider-inline-text">{providerLabel(provider)}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {providerModels.length > 0 ? (
            <>
              <label className="new-thread-label" htmlFor="new-thread-model">
                Model
              </label>
              <select
                id="new-thread-model"
                className="new-thread-select"
                value={selectedModelSlug}
                onChange={(event) => setSelectedModelSlug(event.target.value)}
                disabled={creating}
              >
                <option value="">Use project default</option>
                {providerModels.map((model) => (
                  <option key={model.slug} value={model.slug}>
                    {model.displayName}
                  </option>
                ))}
              </select>
              {selectedModel?.description ? (
                <p className="new-thread-selected-path">{selectedModel.description}</p>
              ) : null}

              {efforts.length > 0 ? (
                <>
                  <span className="new-thread-label">Reasoning effort</span>
                  <div className="new-thread-effort-row">
                    {efforts.map((entry) => (
                      <button
                        key={entry.effort}
                        type="button"
                        className={`new-thread-effort-pick ${
                          selectedEffort === entry.effort ? 'is-selected' : ''
                        }`}
                        onClick={() => setSelectedEffort(entry.effort)}
                        title={entry.description}
                        disabled={creating}
                      >
                        {capitalizeEffort(entry.effort)}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </>
          ) : null}

          <div className="new-thread-actions">
            <button
              className="new-thread-submit"
              type="submit"
              disabled={!selectedProjectId || creating}
            >
              {creatingProjectId === selectedProjectId ? (
                <>
                  <Spinner size={14} /> Starting
                </>
              ) : (
                'Start thread'
              )}
            </button>
          </div>
        </form>
        {error ? <p className="new-thread-error">{error}</p> : null}
      </section>
    </div>
  );
}

function capitalizeEffort(effort: string): string {
  if (!effort) return effort;
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

const EMPTY_MAIN_TONE_COLOR: Record<string, string> = {
  green: 'var(--tone-green)',
  blue: 'var(--tone-blue)',
  yellow: 'var(--tone-yellow)',
  red: 'var(--tone-red)',
  orange: 'var(--tone-orange)',
  gray: 'var(--tone-gray)'
};

function EmptyMain({
  threads,
  onOpenSidebar,
  onSelectThread,
  isLoading = false,
  seenThreadActivity = {},
  onMarkAllReviewed,
  workingThreadIds = new Set()
}: {
  threads: Thread[];
  onOpenSidebar: () => void;
  onSelectThread: (thread: Thread) => void;
  isLoading?: boolean;
  seenThreadActivity?: Record<string, number>;
  onMarkAllReviewed?: () => void;
  workingThreadIds?: Set<string>;
}) {
  const running = threads.filter(
    t => workingThreadIds.has(t.threadId) || t.status === 'running' || t.status === 'compacting'
  ).length;
  const waiting = threads.filter(t => t.status === 'waiting_approval').length;
  const errors = threads.filter(t => t.status === 'error' || t.status === 'connection').length;

  const reviewThreads = useMemo(() =>
    threads
      .filter(t => threadNeedsReview(t, seenThreadActivity))
      .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()),
    [seenThreadActivity, threads]
  );

  const attentionThreads = useMemo(() =>
    threads
      .filter(t => isAttentionStatus(t.status) && !threadNeedsReview(t, seenThreadActivity))
      .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())
      .slice(0, 6),
    [seenThreadActivity, threads]
  );

  const recentThreads = useMemo(() =>
    threads
      .filter(t => !isAttentionStatus(t.status) && !threadNeedsReview(t, seenThreadActivity))
      .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())
      .slice(0, 10),
    [seenThreadActivity, threads]
  );

  const isLiveThread = (thread: Thread) =>
    workingThreadIds.has(thread.threadId) || thread.status === 'running' || thread.status === 'compacting';

  const threadDotTone = (thread: Thread) => statusTone[isLiveThread(thread) ? 'running' : thread.status];
  const heroTitle =
    running > 0
      ? `${running} thread${running === 1 ? '' : 's'} running`
      : reviewThreads.length > 0
        ? `${reviewThreads.length} thread${reviewThreads.length === 1 ? '' : 's'} ready for review`
        : 'Agent Pulse is ready';
  const heroCopy =
    running > 0
      ? 'Live work is in progress. Open a thread to watch the latest changes.'
      : reviewThreads.length > 0
        ? 'Recent work finished. Review the threads that need your attention.'
        : 'Pick a recent thread to continue or check what happened last.';

  if (isLoading && threads.length === 0) {
    return (
      <section className="codex-shell-empty codex-home">
        <button className="codex-sidebar-toggle" type="button" onClick={onOpenSidebar} aria-label="Open thread list">
          <Menu size={20} />
        </button>
        <div className="codex-loading-overlay">
          <Spinner size={28} label="Loading threads" />
          <span>Loading threads…</span>
        </div>
      </section>
    );
  }

  return (
    <section className="codex-shell-empty codex-home">
      <button className="codex-sidebar-toggle" type="button" onClick={onOpenSidebar} aria-label="Open thread list">
        <Menu size={20} />
      </button>

      <div className="codex-home-dashboard">
        {threads.length === 0 ? (
          <div className="codex-home-empty">
            <MessagesSquare size={28} aria-hidden="true" />
            <p>No threads yet. Start a new thread in Codex.</p>
          </div>
        ) : (
          <div className="codex-home-content">
            <div className="codex-home-hero">
              <div className="codex-home-hero-icon" aria-hidden="true">
                <MessagesSquare size={28} />
              </div>
              <h2 className="codex-home-hero-title">{heroTitle}</h2>
              <p className="codex-home-hero-subtitle">{heroCopy}</p>
              {(running > 0 || waiting > 0 || errors > 0) && (
                <div className="codex-home-status-chips">
                  {running > 0 && (
                    <span className="codex-home-chip codex-home-chip-blue">
                      <span className="codex-home-chip-dot is-working" aria-hidden="true" />
                      {running} running
                    </span>
                  )}
                  {waiting > 0 && (
                    <span className="codex-home-chip codex-home-chip-yellow">
                      <span className="codex-home-chip-dot" aria-hidden="true" />
                      {waiting} waiting
                    </span>
                  )}
                  {errors > 0 && (
                    <span className="codex-home-chip codex-home-chip-red">
                      <span className="codex-home-chip-dot" aria-hidden="true" />
                      {errors} error{errors !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="codex-home-kpi-row" aria-label="Thread summary">
              <div className="codex-home-kpi">
                <span className="codex-home-kpi-value tone-blue">{running}</span>
                <span className="codex-home-kpi-label">Running</span>
              </div>
              <div className="codex-home-kpi">
                <span className="codex-home-kpi-value tone-yellow">{reviewThreads.length}</span>
                <span className="codex-home-kpi-label">Review</span>
              </div>
              <div className="codex-home-kpi">
                <span className="codex-home-kpi-value tone-green">{recentThreads.length}</span>
                <span className="codex-home-kpi-label">Recent</span>
              </div>
            </div>

            {reviewThreads.length > 0 && (
              <div className="codex-home-card">
                <div className="codex-home-card-header">
                  <h2 className="codex-home-card-title">Needs review</h2>
                  {onMarkAllReviewed ? (
                    <button
                      className="codex-home-mark-reviewed"
                      type="button"
                      onClick={onMarkAllReviewed}
                    >
                      <CheckCheck size={14} aria-hidden="true" />
                      <span>Mark all reviewed</span>
                    </button>
                  ) : null}
                </div>
                <div className="codex-home-thread-list">
                  {reviewThreads.map((t) => (
                    <button
                      key={t.threadId}
                      className={`codex-home-tile codex-home-thread-row provider-${providerTone(t.provider)}`}
                      type="button"
                      onClick={() => onSelectThread(t)}
                      aria-label={`Review ${providerLabel(t.provider)} chat ${t.title}`}
                    >
                      <span
                        className={`codex-home-thread-dot ${isLiveThread(t) ? 'is-working' : ''}`}
                        style={{
                          background: EMPTY_MAIN_TONE_COLOR[threadDotTone(t)],
                          color: EMPTY_MAIN_TONE_COLOR[threadDotTone(t)]
                        }}
                        aria-hidden="true"
                      />
                      <span
                        className={`codex-home-thread-mark provider-${providerTone(t.provider)}`}
                        aria-hidden="true"
                      >
                        <ProviderMark provider={t.provider} size="sm" />
                      </span>
                      <span className="codex-home-thread-title">{t.title}</span>
                      <span className="codex-home-thread-badge" data-status="review">
                        Review
                      </span>
                      <span className="codex-home-thread-time">{relativeTime(t.lastActivityAt)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {attentionThreads.length > 0 && (
              <div className="codex-home-card">
                <h2 className="codex-home-card-title">Needs attention</h2>
                <div className="codex-home-thread-list">
                  {attentionThreads.map((t) => (
                    <button
                      key={t.threadId}
                      className={`codex-home-tile codex-home-thread-row provider-${providerTone(t.provider)}`}
                      type="button"
                      onClick={() => onSelectThread(t)}
                      aria-label={`Open ${providerLabel(t.provider)} chat ${t.title}`}
                    >
                      <span
                        className={`codex-home-thread-dot ${isLiveThread(t) ? 'is-working' : ''}`}
                        style={{
                          background: EMPTY_MAIN_TONE_COLOR[threadDotTone(t)],
                          color: EMPTY_MAIN_TONE_COLOR[threadDotTone(t)]
                        }}
                        aria-hidden="true"
                      />
                      <span
                        className={`codex-home-thread-mark provider-${providerTone(t.provider)}`}
                        aria-hidden="true"
                      >
                        <ProviderMark provider={t.provider} size="sm" />
                      </span>
                      <span className="codex-home-thread-title">{t.title}</span>
                      <span className="codex-home-thread-badge" data-status={t.status}>
                        {statusLabels[t.status]}
                      </span>
                      <span className="codex-home-thread-time">{relativeTime(t.lastActivityAt)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {recentThreads.length > 0 && (
              <div className="codex-home-card">
                <h2 className="codex-home-card-title">Recent threads</h2>
                <div className="codex-home-thread-list">
                  {recentThreads.map((t) => (
                    <button
                      key={t.threadId}
                      className={`codex-home-tile codex-home-thread-row provider-${providerTone(t.provider)}`}
                      type="button"
                      onClick={() => onSelectThread(t)}
                      aria-label={`Open ${providerLabel(t.provider)} chat ${t.title}`}
                    >
                      <span
                        className={`codex-home-thread-dot ${isLiveThread(t) ? 'is-working' : ''}`}
                        style={{
                          background: EMPTY_MAIN_TONE_COLOR[threadDotTone(t)],
                          color: EMPTY_MAIN_TONE_COLOR[threadDotTone(t)]
                        }}
                        aria-hidden="true"
                      />
                      <span
                        className={`codex-home-thread-mark provider-${providerTone(t.provider)}`}
                        aria-hidden="true"
                      >
                        <ProviderMark provider={t.provider} size="sm" />
                      </span>
                      <span className="codex-home-thread-title">{t.title}</span>
                      <span className="codex-home-thread-workspace">{t.workspace}</span>
                      <span className="codex-home-thread-time">{relativeTime(t.lastActivityAt)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
