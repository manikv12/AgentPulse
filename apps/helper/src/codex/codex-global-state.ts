import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { normalizeSharedChatRoot } from '../chats/shared-chat-paths';

export type RegisterCodexProjectlessChatOptions = {
  globalStatePath?: string;
  chatRoot?: string;
};

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

  const globalStatePath = options.globalStatePath ?? defaultCodexGlobalStatePath();
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
}

async function readGlobalState(globalStatePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(globalStatePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
  const tempPath = `${globalStatePath}.agent-pulse-${process.pid}-${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tempPath, globalStatePath);
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
