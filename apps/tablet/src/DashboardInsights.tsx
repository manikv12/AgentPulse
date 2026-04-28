import type { HelperHealth, Project, Thread, ThreadStatus } from '@agent-pulse/shared';
import { useMemo } from 'react';
import { relativeTime, statusLabels, statusTone } from './status';

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
  const activeThreads = (statusCounts.running ?? 0) + (statusCounts.waiting_approval ?? 0);

  const statusSegments = STATUS_ORDER
    .map((status) => ({
      status,
      count: statusCounts[status] ?? 0
    }))
    .filter((s) => s.count > 0);

  const recentThreads = useMemo(() => {
    return [...threads]
      .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())
      .slice(0, 8);
  }, [threads]);

  const projectCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of threads) {
      counts[t.workspace] = (counts[t.workspace] ?? 0) + 1;
    }
    return counts;
  }, [threads]);

  const topProjects = useMemo(() => {
    const ordered = projects.length > 0
      ? projects.map((p) => ({ name: p.name, count: projectCounts[p.name] ?? 0 }))
      : Object.entries(projectCounts).map(([name, count]) => ({ name, count }));
    return ordered.sort((a, b) => b.count - a.count).slice(0, 6);
  }, [projects, projectCounts]);

  const modelUsage = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of threads) {
      const model = threadModels[t.threadId] ?? t.model;
      if (!model) continue;
      counts[model] = (counts[model] ?? 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [threads, threadModels]);

  return (
    <aside className="codex-insights-rail" aria-label="Insights">
      <section className="codex-insight-card">
        <h3 className="codex-insight-card-title">Overview</h3>
        <div className="codex-insight-stat-row">
          <div className="codex-insight-stat">
            <div className="codex-insight-stat-value">{totalThreads}</div>
            <div className="codex-insight-stat-label">Threads</div>
          </div>
          <div className="codex-insight-stat">
            <div className="codex-insight-stat-value">{activeThreads}</div>
            <div className="codex-insight-stat-label">Active</div>
          </div>
          <div className="codex-insight-stat">
            <div className="codex-insight-stat-value" style={{ color: TONE_COLOR[helperTone(health)] }}>
              {capitalize(health.status)}
            </div>
            <div className="codex-insight-stat-label">Helper</div>
          </div>
        </div>
      </section>

      {statusSegments.length > 0 ? (
        <section className="codex-insight-card">
          <h3 className="codex-insight-card-title">Status</h3>
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
                  className="codex-insight-bar-legend-dot"
                  style={{ background: TONE_COLOR[statusTone[status]] }}
                />
                {statusLabels[status]} · {count}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {recentThreads.length > 0 ? (
        <section className="codex-insight-card">
          <h3 className="codex-insight-card-title">Recent activity</h3>
          <ul className="codex-insight-list">
            {recentThreads.map((t) => (
              <li key={t.threadId} className="codex-insight-list-row">
                <span
                  className="codex-insight-list-row-dot"
                  style={{ background: TONE_COLOR[statusTone[t.status]] }}
                />
                <span className="codex-insight-list-row-title">{t.title}</span>
                <span className="codex-insight-list-row-meta">{relativeTime(t.lastActivityAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {topProjects.length > 0 ? (
        <section className="codex-insight-card">
          <h3 className="codex-insight-card-title">Projects</h3>
          <ul className="codex-insight-list">
            {topProjects.map((p) => (
              <li key={p.name} className="codex-insight-list-row">
                <span className="codex-insight-list-row-title">{p.name}</span>
                <span className="codex-insight-list-row-meta">{p.count}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {modelUsage.length > 0 ? (
        <section className="codex-insight-card">
          <h3 className="codex-insight-card-title">Models in use</h3>
          <ul className="codex-insight-list">
            {modelUsage.map(([model, count]) => (
              <li key={model} className="codex-insight-list-row">
                <span className="codex-insight-list-row-title">{model}</span>
                <span className="codex-insight-list-row-meta">{count}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
