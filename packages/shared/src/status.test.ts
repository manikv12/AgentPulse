import { describe, expect, it } from 'vitest';
import { THREAD_STATUS_PRIORITY, resolveThreadStatus } from './index';

describe('resolveThreadStatus', () => {
  it('returns error when error and waiting approval signals both apply', () => {
    expect(resolveThreadStatus(['waiting_approval', 'error'])).toBe('error');
  });

  it('keeps unknown as the lowest-attention status', () => {
    expect(resolveThreadStatus(['unknown', 'idle'])).toBe('idle');
  });

  it('orders every public status exactly like the requirements', () => {
    expect(THREAD_STATUS_PRIORITY).toEqual([
      'error',
      'connection',
      'waiting_approval',
      'compacting',
      'running',
      'idle',
      'unknown'
    ]);
  });
});
