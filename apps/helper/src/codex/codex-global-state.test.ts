import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerCodexProjectlessChat } from './codex-global-state';

describe('Codex global state helpers', () => {
  it('registers shared Agent Pulse chats as Codex projectless chats', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-pulse-codex-state-'));
    const globalStatePath = path.join(dir, '.codex-global-state.json');
    const chatRoot = path.join(dir, 'Application Support', 'Agent Pulse', 'Chats');
    await writeFile(
      globalStatePath,
      JSON.stringify({
        'projectless-thread-ids': ['thread-existing'],
        'thread-workspace-root-hints': {
          'thread-existing': '/Users/me/Documents/Codex'
        },
        'electron-saved-workspace-roots': ['/Users/me/projects/CodexPulse']
      }),
      'utf8'
    );

    await registerCodexProjectlessChat('thread-new', {
      globalStatePath,
      chatRoot
    });
    await registerCodexProjectlessChat('thread-new', {
      globalStatePath,
      chatRoot
    });

    const state = JSON.parse(await readFile(globalStatePath, 'utf8')) as Record<string, unknown>;
    expect(state['projectless-thread-ids']).toEqual(['thread-existing', 'thread-new']);
    expect(state['thread-workspace-root-hints']).toMatchObject({
      'thread-existing': '/Users/me/Documents/Codex',
      'thread-new': chatRoot
    });
    expect(state['electron-saved-workspace-roots']).toEqual(['/Users/me/projects/CodexPulse']);
  });

  it('serializes concurrent shared chat registrations without temp file collisions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-pulse-codex-state-'));
    const globalStatePath = path.join(dir, '.codex-global-state.json');
    const chatRoot = path.join(dir, 'Application Support', 'Agent Pulse', 'Chats');
    const threadIds = Array.from({ length: 25 }, (_, index) => `thread-${index}`);

    await Promise.all(
      threadIds.map((threadId) =>
        registerCodexProjectlessChat(threadId, {
          globalStatePath,
          chatRoot
        })
      )
    );

    const state = JSON.parse(await readFile(globalStatePath, 'utf8')) as Record<string, unknown>;
    expect(state['projectless-thread-ids']).toEqual(threadIds);
    expect(state['thread-workspace-root-hints']).toEqual(
      Object.fromEntries(threadIds.map((threadId) => [threadId, chatRoot]))
    );
  });

  it('recovers a valid first JSON object when the state file has trailing corrupted JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-pulse-codex-state-'));
    const globalStatePath = path.join(dir, '.codex-global-state.json');
    const chatRoot = path.join(dir, 'Application Support', 'Agent Pulse', 'Chats');
    await writeFile(
      globalStatePath,
      `${JSON.stringify({
        'projectless-thread-ids': ['thread-existing'],
        'thread-workspace-root-hints': {
          'thread-existing': '/Users/me/Documents/Codex'
        }
      })}${JSON.stringify({ trailing: true })}`,
      'utf8'
    );

    await registerCodexProjectlessChat('thread-new', {
      globalStatePath,
      chatRoot
    });

    const state = JSON.parse(await readFile(globalStatePath, 'utf8')) as Record<string, unknown>;
    expect(state['projectless-thread-ids']).toEqual(['thread-existing', 'thread-new']);
    expect(state['thread-workspace-root-hints']).toMatchObject({
      'thread-existing': '/Users/me/Documents/Codex',
      'thread-new': chatRoot
    });
  });
});
