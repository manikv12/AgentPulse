import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerChat, SendBlockedError, type CodexAppServerTransport } from './app-server-chat';

type RequestCall = {
  method: string;
  params: unknown;
};

describe('Codex App Server same-thread chat', () => {
  it('starts a new turn inside the existing idle thread without creating a thread', async () => {
    const transport = fakeTransport([
      threadResponse('thread-1', 'idle', []),
      threadResponse('thread-1', 'active', [turn('turn-new', 'inProgress')])
    ]);
    const chat = new CodexAppServerChat(transport);

    const result = await chat.sendMessage('thread-1', 'Continue from my phone.');

    expect(result.mode).toBe('start');
    expect(result.turnId).toBe('turn-new');
    expect(transport.calls.map((call) => call.method)).toEqual([
      'thread/resume',
      'thread/turns/list',
      'turn/start',
      'thread/resume',
      'thread/turns/list'
    ]);
    expect(transport.calls.some((call) => call.method === 'thread/start')).toBe(false);
    expect(transport.calls[2]?.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Continue from my phone.', text_elements: [] }]
    });
  });

  it('steers the active turn when the existing thread is already running', async () => {
    const transport = fakeTransport([
      threadResponse('thread-1', 'active', [turn('turn-live', 'inProgress')]),
      threadResponse('thread-1', 'active', [turn('turn-live', 'inProgress')])
    ]);
    const chat = new CodexAppServerChat(transport);

    const result = await chat.sendMessage('thread-1', 'Use this extra context.');

    expect(result.mode).toBe('steer');
    expect(result.turnId).toBe('turn-live');
    expect(transport.calls.map((call) => call.method)).toEqual([
      'thread/resume',
      'thread/turns/list',
      'turn/steer',
      'thread/resume',
      'thread/turns/list'
    ]);
    expect(transport.calls[2]?.params).toMatchObject({
      threadId: 'thread-1',
      expectedTurnId: 'turn-live',
      input: [{ type: 'text', text: 'Use this extra context.', text_elements: [] }]
    });
  });

  it('blocks mobile sends when Codex is waiting for approval on the Mac', async () => {
    const transport = fakeTransport([
      threadResponse('thread-1', 'active', [turn('turn-live', 'inProgress')], ['waitingOnApproval'])
    ]);
    const chat = new CodexAppServerChat(transport);

    await expect(chat.sendMessage('thread-1', 'Approve it.')).rejects.toMatchObject({
      reason: 'waiting_on_approval'
    });
    expect(transport.calls.map((call) => call.method)).toEqual(['thread/resume', 'thread/turns/list']);
  });

  it('refreshes once and retries steer when the active turn changed', async () => {
    const transport = fakeTransport([
      threadResponse('thread-1', 'active', [turn('turn-old', 'inProgress')]),
      new Error('expected turn id mismatch'),
      threadResponse('thread-1', 'active', [turn('turn-new', 'inProgress')]),
      threadResponse('thread-1', 'active', [turn('turn-new', 'inProgress')])
    ]);
    const chat = new CodexAppServerChat(transport);

    const result = await chat.sendMessage('thread-1', 'Newest context.');

    expect(result.mode).toBe('steer');
    expect(result.turnId).toBe('turn-new');
    expect(transport.calls.map((call) => call.method)).toEqual([
      'thread/resume',
      'thread/turns/list',
      'turn/steer',
      'thread/resume',
      'thread/turns/list',
      'turn/steer',
      'thread/resume',
      'thread/turns/list'
    ]);
  });

  it('maps App Server thread items into a phone transcript', async () => {
    const transport = fakeTransport([
      threadResponse('thread-1', 'idle', [
        {
          ...turn('turn-1', 'completed'),
          items: [
            {
              type: 'userMessage',
              id: 'user-1',
              content: [{ type: 'text', text: 'Can you check this?', text_elements: [] }]
            },
            {
              type: 'agentMessage',
              id: 'assistant-1',
              text: 'I checked it.',
              phase: null,
              memoryCitation: null
            },
            {
              type: 'commandExecution',
              id: 'cmd-1',
              command: 'pnpm test',
              cwd: '/tmp/project',
              processId: null,
              source: 'agent',
              status: 'completed',
              commandActions: [],
              aggregatedOutput: null,
              exitCode: 0,
              durationMs: 1200
            }
          ]
        }
      ])
    ]);
    const chat = new CodexAppServerChat(transport);

    const transcript = await chat.readTranscript('thread-1');

    expect(transcript.sendState.reason).toBe('ready');
    expect(transcript.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'Can you check this?' }),
      expect.objectContaining({ role: 'assistant', text: 'I checked it.' }),
      expect.objectContaining({ role: 'activity', kind: 'command', text: 'pnpm test' })
    ]);
  });

  it('keeps screenshots from user messages and tool calls in the transcript', async () => {
    const userScreenshot = 'data:image/png;base64,user-image';
    const toolScreenshot = 'data:image/png;base64,tool-image';
    const localScreenshot = '/Users/me/Pictures/screenshot.png';
    const transport = fakeTransport([
      threadResponse('thread-1', 'idle', [
        {
          ...turn('turn-1', 'completed'),
          items: [
            {
              type: 'userMessage',
              id: 'user-1',
              content: [
                { type: 'input_text', text: 'Please inspect this screenshot.', text_elements: [] },
                { type: 'input_image', image_url: { url: userScreenshot } },
                { type: 'localImage', path: localScreenshot }
              ]
            },
            {
              type: 'mcpToolCall',
              id: 'tool-1',
              server: 'browser',
              tool: 'screenshot',
              status: 'completed',
              result: {
                content: [
                  {
                    type: 'image_url',
                    image_url: { url: toolScreenshot },
                    alt: 'Browser screenshot'
                  }
                ]
              }
            }
          ]
        }
      ])
    ]);
    const chat = new CodexAppServerChat(transport);

    const transcript = await chat.readTranscript('thread-1');

    expect(transcript.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        text: 'Please inspect this screenshot.',
        attachments: [
          expect.objectContaining({
            kind: 'image',
            url: userScreenshot
          }),
          expect.objectContaining({
            kind: 'image',
            sourcePath: localScreenshot
          })
        ]
      }),
      expect.objectContaining({
        id: 'tool-1',
        role: 'activity',
        kind: 'tool',
        attachments: [
          expect.objectContaining({
            kind: 'image',
            url: toolScreenshot,
            alt: 'Browser screenshot'
          })
        ]
      })
    ]);
  });

  it('loads an empty new thread when recent turns are not available yet', async () => {
    const calls: RequestCall[] = [];
    const transport: CodexAppServerTransport = {
      isConnected: () => true,
      request: async <T = unknown>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === 'thread/resume') {
          return threadResponse('thread-empty', 'idle', []).thread
            ? (threadResponse('thread-empty', 'idle', []) as T)
            : (undefined as T);
        }
        if (method === 'thread/turns/list') {
          throw new Error('No turns are available yet.');
        }
        throw new Error(`Unexpected method ${method}`);
      }
    };
    const chat = new CodexAppServerChat(transport);

    const transcript = await chat.readTranscript('thread-empty');

    expect(transcript.threadId).toBe('thread-empty');
    expect(transcript.messages).toEqual([]);
    expect(transcript.sendState.reason).toBe('ready');
    expect(calls.map((call) => call.method)).toEqual(['thread/resume', 'thread/turns/list']);
  });

  it('uses a typed blocked error for unavailable active turns', async () => {
    const error = new SendBlockedError('missing_active_turn', 'Codex is running but Agent Pulse cannot find the active turn.');
    expect(error.reason).toBe('missing_active_turn');
    expect(error.message).toContain('active turn');
  });

  it('keeps Codex marked working when the app-server is active but the latest turn list has no in-progress turn', async () => {
    const olderTurn = { ...turn('turn-old', 'completed'), startedAt: 1_777_000_000, completedAt: 1_777_000_010 };
    const commandTurn = { ...turn('turn-command', 'completed'), startedAt: 1_777_000_500, completedAt: 1_777_000_510 };
    const transport = fakeTransport([
      threadResponse('thread-1', 'active', [olderTurn, commandTurn])
    ]);
    const chat = new CodexAppServerChat(transport);

    const transcript = await chat.readTranscript('thread-1');

    expect(transcript.activeTurnId).toBe('app-server-active:thread-1');
    expect(transcript.sendState.canSend).toBe(false);
    expect(transcript.sendState.reason).toBe('missing_active_turn');
    expect(transcript.sendState.label).toBe('Codex is working');
  });

  it('can read full thread history for older-message paging', async () => {
    const turns = Array.from({ length: 14 }, (_, index) => ({
      ...turn(`turn-${index + 1}`, 'completed'),
      startedAt: 1_777_000_000 + index,
      completedAt: 1_777_000_100 + index,
      items: [
        {
          type: 'agentMessage',
          id: `assistant-${index + 1}`,
          text: `Message ${index + 1}`,
          phase: null
        }
      ]
    }));
    const transport = fakeTransport([
      threadResponse('thread-1', 'idle', turns)
    ]);
    const chat = new CodexAppServerChat(transport);

    const transcript = await chat.readFullTranscript('thread-1');

    expect(transport.calls.map((call) => call.method)).toEqual(['thread/read']);
    expect(transport.calls[0]?.params).toEqual({ threadId: 'thread-1', includeTurns: true });
    expect(transcript.messages).toHaveLength(14);
    expect(transcript.messages[0]).toMatchObject({ id: 'assistant-1', text: 'Message 1' });
    expect(transcript.messages[13]).toMatchObject({ id: 'assistant-14', text: 'Message 14' });
  });
});

function fakeTransport(results: unknown[]): CodexAppServerTransport & { calls: RequestCall[] } {
  const calls: RequestCall[] = [];
  let latestThread: Record<string, unknown> | undefined;
  const request = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === 'thread/turns/list') {
      return {
        data: (latestThread?.turns as unknown[]) ?? [],
        nextCursor: null,
        backwardsCursor: null
      };
    }
    if (method === 'turn/start') {
      return { turn: turn('turn-new', 'inProgress') };
    }
    if (method === 'turn/steer') {
      const result = results.shift();
      if (result instanceof Error) {
        throw result;
      }
      if (result) {
        results.unshift(result);
      }
      return { turnId: (params as { expectedTurnId: string }).expectedTurnId };
    }
    const result = results.shift();
    if (result instanceof Error) {
      throw result;
    }
    if (
      result &&
      typeof result === 'object' &&
      'thread' in result &&
      result.thread &&
      typeof result.thread === 'object'
    ) {
      latestThread = result.thread as Record<string, unknown>;
    }
    return result;
  });

  return {
    calls,
    isConnected: () => true,
    request: async <T = unknown>(method: string, params: unknown) => request(method, params) as Promise<T>
  };
}

function threadResponse(
  threadId: string,
  status: 'idle' | 'active',
  turns: Array<Record<string, unknown>>,
  activeFlags: string[] = []
) {
  return {
    thread: {
      id: threadId,
      status: status === 'idle' ? { type: 'idle' } : { type: 'active', activeFlags },
      turns,
      preview: '',
      forkedFromId: null,
      ephemeral: false,
      modelProvider: 'openai',
      createdAt: 1_777_000_000,
      updatedAt: 1_777_000_100,
      path: null,
      cwd: '/tmp/project',
      cliVersion: '0.0.0',
      source: 'app-server',
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: 'Existing thread'
    }
  };
}

function turn(id: string, status: 'completed' | 'inProgress') {
  return {
    id,
    status,
    error: null,
    items: [],
    startedAt: 1_777_000_000,
    completedAt: status === 'completed' ? 1_777_000_100 : null,
    durationMs: status === 'completed' ? 1000 : null
  };
}
