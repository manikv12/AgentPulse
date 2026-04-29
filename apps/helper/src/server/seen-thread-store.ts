import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// 14 days. Entries older than this are dropped on every read/write — see the
// note in CodexPulse design discussion. The UI on the tablet uses a shorter
// cutoff (4 days) for hiding the Review chip; this longer window is the data
// safety net so we don't accidentally re-mark threads as unread that the user
// already saw days ago.
const ENTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FILE_VERSION = 1;

export type SeenThreadEntry = {
  seenAt: number;
  lastTouchedAt: number;
};

type SeenThreadFile = {
  version: number;
  entries: Record<string, SeenThreadEntry>;
};

function emptyFile(): SeenThreadFile {
  return { version: FILE_VERSION, entries: {} };
}

export class SeenThreadStore {
  // Cached in-memory copy. We rewrite the disk file on every change but reads
  // are served from this map so the polling loop and HTTP handlers don't hit
  // the disk repeatedly.
  private cache: SeenThreadFile = emptyFile();
  private loaded = false;

  constructor(
    private readonly storePath: string = path.join(
      homedir(),
      'Library',
      'Application Support',
      'Agent Pulse',
      'seen-thread-activity.json'
    ),
    private readonly now: () => number = () => Date.now()
  ) {}

  async load(): Promise<void> {
    try {
      const content = await readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(content) as Partial<SeenThreadFile>;
      this.cache = sanitize(parsed);
    } catch {
      this.cache = emptyFile();
    }
    this.pruneOlderThan(ENTRY_TTL_MS);
    this.loaded = true;
  }

  // Returns a snapshot of the current map. Cheap — callers can call this on
  // every poll tick without worrying about IO.
  getAll(): Record<string, number> {
    this.pruneOlderThan(ENTRY_TTL_MS);
    const out: Record<string, number> = {};
    for (const [threadId, entry] of Object.entries(this.cache.entries)) {
      out[threadId] = entry.seenAt;
    }
    return out;
  }

  async markSeen(threadId: string, seenAt: number): Promise<void> {
    if (!threadId.trim() || !Number.isFinite(seenAt)) {
      return;
    }
    const nowMs = this.now();
    const previous = this.cache.entries[threadId];
    // Never let an older seen-at clobber a fresher one. Two devices could mark
    // the same thread as seen with timestamps a few ms apart; keep the latest.
    const nextSeenAt = previous ? Math.max(previous.seenAt, seenAt) : seenAt;
    this.cache.entries[threadId] = {
      seenAt: nextSeenAt,
      lastTouchedAt: nowMs
    };
    this.pruneOlderThan(ENTRY_TTL_MS);
    await this.persist();
  }

  // Drop entries for threads that no longer exist. Called by the polling loop
  // with the current set of live thread ids.
  async pruneOrphans(liveThreadIds: ReadonlySet<string>): Promise<void> {
    let changed = false;
    for (const threadId of Object.keys(this.cache.entries)) {
      if (!liveThreadIds.has(threadId)) {
        delete this.cache.entries[threadId];
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  // Bulk-import entries from the tablet's legacy localStorage map. Only inserts
  // entries we don't already have, so a tablet syncing for the first time
  // doesn't overwrite a more recent reviewed-on-another-device timestamp.
  async importIfMissing(entries: Record<string, number>): Promise<void> {
    const nowMs = this.now();
    let changed = false;
    for (const [threadId, seenAt] of Object.entries(entries)) {
      if (!threadId.trim() || !Number.isFinite(seenAt)) {
        continue;
      }
      const existing = this.cache.entries[threadId];
      if (existing && existing.seenAt >= seenAt) {
        continue;
      }
      this.cache.entries[threadId] = {
        seenAt,
        lastTouchedAt: nowMs
      };
      changed = true;
    }
    if (changed) {
      this.pruneOlderThan(ENTRY_TTL_MS);
      await this.persist();
    }
  }

  // Visible for tests.
  pruneOlderThan(maxAgeMs: number): void {
    const cutoff = this.now() - maxAgeMs;
    for (const [threadId, entry] of Object.entries(this.cache.entries)) {
      if (entry.lastTouchedAt < cutoff) {
        delete this.cache.entries[threadId];
      }
    }
  }

  private async persist(): Promise<void> {
    if (!this.loaded) {
      return;
    }
    const serialized = `${JSON.stringify(this.cache, null, 2)}\n`;
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(tempPath, serialized, 'utf8');
    await rename(tempPath, this.storePath);
  }
}

function sanitize(raw: Partial<SeenThreadFile>): SeenThreadFile {
  const entries: Record<string, SeenThreadEntry> = {};
  if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
    for (const [threadId, entry] of Object.entries(raw.entries)) {
      if (!threadId.trim() || !entry || typeof entry !== 'object') {
        continue;
      }
      const seenAt = (entry as SeenThreadEntry).seenAt;
      const lastTouchedAt = (entry as SeenThreadEntry).lastTouchedAt;
      if (!Number.isFinite(seenAt) || !Number.isFinite(lastTouchedAt)) {
        continue;
      }
      entries[threadId] = { seenAt, lastTouchedAt };
    }
  }
  return { version: FILE_VERSION, entries };
}
