import type {
  CatalogCommand,
  CatalogModel,
  CatalogPlugin,
  CatalogSkill,
  ChatAttachment,
  ChatMessage,
  Thread,
  ThreadMessageResponse,
  ThreadTranscript,
  ThreadUsage
} from '@agent-pulse/shared';
import {
  ArrowUp,
  Brain,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileEdit,
  Info,
  ListChecks,
  Menu,
  Plus,
  Terminal,
  Wrench,
  X
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FetchThreadTranscriptOptions } from './api';
import { CodexMark } from './CodexMark';
import { MentionPicker, type MentionItem, type MentionTrigger } from './MentionPicker';

const INITIAL_TRANSCRIPT_MESSAGE_LIMIT = 40;

export type ThreadPendingRequest = {
  id: string;
  method: string;
  title: string;
  body?: string;
  itemId?: string;
  turnId?: string;
  kind?: 'question' | 'plan' | 'commandApproval' | 'fileApproval' | 'permissionsApproval';
};

export type ApprovalMethodForUi =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval';

export type ThreadViewProps = {
  thread: Thread;
  onClose?: () => void;
  onOpenSidebar?: () => void;
  fetchTranscript?: (
    threadId: string,
    options?: FetchThreadTranscriptOptions
  ) => Promise<ThreadTranscript>;
  sendMessage?: (threadId: string, text: string) => Promise<ThreadMessageResponse>;
  openThreadInCodex?: (threadId: string) => Promise<void>;
  liveTranscript?: ThreadTranscript;
  modelName?: string;
  pendingRequests?: ThreadPendingRequest[];
  forceWorking?: boolean;
  plugins?: CatalogPlugin[];
  skills?: CatalogSkill[];
  commands?: CatalogCommand[];
  models?: CatalogModel[];
  fetchProjectFiles?: (query: string) => Promise<{ path: string; relativePath: string }[]>;
  onChangeModel?: (modelSlug: string, reasoningEffort?: string) => Promise<void>;
  onApprovalDecision?: (
    requestId: string,
    method: ApprovalMethodForUi,
    decision: string | Record<string, unknown>
  ) => Promise<void>;
  selectedModelSlug?: string;
  selectedReasoningEffort?: string;
};

// ─── Utilities ───────────────────────────────────────────────────────────────

function matchPluginFromToolText(
  text: string,
  plugins: CatalogPlugin[]
): CatalogPlugin | undefined {
  if (!text || plugins.length === 0) {
    return undefined;
  }
  const lowered = text.toLowerCase();
  const head = lowered.split(/\s|\.|:/, 1)[0]?.replace(/^@/, '') ?? '';
  if (!head) {
    return undefined;
  }
  for (const plugin of plugins) {
    if (plugin.slug.toLowerCase() === head) {
      return plugin;
    }
    if (plugin.aliases?.some((alias) => alias.toLowerCase() === head)) {
      return plugin;
    }
  }
  return undefined;
}

function detectMentionAtCaret(
  value: string,
  caret: number
): { trigger: MentionTrigger; query: string; start: number; end: number } | undefined {
  const upToCaret = value.slice(0, caret);
  const match = upToCaret.match(/(^|\s)([@/])([^\s]*)$/);
  if (!match) {
    return undefined;
  }
  const trigger = match[2] as MentionTrigger;
  const query = match[3];
  const start = caret - query.length - 1;
  return { trigger, query, start, end: caret };
}

function formatModelName(slug: string | undefined): string {
  const value = slug?.trim();
  if (!value) {
    return 'Codex';
  }
  if (/^gpt-/i.test(value)) {
    return value.replace(/^gpt-/i, 'GPT-');
  }
  if (/^o\d/i.test(value)) {
    return value.toUpperCase();
  }
  return value;
}

function truncate(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max - 1).trimEnd()}…` : input;
}

function formatCommandSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const stripped = oneLine
    .replace(/^\/bin\/(?:ba|z)?sh\s+-l?c\s+/, '')
    .replace(/^["']|["']$/g, '');
  return truncate(stripped, 90);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

type ActivityKind = ChatMessage['kind'];

const ACTIVITY_ICONS: Record<ActivityKind, LucideIcon> = {
  message: Info,
  plan: ListChecks,
  reasoning: Brain,
  command: Terminal,
  file: FileEdit,
  tool: Wrench,
  status: Info
};

type RenderableEntry =
  | { type: 'message'; message: ChatMessage }
  | { type: 'event'; message: ChatMessage }
  | {
      type: 'work';
      id: string;
      messages: ChatMessage[];
      startedAt?: string;
      endedAt?: string;
    };

function buildRenderableEntries(messages: ChatMessage[]): RenderableEntry[] {
  const result: RenderableEntry[] = [];
  let turnBuffer: ChatMessage[] = [];

  const flushTurn = () => {
    if (turnBuffer.length === 0) {
      return;
    }

    const finalIndex = findFinalResponseIndex(turnBuffer);
    const finalMessage = finalIndex >= 0 ? turnBuffer[finalIndex]! : null;
    const workMessages = finalMessage
      ? turnBuffer.filter((_, index) => index !== finalIndex)
      : turnBuffer.slice();

    if (workMessages.length > 0) {
      const startedAt = workMessages[0]?.createdAt;
      const endedAt = finalMessage?.createdAt ?? workMessages[workMessages.length - 1]?.createdAt;
      result.push({
        type: 'work',
        id: `work-${workMessages[0]?.id ?? result.length}`,
        messages: workMessages,
        startedAt,
        endedAt
      });
    }

    if (finalMessage) {
      result.push({ type: 'message', message: finalMessage });
    }

    turnBuffer = [];
  };

  for (const message of messages) {
    if (message.role === 'user') {
      flushTurn();
      result.push({ type: 'message', message });
      continue;
    }

    turnBuffer.push(message);
  }

  flushTurn();
  return result;
}

function findFinalResponseIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.phase === 'final_answer' && message.text.trim()) {
      return index;
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.phase !== 'commentary' && message.text.trim()) {
      return index;
    }
  }

  return -1;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MessageAttachments({
  attachments,
  compact = false
}: {
  attachments?: ChatAttachment[];
  compact?: boolean;
}) {
  const [preview, setPreview] = useState<ChatAttachment | null>(null);

  useEffect(() => {
    if (!preview) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreview(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [preview]);

  if (!attachments?.length) {
    return null;
  }

  return (
    <>
      <div className={`codex-attachment-gallery ${compact ? 'is-compact' : ''}`}>
        {attachments.map((attachment) => {
          const alt = attachment.alt ?? 'Screenshot';
          return (
            <button
              key={attachment.id}
              type="button"
              className="codex-attachment-thumb"
              onClick={() => setPreview(attachment)}
              aria-label={`Open ${alt}`}
            >
              <img
                className="codex-attachment-thumb-image"
                src={attachment.url}
                alt={alt}
                loading="lazy"
              />
            </button>
          );
        })}
      </div>
      {preview ? (
        <div
          className="codex-attachment-preview-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={preview.alt ?? 'Screenshot'}
          onClick={() => setPreview(null)}
        >
          <div className="codex-attachment-preview" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="codex-attachment-preview-close"
              onClick={() => setPreview(null)}
              aria-label="Close screenshot preview"
            >
              <X size={18} />
            </button>
            <img
              className="codex-attachment-preview-image"
              src={preview.url}
              alt={`${preview.alt ?? 'Screenshot'} preview`}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function EventRow({
  message,
  plugins = []
}: {
  message: ChatMessage;
  plugins?: CatalogPlugin[];
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = ACTIVITY_ICONS[message.kind];
  const matchedPlugin = useMemo(() => {
    if (message.kind !== 'tool') {
      return undefined;
    }
    return matchPluginFromToolText(message.text, plugins);
  }, [message.kind, message.text, plugins]);

  const labelNode = useMemo(() => {
    switch (message.kind) {
      case 'command': {
        const summary = formatCommandSummary(message.text);
        return <code>{summary}</code>;
      }
      case 'file':
      case 'tool':
      case 'status': {
        return <span>{truncate(message.text.replace(/\s+/g, ' ').trim(), 90)}</span>;
      }
      case 'message': {
        const firstLine = message.text.split('\n').find((l) => l.trim().length > 0) ?? '';
        return <span>{truncate(firstLine.trim(), 90) || 'Agent update'}</span>;
      }
      case 'reasoning': {
        const firstLine = message.text.split('\n').find((l) => l.trim().length > 0) ?? '';
        return <span>{truncate(firstLine.trim(), 80) || 'Thought'}</span>;
      }
      default: {
        return <span>{truncate(message.text.replace(/\s+/g, ' ').trim(), 90)}</span>;
      }
    }
  }, [message.kind, message.text]);

  return (
    <div className="codex-event">
      <button
        type="button"
        className="codex-event-row"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="codex-event-icon" aria-hidden="true">
          {matchedPlugin?.iconUrl ? (
            <img
              className="codex-event-plugin-icon"
              src={matchedPlugin.iconUrl}
              alt=""
            />
          ) : (
            <Icon size={13} />
          )}
        </span>
        <span className="codex-event-text">
          {matchedPlugin ? (
            <span className="codex-event-plugin-name">{matchedPlugin.displayName}</span>
          ) : null}
          {labelNode}
        </span>
        <ChevronDown
          size={12}
          className={`codex-event-chevron ${expanded ? 'is-open' : ''}`}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div className="codex-event-detail">
          {message.kind === 'message' ? (
            <MessageMarkdown text={message.text} />
          ) : (
            <pre className="codex-event-body">{message.text}</pre>
          )}
          <MessageAttachments attachments={message.attachments} compact />
        </div>
      ) : null}
    </div>
  );
}

function WorkGroup({
  messages,
  startedAt,
  endedAt,
  plugins = []
}: {
  messages: ChatMessage[];
  startedAt?: string;
  endedAt?: string;
  plugins?: CatalogPlugin[];
}) {
  const [expanded, setExpanded] = useState(false);
  const label = useMemo(() => formatWorkLabel(messages, startedAt, endedAt), [
    endedAt,
    messages,
    startedAt
  ]);
  const imageCount = messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0);

  return (
    <section className={`codex-work-group ${expanded ? 'is-open' : ''}`}>
      <button
        type="button"
        className="codex-work-toggle"
        onClick={() => setExpanded((previous) => !previous)}
        aria-expanded={expanded}
      >
        <span>{label}</span>
        <ChevronDown
          size={14}
          className={`codex-work-chevron ${expanded ? 'is-open' : ''}`}
          aria-hidden="true"
        />
        {imageCount > 0 ? (
          <span className="codex-work-meta">
            {imageCount} screenshot{imageCount === 1 ? '' : 's'}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="codex-work-body">
          {messages.map((message) => (
            <EventRow key={message.id} message={message} plugins={plugins} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function formatWorkLabel(messages: ChatMessage[], startedAt?: string, endedAt?: string): string {
  const first = Date.parse(startedAt ?? messages[0]?.createdAt ?? '');
  const last = Date.parse(endedAt ?? messages[messages.length - 1]?.createdAt ?? '');
  if (Number.isFinite(first) && Number.isFinite(last) && last > first) {
    const seconds = Math.round((last - first) / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0) {
      return `Worked for ${minutes}m ${remainingSeconds}s`;
    }
    return `Worked for ${seconds}s`;
  }
  return `Agent work · ${messages.length} update${messages.length === 1 ? '' : 's'}`;
}

// ─── Main component ──────────────────────────────────────────────────────────

export function ThreadView({
  thread,
  onClose,
  onOpenSidebar,
  fetchTranscript,
  sendMessage,
  openThreadInCodex,
  liveTranscript,
  modelName,
  pendingRequests = [],
  plugins = [],
  skills = [],
  commands = [],
  models = [],
  fetchProjectFiles,
  onChangeModel,
  onApprovalDecision,
  selectedModelSlug,
  selectedReasoningEffort,
  forceWorking = false
}: ThreadViewProps) {
  const [transcript, setTranscript] = useState<ThreadTranscript | undefined>();
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(Boolean(fetchTranscript));
  const [sending, setSending] = useState(false);
  const [openingCodex, setOpeningCodex] = useState(false);
  const [error, setError] = useState('');
  const [mention, setMention] = useState<{ trigger: MentionTrigger; query: string; start: number; end: number } | undefined>();
  const [files, setFiles] = useState<{ path: string; relativePath: string }[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelUpdating, setModelUpdating] = useState(false);
  // Optimistic local copies of just-sent user messages. These get merged into `renderable`
  // immediately on send so the chat shows the bubble without waiting for the round-trip
  // transcript fetch (which can lag several seconds while Codex is streaming the reply).
  // An entry is dropped as soon as a message with the same trimmed text appears in the
  // server transcript.
  const [pendingMessages, setPendingMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRequestsInFlight = useRef(0);

  const trimmedDraft = draft.trim();
  const canSend = Boolean(transcript?.sendState.canSend && trimmedDraft && sendMessage && !sending);
  const isAgentWorking =
    forceWorking || Boolean(transcript?.activeTurnId) || thread.status === 'running';
  const effectiveModelName = modelName || thread.model;

  // Status bar text logic:
  // - When sending: "Sending to Codex..."
  // - When sendState blocks sending: show the explicit reason (e.g. "Approve on Mac to continue")
  //   even if a turn is live, so the user can see why the input is disabled.
  // - Else when activeTurnId is set: "Codex is working"
  // - Otherwise: sendState.label (which may be "Ready", "Mobile sending is off on the Mac.", etc.)
  // - If loading and no transcript yet: "Loading conversation..."
  const sendBlockedLabel =
    transcript && !transcript.sendState.canSend ? transcript.sendState.label : null;
  const statusText = sending
    ? 'Sending to Codex...'
    : sendBlockedLabel
      ? sendBlockedLabel
      : transcript?.activeTurnId
        ? 'Codex is working'
        : transcript?.sendState.label ?? (loading ? 'Loading conversation...' : '');

  const renderable = useMemo(() => {
    const real =
      transcript?.messages.filter(
        (message) => message.role !== 'activity' || message.text.trim().length > 0
      ) ?? [];
    // Drop pending entries whose text already shows up in the real transcript, then append
    // any remaining ones at the end so the user sees their just-sent message immediately.
    const realUserTexts = new Set(
      real.filter((m) => m.role === 'user').map((m) => m.text.trim())
    );
    const stillPending = pendingMessages.filter((m) => !realUserTexts.has(m.text.trim()));
    return buildRenderableEntries([...real, ...stillPending]);
  }, [transcript?.messages, pendingMessages]);

  // Reconcile pendingMessages whenever the transcript changes — once the server confirms a
  // pending message, drop it from local state so duplicates don't pile up.
  useEffect(() => {
    if (pendingMessages.length === 0) return;
    const realUserTexts = new Set(
      (transcript?.messages ?? [])
        .filter((m) => m.role === 'user')
        .map((m) => m.text.trim())
    );
    setPendingMessages((current) => {
      const next = current.filter((m) => !realUserTexts.has(m.text.trim()));
      return next.length === current.length ? current : next;
    });
  }, [transcript?.messages, pendingMessages.length]);

  // Clear pending state when switching threads — they're per-thread.
  useEffect(() => {
    setPendingMessages([]);
  }, [thread.threadId]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const node = messagesRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [transcript?.messages.length, transcript?.activeTurnId, loading]);

  // Apply live transcript updates immediately (WebSocket path)
  useEffect(() => {
    if (liveTranscript) {
      setTranscript(liveTranscript);
    }
  }, [liveTranscript]);

  // Initial transcript fetch
  useEffect(() => {
    let cancelled = false;
    setError('');

    setTranscript((current) => {
      if (liveTranscript?.threadId === thread.threadId) {
        return liveTranscript;
      }
      if (current?.threadId === thread.threadId) {
        return current;
      }
      return undefined;
    });

    if (!fetchTranscript) {
      setLoading(false);
      return;
    }

    setLoading(!liveTranscript || liveTranscript.threadId !== thread.threadId);
    transcriptRequestsInFlight.current += 1;
    fetchTranscript(thread.threadId, { messageLimit: INITIAL_TRANSCRIPT_MESSAGE_LIMIT })
      .then((nextTranscript) => {
        if (!cancelled) {
          setTranscript(nextTranscript);
        }
      })
      .catch((loadError: unknown) => {
        if (cancelled) {
          return;
        }
        const haveLive = liveTranscript?.threadId === thread.threadId;
        if (haveLive) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : 'Could not load this thread.');
      })
      .finally(() => {
        transcriptRequestsInFlight.current = Math.max(0, transcriptRequestsInFlight.current - 1);
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fetchTranscript, thread.threadId]);

  // Polling every 3 seconds
  useEffect(() => {
    if (!fetchTranscript) {
      return;
    }

    let cancelled = false;
    const interval = window.setInterval(() => {
      if (transcriptRequestsInFlight.current > 0) {
        return;
      }

      transcriptRequestsInFlight.current += 1;
      fetchTranscript(thread.threadId, { messageLimit: INITIAL_TRANSCRIPT_MESSAGE_LIMIT })
        .then((nextTranscript) => {
          if (!cancelled) {
            setTranscript(nextTranscript);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          transcriptRequestsInFlight.current = Math.max(0, transcriptRequestsInFlight.current - 1);
        });
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [fetchTranscript, thread.threadId]);

  useEffect(() => {
    if (!mention || mention.trigger !== '@' || !fetchProjectFiles) {
      setFiles([]);
      setFilesLoading(false);
      return;
    }
    const query = mention.query;
    setFilesLoading(true);
    const handle = window.setTimeout(() => {
      void fetchProjectFiles(query)
        .then((next) => setFiles(next))
        .catch(() => setFiles([]))
        .finally(() => setFilesLoading(false));
    }, 150);
    return () => {
      window.clearTimeout(handle);
    };
  }, [mention?.trigger, mention?.query, fetchProjectFiles]);

  const updateMentionFromCursor = (value: string, caret: number) => {
    const detected = detectMentionAtCaret(value, caret);
    setMention(detected ?? undefined);
  };

  const onDraftChange = (next: string, caret: number) => {
    setDraft(next);
    updateMentionFromCursor(next, caret);
  };

  const insertMention = (item: MentionItem) => {
    if (!mention) {
      return;
    }
    const before = draft.slice(0, mention.start);
    const after = draft.slice(mention.end);
    const insertion = item.insertText;
    const next = `${before}${insertion}${after}`;
    setDraft(next);
    setMention(undefined);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        const caret = before.length + insertion.length;
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      }
    });
  };

  const handleSend = async () => {
    if (!sendMessage || !canSend) {
      return;
    }

    const textToSend = trimmedDraft;
    // Optimistic UI: clear the textarea and append the user's bubble to the chat right away.
    // The full transcript round-trip can take several seconds while Codex is streaming a
    // reply, so we don't want the message to appear "stuck" in the input.
    const optimistic: ChatMessage = {
      id: `pending-${Date.now()}`,
      role: 'user',
      kind: 'message',
      text: textToSend,
      createdAt: new Date().toISOString()
    };
    setPendingMessages((current) => [...current, optimistic]);
    setDraft('');
    setSending(true);
    setError('');
    try {
      const result = await sendMessage(thread.threadId, textToSend);
      setTranscript(result.transcript);
    } catch (sendError) {
      // Roll back the optimistic bubble and restore the draft so the user can retry.
      setPendingMessages((current) => current.filter((m) => m.id !== optimistic.id));
      setDraft(textToSend);
      setError(sendError instanceof Error ? sendError.message : 'Could not send this message.');
    } finally {
      setSending(false);
    }
  };

  const handleOpenInCodex = async () => {
    if (!openThreadInCodex || openingCodex) {
      return;
    }

    setOpeningCodex(true);
    setError('');
    try {
      await openThreadInCodex(thread.threadId);
    } catch (openError) {
      setError(
        openError instanceof Error ? openError.message : 'Could not open this thread in Codex.'
      );
    } finally {
      setOpeningCodex(false);
    }
  };

  return (
    <section className="codex-thread" data-testid="thread-chat-drawer">
      <header className="codex-thread-header">
        <div className="codex-thread-title-block">
          {onOpenSidebar ? (
            <button
              className="codex-thread-sidebar-toggle"
              type="button"
              onClick={onOpenSidebar}
              aria-label="Open sidebar"
            >
              <Menu size={20} />
            </button>
          ) : null}
          <h2 className="codex-thread-title">{thread.title}</h2>
          <span className="codex-thread-workspace">{thread.workspace}</span>
        </div>
        {isAgentWorking ? (
          <span
            className="codex-thread-working-badge"
            role="status"
            aria-live="polite"
            aria-label="Agent is working"
          >
            <span className="codex-thread-working-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>Working</span>
          </span>
        ) : null}

        <div className="codex-thread-actions">
          {openThreadInCodex ? (
            <button
              className="codex-thread-open"
              type="button"
              onClick={() => void handleOpenInCodex()}
              disabled={openingCodex}
              aria-label="Open in Codex"
            >
              <ExternalLink size={14} />
              <span>{openingCodex ? 'Opening' : 'Open Codex'}</span>
            </button>
          ) : null}
          {onClose ? (
            <button
              className="codex-thread-close"
              type="button"
              onClick={onClose}
              aria-label="Close thread chat"
            >
              <X size={18} />
            </button>
          ) : null}
        </div>
      </header>

      <div className="codex-thread-status">
        <span>{statusText}</span>
        {transcript?.activeTurnId ? (
          <span className="codex-thread-status-active">Live turn</span>
        ) : null}
      </div>

      <div className="codex-thread-messages" ref={messagesRef}>
        {loading ? <p className="codex-thread-placeholder">Loading conversation...</p> : null}
        {!loading && !transcript && !error ? (
          <p className="codex-thread-placeholder">Transcript is unavailable.</p>
        ) : null}
        {!loading && transcript?.messages.length === 0 ? (
          <p className="codex-thread-placeholder">No visible chat messages yet.</p>
        ) : null}

        {renderable.map((entry) => {
          if (entry.type === 'work') {
            return (
              <WorkGroup
                key={entry.id}
                messages={entry.messages}
                startedAt={entry.startedAt}
                endedAt={entry.endedAt}
                plugins={plugins}
              />
            );
          }

          if (entry.type === 'event') {
            return (
              <div key={entry.message.id} className="codex-live-event">
                <EventRow message={entry.message} plugins={plugins} />
              </div>
            );
          }

          const { message } = entry;

          if (message.role === 'user') {
            return (
              <div key={message.id} className="codex-message codex-message--user">
                <MessageAttachments attachments={message.attachments} />
                <article className="codex-bubble codex-bubble--user">
                  {message.text.trim() ? <p>{message.text}</p> : null}
                </article>
                <span className="codex-message-tag codex-message-tag--user">You</span>
              </div>
            );
          }

          return (
            <div key={message.id} className="codex-message codex-message--assistant">
              <div className="codex-message-avatar" aria-hidden="true">
                <CodexMark size="sm" />
              </div>
              <div className="codex-message-body">
                <span className="codex-message-tag codex-message-tag--assistant">
                  {formatModelName(effectiveModelName)}
                </span>
                <MessageAttachments attachments={message.attachments} />
                <article className="codex-prose">
                  {message.text.trim() ? <MessageMarkdown text={message.text} /> : null}
                </article>
              </div>
            </div>
          );
        })}
      </div>

      {pendingRequests.length > 0 ? (
        <div className="codex-pending-requests" role="region" aria-label="Codex needs input">
          {pendingRequests.map((request) => (
            <PendingRequestRow
              key={request.id}
              request={request}
              transcript={transcript}
              onApprovalDecision={onApprovalDecision}
            />
          ))}
        </div>
      ) : null}

      {error ? <p className="codex-thread-error">{error}</p> : null}

      <form
        className="codex-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSend();
        }}
      >
        <div className="codex-composer-frame">
          {mention ? (
            <MentionPicker
              trigger={mention.trigger}
              query={mention.query}
              plugins={plugins}
              skills={skills}
              commands={commands}
              files={files}
              filesLoading={filesLoading}
              onSelect={insertMention}
              onClose={() => setMention(undefined)}
            />
          ) : null}
          <label className="sr-only" htmlFor={`message-${thread.threadId}`}>
            Message Codex
          </label>
          <textarea
            id={`message-${thread.threadId}`}
            ref={textareaRef}
            className="codex-composer-input"
            placeholder="Ask Codex anything"
            rows={1}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value, event.target.selectionStart ?? 0)}
            onClick={(event) =>
              updateMentionFromCursor(
                (event.currentTarget as HTMLTextAreaElement).value,
                (event.currentTarget as HTMLTextAreaElement).selectionStart ?? 0
              )
            }
            onKeyUp={(event) => {
              if (
                event.key === 'ArrowDown' ||
                event.key === 'ArrowUp' ||
                event.key === 'Enter' ||
                event.key === 'Tab' ||
                event.key === 'Escape'
              ) {
                return;
              }
              const target = event.currentTarget as HTMLTextAreaElement;
              updateMentionFromCursor(target.value, target.selectionStart ?? 0);
            }}
            onKeyDown={(event) => {
              if (mention) {
                if (
                  event.key === 'ArrowDown' ||
                  event.key === 'ArrowUp' ||
                  event.key === 'Enter' ||
                  event.key === 'Tab' ||
                  event.key === 'Escape'
                ) {
                  return;
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            disabled={!transcript?.sendState.canSend || sending}
          />
          <div className="codex-composer-row">
            <div className="codex-composer-row-left">
              <button
                className="codex-composer-add"
                type="button"
                aria-label="Add attachment"
                disabled
              >
                <Plus size={16} />
              </button>
              <ModelChip
                models={models}
                selectedModelSlug={selectedModelSlug ?? effectiveModelName}
                selectedReasoningEffort={selectedReasoningEffort}
                fallbackLabel={formatModelName(effectiveModelName)}
                isOpen={modelPickerOpen}
                onOpen={() => setModelPickerOpen(true)}
                onClose={() => setModelPickerOpen(false)}
                onChangeModel={onChangeModel}
                disabled={modelUpdating || !onChangeModel}
                setUpdating={setModelUpdating}
              />
            </div>
            <button
              className="codex-composer-send"
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
      </form>

      {transcript?.usage ? (
        <div className="codex-composer-context-bar">
          <UsageBadges usage={transcript.usage} />
        </div>
      ) : null}

    </section>
  );
}

function ModelChip({
  models,
  selectedModelSlug,
  selectedReasoningEffort,
  fallbackLabel,
  isOpen,
  onOpen,
  onClose,
  onChangeModel,
  disabled,
  setUpdating
}: {
  models: CatalogModel[];
  selectedModelSlug?: string;
  selectedReasoningEffort?: string;
  fallbackLabel: string;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChangeModel?: (modelSlug: string, reasoningEffort?: string) => Promise<void>;
  disabled: boolean;
  setUpdating: (value: boolean) => void;
}) {
  const selected = models.find((model) => model.slug === selectedModelSlug);
  const label = selected?.displayName ?? fallbackLabel;
  const reasoningLabel = selectedReasoningEffort
    ? capitalize(selectedReasoningEffort)
    : selected?.defaultReasoningLevel
      ? capitalize(selected.defaultReasoningLevel)
      : undefined;

  if (!onChangeModel || models.length === 0) {
    return (
      <span className="codex-composer-model" aria-label="Current Codex model">
        {label}
        {reasoningLabel ? <span className="codex-composer-model-effort">{reasoningLabel}</span> : null}
      </span>
    );
  }

  return (
    <div className={`codex-composer-model-chip ${isOpen ? 'is-open' : ''}`}>
      <button
        type="button"
        className="codex-composer-model-toggle"
        onClick={() => (isOpen ? onClose() : onOpen())}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <span>{label}</span>
        {reasoningLabel ? <span className="codex-composer-model-effort">{reasoningLabel}</span> : null}
        {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {isOpen ? (
        <div className="codex-composer-model-menu" role="menu">
          {models.map((model) => (
            <ModelMenuRow
              key={model.slug}
              model={model}
              selectedReasoningEffort={
                model.slug === selectedModelSlug ? selectedReasoningEffort : undefined
              }
              isSelected={model.slug === selectedModelSlug}
              onPick={async (effort) => {
                onClose();
                if (!onChangeModel) {
                  return;
                }
                setUpdating(true);
                try {
                  await onChangeModel(model.slug, effort);
                } finally {
                  setUpdating(false);
                }
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ModelMenuRow({
  model,
  selectedReasoningEffort,
  isSelected,
  onPick
}: {
  model: CatalogModel;
  selectedReasoningEffort?: string;
  isSelected: boolean;
  onPick: (effort?: string) => void | Promise<void>;
}) {
  const efforts = model.supportedReasoningLevels ?? [];
  return (
    <div className={`codex-composer-model-row ${isSelected ? 'is-current' : ''}`}>
      <div className="codex-composer-model-row-head">
        <span className="codex-composer-model-row-name">{model.displayName}</span>
        {model.description ? (
          <span className="codex-composer-model-row-desc">{model.description}</span>
        ) : null}
      </div>
      {efforts.length === 0 ? (
        <button
          type="button"
          className="codex-composer-model-effort-pick"
          onClick={() => void onPick(undefined)}
        >
          Use default
        </button>
      ) : (
        <div className="codex-composer-model-effort-list">
          {efforts.map((effort) => (
            <button
              key={effort.effort}
              type="button"
              className={`codex-composer-model-effort-pick ${selectedReasoningEffort === effort.effort ? 'is-selected' : ''}`}
              onClick={() => void onPick(effort.effort)}
              title={effort.description}
            >
              {capitalize(effort.effort)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function PendingRequestRow({
  request,
  transcript,
  onApprovalDecision
}: {
  request: ThreadPendingRequest;
  transcript?: ThreadTranscript;
  onApprovalDecision?: (
    requestId: string,
    method: ApprovalMethodForUi,
    decision: string | Record<string, unknown>
  ) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState<string | undefined>();
  const [error, setError] = useState('');
  const matchedItem = useMemo(() => {
    if (!request.itemId || !transcript?.messages) return undefined;
    return transcript.messages.find((message) => message.id === request.itemId);
  }, [request.itemId, transcript?.messages]);

  const isApproval =
    request.kind === 'commandApproval' ||
    request.kind === 'fileApproval' ||
    request.kind === 'permissionsApproval';

  const submit = async (label: string, decision: string | Record<string, unknown>) => {
    if (!onApprovalDecision || !isApproval) return;
    const method =
      request.kind === 'commandApproval'
        ? 'item/commandExecution/requestApproval'
        : request.kind === 'fileApproval'
          ? 'item/fileChange/requestApproval'
          : 'item/permissions/requestApproval';
    setSubmitting(label);
    setError('');
    try {
      await onApprovalDecision(request.id, method, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record approval.');
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <article className="codex-pending-request">
      <header className="codex-pending-request-title">{request.title}</header>
      {request.body ? (
        <div className="codex-pending-request-body">
          <MessageMarkdown text={request.body} />
        </div>
      ) : null}
      {matchedItem ? (
        <div className="codex-pending-request-context">
          <pre className="codex-pending-request-context-pre">{matchedItem.text}</pre>
        </div>
      ) : null}
      {isApproval && onApprovalDecision ? (
        <div className="codex-pending-request-actions">
          <button
            type="button"
            className="codex-pending-request-action is-primary"
            onClick={() => void submit('accept', 'accept')}
            disabled={Boolean(submitting)}
          >
            {submitting === 'accept' ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            className="codex-pending-request-action"
            onClick={() => void submit('acceptForSession', 'acceptForSession')}
            disabled={Boolean(submitting)}
          >
            {submitting === 'acceptForSession' ? 'Approving…' : 'Approve for session'}
          </button>
          <button
            type="button"
            className="codex-pending-request-action is-danger"
            onClick={() => void submit('decline', 'decline')}
            disabled={Boolean(submitting)}
          >
            {submitting === 'decline' ? 'Declining…' : 'Decline'}
          </button>
        </div>
      ) : (
        <p className="codex-pending-request-hint">Open Codex on your Mac to answer.</p>
      )}
      {error ? <p className="codex-pending-request-error">{error}</p> : null}
    </article>
  );
}

function UsageBadges({ usage }: { usage: ThreadUsage }) {
  const items: { label: string; value: string; tone: 'context' | 'window' }[] = [];
  if (typeof usage.contextUsedPercent === 'number') {
    items.push({ label: 'Context', value: `${usage.contextUsedPercent}%`, tone: 'context' });
  }
  if (usage.primaryWindow) {
    items.push({
      label: formatWindowLabel(usage.primaryWindow.windowMinutes ?? 300),
      value: `${Math.round(usage.primaryWindow.usedPercent)}%`,
      tone: 'window'
    });
  }
  if (usage.secondaryWindow) {
    items.push({
      label: formatWindowLabel(usage.secondaryWindow.windowMinutes ?? 10080),
      value: `${Math.round(usage.secondaryWindow.usedPercent)}%`,
      tone: 'window'
    });
  }
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="codex-thread-usage" role="status" aria-label="Codex usage">
      {items.map((item) => (
        <span key={`${item.label}-${item.value}`} className={`codex-thread-usage-item tone-${item.tone}`}>
          <span className="codex-thread-usage-label">{item.label}</span>
          <span className="codex-thread-usage-value">{item.value}</span>
        </span>
      ))}
    </div>
  );
}

function formatWindowLabel(minutes: number): string {
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440);
    return days === 7 ? 'Weekly' : `${days}d`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}
