import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { debugEnabled } from '../debug';
import type { CodexAppServerTransport } from './app-server-chat';

const STDERR_RING_LIMIT = 8 * 1024;
// Codex can spend tens of seconds scanning very large session histories before
// responding to `thread/read` etc. Killing the subprocess on a 30s timeout was
// pegging the CPU in a spawn-and-kill loop on machines with big ~/.codex/sessions
// (e.g. 10GB+). Give individual requests a generous ceiling instead.
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const AUTH_ERROR_TEXT_PATTERNS = [
  '403 Forbidden',
  '401 Unauthorized',
  'token expired',
  'invalid token',
  'authentication failed'
];
const NOISY_STDERR_PATTERNS = [
  'unknown feature key in config:',
  'skipping duplicate plugin MCP server name',
  'configured curated plugin no longer exists in curated marketplace during cache refresh',
  'ignoring interface.defaultPrompt:',
  'slow statement: execution time exceeded alert threshold',
  'acquired connection was held longer than slow threshold',
  'acquired connection, but time to acquire exceeded slow threshold',
  'thread/resume overrides ignored for running thread',
  'resuming session with different model',
  'failed to delete old shell snapshots',
  'Failed to delete shell snapshot at',
  'dropping overload response for connection',
  'overwriting handler for tool'
];
const NOISY_REMOTE_CONTROL_PATTERN =
  'remote control server enrollment failed at `https://chatgpt.com/backend-api/wham/remote/control/server/enroll`: HTTP 404 Not Found';
const NOISY_CHATGPT_AUTH_ENDPOINT_MARKERS = [
  'backend-api/codex/responses',
  'backend-api/plugins/featured',
  'backend-api/codex/analytics-events/events'
];

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type JsonRpcResponse = {
  id?: number | string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

export type CodexAppServerNotification = {
  method: string;
  params?: unknown;
};

export type CodexAppServerServerRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

export type CodexAppServerClientOptions = {
  codexBinary?: string;
  version?: string;
  requestTimeoutMs?: number;
};

export type ResolveCodexBinaryOptions = {
  codexBinary?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  exists?: (filePath: string) => boolean;
};

export class CodexAppServerClient implements CodexAppServerTransport {
  private process?: ChildProcessWithoutNullStreams;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<
    (notification: CodexAppServerNotification) => void
  >();
  private readonly serverRequestListeners = new Set<
    (request: CodexAppServerServerRequest) => void
  >();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private stderrRing = '';
  // De-duplicates concurrent `ensureStarted` calls. Keep a single in-flight promise so we
  // end up with at most one subprocess.
  private startPromise?: Promise<void>;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  recentStderr(): string {
    return this.stderrRing.trim();
  }

  isConnected(): boolean {
    return Boolean(this.process && !this.process.killed && this.initialized);
  }

  async ensureConnected(): Promise<void> {
    await this.ensureStarted();
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    return this.sendRequest<T>(method, params);
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: CodexAppServerServerRequest) => void): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  async respondToServerRequest(id: number | string, result: unknown): Promise<void> {
    const child = this.process;
    if (!child) {
      throw new Error('Codex App Server is not running.');
    }
    child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }

    child.kill();
    this.process = undefined;
    this.initialized = false;
  }

  private async ensureStarted(): Promise<void> {
    if (this.isConnected()) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startSubprocess().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startSubprocess(): Promise<void> {
    const codexBinary = this.codexBinary();
    const child = spawn(codexBinary, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });
    this.process = child;
    this.stderrRing = '';
    console.warn(
      `[codex app-server] spawned pid=${child.pid ?? 'unknown'} binary=${codexBinary}`
    );
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const next = this.stderrRing + text;
      this.stderrRing =
        next.length > STDERR_RING_LIMIT ? next.slice(-STDERR_RING_LIMIT) : next;
      for (const line of codexStderrLinesForLog(text, { debug: debugEnabled })) {
        console.warn('[codex app-server stderr]', line);
      }
    });
    child.once('exit', (code, signal) => {
      this.initialized = false;
      this.process = undefined;
      this.emitConnectionChange(false);
      const stderr = this.recentStderr();
      const detail = stderr ? ` — codex stderr: ${stderr}` : '';
      const reason = `Codex App Server disconnected (code=${code ?? 'null'}, signal=${signal ?? 'null'})${detail}`;
      // Always log the exit so we can tell whether it died on its own (with
      // stderr / non-zero code) or was killed externally (signal=SIGTERM and
      // no stderr means something else sent the signal — possibly the desktop
      // claiming exclusivity, or our own timeout-kill at app-server-client.ts:182).
      console.warn(
        `[codex app-server] exited pid=${child.pid ?? 'unknown'} code=${code ?? 'null'} signal=${signal ?? 'null'} pendingRequests=${this.pending.size}${detail}`
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      this.pending.clear();
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));

    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'agent_pulse',
        title: 'Agent Pulse',
        version: this.options.version ?? '0.1.0'
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.sendNotification('initialized', {});
    this.initialized = true;
    this.emitConnectionChange(true);
  }

  private codexBinary(): string {
    return resolveCodexBinary({ codexBinary: this.options.codexBinary });
  }

  private sendRequest<T>(method: string, params: unknown): Promise<T> {
    const child = this.process;
    if (!child) {
      return Promise.reject(new Error('Codex App Server is not running.'));
    }

    const id = this.nextId++;
    const message = { method, id, params };
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          const stderr = this.recentStderr();
          const detail = stderr ? ` — codex stderr: ${stderr}` : '';
          const error = new Error(
            `Codex App Server timed out after ${timeoutMs}ms on ${method}${detail}`
          );
          // Fail just this one request — don't kill the whole subprocess.
          // On machines with large ~/.codex/sessions, a slow `thread/read`
          // used to trigger a kill-and-respawn loop that pegged the CPU.
          console.warn(
            `[codex app-server] request timed out pid=${this.process?.pid ?? 'unknown'} after ${timeoutMs}ms on ${method}`
          );
          reject(error);
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (writeError) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(writeError instanceof Error ? writeError : new Error(String(writeError)));
      }
    });
  }

  private sendNotification(method: string, params: unknown): void {
    this.process?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse & {
      method?: unknown;
      params?: unknown;
    };
    try {
      message = JSON.parse(line) as JsonRpcResponse & {
        method?: unknown;
        params?: unknown;
      };
    } catch {
      return;
    }

    if (typeof message.method === 'string') {
      if (typeof message.id === 'number' || typeof message.id === 'string') {
        this.emitServerRequest({
          id: message.id,
          method: message.method,
          params: message.params
        });
        return;
      }
      this.emitNotification({
        method: message.method,
        params: message.params
      });
      return;
    }

    if (typeof message.id !== 'number') {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'Codex App Server request failed.'));
      return;
    }

    pending.resolve(message.result);
  }

  private emitNotification(notification: CodexAppServerNotification): void {
    for (const listener of this.notificationListeners) {
      try {
        listener(notification);
      } catch (error) {
        console.warn('[codex app-server] notification listener failed', {
          method: notification.method,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private emitServerRequest(request: CodexAppServerServerRequest): void {
    for (const listener of this.serverRequestListeners) {
      try {
        listener(request);
      } catch (error) {
        console.warn('[codex app-server] server request listener failed', {
          method: request.method,
          id: request.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private emitConnectionChange(connected: boolean): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(connected);
      } catch (error) {
        console.warn('[codex app-server] connection listener failed', {
          connected,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}

export function resolveCodexBinary(options: ResolveCodexBinaryOptions = {}): string {
  if (options.codexBinary) {
    return options.codexBinary;
  }

  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;

  if (platform === 'darwin') {
    const bundled = '/Applications/Codex.app/Contents/Resources/codex';
    if (exists(bundled)) {
      return bundled;
    }
  }

  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  for (const candidate of collectCodexBinaryCandidates({ platform, env, homeDir: home })) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  return platform === 'win32' ? 'codex.cmd' : 'codex';
}

function collectCodexBinaryCandidates(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): string[] {
  const pathCandidates = (options.env.PATH ?? '')
    .split(pathListDelimiter(options.platform))
    .filter(Boolean)
    .flatMap((dir) =>
      options.platform === 'win32'
        ? [path.join(dir, 'codex.cmd'), path.join(dir, 'codex.exe'), path.join(dir, 'codex')]
        : [path.join(dir, 'codex')]
    );

  if (options.platform !== 'win32') {
    return pathCandidates;
  }

  return [
    ...pathCandidates,
    path.join(options.homeDir, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
    path.join(options.homeDir, 'AppData', 'Roaming', 'npm', 'codex.exe')
  ];
}

function pathListDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : path.delimiter;
}

export function codexStderrLinesForLog(
  text: string,
  options: { debug?: boolean } = {}
): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => options.debug || !isNoisyCodexStderrLine(line));
}

function isNoisyCodexStderrLine(line: string): boolean {
  if (line.includes(NOISY_REMOTE_CONTROL_PATTERN)) {
    return true;
  }
  if (isBackgroundChatgptAuthLine(line)) {
    return true;
  }
  return NOISY_STDERR_PATTERNS.some((pattern) => line.includes(pattern));
}

function isBackgroundChatgptAuthLine(line: string): boolean {
  return (
    NOISY_CHATGPT_AUTH_ENDPOINT_MARKERS.some((marker) => line.includes(marker)) &&
    AUTH_ERROR_TEXT_PATTERNS.some((pattern) => line.includes(pattern))
  );
}
