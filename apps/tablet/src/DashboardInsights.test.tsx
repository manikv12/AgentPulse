// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project, Thread } from '@agent-pulse/shared';
import { DashboardInsights } from './DashboardInsights';

describe('Dashboard insights', () => {
  afterEach(() => {
    cleanup();
  });

  it('combines repeated workspace rows with the same display name', () => {
    const threads: Thread[] = [
      thread('rapid-root', 'Rapid', '/Users/me/projects/Rapid'),
      thread('rapid-worktree', 'Rapid', '/private/var/folders/tmp/vibe-kanban-worktrees/1abd/Rapid'),
      thread('amwins', 'Amwins', '/Users/me/projects/Amwins')
    ];
    const projects: Project[] = [
      project('rapid-root', 'Rapid', '/Users/me/projects/Rapid'),
      project('rapid-worktree', 'Rapid', '/private/var/folders/tmp/vibe-kanban-worktrees/1abd/Rapid'),
      project('amwins', 'Amwins', '/Users/me/projects/Amwins')
    ];

    render(
      <DashboardInsights
        threads={threads}
        projects={projects}
        health={{ status: 'ok', codexAppServer: 'connected', version: '0.1.0', uptimeSec: 1 }}
      />
    );

    const workspaces = screen.getByRole('heading', { name: 'Workspaces' }).closest('section');
    expect(workspaces).not.toBeNull();
    const rows = within(workspaces!).getAllByRole('listitem');

    expect(rows.map((row) => row.textContent)).toEqual(['Rapid2', 'Amwins1']);
  });
});

function thread(threadId: string, workspace: string, workspacePath: string): Thread {
  return {
    threadId,
    provider: 'codex',
    providerThreadId: threadId,
    title: threadId,
    workspace,
    workspacePath,
    status: 'idle',
    lastActivityAt: '2026-05-03T12:00:00.000Z',
    lastTurnSummary: ''
  };
}

function project(projectId: string, name: string, path: string): Project {
  return {
    projectId,
    name,
    path,
    providers: ['codex']
  };
}
