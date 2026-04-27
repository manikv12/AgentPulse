import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type Project,
  type Thread,
  type ThreadStatus,
  type ThreadUsage,
  ProjectSchema,
  ThreadSchema,
  ThreadUsageSchema,
  resolveThreadStatus
} from '@agent-pulse/shared';

const execFileAsync = promisify(execFile);

export type SqliteThreadRow = {
  id: string;
  title: string;
  cwd: string;
  source?: string;
  updated_at_ms: number;
  archived: number;
  rollout_path: string;
  model?: string;
};

export type CodexThreadReaderOptions = {
  codexHome?: string;
  globalStatePath?: string;
  now?: () => Date;
  maxThreads?: number;
  maxIdleThreadsPerProject?: number;
  recentlyActiveMs?: number;
  liveSignalTtlMs?: number;
};

export type CodexSidebarState = {
  savedWorkspaceRoots: string[];
  activeWorkspaceRoots: string[];
  projectlessThreadIds: Set<string>;
  projectOrder: string[];
  threadWorkspaceRootHints: Record<string, string>;
};

type VisibleThreadEntry = {
  row: SqliteThreadRow;
  workspaceRoot: string;
  thread: Thread;
};

export class CodexThreadReader {
  private readonly codexHome: string;
  private readonly globalStatePath: string;
  private readonly now: () => Date;
  private readonly maxThreads: number;
  private readonly maxIdleThreadsPerProject: number;
  private readonly recentlyActiveMs: number;
  private readonly liveSignalTtlMs: number;

  constructor(options: CodexThreadReaderOptions = {}) {
    this.codexHome = options.codexHome ?? path.join(homedir(), '.codex');
    this.globalStatePath = options.globalStatePath ?? path.join(this.codexHome, '.codex-global-state.json');
    this.now = options.now ?? (() => new Date());
    this.maxThreads = options.maxThreads ?? 5_000;
    this.maxIdleThreadsPerProject = options.maxIdleThreadsPerProject ?? 5;
    this.recentlyActiveMs = options.recentlyActiveMs ?? 2 * 60 * 1000;
    this.liveSignalTtlMs = options.liveSignalTtlMs ?? 30 * 60 * 1000;
  }

  async listThreads(): Promise<Thread[]> {
    const { entries } = await this.readVisibleThreadEntries();
    return limitCodexSidebarHistory(entries.map(({ thread }) => thread), this.maxIdleThreadsPerProject);
  }

  async listProjects(): Promise<Project[]> {
    const { sidebarState, entries } = await this.readVisibleThreadEntries();
    const candidates = [
      ...orderedCodexSidebarProjectRoots(sidebarState),
      ...entries.map(({ workspaceRoot }) => workspaceRoot)
    ];
    const seen = new Set<string>();
    const projects: Project[] = [];

    for (const candidate of candidates) {
      const normalized = normalizeWorkspacePath(candidate);
      if (!path.isAbsolute(normalized) || normalized === 'Unknown workspace' || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      projects.push(ProjectSchema.parse({
        projectId: projectIdForPath(normalized),
        name: workspaceNameFromCwd(normalized),
        path: normalized
      }));
    }

    return projects;
  }

  private async readSqliteRows(): Promise<SqliteThreadRow[]> {
    const dbPath = path.join(this.codexHome, 'state_5.sqlite');
    const query = `
      select id, substr(coalesce(title, ''), 1, 240) as title, cwd, source, updated_at_ms, archived, rollout_path, model
      from threads
      where archived = 0
        and (source is null or source in ('vscode', 'cli', 'exec', 'appServer', 'unknown'))
      order by updated_at_ms desc
      limit ${this.maxThreads};
    `;

    try {
      const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, query], {
        maxBuffer: 16 * 1024 * 1024
      });
      const rows = JSON.parse(stdout || '[]') as SqliteThreadRow[];
      return rows;
    } catch {
      return this.readSessionIndexFallback();
    }
  }

  private async readSessionIndexFallback(): Promise<SqliteThreadRow[]> {
    const indexPath = path.join(this.codexHome, 'session_index.jsonl');

    try {
      const content = await readFile(indexPath, 'utf8');
      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-this.maxThreads)
        .reverse()
        .map((line): SqliteThreadRow | undefined => {
          try {
            const parsed = JSON.parse(line) as {
              id: string;
              thread_name?: string;
              updated_at?: string;
            };
            return {
              id: parsed.id,
              title: parsed.thread_name || 'Untitled thread',
              cwd: 'Unknown workspace',
              source: 'unknown',
              updated_at_ms: parsed.updated_at ? Date.parse(parsed.updated_at) : Date.now(),
              archived: 0,
              rollout_path: ''
            };
          } catch {
            return undefined;
          }
        })
        .filter((row): row is SqliteThreadRow => Boolean(row));
    } catch {
      return [];
    }
  }

  private async readSignalsForRow(row: SqliteThreadRow): Promise<ThreadStatus[]> {
    if (!row.rollout_path) {
      return [];
    }

    try {
      return readRolloutSignals(await readLastLines(row.rollout_path, 80));
    } catch {
      return ['connection'];
    }
  }

  private async readSidebarState(): Promise<CodexSidebarState> {
    try {
      return parseCodexSidebarState(await readFile(this.globalStatePath, 'utf8'));
    } catch {
      return emptyCodexSidebarState();
    }
  }

  private async readVisibleThreadEntries(): Promise<{
    sidebarState: CodexSidebarState;
    entries: VisibleThreadEntry[];
  }> {
    const sidebarState = await this.readSidebarState();
    const rows = await this.readSqliteRows();
    const entries = await Promise.all(
      rows.map(async (row) => {
        const workspaceRoot = resolveThreadWorkspaceRoot(row, sidebarState);
        const baseThread = mapSqliteThreadRow(row, workspaceRoot);
        const rolloutSignals = isLiveStatusFresh(row.updated_at_ms, this.now(), this.liveSignalTtlMs)
          ? await this.readSignalsForRow(row)
          : [];
        const status = resolveThreadStatus([baseThread.status, ...rolloutSignals]);

        return {
          row,
          workspaceRoot,
          thread: ThreadSchema.parse({
            ...baseThread,
            status
          })
        } satisfies VisibleThreadEntry;
      })
    );

    return {
      sidebarState,
      entries: entries.filter(({ row, workspaceRoot, thread }) =>
        shouldShowInCodexSidebarProjects(
          {
            id: row.id,
            cwd: workspaceRoot
          },
          thread.status,
          sidebarState
        )
      )
    };
  }
}

export function isLiveStatusFresh(updatedAtMs: number, now: Date, maxAgeMs: number): boolean {
  return now.getTime() - updatedAtMs <= maxAgeMs;
}

export function shouldShowInCodexSidebarProjects(
  row: Pick<SqliteThreadRow, 'id' | 'cwd'>,
  status: ThreadStatus,
  sidebarState: CodexSidebarState
): boolean {
  if (status !== 'idle' && status !== 'unknown') {
    return true;
  }

  if (
    sidebarState.savedWorkspaceRoots.length === 0 &&
    sidebarState.activeWorkspaceRoots.length === 0 &&
    sidebarState.projectlessThreadIds.size === 0
  ) {
    return true;
  }

  if (sidebarState.projectlessThreadIds.has(row.id)) {
    return false;
  }

  const cwd = normalizeWorkspacePath(row.cwd);
  const sidebarRoots = orderedCodexSidebarProjectRoots(sidebarState);
  return sidebarRoots.some((root) => isPathInside(root, cwd));
}

export function orderedCodexSidebarProjectRoots(sidebarState: CodexSidebarState): string[] {
  const seen = new Set<string>();
  const orderedRoots: string[] = [];

  for (const candidate of [
    ...sidebarState.projectOrder,
    ...sidebarState.activeWorkspaceRoots,
    ...sidebarState.savedWorkspaceRoots
  ]) {
    const normalized = normalizeWorkspacePath(candidate);
    if (!path.isAbsolute(normalized) || normalized === 'Unknown workspace' || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    orderedRoots.push(normalized);
  }

  return orderedRoots;
}

export function limitCodexSidebarHistory(
  threads: Thread[],
  maxIdleThreadsPerProject: number
): Thread[] {
  const idleCounts = new Map<string, number>();

  return threads.filter((thread) => {
    if (thread.status !== 'idle' && thread.status !== 'unknown') {
      return true;
    }

    const count = idleCounts.get(thread.workspace) ?? 0;
    if (count >= maxIdleThreadsPerProject) {
      return false;
    }

    idleCounts.set(thread.workspace, count + 1);
    return true;
  });
}

export function isUserFacingThreadSource(source: string | undefined): boolean {
  return !source || ['vscode', 'cli', 'exec', 'appServer', 'unknown'].includes(source);
}

export function mapSqliteThreadRow(row: SqliteThreadRow, workspaceRoot = row.cwd): Thread {
  return ThreadSchema.parse({
    threadId: row.id,
    title: row.title || 'Untitled thread',
    workspace: workspaceNameFromCwd(workspaceRoot),
    status: 'idle',
    lastActivityAt: new Date(row.updated_at_ms).toISOString(),
    lastTurnSummary: '',
    ...(row.model ? { model: row.model } : {})
  });
}

export function resolveThreadWorkspaceRoot(
  row: Pick<SqliteThreadRow, 'id' | 'cwd'>,
  sidebarState: CodexSidebarState
): string {
  const hintedRoot = sidebarState.threadWorkspaceRootHints[row.id];
  if (hintedRoot) {
    return normalizeWorkspacePath(hintedRoot);
  }

  const cwd = normalizeWorkspacePath(row.cwd);
  const matchingSidebarRoot = orderedCodexSidebarProjectRoots(sidebarState).find((root) =>
    isPathInside(root, cwd)
  );
  return matchingSidebarRoot ?? cwd;
}

export function readRolloutSignals(lines: string[]): ThreadStatus[] {
  const signals = new Set<ThreadStatus>();
  const lastCompletionIndex = lastIndexWhere(lines, isTaskCompleteLine);

  for (const line of lines.slice(lastCompletionIndex + 1)) {
    const event = parseRolloutLine(line);
    const normalized = line.toLowerCase();

    if (isWaitingApprovalLine(event, normalized)) {
      signals.add('waiting_approval');
    }

    if (isTaskStartedLine(event) || isTurnActivityLine(event)) {
      signals.add('running');
    }

    if (isSuccessfulCommandLine(event)) {
      signals.delete('error');
    }

    if (isErrorLine(event, normalized)) {
      signals.add('error');
    }
  }

  return [...signals];
}

function lastIndexWhere(values: string[], predicate: (value: string) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) {
      return index;
    }
  }

  return -1;
}

type RolloutEvent = {
  type?: string;
  message?: string;
  status?: string;
  exit_code?: number;
  payload?: {
    type?: string;
    status?: string;
    exit_code?: number;
    message?: string;
    turn_id?: string;
    payload?: {
      type?: string;
      status?: string;
      exit_code?: number;
    };
  };
};

function parseRolloutLine(line: string): RolloutEvent | undefined {
  try {
    return JSON.parse(line) as RolloutEvent;
  } catch {
    return undefined;
  }
}

function isTaskCompleteLine(line: string): boolean {
  const event = parseRolloutLine(line);
  return event?.type === 'task_complete' || event?.payload?.type === 'task_complete';
}

function isTaskStartedLine(event: RolloutEvent | undefined): boolean {
  return event?.type === 'task_started' || event?.payload?.type === 'task_started';
}

function isTurnActivityLine(event: RolloutEvent | undefined): boolean {
  return Boolean(
    event?.payload?.turn_id &&
      event.payload.type !== 'task_complete' &&
      event.payload.type !== 'token_count'
  );
}

function isWaitingApprovalLine(event: RolloutEvent | undefined, normalized: string): boolean {
  const payloadType = event?.payload?.type ?? event?.payload?.payload?.type;
  const message = (event?.payload?.message ?? event?.message ?? '').toLowerCase();

  return (
    payloadType === 'mcp_tool_call_approval' ||
    payloadType === 'apply_patch_approval' ||
    message.includes('waiting for approval') ||
    normalized.includes('"type":"mcp_tool_call_approval"') ||
    normalized.includes('"type":"apply_patch_approval"')
  );
}

function isSuccessfulCommandLine(event: RolloutEvent | undefined): boolean {
  const payload = event?.payload;
  const status = payload?.status ?? payload?.payload?.status;
  const exitCode = payload?.exit_code ?? payload?.payload?.exit_code;
  return payload?.type === 'exec_command_end' && status === 'completed' && exitCode === 0;
}

function isErrorLine(event: RolloutEvent | undefined, normalized: string): boolean {
  const payload = event?.payload;
  const status = payload?.status ?? payload?.payload?.status;
  const exitCode = payload?.exit_code ?? payload?.payload?.exit_code;

  return (
    event?.type === 'error' ||
    payload?.type === 'error' ||
    normalized.includes('"level":"error"') ||
    (payload?.type === 'exec_command_end' && (status === 'failed' || Number(exitCode) > 0))
  );
}

export async function readUsageFromRollout(rolloutPath: string): Promise<ThreadUsage | undefined> {
  if (!rolloutPath) {
    return undefined;
  }
  let lines: string[];
  try {
    lines = await readLastLines(rolloutPath, 200);
  } catch {
    return undefined;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const usage = parseUsageLine(lines[index]);
    if (usage) {
      return usage;
    }
  }
  return undefined;
}

function parseUsageLine(line: string): ThreadUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const payload = (parsed as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const payloadObj = payload as Record<string, unknown>;
  if (payloadObj.type !== 'token_count') {
    return undefined;
  }
  const info = payloadObj.info as Record<string, unknown> | undefined;
  const total = info?.total_token_usage as Record<string, unknown> | undefined;
  const contextTokens = numberField(total, 'total_tokens');
  const contextWindow = numberField(info, 'model_context_window');
  const contextUsedPercent =
    contextTokens !== undefined && contextWindow && contextWindow > 0
      ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
      : undefined;
  const rateLimits = payloadObj.rate_limits as Record<string, unknown> | undefined;
  const primary = readWindow(rateLimits?.primary);
  const secondary = readWindow(rateLimits?.secondary);
  const planType = stringField(rateLimits, 'plan_type');
  return ThreadUsageSchema.parse({
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextUsedPercent !== undefined ? { contextUsedPercent } : {}),
    ...(primary ? { primaryWindow: primary } : {}),
    ...(secondary ? { secondaryWindow: secondary } : {}),
    ...(planType ? { planType } : {})
  });
}

function readWindow(value: unknown): { usedPercent: number; windowMinutes?: number; resetsAt?: number } | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const usedPercent = numberField(record, 'used_percent');
  if (usedPercent === undefined) {
    return undefined;
  }
  return {
    usedPercent,
    ...(numberField(record, 'window_minutes') !== undefined
      ? { windowMinutes: numberField(record, 'window_minutes') }
      : {}),
    ...(numberField(record, 'resets_at') !== undefined
      ? { resetsAt: numberField(record, 'resets_at') }
      : {})
  };
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export async function readLastLines(
  filePath: string,
  maxLines: number,
  maxBytes = 1024 * 1024
): Promise<string[]> {
  const file = await open(filePath, 'r');

  try {
    const stat = await file.stat();
    let position = stat.size;
    let bytesCollected = 0;
    let lineCount = 0;
    const chunks: Buffer[] = [];
    const chunkSize = 64 * 1024;

    while (position > 0 && lineCount <= maxLines && bytesCollected < maxBytes) {
      const readSize = Math.min(chunkSize, position, maxBytes - bytesCollected);
      position -= readSize;
      bytesCollected += readSize;

      const buffer = Buffer.alloc(readSize);
      await file.read(buffer, 0, readSize, position);
      chunks.unshift(buffer);
      lineCount = Buffer.concat(chunks).toString('utf8').split('\n').length;
    }

    return Buffer.concat(chunks)
      .toString('utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-maxLines);
  } finally {
    await file.close();
  }
}

export function workspaceNameFromCwd(cwd: string): string {
  if (!cwd || cwd === 'Unknown workspace') {
    return 'Unknown workspace';
  }

  return path.basename(path.normalize(cwd)) || cwd;
}

export function parseCodexSidebarState(content: string): CodexSidebarState {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      savedWorkspaceRoots: readStringArray(parsed['electron-saved-workspace-roots']),
      activeWorkspaceRoots: readStringArray(parsed['active-workspace-roots']),
      projectlessThreadIds: new Set(readStringArray(parsed['projectless-thread-ids'])),
      projectOrder: readStringArray(parsed['project-order']),
      threadWorkspaceRootHints: readStringRecord(parsed['thread-workspace-root-hints'])
    };
  } catch {
    return emptyCodexSidebarState();
  }
}

function emptyCodexSidebarState(): CodexSidebarState {
  return {
    savedWorkspaceRoots: [],
    activeWorkspaceRoots: [],
    projectlessThreadIds: new Set(),
    projectOrder: [],
    threadWorkspaceRootHints: {}
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(normalizeWorkspacePath);
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (typeof key !== 'string' || typeof item !== 'string' || item.trim().length === 0) {
        return [];
      }
      return [[key, normalizeWorkspacePath(item)] as const];
    })
  );
}

function normalizeWorkspacePath(value: string): string {
  return path.normalize(value.replace(/^~(?=$|\/)/, homedir()));
}

export function projectIdForPath(value: string): string {
  return createHash('sha256').update(normalizeWorkspacePath(value)).digest('hex').slice(0, 16);
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeWorkspacePath(root);
  const normalizedCandidate = normalizeWorkspacePath(candidate);

  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}
