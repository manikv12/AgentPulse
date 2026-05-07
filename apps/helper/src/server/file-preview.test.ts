import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentProvider, ThreadTranscript } from '@agent-pulse/shared';
import {
  decorateTranscriptFileReferences,
  readThreadFilePreview,
  resolveThreadFileReferenceCandidate
} from './file-preview';

describe('file preview helpers', () => {
  it('extracts markdown and code paths from Codex assistant text', () => {
    const workspace = createWorkspace({
      'docs/PLAN.md': '# Plan\n',
      'src/app.ts': 'export const ok = true;\n'
    });

    const transcript = decorateTranscriptFileReferences(
      transcriptWithMessage(
        'codex',
        'Created the plan here: docs/PLAN.md and updated `src/app.ts`.'
      ),
      'thread-codex',
      workspace
    );

    expect(transcript.messages[0]?.fileReferences).toMatchObject([
      {
        displayPath: 'src/app.ts',
        kind: 'code',
        language: 'typescript',
        source: 'codex'
      },
      {
        displayPath: 'docs/PLAN.md',
        kind: 'markdown',
        language: 'markdown',
        source: 'codex'
      }
    ]);
  });

  it('extracts file paths from Copilot messages with the same shared shape', () => {
    const workspace = createWorkspace({
      'src/index.ts': 'console.log("hello");\n'
    });

    const transcript = decorateTranscriptFileReferences(
      transcriptWithMessage('copilot', 'Wrote `src/index.ts` for the app.'),
      'copilot-thread-1',
      workspace
    );

    expect(transcript.messages[0]?.fileReferences?.[0]).toMatchObject({
      displayPath: 'src/index.ts',
      kind: 'code',
      source: 'copilot'
    });
  });

  it('resolves a bare filename when it is unique inside the workspace', () => {
    const workspace = createWorkspace({
      'Phone App/src/components/phone/workspace-components.tsx': 'export function ChatSurface() {}\n'
    });

    const transcript = decorateTranscriptFileReferences(
      transcriptWithMessage('codex', 'Changed in workspace-components.tsx.'),
      'thread-codex',
      workspace
    );

    expect(transcript.messages[0]?.fileReferences?.[0]).toMatchObject({
      displayPath: 'Phone App/src/components/phone/workspace-components.tsx',
      kind: 'code',
      source: 'codex'
    });
  });

  it('does not resolve a bare filename when it is ambiguous', () => {
    const workspace = createWorkspace({
      'src/index.ts': 'console.log("src");\n',
      'tests/index.ts': 'console.log("tests");\n'
    });

    const transcript = decorateTranscriptFileReferences(
      transcriptWithMessage('codex', 'Updated index.ts.'),
      'thread-codex',
      workspace
    );

    expect(transcript.messages[0]?.fileReferences).toBeUndefined();
  });

  it('attaches preview references to file-change rows', () => {
    const workspace = createWorkspace({
      'docs/CHANGELOG.md': '# Changelog\n'
    });

    const transcript = decorateTranscriptFileReferences(
      {
        ...transcriptWithMessage('codex', 'Done.'),
        fileChanges: [
          {
            id: 'change-1',
            threadId: 'thread-codex',
            cwd: workspace,
            fileCount: 1,
            linesAdded: 2,
            linesDeleted: 0,
            files: [{ path: 'docs/CHANGELOG.md', linesAdded: 2, linesDeleted: 0 }],
            action: 'undo',
            canUseCodexApplyPatch: true
          }
        ]
      },
      'thread-codex',
      workspace
    );

    expect(transcript.fileChanges?.[0]?.files[0]?.reference).toMatchObject({
      displayPath: 'docs/CHANGELOG.md',
      kind: 'markdown',
      source: 'file-change'
    });
  });

  it('rejects missing files, folders, and outside-workspace paths', () => {
    const workspace = createWorkspace({
      'docs/PLAN.md': '# Plan\n'
    });
    mkdirSync(path.join(workspace, 'docs', 'folder'));
    const outside = mkdtempSync(path.join(tmpdir(), 'agent-pulse-outside-'));
    writeFileSync(path.join(outside, 'secret.md'), '# Secret\n', 'utf8');

    expect(resolveThreadFileReferenceCandidate('docs/PLAN.md', workspace)).toBeDefined();
    expect(resolveThreadFileReferenceCandidate('docs/MISSING.md', workspace)).toBeUndefined();
    expect(resolveThreadFileReferenceCandidate('docs/folder', workspace)).toBeUndefined();
    expect(
      resolveThreadFileReferenceCandidate(path.join(outside, 'secret.md'), workspace)
    ).toBeUndefined();
  });

  it('reads safe markdown previews and keeps the metadata stable', async () => {
    const workspace = createWorkspace({
      'docs/TEST_PLAN.md': '# Test Plan\n\n- Check the modal.\n'
    });
    const transcript = decorateTranscriptFileReferences(
      transcriptWithMessage('codex', 'Created docs/TEST_PLAN.md.'),
      'thread-codex',
      workspace
    );
    const reference = transcript.messages[0]?.fileReferences?.[0];

    expect(reference).toBeDefined();
    const preview = await readThreadFilePreview(reference!, workspace);

    expect(preview.metadata).toMatchObject({
      displayPath: 'docs/TEST_PLAN.md',
      kind: 'markdown',
      source: 'codex'
    });
    expect(preview.content).toContain('Check the modal.');
  });
});

function createWorkspace(files: Record<string, string>): string {
  const workspace = mkdtempSync(path.join(tmpdir(), 'agent-pulse-preview-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(workspace, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
  }
  return workspace;
}

function transcriptWithMessage(provider: AgentProvider, text: string): ThreadTranscript {
  return {
    threadId: provider === 'copilot' ? 'copilot-thread-1' : 'thread-codex',
    provider,
    activeTurnId: null,
    sendState: { canSend: true, reason: 'ready', label: 'Ready' },
    messages: [
      {
        id: 'message-1',
        role: 'assistant',
        kind: 'message',
        text,
        createdAt: '2026-05-07T00:00:00.000Z'
      }
    ]
  };
}
