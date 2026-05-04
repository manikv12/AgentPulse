import type { HelperHealth, Project, Thread, ThreadStatus } from '@agent-pulse/shared';
import { useMemo } from 'react';
import { ProviderMark } from './ProviderMark';
import { providerLabel, providerTone } from './providers';
import { statusLabels, statusTone } from './status';

type Props = {
  threads: Thread[];
  projects?: Project[];
  health: HelperHealth;
  threadModels?: Record<string, string>;
};

const TONE_COLOR: Record<string, string> = {
  green: 'var(--tone-green)',
  blue: 'var(--tone-blue)',
  yellow: 'var(--tone-yellow)',
  red: 'var(--tone-red)',
  orange: 'var(--tone-orange)',
  gray: 'var(--tone-gray)'
};

const STATUS_ORDER: ThreadStatus[] = [
  'running',
  'compacting',
  'waiting_approval',
  'error',
  'connection',
  'idle',
  'unknown'
];

export function DashboardInsights({ threads, projects = [], health, threadModels = {} }: Props) {
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of threads) {
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    }
    return counts;
  }, [threads]);

  const totalThreads = threads.length;

  const statusSegments = STATUS_ORDER
    .map((status) => ({ status, count: statusCounts[status] ?? 0 }))
    .filter((s) => s.count > 0);

  const modelUsage = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of threads) {
      const model = threadModels[t.threadId] ?? t.model;
      if (!model) continue;
      counts[model] = (counts[model] ?? 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [threads, threadModels]);

  const topProjects = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const t of threads) {
      const key = workspaceInsightKey(t.workspacePath, t.workspace);
      const existing = counts.get(key);
      counts.set(key, {
        name: existing?.name ?? t.workspace,
        count: (existing?.count ?? 0) + 1
      });
    }
    const ordered = projects.length > 0
      ? combineWorkspaceInsightRows(
          projects.map((p) => {
            const key = workspaceInsightKey(p.path, p.name);
            return {
              key,
              name: p.name,
              count: counts.get(key)?.count ?? 0
            };
          })
        )
      : [...counts.entries()].map(([key, value]) => ({ key, ...value }));
    return ordered.sort((a, b) => b.count - a.count).slice(0, 5);
  }, [projects, threads]);

  const recentThreads = useMemo(
    () =>
      [...threads]
        .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())
        .slice(0, 5),
    [threads]
  );

  return (
    <aside className="codex-insights-rail" aria-label="Insights">

      <section className="codex-insight-card">
        <h3 className="codex-insight-card-title">Helper</h3>
        <div className="codex-insight-helper-row">
          <span
            className="codex-insight-helper-dot"
            style={{ background: TONE_COLOR[helperTone(health)] }}
            aria-hidden="true"
          />
          <span className="codex-insight-helper-status">{capitalize(health.status)}</span>
        </div>
      </section>

      {statusSegments.length > 0 && (
        <section className="codex-insight-card">
          <h3 className="codex-insight-card-title">Status breakdown</h3>
          <div className="codex-insight-bars" role="img" aria-label="Thread status breakdown">
            {statusSegments.map(({ status, count }) => (
              <div
                key={status}
                className="codex-insight-bar-segment"
                style={{
                  width: `${(count / totalThreads) * 100}%`,
                  background: TONE_COLOR[statusTone[status]]
                }}
                title={`${statusLabels[status]}: ${count}`}
              />
            ))}
          </div>
          <div className="codex-insight-bar-legend">
            {statusSegments.map(({ status, count }) => (
              <span key={status}>
                <span
                  className={`codex-insight-bar-legend-dot ${status === 'running' || status === 'compacting' ? 'is-working' : ''}`}
                  style={{ background: TONE_COLOR[statusTone[status]] }}
                />
                {statusLabels[status]} · {count}
              </span>
            ))}
          </div>
        </section>
      )}

      {topProjects.length > 0 && (
        <section className="codex-insight-card">
          <h3 className="codex-insight-card-title">Workspaces</h3>
          <ul className="codex-insight-list">
            {topProjects.map((p) => (
              <li key={p.key} className="codex-insight-list-row">
                <span className="codex-insight-list-row-title">{p.name}</span>
                <span className="codex-insight-list-row-meta">{p.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recentThreads.length > 0 && (
        <section className="codex-insight-card">
          <h3 className="codex-insight-card-title">Recent activity</h3>
          <ul className="codex-insight-list">
            {recentThreads.map((thread) => (
              <li key={thread.threadId} className="codex-insight-list-row">
                <span
                  className={`codex-insight-list-row-mark provider-${providerTone(thread.provider)}`}
                  aria-label={providerLabel(thread.provider)}
                >
                  <ProviderMark provider={thread.provider} size="sm" />
                </span>
                <span className="codex-insight-list-row-title">{thread.title}</span>
                <span className="codex-insight-list-row-meta">{statusLabels[thread.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {modelUsage.length > 0 && (
        <section className="codex-insight-card">
          <h3 className="codex-insight-card-title">Models</h3>
          <ul className="codex-insight-list">
            {modelUsage.map(([model, count]) => (
              <li key={model} className="codex-insight-list-row">
                <span className="codex-insight-list-row-title">{model}</span>
                <span className="codex-insight-list-row-meta">{count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

    </aside>
  );
}

function helperTone(health: HelperHealth): string {
  if (health.status === 'ok') return 'green';
  if (health.status === 'degraded') return 'yellow';
  return 'red';
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function workspaceInsightKey(pathValue: string | undefined, name: string): string {
  return normalizeWorkspaceText(pathValue ?? name) || normalizeWorkspaceText(name);
}

function normalizeWorkspaceText(value: string): string {
  return value.trim().replace(/\/+$/g, '').toLowerCase();
}

function combineWorkspaceInsightRows(
  rows: Array<{ key: string; name: string; count: number }>
): Array<{ key: string; name: string; count: number }> {
  const byKey = new Map<string, { key: string; name: string; count: number }>();
  const usedNames = new Map<string, string>();

  for (const row of rows) {
    const nameKey = normalizeWorkspaceText(row.name);
    const key = usedNames.get(nameKey) ?? row.key;
    usedNames.set(nameKey, key);
    const existing = byKey.get(key);
    byKey.set(key, {
      key,
      name: existing?.name ?? row.name,
      count: (existing?.count ?? 0) + row.count
    });
  }

  return [...byKey.values()];
}
