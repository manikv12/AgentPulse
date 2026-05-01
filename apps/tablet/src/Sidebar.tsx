import type { HelperHealth, Project, Thread } from '@agent-pulse/shared';
import {
  ChevronDown,
  ChevronRight,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Sun,
  Wifi,
  WifiOff,
  Search,
  X
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { AppMark } from './AppMark';
import { ProviderMark } from './ProviderMark';
import { providerLabel, providerTone } from './providers';
import { hasUnseenActivity, isAttentionStatus, relativeTime, statusTone, threadNeedsReview } from './status';
import { useThemePreference, type ThemePreference } from './theme';

const COLLAPSED_KEY = 'agent-pulse:sidebar-collapsed';
const COLLAPSED_GROUPS_KEY = 'agent-pulse:sidebar-collapsed-groups';

function readCollapsedFromStorage(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.localStorage.getItem(COLLAPSED_KEY) === '1';
}

function readCollapsedGroupsFromStorage(): Set<string> {
  if (typeof window === 'undefined') {
    return new Set();
  }
  try {
    const data = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (data) {
      return new Set(JSON.parse(data));
    }
  } catch {}
  return new Set();
}

function writeCollapsedGroupsToStorage(groups: Set<string>) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups]));
  } catch {}
}

export type SidebarProps = {
  threads: Thread[];
  projects?: Project[];
  activeThreadId?: string;
  seenThreadActivity?: Record<string, number>;
  workingThreadIds?: Set<string>;
  onSelectThread: (thread: Thread) => void;
  onNewThread?: (projectId?: string) => void;
  onOpenSettings?: () => void;
  onGoHome?: () => void;
  health: HelperHealth;
  isOpen?: boolean;
  onClose?: () => void;
};

type ProjectGroup = {
  workspace: string;
  workspacePath: string;
  project?: Project;
  threads: Thread[];
};

function sortThreadsByActivity(threads: Thread[]): Thread[] {
  return [...threads].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
  );
}

function groupAndSortThreads(threads: Thread[], projects: Project[] = []): ProjectGroup[] {
  const groups = new Map<string, Thread[]>();

  for (const thread of threads) {
    const key = thread.workspacePath ?? thread.workspace;
    const existing = groups.get(key) ?? [];
    existing.push(thread);
    groups.set(key, existing);
  }

  const projectByPath = new Map(projects.map((project) => [project.path, project]));
  const projectByName = new Map(projects.map((project) => [project.name, project]));
  const seenProjectPaths = new Set<string>();
  const groupedThreads = [...groups.entries()]
    .map(([workspacePath, groupThreads]) => {
      const project =
        projectByPath.get(workspacePath) ??
        projectByName.get(groupThreads[0]?.workspace ?? workspacePath);
      return {
        workspace: groupThreads[0]?.workspace ?? project?.name ?? workspacePath,
        workspacePath: project?.path ?? workspacePath,
        project,
        threads: sortThreadsByActivity(groupThreads)
      };
    })
    .sort((a, b) => {
      const aLatest = new Date(a.threads[0]?.lastActivityAt ?? 0).getTime();
      const bLatest = new Date(b.threads[0]?.lastActivityAt ?? 0).getTime();
      return bLatest - aLatest;
    });

  for (const group of groupedThreads) {
    if (group.project) {
      seenProjectPaths.add(group.project.path);
    }
  }

  const emptyProjectGroups = projects
    .filter((project) => !seenProjectPaths.has(project.path) && !groups.has(project.path))
    .map((project) => ({
      workspace: project.name,
      workspacePath: project.path,
      project,
      threads: []
    }));

  return [...groupedThreads, ...emptyProjectGroups];
}

function fuzzyIncludes(value: string | undefined, query: string): boolean {
  const haystack = normalizeSearchText(value);
  const needle = normalizeSearchText(query);
  if (!needle) {
    return true;
  }
  if (haystack.includes(needle)) {
    return true;
  }
  const compactHaystack = haystack.replace(/\s+/g, '');
  const compactNeedle = needle.replace(/\s+/g, '');
  if (compactHaystack.includes(compactNeedle)) {
    return true;
  }

  let index = 0;
  for (const char of compactHaystack) {
    if (char === compactNeedle[index]) {
      index += 1;
      if (index === compactNeedle.length) {
        return true;
      }
    }
  }
  return false;
}

function normalizeSearchText(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function filterProjectGroups(groups: ProjectGroup[], rawQuery: string): ProjectGroup[] {
  const query = rawQuery.trim();
  if (!query) {
    return groups;
  }

  return groups
    .map((group) => {
      const projectMatches =
        fuzzyIncludes(group.workspace, query) ||
        fuzzyIncludes(group.workspacePath, query) ||
        fuzzyIncludes(group.project?.name, query) ||
        fuzzyIncludes(group.project?.path, query);
      const matchingThreads = group.threads.filter(
        (thread) =>
          projectMatches ||
          fuzzyIncludes(thread.title, query) ||
          fuzzyIncludes(thread.workspace, query) ||
          fuzzyIncludes(thread.workspacePath, query)
      );

      if (!projectMatches && matchingThreads.length === 0) {
        return undefined;
      }

      return {
        ...group,
        threads: projectMatches ? group.threads : matchingThreads
      };
    })
    .filter((group): group is ProjectGroup => group !== undefined);
}

function ThemeQuickToggle({
  theme,
  onChange
}: {
  theme: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  const nextTheme: ThemePreference = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  const Icon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon;
  const label = `Theme: ${theme}. Switch to ${nextTheme}.`;

  return (
    <button
      className="codex-sidebar-icon"
      type="button"
      onClick={() => onChange(nextTheme)}
      aria-label={label}
      title={label}
    >
      <Icon size={14} />
    </button>
  );
}

export function Sidebar({
  threads,
  projects = [],
  activeThreadId,
  seenThreadActivity = {},
  workingThreadIds,
  onSelectThread,
  onNewThread,
  onOpenSettings,
  onGoHome,
  health,
  isOpen = false,
  onClose
}: SidebarProps) {
  const projectGroups = useMemo(() => groupAndSortThreads(threads, projects), [projects, threads]);
  const degraded = health.status !== 'ok';
  const { theme, setTheme } = useThemePreference();
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsedFromStorage());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => readCollapsedGroupsFromStorage());
  const [searchQuery, setSearchQuery] = useState('');
  const visibleProjectGroups = useMemo(
    () => filterProjectGroups(projectGroups, searchQuery),
    [projectGroups, searchQuery]
  );
  const searchActive = searchQuery.trim().length > 0;
  const visibleThreadCount = visibleProjectGroups.reduce(
    (count, group) => count + group.threads.length,
    0
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  useEffect(() => {
    writeCollapsedGroupsToStorage(collapsedGroups);
  }, [collapsedGroups]);

  const toggleCollapsed = () => setCollapsed((prev) => !prev);

  const toggleGroup = (workspace: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(workspace)) {
        next.delete(workspace);
      } else {
        next.add(workspace);
      }
      return next;
    });
  };

  if (collapsed) {
    const attentionCount = threads.reduce(
      (acc, thread) =>
        acc +
        (threadNeedsReview(thread, seenThreadActivity) ||
        (isAttentionStatus(thread.status) && hasUnseenActivity(thread, seenThreadActivity))
          ? 1
          : 0),
      0
    );
    const healthLabel = health.status === 'ok' ? 'OK' : health.status === 'degraded' ? 'DEG' : 'DOWN';

    return (
      <aside
        className={`codex-sidebar is-collapsed ${isOpen ? 'is-open' : ''}`}
        data-testid="codex-sidebar"
      >
        <button
          type="button"
          className="codex-sidebar-sheet-handle"
          onClick={onClose}
          aria-label="Close thread list"
        >
          <span className="codex-sidebar-sheet-handle-bar" aria-hidden="true" />
        </button>
        <button
          className="codex-sidebar-brand-rail"
          onClick={onGoHome}
          type="button"
          style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}
        >
          <AppMark size="sm" />
        </button>

        <button
          className="codex-sidebar-rail-toggle"
          type="button"
          onClick={toggleCollapsed}
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <PanelLeftOpen size={18} />
        </button>

        <button
          className="codex-sidebar-rail-new"
          type="button"
          onClick={() => onNewThread?.()}
          disabled={onNewThread === undefined}
          aria-label="New thread"
          title="New thread"
        >
          <Plus size={18} />
        </button>

        {attentionCount > 0 ? (
          <div
            className="codex-sidebar-rail-attention"
            title={`${attentionCount} thread${attentionCount === 1 ? '' : 's'} need attention`}
            aria-label={`${attentionCount} threads need attention`}
          >
            {attentionCount}
          </div>
        ) : null}

        <div className="codex-sidebar-rail-divider" aria-hidden="true" />

        <ul className="codex-sidebar-rail-threads">
          {visibleProjectGroups.map((group, groupIndex) => (
            <Fragment key={group.workspacePath}>
              {groupIndex > 0 ? (
                <li className="codex-sidebar-rail-group-divider" aria-hidden="true" />
              ) : null}
              {group.threads.map((thread) => {
                const active = thread.threadId === activeThreadId;
                const isWorking = workingThreadIds?.has(thread.threadId) ?? false;
                const showLiveDot =
                  isWorking || thread.status === 'running' || thread.status === 'compacting';
                const initial = (group.workspace.trim().charAt(0) || '·').toUpperCase();

                return (
                  <li key={thread.threadId}>
                    <button
                      type="button"
                      className={`codex-sidebar-rail-thread ${active ? 'is-active' : ''}`}
                      onClick={() => onSelectThread(thread)}
                      aria-label={`Open chat for ${thread.title}`}
                      title={`${group.workspace} · ${providerLabel(thread.provider)} · ${thread.title} · ${thread.status}`}
                    >
                      <span className={`codex-sidebar-rail-initial provider-${providerTone(thread.provider)}`}>{initial}</span>
                      {showLiveDot ? (
                        <span
                          className="codex-sidebar-rail-dot tone-blue is-working"
                          aria-hidden="true"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </Fragment>
          ))}
        </ul>

        <footer className="codex-sidebar-rail-footer">
          <ThemeQuickToggle theme={theme} onChange={setTheme} />
          <button
            className="codex-sidebar-icon"
            type="button"
            onClick={onOpenSettings}
            aria-label="Open settings"
          >
            <Settings size={14} />
          </button>
          <div
            className={`codex-sidebar-rail-health ${degraded ? 'is-degraded' : 'is-ok'}`}
            title={degraded ? `Helper ${health.status}` : 'Helper live'}
          >
            {degraded ? <WifiOff size={14} /> : <Wifi size={14} />}
            <span className="codex-sidebar-rail-health-label">{healthLabel}</span>
          </div>
        </footer>
      </aside>
    );
  }

  return (
    <aside className={`codex-sidebar ${isOpen ? 'is-open' : ''}`} data-testid="codex-sidebar">
      <button
        type="button"
        className="codex-sidebar-sheet-handle"
        onClick={onClose}
        aria-label="Close thread list"
      >
        <span className="codex-sidebar-sheet-handle-bar" aria-hidden="true" />
      </button>
      <div className="codex-sidebar-brand">
        <button
          className="codex-sidebar-brand-left"
          onClick={onGoHome}
          type="button"
          style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', color: 'inherit' }}
        >
          <AppMark size="sm" />
          <div className="codex-sidebar-brand-copy">
            <span className="codex-sidebar-brand-title">Agent Pulse</span>
          </div>
        </button>
        <button
          className="codex-sidebar-collapse"
          type="button"
          onClick={toggleCollapsed}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      <button
        className="codex-sidebar-new"
        type="button"
        onClick={() => onNewThread?.()}
        disabled={onNewThread === undefined}
      >
        <Plus size={16} />
        <span>New thread</span>
      </button>

      <p className="codex-sidebar-section-label">Threads</p>

      <div className={`codex-sidebar-search-shell ${searchActive ? 'is-active' : ''}`}>
        <label className="codex-sidebar-search">
          <Search size={11} aria-hidden="true" />
          <span className="sr-only">Search threads</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder="Search threads or projects"
            aria-label="Search threads or projects"
          />
          {searchActive ? (
            <button
              className="codex-sidebar-search-clear"
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear thread search"
              title="Clear search"
            >
              <X size={13} />
            </button>
          ) : null}
        </label>
        <div className="codex-sidebar-search-meta" aria-live="polite">
          {searchActive
            ? `${visibleThreadCount} thread${visibleThreadCount === 1 ? '' : 's'} found`
            : 'Search by thread or project'}
        </div>
      </div>

      <div className="codex-sidebar-thread-scroll" aria-label="Thread list">
        {visibleProjectGroups.map((group) => {
          const isGroupCollapsed = !searchActive && collapsedGroups.has(group.workspacePath);
          return (
            <div
              key={group.workspacePath}
              className={`codex-sidebar-group ${searchActive ? 'is-search-result' : ''}`}
            >
              <div className="codex-sidebar-group-heading">
                <button
                  className="codex-sidebar-group-name"
                  type="button"
                  onClick={() => toggleGroup(group.workspacePath)}
                  style={{ background: 'transparent', border: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit', fontFamily: 'inherit' }}
                >
                  <span style={{ color: 'var(--text-subtle)', display: 'grid', placeItems: 'center' }}>
                    {isGroupCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </span>
                  {group.workspace}
                </button>
              {group.project ? (
                <button
                  className="codex-sidebar-group-new"
                  type="button"
                  onClick={() => onNewThread?.(group.project?.projectId)}
                  disabled={onNewThread === undefined}
                  aria-label={`New thread in ${group.workspace}`}
                  title={`New thread in ${group.workspace}`}
                >
                  <Plus size={14} />
                </button>
              ) : null}
            </div>
            {!isGroupCollapsed ? (
              <ul className="codex-sidebar-threads">
                {group.threads.map((thread) => {
                const active = thread.threadId === activeThreadId;
                const isWorking = workingThreadIds?.has(thread.threadId) ?? false;
                const isLive = isWorking || thread.status === 'compacting';
                const isWaitingApproval = thread.status === 'waiting_approval';
                const isCompacting = thread.status === 'compacting';
                const needsReview = threadNeedsReview(thread, seenThreadActivity);
                const dotTone = isLive ? 'blue' : needsReview ? 'yellow' : statusTone[thread.status];
                const showDot =
                  isLive ||
                  needsReview ||
                  isWaitingApproval ||
                  (isAttentionStatus(thread.status) && hasUnseenActivity(thread, seenThreadActivity));

                return (
                  <li key={thread.threadId}>
                    <button
                      type="button"
                      className={`codex-sidebar-thread ${active ? 'is-active' : ''}`}
                      onClick={() => onSelectThread(thread)}
                      aria-label={`Open chat for ${thread.title}`}
                    >
                      <span className="codex-sidebar-thread-dot-slot" aria-hidden="true">
                        {showDot ? (
                          <span
                            className={`codex-sidebar-thread-dot tone-${dotTone} ${isLive ? 'is-working' : ''}`}
                          />
                        ) : null}
                      </span>
                      <span
                        className={`codex-sidebar-thread-mark provider-${providerTone(thread.provider)}`}
                        aria-label={providerLabel(thread.provider)}
                      >
                        <ProviderMark provider={thread.provider} size="sm" />
                      </span>
                      <span className="codex-sidebar-thread-title">{thread.title}</span>
                      {needsReview ? (
                        <span className="codex-sidebar-thread-state is-review">Review</span>
                      ) : isWaitingApproval ? (
                        <span className="codex-sidebar-thread-state">Awaiting approval</span>
                      ) : isCompacting ? (
                        <span className="codex-sidebar-thread-state is-compacting">Compacting</span>
                      ) : null}
                      <span className="codex-sidebar-thread-time">
                        {relativeTime(thread.lastActivityAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
              {group.threads.length === 0 ? (
                <li className="codex-sidebar-empty-project">No threads yet</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      );
    })}
        {visibleProjectGroups.length === 0 ? (
          <div className="codex-sidebar-search-empty">No matching threads or projects.</div>
        ) : null}
  </div>

      <footer className="codex-sidebar-footer">
        <div className={`codex-sidebar-health ${degraded ? 'is-degraded' : 'is-ok'}`}>
          {degraded ? <WifiOff size={14} /> : <Wifi size={14} />}
          <span className="codex-sidebar-health-label">{degraded ? 'Helper limited' : 'Helper live'}</span>
        </div>
        <ThemeQuickToggle theme={theme} onChange={setTheme} />
        <button
          className="codex-sidebar-icon"
          type="button"
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="Settings"
        >
          <Settings size={14} />
        </button>
      </footer>
    </aside>
  );
}
