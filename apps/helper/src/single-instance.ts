import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const LOCK_PATH = path.join(
  homedir(),
  'Library',
  'Application Support',
  'Agent Pulse',
  'helper.lock'
);

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

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by a different user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function tryWriteExclusive(): Promise<boolean> {
  try {
    await writeFile(LOCK_PATH, String(process.pid), { flag: 'wx', encoding: 'utf8' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

async function readLockPid(): Promise<number> {
  try {
    const contents = await readFile(LOCK_PATH, 'utf8');
    return Number.parseInt(contents.trim(), 10);
  } catch {
    return Number.NaN;
  }
}

function releaseSync(): void {
  try {
    const contents = readFileSync(LOCK_PATH, 'utf8');
    if (Number.parseInt(contents.trim(), 10) === process.pid) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    // Lock already gone or unreadable — nothing to do.
  }
}

export async function acquireSingleInstanceLock(): Promise<SingleInstanceResult> {
  await mkdir(path.dirname(LOCK_PATH), { recursive: true });

  if (await tryWriteExclusive()) {
    return makeAcquired();
  }

  const existingPid = await readLockPid();
  if (isProcessAlive(existingPid)) {
    return { acquired: false, existingPid, lockPath: LOCK_PATH };
  }

  // Stale lock from a crashed or replaced process — clear and retry once.
  try {
    await unlink(LOCK_PATH);
  } catch {
    // Someone else may have removed it; the retry below will resolve who wins.
  }

  if (await tryWriteExclusive()) {
    return makeAcquired();
  }

  const racingPid = await readLockPid();
  return { acquired: false, existingPid: racingPid, lockPath: LOCK_PATH };
}

function makeAcquired(): SingleInstanceLock {
  let released = false;

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      const contents = await readFile(LOCK_PATH, 'utf8');
      if (Number.parseInt(contents.trim(), 10) === process.pid) {
        await unlink(LOCK_PATH);
      }
    } catch {
      // Already removed.
    }
  };

  const onExit = (): void => {
    if (released) return;
    released = true;
    releaseSync();
  };
  process.once('exit', onExit);

  return { acquired: true, release };
}

export const SINGLE_INSTANCE_LOCK_PATH = LOCK_PATH;
