import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const MAX_BUFFER_BYTES = 512 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const RECONNECT_DELAY_MS = 1_000;
const INITIALIZING_CLIENT_ID = 'initializing-client';

const METHOD_VERSIONS: Record<string, number> = {
  'thread-stream-state-changed': 6,
  'thread-read-state-changed': 1,
  'thread-archived': 2,
  'thread-unarchived': 1,
  'thread-queued-followups-changed': 1,
  'thread-follower-start-turn': 1,
  'thread-follower-compact-thread': 1,
  'thread-follower-steer-turn': 1,
  'thread-follower-interrupt-turn': 1,
  'thread-follower-set-model-and-reasoning': 1,
  'thread-follower-set-collaboration-mode': 1,
  'thread-follower-edit-last-user-turn': 1,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
  'thread-follower-submit-user-input': 1,
  'thread-follower-submit-mcp-server-elicitation-response': 1,
  'thread-follower-set-queued-follow-ups-state': 1
};

export function methodVersion(method: string): number {
  return METHOD_VERSIONS[method] ?? 0;
}

export function defaultIpcSocketPath(): string {
  if (process.platform === 'win32') {
    return path.join('\\\\.\\pipe', 'codex-ipc');
  }
  const dir = path.join(tmpdir(), 'codex-ipc');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return path.join(dir, uid ? `ipc-${uid}.sock` : 'ipc.sock');
}

type RequestEnvelope = {
  type: 'request';
  requestId: string;
  sourceClientId: string;
  version: number;
  method: string;
  params: unknown;
  targetClientId?: string;
};

type ResponseEnvelope = {
  type: 'response';
  requestId: string;
  resultType: 'success' | 'error';
  method?: string;
  handledByClientId?: string;
  result?: unknown;
  error?: string;
};

type BroadcastEnvelope = {
  type: 'broadcast';
  method: string;
  sourceClientId: string;
  version: number;
  params: unknown;
};

type ClientDiscoveryRequestEnvelope = {
  type: 'client-discovery-request';
  requestId: string;
  request: RequestEnvelope;
};

type ClientDiscoveryResponseEnvelope = {
  type: 'client-discovery-response';
  requestId: string;
  response: { canHandle: boolean };
};

type IncomingMessage =
  | RequestEnvelope
  | ResponseEnvelope
  | BroadcastEnvelope
  | ClientDiscoveryRequestEnvelope
  | ClientDiscoveryResponseEnvelope;

export type BroadcastHandler = (event: BroadcastEnvelope) => void | Promise<void>;
export type RequestHandler<T = unknown> = (params: unknown) => Promise<T> | T;
export type DiscoveryHandler = (request: RequestEnvelope) => Promise<boolean> | boolean;

export type IpcClientOptions = {
  socketPath?: string;
  clientType: string;
  reconnectDelayMs?: number;
  requestTimeoutMs?: number;
  logger?: {
    debug?: (message: string, extra?: unknown) => void;
    info?: (message: string, extra?: unknown) => void;
    warn?: (message: string, extra?: unknown) => void;
  };
  netConnect?: typeof net.connect;
};

export type IpcClient = {
  connect(): void;
  dispose(): void;
  isReady(): boolean;
  getClientId(): string | undefined;
  sendRequest<T = unknown>(method: string, params: unknown, options?: { targetClientId?: string }): Promise<T>;
  sendBroadcast(method: string, params: unknown): void;
  addBroadcastHandler(method: string, handler: BroadcastHandler): () => void;
  addAnyBroadcastHandler(handler: BroadcastHandler): () => void;
  addRequestHandler<T = unknown>(
    method: string,
    discoveryHandler: DiscoveryHandler,
    requestHandler: RequestHandler<T>
  ): () => void;
};

export function createIpcClient(options: IpcClientOptions): IpcClient {
  const socketPath = options.socketPath ?? defaultIpcSocketPath();
  const clientType = options.clientType;
  const reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const log = options.logger ?? {};
  const netConnect = options.netConnect ?? net.connect;

  let socket: net.Socket | undefined;
  let buffer = Buffer.alloc(0);
  let pendingFrameLength: number | null = null;
  let clientId: string = INITIALIZING_CLIENT_ID;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const pendingResponses = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const broadcastHandlers = new Map<string, BroadcastHandler>();
  const anyBroadcastHandlers = new Set<BroadcastHandler>();
  const requestHandlers = new Map<
    string,
    { discovery: DiscoveryHandler; handler: RequestHandler }
  >();

  function frame(payload: object): Buffer {
    const json = JSON.stringify(payload);
    const len = Buffer.byteLength(json, 'utf8');
    if (len > MAX_FRAME_BYTES) {
      throw new Error('IPC frame exceeds size limit');
    }
    const out = Buffer.alloc(4 + len);
    out.writeUInt32LE(len, 0);
    out.write(json, 4, 'utf8');
    return out;
  }

  function writeMessage(payload: object): void {
    if (!socket || !socket.writable) {
      throw new Error('not-connected');
    }
    socket.write(frame(payload));
  }

  function handleData(chunk: Buffer): void {
    if (buffer.length + chunk.length > MAX_BUFFER_BYTES) {
      log.warn?.('IPC buffer exceeded limit; resetting socket', {
        bufferLength: buffer.length,
        chunkLength: chunk.length
      });
      destroySocket();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (pendingFrameLength === null) {
        if (buffer.length < 4) {
          return;
        }
        pendingFrameLength = buffer.readUInt32LE(0);
        buffer = buffer.subarray(4);
        if (pendingFrameLength > MAX_FRAME_BYTES) {
          log.warn?.('IPC frame exceeds limit; closing socket');
          destroySocket();
          return;
        }
      }

      if (buffer.length < pendingFrameLength) {
        return;
      }

      const slice = buffer.subarray(0, pendingFrameLength);
      buffer = buffer.subarray(pendingFrameLength);
      pendingFrameLength = null;

      let parsed: IncomingMessage;
      try {
        parsed = JSON.parse(slice.toString('utf8')) as IncomingMessage;
      } catch (error) {
        log.warn?.('Failed to parse IPC frame', { error });
        continue;
      }

      void handleMessage(parsed);
    }
  }

  async function handleMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'response': {
        const pending = pendingResponses.get(message.requestId);
        if (!pending) {
          return;
        }
        pendingResponses.delete(message.requestId);
        clearTimeout(pending.timer);
        if (
          message.resultType === 'success' &&
          message.method === 'initialize' &&
          message.result &&
          typeof (message.result as { clientId?: unknown }).clientId === 'string'
        ) {
          clientId = (message.result as { clientId: string }).clientId;
          log.debug?.('IPC client initialized', { clientId, clientType });
        }
        if (message.resultType === 'success') {
          pending.resolve(message.result);
        } else {
          // Codex's follower IPC sometimes rejects with a structured object
          // rather than a string. new Error(<object>) produces an Error with
          // message "[object Object]", which masks the real cause. Stringify
          // it so the message at least carries the JSON, then preserve the
          // raw payload on a `cause` property for callers that want to inspect.
          const rawError = message.error;
          let errorMessage: string;
          if (typeof rawError === 'string') {
            errorMessage = rawError;
          } else if (rawError === undefined || rawError === null) {
            errorMessage = 'ipc-error';
          } else {
            try {
              errorMessage = JSON.stringify(rawError);
            } catch {
              errorMessage = String(rawError);
            }
          }
          const wrapped = new Error(errorMessage);
          if (rawError && typeof rawError === 'object') {
            (wrapped as Error & { cause?: unknown }).cause = rawError;
          }
          pending.reject(wrapped);
        }
        return;
      }
      case 'broadcast': {
        const handler = broadcastHandlers.get(message.method);
        const fanouts = [...anyBroadcastHandlers].map((h) => Promise.resolve(h(message)));
        if (handler) {
          fanouts.push(Promise.resolve(handler(message)));
        }
        await Promise.all(fanouts).catch((error) => {
          log.warn?.('Broadcast handler threw', { method: message.method, error });
        });
        return;
      }
      case 'client-discovery-request': {
        const inner = message.request;
        const expectedVersion = methodVersion(inner.method);
        if ((inner.version ?? 0) !== expectedVersion) {
          writeMessage({
            type: 'client-discovery-response',
            requestId: message.requestId,
            response: { canHandle: false }
          });
          return;
        }
        const entry = requestHandlers.get(inner.method);
        if (!entry) {
          writeMessage({
            type: 'client-discovery-response',
            requestId: message.requestId,
            response: { canHandle: false }
          });
          return;
        }
        let canHandle = false;
        try {
          canHandle = await entry.discovery(inner);
        } catch (error) {
          log.warn?.('Discovery handler threw', { method: inner.method, error });
        }
        writeMessage({
          type: 'client-discovery-response',
          requestId: message.requestId,
          response: { canHandle }
        });
        return;
      }
      case 'request': {
        const expectedVersion = methodVersion(message.method);
        if ((message.version ?? 0) !== expectedVersion) {
          writeMessage({
            type: 'response',
            requestId: message.requestId,
            resultType: 'error',
            error: 'request-version-mismatch'
          });
          return;
        }
        const entry = requestHandlers.get(message.method);
        if (!entry) {
          writeMessage({
            type: 'response',
            requestId: message.requestId,
            resultType: 'error',
            error: 'no-handler-for-request'
          });
          return;
        }
        try {
          const result = await entry.handler(message.params);
          writeMessage({
            type: 'response',
            requestId: message.requestId,
            resultType: 'success',
            method: message.method,
            handledByClientId: clientId,
            result
          });
        } catch (error) {
          writeMessage({
            type: 'response',
            requestId: message.requestId,
            resultType: 'error',
            error: error instanceof Error ? error.message : 'error-handling-request'
          });
        }
        return;
      }
      default:
        return;
    }
  }

  function destroySocket(): void {
    if (!socket) {
      return;
    }
    try {
      socket.destroy();
    } catch {
      // ignore
    }
    socket = undefined;
    buffer = Buffer.alloc(0);
    pendingFrameLength = null;
  }

  function rejectAllPending(reason: string): void {
    for (const [, pending] of pendingResponses) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    pendingResponses.clear();
  }

  function scheduleReconnect(): void {
    if (disposed) {
      return;
    }
    if (reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectDelayMs);
  }

  function connect(): void {
    if (disposed || socket) {
      return;
    }

    const next = netConnect(socketPath, () => {
      log.debug?.('IPC connected', { socketPath, clientType });
      sendInitialize();
    });
    socket = next;

    next.on('data', handleData);
    next.on('error', (error) => {
      log.debug?.('IPC socket error', { error });
    });
    next.on('close', () => {
      log.debug?.('IPC socket closed', { clientType });
      socket = undefined;
      buffer = Buffer.alloc(0);
      pendingFrameLength = null;
      clientId = INITIALIZING_CLIENT_ID;
      rejectAllPending('connection-closed');
      scheduleReconnect();
    });
  }

  function sendInitialize(): void {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pendingResponses.delete(requestId);
      log.warn?.('IPC initialize timed out');
      destroySocket();
    }, requestTimeoutMs);
    pendingResponses.set(requestId, {
      resolve: () => undefined,
      reject: () => undefined,
      timer
    });
    try {
      writeMessage({
        type: 'request',
        requestId,
        sourceClientId: INITIALIZING_CLIENT_ID,
        version: methodVersion('initialize'),
        method: 'initialize',
        params: { clientType }
      });
    } catch (error) {
      clearTimeout(timer);
      pendingResponses.delete(requestId);
      log.warn?.('IPC initialize write failed', { error });
      destroySocket();
    }
  }

  return {
    connect,
    dispose() {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      rejectAllPending('disposed');
      broadcastHandlers.clear();
      anyBroadcastHandlers.clear();
      requestHandlers.clear();
      destroySocket();
    },
    isReady() {
      return Boolean(socket && socket.writable && clientId !== INITIALIZING_CLIENT_ID);
    },
    getClientId() {
      return clientId === INITIALIZING_CLIENT_ID ? undefined : clientId;
    },
    sendRequest<T = unknown>(
      method: string,
      params: unknown,
      requestOptions: { targetClientId?: string } = {}
    ): Promise<T> {
      if (!socket || !socket.writable) {
        return Promise.reject(new Error('not-connected'));
      }
      if (clientId === INITIALIZING_CLIENT_ID && method !== 'initialize') {
        return Promise.reject(new Error('not-initialized'));
      }
      const requestId = randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResponses.delete(requestId);
          reject(new Error('timeout'));
        }, requestTimeoutMs);
        pendingResponses.set(requestId, {
          resolve: (value) => resolve(value as T),
          reject,
          timer
        });
        try {
          writeMessage({
            type: 'request',
            requestId,
            sourceClientId: clientId,
            version: methodVersion(method),
            method,
            params,
            targetClientId: requestOptions.targetClientId
          });
        } catch (error) {
          clearTimeout(timer);
          pendingResponses.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    sendBroadcast(method: string, params: unknown): void {
      if (!socket || !socket.writable) {
        throw new Error('not-connected');
      }
      writeMessage({
        type: 'broadcast',
        method,
        sourceClientId: clientId,
        version: methodVersion(method),
        params
      });
    },
    addBroadcastHandler(method, handler) {
      broadcastHandlers.set(method, handler);
      return () => {
        if (broadcastHandlers.get(method) === handler) {
          broadcastHandlers.delete(method);
        }
      };
    },
    addAnyBroadcastHandler(handler) {
      anyBroadcastHandlers.add(handler);
      return () => {
        anyBroadcastHandlers.delete(handler);
      };
    },
    addRequestHandler(method, discoveryHandler, requestHandler) {
      requestHandlers.set(method, {
        discovery: discoveryHandler,
        handler: requestHandler as RequestHandler
      });
      return () => {
        const entry = requestHandlers.get(method);
        if (entry && entry.handler === (requestHandler as RequestHandler)) {
          requestHandlers.delete(method);
        }
      };
    }
  };
}

// Exposed for tests that need to clean up stale socket files.
export function unlinkSocketIfExists(socketPath: string): void {
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore
    }
  }
}
