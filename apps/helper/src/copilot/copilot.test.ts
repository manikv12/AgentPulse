import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotProvider, isCopilotThreadId } from './copilot';

const tempHomes: string[] = [];

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempCopilotHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'agent-pulse-copilot-'));
  tempHomes.push(home);
  return home;
}

describe('CopilotProvider', () => {
  it('reads Copilot session-state as provider-aware threads and projects', async () => {
    const copilotHome = await tempCopilotHome();
    const sessionDir = path.join(copilotHome, 'session-state', 'session-1');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'workspace.yaml'),
      [
        'id: session-1',
        'cwd: /Users/me/projects/CodexPulse',
        'created_at: 2026-04-25T16:14:00.000Z',
        'updated_at: 2026-04-25T16:16:00.000Z',
        'summary: Check Copilot'
      ].join('\n')
    );
    await writeFile(
      path.join(sessionDir, 'events.jsonl'),
      [
        JSON.stringify({
          type: 'session.start',
          data: {
            sessionId: 'session-1',
            selectedModel: 'gpt-5.2',
            context: { cwd: '/Users/me/projects/CodexPulse' }
          },
          id: 'session-start',
          timestamp: '2026-04-25T16:14:00Z'
        }),
        JSON.stringify({
          type: 'user.message',
          data: { content: 'Check Copilot', attachments: [] },
          id: 'message-user',
          timestamp: '2026-04-25T16:14:05Z'
        }),
        JSON.stringify({
          type: 'assistant.message',
          data: {
            messageId: 'assistant-tools',
            content: '',
            reasoningText: 'I need to inspect the workspace.',
            toolRequests: [
              {
                toolCallId: 'tool-1',
                name: 'workspace_search',
                arguments: { query: 'provider' }
              }
            ]
          },
          id: 'message-tool',
          timestamp: '2026-04-25T16:14:10Z'
        }),
        JSON.stringify({
          type: 'tool.execution_complete',
          data: {
            toolCallId: 'tool-1',
            toolName: 'workspace_search',
            success: true,
            result: { content: 'Found provider files.' }
          },
          id: 'tool-complete',
          timestamp: '2026-04-25T16:14:20Z'
        }),
        JSON.stringify({
          type: 'assistant.message',
          data: {
            messageId: 'message-assistant',
            content: 'Done.',
            toolRequests: []
          },
          id: 'message-assistant',
          timestamp: '2026-04-25T16:15:00Z'
        })
      ].join('\n')
    );

    const provider = new CopilotProvider({
      copilotHome,
      usageReader: { readUsage: async () => undefined }
    });

    await expect(provider.listProjects()).resolves.toEqual([
      {
        projectId: 'e2243034ee1c529e',
        name: 'CodexPulse',
        path: '/Users/me/projects/CodexPulse',
        providers: ['copilot']
      }
    ]);
    await expect(provider.listThreads()).resolves.toMatchObject([
      {
        threadId: 'copilot:session-1',
        provider: 'copilot',
        providerThreadId: 'session-1',
        title: 'Check Copilot',
        workspace: 'CodexPulse',
        workspacePath: '/Users/me/projects/CodexPulse',
        status: 'idle',
        lastTurnSummary: 'Done.',
        model: 'gpt-5.2'
      }
    ]);

    const transcript = await provider.readTranscript('copilot:session-1');
    expect(transcript.provider).toBe('copilot');
    expect(transcript.providerThreadId).toBe('session-1');
    expect(transcript.model).toBe('gpt-5.2');
    expect(transcript.messages.map((message) => message.kind)).toEqual([
      'message',
      'reasoning',
      'tool',
      'tool',
      'message'
    ]);
  });

  it('deletes Copilot session-state folders from local history', async () => {
    const copilotHome = await tempCopilotHome();
    const sessionDir = path.join(copilotHome, 'session-state', 'session-delete');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, 'workspace.yaml'), 'cwd: /Users/me/projects/CodexPulse\n');

    const provider = new CopilotProvider({
      copilotHome,
      usageReader: { readUsage: async () => undefined }
    });

    await provider.deleteThread('copilot:session-delete');

    await expect(access(sessionDir)).rejects.toThrow();
  });

  it('lists the Copilot CLI supported model catalog', async () => {
    const provider = new CopilotProvider({
      copilotHome: await tempCopilotHome(),
      usageReader: { readUsage: async () => undefined }
    });

    const models = await provider.listModels();

    expect(models.map((model) => model.slug)).toEqual(
      expect.arrayContaining([
        'gpt-5.4',
        'claude-sonnet-4.5',
        'claude-opus-4.6',
        'gemini-3-pro-preview',
        'gpt-5.3-codex',
        'gpt-5.2-codex',
        'gpt-5.2',
        'gpt-4.1'
      ])
    );
    expect(models).toHaveLength(19);
    expect(models[0]).toMatchObject({
      provider: 'copilot',
      supportedReasoningLevels: expect.arrayContaining([
        { effort: 'xhigh', description: expect.any(String) }
      ])
    });
  });

  it('fails fast when Copilot rejects an unavailable model and hides it from the catalog', async () => {
    const copilotHome = await tempCopilotHome();
    await mkdir(path.join(copilotHome, 'logs'), { recursive: true });
    const child = fakeCopilotProcess();
    const spawnProcess = vi.fn(() => child.process) as unknown as typeof import('node:child_process').spawn;
    const provider = new CopilotProvider({
      copilotHome,
      spawnProcess,
      now: () => new Date('2026-05-01T17:10:32Z'),
      usageReader: { readUsage: async () => undefined }
    });

    const thread = await provider.startThread('/Users/me/projects/CodexPulse');
    const sendPromise = provider.sendMessage(thread.threadId, 'Hello Copilot', {
      model: 'claude-opus-4.6'
    });

    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));

    child.stderr.write('2026-05-01T17:10:32.428Z [ERROR] Model "claude-opus-4.6" from --model flag is not available.\n');
    child.process.emit('exit', 1);

    await expect(sendPromise).rejects.toThrow('Copilot model "claude-opus-4.6" is not available for this account.');

    const models = await provider.listModels();
    expect(models.find((model) => model.slug === 'claude-opus-4.6')).toMatchObject({
      visibility: 'hidden'
    });
    await expect(provider.setModel(thread.threadId, 'claude-opus-4.6')).rejects.toThrow(
      'Copilot model "claude-opus-4.6" is not available for this account.'
    );
  });

  it('fails the turn instead of staying running when the Copilot executable cannot spawn', async () => {
    const copilotHome = await tempCopilotHome();
    const spawnError = Object.assign(new Error('spawn copilot ENOENT'), { code: 'ENOENT' });
    const spawnProcess = vi.fn(() => {
      const child = fakeCopilotProcess();
      queueMicrotask(() => child.process.emit('error', spawnError));
      return child.process;
    }) as unknown as typeof import('node:child_process').spawn;
    const provider = new CopilotProvider({
      copilotHome,
      spawnProcess,
      usageReader: { readUsage: async () => undefined }
    });

    const thread = await provider.startThread('/Users/me/projects/CodexPulse');

    await expect(provider.sendMessage(thread.threadId, 'Hello Copilot')).rejects.toThrow(
      'GitHub Copilot could not start from Agent Pulse'
    );
    expect(provider.isThreadStreaming(thread.threadId)).toBe(false);
    const transcript = await provider.readTranscript(thread.threadId);
    expect(transcript.sendState).toMatchObject({ canSend: true, reason: 'ready' });
    expect(transcript.messages).toEqual([]);
  });

  it('keeps live Copilot messages ordered by timestamp when persisted activity arrives first', async () => {
    const copilotHome = await tempCopilotHome();
    const sessionDir = path.join(copilotHome, 'session-state', 'session-live');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'workspace.yaml'),
      [
        'id: session-live',
        'cwd: /Users/me/projects/CodexPulse',
        'created_at: 2026-04-25T16:13:00.000Z',
        'updated_at: 2026-04-25T16:14:05.000Z'
      ].join('\n')
    );
    await writeFile(
      path.join(sessionDir, 'events.jsonl'),
      [
        JSON.stringify({
          type: 'session.start',
          data: {
            sessionId: 'session-live',
            context: { cwd: '/Users/me/projects/CodexPulse' }
          },
          id: 'session-start',
          timestamp: '2026-04-25T16:13:00Z'
        }),
        JSON.stringify({
          type: 'tool.execution_complete',
          data: {
            toolCallId: 'tool-1',
            toolName: 'web_search',
            result: { content: 'Found one result.' }
          },
          id: 'tool-complete',
          timestamp: '2026-04-25T16:14:05Z'
        })
      ].join('\n')
    );
    const child = fakeCopilotProcess();
    const spawnProcess = vi.fn(() => child.process) as unknown as typeof import('node:child_process').spawn;
    const nowValues = [
      '2026-04-25T16:14:00Z',
      '2026-04-25T16:14:00Z',
      '2026-04-25T16:14:10Z'
    ];
    let nowIndex = 0;
    const provider = new CopilotProvider({
      copilotHome,
      spawnProcess,
      now: () => new Date(nowValues[Math.min(nowIndex++, nowValues.length - 1)]!),
      usageReader: { readUsage: async () => undefined }
    });

    const sendPromise = provider.sendMessage('copilot:session-live', 'Can you check this?');
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
    child.stdout.write(`${JSON.stringify({ type: 'assistant.message', content: 'Live answer.' })}\n`);

    const response = await sendPromise;
    expect(response.transcript.messages.map((message) => message.role)).toEqual([
      'user',
      'activity',
      'assistant'
    ]);
    expect(response.transcript.messages.map((message) => message.text)).toEqual([
      'Can you check this?',
      'web_search completed\nFound one result.',
      'Live answer.'
    ]);

    provider.dispose();
  });

  it('passes pasted images to Copilot as local file references', async () => {
    const copilotHome = await tempCopilotHome();
    const child = fakeCopilotProcess();
    const spawnMock = vi.fn((_command: string, _args: readonly string[], _options: unknown) => child.process);
    const provider = new CopilotProvider({
      copilotHome,
      spawnProcess: spawnMock as unknown as typeof import('node:child_process').spawn,
      now: () => new Date('2026-04-25T16:14:00Z'),
      usageReader: { readUsage: async () => undefined }
    });

    const thread = await provider.startThread('/Users/me/projects/CodexPulse');
    const sendPromise = provider.sendMessage(thread.threadId, 'Describe this image', {
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

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const args = spawnMock.mock.calls[0]![1] as string[];
    const prompt = args[args.indexOf('--prompt') + 1] ?? '';
    expect(args).toContain('--allow-all-paths');
    expect(prompt).toContain('Attached image files:');
    expect(prompt).toContain('Please inspect these image file paths as part of this message.');
    const filePath = /Image 1 \(image\/png\): ([^\n]+)/.exec(prompt)?.[1];
    expect(filePath).toBeTruthy();
    await access(filePath!);

    child.stdout.write(`${JSON.stringify({ type: 'assistant.message', content: 'Saw the attached image.' })}\n`);
    const response = await sendPromise;
    expect(response.transcript.messages[0]?.attachments?.[0]).toMatchObject({
      id: 'pasted-image-1',
      kind: 'image',
      url: 'data:image/png;base64,iVBORw0KGgo='
    });

    provider.dispose();
  });

  it('recognizes Copilot thread ids', () => {
    expect(isCopilotThreadId('copilot:abc')).toBe(true);
    expect(isCopilotThreadId('claude-code:abc')).toBe(false);
  });
});

function fakeCopilotProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
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
  return { process: process as unknown as ChildProcessWithoutNullStreams, stdout, stderr };
}
