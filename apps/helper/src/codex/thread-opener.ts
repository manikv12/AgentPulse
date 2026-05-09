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

export type ThreadOpenOptions = {
  refreshMode?: 'mini-window';
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
  platform?: NodeJS.Platform;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  now?: () => number;
};

export type ThreadRefreshOptions = {
  waitForGrowth?: boolean;
  immediate?: boolean;
  forceRemount?: boolean;
};

export type ThreadOpener = {
  openThread(threadId: string, options?: ThreadOpenOptions): Promise<ThreadOpenResult>;
  revealThread(threadId: string): Promise<ThreadOpenResult>;
  refreshDesktop(threadId: string, options?: ThreadRefreshOptions): void;
  isCodexFrontmost?(): Promise<boolean>;
  dispose(): void;
};

const DEFAULT_DEBOUNCE_MS = 1_200;
const DEFAULT_REFRESH_THROTTLE_MS = 1_500;
const DEFAULT_GROWTH_WAIT_MS = 1_500;
const DEFAULT_LIVE_REFRESH_IDLE_MS = 60_000;
const DEFAULT_MINI_WINDOW_OPEN_MS = 2_500;
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
  const platform = options.platform ?? process.platform;
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
  let pendingRefreshForceRemount = false;
  let liveWatcher: RolloutWatcher | undefined;
  let liveWatcherThreadId: string | null = null;
  let liveWatcherGeneration = 0;

  function run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(command, args, (error) => {
        if (error) {
          // Surface the underlying message so the helper log shows why
          // osascript failed (Accessibility permission, app not found,
          // mini-window detection timed out, etc.) instead of silently
          // falling through to plain `open`.
          console.warn(`[thread-opener] ${command} failed`, {
            args,
            error: error instanceof Error ? error.message : String(error)
          });
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async function executeBounceUrl(
    targetUrl: string,
    options: { preflightUrl?: string; miniWindow?: boolean; miniWindowOpenMs?: number } = {}
  ): Promise<ThreadOpenResult> {
    if (platform === 'win32') {
      return openWindowsDeepLink(targetUrl);
    }

    if (platform !== 'darwin') {
      return openGenericDeepLink(targetUrl);
    }

    const scriptArgs = [scriptPath, bundleId, appPath, targetUrl];
    if (options.miniWindow) {
      scriptArgs.push('mini-window', String(options.miniWindowOpenMs ?? DEFAULT_MINI_WINDOW_OPEN_MS));
    } else if (options.preflightUrl) {
      scriptArgs.push(options.preflightUrl);
    }

    try {
      await run('osascript', scriptArgs);
      return { ok: true };
    } catch (scriptError) {
      // The mini-window dance failed (palette focus race, Accessibility
      // permission revoked, or the new window never appeared). The thread
      // URL still needs to land on Codex, so fall back to a plain
      // `open codex://...` — the user just won't see the brief mini-window
      // pop. This logs once per failure so the underlying cause is visible.
      console.warn('[thread-opener] mini-window osascript failed; falling back to plain open', {
        targetUrl,
        miniWindow: options.miniWindow === true,
        error: scriptError instanceof Error ? scriptError.message : String(scriptError)
      });
      try {
        if (options.preflightUrl) {
          await run('open', ['-b', bundleId, options.preflightUrl]).catch(() => undefined);
        }
        await run('open', ['-b', bundleId, targetUrl]);
        return { ok: true };
      } catch {
        try {
          if (options.preflightUrl) {
            await run('open', ['-a', 'Codex', options.preflightUrl]).catch(() => undefined);
          }
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
                  : 'Could not refresh Codex on this computer.'
          };
        }
      }
    }
  }

  async function executeBounce(
    threadId: string,
    options: ThreadOpenOptions = {}
  ): Promise<ThreadOpenResult> {
    return executeBounceUrl(`codex://threads/${encodeURIComponent(threadId)}`, {
      miniWindow: options.refreshMode === 'mini-window'
    });
  }

  async function executeHardRefresh(threadId: string): Promise<ThreadOpenResult> {
    return executeBounce(threadId, { refreshMode: 'mini-window' });
  }

  async function performRefresh(
    threadId: string,
    waitForGrowth: boolean,
    forceRemount: boolean
  ): Promise<void> {
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
      const result = forceRemount ? await executeHardRefresh(threadId) : await executeBounce(threadId);
      lastRefreshAt = now();
      if (result.ok && !forceRemount) {
        startLiveRefreshWatcher(threadId);
      }
    } finally {
      refreshing = false;
      if (queuedAfterCurrent && pendingThreadId && !disposed) {
        queuedAfterCurrent = false;
        scheduleRefresh(pendingThreadId, {
          forceRemount: pendingRefreshForceRemount,
          waitForGrowth: pendingRefreshShouldWaitForGrowth
        });
      }
    }
  }

  function scheduleRefresh(threadId: string, options: ThreadRefreshOptions = {}): void {
    if (disposed) {
      return;
    }
    pendingThreadId = threadId;
    if (options.waitForGrowth === false) {
      pendingRefreshShouldWaitForGrowth = false;
    }
    if (options.forceRemount) {
      pendingRefreshForceRemount = true;
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
    const wait = options.immediate ? 0 : Math.max(debounceMs, refreshThrottleMs - elapsed);

    debounceTimer = setTimeoutFn(() => {
      debounceTimer = undefined;
      const target = pendingThreadId;
      if (!target) {
        return;
      }
      const waitForGrowth = pendingRefreshShouldWaitForGrowth;
      const forceRemount = pendingRefreshForceRemount;
      pendingThreadId = null;
      pendingRefreshShouldWaitForGrowth = true;
      pendingRefreshForceRemount = false;
      void performRefresh(target, waitForGrowth, forceRemount);
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
    if (platform === 'win32') {
      return openWindowsDeepLink(targetUrl);
    }

    if (platform !== 'darwin') {
      return openGenericDeepLink(targetUrl);
    }

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
              : 'Could not open Codex on this computer.'
        };
      }
    }
  }

  async function executeIsCodexFrontmost(): Promise<boolean> {
    if (platform !== 'darwin') {
      return false;
    }

    try {
      await run('osascript', [
        '-e',
        'tell application "System Events"',
        '-e',
        'set frontmostBundleId to bundle identifier of first application process whose frontmost is true',
        '-e',
        `if frontmostBundleId is not "${appleScriptString(bundleId)}" then error "Codex is not frontmost" number 1`,
        '-e',
        'end tell'
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async function openWindowsDeepLink(targetUrl: string): Promise<ThreadOpenResult> {
    try {
      await run('cmd.exe', ['/c', 'start', '', targetUrl]);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not open Codex on Windows.'
      };
    }
  }

  async function openGenericDeepLink(targetUrl: string): Promise<ThreadOpenResult> {
    try {
      await run('xdg-open', [targetUrl]);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not open Codex.'
      };
    }
  }

  return {
    async openThread(
      threadId: string,
      options: ThreadOpenOptions = {}
    ): Promise<ThreadOpenResult> {
      return executeBounce(threadId, options);
    },
    async revealThread(threadId: string): Promise<ThreadOpenResult> {
      return executeReveal(threadId);
    },
    refreshDesktop(threadId: string, options: ThreadRefreshOptions = {}): void {
      if (!threadId) {
        return;
      }
      scheduleRefresh(threadId, options);
    },
    isCodexFrontmost(): Promise<boolean> {
      return executeIsCodexFrontmost();
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
      pendingRefreshForceRemount = false;
    }
  };
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
