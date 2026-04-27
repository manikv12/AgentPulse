import type {
  CatalogCommand,
  CatalogModel,
  CatalogPlugin,
  CatalogSkill,
  HelperHealth,
  Project,
  Thread,
  ThreadMessageResponse,
  ThreadTranscript
} from '@agent-pulse/shared';
import { Menu, MessagesSquare, X } from 'lucide-react';
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { FetchThreadTranscriptOptions } from './api';
import { Sidebar } from './Sidebar';
import { ThreadView } from './ThreadView';
import { relativeTime, statusTone } from './status';

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
  sendMessage?: (threadId: string, text: string) => Promise<ThreadMessageResponse>;
  transcriptUpdates?: Record<string, ThreadTranscript>;
  threadModels?: Record<string, string>;
  threadReasoningEfforts?: Record<string, string>;
  threadPendingRequests?: Record<string, PendingRequest[]>;
  streamingThreadIds?: Set<string>;
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
      | 'item/permissions/requestApproval',
    decision: string | Record<string, unknown>
  ) => Promise<void>;
};

export type PendingRequest = {
  id: string;
  method: string;
  title: string;
  body?: string;
};

export type NewThreadTarget = { projectId: string } | { cwd: string };

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
  onApprovalDecision
}: DashboardProps) {
  const [internalActiveThreadId, setInternalActiveThreadId] = useState<string | undefined>(() => readActiveThreadId());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [createdThreads, setCreatedThreads] = useState<Thread[]>([]);
  const [newThreadDialogOpen, setNewThreadDialogOpen] = useState(false);
  const [newThreadError, setNewThreadError] = useState('');
  const [creatingProjectId, setCreatingProjectId] = useState<string | undefined>();
  const [seenThreadActivity, setSeenThreadActivity] = useState<Record<string, number>>(() =>
    readSeenThreadActivity()
  );

  const activeThreadId =
    controlledActiveThreadId !== undefined
      ? (controlledActiveThreadId ?? undefined)
      : internalActiveThreadId;

  const visibleThreads = useMemo(
    () => [
      ...createdThreads,
      ...threads.filter(
        (thread) => !createdThreads.some((created) => created.threadId === thread.threadId)
      )
    ],
    [createdThreads, threads]
  );

  const activeThread = useMemo(
    () => visibleThreads.find((thread) => thread.threadId === activeThreadId),
    [activeThreadId, visibleThreads]
  );

  const workingThreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [threadId, transcript] of Object.entries(transcriptUpdates)) {
      if (transcript?.activeTurnId) {
        ids.add(threadId);
      }
    }
    if (streamingThreadIds) {
      for (const id of streamingThreadIds) {
        ids.add(id);
      }
    }
    return ids;
  }, [transcriptUpdates, streamingThreadIds]);

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
    window.localStorage.setItem(SEEN_ACTIVITY_KEY, JSON.stringify(seenThreadActivity));
  }, [seenThreadActivity]);

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
    <div className="codex-shell">
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
      />
      <main className="codex-main">
        {activeThread ? (
          <ThreadView
            thread={activeThread}
            onClose={handleCloseThread}
            onOpenSidebar={() => setSidebarOpen(true)}
            fetchTranscript={fetchTranscript}
            sendMessage={sendMessage}
            openThreadInCodex={onOpenThreadInCodex}
            liveTranscript={transcriptUpdates[activeThread.threadId]}
            modelName={threadModels[activeThread.threadId]}
            selectedModelSlug={threadModels[activeThread.threadId]}
            selectedReasoningEffort={threadReasoningEfforts[activeThread.threadId]}
            pendingRequests={threadPendingRequests[activeThread.threadId] ?? []}
            forceWorking={streamingThreadIds?.has(activeThread.threadId) ?? false}
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
          />
        )}
      </main>
      {newThreadDialogOpen ? (
        <NewThreadDialog
          projects={projects}
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
  creatingProjectId,
  error,
  onClose,
  onCreate
}: {
  projects: Project[];
  creatingProjectId?: string;
  error: string;
  onClose: () => void;
  onCreate: (target: NewThreadTarget) => void;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState(() => projects[0]?.projectId ?? '');
  const creating = creatingProjectId !== undefined;
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId);

  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProjectId('');
      return;
    }

    if (!projects.some((project) => project.projectId === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.projectId ?? '');
    }
  }, [projects, selectedProjectId]);

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
            <h2>Choose a project</h2>
            <p>Pick where Codex should start the new thread.</p>
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
            onCreate({ projectId: selectedProjectId });
          }}
        >
          <label className="new-thread-label" htmlFor="new-thread-project">
            Project
          </label>
          <div className="new-thread-select-row">
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
            <button
              className="new-thread-submit"
              type="submit"
              disabled={!selectedProjectId || creating}
            >
              {creatingProjectId === selectedProjectId ? 'Starting' : 'Start thread'}
            </button>
          </div>
          {selectedProject ? (
            <p className="new-thread-selected-path">{selectedProject.path}</p>
          ) : (
            <p className="new-thread-empty">No saved Codex projects are available yet.</p>
          )}
        </form>
        {error ? <p className="new-thread-error">{error}</p> : null}
      </section>
    </div>
  );
}

function EmptyMain({
  threads,
  onOpenSidebar,
  onSelectThread
}: {
  threads: Thread[];
  onOpenSidebar: () => void;
  onSelectThread: (thread: Thread) => void;
}) {
  const recentThreads = [...threads]
    .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())
    .slice(0, 8);

  return (
    <section className="codex-shell-empty">
      <button
        className="codex-sidebar-toggle"
        type="button"
        onClick={onOpenSidebar}
        aria-label="Open thread list"
      >
        <Menu size={20} />
      </button>
      <div className="codex-shell-empty-body" style={{ marginTop: 'min(10vh, 60px)', marginBottom: '32px' }}>
        <MessagesSquare size={36} aria-hidden="true" />
        <h1>Agent Pulse</h1>
        <p>Pick a thread to follow what Codex is doing.</p>
      </div>

      {recentThreads.length > 0 ? (
        <div style={{ padding: '0 20px 40px', maxWidth: '800px', margin: '0 auto', width: '100%', textAlign: 'left' }}>
          <div className="section-heading" style={{ marginBottom: '16px' }}>
            <h2 style={{ fontSize: '1.125rem', margin: 0, color: 'var(--text)' }}>Recent Activity</h2>
          </div>
          <div className="thread-board">
            {recentThreads.map((thread) => {
              const tone = statusTone[thread.status] || 'gray';
              return (
                <button
                  key={thread.threadId}
                  className="thread-tile"
                  style={{ textAlign: 'left', padding: 0, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer' }}
                  onClick={() => onSelectThread(thread)}
                >
                  <div className="thread-main">
                    <div className="thread-status-row">
                      <span className={`status-dot tone-${tone}`} style={{ background: `var(--tone-${tone})` }} />
                      <span style={{ textTransform: 'capitalize' }}>{thread.status}</span>
                      <span className="thread-time">{relativeTime(thread.lastActivityAt)}</span>
                    </div>
                    <h2>{thread.title}</h2>
                    <p className="workspace-name">{thread.workspace}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
