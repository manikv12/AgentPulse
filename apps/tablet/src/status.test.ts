import { describe, expect, it } from 'vitest';
import type { Thread } from '@agent-pulse/shared';
import { hasUnseenActivity, threadNeedsReview } from './status';

const baseThread: Thread = {
  threadId: 'thread-1',
  provider: 'codex',
  title: 'Fix review state',
  workspace: 'CodexPulse',
  status: 'idle',
  lastActivityAt: '2026-05-01T13:28:17.118Z',
  lastTurnSummary: ''
};

describe('thread review state', () => {
  it('does not re-open review for tiny timestamp drift after a thread was seen', () => {
    const seenAt = Date.parse('2026-05-01T13:28:17.000Z');

    expect(hasUnseenActivity(baseThread, { 'thread-1': seenAt })).toBe(false);
    expect(threadNeedsReview(baseThread, { 'thread-1': seenAt })).toBe(false);
  });

  it('still marks genuinely newer idle activity for review', () => {
    const seenAt = Date.parse('2026-05-01T13:27:00.000Z');

    expect(hasUnseenActivity(baseThread, { 'thread-1': seenAt })).toBe(true);
    expect(threadNeedsReview(baseThread, { 'thread-1': seenAt })).toBe(true);
  });
});
