import { mkdtemp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  ThreadSchema,
  type AgentProvider,
  type Project,
  type Thread
} from '@agent-pulse/shared';
import { agentPulseDataPath } from '../platform/paths';

export const SHARED_CHAT_WORKSPACE = 'Chats';

export function defaultSharedChatRoot(): string {
  return agentPulseDataPath('Chats');
}

export function normalizeSharedChatRoot(chatRoot?: string): string {
  const root = chatRoot?.trim() || defaultSharedChatRoot();
  return path.normalize(root.replace(/^~(?=$|\/)/, homedir()));
}

export function sharedChatProviderRoot(provider: AgentProvider, chatRoot?: string): string {
  return path.join(normalizeSharedChatRoot(chatRoot), provider);
}

export async function createSharedChatCwd(
  provider: AgentProvider,
  chatRoot?: string,
  now = new Date()
): Promise<string> {
  const providerRoot = sharedChatProviderRoot(provider, chatRoot);
  await mkdir(providerRoot, { recursive: true });
  return mkdtemp(path.join(providerRoot, `${dateSlug(now)}-`));
}

export function isSharedChatPath(candidate: string | undefined, chatRoot?: string): boolean {
  if (!candidate?.trim()) {
    return false;
  }

  const normalized = path.normalize(candidate.trim());
  if (!path.isAbsolute(normalized)) {
    return false;
  }

  const root = normalizeSharedChatRoot(chatRoot);
  const relative = path.relative(root, normalized);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isHomeWorkspacePath(candidate: string | undefined): boolean {
  if (!candidate?.trim()) {
    return false;
  }

  return path.normalize(candidate.trim()) === path.normalize(homedir());
}

export function decorateSharedChatThread(thread: Thread, chatRoot?: string): Thread {
  if (!isSharedChatPath(thread.workspacePath, chatRoot) && !isHomeWorkspacePath(thread.workspacePath)) {
    return ThreadSchema.parse(thread);
  }

  return ThreadSchema.parse({
    ...thread,
    workspace: SHARED_CHAT_WORKSPACE,
    workspaceKind: 'chat'
  });
}

export function decorateSharedChatThreads(threads: Thread[], chatRoot?: string): Thread[] {
  return threads.map((thread) => decorateSharedChatThread(thread, chatRoot));
}

export function filterSharedChatProjects(projects: Project[], chatRoot?: string): Project[] {
  return projects.filter(
    (project) => !isSharedChatPath(project.path, chatRoot) && !isHomeWorkspacePath(project.path)
  );
}

function dateSlug(date: Date): string {
  return date.toISOString().slice(0, 10);
}
