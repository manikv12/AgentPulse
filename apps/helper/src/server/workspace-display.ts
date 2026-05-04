import { access } from 'node:fs/promises';
import path from 'node:path';
import { ProjectSchema, ThreadSchema, type Project, type Thread } from '@agent-pulse/shared';
import { isSharedChatPath } from '../chats/shared-chat-paths';

export class WorkspaceDisplayRootResolver {
  private readonly cache = new Map<string, Promise<string>>();

  async resolve(workspacePath: string): Promise<string> {
    const normalizedPath = path.normalize(workspacePath);
    if (!path.isAbsolute(normalizedPath)) {
      return normalizedPath;
    }

    const cached = this.cache.get(normalizedPath);
    if (cached) {
      return cached;
    }

    const pending = findGitWorkspaceRoot(normalizedPath).then((gitRoot) => gitRoot ?? normalizedPath);
    this.cache.set(normalizedPath, pending);
    return pending;
  }
}

export async function normalizeThreadForWorkspaceDisplay(
  thread: Thread,
  resolver: WorkspaceDisplayRootResolver,
  chatRoot?: string
): Promise<Thread> {
  if (
    !thread.workspacePath ||
    thread.workspaceKind === 'chat' ||
    isSharedChatPath(thread.workspacePath, chatRoot)
  ) {
    return thread;
  }

  const displayPath = await resolver.resolve(thread.workspacePath);
  if (displayPath === thread.workspacePath) {
    return thread;
  }

  return ThreadSchema.parse({
    ...thread,
    workspace: path.basename(displayPath) || thread.workspace,
    workspacePath: displayPath
  });
}

export async function normalizeThreadsForWorkspaceDisplay(
  threads: Thread[],
  resolver: WorkspaceDisplayRootResolver,
  chatRoot?: string
): Promise<Thread[]> {
  return Promise.all(
    threads.map((thread) => normalizeThreadForWorkspaceDisplay(thread, resolver, chatRoot))
  );
}

export async function normalizeProjectForWorkspaceDisplay(
  project: Project,
  resolver: WorkspaceDisplayRootResolver,
  chatRoot?: string
): Promise<Project> {
  if (isSharedChatPath(project.path, chatRoot)) {
    return project;
  }

  const displayPath = await resolver.resolve(project.path);
  if (displayPath === project.path) {
    return project;
  }

  return ProjectSchema.parse({
    ...project,
    name: path.basename(displayPath) || project.name,
    path: displayPath
  });
}

export async function normalizeProjectsForWorkspaceDisplay(
  projects: Project[],
  resolver: WorkspaceDisplayRootResolver,
  chatRoot?: string
): Promise<Project[]> {
  return Promise.all(
    projects.map((project) => normalizeProjectForWorkspaceDisplay(project, resolver, chatRoot))
  );
}

async function findGitWorkspaceRoot(workspacePath: string): Promise<string | undefined> {
  let currentPath = path.normalize(workspacePath);

  while (true) {
    if (await hasGitMarker(currentPath)) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }

    currentPath = parentPath;
  }
}

async function hasGitMarker(workspacePath: string): Promise<boolean> {
  try {
    await access(path.join(workspacePath, '.git'));
    return true;
  } catch {
    return false;
  }
}
