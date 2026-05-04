import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project, Thread } from '@agent-pulse/shared';
import {
  normalizeProjectForWorkspaceDisplay,
  normalizeThreadForWorkspaceDisplay,
  WorkspaceDisplayRootResolver
} from './workspace-display';

describe('workspace display normalization', () => {
  it('collapses nested folders to the enclosing git repo root', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-pulse-workspace-root-'));
    const nestedWorkspace = path.join(repoRoot, 'Watch app', 'AgentPulseWatch');

    await mkdir(path.join(repoRoot, '.git'));
    await mkdir(nestedWorkspace, { recursive: true });

    try {
      const resolver = new WorkspaceDisplayRootResolver();
      await expect(resolver.resolve(nestedWorkspace)).resolves.toBe(repoRoot);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('rewrites thread and project display paths when a nested folder belongs to the same repo', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-pulse-workspace-display-'));
    const nestedWorkspace = path.join(repoRoot, 'Watch app');

    await mkdir(path.join(repoRoot, '.git'));
    await mkdir(nestedWorkspace, { recursive: true });

    const thread: Thread = {
      threadId: 'thread-watch',
      provider: 'claude-code',
      providerThreadId: 'native-watch',
      title: 'Watch app fixes',
      workspace: 'Watch app',
      workspacePath: nestedWorkspace,
      status: 'idle',
      lastActivityAt: '2026-05-03T12:00:00.000Z',
      lastTurnSummary: ''
    };
    const project: Project = {
      projectId: 'project-watch',
      name: 'Watch app',
      path: nestedWorkspace,
      providers: ['claude-code']
    };

    try {
      const resolver = new WorkspaceDisplayRootResolver();
      await expect(normalizeThreadForWorkspaceDisplay(thread, resolver)).resolves.toMatchObject({
        workspace: path.basename(repoRoot),
        workspacePath: repoRoot
      });
      await expect(normalizeProjectForWorkspaceDisplay(project, resolver)).resolves.toMatchObject({
        name: path.basename(repoRoot),
        path: repoRoot
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('leaves chat threads untouched', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-pulse-workspace-chat-'));
    const chatPath = path.join(repoRoot, 'Watch app');

    await mkdir(path.join(repoRoot, '.git'));
    await mkdir(chatPath, { recursive: true });

    const thread: Thread = {
      threadId: 'thread-chat',
      provider: 'codex',
      providerThreadId: 'thread-chat',
      title: 'Chat',
      workspace: 'Chats',
      workspacePath: chatPath,
      workspaceKind: 'chat',
      status: 'idle',
      lastActivityAt: '2026-05-03T12:00:00.000Z',
      lastTurnSummary: ''
    };

    try {
      const resolver = new WorkspaceDisplayRootResolver();
      await expect(normalizeThreadForWorkspaceDisplay(thread, resolver)).resolves.toEqual(thread);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
