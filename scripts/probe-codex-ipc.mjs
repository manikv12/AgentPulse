#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const methodVersions = {
  initialize: 0,
  'thread-stream-state-changed': 6,
  'thread-read-state-changed': 1,
  'thread-archived': 2,
  'thread-unarchived': 1,
  'thread-queued-followups-changed': 1
};

function defaultIpcSocketPath() {
  const dir = path.join(tmpdir(), 'codex-ipc');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return path.join(dir, uid ? `ipc-${uid}.sock` : 'ipc.sock');
}

function frame(payload) {
  const json = JSON.stringify(payload);
  const out = Buffer.alloc(4 + Buffer.byteLength(json));
  out.writeUInt32LE(Buffer.byteLength(json), 0);
  out.write(json, 4, 'utf8');
  return out;
}

function compact(value, max = 1200) {
  const json = JSON.stringify(value);
  return json.length > max ? `${json.slice(0, max)}...` : json;
}

function activeItemCountFromState(state) {
  const turns = Array.isArray(state?.turns) ? state.turns : [];
  return turns
    .flatMap((turn) => (Array.isArray(turn.items) ? turn.items : []))
    .filter((item) => item && typeof item === 'object' && item.status === 'inProgress')
    .length;
}

function patchSummary(change) {
  const patches = Array.isArray(change?.patches) ? change.patches : [];
  return patches.map((patch) => ({
    op: patch.op,
    path: Array.isArray(patch.path) ? patch.path.join('.') : undefined,
    type: patch.value?.type,
    status: patch.value?.status,
    turnStatus: patch.value?.status,
    output: typeof patch.value?.aggregatedOutput === 'string' ? patch.value.aggregatedOutput.length : undefined
  }));
}

const args = new Map(
  process.argv.slice(2).flatMap((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  })
);

const socketPath = args.get('socket') || defaultIpcSocketPath();
const seconds = Number(args.get('seconds') || 20);
const all = args.get('all') === '1' || args.get('all') === 'true';
const startedAt = Date.now();
const clientId = 'initializing-client';
const stateByThread = new Map();

console.log(`[probe] connecting to ${socketPath}`);
console.log(`[probe] watching Codex desktop IPC for ${seconds}s`);

let buffer = Buffer.alloc(0);
let pendingFrameLength = null;

const socket = net.connect(socketPath, () => {
  socket.write(
    frame({
      type: 'request',
      requestId: randomUUID(),
      sourceClientId: clientId,
      version: methodVersions.initialize,
      method: 'initialize',
      params: { clientType: 'agent-pulse-probe' }
    })
  );
});

socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (pendingFrameLength === null) {
      if (buffer.length < 4) return;
      pendingFrameLength = buffer.readUInt32LE(0);
      buffer = buffer.subarray(4);
    }
    if (buffer.length < pendingFrameLength) return;
    const body = buffer.subarray(0, pendingFrameLength);
    buffer = buffer.subarray(pendingFrameLength);
    pendingFrameLength = null;

    let message;
    try {
      message = JSON.parse(body.toString('utf8'));
    } catch {
      continue;
    }

    if (message.type === 'response' && message.method === 'initialize') {
      console.log(`[probe] initialized as ${message.result?.clientId ?? '(unknown)'}`);
      continue;
    }

    if (message.type !== 'broadcast') {
      continue;
    }

    const params = message.params || {};
    const change = params.change || {};
    const conversationId = typeof params.conversationId === 'string' ? params.conversationId : undefined;
    const isInteresting =
      message.method === 'thread-stream-state-changed' ||
      message.method === 'thread-read-state-changed' ||
      message.method === 'thread-queued-followups-changed';

    if (!all && !isInteresting) {
      return;
    }

    const state = conversationId
      ? {
          method: message.method,
          hostId: typeof params.hostId === 'string' ? params.hostId : undefined,
          changeType: change.type,
          isStreaming:
            typeof change.isStreaming === 'boolean' ? change.isStreaming : undefined,
          role: change.streamRole?.role,
          sendState: change.conversationState?.sendState,
          activeTurnId: change.conversationState?.activeTurnId,
          activeItems: activeItemCountFromState(change.conversationState),
          patches: change.type === 'patches' ? patchSummary(change) : undefined,
          model:
            change.conversationState?.latestModel ||
            change.latestModel ||
            change.latestCollaborationMode?.settings?.model,
          reasoningEffort:
            change.conversationState?.latestReasoningEffort ||
            change.latestReasoningEffort ||
            change.latestCollaborationMode?.settings?.reasoning_effort
        }
      : { method: message.method };

    if (conversationId) {
      stateByThread.set(conversationId, { ...stateByThread.get(conversationId), ...state });
    }

    console.log(`[probe] ${new Date().toISOString()} ${compact(state)}`);
    if (all || !conversationId) {
      console.log(`[probe:raw] ${compact(message.params)}`);
    }
  }
});

socket.on('error', (error) => {
  console.error(`[probe] IPC error: ${error.message}`);
  process.exitCode = 1;
});

socket.on('close', () => {
  console.log('[probe] socket closed');
});

setTimeout(() => {
  console.log('[probe] summary');
  for (const [threadId, state] of stateByThread) {
    console.log(`[probe] ${threadId} ${compact(state)}`);
  }
  socket.destroy();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[probe] done after ${elapsed}s`);
}, seconds * 1000);
