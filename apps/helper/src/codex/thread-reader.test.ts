import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CodexThreadReader,
  isUserFacingThreadSource,
  isLiveStatusFresh,
  limitCodexSidebarHistory,
  mapSqliteThreadRow,
  orderedCodexSidebarProjectRoots,
  parseCodexSidebarState,
  projectIdForPath,
  readUsageFromRollout,
  readLastLines,
  readRolloutSignals,
  resolveThreadWorkspaceRoot,
  shouldShowInCodexSidebarProjects,
  workspaceNameFromCwd
} from './thread-reader';

describe('Codex thread reader', () => {
  it('maps sqlite thread rows to safe tablet thread summaries', () => {
    const mapped = mapSqliteThreadRow({
      id: 'thread-1',
      title: 'Fix billing page',
      cwd: '/Users/me/projects/BillingApp',
      updated_at_ms: 1777133990620,
      archived: 0,
      rollout_path: '/Users/me/.codex/sessions/private-rollout.jsonl'
    });

    expect(mapped).toEqual({
      threadId: 'thread-1',
      title: 'Fix billing page',
      workspace: 'BillingApp',
      status: 'idle',
      lastActivityAt: '2026-04-25T16:19:50.620Z',
      lastTurnSummary: ''
    });
    expect(mapped).not.toHaveProperty('rollout_path');
  });

  it('detects waiting approval and error signals from rollout text without exposing raw content', () => {
    const signals = readRolloutSignals([
      '{"type":"event_msg","message":"waiting for approval"}',
      '{"type":"error","message":"tool call failed"}'
    ]);

    expect(signals).toEqual(['waiting_approval', 'error']);
  });

  it('does not treat old failure text as a live error after task completion', () => {
    const signals = readRolloutSignals([
      '{"type":"event_msg","payload":{"type":"exec_command_end","status":"failed","exit_code":1}}',
      '{"type":"event_msg","payload":{"type":"agent_message","message":"Fixed after the test failed."}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}'
    ]);

    expect(signals).toEqual([]);
  });

  it('detects an unfinished Codex task as running from rollout lifecycle events', () => {
    const signals = readRolloutSignals([
      '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-old"}}',
      '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-new"}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end","status":"completed","exit_code":0,"turn_id":"turn-new"}}'
    ]);

    expect(signals).toEqual(['running']);
  });

  it('does not keep a fresh completed task running only because it had recent activity', () => {
    const signals = readRolloutSignals([
      '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end","status":"completed","exit_code":0,"turn_id":"turn-1"}}',
      '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}',
      '{"type":"event_msg","payload":{"type":"token_count"}}'
    ]);

    expect(signals).toEqual([]);
  });

  it('uses current turn tokens for context fullness instead of cumulative thread tokens', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-pulse-usage-'));
    const rolloutPath = path.join(tempRoot, 'rollout.jsonl');

    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 900_000
              },
              last_token_usage: {
                total_tokens: 100_000
              },
              model_context_window: 200_000
            },
            rate_limits: {
              primary: {
                used_percent: 8,
                window_minutes: 300
              },
              secondary: {
                used_percent: 63,
                window_minutes: 10080
              },
              plan_type: 'prolite'
            }
          }
        })
      ].join('\n')
    );

    try {
      await expect(readUsageFromRollout(rolloutPath)).resolves.toMatchObject({
        contextTokens: 100_000,
        contextWindow: 200_000,
        contextUsedPercent: 50,
        primaryWindow: {
          usedPercent: 8,
          windowMinutes: 300
        },
        secondaryWindow: {
          usedPercent: 63,
          windowMinutes: 10080
        },
        planType: 'prolite'
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('detects a latest failed command before the task completes', () => {
    const signals = readRolloutSignals([
      '{"type":"event_msg","payload":{"type":"agent_message","message":"Running checks."}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end","status":"failed","exit_code":1}}'
    ]);

    expect(signals).toEqual(['error']);
  });

  it('treats old rollout status signals as stale', () => {
    expect(
      isLiveStatusFresh(Date.parse('2026-04-25T16:00:00Z'), new Date('2026-04-25T16:29:59Z'), 30 * 60 * 1000)
    ).toBe(true);
    expect(
      isLiveStatusFresh(Date.parse('2026-04-25T16:00:00Z'), new Date('2026-04-25T16:30:01Z'), 30 * 60 * 1000)
    ).toBe(false);
  });

  it('parses the same saved project roots the Codex sidebar uses', () => {
    const sidebar = parseCodexSidebarState(
      JSON.stringify({
        'electron-saved-workspace-roots': [
          '/Users/me/projects/AgentPulse',
          '/Users/me/projects/OpenAssist'
        ],
        'active-workspace-roots': ['/Users/me/projects/AgentPulse'],
        'projectless-thread-ids': ['thread-projectless'],
        'project-order': ['/Users/me/projects/OpenAssist', '/Users/me/projects/AgentPulse'],
        'thread-workspace-root-hints': {
          'thread-hinted': '/Users/me/projects/OpenAssist'
        }
      })
    );

    expect(sidebar.savedWorkspaceRoots).toEqual([
      '/Users/me/projects/AgentPulse',
      '/Users/me/projects/OpenAssist'
    ]);
    expect(sidebar.activeWorkspaceRoots).toEqual(['/Users/me/projects/AgentPulse']);
    expect(sidebar.projectlessThreadIds.has('thread-projectless')).toBe(true);
    expect(sidebar.projectOrder).toEqual([
      '/Users/me/projects/OpenAssist',
      '/Users/me/projects/AgentPulse'
    ]);
    expect(sidebar.threadWorkspaceRootHints).toEqual({
      'thread-hinted': '/Users/me/projects/OpenAssist'
    });
  });

  it('keeps Codex project order ahead of the remaining saved workspaces', () => {
    const sidebar = parseCodexSidebarState(
      JSON.stringify({
        'electron-saved-workspace-roots': [
          '/Users/me/projects/AgentPulse',
          '/Users/me/projects/OpenAssist',
          '/Users/me/projects/Showcase'
        ],
        'active-workspace-roots': ['/Users/me/projects/AgentPulse'],
        'project-order': ['/Users/me/projects/OpenAssist']
      })
    );

    expect(orderedCodexSidebarProjectRoots(sidebar)).toEqual([
      '/Users/me/projects/OpenAssist',
      '/Users/me/projects/AgentPulse',
      '/Users/me/projects/Showcase'
    ]);
  });

  it('collapses nested thread cwd values onto the Codex sidebar project root', () => {
    const sidebar = parseCodexSidebarState(
      JSON.stringify({
        'electron-saved-workspace-roots': ['/Users/me/projects/Vellum']
      })
    );
    const workspaceRoot = resolveThreadWorkspaceRoot(
      {
        id: 'thread-vellum-web',
        cwd: '/Users/me/projects/Vellum/apps/web'
      },
      sidebar
    );

    const mapped = mapSqliteThreadRow(
      {
        id: 'thread-vellum-web',
        title: 'Fix nested package',
        cwd: '/Users/me/projects/Vellum/apps/web',
        source: 'vscode',
        updated_at_ms: 1777133990620,
        archived: 0,
        rollout_path: ''
      },
      workspaceRoot
    );

    expect(workspaceRoot).toBe('/Users/me/projects/Vellum');
    expect(mapped.workspace).toBe('Vellum');
  });

  it('uses Codex workspace root hints for worktree-backed threads', () => {
    const sidebar = parseCodexSidebarState(
      JSON.stringify({
        'electron-saved-workspace-roots': ['/Users/me/projects/Rapid'],
        'thread-workspace-root-hints': {
          'thread-worktree': '/Users/me/projects/Rapid'
        }
      })
    );
    const workspaceRoot = resolveThreadWorkspaceRoot(
      {
        id: 'thread-worktree',
        cwd: '/Users/me/.codex/worktrees/cd6d/Rapid'
      },
      sidebar
    );

    expect(workspaceRoot).toBe('/Users/me/projects/Rapid');
    expect(
      shouldShowInCodexSidebarProjects(
        {
          id: 'thread-worktree',
          cwd: workspaceRoot
        },
        'idle',
        sidebar
      )
    ).toBe(true);
  });

  it('derives projects from Codex-visible roots instead of every raw thread cwd', async () => {
    const reader = new CodexThreadReader() as any;
    const sidebar = parseCodexSidebarState(
      JSON.stringify({
        'electron-saved-workspace-roots': ['/Users/me/projects/Vellum'],
        'project-order': ['/Users/me/projects/Vellum']
      })
    );

    reader.readSidebarState = async () => sidebar;
    reader.readSqliteRows = async () => [
      {
        id: 'thread-root',
        title: 'Root thread',
        cwd: '/Users/me/projects/Vellum',
        source: 'vscode',
        updated_at_ms: 1777133990620,
        archived: 0,
        rollout_path: ''
      },
      {
        id: 'thread-nested',
        title: 'Nested thread',
        cwd: '/Users/me/projects/Vellum/apps/web',
        source: 'vscode',
        updated_at_ms: 1777133991620,
        archived: 0,
        rollout_path: ''
      },
      {
        id: 'thread-scratch',
        title: 'Scratch thread',
        cwd: '/Users/me/Documents/Codex/2026-04-26-temp',
        source: 'vscode',
        updated_at_ms: 1777133992620,
        archived: 0,
        rollout_path: ''
      }
    ];
    reader.readSignalsForRow = async () => [];

    await expect(reader.listThreads()).resolves.toMatchObject([
      {
        threadId: 'thread-root',
        workspace: 'Vellum'
      },
      {
        threadId: 'thread-nested',
        workspace: 'Vellum'
      }
    ]);
    await expect(reader.listProjects()).resolves.toEqual([
      {
        projectId: projectIdForPath('/Users/me/projects/Vellum'),
        name: 'Vellum',
        path: '/Users/me/projects/Vellum'
      }
    ]);
  });

  it('keeps old idle chats when their workspace is still in the Codex sidebar', () => {
    const sidebar = parseCodexSidebarState(
      JSON.stringify({
        'electron-saved-workspace-roots': ['/Users/me/projects/OpenAssist'],
        'projectless-thread-ids': []
      })
    );

    expect(
      shouldShowInCodexSidebarProjects(
        {
          id: 'thread-openassist',
          cwd: '/Users/me/projects/OpenAssist'
        },
        'idle',
        sidebar
      )
    ).toBe(true);
  });

  it('keeps old idle chats from the active Codex workspace even if it is not saved yet', () => {
    const sidebar = parseCodexSidebarState(
      JSON.stringify({
        'electron-saved-workspace-roots': [],
        'active-workspace-roots': ['/Users/me/projects/AgentPulse'],
        'projectless-thread-ids': []
      })
    );

    expect(
      shouldShowInCodexSidebarProjects(
        {
          id: 'thread-active',
          cwd: '/Users/me/projects/AgentPulse'
        },
        'idle',
        sidebar
      )
    ).toBe(true);
  });

  it('hides old projectless chats that are not part of the Codex sidebar projects', () => {
    const sidebar = parseCodexSidebarState(
      JSON.stringify({
        'electron-saved-workspace-roots': ['/Users/me/projects/OpenAssist'],
        'projectless-thread-ids': ['thread-generated']
      })
    );

    expect(
      shouldShowInCodexSidebarProjects(
        {
          id: 'thread-generated',
          cwd: '/Users/me/Documents/Codex/2026-04-22-can-you-check-the-codex-app'
        },
        'idle',
        sidebar
      )
    ).toBe(false);
  });

  it('still shows running or attention threads even when they are projectless', () => {
    const sidebar = parseCodexSidebarState(
      JSON.stringify({
        'electron-saved-workspace-roots': ['/Users/me/projects/OpenAssist'],
        'projectless-thread-ids': ['thread-generated']
      })
    );

    expect(
      shouldShowInCodexSidebarProjects(
        {
          id: 'thread-generated',
          cwd: '/Users/me/Documents/Codex/2026-04-22-can-you-check-the-codex-app'
        },
        'running',
        sidebar
      )
    ).toBe(true);
    expect(
      shouldShowInCodexSidebarProjects(
        {
          id: 'thread-generated',
          cwd: '/Users/me/Documents/Codex/2026-04-22-can-you-check-the-codex-app'
        },
        'waiting_approval',
        sidebar
      )
    ).toBe(true);
  });

  it('keeps only a small Codex-style slice of idle history per project', () => {
    const visible = limitCodexSidebarHistory(
      [
        {
          threadId: 'live-1',
          title: 'Running now',
          workspace: 'OpenAssist',
          status: 'running',
          lastActivityAt: '2026-04-26T15:00:00Z',
          lastTurnSummary: ''
        },
        ...Array.from({ length: 7 }, (_, index) => ({
          threadId: `idle-${index}`,
          title: `Idle ${index}`,
          workspace: 'OpenAssist',
          status: 'idle' as const,
          lastActivityAt: `2026-04-2${index}T15:00:00Z`,
          lastTurnSummary: ''
        }))
      ],
      5
    );

    expect(visible.map((thread) => thread.threadId)).toEqual([
      'live-1',
      'idle-0',
      'idle-1',
      'idle-2',
      'idle-3',
      'idle-4'
    ]);
  });

  it('does not treat subagent worker rows as normal sidebar chats', () => {
    expect(isUserFacingThreadSource('vscode')).toBe(true);
    expect(isUserFacingThreadSource('cli')).toBe(true);
    expect(
      isUserFacingThreadSource(
        '{"subagent":{"thread_spawn":{"parent_thread_id":"parent","depth":1,"agent_role":"worker"}}}'
      )
    ).toBe(false);
  });

  it('uses the folder name as the workspace label', () => {
    expect(workspaceNameFromCwd('/Users/me/projects/AgentPulse')).toBe('AgentPulse');
  });

  it('reads only the end of large rollout files for live status checks', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'agent-pulse-rollout-'));
    const filePath = path.join(directory, 'rollout.jsonl');

    try {
      await writeFile(
        filePath,
        `${Array.from({ length: 2_000 }, (_, index) => `line-${index}`).join('\n')}\nlast-line`,
        'utf8'
      );

      await expect(readLastLines(filePath, 3)).resolves.toEqual([
        'line-1998',
        'line-1999',
        'last-line'
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
