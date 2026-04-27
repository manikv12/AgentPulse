import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIpcClient, methodVersion } from './ipc-client';

type Frame = { length: number; body: string };

function readFrames(buffer: Buffer): { frames: Frame[]; remainder: Buffer } {
  const frames: Frame[] = [];
  let cursor = 0;
  while (buffer.length - cursor >= 4) {
    const length = buffer.readUInt32LE(cursor);
    if (buffer.length - cursor - 4 < length) {
      break;
    }
    const body = buffer.subarray(cursor + 4, cursor + 4 + length).toString('utf8');
    frames.push({ length, body });
    cursor += 4 + length;
  }
  return { frames, remainder: buffer.subarray(cursor) };
}

function frame(payload: object): Buffer {
  const json = JSON.stringify(payload);
  const len = Buffer.byteLength(json, 'utf8');
  const out = Buffer.alloc(4 + len);
  out.writeUInt32LE(len, 0);
  out.write(json, 4, 'utf8');
  return out;
}

function pickSocketPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-pulse-ipc-test-'));
  return path.join(dir, 'ipc.sock');
}

let activeServer: net.Server | undefined;
let activeSocket: net.Socket | undefined;
let socketPath = '';
let serverBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
let receivedFrames: Frame[] = [];

beforeEach(() => {
  socketPath = pickSocketPath();
  receivedFrames = [];
  serverBuffer = Buffer.alloc(0);
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }
});

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = undefined;
  }
  activeSocket = undefined;
});

async function startTestServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    activeServer = net.createServer((socket) => {
      activeSocket = socket;
      socket.on('data', (chunk: Buffer) => {
        const merged = Buffer.alloc(serverBuffer.length + chunk.length);
        serverBuffer.copy(merged, 0);
        chunk.copy(merged, serverBuffer.length);
        serverBuffer = merged;
        const { frames, remainder } = readFrames(serverBuffer);
        serverBuffer = remainder;
        receivedFrames.push(...frames);
      });
    });
    activeServer.on('error', reject);
    activeServer.listen(socketPath, () => resolve());
  });
}

function waitForFrame(predicate: (frame: Frame) => boolean, timeoutMs = 1_000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const found = receivedFrames.find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error('timeout waiting for frame'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function writeToClient(payload: object): void {
  if (!activeSocket) {
    throw new Error('No active client socket');
  }
  activeSocket.write(frame(payload));
}

describe('createIpcClient', () => {
  it('exposes versions for known methods and falls back to 0', () => {
    expect(methodVersion('thread-follower-start-turn')).toBe(1);
    expect(methodVersion('thread-stream-state-changed')).toBe(6);
    expect(methodVersion('not-a-real-method')).toBe(0);
  });

  it('connects, initializes, and returns the assigned clientId', async () => {
    await startTestServer();
    const client = createIpcClient({
      socketPath,
      clientType: 'agent-pulse',
      reconnectDelayMs: 50,
      requestTimeoutMs: 1_000
    });
    client.connect();

    const initFrame = await waitForFrame((f) => f.body.includes('"method":"initialize"'));
    const init = JSON.parse(initFrame.body);
    expect(init).toMatchObject({
      type: 'request',
      method: 'initialize',
      params: { clientType: 'agent-pulse' }
    });

    writeToClient({
      type: 'response',
      requestId: init.requestId,
      resultType: 'success',
      method: 'initialize',
      result: { clientId: 'test-client-1' }
    });

    await waitForReady(client);
    expect(client.getClientId()).toBe('test-client-1');
    client.dispose();
  });

  it('routes broadcast events to the matching handler', async () => {
    await startTestServer();
    const client = createIpcClient({
      socketPath,
      clientType: 'agent-pulse',
      reconnectDelayMs: 50,
      requestTimeoutMs: 1_000
    });
    client.connect();

    const initFrame = await waitForFrame((f) => f.body.includes('"method":"initialize"'));
    const init = JSON.parse(initFrame.body);
    writeToClient({
      type: 'response',
      requestId: init.requestId,
      resultType: 'success',
      method: 'initialize',
      result: { clientId: 'test-client-2' }
    });
    await waitForReady(client);

    const received: unknown[] = [];
    client.addBroadcastHandler('thread-stream-state-changed', (event) => {
      received.push(event.params);
    });

    writeToClient({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      sourceClientId: 'desktop',
      version: 6,
      params: { hostId: 'local', conversationId: 'thread-1', change: { isStreaming: true } }
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received).toHaveLength(1);
    client.dispose();
  });

  it('answers client-discovery-request based on the registered handler', async () => {
    await startTestServer();
    const client = createIpcClient({
      socketPath,
      clientType: 'agent-pulse',
      reconnectDelayMs: 50,
      requestTimeoutMs: 1_000
    });
    client.connect();

    const initFrame = await waitForFrame((f) => f.body.includes('"method":"initialize"'));
    const init = JSON.parse(initFrame.body);
    writeToClient({
      type: 'response',
      requestId: init.requestId,
      resultType: 'success',
      method: 'initialize',
      result: { clientId: 'test-client-3' }
    });
    await waitForReady(client);

    client.addRequestHandler(
      'thread-follower-start-turn',
      (request) => {
        const params = (request.params ?? {}) as { conversationId?: string };
        return params.conversationId === 'mine';
      },
      async () => ({ result: { turn: { id: 'turn-1' } } })
    );

    receivedFrames.length = 0;
    writeToClient({
      type: 'client-discovery-request',
      requestId: 'discovery-1',
      request: {
        type: 'request',
        requestId: 'inner-1',
        sourceClientId: 'router',
        version: 1,
        method: 'thread-follower-start-turn',
        params: { conversationId: 'mine', turnStartParams: {} }
      }
    });

    const reply = await waitForFrame((f) => f.body.includes('"client-discovery-response"'));
    expect(JSON.parse(reply.body)).toMatchObject({
      type: 'client-discovery-response',
      requestId: 'discovery-1',
      response: { canHandle: true }
    });

    client.dispose();
  });

  it('rejects client-discovery-request when method version mismatches', async () => {
    await startTestServer();
    const client = createIpcClient({
      socketPath,
      clientType: 'agent-pulse',
      reconnectDelayMs: 50,
      requestTimeoutMs: 1_000
    });
    client.connect();

    const initFrame = await waitForFrame((f) => f.body.includes('"method":"initialize"'));
    const init = JSON.parse(initFrame.body);
    writeToClient({
      type: 'response',
      requestId: init.requestId,
      resultType: 'success',
      method: 'initialize',
      result: { clientId: 'test-client-4' }
    });
    await waitForReady(client);

    client.addRequestHandler(
      'thread-follower-start-turn',
      () => true,
      async () => ({ result: { turn: { id: 'turn' } } })
    );

    receivedFrames.length = 0;
    writeToClient({
      type: 'client-discovery-request',
      requestId: 'discovery-bad-version',
      request: {
        type: 'request',
        requestId: 'inner-1',
        sourceClientId: 'router',
        version: 999,
        method: 'thread-follower-start-turn',
        params: { conversationId: 'mine' }
      }
    });

    const reply = await waitForFrame((f) => f.body.includes('"client-discovery-response"'));
    expect(JSON.parse(reply.body)).toMatchObject({
      requestId: 'discovery-bad-version',
      response: { canHandle: false }
    });
    client.dispose();
  });

  it('sendRequest resolves with the server response result', async () => {
    await startTestServer();
    const client = createIpcClient({
      socketPath,
      clientType: 'agent-pulse',
      reconnectDelayMs: 50,
      requestTimeoutMs: 1_000
    });
    client.connect();

    const initFrame = await waitForFrame((f) => f.body.includes('"method":"initialize"'));
    const init = JSON.parse(initFrame.body);
    writeToClient({
      type: 'response',
      requestId: init.requestId,
      resultType: 'success',
      method: 'initialize',
      result: { clientId: 'test-client-5' }
    });
    await waitForReady(client);

    receivedFrames.length = 0;
    const pending = client.sendRequest<{ result: { turn: { id: string } } }>(
      'thread-follower-start-turn',
      { conversationId: 't1', turnStartParams: { threadId: 't1' } }
    );

    const sent = await waitForFrame((f) => f.body.includes('thread-follower-start-turn'));
    const parsed = JSON.parse(sent.body);
    expect(parsed.method).toBe('thread-follower-start-turn');
    expect(parsed.version).toBe(1);

    writeToClient({
      type: 'response',
      requestId: parsed.requestId,
      resultType: 'success',
      method: 'thread-follower-start-turn',
      result: { result: { turn: { id: 'turn-77' } } }
    });

    const result = await pending;
    expect(result.result.turn.id).toBe('turn-77');
    client.dispose();
  });

  it('sendRequest rejects on error response with the server-provided message', async () => {
    await startTestServer();
    const client = createIpcClient({
      socketPath,
      clientType: 'agent-pulse',
      reconnectDelayMs: 50,
      requestTimeoutMs: 1_000
    });
    client.connect();

    const initFrame = await waitForFrame((f) => f.body.includes('"method":"initialize"'));
    const init = JSON.parse(initFrame.body);
    writeToClient({
      type: 'response',
      requestId: init.requestId,
      resultType: 'success',
      method: 'initialize',
      result: { clientId: 'test-client-6' }
    });
    await waitForReady(client);

    receivedFrames.length = 0;
    const pending = client.sendRequest('thread-follower-start-turn', { conversationId: 'x' });
    const sent = await waitForFrame((f) => f.body.includes('thread-follower-start-turn'));
    const parsed = JSON.parse(sent.body);

    writeToClient({
      type: 'response',
      requestId: parsed.requestId,
      resultType: 'error',
      error: 'no-client-found'
    });

    await expect(pending).rejects.toThrow('no-client-found');
    client.dispose();
  });
});

async function waitForReady(client: ReturnType<typeof createIpcClient>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (client.isReady()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('IPC client never became ready');
}
