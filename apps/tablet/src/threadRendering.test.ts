import type { ChatMessage } from '@agent-pulse/shared';
import { describe, expect, it } from 'vitest';
import { buildRenderableEntries } from './threadRendering';

const message = (overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage => ({
  role: 'activity',
  kind: 'status',
  text: '',
  createdAt: '2026-04-25T16:14:00Z',
  ...overrides
});

describe('thread rendering helpers', () => {
  it('renders user, collapsed activity summary, then final answer for a completed turn', () => {
    const entries = buildRenderableEntries([
      message({
        id: 'user-1',
        role: 'user',
        kind: 'message',
        text: 'Check this.'
      }),
      message({
        id: 'cmd-1',
        kind: 'command',
        text: 'rg -n "streaming" apps',
        createdAt: '2026-04-25T16:14:05Z'
      }),
      message({
        id: 'search-1',
        kind: 'tool',
        text: 'web_search completed',
        createdAt: '2026-04-25T16:14:10Z'
      }),
      message({
        id: 'assistant-1',
        role: 'assistant',
        kind: 'message',
        phase: 'final_answer',
        text: 'Done.',
        createdAt: '2026-04-25T16:14:38Z'
      })
    ]);

    expect(entries.map((entry) => entry.type)).toEqual([
      'message',
      'activityGroup',
      'message'
    ]);
    expect(entries[1]).toMatchObject({
      type: 'activityGroup',
      group: {
        status: 'completed',
        title: 'Worked for 38s'
      }
    });
    expect(entries[2]).toMatchObject({
      type: 'message',
      message: { id: 'assistant-1', text: 'Done.' }
    });
  });

  it('keeps a turn without a final answer as a running activity group', () => {
    const entries = buildRenderableEntries([
      message({
        id: 'user-1',
        role: 'user',
        kind: 'message',
        text: 'Keep going.'
      }),
      message({
        id: 'thinking-1',
        role: 'assistant',
        kind: 'message',
        phase: 'commentary',
        text: 'I am checking the code.',
        createdAt: '2026-04-25T16:14:05Z'
      }),
      message({
        id: 'tool-1',
        kind: 'tool',
        text: 'Bash pwd',
        createdAt: '2026-04-25T16:14:10Z'
      })
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      type: 'activityGroup',
      group: {
        status: 'running',
        title: 'Working for 10s',
        hasFinalResponse: false
      }
    });
    if (entries[1].type !== 'activityGroup') {
      throw new Error('Expected an activity group');
    }
    expect(entries[1].group.items.at(-1)).toMatchObject({
      id: 'tool-1',
      status: 'running'
    });
  });

  it('keeps unmarked assistant text inside live activity until a final answer is known', () => {
    const entries = buildRenderableEntries(
      [
        message({
          id: 'user-1',
          role: 'user',
          kind: 'message',
          text: 'Check this.'
        }),
        message({
          id: 'assistant-draft',
          role: 'assistant',
          kind: 'message',
          text: 'I am still checking.',
          createdAt: '2026-04-25T16:14:05Z'
        }),
        message({
          id: 'tool-1',
          role: 'activity',
          kind: 'tool',
          text: 'browser.open completed',
          createdAt: '2026-04-25T16:14:10Z'
        })
      ],
      { isLive: true }
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      type: 'message',
      message: { id: 'user-1' }
    });
    expect(entries[1]).toMatchObject({
      type: 'activityGroup',
      group: {
        status: 'running',
        title: 'Working for 10s',
        hasFinalResponse: false
      }
    });
    if (entries[1].type !== 'activityGroup') {
      throw new Error('Expected an activity group');
    }
    expect(entries[1].group.messages.map((item) => item.id)).toEqual([
      'assistant-draft',
      'tool-1'
    ]);
  });

  it('treats commentary assistant text before the final answer as activity', () => {
    const entries = buildRenderableEntries([
      message({
        id: 'user-1',
        role: 'user',
        kind: 'message',
        text: 'Explain it.'
      }),
      message({
        id: 'assistant-commentary',
        role: 'assistant',
        kind: 'message',
        phase: 'commentary',
        text: 'I am tracing the flow.',
        createdAt: '2026-04-25T16:14:05Z'
      }),
      message({
        id: 'assistant-final',
        role: 'assistant',
        kind: 'message',
        text: 'Here is the answer.',
        createdAt: '2026-04-25T16:14:20Z'
      })
    ]);

    expect(entries.map((entry) => entry.type)).toEqual([
      'message',
      'activityGroup',
      'message'
    ]);
    if (entries[1].type !== 'activityGroup') {
      throw new Error('Expected an activity group');
    }
    expect(entries[1].group.items).toHaveLength(1);
    expect(entries[1].group.title).toBe('Worked for 20s');
    expect(entries[1].group.items[0]).toMatchObject({
      id: 'assistant-commentary',
      kind: 'reasoning',
      detail: 'I am tracing the flow.'
    });
    expect(entries[2]).toMatchObject({
      type: 'message',
      message: { id: 'assistant-final' }
    });
  });

  it('honors preserveInputOrder so an optimistic pending bubble stays above tool messages stamped earlier', () => {
    // Simulates the optimistic-pending case: the tablet has just appended the
    // user bubble (timestamped at tablet wall-clock) while the helper has been
    // streaming tool messages whose timestamps come from the helper's clock.
    // If the helper's clock is even slightly behind the tablet's, sorting by
    // createdAt would shove the activity group above the user message — the
    // bug the user reported. With preserveInputOrder, the explicit caller
    // order (pending user first, then helper messages) wins.
    const entries = buildRenderableEntries(
      [
        message({
          id: 'pending-user',
          role: 'user',
          kind: 'message',
          text: 'Optimistic prompt',
          createdAt: '2026-04-25T16:14:30Z'
        }),
        message({
          id: 'tool-old-1',
          role: 'activity',
          kind: 'tool',
          text: 'Bash pwd',
          createdAt: '2026-04-25T16:14:05Z'
        }),
        message({
          id: 'tool-old-2',
          role: 'activity',
          kind: 'tool',
          text: 'web_search query',
          createdAt: '2026-04-25T16:14:10Z'
        })
      ],
      { isLive: true, preserveInputOrder: true }
    );

    expect(entries.map((entry) => entry.type)).toEqual(['message', 'activityGroup']);
    expect(entries[0]).toMatchObject({ type: 'message', message: { id: 'pending-user' } });
    if (entries[1].type !== 'activityGroup') {
      throw new Error('Expected an activity group');
    }
    expect(entries[1].group.messages.map((item) => item.id)).toEqual(['tool-old-1', 'tool-old-2']);
  });

  it('labels the synthetic pending-send activity as Thinking', () => {
    const entries = buildRenderableEntries(
      [
        message({
          id: 'pending-user',
          role: 'user',
          kind: 'message',
          text: 'Slow prompt',
          createdAt: '2026-04-25T16:14:30Z'
        }),
        message({
          id: 'pending-thinking',
          role: 'activity',
          kind: 'reasoning',
          phase: 'pending_send',
          text: 'Codex is thinking...',
          createdAt: '2026-04-25T16:14:31Z'
        })
      ],
      { isLive: true, preserveInputOrder: true }
    );

    expect(entries.map((entry) => entry.type)).toEqual(['message', 'activityGroup']);
    if (entries[1].type !== 'activityGroup') {
      throw new Error('Expected an activity group');
    }
    expect(entries[1].group).toMatchObject({
      title: 'Working for 1s',
      status: 'running'
    });
    expect(entries[1].group.items[0]).toMatchObject({
      title: 'Thinking',
      detail: 'Codex is thinking...'
    });
  });

  it('renders context compaction outside the activity group', () => {
    const entries = buildRenderableEntries([
      message({
        id: 'user-1',
        role: 'user',
        kind: 'message',
        text: 'Continue.',
        createdAt: '2026-04-25T16:14:30Z'
      }),
      message({
        id: 'compact-1',
        role: 'activity',
        kind: 'status',
        phase: 'context_compaction',
        text: 'Automatically compacting context',
        createdAt: '2026-04-25T16:14:31Z'
      })
    ], { isLive: true, isCompacting: true });

    expect(entries.map((entry) => entry.type)).toEqual(['message', 'contextCompaction']);
    if (entries[1].type !== 'contextCompaction') {
      throw new Error('Expected a context compaction marker');
    }
    expect(entries[1]).toMatchObject({
      status: 'running',
      message: {
        id: 'compact-1',
        text: 'Automatically compacting context'
      }
    });
  });

  it('treats compaction as finished when normal live work appears after it', () => {
    const entries = buildRenderableEntries([
      message({
        id: 'user-1',
        role: 'user',
        kind: 'message',
        text: 'Continue.',
        createdAt: '2026-04-25T16:14:30Z'
      }),
      message({
        id: 'tool-before-compact',
        role: 'activity',
        kind: 'command',
        text: 'rg -n compact apps',
        createdAt: '2026-04-25T16:14:32Z'
      }),
      message({
        id: 'compact-1',
        role: 'activity',
        kind: 'status',
        phase: 'context_compaction',
        text: 'Automatically compacting context',
        createdAt: '2026-04-25T16:14:40Z'
      }),
      message({
        id: 'assistant-after-compact',
        role: 'assistant',
        kind: 'message',
        phase: 'commentary',
        text: 'I found the next issue.',
        createdAt: '2026-04-25T16:14:45Z'
      }),
      message({
        id: 'tool-after-compact',
        role: 'activity',
        kind: 'command',
        text: 'pnpm vitest run apps/tablet/src/threadRendering.test.ts',
        createdAt: '2026-04-25T16:14:50Z'
      })
    ], { isLive: true, isCompacting: false });

    expect(entries.map((entry) => entry.type)).toEqual([
      'message',
      'activityGroup',
      'contextCompaction',
      'activityGroup'
    ]);
    expect(entries[1]).toMatchObject({
      type: 'activityGroup',
      group: { status: 'completed', title: 'Worked for 2s' }
    });
    expect(entries[2]).toMatchObject({
      type: 'contextCompaction',
      status: 'completed'
    });
    expect(entries[3]).toMatchObject({
      type: 'activityGroup',
      group: { status: 'running', title: 'Working for 5s' }
    });
  });

  it('hides context compaction once the final answer is visible', () => {
    const entries = buildRenderableEntries([
      message({
        id: 'user-1',
        role: 'user',
        kind: 'message',
        text: 'Continue.',
        createdAt: '2026-04-25T16:14:30Z'
      }),
      message({
        id: 'compact-1',
        role: 'activity',
        kind: 'status',
        phase: 'context_compaction',
        text: 'Automatically compacting context',
        createdAt: '2026-04-25T16:14:31Z'
      }),
      message({
        id: 'assistant-1',
        role: 'assistant',
        kind: 'message',
        phase: 'final_answer',
        text: 'Done.',
        createdAt: '2026-04-25T16:14:35Z'
      })
    ]);

    expect(entries.map((entry) => entry.type)).toEqual(['message', 'message']);
    expect(entries[1]).toMatchObject({
      type: 'message',
      message: { id: 'assistant-1' }
    });
  });

  it('extracts the latest final_answer per turn even when several assistant messages share the same phase (Copilot multi-message turn)', () => {
    // Regression for the screenshot bug: Copilot turns can emit several
    // `assistant.message` chunks (progress updates + final big answer). All
    // should carry phase=final_answer (set by the helper). The renderer
    // walks backward and carves only the latest one out as the visible
    // bubble; earlier ones stay inside the activity group as collapsed
    // progress items. Without that latest extraction, the activity group
    // ends up sitting between the user's prompt and the NEXT user prompt
    // with no answer bubble in between, making it look orphaned.
    const entries = buildRenderableEntries([
      message({
        id: 'user-1',
        role: 'user',
        kind: 'message',
        text: 'Make a doc.',
        createdAt: '2026-04-25T16:14:05Z'
      }),
      message({
        id: 'tool-browser-1',
        role: 'activity',
        kind: 'tool',
        text: 'browser.open completed',
        createdAt: '2026-04-25T16:14:10Z'
      }),
      message({
        id: 'assistant-progress-1',
        role: 'assistant',
        kind: 'message',
        phase: 'final_answer',
        text: 'Drafting…',
        createdAt: '2026-04-25T16:14:11Z'
      }),
      message({
        id: 'tool-browser-2',
        role: 'activity',
        kind: 'tool',
        text: 'browser.open completed',
        createdAt: '2026-04-25T16:14:30Z'
      }),
      message({
        id: 'assistant-final',
        role: 'assistant',
        kind: 'message',
        phase: 'final_answer',
        text: 'Here is the requirements doc you asked for.',
        createdAt: '2026-04-25T16:15:00Z'
      }),
      message({
        id: 'user-2',
        role: 'user',
        kind: 'message',
        text: 'Did you add the documentation?',
        createdAt: '2026-04-25T16:42:15Z'
      }),
      message({
        id: 'assistant-final-2',
        role: 'assistant',
        kind: 'message',
        phase: 'final_answer',
        text: 'No. I was blocked by write permission errors.',
        createdAt: '2026-04-25T16:42:19Z'
      })
    ]);

    expect(entries.map((entry) => entry.type)).toEqual([
      'message',
      'activityGroup',
      'message',
      'message',
      'message'
    ]);
    if (entries[1].type !== 'activityGroup') {
      throw new Error('Expected an activity group for turn 1');
    }
    expect(entries[1].group.messages.map((item) => item.id)).toEqual([
      'tool-browser-1',
      'assistant-progress-1',
      'tool-browser-2'
    ]);
    expect(entries[2]).toMatchObject({
      type: 'message',
      message: { id: 'assistant-final', text: 'Here is the requirements doc you asked for.' }
    });
    expect(entries[3]).toMatchObject({
      type: 'message',
      message: { id: 'user-2' }
    });
    expect(entries[4]).toMatchObject({
      type: 'message',
      message: { id: 'assistant-final-2' }
    });
  });

  it('does not render activity above the first visible user turn', () => {
    const entries = buildRenderableEntries([
      message({
        id: 'search-1',
        role: 'activity',
        kind: 'tool',
        text: 'web_search completed',
        createdAt: '2026-04-25T16:14:05Z'
      }),
      message({
        id: 'assistant-early',
        role: 'assistant',
        kind: 'message',
        text: 'I found a possible source.',
        createdAt: '2026-04-25T16:14:10Z'
      }),
      message({
        id: 'user-1',
        role: 'user',
        kind: 'message',
        text: 'Can you check this?',
        createdAt: '2026-04-25T16:14:00Z'
      }),
      message({
        id: 'tool-1',
        role: 'activity',
        kind: 'tool',
        text: 'browser.open completed',
        createdAt: '2026-04-25T16:14:12Z'
      }),
      message({
        id: 'assistant-final',
        role: 'assistant',
        kind: 'message',
        text: 'Here is what I found.',
        createdAt: '2026-04-25T16:14:20Z'
      })
    ]);

    expect(entries.map((entry) => entry.type)).toEqual([
      'message',
      'activityGroup',
      'message'
    ]);
    expect(entries[0]).toMatchObject({
      type: 'message',
      message: { id: 'user-1' }
    });
    if (entries[1].type !== 'activityGroup') {
      throw new Error('Expected an activity group');
    }
    expect(entries[1].group.messages.map((item) => item.id)).toEqual([
      'search-1',
      'assistant-early',
      'tool-1'
    ]);
    expect(entries[2]).toMatchObject({
      type: 'message',
      message: { id: 'assistant-final' }
    });
  });

  it('renders file changes inside the turn that owns the fileChange item', () => {
    const entries = buildRenderableEntries(
      [
        message({
          id: 'user-1',
          role: 'user',
          kind: 'message',
          text: 'First task',
          turnId: 'turn-1',
          createdAt: '2026-04-25T16:14:00Z'
        }),
        message({
          id: 'file-change-1',
          role: 'activity',
          kind: 'file',
          text: 'File change completed',
          turnId: 'turn-1',
          createdAt: '2026-04-25T16:14:10Z'
        }),
        message({
          id: 'assistant-1',
          role: 'assistant',
          kind: 'message',
          phase: 'final_answer',
          text: 'First done.',
          turnId: 'turn-1',
          createdAt: '2026-04-25T16:14:20Z'
        }),
        message({
          id: 'user-2',
          role: 'user',
          kind: 'message',
          text: 'Second task',
          turnId: 'turn-2',
          createdAt: '2026-04-25T16:15:00Z'
        }),
        message({
          id: 'file-change-2',
          role: 'activity',
          kind: 'file',
          text: 'File change completed',
          turnId: 'turn-2',
          createdAt: '2026-04-25T16:15:10Z'
        }),
        message({
          id: 'assistant-2',
          role: 'assistant',
          kind: 'message',
          phase: 'final_answer',
          text: 'Second done.',
          turnId: 'turn-2',
          createdAt: '2026-04-25T16:15:20Z'
        })
      ],
      {
        fileChanges: [
          {
            id: 'turn-1:file-change-1',
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'file-change-1',
            fileCount: 1,
            linesAdded: 1,
            linesDeleted: 0,
            files: [{ path: 'first.ts', linesAdded: 1, linesDeleted: 0 }],
            action: 'undo',
            canUseCodexApplyPatch: true
          },
          {
            id: 'turn-2:file-change-2',
            threadId: 'thread-1',
            turnId: 'turn-2',
            itemId: 'file-change-2',
            fileCount: 1,
            linesAdded: 2,
            linesDeleted: 0,
            files: [{ path: 'second.ts', linesAdded: 2, linesDeleted: 0 }],
            action: 'undo',
            canUseCodexApplyPatch: true
          }
        ]
      }
    );

    expect(entries.map((entry) => entry.type)).toEqual([
      'message',
      'activityGroup',
      'message',
      'fileChanges',
      'message',
      'activityGroup',
      'message',
      'fileChanges'
    ]);
    expect(entries[3]).toMatchObject({
      type: 'fileChanges',
      summaries: [{ id: 'turn-1:file-change-1' }]
    });
    expect(entries[7]).toMatchObject({
      type: 'fileChanges',
      summaries: [{ id: 'turn-2:file-change-2' }]
    });
  });

  it('does not move a hidden file-change card into the next visible agent response', () => {
    const entries = buildRenderableEntries(
      [
        message({
          id: 'file-change-hidden',
          role: 'activity',
          kind: 'file',
          text: 'File change completed',
          turnId: 'turn-1',
          createdAt: '2026-04-25T16:14:10Z'
        }),
        message({
          id: 'user-2',
          role: 'user',
          kind: 'message',
          text: 'Second task',
          turnId: 'turn-2',
          createdAt: '2026-04-25T16:15:00Z'
        }),
        message({
          id: 'file-change-2',
          role: 'activity',
          kind: 'file',
          text: 'File change completed',
          turnId: 'turn-2',
          createdAt: '2026-04-25T16:15:10Z'
        }),
        message({
          id: 'assistant-2',
          role: 'assistant',
          kind: 'message',
          phase: 'final_answer',
          text: 'Second done.',
          turnId: 'turn-2',
          createdAt: '2026-04-25T16:15:20Z'
        })
      ],
      {
        fileChanges: [
          {
            id: 'hidden:file-change-1',
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'file-change-hidden',
            fileCount: 1,
            linesAdded: 1,
            linesDeleted: 0,
            files: [{ path: 'old.ts', linesAdded: 1, linesDeleted: 0 }],
            action: 'undo',
            canUseCodexApplyPatch: true
          },
          {
            id: 'turn-2:file-change-2',
            threadId: 'thread-1',
            turnId: 'turn-2',
            itemId: 'file-change-2',
            fileCount: 1,
            linesAdded: 2,
            linesDeleted: 0,
            files: [{ path: 'second.ts', linesAdded: 2, linesDeleted: 0 }],
            action: 'undo',
            canUseCodexApplyPatch: true
          }
        ]
      }
    );

    const fileChangeEntries = entries.filter((entry) => entry.type === 'fileChanges');
    expect(fileChangeEntries).toHaveLength(1);
    expect(fileChangeEntries[0]).toMatchObject({
      type: 'fileChanges',
      summaries: [{ id: 'turn-2:file-change-2' }]
    });
  });
});
