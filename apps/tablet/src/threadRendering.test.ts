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
        title: 'Explored the workspace, ran 1 search'
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
});
