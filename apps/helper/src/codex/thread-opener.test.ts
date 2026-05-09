import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createThreadOpener, resolveDefaultScriptPath } from './thread-opener';
import type { RolloutLookup } from './rollout-lookup';
import type { RolloutWatcherEvent, RolloutWatcherOptions } from './rollout-watch';

const stubLookup: RolloutLookup = {
  findRolloutPath: vi.fn(async () => null)
};

const stubWatch = (): ReturnType<typeof import('./rollout-watch').watchRolloutFile> => ({
  stop: vi.fn()
});

function fakeNow(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    }
  };
}

function createTestThreadOpener(
  options: Parameters<typeof createThreadOpener>[0] = {}
): ReturnType<typeof createThreadOpener> {
  return createThreadOpener({ platform: 'darwin', ...options });
}

describe('thread opener', () => {
  it('opens the target thread with AppleScript on openThread', async () => {
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: stubLookup,
      watchRollout: stubWatch,
      scriptPath: '/abs/script.applescript',
      bundleId: 'com.openai.codex',
      appPath: '/Applications/Codex.app'
    });

    await expect(opener.openThread('019dc68a-aedf-70f0-901e-825a65116744')).resolves.toEqual({ ok: true });

    expect(execFile).toHaveBeenCalledWith(
      'osascript',
      [
        '/abs/script.applescript',
        'com.openai.codex',
        '/Applications/Codex.app',
        'codex://threads/019dc68a-aedf-70f0-901e-825a65116744'
      ],
      expect.any(Function)
    );
    opener.dispose();
  });

  it('opens the target thread with a mini-window refresh when requested', async () => {
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: stubLookup,
      watchRollout: stubWatch,
      scriptPath: '/abs/script.applescript',
      bundleId: 'com.openai.codex',
      appPath: '/Applications/Codex.app'
    });

    await expect(
      opener.openThread('019dc68a-aedf-70f0-901e-825a65116744', { refreshMode: 'mini-window' })
    ).resolves.toEqual({ ok: true });

    expect(execFile).toHaveBeenCalledWith(
      'osascript',
      [
        '/abs/script.applescript',
        'com.openai.codex',
        '/Applications/Codex.app',
        'codex://threads/019dc68a-aedf-70f0-901e-825a65116744',
        'mini-window',
        '2500'
      ],
      expect.any(Function)
    );
    opener.dispose();
  });

  it('opens the target thread with the Windows URL handler on Windows', async () => {
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: stubLookup,
      watchRollout: stubWatch,
      platform: 'win32'
    });

    await expect(opener.openThread('thread-123')).resolves.toEqual({ ok: true });

    expect(execFile).toHaveBeenCalledWith(
      'cmd.exe',
      ['/c', 'start', '', 'codex://threads/thread-123'],
      expect.any(Function)
    );
    opener.dispose();
  });

  it('does not run AppleScript frontmost checks outside macOS', async () => {
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: stubLookup,
      watchRollout: stubWatch,
      platform: 'win32'
    });

    await expect(opener.isCodexFrontmost?.()).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
    opener.dispose();
  });

  it('finds the AppleScript copied into the built helper dist folder', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-pulse-refresh-script-'));
    const distDir = path.join(tempRoot, 'dist');
    const expectedScriptPath = path.join(distDir, 'codex/scripts/codex-refresh.applescript');

    await mkdir(path.dirname(expectedScriptPath), { recursive: true });
    await writeFile(expectedScriptPath, '-- test script');

    try {
      expect(resolveDefaultScriptPath(distDir)).toBe(expectedScriptPath);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('falls back to a direct thread deep link if osascript fails', async () => {
    const execFile = vi
      .fn()
      .mockImplementationOnce((_command, _args, callback) => callback(new Error('osascript missing')))
      .mockImplementationOnce((_command, _args, callback) => callback(null));
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: stubLookup,
      watchRollout: stubWatch,
      bundleId: 'com.openai.codex'
    });

    await expect(opener.openThread('thread-123')).resolves.toEqual({ ok: true });

    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'open',
      ['-b', 'com.openai.codex', 'codex://threads/thread-123'],
      expect.any(Function)
    );
    opener.dispose();
  });

  it('falls back to `open -a Codex` if osascript and the direct bundle open fail', async () => {
    const execFile = vi
      .fn()
      .mockImplementationOnce((_command, _args, callback) => callback(new Error('osascript missing')))
      .mockImplementationOnce((_command, _args, callback) => callback(new Error('bad thread url')))
      .mockImplementationOnce((_command, _args, callback) => callback(null));
    const opener = createTestThreadOpener({ execFile, rolloutLookup: stubLookup, watchRollout: stubWatch });

    await expect(opener.openThread('thread-123')).resolves.toEqual({ ok: true });

    expect(execFile).toHaveBeenLastCalledWith('open', ['-a', 'Codex', 'codex://threads/thread-123'], expect.any(Function));
    opener.dispose();
  });

  it('uses the mini-window refresh path for forced desktop remounts', async () => {
    vi.useFakeTimers();
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: stubLookup,
      watchRollout: stubWatch,
      scriptPath: '/script.applescript',
      debounceMs: 0,
      refreshThrottleMs: 0,
      growthWaitMs: 10
    });

    opener.refreshDesktop('thread-123', {
      forceRemount: true,
      immediate: true,
      waitForGrowth: false
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(execFile).toHaveBeenCalledWith(
      'osascript',
      [
        '/script.applescript',
        'com.openai.codex',
        '/Applications/Codex.app',
        'codex://threads/thread-123',
        'mini-window',
        '2500'
      ],
      expect.any(Function)
    );
    expect(execFile).not.toHaveBeenCalledWith(
      'open',
      ['-b', 'com.openai.codex', 'codex://settings'],
      expect.any(Function)
    );

    opener.dispose();
    vi.useRealTimers();
  });

  it('does not start the rollout live watcher after a forced mini-window refresh', async () => {
    vi.useFakeTimers();
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const lookup: RolloutLookup = {
      findRolloutPath: vi.fn(async () => '/sessions/rollout-x.jsonl')
    };
    const watchRollout = vi.fn(stubWatch);
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: lookup,
      watchRollout,
      scriptPath: '/script.applescript',
      debounceMs: 0,
      refreshThrottleMs: 0,
      growthWaitMs: 10
    });

    opener.refreshDesktop('thread-123', {
      forceRemount: true,
      immediate: true,
      waitForGrowth: false
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(execFile).toHaveBeenCalledWith(
      'osascript',
      [
        '/script.applescript',
        'com.openai.codex',
        '/Applications/Codex.app',
        'codex://threads/thread-123',
        'mini-window',
        '2500'
      ],
      expect.any(Function)
    );
    expect(lookup.findRolloutPath).not.toHaveBeenCalled();
    expect(watchRollout).not.toHaveBeenCalled();

    opener.dispose();
    vi.useRealTimers();
  });

  it('debounces rapid refreshDesktop calls into a single bounce', async () => {
    vi.useFakeTimers();
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const time = fakeNow();
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: stubLookup,
      watchRollout: stubWatch,
      scriptPath: '/script.applescript',
      debounceMs: 1_200,
      refreshThrottleMs: 0,
      growthWaitMs: 10,
      now: time.now
    });

    opener.refreshDesktop('t1');
    opener.refreshDesktop('t1');
    opener.refreshDesktop('t1');

    expect(execFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_200);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(execFile).toHaveBeenCalledTimes(1);
    opener.dispose();
    vi.useRealTimers();
  });

  it('waits for rollout file growth before bouncing when a rollout path is known', async () => {
    vi.useFakeTimers();
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const onEventHandlers: Array<(event: RolloutWatcherEvent) => void> = [];
    const watchRollout = vi.fn((opts: RolloutWatcherOptions) => {
      onEventHandlers.push(opts.onEvent);
      return { stop: vi.fn() };
    });
    const lookup: RolloutLookup = {
      findRolloutPath: vi.fn(async () => '/sessions/rollout-x.jsonl')
    };
    const time = fakeNow();
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: lookup,
      watchRollout,
      scriptPath: '/script.applescript',
      debounceMs: 0,
      refreshThrottleMs: 0,
      growthWaitMs: 1_500,
      now: time.now
    });

    opener.refreshDesktop('019dc68a-aedf-70f0-901e-825a65116744');

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(watchRollout).toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();

    onEventHandlers[0]?.({ type: 'growth', rolloutPath: '/sessions/rollout-x.jsonl', previousSize: 100, nextSize: 200 });

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(execFile).toHaveBeenCalledTimes(1);
    opener.dispose();
    vi.useRealTimers();
  });

  it('still bounces if the rollout file never grows (lookup_timeout)', async () => {
    vi.useFakeTimers();
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const onEventHandlers: Array<(event: RolloutWatcherEvent) => void> = [];
    const watchRollout = vi.fn((opts: RolloutWatcherOptions) => {
      onEventHandlers.push(opts.onEvent);
      return { stop: vi.fn() };
    });
    const lookup: RolloutLookup = {
      findRolloutPath: vi.fn(async () => '/sessions/rollout-x.jsonl')
    };
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: lookup,
      watchRollout,
      scriptPath: '/script.applescript',
      debounceMs: 0,
      refreshThrottleMs: 0,
      growthWaitMs: 1_500
    });

    opener.refreshDesktop('thread-x');

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    onEventHandlers[0]?.({ type: 'lookup_timeout' });
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(execFile).toHaveBeenCalledTimes(1);
    opener.dispose();
    vi.useRealTimers();
  });

  it('throttles back-to-back refreshes', async () => {
    vi.useFakeTimers();
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const time = fakeNow();
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: stubLookup,
      watchRollout: stubWatch,
      scriptPath: '/script.applescript',
      debounceMs: 0,
      refreshThrottleMs: 5_000,
      growthWaitMs: 10,
      now: time.now
    });

    opener.refreshDesktop('t1');
    await vi.advanceTimersByTimeAsync(20);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(execFile).toHaveBeenCalledTimes(1);

    time.advance(20);
    opener.refreshDesktop('t1');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(execFile).toHaveBeenCalledTimes(1);

    time.advance(1_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(execFile).toHaveBeenCalledTimes(2);

    opener.dispose();
    vi.useRealTimers();
  });

  it('keeps watching the rollout and refreshes again when a phone-started run grows', async () => {
    vi.useFakeTimers();
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const onEventHandlers: Array<(event: RolloutWatcherEvent) => void> = [];
    const watchRollout = vi.fn((opts: RolloutWatcherOptions) => {
      onEventHandlers.push(opts.onEvent);
      return { stop: vi.fn() };
    });
    const lookup: RolloutLookup = {
      findRolloutPath: vi.fn(async () => '/sessions/rollout-live.jsonl')
    };
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: lookup,
      watchRollout,
      scriptPath: '/script.applescript',
      debounceMs: 0,
      refreshThrottleMs: 0,
      growthWaitMs: 1_500
    });

    opener.refreshDesktop('thread-live');

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    onEventHandlers[0]?.({
      type: 'growth',
      rolloutPath: '/sessions/rollout-live.jsonl',
      previousSize: 100,
      nextSize: 160
    });
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(watchRollout).toHaveBeenCalledTimes(2);

    onEventHandlers[1]?.({
      type: 'growth',
      rolloutPath: '/sessions/rollout-live.jsonl',
      previousSize: 160,
      nextSize: 220
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(execFile).toHaveBeenCalledTimes(2);
    opener.dispose();
    vi.useRealTimers();
  });

  it('dispose cancels any pending refresh', async () => {
    vi.useFakeTimers();
    const execFile = vi.fn((_command, _args, callback) => callback(null));
    const opener = createTestThreadOpener({
      execFile,
      rolloutLookup: stubLookup,
      watchRollout: stubWatch,
      debounceMs: 1_000,
      refreshThrottleMs: 0,
      growthWaitMs: 10
    });

    opener.refreshDesktop('t1');
    opener.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(execFile).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
