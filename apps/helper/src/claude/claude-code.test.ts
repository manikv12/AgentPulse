import { EventEmitter } from 'node:events';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider, isClaudeThreadId } from './claude-code';

const tempHomes: string[] = [];

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempClaudeHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'agent-pulse-claude-'));
  tempHomes.push(home);
  return home;
}

describe('ClaudeCodeProvider', () => {
  it('reads Claude JSONL sessions as provider-aware threads and projects', async () => {
    const claudeHome = await tempClaudeHome();
    const projectDir = path.join(claudeHome, 'projects', '-Users-me-projects-CodexPulse');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          uuid: 'message-user',
          timestamp: '2026-04-25T16:14:00Z',
          cwd: '/Users/me/projects/CodexPulse',
          message: { role: 'user', content: [{ type: 'text', text: 'Fix the sidebar' }] }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          uuid: 'message-assistant',
          timestamp: '2026-04-25T16:15:00Z',
          cwd: '/Users/me/projects/CodexPulse',
          message: {
            role: 'assistant',
            model: 'claude-sonnet',
            usage: {
              input_tokens: 1000,
              cache_creation_input_tokens: 500,
              cache_read_input_tokens: 250,
              output_tokens: 250
            },
            content: [
              { type: 'text', text: 'Done.' },
              {
                type: 'tool_use',
                name: 'TodoWrite',
                input: { todos: [{ content: 'Check grouping', status: 'completed' }] }
              }
            ]
          }
        })
      ].join('\n')
    );

    const provider = new ClaudeCodeProvider({
      claudeHome,
      usageReader: { readUsage: async () => undefined }
    });

    await expect(provider.listProjects()).resolves.toEqual([
      {
        projectId: 'e2243034ee1c529e',
        name: 'CodexPulse',
        path: '/Users/me/projects/CodexPulse',
        providers: ['claude-code']
      }
    ]);
    await expect(provider.listThreads()).resolves.toMatchObject([
      {
        threadId: 'claude-code:session-1',
        provider: 'claude-code',
        providerThreadId: 'session-1',
        title: 'Fix the sidebar',
        workspace: 'CodexPulse',
        workspacePath: '/Users/me/projects/CodexPulse',
        status: 'idle',
        lastTurnSummary: 'Done.',
        model: 'sonnet'
      }
    ]);

    const transcript = await provider.readTranscript('claude-code:session-1');
    expect(transcript.provider).toBe('claude-code');
    expect(transcript.providerThreadId).toBe('session-1');
    expect(transcript.model).toBe('sonnet');
    expect(transcript.usage).toMatchObject({
      contextTokens: 2000,
      contextWindow: 200000,
      contextUsedPercent: 1
    });
    expect(transcript.messages.map((message) => message.kind)).toEqual(['message', 'message', 'plan']);
    expect(transcript.messages.at(-1)?.text).toBe('[completed] Check grouping');
  });

  it('deletes Claude JSONL session files from local history', async () => {
    const claudeHome = await tempClaudeHome();
    const projectDir = path.join(claudeHome, 'projects', '-Users-me-projects-CodexPulse');
    const sessionPath = path.join(projectDir, 'session-delete.jsonl');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: 'user',
        sessionId: 'session-delete',
        uuid: 'message-user',
        timestamp: '2026-04-25T16:14:00Z',
        cwd: '/Users/me/projects/CodexPulse',
        message: { role: 'user', content: [{ type: 'text', text: 'Remove me' }] }
      })
    );

    const provider = new ClaudeCodeProvider({
      claudeHome,
      usageReader: { readUsage: async () => undefined }
    });

    await expect(provider.listThreads()).resolves.toHaveLength(1);
    await provider.deleteThread('claude-code:session-delete');

    await expect(provider.listThreads()).resolves.toHaveLength(0);
    await expect(access(sessionPath)).rejects.toThrow();
  });

  it('deletes unsent Claude draft threads without touching disk', async () => {
    const claudeHome = await tempClaudeHome();
    const provider = new ClaudeCodeProvider({
      claudeHome,
      usageReader: { readUsage: async () => undefined }
    });

    const draft = await provider.startThread('/Users/me/projects/CodexPulse');
    await expect(provider.listThreads()).resolves.toHaveLength(1);

    await provider.deleteThread(draft.threadId);

    await expect(provider.listThreads()).resolves.toHaveLength(0);
  });

  it('turns Claude image source markers into thumbnail attachments', async () => {
    const claudeHome = await tempClaudeHome();
    const projectDir = path.join(claudeHome, 'projects', '-Users-me-projects-CodexPulse');
    const imageDir = path.join(claudeHome, 'image-cache', 'session-1');
    const imagePath = path.join(imageDir, '2.png');
    await mkdir(projectDir, { recursive: true });
    await mkdir(imageDir, { recursive: true });
    await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    await writeFile(
      path.join(projectDir, 'session-1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          uuid: 'message-user',
          timestamp: '2026-04-25T16:14:00Z',
          cwd: '/Users/me/projects/CodexPulse',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Please check this.\n\n[Image: source: ${imagePath}]`
              }
            ]
          }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          uuid: 'message-assistant',
          timestamp: '2026-04-25T16:15:00Z',
          cwd: '/Users/me/projects/CodexPulse',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'I can see the screenshot.' }]
          }
        })
      ].join('\n')
    );

    const provider = new ClaudeCodeProvider({
      claudeHome,
      usageReader: { readUsage: async () => undefined }
    });

    const transcript = await provider.readTranscript('claude-code:session-1');
    expect(transcript.messages[0]).toMatchObject({
      text: 'Please check this.',
      attachments: [
        {
          kind: 'image',
          sourcePath: imagePath,
          alt: 'Image 1'
        }
      ]
    });
    expect(transcript.messages[0]?.text).not.toContain('source:');
  });

  it('lists OpenAssist-style Claude model aliases', async () => {
    const provider = new ClaudeCodeProvider({
      usageReader: { readUsage: async () => undefined }
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        slug: 'opus',
        displayName: 'Claude Opus',
        provider: 'claude-code',
        description: 'Higher-capability Claude Code model alias.',
        defaultReasoningLevel: 'medium',
        supportedReasoningLevels: [
          { effort: 'low', description: 'Fastest Claude Code reasoning.' },
          { effort: 'medium', description: 'Balanced Claude Code reasoning.' },
          { effort: 'high', description: 'Deeper Claude Code reasoning.' },
          { effort: 'xhigh', description: 'Extra-deep Claude Code reasoning.' },
          { effort: 'max', description: 'Maximum Claude Code reasoning.' }
        ],
        visibility: 'visible',
        priority: 10
      },
      {
        slug: 'sonnet',
        displayName: 'Claude Sonnet',
        provider: 'claude-code',
        description: 'Balanced Claude Code model alias.',
        defaultReasoningLevel: 'medium',
        supportedReasoningLevels: [
          { effort: 'low', description: 'Fastest Claude Code reasoning.' },
          { effort: 'medium', description: 'Balanced Claude Code reasoning.' },
          { effort: 'high', description: 'Deeper Claude Code reasoning.' },
          { effort: 'xhigh', description: 'Extra-deep Claude Code reasoning.' },
          { effort: 'max', description: 'Maximum Claude Code reasoning.' }
        ],
        visibility: 'visible',
        priority: 20
      }
    ]);
  });

  it('starts draft sessions and streams user input into Claude Code', async () => {
    const claudeHome = await tempClaudeHome();
    const child = fakeClaudeProcess();
    const spawnProcess = vi.fn(() => child.process);
    const provider = new ClaudeCodeProvider({
      claudeHome,
      spawnProcess,
      now: () => new Date('2026-04-25T16:14:00Z'),
      usageReader: { readUsage: async () => undefined }
    });

    const thread = await provider.startThread('/Users/me/projects/CodexPulse');
    expect(isClaudeThreadId(thread.threadId)).toBe(true);
    expect(thread.provider).toBe('claude-code');

    const response = await provider.sendMessage(thread.threadId, 'Hello Claude', {
      model: 'claude-sonnet',
      effort: 'high',
      attachments: [
        {
          id: 'pasted-image-1',
          kind: 'image',
          url: 'data:image/png;base64,iVBORw0KGgo=',
          mimeType: 'image/png',
          alt: 'Pasted image'
        }
      ]
    });

    expect(response.ok).toBe(true);
    expect(spawnProcess).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '-p',
        '--input-format',
        'stream-json',
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--session-id',
        thread.providerThreadId
      ]),
      expect.objectContaining({ cwd: '/Users/me/projects/CodexPulse', stdio: 'pipe' })
    );
    expect(JSON.parse(child.writes[0] ?? '{}')).toMatchObject({
      type: 'user',
      session_id: thread.providerThreadId,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello Claude' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgo='
            }
          }
        ]
      }
    });

    const imagePath = path.join(claudeHome, 'image-cache', 'session-draft.png');
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `Hi from Claude\n\n[Image: source: ${imagePath}]` }] }
      })}\n`
    );

    const transcript = await provider.readTranscript(thread.threadId);
    expect(transcript.activeTurnId).toBe(response.turnId);
    expect(transcript.reasoningEffort).toBe('high');
    expect(transcript.messages.map((message) => message.text)).toEqual([
      'Hello Claude',
      'Hi from Claude'
    ]);
    expect(transcript.messages[1]?.attachments?.[0]).toMatchObject({
      kind: 'image',
      sourcePath: imagePath
    });
  });

  it('keeps the draft ready when the Claude Code executable cannot start', async () => {
    const claudeHome = await tempClaudeHome();
    const child = fakeClaudeProcess({ pid: undefined });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => (child.process as unknown as EventEmitter).emit('error', new Error('spawn claude ENOENT')));
      return child.process;
    });
    const provider = new ClaudeCodeProvider({
      claudeHome,
      spawnProcess,
      usageReader: { readUsage: async () => undefined }
    });

    const thread = await provider.startThread('/Users/me/projects/CodexPulse');
    const pending = provider.sendMessage(thread.threadId, 'Hello Claude');

    await expect(pending).rejects.toThrow('Claude Code could not start from Agent Pulse');
    const transcript = await provider.readTranscript(thread.threadId);
    expect(transcript.activeTurnId).toBeNull();
    expect(transcript.sendState).toEqual({ canSend: true, reason: 'ready', label: 'Send' });
    await expect(provider.listThreads()).resolves.toMatchObject([
      {
        threadId: thread.threadId,
        title: 'New Claude chat',
        status: 'idle'
      }
    ]);
  });

  it('clears the running state if Claude Code dies after a send starts', async () => {
    const claudeHome = await tempClaudeHome();
    const child = fakeClaudeProcess();
    const spawnProcess = vi.fn(() => child.process);
    const provider = new ClaudeCodeProvider({
      claudeHome,
      spawnProcess,
      now: () => new Date('2026-04-25T16:14:00Z'),
      usageReader: { readUsage: async () => undefined }
    });

    const thread = await provider.startThread('/Users/me/projects/CodexPulse');
    await expect(provider.sendMessage(thread.threadId, 'Hello Claude')).resolves.toMatchObject({
      ok: true
    });

    (child.process as unknown as EventEmitter).emit('error', new Error('Claude crashed'));

    const transcript = await provider.readTranscript(thread.threadId);
    expect(transcript.activeTurnId).toBeNull();
    expect(transcript.sendState).toEqual({ canSend: true, reason: 'ready', label: 'Send' });
    expect(transcript.messages.map((message) => message.text)).toEqual([
      'Hello Claude',
      'Claude Code stopped before finishing: Claude crashed'
    ]);
    expect(transcript.messages.at(-1)).toMatchObject({
      role: 'assistant',
      kind: 'message',
      phase: 'final_answer'
    });
  });

  it('retries a missing resumed Claude conversation as a session-owned turn', async () => {
    const claudeHome = await tempClaudeHome();
    const projectDir = path.join(claudeHome, 'projects', '-Users-me-projects-CodexPulse');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-retry.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 'session-retry',
        uuid: 'message-user',
        timestamp: '2026-04-25T16:14:00Z',
        cwd: '/Users/me/projects/CodexPulse',
        entrypoint: 'claude-desktop',
        message: { role: 'user', content: [{ type: 'text', text: 'Old desktop prompt' }] }
      })
    );

    const firstChild = fakeClaudeProcess();
    const secondChild = fakeClaudeProcess();
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild.process)
      .mockReturnValueOnce(secondChild.process);
    const provider = new ClaudeCodeProvider({
      claudeHome,
      spawnProcess,
      now: () => new Date('2026-04-25T16:20:00Z'),
      usageReader: { readUsage: async () => undefined }
    });

    await provider.sendMessage('claude-code:session-retry', 'Continue from Agent Pulse');
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--resume', 'session-retry']));
    expect(firstChild.writes).toHaveLength(1);

    firstChild.stderr.write('Error: No conversation found with session ID: session-retry\n');
    (firstChild.process as unknown as EventEmitter).emit('exit', 1);
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));

    expect(spawnProcess.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['--session-id', 'session-retry']));
    await vi.waitFor(() => expect(secondChild.writes).toHaveLength(1));
    expect(JSON.parse(secondChild.writes[0] ?? '{}')).toMatchObject({
      type: 'user',
      session_id: 'session-retry',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Continue from Agent Pulse' }]
      }
    });

    const retryingTranscript = await provider.readTranscript('claude-code:session-retry');
    expect(retryingTranscript.sendState).toMatchObject({
      canSend: false,
      label: 'Claude is working'
    });
    expect(retryingTranscript.messages.map((message) => message.text)).not.toContain(
      'Claude Code stopped before finishing: Error: No conversation found with session ID: session-retry'
    );

    secondChild.stdout.write(`${JSON.stringify({ type: 'result', result: 'Recovered reply' })}\n`);

    const completedTranscript = await provider.readTranscript('claude-code:session-retry');
    expect(completedTranscript.messages.at(-1)).toMatchObject({
      role: 'assistant',
      kind: 'message',
      text: 'Recovered reply',
      phase: 'final_answer'
    });
  });

  it('emits per-token text-delta and text-end events for live Claude streaming', async () => {
    const claudeHome = await tempClaudeHome();
    const child = fakeClaudeProcess();
    const spawnProcess = vi.fn(() => child.process);
    const provider = new ClaudeCodeProvider({
      claudeHome,
      spawnProcess,
      now: () => new Date('2026-04-25T16:14:00Z'),
      usageReader: { readUsage: async () => undefined }
    });

    const events: { type: string; payload: unknown }[] = [];
    provider.onLiveEvent((event) => {
      if (
        event.type === 'thread/assistant/text-delta' ||
        event.type === 'thread/assistant/text-end'
      ) {
        events.push({ type: event.type, payload: event.payload });
      }
    });

    const thread = await provider.startThread('/Users/me/projects/CodexPulse');
    await provider.sendMessage(thread.threadId, 'Hi Claude');

    // Two streaming text deltas, then a result.
    child.stdout.write(
      `${JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hel' }
        }
      })}\n`
    );
    child.stdout.write(
      `${JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'lo!' }
        }
      })}\n`
    );
    child.stdout.write(`${JSON.stringify({ type: 'result', result: 'Hello!' })}\n`);

    const deltas = events.filter((event) => event.type === 'thread/assistant/text-delta');
    const ends = events.filter((event) => event.type === 'thread/assistant/text-end');
    expect(deltas.map((event) => (event.payload as { delta: string }).delta)).toEqual(['Hel', 'lo!']);
    expect(ends).toHaveLength(1);

    const messageIds = new Set(
      events.map((event) => (event.payload as { messageId: string }).messageId)
    );
    expect(messageIds.size).toBe(1);
    const messageId = [...messageIds][0]!;

    const transcript = await provider.readTranscript(thread.threadId);
    const assistantMessage = transcript.messages.find((message) => message.id === messageId);
    expect(assistantMessage?.text).toBe('Hello!');
    expect(assistantMessage?.phase).toBe('final_answer');
  });

  it('marks live Claude assistant output as commentary until the turn finishes', async () => {
    const claudeHome = await tempClaudeHome();
    const child = fakeClaudeProcess();
    const spawnProcess = vi.fn(() => child.process);
    const provider = new ClaudeCodeProvider({
      claudeHome,
      spawnProcess,
      now: () => new Date('2026-04-25T16:14:00Z'),
      usageReader: { readUsage: async () => undefined }
    });

    const thread = await provider.startThread('/Users/me/projects/CodexPulse');
    await provider.sendMessage(thread.threadId, 'Hello Claude');

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'First Claude update' }]
        }
      })}\n`
    );

    const streamingTranscript = await provider.readTranscript(thread.threadId);
    expect(streamingTranscript.messages.at(-1)).toMatchObject({
      role: 'assistant',
      kind: 'message',
      text: 'First Claude update',
      phase: 'commentary'
    });

    child.stdout.write(`${JSON.stringify({ type: 'result', result: 'Final Claude answer' })}\n`);

    const completedTranscript = await provider.readTranscript(thread.threadId);
    expect(completedTranscript.messages.at(-1)).toMatchObject({
      role: 'assistant',
      kind: 'message',
      text: 'Final Claude answer',
      phase: 'final_answer'
    });
  });

  it('keeps live Claude progress after the current user message when JSONL echoes the prompt later', async () => {
    const claudeHome = await tempClaudeHome();
    const projectDir = path.join(claudeHome, 'projects', '-Users-me-projects-CodexPulse');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-live.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-live',
          uuid: 'history-user',
          timestamp: '2026-04-25T16:10:00Z',
          cwd: '/Users/me/projects/CodexPulse',
          message: { role: 'user', content: [{ type: 'text', text: 'Old question' }] }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-live',
          uuid: 'history-assistant',
          timestamp: '2026-04-25T16:11:00Z',
          cwd: '/Users/me/projects/CodexPulse',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Old answer' }] }
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-live',
          uuid: 'jsonl-current-user',
          timestamp: '2026-04-25T16:20:00Z',
          cwd: '/Users/me/projects/CodexPulse',
          message: { role: 'user', content: [{ type: 'text', text: 'Newest Claude prompt' }] }
        })
      ].join('\n')
    );

    const child = fakeClaudeProcess();
    const spawnProcess = vi.fn(() => child.process);
    const times = [
      '2026-04-25T16:18:00Z',
      '2026-04-25T16:18:01Z',
      '2026-04-25T16:18:02Z'
    ];
    let timeIndex = 0;
    const provider = new ClaudeCodeProvider({
      claudeHome,
      spawnProcess,
      now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]!),
      usageReader: { readUsage: async () => undefined }
    });

    await provider.sendMessage('claude-code:session-live', 'Newest Claude prompt');
    child.stdout.write(
      `${JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            id: 'tool-1',
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'pwd' }
          }
        }
      })}\n`
    );

    const transcript = await provider.readTranscript('claude-code:session-live');
    expect(transcript.messages.map((message) => message.text)).toEqual([
      'Old question',
      'Old answer',
      'Newest Claude prompt',
      'Bash\n{"command":"pwd"}'
    ]);
  });

  it('discards an empty Claude draft thread before it becomes history', async () => {
    const claudeHome = await tempClaudeHome();
    const provider = new ClaudeCodeProvider({
      claudeHome,
      usageReader: { readUsage: async () => undefined }
    });

    const thread = await provider.startThread('/Users/me/projects/CodexPulse');
    await expect(provider.listThreads()).resolves.toHaveLength(1);

    expect(provider.discardDraftThread(thread.threadId)).toBe(true);
    await expect(provider.listThreads()).resolves.toEqual([]);
    expect(provider.discardDraftThread(thread.threadId)).toBe(false);
  });

  it('restarts an idle Claude process when the selected model changes', async () => {
    const claudeHome = await tempClaudeHome();
    const firstChild = fakeClaudeProcess();
    const secondChild = fakeClaudeProcess();
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild.process)
      .mockReturnValueOnce(secondChild.process);
    const provider = new ClaudeCodeProvider({
      claudeHome,
      spawnProcess,
      now: () => new Date('2026-04-25T16:14:00Z'),
      usageReader: { readUsage: async () => undefined }
    });

    const thread = await provider.startThread('/Users/me/projects/CodexPulse', {
      model: 'sonnet'
    });
    await provider.sendMessage(thread.threadId, 'First message');
    firstChild.stdout.write(`${JSON.stringify({ type: 'result', result: 'Done' })}\n`);

    await provider.setModel(thread.threadId, 'opus', 'xhigh');
    expect((firstChild.process as unknown as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith('SIGTERM');

    await provider.sendMessage(thread.threadId, 'Second message');
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(['--model', 'opus', '--effort', 'xhigh', '--resume', thread.providerThreadId])
    );
  });
});

function fakeClaudeProcess(options: { pid?: number } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const writes: string[] = [];
  const pid = Object.prototype.hasOwnProperty.call(options, 'pid') ? options.pid : 12345;
  stdin.on('data', (chunk) => writes.push(chunk.toString('utf8').trim()));
  const process = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    pid,
    killed: false,
    kill: vi.fn(() => {
      process.killed = true;
      process.emit('exit', 0);
      return true;
    })
  });
  return { process: process as never, stdout, stderr, writes };
}
