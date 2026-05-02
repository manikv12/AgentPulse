import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decorateSharedChatThread,
  filterSharedChatProjects,
  isHomeWorkspacePath,
  isSharedChatPath
} from './shared-chat-paths';

describe('shared chat paths', () => {
  it('treats the shared Chats root and provider folders as chat paths', () => {
    const chatRoot = path.join(homedir(), 'Library', 'Application Support', 'Agent Pulse', 'Chats');

    expect(isSharedChatPath(chatRoot, chatRoot)).toBe(true);
    expect(isSharedChatPath(path.join(chatRoot, 'codex', '2026-05-01-chat'), chatRoot)).toBe(true);
  });

  it('treats the user home workspace bucket as Chats for every provider', () => {
    const home = homedir();

    expect(isHomeWorkspacePath(home)).toBe(true);
    expect(
      decorateSharedChatThread({
        threadId: 'claude-code:thread-home',
        provider: 'claude-code',
        title: 'Regular chat',
        workspace: path.basename(home),
        workspacePath: home,
        status: 'idle',
        lastActivityAt: '2026-05-01T10:00:00Z',
        lastTurnSummary: ''
      })
    ).toMatchObject({
      workspace: 'Chats',
      workspaceKind: 'chat'
    });
    expect(
      filterSharedChatProjects([
        {
          projectId: 'home',
          name: path.basename(home),
          path: home,
          providers: ['claude-code']
        }
      ])
    ).toEqual([]);
  });
});
