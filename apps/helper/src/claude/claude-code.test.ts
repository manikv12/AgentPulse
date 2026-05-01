import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
      effort: 'high'
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
        content: [{ type: 'text', text: 'Hello Claude' }]
      }
    });

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi from Claude' }] }
      })}\n`
    );

    const transcript = await provider.readTranscript(thread.threadId);
    expect(transcript.activeTurnId).toBe(response.turnId);
    expect(transcript.reasoningEffort).toBe('high');
    expect(transcript.messages.map((message) => message.text)).toEqual([
      'Hello Claude',
      'Hi from Claude'
    ]);
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

function fakeClaudeProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const writes: string[] = [];
  stdin.on('data', (chunk) => writes.push(chunk.toString('utf8').trim()));
  const process = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    killed: false,
    kill: vi.fn(() => {
      process.killed = true;
      process.emit('exit', 0);
      return true;
    })
  });
  return { process: process as never, stdout, writes };
}
