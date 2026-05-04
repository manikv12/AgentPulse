import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { normalizeSharedChatRoot } from '../chats/shared-chat-paths';

export type RegisterCodexProjectlessChatOptions = {
  globalStatePath?: string;
  chatRoot?: string;
};

const globalStateLocks = new Map<string, Promise<void>>();

export function defaultCodexGlobalStatePath(): string {
  return path.join(homedir(), '.codex', '.codex-global-state.json');
}

export async function registerCodexProjectlessChat(
  threadId: string,
  options: RegisterCodexProjectlessChatOptions = {}
): Promise<void> {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) {
    return;
  }

  await withGlobalStateLock(options.globalStatePath ?? defaultCodexGlobalStatePath(), async (globalStatePath) => {
    const state = await readGlobalState(globalStatePath);
    const projectlessThreadIds = readStringArray(state['projectless-thread-ids']);
    const threadWorkspaceRootHints = readStringRecord(state['thread-workspace-root-hints']);
    const rootHint = normalizeSharedChatRoot(options.chatRoot);

    if (!projectlessThreadIds.includes(normalizedThreadId)) {
      projectlessThreadIds.push(normalizedThreadId);
    }
    threadWorkspaceRootHints[normalizedThreadId] = rootHint;

    state['projectless-thread-ids'] = projectlessThreadIds;
    state['thread-workspace-root-hints'] = threadWorkspaceRootHints;
    await writeGlobalState(globalStatePath, state);
  });
}

async function withGlobalStateLock<T>(
  globalStatePath: string,
  task: (globalStatePath: string) => Promise<T>
): Promise<T> {
  const previous = globalStateLocks.get(globalStatePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = previous.catch(() => undefined).then(() => current);
  globalStateLocks.set(globalStatePath, lock);

  await previous.catch(() => undefined);
  try {
    return await task(globalStatePath);
  } finally {
    release();
    if (globalStateLocks.get(globalStatePath) === lock) {
      globalStateLocks.delete(globalStatePath);
    }
  }
}

async function readGlobalState(globalStatePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(globalStatePath, 'utf8');
    const parsed = parseGlobalStateJson(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    if (error instanceof SyntaxError) {
      const raw = await readFile(globalStatePath, 'utf8').catch(() => '');
      const recovered = parseFirstJsonObject(raw);
      if (recovered) {
        return recovered;
      }
      await writeCorruptGlobalStateBackup(globalStatePath, raw);
      return {};
    }
    throw error;
  }
}

async function writeGlobalState(
  globalStatePath: string,
  state: Record<string, unknown>
): Promise<void> {
  await mkdir(path.dirname(globalStatePath), { recursive: true });
  const tempPath = `${globalStatePath}.agent-pulse-${process.pid}-${Date.now()}-${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tempPath, globalStatePath);
}

function parseGlobalStateJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      const recovered = parseFirstJsonObject(raw);
      if (recovered) {
        return recovered;
      }
    }
    throw error;
  }
}

function parseFirstJsonObject(raw: string): Record<string, unknown> | undefined {
  const start = raw.search(/\S/);
  if (start < 0 || raw[start] !== '{') {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const parsed = JSON.parse(raw.slice(start, index + 1)) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>) }
          : undefined;
      }
    }
  }
  return undefined;
}

async function writeCorruptGlobalStateBackup(globalStatePath: string, raw: string): Promise<void> {
  if (!raw) {
    return;
  }
  const backupPath = `${globalStatePath}.corrupt-${Date.now()}-${randomUUID()}`;
  await writeFile(backupPath, raw, 'utf8').catch(() => undefined);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string' &&
        entry[0].trim().length > 0 &&
        entry[1].trim().length > 0
    )
  );
}
