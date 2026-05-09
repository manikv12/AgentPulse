import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agentPulseDataPath } from './platform/paths';

const LOCK_PATH = agentPulseDataPath('helper.lock');

export type SingleInstanceLockOptions = {
  lockPath?: string;
  processId?: number;
  isProcessAlive?: (pid: number) => boolean;
};

export type SingleInstanceLock = {
  acquired: true;
  release: () => Promise<void>;
};

export type SingleInstanceConflict = {
  acquired: false;
  existingPid: number;
  lockPath: string;
};

export type SingleInstanceResult = SingleInstanceLock | SingleInstanceConflict;

export async function acquireSingleInstanceLock(
  options: SingleInstanceLockOptions = {}
): Promise<SingleInstanceResult> {
  const lockPath = options.lockPath ?? LOCK_PATH;
  const processId = options.processId ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive(processId);

  await mkdir(path.dirname(lockPath), { recursive: true });

  if (await tryWriteExclusive(lockPath, processId)) {
    return makeAcquired(lockPath, processId);
  }

  const existingPid = await readLockPid(lockPath);
  if (isProcessAlive(existingPid)) {
    return { acquired: false, existingPid, lockPath };
  }

  // Stale lock from a crashed or replaced process - clear and retry once.
  try {
    await unlink(lockPath);
  } catch {
    // Someone else may have removed it; the retry below will resolve who wins.
  }

  if (await tryWriteExclusive(lockPath, processId)) {
    return makeAcquired(lockPath, processId);
  }

  const racingPid = await readLockPid(lockPath);
  return { acquired: false, existingPid: racingPid, lockPath };
}

function defaultIsProcessAlive(currentPid: number): (pid: number) => boolean {
  return (pid) => {
    if (!Number.isFinite(pid) || pid <= 0 || pid === currentPid) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but is owned by a different user.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
}

async function tryWriteExclusive(lockPath: string, processId: number): Promise<boolean> {
  try {
    await writeFile(lockPath, String(processId), { flag: 'wx', encoding: 'utf8' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

async function readLockPid(lockPath: string): Promise<number> {
  try {
    const contents = await readFile(lockPath, 'utf8');
    return Number.parseInt(contents.trim(), 10);
  } catch {
    return Number.NaN;
  }
}

function releaseSync(lockPath: string, processId: number): void {
  try {
    const contents = readFileSync(lockPath, 'utf8');
    if (Number.parseInt(contents.trim(), 10) === processId) {
      unlinkSync(lockPath);
    }
  } catch {
    // Lock already gone or unreadable - nothing to do.
  }
}

function makeAcquired(lockPath: string, processId: number): SingleInstanceLock {
  let released = false;

  const onExit = (): void => {
    if (released) return;
    released = true;
    releaseSync(lockPath, processId);
  };

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    process.removeListener('exit', onExit);
    try {
      const contents = await readFile(lockPath, 'utf8');
      if (Number.parseInt(contents.trim(), 10) === processId) {
        await unlink(lockPath);
      }
    } catch {
      // Already removed.
    }
  };

  process.once('exit', onExit);

  return { acquired: true, release };
}

export const SINGLE_INSTANCE_LOCK_PATH = LOCK_PATH;
