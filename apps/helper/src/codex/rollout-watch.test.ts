import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchRolloutFile, type RolloutWatcherEvent } from './rollout-watch';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('watchRolloutFile', () => {
  it('emits a growth event when the file grows', async () => {
    const events: RolloutWatcherEvent[] = [];
    let size = 100;
    const statFile = vi.fn(async () => ({ size }));

    const watcher = watchRolloutFile({
      rolloutPath: '/x.jsonl',
      intervalMs: 50,
      lookupTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      statFile,
      onEvent: (event) => events.push(event)
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(events.find((event) => event.type === 'found')).toBeTruthy();

    size = 200;
    await vi.advanceTimersByTimeAsync(50);

    const growth = events.find((event) => event.type === 'growth');
    expect(growth).toBeTruthy();
    if (growth?.type === 'growth') {
      expect(growth.previousSize).toBe(100);
      expect(growth.nextSize).toBe(200);
    }

    watcher.stop();
  });

  it('emits lookup_timeout if the file never appears', async () => {
    const events: RolloutWatcherEvent[] = [];
    const statFile = vi.fn(async () => {
      throw new Error('ENOENT');
    });

    watchRolloutFile({
      rolloutPath: '/missing.jsonl',
      intervalMs: 50,
      lookupTimeoutMs: 200,
      idleTimeoutMs: 1_000,
      statFile,
      onEvent: (event) => events.push(event)
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(events.some((event) => event.type === 'lookup_timeout')).toBe(true);
    expect(events.some((event) => event.type === 'stopped')).toBe(true);
  });

  it('emits idle if the file exists but never grows', async () => {
    const events: RolloutWatcherEvent[] = [];
    const statFile = vi.fn(async () => ({ size: 100 }));

    watchRolloutFile({
      rolloutPath: '/static.jsonl',
      intervalMs: 50,
      lookupTimeoutMs: 1_000,
      idleTimeoutMs: 250,
      statFile,
      onEvent: (event) => events.push(event)
    });

    await vi.advanceTimersByTimeAsync(800);

    expect(events.some((event) => event.type === 'idle')).toBe(true);
    expect(events.some((event) => event.type === 'stopped')).toBe(true);
  });

  it('stop() halts emissions', async () => {
    const events: RolloutWatcherEvent[] = [];
    const statFile = vi.fn(async () => ({ size: 100 }));

    const watcher = watchRolloutFile({
      rolloutPath: '/x.jsonl',
      intervalMs: 50,
      lookupTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      statFile,
      onEvent: (event) => events.push(event)
    });

    await vi.advanceTimersByTimeAsync(60);
    const beforeStopCount = events.length;
    watcher.stop();

    await vi.advanceTimersByTimeAsync(500);
    const stopEventCount = events.filter((event) => event.type === 'stopped').length;
    expect(stopEventCount).toBe(1);
    expect(events.length).toBe(beforeStopCount + 1);
  });
});
