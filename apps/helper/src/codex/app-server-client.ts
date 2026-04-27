import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import readline from 'node:readline';
import type { CodexAppServerTransport } from './app-server-chat';

const STDERR_RING_LIMIT = 8 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

export type CodexAppServerClientOptions = {
  codexBinary?: string;
  version?: string;
  requestTimeoutMs?: number;
};

export class CodexAppServerClient implements CodexAppServerTransport {
  private process?: ChildProcessWithoutNullStreams;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderrRing = '';

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  recentStderr(): string {
    return this.stderrRing.trim();
  }

  isConnected(): boolean {
    return Boolean(this.process && !this.process.killed && this.initialized);
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    return this.sendRequest<T>(method, params);
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

    const child = spawn(this.codexBinary(), ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process = child;
    this.stderrRing = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const next = this.stderrRing + chunk.toString('utf8');
      this.stderrRing =
        next.length > STDERR_RING_LIMIT ? next.slice(-STDERR_RING_LIMIT) : next;
      console.warn('[codex app-server stderr]', chunk.toString('utf8').trim());
    });
    child.once('exit', (code, signal) => {
      this.initialized = false;
      this.process = undefined;
      const stderr = this.recentStderr();
      const detail = stderr ? ` — codex stderr: ${stderr}` : '';
      const reason = `Codex App Server disconnected (code=${code ?? 'null'}, signal=${signal ?? 'null'})${detail}`;
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
  }

  private codexBinary(): string {
    if (this.options.codexBinary) {
      return this.options.codexBinary;
    }

    const bundled = '/Applications/Codex.app/Contents/Resources/codex';
    return existsSync(bundled) ? bundled : 'codex';
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
          // Force restart on next request: subprocess is hung.
          try {
            this.process?.kill();
          } catch {
            // ignore
          }
          this.process = undefined;
          this.initialized = false;
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
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
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
}
