import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireSingleInstanceLock } from './single-instance';

describe('acquireSingleInstanceLock', () => {
  it('blocks a second helper while the first helper pid is alive', async () => {
    const lockPath = await tempLockPath();
    const first = await acquireSingleInstanceLock({ lockPath, processId: 111 });
    expect(first.acquired).toBe(true);

    try {
      const second = await acquireSingleInstanceLock({
        lockPath,
        processId: 222,
        isProcessAlive: (pid) => pid === 111
      });

      expect(second).toEqual({ acquired: false, existingPid: 111, lockPath });
      await expect(readFile(lockPath, 'utf8')).resolves.toBe('111');
    } finally {
      if (first.acquired) {
        await first.release();
      }
    }
  });

  it('clears a stale lock and lets the new helper start', async () => {
    const lockPath = await tempLockPath();
    const stale = await acquireSingleInstanceLock({ lockPath, processId: 111 });
    expect(stale.acquired).toBe(true);

    const next = await acquireSingleInstanceLock({
      lockPath,
      processId: 222,
      isProcessAlive: () => false
    });

    try {
      expect(next.acquired).toBe(true);
      await expect(readFile(lockPath, 'utf8')).resolves.toBe('222');
    } finally {
      if (stale.acquired) {
        await stale.release();
      }
      if (next.acquired) {
        await next.release();
      }
    }
  });

  it('removes its own lock file when released', async () => {
    const lockPath = await tempLockPath();
    const lock = await acquireSingleInstanceLock({ lockPath, processId: 111 });
    expect(lock.acquired).toBe(true);

    if (lock.acquired) {
      await lock.release();
    }

    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function tempLockPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-pulse-lock-'));
  return path.join(dir, 'helper.lock');
}
