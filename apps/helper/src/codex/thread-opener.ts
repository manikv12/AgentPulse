import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRolloutLookup, type RolloutLookup } from './rollout-lookup';
import { watchRolloutFile, type RolloutWatcher, type RolloutWatcherEvent } from './rollout-watch';

type ExecFile = (
  command: string,
  args: string[],
  callback: (error: Error | null) => void
) => void;

export type ThreadOpenResult = {
  ok: boolean;
  error?: string;
};

export type ThreadOpenerOptions = {
  execFile?: ExecFile;
  rolloutLookup?: RolloutLookup;
  watchRollout?: typeof watchRolloutFile;
  debounceMs?: number;
  refreshThrottleMs?: number;
  growthWaitMs?: number;
  liveRefreshIdleMs?: number;
  bundleId?: string;
  appPath?: string;
  scriptPath?: string;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  now?: () => number;
};

export type ThreadOpener = {
  openThread(threadId: string): Promise<ThreadOpenResult>;
  revealThread(threadId: string): Promise<ThreadOpenResult>;
  refreshDesktop(threadId: string): void;
  dispose(): void;
};

const DEFAULT_DEBOUNCE_MS = 1_200;
const DEFAULT_REFRESH_THROTTLE_MS = 1_500;
const DEFAULT_GROWTH_WAIT_MS = 1_500;
const DEFAULT_LIVE_REFRESH_IDLE_MS = 60_000;
const DEFAULT_BUNDLE_ID = 'com.openai.codex';
const DEFAULT_APP_PATH = '/Applications/Codex.app';

export function createThreadOpener(options: ThreadOpenerOptions = {}): ThreadOpener {
  const execFile = options.execFile ?? nodeExecFile;
  const rolloutLookup = options.rolloutLookup ?? createRolloutLookup();
  const watchRollout = options.watchRollout ?? watchRolloutFile;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const refreshThrottleMs = options.refreshThrottleMs ?? DEFAULT_REFRESH_THROTTLE_MS;
  const growthWaitMs = options.growthWaitMs ?? DEFAULT_GROWTH_WAIT_MS;
  const liveRefreshIdleMs = options.liveRefreshIdleMs ?? DEFAULT_LIVE_REFRESH_IDLE_MS;
  const bundleId = options.bundleId ?? DEFAULT_BUNDLE_ID;
  const appPath = options.appPath ?? DEFAULT_APP_PATH;
  const scriptPath = options.scriptPath ?? resolveDefaultScriptPath();
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const now = options.now ?? (() => Date.now());

  let pendingThreadId: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  let queuedAfterCurrent = false;
  let lastRefreshAt = 0;
  let disposed = false;
  let pendingRefreshShouldWaitForGrowth = true;
  let liveWatcher: RolloutWatcher | undefined;
  let liveWatcherThreadId: string | null = null;
  let liveWatcherGeneration = 0;

  function run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(command, args, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async function executeBounce(threadId: string): Promise<ThreadOpenResult> {
    const targetUrl = `codex://threads/${encodeURIComponent(threadId)}`;
    try {
      await run('osascript', [scriptPath, bundleId, appPath, targetUrl]);
      return { ok: true };
    } catch (scriptError) {
      try {
        await run('open', ['-b', bundleId, targetUrl]);
        return { ok: true };
      } catch {
        try {
          await run('open', ['-a', 'Codex', targetUrl]);
          return { ok: true };
        } catch (fallbackError) {
          return {
            ok: false,
            error:
              fallbackError instanceof Error
                ? fallbackError.message
                : scriptError instanceof Error
                  ? scriptError.message
                  : 'Could not refresh Codex on this Mac.'
          };
        }
      }
    }
  }

  async function performRefresh(threadId: string, waitForGrowth: boolean): Promise<void> {
    if (disposed) {
      return;
    }
    refreshing = true;
    try {
      if (waitForGrowth) {
        await waitForRolloutGrowth(threadId, {
          rolloutLookup,
          watchRollout,
          growthWaitMs
        });
      }
      const result = await executeBounce(threadId);
      lastRefreshAt = now();
      if (result.ok) {
        startLiveRefreshWatcher(threadId);
      }
    } finally {
      refreshing = false;
      if (queuedAfterCurrent && pendingThreadId && !disposed) {
        queuedAfterCurrent = false;
        scheduleRefresh(pendingThreadId, { waitForGrowth: pendingRefreshShouldWaitForGrowth });
      }
    }
  }

  function scheduleRefresh(
    threadId: string,
    options: { waitForGrowth?: boolean } = {}
  ): void {
    if (disposed) {
      return;
    }
    pendingThreadId = threadId;
    if (options.waitForGrowth === false) {
      pendingRefreshShouldWaitForGrowth = false;
    }

    if (refreshing) {
      queuedAfterCurrent = true;
      return;
    }

    if (debounceTimer) {
      clearTimeoutFn(debounceTimer);
    }

    const elapsed = now() - lastRefreshAt;
    const wait = Math.max(debounceMs, refreshThrottleMs - elapsed);

    debounceTimer = setTimeoutFn(() => {
      debounceTimer = undefined;
      const target = pendingThreadId;
      if (!target) {
        return;
      }
      const waitForGrowth = pendingRefreshShouldWaitForGrowth;
      pendingThreadId = null;
      pendingRefreshShouldWaitForGrowth = true;
      void performRefresh(target, waitForGrowth);
    }, Math.max(0, wait));
  }

  function startLiveRefreshWatcher(threadId: string): void {
    if (disposed || !threadId) {
      return;
    }

    if (liveWatcherThreadId === threadId && liveWatcher) {
      return;
    }

    stopLiveRefreshWatcher();
    const generation = ++liveWatcherGeneration;
    liveWatcherThreadId = threadId;

    void rolloutLookup.findRolloutPath(threadId).then((rolloutPath) => {
      if (
        disposed ||
        !rolloutPath ||
        liveWatcherGeneration !== generation ||
        liveWatcherThreadId !== threadId
      ) {
        return;
      }

      liveWatcher = watchRollout({
        rolloutPath,
        idleTimeoutMs: liveRefreshIdleMs,
        lookupTimeoutMs: growthWaitMs,
        onEvent: (event) => handleLiveRefreshEvent(threadId, event)
      });
    }).catch(() => {
      if (liveWatcherGeneration === generation) {
        liveWatcherThreadId = null;
      }
    });
  }

  function handleLiveRefreshEvent(threadId: string, event: RolloutWatcherEvent): void {
    if (disposed || liveWatcherThreadId !== threadId) {
      return;
    }

    if (event.type === 'growth') {
      scheduleRefresh(threadId, { waitForGrowth: false });
      return;
    }

    if (event.type === 'idle') {
      scheduleRefresh(threadId, { waitForGrowth: false });
      stopLiveRefreshWatcher();
      return;
    }

    if (event.type === 'lookup_timeout' || event.type === 'stopped') {
      stopLiveRefreshWatcher();
    }
  }

  function stopLiveRefreshWatcher(): void {
    liveWatcherGeneration += 1;
    const watcher = liveWatcher;
    liveWatcher = undefined;
    liveWatcherThreadId = null;
    if (watcher) {
      watcher.stop();
    }
  }

  async function executeReveal(threadId: string): Promise<ThreadOpenResult> {
    const targetUrl = `codex://threads/${encodeURIComponent(threadId)}`;
    try {
      await run('open', [targetUrl]);
      return { ok: true };
    } catch {
      try {
        await run('open', ['-a', 'Codex']);
        return { ok: true };
      } catch (fallbackError) {
        return {
          ok: false,
          error:
            fallbackError instanceof Error
              ? fallbackError.message
              : 'Could not open Codex on this Mac.'
        };
      }
    }
  }

  return {
    async openThread(threadId: string): Promise<ThreadOpenResult> {
      return executeBounce(threadId);
    },
    async revealThread(threadId: string): Promise<ThreadOpenResult> {
      return executeReveal(threadId);
    },
    refreshDesktop(threadId: string): void {
      if (!threadId) {
        return;
      }
      scheduleRefresh(threadId);
    },
    dispose(): void {
      disposed = true;
      if (debounceTimer) {
        clearTimeoutFn(debounceTimer);
        debounceTimer = undefined;
      }
      stopLiveRefreshWatcher();
      pendingThreadId = null;
      queuedAfterCurrent = false;
      pendingRefreshShouldWaitForGrowth = true;
    }
  };
}

async function waitForRolloutGrowth(
  threadId: string,
  options: {
    rolloutLookup: RolloutLookup;
    watchRollout: typeof watchRolloutFile;
    growthWaitMs: number;
  }
): Promise<void> {
  const rolloutPath = await options.rolloutLookup.findRolloutPath(threadId).catch(() => null);
  if (!rolloutPath) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      watcher.stop();
      resolve();
    };

    const watcher = options.watchRollout({
      rolloutPath,
      idleTimeoutMs: options.growthWaitMs,
      lookupTimeoutMs: options.growthWaitMs,
      onEvent: (event: RolloutWatcherEvent) => {
        if (event.type === 'growth' || event.type === 'idle' || event.type === 'lookup_timeout') {
          finish();
        }
      }
    });

    setTimeout(finish, options.growthWaitMs + 500);
  });
}

export function resolveDefaultScriptPath(baseDir = path.dirname(fileURLToPath(import.meta.url))): string {
  const here = baseDir;
  const candidates = [
    path.resolve(here, 'scripts/codex-refresh.applescript'),
    path.resolve(here, 'codex/scripts/codex-refresh.applescript'),
    path.resolve(here, '../codex/scripts/codex-refresh.applescript'),
    path.resolve(here, '../../src/codex/scripts/codex-refresh.applescript')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}
