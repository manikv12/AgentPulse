import { stat } from 'node:fs/promises';

export type RolloutWatcherEvent =
  | { type: 'found'; rolloutPath: string }
  | { type: 'growth'; rolloutPath: string; previousSize: number; nextSize: number }
  | { type: 'idle'; rolloutPath: string }
  | { type: 'lookup_timeout' }
  | { type: 'stopped' };

export type RolloutWatcherOptions = {
  rolloutPath: string;
  intervalMs?: number;
  lookupTimeoutMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  statFile?: (path: string) => Promise<{ size: number }>;
  onEvent: (event: RolloutWatcherEvent) => void;
};

export type RolloutWatcher = {
  stop(): void;
};

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

export function watchRolloutFile(options: RolloutWatcherOptions): RolloutWatcher {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const lookupTimeoutMs = options.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const statFile = options.statFile ?? (async (filePath: string) => await stat(filePath));

  const startedAt = now();
  let lastGrowthAt = startedAt;
  let lastSize: number | null = null;
  let foundFile = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const emit = (event: RolloutWatcherEvent): void => {
    if (stopped) {
      return;
    }
    options.onEvent(event);
  };

  const stop = (reason: RolloutWatcherEvent | null = null): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (reason) {
      options.onEvent(reason);
    }
    options.onEvent({ type: 'stopped' });
  };

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    try {
      const result = await statFile(options.rolloutPath);
      const currentSize = result.size;

      if (!foundFile) {
        foundFile = true;
        emit({ type: 'found', rolloutPath: options.rolloutPath });
      }

      if (lastSize === null) {
        lastSize = currentSize;
        lastGrowthAt = now();
      } else if (currentSize > lastSize) {
        const previousSize = lastSize;
        lastSize = currentSize;
        lastGrowthAt = now();
        emit({ type: 'growth', rolloutPath: options.rolloutPath, previousSize, nextSize: currentSize });
      } else if (now() - lastGrowthAt >= idleTimeoutMs) {
        stop({ type: 'idle', rolloutPath: options.rolloutPath });
        return;
      }
    } catch {
      if (!foundFile && now() - startedAt >= lookupTimeoutMs) {
        stop({ type: 'lookup_timeout' });
        return;
      }
    }

    if (!stopped) {
      timer = setTimeout(() => {
        void tick();
      }, intervalMs);
    }
  };

  timer = setTimeout(() => {
    void tick();
  }, 0);

  return {
    stop() {
      stop();
    }
  };
}
