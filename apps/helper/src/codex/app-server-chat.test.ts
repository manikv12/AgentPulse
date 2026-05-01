import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerChat, SendBlockedError, type CodexAppServerTransport } from './app-server-chat';

type RequestCall = {
  method: string;
  params: unknown;
};

describe('Codex App Server same-thread chat', () => {
  it('tracks app-server notifications as live thread state', () => {
    const transport = eventTransport();
    const chat = new CodexAppServerChat(transport);
    const liveEvents: unknown[] = [];
    const liveStateChanges: string[] = [];
    chat.onLiveEvent((event) => liveEvents.push(event));
    chat.onLiveStateChange((threadId) => liveStateChanges.push(threadId));

    transport.emitNotification({
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: turn('turn-1', 'inProgress')
      }
    });
    transport.emitNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-live-1',
        delta: 'Hello live'
      }
    });

    const visible = chat.applyLiveState(emptyTranscript('thread-1'), 'thread-1');

    expect(chat.isThreadStreaming('thread-1')).toBe(true);
    expect(visible.activeTurnId).toBe('turn-1');
    expect(visible.sendState).toMatchObject({
      canSend: false,
      reason: 'thread_changed',
      label: 'Codex is working'
    });
    expect(visible.messages).toEqual([
      expect.objectContaining({
        id: 'assistant-live-1',
        role: 'assistant',
        kind: 'message',
        text: 'Hello live'
      })
    ]);
    expect(liveEvents).toContainEqual({
      type: 'thread/streaming-changed',
      payload: { threadId: 'thread-1', isStreaming: true }
    });
    expect(liveStateChanges).toContain('thread-1');
  });

  it('emits app-server turn completion events with the completed turn id', () => {
    const transport = eventTransport();
    const chat = new CodexAppServerChat(transport);
    const completedTurns: unknown[] = [];
    chat.onTurnCompleted((event) => completedTurns.push(event));

    transport.emitNotification({
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: turn('turn-1', 'inProgress')
      }
    });
    transport.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: turn('turn-1', 'completed')
      }
    });

    expect(completedTurns).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    expect(chat.isThreadStreaming('thread-1')).toBe(false);
  });

  it('renders app-server plan updates as live plan checklist text', () => {
    const transport = eventTransport();
    const chat = new CodexAppServerChat(transport);

    transport.emitNotification({
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: turn('turn-1', 'inProgress')
      }
    });
    transport.emitNotification({
      method: 'turn/plan/updated',
      params: {
        turnId: 'turn-1',
        explanation: 'I will do this in two steps.',
        plan: [
          { step: 'Read the code', status: 'completed' },
          { step: 'Wire plan mode', status: 'in_progress' },
          { step: 'Run tests', status: 'pending' }
        ]
      }
    });

    const visible = chat.applyLiveState(emptyTranscript('thread-1'), 'thread-1');

    expect(visible.messages).toEqual([
      expect.objectContaining({
        id: 'plan:turn-1',
        role: 'activity',
        kind: 'plan',
        text: [
          'I will do this in two steps.',
          '',
          '[x] Read the code',
          '[*] Wire plan mode',
          '[ ] Run tests'
        ].join('\n')
      })
    ]);
  });

  it('emits app-server thread status changes as tablet live events', () => {
    const transport = eventTransport();
    const chat = new CodexAppServerChat(transport);
    const liveEvents: unknown[] = [];
    chat.onLiveEvent((event) => liveEvents.push(event));

    transport.emitNotification({
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: { type: 'active', activeFlags: [] }
      }
    });

    expect(liveEvents).toContainEqual({
      type: 'thread/status/changed',
      payload: {
        threadId: 'thread-1',
        status: 'running'
      }
    });
    expect(chat.isThreadStreaming('thread-1')).toBe(true);
  });

  it('stores app-server approval requests and answers the same request id', async () => {
    const transport = eventTransport();
    const chat = new CodexAppServerChat(transport);

    transport.emitServerRequest({
      id: 42,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-approval',
        turnId: 'turn-7',
        itemId: 'file-change-1',
        reason: 'Allow this file change?'
      }
    });

    expect(chat.isThreadWaitingForApproval('thread-approval')).toBe(true);
    expect(chat.getPendingApprovalRequests('thread-approval')).toEqual([
      expect.objectContaining({
        id: '42',
        method: 'item/fileChange/requestApproval',
        turnId: 'turn-7',
        itemId: 'file-change-1'
      })
    ]);

    await chat.respondToApproval(
      'thread-approval',
      '42',
      'item/fileChange/requestApproval',
      'accept'
    );

    expect(transport.serverResponses).toEqual([
      {
        id: 42,
        result: { decision: 'accept' }
      }
    ]);
    expect(chat.getPendingApprovalRequests('thread-approval')).toEqual([]);
  });

  it('interrupts the active app-server turn', async () => {
    const transport = eventTransport();
    const chat = new CodexAppServerChat(transport);

    transport.emitNotification({
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: turn('turn-live', 'inProgress')
      }
    });

    await chat.interruptTurn('thread-1');

    expect(transport.calls).toContainEqual({
      method: 'turn/interrupt',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-live'
      }
    });
    expect(chat.isThreadStreaming('thread-1')).toBe(false);
  });

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
      'thread/read'
    ]);
    expect(transport.calls.some((call) => call.method === 'thread/start')).toBe(false);
    expect(transport.calls[2]?.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Continue from my phone.', text_elements: [] }]
    });
  });

  it('keeps the just-started user message when thread/read returns old history with the same text', async () => {
    const oldTurn = {
      ...turn('turn-old', 'completed'),
      items: [
        {
          type: 'userMessage',
          id: 'old-user-choice',
          content: [{ type: 'text', text: '2' }]
        },
        {
          type: 'agentMessage',
          id: 'old-answer',
          text: 'Previous answer for option 2.',
          phase: null
        }
      ]
    };
    const transport = fakeTransport([
      threadResponse('thread-1', 'idle', [oldTurn]),
      threadResponse('thread-1', 'idle', [oldTurn])
    ]);
    const chat = new CodexAppServerChat(transport);

    const result = await chat.sendMessage('thread-1', '2');

    expect(result.transcript.activeTurnId).toBe('turn-new');
    expect(result.transcript.sendState).toMatchObject({
      canSend: false,
      reason: 'thread_changed',
      label: 'Codex is working'
    });
    expect(result.transcript.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'old-user-choice',
          role: 'user',
          text: '2'
        }),
        expect.objectContaining({
          id: 'user:turn-new',
          role: 'user',
          text: '2'
        })
      ])
    );
  });

  it('maps app-server model reasoning metadata from snake_case fields', async () => {
    const transport = fakeTransport([
      {
        data: [
          {
            model: 'gpt-5.5',
            displayName: 'GPT-5.5',
            default_reasoning_level: 'medium',
            supported_reasoning_levels: [
              { effort: 'low', description: 'Low' },
              { effort: 'medium', description: 'Medium' },
              { effort: 'high', description: 'High' },
              { effort: 'xhigh', description: 'Extra high' }
            ]
          }
        ],
        nextCursor: null
      }
    ]);
    const chat = new CodexAppServerChat(transport);

    const models = await chat.listModels();

    expect(transport.calls[0]?.method).toBe('model/list');
    expect(models).toEqual([
      expect.objectContaining({
        slug: 'gpt-5.5',
        displayName: 'GPT-5.5',
        defaultReasoningLevel: 'medium',
        supportedReasoningLevels: [
          { effort: 'low', description: 'Low' },
          { effort: 'medium', description: 'Medium' },
          { effort: 'high', description: 'High' },
          { effort: 'xhigh', description: 'Extra high' }
        ]
      })
    ]);
  });

  it('passes selected collaboration mode to app-server turn/start', async () => {
    const transport = fakeTransport([
      {
        ...threadResponse('thread-1', 'idle', []),
        model: 'gpt-5.5',
        reasoningEffort: 'medium'
      },
      threadResponse('thread-1', 'active', [turn('turn-new', 'inProgress')])
    ]);
    const chat = new CodexAppServerChat(transport);

    await chat.sendMessage('thread-1', 'Make a plan first.', {
      collaborationMode: 'plan',
      model: 'gpt-5.6',
      effort: 'high'
    });

    expect(transport.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Make a plan first.', text_elements: [] }],
      model: 'gpt-5.6',
      effort: 'high',
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'gpt-5.6',
          reasoning_effort: 'high',
          developer_instructions: null
        }
      }
    });
  });

  it('keeps full-access permissions on follow-up turns for resumed Codex threads', async () => {
    const transport = fakeTransport([
      {
        ...threadResponse('thread-1', 'idle', []),
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        permissionProfile: { type: 'disabled' },
        sandbox: { type: 'dangerFullAccess' }
      },
      threadResponse('thread-1', 'active', [turn('turn-new', 'inProgress')])
    ]);
    const chat = new CodexAppServerChat(transport);

    await chat.sendMessage('thread-1', 'Run the full test suite.');

    const turnStartParams = transport.calls.find((call) => call.method === 'turn/start')
      ?.params as Record<string, unknown>;
    expect(turnStartParams).toMatchObject({
      threadId: 'thread-1',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      permissionProfile: { type: 'disabled' }
    });
    expect(Object.prototype.hasOwnProperty.call(turnStartParams, 'sandboxPolicy')).toBe(false);
  });

  it('falls back to the resumed thread sandbox policy when no permission profile is present', async () => {
    const transport = fakeTransport([
      {
        ...threadResponse('thread-1', 'idle', []),
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' }
      },
      threadResponse('thread-1', 'active', [turn('turn-new', 'inProgress')])
    ]);
    const chat = new CodexAppServerChat(transport);

    await chat.sendMessage('thread-1', 'Run tests without another approval popup.');

    expect(transport.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      threadId: 'thread-1',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' }
    });
  });

  it('starts the first turn on a draft thread before Codex has materialized history', async () => {
    const calls: RequestCall[] = [];
    const transport: CodexAppServerTransport = {
      isConnected: () => true,
      request: async <T = unknown>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === 'thread/resume') {
          throw new Error('no rollout found for thread id thread-draft');
        }
        if (method === 'thread/turns/list') {
          throw new Error('thread thread-draft is not materialized yet; thread/turns/list is unavailable before first user message');
        }
        if (method === 'thread/read') {
          throw new Error('thread thread-draft is not materialized yet; includeTurns is unavailable before first user message');
        }
        if (method === 'turn/start') {
          return { turn: { id: 'turn-first' } } as T;
        }
        throw new Error(`Unexpected method ${method}`);
      }
    };
    const chat = new CodexAppServerChat(transport);

    const result = await chat.sendMessage('thread-draft', 'First prompt in this project.');

    expect(result.mode).toBe('start');
    expect(result.turnId).toBe('turn-first');
    expect(calls.map((call) => call.method)).toContain('turn/start');
    expect(calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      threadId: 'thread-draft',
      input: [{ type: 'text', text: 'First prompt in this project.', text_elements: [] }]
    });
    expect(result.transcript.activeTurnId).toBe('turn-first');
    expect(result.transcript.sendState).toMatchObject({
      canSend: false,
      reason: 'missing_active_turn',
      label: 'Codex is working'
    });
    expect(result.transcript.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        kind: 'message',
        text: 'First prompt in this project.'
      })
    ]);
  });

  it('starts a new thread with Codex desktop-style project config', async () => {
    const cwd = '/Users/me/projects/CodexPulse';
    const config = {
      model: 'gpt-5.5',
      model_provider: 'openai',
      sandbox_mode: 'danger-full-access',
      approval_policy: 'never',
      developer_instructions: 'Be concise.',
      personality: 'friendly',
      model_reasoning_effort: 'xhigh',
      service_tier: 'priority',
      marketplaces: {
        'openai-bundled': {
          sparse_paths: ''
        }
      },
      plugins: {
        cache: '/Users/me/.codex/plugins/cache'
      }
    };
    const transport = fakeTransport([
      { config },
      threadResponse('thread-new', 'idle', [], [], cwd)
    ]);
    const chat = new CodexAppServerChat(transport);

    const result = await chat.startThread(cwd);

    expect(result.threadId).toBe('thread-new');
    expect(result.workspace).toBe('CodexPulse');
    expect(transport.calls.map((call) => call.method)).toEqual(['config/read', 'thread/start']);
    expect(transport.calls[0]?.params).toEqual({ includeLayers: false, cwd });
    expect(transport.calls[1]?.params).toEqual({
      cwd,
      model: 'gpt-5.5',
      modelProvider: 'openai',
      approvalsReviewer: 'user',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: {
        model_reasoning_effort: 'xhigh'
      },
      personality: 'friendly',
      ephemeral: null,
      mockExperimentalField: null,
      dynamicTools: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      serviceTier: 'priority',
      developerInstructions: 'Be concise.'
    });
  });

  it('omits serviceTier and developerInstructions when the project config does not set them', async () => {
    const cwd = '/Users/me/projects/CodexPulse';
    const transport = fakeTransport([
      { config: { model: 'gpt-5.5' } },
      threadResponse('thread-new', 'idle', [], [], cwd)
    ]);
    const chat = new CodexAppServerChat(transport);

    await chat.startThread(cwd);

    const params = transport.calls[1]?.params as Record<string, unknown>;
    expect(params).toMatchObject({
      cwd,
      model: 'gpt-5.5',
      approvalsReviewer: 'user',
      ephemeral: null,
      mockExperimentalField: null,
      dynamicTools: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
    // Codex desktop omits these keys entirely when unset; mirror that shape so
    // schema validation does not reject `null` placeholders.
    expect(Object.prototype.hasOwnProperty.call(params, 'serviceTier')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(params, 'developerInstructions')).toBe(false);
  });

  it('lets the caller override model and reasoning effort for the new thread', async () => {
    const cwd = '/Users/me/projects/CodexPulse';
    const transport = fakeTransport([
      { config: { model: 'gpt-5.5', model_reasoning_effort: 'medium' } },
      threadResponse('thread-new', 'idle', [], [], cwd)
    ]);
    const chat = new CodexAppServerChat(transport);

    await chat.startThread(cwd, { model: 'gpt-5.6', reasoningEffort: 'high' });

    expect(transport.calls[1]?.params).toMatchObject({
      cwd,
      // The caller's override beats the project config's `model` field.
      model: 'gpt-5.6',
      // Reasoning effort lives inside the thread/start `config` blob.
      config: { model_reasoning_effort: 'high' }
    });
  });

  it('uses Codex auto defaults when project config does not pin access settings', async () => {
    const cwd = '/Users/me/projects/CodexPulse';
    const transport = fakeTransport([
      {
        config: {
          model: 'gpt-5.5',
          sandbox_mode: null,
          approval_policy: null
        }
      },
      threadResponse('thread-new', 'idle', [], [], cwd)
    ]);
    const chat = new CodexAppServerChat(transport);

    await chat.startThread(cwd);

    expect(transport.calls[1]?.params).toMatchObject({
      cwd,
      model: 'gpt-5.5',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    });
  });

  it('still asks Codex to start the project thread if config read is unavailable', async () => {
    const cwd = '/Users/me/projects/CodexPulse';
    const transport = fakeTransport([
      new Error('config/read unavailable'),
      threadResponse('thread-new', 'idle', [], [], cwd)
    ]);
    const chat = new CodexAppServerChat(transport);

    await chat.startThread(cwd);

    expect(transport.calls.map((call) => call.method)).toEqual(['config/read', 'thread/start']);
    expect(transport.calls[1]?.params).toMatchObject({
      cwd,
      model: 'gpt-5.5',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {}
    });
  });

  it('retries project thread creation once when the spawned app-server exits during start', async () => {
    const cwd = '/Users/me/projects/CodexPulse';
    const transport = fakeTransport([
      { config: { model: 'gpt-5.5' } },
      new Error('Codex App Server disconnected (code=null, signal=SIGTERM)'),
      { config: { model: 'gpt-5.5' } },
      threadResponse('thread-new', 'idle', [], [], cwd)
    ]);
    const chat = new CodexAppServerChat(transport);

    const result = await chat.startThread(cwd);

    expect(result.threadId).toBe('thread-new');
    expect(transport.calls.map((call) => call.method)).toEqual([
      'config/read',
      'thread/start',
      'config/read',
      'thread/start'
    ]);
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
      'thread/read'
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
      'thread/read'
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

  it('reads transcript snapshots without resuming the thread', async () => {
    const calls: RequestCall[] = [];
    const transport: CodexAppServerTransport = {
      isConnected: () => true,
      request: async <T = unknown>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === 'thread/read') {
          return threadResponse('thread-1', 'idle', [turn('turn-1', 'completed')]) as T;
        }
        throw new Error(`Unexpected method ${method}`);
      }
    };
    const chat = new CodexAppServerChat(transport);

    const transcript = await chat.readTranscript('thread-1');

    expect(transcript.threadId).toBe('thread-1');
    expect(calls).toEqual([
      {
        method: 'thread/read',
        params: { threadId: 'thread-1', includeTurns: true }
      }
    ]);
  });

  it('subscribes to live updates by resuming the opened thread', async () => {
    const transport = fakeTransport([
      threadResponse('thread-1', 'idle', [turn('turn-1', 'completed')])
    ]);
    const chat = new CodexAppServerChat(transport);

    await chat.subscribeThread('thread-1');

    expect(transport.calls.map((call) => call.method)).toEqual([
      'thread/resume',
      'thread/turns/list'
    ]);
  });

  it('lists loaded app-server thread ids for current-state reconciliation', async () => {
    const calls: RequestCall[] = [];
    const responses = [
      { data: ['thread-1', 'thread-2'], nextCursor: 'cursor-2' },
      { data: ['thread-3'], nextCursor: null }
    ];
    const transport: CodexAppServerTransport = {
      isConnected: () => true,
      request: async <T = unknown>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === 'thread/loaded/list') {
          return responses.shift() as T;
        }
        throw new Error(`Unexpected method ${method}`);
      }
    };
    const chat = new CodexAppServerChat(transport);

    await expect(chat.listLoadedThreadIds()).resolves.toEqual(
      new Set(['thread-1', 'thread-2', 'thread-3'])
    );
    expect(calls).toEqual([
      { method: 'thread/loaded/list', params: { cursor: null } },
      { method: 'thread/loaded/list', params: { cursor: 'cursor-2' } }
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
        if (method === 'thread/read') {
          return threadResponse('thread-empty', 'idle', []) as T;
        }
        throw new Error(`Unexpected method ${method}`);
      }
    };
    const chat = new CodexAppServerChat(transport);

    const transcript = await chat.readTranscript('thread-empty');

    expect(transcript.threadId).toBe('thread-empty');
    expect(transcript.messages).toEqual([]);
    expect(transcript.sendState.reason).toBe('ready');
    expect(calls).toEqual([
      {
        method: 'thread/read',
        params: { threadId: 'thread-empty', includeTurns: true }
      }
    ]);
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

  it('archives a thread through app-server and emits a remove event', async () => {
    const transport = eventTransport();
    const chat = new CodexAppServerChat(transport);
    const liveEvents: unknown[] = [];
    chat.onLiveEvent((event) => liveEvents.push(event));

    await chat.archiveThread('thread-1');

    expect(transport.calls).toEqual([
      { method: 'thread/archive', params: { threadId: 'thread-1' } }
    ]);
    expect(liveEvents).toContainEqual({
      type: 'thread/remove',
      payload: { threadId: 'thread-1' }
    });
  });

  it('maps app-server thread archived notifications to tablet remove events', () => {
    const transport = eventTransport();
    const chat = new CodexAppServerChat(transport);
    const liveEvents: unknown[] = [];
    chat.onLiveEvent((event) => liveEvents.push(event));

    transport.emitNotification({
      method: 'thread/archived',
      params: { threadId: 'thread-1' }
    });

    expect(liveEvents).toContainEqual({
      type: 'thread/remove',
      payload: { threadId: 'thread-1' }
    });
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

function eventTransport(): CodexAppServerTransport & {
  calls: RequestCall[];
  serverResponses: Array<{ id: number | string; result: unknown }>;
  emitNotification(notification: { method: string; params?: unknown }): void;
  emitServerRequest(request: { id: number | string; method: string; params?: unknown }): void;
} {
  const calls: RequestCall[] = [];
  const serverResponses: Array<{ id: number | string; result: unknown }> = [];
  const notificationListeners = new Set<(notification: { method: string; params?: unknown }) => void>();
  const serverRequestListeners = new Set<
    (request: { id: number | string; method: string; params?: unknown }) => void
  >();
  return {
    calls,
    serverResponses,
    isConnected: () => true,
    request: async <T = unknown>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params });
      return {} as T;
    },
    onNotification: (listener) => {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onServerRequest: (listener) => {
      serverRequestListeners.add(listener);
      return () => serverRequestListeners.delete(listener);
    },
    respondToServerRequest: async (id, result) => {
      serverResponses.push({ id, result });
    },
    emitNotification: (notification) => {
      for (const listener of notificationListeners) {
        listener(notification);
      }
    },
    emitServerRequest: (request) => {
      for (const listener of serverRequestListeners) {
        listener(request);
      }
    }
  };
}

function emptyTranscript(threadId: string) {
  return {
    threadId,
    activeTurnId: null,
    sendState: {
      canSend: true as const,
      reason: 'ready' as const,
      label: 'Ready'
    },
    messages: []
  };
}

function threadResponse(
  threadId: string,
  status: 'idle' | 'active',
  turns: Array<Record<string, unknown>>,
  activeFlags: string[] = [],
  cwd = '/tmp/project'
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
      cwd,
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
