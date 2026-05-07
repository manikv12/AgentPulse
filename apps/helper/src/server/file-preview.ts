import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ThreadFilePreviewResponseSchema,
  ThreadTranscriptSchema,
  type AgentProvider,
  type ChatMessage,
  type ThreadFileChangeFile,
  type ThreadFileChangeSummary,
  type ThreadFilePreviewResponse,
  type ThreadFileReference,
  type ThreadTranscript
} from '@agent-pulse/shared';

export const MAX_FILE_PREVIEW_BYTES = 512 * 1024;

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.log',
  '.csv',
  '.tsv',
  '.env',
  '.example',
  '.gitignore'
]);

const CODE_LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ['.bash', 'bash'],
  ['.c', 'c'],
  ['.cc', 'cpp'],
  ['.cjs', 'javascript'],
  ['.cpp', 'cpp'],
  ['.cs', 'csharp'],
  ['.css', 'css'],
  ['.go', 'go'],
  ['.h', 'c'],
  ['.hpp', 'cpp'],
  ['.html', 'html'],
  ['.java', 'java'],
  ['.js', 'javascript'],
  ['.json', 'json'],
  ['.jsonl', 'jsonl'],
  ['.jsx', 'jsx'],
  ['.kt', 'kotlin'],
  ['.mjs', 'javascript'],
  ['.php', 'php'],
  ['.py', 'python'],
  ['.rb', 'ruby'],
  ['.rs', 'rust'],
  ['.sass', 'sass'],
  ['.scss', 'scss'],
  ['.sh', 'bash'],
  ['.sql', 'sql'],
  ['.swift', 'swift'],
  ['.toml', 'toml'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.xml', 'xml'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.zsh', 'zsh']
]);

const CODE_BASENAMES = new Map<string, string>([
  ['Dockerfile', 'dockerfile'],
  ['Makefile', 'makefile'],
  ['Rakefile', 'ruby']
]);

const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\(([^)\s]+)\)/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const PLAIN_FILE_PATH_PATTERN =
  /(?:^|[\s("'[])(\.{0,2}\/)?([A-Za-z0-9_@().-]+\/)+[A-Za-z0-9_@().-]+\.[A-Za-z0-9]+(?=$|[\s"',.;:)\]])/g;
const BARE_FILE_NAME_PATTERN =
  /(?:^|[\s("'[])([A-Za-z0-9_@()-]+\.[A-Za-z][A-Za-z0-9]+)(?=$|[\s"',.;:)\]])/g;
const SKIPPED_BASENAME_SEARCH_DIRS = new Set([
  '.expo',
  '.git',
  '.next',
  '.pnpm',
  '.turbo',
  'Pods',
  'build',
  'dist',
  'node_modules'
]);

export class FilePreviewError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'FilePreviewError';
    this.status = status;
  }
}

export type ResolvedThreadFileReference = {
  reference: ThreadFileReference;
  absolutePath: string;
};

type FileReferenceExtractionInput = {
  threadId: string;
  cwd: string;
  provider: AgentProvider;
  message: ChatMessage;
};

export function decorateTranscriptFileReferences(
  transcript: ThreadTranscript,
  threadId: string,
  cwd?: string
): ThreadTranscript {
  if (!cwd) {
    return transcript;
  }

  const parsed = ThreadTranscriptSchema.parse(transcript);
  const provider = parsed.provider ?? 'codex';
  const messages = parsed.messages.map((message) => {
    const extracted = extractFileReferencesFromMessage({
      threadId,
      cwd,
      provider,
      message
    });
    if (extracted.length === 0) {
      return message;
    }
    return {
      ...message,
      fileReferences: mergeFileReferences(message.fileReferences, extracted)
    };
  });
  const fileChanges = parsed.fileChanges?.map((summary) =>
    decorateFileChangeSummary(summary, threadId, cwd)
  );

  return ThreadTranscriptSchema.parse({
    ...parsed,
    messages,
    ...(fileChanges ? { fileChanges } : {})
  });
}

export function extractFileReferencesFromMessage(
  input: FileReferenceExtractionInput
): ThreadFileReference[] {
  const candidates = extractCandidatePaths(input.message.text);
  const references: ThreadFileReference[] = [];
  const seenDisplayPaths = new Set<string>();

  for (const candidate of candidates) {
    const resolved = resolveThreadFileReferenceCandidate(candidate, input.cwd);
    if (!resolved || seenDisplayPaths.has(resolved.reference.displayPath)) {
      continue;
    }
    seenDisplayPaths.add(resolved.reference.displayPath);
    references.push({
      ...resolved.reference,
      id: threadFileReferenceId({
        threadId: input.threadId,
        displayPath: resolved.reference.displayPath,
        source: input.provider,
        messageId: input.message.id,
        turnId: input.message.turnId
      }),
      messageId: input.message.id,
      ...(input.message.turnId ? { turnId: input.message.turnId } : {}),
      source: input.provider
    });
  }

  return references;
}

export function extractCandidatePaths(text: string): string[] {
  const candidates: string[] = [];
  for (const pattern of [
    MARKDOWN_LINK_PATTERN,
    INLINE_CODE_PATTERN,
    PLAIN_FILE_PATH_PATTERN,
    BARE_FILE_NAME_PATTERN
  ]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = pattern === PLAIN_FILE_PATH_PATTERN ? match[0] : match[1];
      const cleaned = cleanCandidatePath(value);
      if (cleaned) {
        candidates.push(cleaned);
      }
    }
  }
  return candidates;
}

export function resolveThreadFileReferenceCandidate(
  candidate: string,
  cwd: string
): ResolvedThreadFileReference | undefined {
  const cleanPath = cleanCandidatePath(candidate);
  if (!cleanPath || looksLikeRemoteReference(cleanPath)) {
    return undefined;
  }

  const root = safeRealpath(cwd);
  if (!root) {
    return undefined;
  }

  const absoluteCandidate = path.isAbsolute(cleanPath)
    ? cleanPath
    : path.resolve(root, cleanPath);
  const realFilePath = safeRealpath(absoluteCandidate);
  const realPreviewPath = realFilePath && isPathInside(realFilePath, root)
    ? realFilePath
    : findUniqueFileByBasename(root, cleanPath);
  if (!realPreviewPath || !isPathInside(realPreviewPath, root)) {
    return undefined;
  }

  let stats;
  try {
    stats = statSync(realPreviewPath);
  } catch {
    return undefined;
  }
  if (!stats.isFile() || !isSupportedPreviewPath(realPreviewPath)) {
    return undefined;
  }

  const displayPath = normalizeDisplayPath(path.relative(root, realPreviewPath));
  const metadata = metadataForPath(displayPath, realPreviewPath);
  return {
    absolutePath: realPreviewPath,
    reference: {
      id: threadFileReferenceId({
        threadId: 'preview',
        displayPath,
        source: 'codex'
      }),
      label: path.basename(displayPath),
      displayPath,
      kind: metadata.kind,
      ...(metadata.language ? { language: metadata.language } : {}),
      source: 'codex'
    }
  };
}

export function findThreadFileReference(
  transcript: ThreadTranscript,
  fileReferenceId: string
): ThreadFileReference | undefined {
  const parsed = ThreadTranscriptSchema.parse(transcript);
  for (const message of parsed.messages) {
    const match = message.fileReferences?.find((reference) => reference.id === fileReferenceId);
    if (match) {
      return match;
    }
  }
  for (const summary of parsed.fileChanges ?? []) {
    for (const file of summary.files) {
      if (file.reference?.id === fileReferenceId) {
        return file.reference;
      }
    }
  }
  return undefined;
}

export function findThreadFileReferenceCwd(
  transcript: ThreadTranscript,
  fileReferenceId: string
): string | undefined {
  const parsed = ThreadTranscriptSchema.parse(transcript);
  for (const summary of parsed.fileChanges ?? []) {
    for (const file of summary.files) {
      if (file.reference?.id === fileReferenceId) {
        return summary.cwd;
      }
    }
  }
  return undefined;
}

export async function readThreadFilePreview(
  reference: ThreadFileReference,
  cwd: string
): Promise<ThreadFilePreviewResponse> {
  const resolved = resolveThreadFileReferenceCandidate(reference.displayPath, cwd);
  if (!resolved) {
    throw new FilePreviewError(404, 'This file cannot be previewed from the phone.');
  }

  const stats = statSync(resolved.absolutePath);
  if (stats.size > MAX_FILE_PREVIEW_BYTES) {
    throw new FilePreviewError(413, 'This file is too large to preview from the phone.');
  }

  const buffer = await readFile(resolved.absolutePath);
  if (buffer.includes(0)) {
    throw new FilePreviewError(415, 'This file cannot be previewed from the phone.');
  }

  const content = buffer.toString('utf8');
  if (content.includes('\uFFFD')) {
    throw new FilePreviewError(415, 'This file cannot be previewed from the phone.');
  }

  return ThreadFilePreviewResponseSchema.parse({
    metadata: {
      ...reference,
      label: resolved.reference.label,
      displayPath: resolved.reference.displayPath,
      kind: resolved.reference.kind,
      language: resolved.reference.language,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString()
    },
    content
  });
}

export function threadFileReferenceId(input: {
  threadId: string;
  displayPath: string;
  source: ThreadFileReference['source'];
  messageId?: string;
  turnId?: string;
}): string {
  const hash = createHash('sha256')
    .update([
      input.threadId,
      input.source,
      input.displayPath,
      input.messageId ?? '',
      input.turnId ?? ''
    ].join('\0'))
    .digest('base64url')
    .slice(0, 22);
  return `file_${hash}`;
}

function decorateFileChangeSummary(
  summary: ThreadFileChangeSummary,
  threadId: string,
  threadCwd: string
): ThreadFileChangeSummary {
  const cwd = summary.cwd ?? threadCwd;
  const files = summary.files.map((file) => decorateFileChangeFile(file, summary, threadId, cwd));
  return {
    ...summary,
    files
  };
}

function decorateFileChangeFile(
  file: ThreadFileChangeFile,
  summary: ThreadFileChangeSummary,
  threadId: string,
  cwd: string
): ThreadFileChangeFile {
  const resolved = resolveThreadFileReferenceCandidate(file.path, cwd);
  if (!resolved) {
    return file;
  }
  return {
    ...file,
    reference: {
      ...resolved.reference,
      id: threadFileReferenceId({
        threadId,
        displayPath: resolved.reference.displayPath,
        source: 'file-change',
        turnId: summary.turnId
      }),
      ...(summary.turnId ? { turnId: summary.turnId } : {}),
      source: 'file-change'
    }
  };
}

function mergeFileReferences(
  existing: ThreadFileReference[] | undefined,
  next: ThreadFileReference[]
): ThreadFileReference[] {
  const merged: ThreadFileReference[] = [];
  const seen = new Set<string>();
  for (const reference of [...(existing ?? []), ...next]) {
    const key = `${reference.source}:${reference.displayPath}:${reference.messageId ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(reference);
  }
  return merged;
}

function metadataForPath(
  displayPath: string,
  absolutePath: string
): Pick<ThreadFileReference, 'kind' | 'language'> {
  const basename = path.basename(displayPath);
  const ext = path.extname(absolutePath).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return { kind: 'markdown', language: 'markdown' };
  }
  const codeLanguage = CODE_LANGUAGE_BY_EXTENSION.get(ext) ?? CODE_BASENAMES.get(basename);
  if (codeLanguage) {
    return { kind: 'code', language: codeLanguage };
  }
  return { kind: 'text' };
}

function isSupportedPreviewPath(filePath: string): boolean {
  const basename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  return (
    MARKDOWN_EXTENSIONS.has(ext) ||
    TEXT_EXTENSIONS.has(ext) ||
    CODE_LANGUAGE_BY_EXTENSION.has(ext) ||
    CODE_BASENAMES.has(basename)
  );
}

function findUniqueFileByBasename(root: string, candidate: string): string | undefined {
  if (candidate.includes('/') || candidate.includes(path.sep) || path.isAbsolute(candidate)) {
    return undefined;
  }
  const basename = path.basename(candidate);
  if (!isSupportedPreviewPath(basename)) {
    return undefined;
  }
  let match: string | undefined;
  let matchCount = 0;
  const visit = (dir: string, depth: number) => {
    if (matchCount > 1 || depth > 8) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matchCount > 1) {
        return;
      }
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_BASENAME_SEARCH_DIRS.has(entry.name)) {
          visit(entryPath, depth + 1);
        }
        continue;
      }
      if (entry.isFile() && entry.name === basename && isSupportedPreviewPath(entryPath)) {
        const realEntryPath = safeRealpath(entryPath);
        if (realEntryPath && isPathInside(realEntryPath, root)) {
          match = realEntryPath;
          matchCount += 1;
        }
      }
    }
  };
  visit(root, 0);
  return matchCount === 1 ? match : undefined;
}

function cleanCandidatePath(candidate: string | undefined): string | undefined {
  if (!candidate) {
    return undefined;
  }
  let cleaned = candidate.trim();
  cleaned = cleaned.replace(/^[`"'([{<]+/, '');
  cleaned = stripLineSuffix(cleaned);
  while (/[.,;:]+$/.test(cleaned)) {
    cleaned = cleaned.slice(0, -1);
  }
  while (cleaned.endsWith(')') && countChar(cleaned, ')') > countChar(cleaned, '(')) {
    cleaned = cleaned.slice(0, -1);
  }
  while (cleaned.endsWith(']') && countChar(cleaned, ']') > countChar(cleaned, '[')) {
    cleaned = cleaned.slice(0, -1);
  }
  cleaned = cleaned.trim();
  if (
    !cleaned ||
    cleaned.includes('\0') ||
    cleaned.startsWith('~') ||
    cleaned === '.' ||
    cleaned === '..'
  ) {
    return undefined;
  }
  return cleaned;
}

function stripLineSuffix(candidate: string): string {
  return candidate.replace(/:(\d+)(?::\d+)?$/, '');
}

function looksLikeRemoteReference(candidate: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) || candidate.startsWith('mailto:');
}

function safeRealpath(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) {
      return undefined;
    }
    return realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function isPathInside(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeDisplayPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (const character of value) {
    if (character === char) {
      count += 1;
    }
  }
  return count;
}
