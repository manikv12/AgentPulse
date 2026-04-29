import type { Thread, ThreadStatus } from '@agent-pulse/shared';

export const statusLabels: Record<ThreadStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  compacting: 'Compacting',
  waiting_approval: 'Approval',
  error: 'Error',
  connection: 'Connection',
  unknown: 'Unknown'
};

export const statusTone: Record<ThreadStatus, string> = {
  idle: 'green',
  running: 'blue',
  compacting: 'blue',
  waiting_approval: 'yellow',
  error: 'red',
  connection: 'orange',
  unknown: 'gray'
};

export function isAttentionStatus(status: ThreadStatus): boolean {
  return status === 'waiting_approval' || status === 'error' || status === 'connection';
}

export function hasUnseenActivity(thread: Thread, seenThreadActivity: Record<string, number>): boolean {
  const seenAt = seenThreadActivity[thread.threadId] ?? 0;
  const activityAt = Date.parse(thread.lastActivityAt);
  return Number.isFinite(activityAt) && activityAt > seenAt;
}

export function threadNeedsReview(thread: Thread, seenThreadActivity: Record<string, number>): boolean {
  return thread.status === 'idle' && hasUnseenActivity(thread, seenThreadActivity);
}

export function relativeTime(value: string): string {
  const then = new Date(value).getTime();
  const diffSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
}
