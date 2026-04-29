import type {
  CatalogCommand,
  CatalogModel,
  CatalogPlugin,
  CatalogSkill,
  CollaborationModeKind,
  HelperHealth,
  OlderThreadMessagesResponse,
  Project,
  Thread,
  ThreadMessageResponse,
  ThreadTranscript
} from '@agent-pulse/shared';
import { Menu, MessagesSquare, X } from 'lucide-react';
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { FetchThreadTranscriptOptions } from './api';
import { DashboardInsights } from './DashboardInsights';
import { Sidebar } from './Sidebar';
import { Spinner } from './Spinner';
import { ThreadView } from './ThreadView';
import { relativeTime, statusLabels, statusTone } from './status';

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
    method:
      | 'item/commandExecution/requestApproval'
      | 'item/fileChange/requestApproval'
      | 'item/permissions/requestApproval'
      | 'execCommandApproval'
      | 'applyPatchApproval'
      | 'item/tool/requestUserInput'
      | 'item/plan/requestImplementation'
      | 'mcpServer/elicitation/request',
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
  | { projectId: string; modelSlug?: string; reasoningEffort?: string }
  | { cwd: string; modelSlug?: string; reasoningEffort?: string };

export function Dashboard({
  health,
  threads,
  threadsLoaded = true,
  activeThreadId: controlledActiveThreadId,
  onActiveThreadIdChange,
  projects = [],
  onNewThread,
  onOpenThreadInCodex,
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
  const [newThreadDialogOpen, setNewThreadDialogOpen] = useState(false);
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
    }
    updateActiveThreadId(undefined);
  };

  const handleNewThread = (projectId?: string) => {
    if (!projectId) {
      setNewThreadDialogOpen(true);
      setNewThreadError('');
      return;
    }
    void createThread({ projectId });
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
            sendMessage={sendMessage}
            stopWork={stopWork}
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
          projects={projects}
          models={models}
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

function hasUnseenActivity(thread: Thread, seenThreadActivity: Record<string, number>): boolean {
  const seenAt = seenThreadActivity[thread.threadId] ?? 0;
  const activityAt = Date.parse(thread.lastActivityAt);
  return Number.isFinite(activityAt) && activityAt > seenAt;
}

function NewThreadDialog({
  projects,
  models,
  creatingProjectId,
  error,
  onClose,
  onCreate
}: {
  projects: Project[];
  models: CatalogModel[];
  creatingProjectId?: string;
  error: string;
  onClose: () => void;
  onCreate: (target: NewThreadTarget) => void;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState(() => projects[0]?.projectId ?? '');
  // Empty `selectedModelSlug` means "use the project's default model from
  // ~/.codex/config.toml". The user can override here for one-off threads.
  const [selectedModelSlug, setSelectedModelSlug] = useState<string>('');
  const [selectedEffort, setSelectedEffort] = useState<string>('');
  const creating = creatingProjectId !== undefined;
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId);
  const selectedModel = models.find((model) => model.slug === selectedModelSlug);
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
            <p>Pick where Codex should start, and optionally choose a model.</p>
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
            <p className="new-thread-empty">No saved Codex projects are available yet.</p>
          )}

          {models.length > 0 ? (
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
                {models.map((model) => (
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

function EmptyMain({
  threads,
  onOpenSidebar,
  onSelectThread,
  isLoading = false,
  seenThreadActivity = {}
}: {
  threads: Thread[];
  onOpenSidebar: () => void;
  onSelectThread: (thread: Thread) => void;
  isLoading?: boolean;
  seenThreadActivity?: Record<string, number>;
}) {
  const recentThreads = [...threads]
    .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())
    .slice(0, 8);

  if (isLoading && threads.length === 0) {
    return (
      <section className="codex-shell-empty codex-home">
        <button
          className="codex-sidebar-toggle"
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open thread list"
        >
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
      <button
        className="codex-sidebar-toggle"
        type="button"
        onClick={onOpenSidebar}
        aria-label="Open thread list"
      >
        <Menu size={20} />
      </button>
      <div className="codex-home-hero glass">
        <div className="codex-home-hero-icon" aria-hidden="true">
          <MessagesSquare size={28} />
        </div>
        <h1 className="codex-home-hero-title">Agent Pulse</h1>
        <p className="codex-home-hero-subtitle">Pick a thread to follow what Codex is doing.</p>
      </div>

      {recentThreads.length > 0 ? (
        <div className="codex-home-section">
          <div className="codex-home-section-heading">
            <h2 className="codex-home-section-title">Recent activity</h2>
            <span className="codex-home-section-meta">{recentThreads.length} thread{recentThreads.length === 1 ? '' : 's'}</span>
          </div>
          <div className="codex-home-tiles">
            {recentThreads.map((thread) => {
              const needsReview = threadNeedsReview(thread, seenThreadActivity);
              const tone = needsReview ? 'yellow' : statusTone[thread.status] || 'gray';
              const statusLabel = needsReview ? 'Review' : statusLabels[thread.status] ?? thread.status;
              return (
                <button
                  key={thread.threadId}
                  type="button"
                  className="codex-home-tile"
                  onClick={() => onSelectThread(thread)}
                >
                  <div className="codex-home-tile-row">
                    <span
                      className={`codex-home-tile-dot tone-${tone}`}
                      style={{ background: `var(--tone-${tone})` }}
                      aria-hidden="true"
                    />
                    <span className="codex-home-tile-status">{statusLabel}</span>
                    <span className="codex-home-tile-time">{relativeTime(thread.lastActivityAt)}</span>
                  </div>
                  <h3 className="codex-home-tile-title">{thread.title}</h3>
                  <p className="codex-home-tile-workspace">{thread.workspace}</p>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function threadNeedsReview(thread: Thread, seenThreadActivity: Record<string, number>): boolean {
  return thread.status === 'idle' && hasUnseenActivity(thread, seenThreadActivity);
}
