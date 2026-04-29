import type {
  CatalogCommand,
  CatalogModel,
  CatalogPlugin,
  CatalogSkill,
  ChatAttachment,
  ChatMessage,
  CollaborationModeKind,
  OlderThreadMessagesResponse,
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
  Square,
  Terminal,
  Wrench,
  X
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent,
  type UIEvent,
  type WheelEvent
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TranscriptFetchTimeoutError, type FetchThreadTranscriptOptions } from './api';
import { CodexMark } from './CodexMark';
import { MentionPicker, type MentionItem, type MentionTrigger } from './MentionPicker';
import { Spinner } from './Spinner';

const INITIAL_TRANSCRIPT_MESSAGE_LIMIT = 40;
const VISIBLE_TRANSCRIPT_TAIL_MESSAGE_COUNT = 2;
const OLDER_MESSAGES_PAGE_SIZE = 40;
const MIRROR_STREAMING_TURN_PREFIX = 'mirror-streaming:';
// Older pages should load only after a deliberate extra pull at the top. A normal scroll
// up should just reveal the prefetched messages already sitting above the latest tail.
const OLDER_MESSAGES_PULL_TOP_PX = 12;
const OLDER_MESSAGES_WHEEL_PULL_DELTA = 90;
const OLDER_MESSAGES_TOUCH_PULL_DELTA = 70;
// Once the user is within this many pixels of the bottom we consider them "pinned" to
// the latest message and resume auto-scrolling on new updates. Any further than that and
// we leave their scroll position alone — typically because they've scrolled up to read.
const NEAR_BOTTOM_PX = 60;

export type ThreadPendingRequest = {
  id: string;
  method: string;
  title: string;
  body?: string;
  itemId?: string;
  turnId?: string;
  permissions?: Record<string, unknown>;
  availableDecisions?: unknown[];
  proposedExecpolicyAmendment?: string[];
  // Raw params for requestUserInput — carries `{ questions: [...] }` so the
  // renderer can show suggestion buttons / a freeform input.
  params?: Record<string, unknown>;
  kind?:
    | 'question'
    | 'plan'
    | 'commandApproval'
    | 'fileApproval'
    | 'permissionsApproval'
    | 'mcpElicitationApproval';
};

export type ApprovalMethodForUi =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'execCommandApproval'
  | 'applyPatchApproval'
  | 'item/tool/requestUserInput'
  | 'item/plan/requestImplementation'
  | 'mcpServer/elicitation/request';

export type ThreadViewProps = {
  thread: Thread;
  onClose?: () => void;
  onOpenSidebar?: () => void;
  fetchTranscript?: (
    threadId: string,
    options?: FetchThreadTranscriptOptions
  ) => Promise<ThreadTranscript>;
  sendMessage?: (
    threadId: string,
    text: string,
    options?: { collaborationMode?: CollaborationModeKind }
  ) => Promise<ThreadMessageResponse>;
  stopWork?: (threadId: string) => Promise<void>;
  fetchOlderMessages?: (
    beforeMessageId: string,
    limit?: number
  ) => Promise<OlderThreadMessagesResponse>;
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

function splitTranscriptForScrollback(
  transcript: ThreadTranscript,
  options: {
    hasUnconfirmedPendingMessage?: boolean;
    sessionUserBaselineIds?: Set<string>;
  } = {}
): { visible: ThreadTranscript; scrollback: ChatMessage[] } {
  if (transcript.messages.length <= VISIBLE_TRANSCRIPT_TAIL_MESSAGE_COUNT) {
    return { visible: transcript, scrollback: [] };
  }

  // When the user just sent a message that the server transcript hasn't confirmed yet,
  // the latest user message in the transcript is the *previous* turn. Anchoring the
  // visible tail to it would drag the previous turn's assistant reply back on screen
  // under the new pending bubble. Push everything to scrollback in that case so the
  // chat shows only the new pending bubble until the real user message lands.
  if (options.hasUnconfirmedPendingMessage) {
    return {
      visible: { ...transcript, messages: [] },
      scrollback: transcript.messages
    };
  }

  // Anchor the visible tail on the *earliest* user message the user sent this session
  // (anything not in the baseline-at-thread-open snapshot). That way every turn the
  // user just sent stays visible together with its assistant reply, instead of the
  // newest user message hiding earlier turns' replies in scrollback.
  const baseline = options.sessionUserBaselineIds;
  let cutoff = transcript.messages.length - VISIBLE_TRANSCRIPT_TAIL_MESSAGE_COUNT;
  let foundSessionUser = false;
  if (baseline) {
    for (let i = 0; i < transcript.messages.length; i++) {
      const message = transcript.messages[i]!;
      if (message.role === 'user' && !baseline.has(message.id)) {
        cutoff = i;
        foundSessionUser = true;
        break;
      }
    }
  }
  if (!foundSessionUser) {
    // Fallback to the previous behavior: latest user message.
    for (let i = transcript.messages.length - 1; i >= 0; i--) {
      if (transcript.messages[i]!.role === 'user') {
        cutoff = i;
        break;
      }
    }
  }

  const scrollback = transcript.messages.slice(0, cutoff);
  const visibleMessages = transcript.messages.slice(cutoff);
  return {
    visible: {
      ...transcript,
      messages: visibleMessages
    },
    scrollback
  };
}

function mergeMessagesById(current: ChatMessage[], additions: ChatMessage[]): ChatMessage[] {
  if (additions.length === 0) {
    return current;
  }

  const seen = new Set(current.map((message) => message.id));
  const next = [...current];
  for (const message of additions) {
    if (seen.has(message.id)) {
      continue;
    }
    seen.add(message.id);
    next.push(message);
  }
  return next;
}

type PendingChatMessage = ChatMessage & {
  baselineMessageIds: string[];
};

function hasNewMatchingUserMessage(
  messages: ChatMessage[],
  text: string,
  baselineMessageIds: Set<string>
): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return messages.some(
    (message) =>
      message.role === 'user' &&
      message.text.trim() === trimmed &&
      !baselineMessageIds.has(message.id)
  );
}

function transcriptContainsNewUserText(
  transcript: ThreadTranscript,
  text: string,
  baselineMessageIds: Set<string>
): boolean {
  return hasNewMatchingUserMessage(transcript.messages, text, baselineMessageIds);
}

function pendingMessageIsConfirmed(pending: PendingChatMessage, messages: ChatMessage[]): boolean {
  return hasNewMatchingUserMessage(messages, pending.text, new Set(pending.baselineMessageIds));
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
  plugins = [],
  isLatest = false,
  isAgentWorking = false
}: {
  messages: ChatMessage[];
  startedAt?: string;
  endedAt?: string;
  plugins?: CatalogPlugin[];
  isLatest?: boolean;
  isAgentWorking?: boolean;
}) {
  // Auto-expand the latest work group while the agent is actively working so the user
  // can watch progress without having to click. Once the turn finishes (or this stops
  // being the latest group because a new turn started), auto-collapse it.
  //
  // Manual-override sticky: once the user clicks the toggle, their choice wins for the
  // rest of this component's lifetime. Without this, the auto-expand effect would slam
  // the group back open each render if the user collapsed it mid-turn.
  const autoExpand = isLatest && isAgentWorking;
  const [expanded, setExpanded] = useState(autoExpand);
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (userToggledRef.current) {
      return;
    }
    setExpanded(autoExpand);
  }, [autoExpand]);

  const handleToggle = () => {
    userToggledRef.current = true;
    setExpanded((previous) => !previous);
  };

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
        onClick={handleToggle}
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
  stopWork,
  fetchOlderMessages,
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
  const [stopping, setStopping] = useState(false);
  const [implementingPlan, setImplementingPlan] = useState(false);
  const [openingCodex, setOpeningCodex] = useState(false);
  const [error, setError] = useState('');
  const [mention, setMention] = useState<{ trigger: MentionTrigger; query: string; start: number; end: number } | undefined>();
  const [files, setFiles] = useState<{ path: string; relativePath: string }[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelUpdating, setModelUpdating] = useState(false);
  const [collaborationMode, setCollaborationMode] =
    useState<CollaborationModeKind>('default');
  // Optimistic local copies of just-sent user messages. These get merged into `renderable`
  // immediately on send so the chat shows the bubble without waiting for the round-trip
  // transcript fetch (which can lag several seconds while Codex is streaming the reply).
  // An entry is dropped as soon as a message with the same trimmed text appears in the
  // server transcript.
  const [pendingMessages, setPendingMessages] = useState<PendingChatMessage[]>([]);
  // Older history shown above the latest tail. The helper prefetch can include more than
  // the default latest two messages, so we keep the extra history in a separate bucket and
  // prepend it at render time. Reset whenever the active thread changes.
  const [olderMessages, setOlderMessages] = useState<ChatMessage[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRequestsInFlight = useRef(0);
  // Tracks whether the user is "pinned" to the bottom of the conversation. When true we
  // auto-scroll on new messages; when false (because they scrolled up to read history)
  // we leave their position alone so a newly streamed token doesn't yank them down.
  const pinnedToBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const olderWheelPullRef = useRef(0);
  const olderTouchStartYRef = useRef<number | null>(null);
  // After the first transcript paint for a thread, we scroll the latest user message to
  // the top of the viewport so the user sees their question, the agent work group, and
  // the final response in reading order. This ref guards that one-shot positioning so
  // later transcript updates (live streams, polls) don't yank the scroll back.
  const hasPositionedInitialRef = useRef(false);
  // Pending bubbles change on every send/confirm. We track them in a ref so
  // applyTranscriptWindow can ask "is there a pending message that the transcript
  // doesn't yet contain?" without rebuilding the closure on every pending update.
  const pendingMessagesRef = useRef<PendingChatMessage[]>([]);
  // Snapshot of message IDs that existed when this thread was first opened on the
  // tablet. Anchoring the visible tail on the *first* user message that isn't in
  // this baseline keeps every turn the user just sent visible together with its
  // reply — without it, sending two messages in a row hides the first reply behind
  // the second user bubble.
  const sessionUserBaselineRef = useRef<Set<string>>(new Set());
  // Tracks whether the session baseline has been seeded at least once. Kept
  // separate from sessionUserBaselineRef so that an empty thread (zero user
  // messages on open) is still recorded as "already seeded" — otherwise the
  // first message the user sends would incorrectly be treated as pre-existing
  // history and excluded from the visible tail.
  const sessionBaselineSeededRef = useRef(false);

  const applyTranscriptWindow = (nextTranscript: ThreadTranscript) => {
    // Seed the session baseline from the *first* transcript we ever see for this
    // thread, BEFORE we split. The full transcript is what tells us which user
    // messages are pre-existing history; everything user-authored after this is
    // a turn from the current session that should stay visible with its reply.
    // We check sessionBaselineSeededRef (not the set's size) so that an empty
    // thread — which has no user messages on open — is still counted as seeded.
    if (!sessionBaselineSeededRef.current) {
      const baseline = new Set<string>();
      for (const message of nextTranscript.messages) {
        if (message.role === 'user') {
          baseline.add(message.id);
        }
      }
      sessionUserBaselineRef.current = baseline;
      sessionBaselineSeededRef.current = true;
    }
    const hasUnconfirmedPendingMessage = pendingMessagesRef.current.some(
      (pending) => !pendingMessageIsConfirmed(pending, nextTranscript.messages)
    );
    const { visible, scrollback } = splitTranscriptForScrollback(nextTranscript, {
      hasUnconfirmedPendingMessage,
      sessionUserBaselineIds: sessionUserBaselineRef.current
    });
    if (scrollback.length > 0) {
      setOlderMessages((current) => mergeMessagesById(current, scrollback));
    }
    setTranscript(visible);
  };

  const trimmedDraft = draft.trim();
  const sendBlockReason = transcript?.sendState.reason;
  const isHardSendBlock =
    sendBlockReason === 'mobile_send_disabled' ||
    sendBlockReason === 'waiting_on_approval' ||
    sendBlockReason === 'waiting_on_user_input' ||
    sendBlockReason === 'compacting_context' ||
    sendBlockReason === 'thread_unavailable';
  const hasPendingRequest = pendingRequests.length > 0;
  const hasPlanRequest = pendingRequests.some((request) => request.kind === 'plan');
  const hasPendingPermissionRequest = pendingRequests.some(
    (request) => request.kind === 'permissionsApproval'
  );
  const threadSaysWaitingApproval =
    thread.status === 'waiting_approval' || sendBlockReason === 'waiting_on_approval';
  const isCompacting =
    thread.status === 'compacting' || sendBlockReason === 'compacting_context';
  const isWaitingForApproval = hasPendingRequest || threadSaysWaitingApproval;
  const pendingRequestStatus = hasPendingRequest
    ? hasPendingPermissionRequest
      ? 'Codex needs permission'
      : pendingRequests.some((request) => request.kind === 'question')
        ? 'Codex needs an answer'
        : 'Codex needs approval'
    : null;
  const transcriptSaysMirrorWorking = Boolean(
    transcript &&
      !isHardSendBlock &&
      (transcript.activeTurnId?.startsWith(MIRROR_STREAMING_TURN_PREFIX) ||
        (transcript.sendState.reason === 'thread_changed' &&
          transcript.sendState.label === 'Codex is working'))
  );
  const waitingApprovalStatus = pendingRequestStatus
    ? pendingRequestStatus
    : threadSaysWaitingApproval
      ? 'Codex is waiting for approval'
      : null;
  const isCodexActive =
    forceWorking || transcriptSaysMirrorWorking || threadSaysWaitingApproval || isCompacting;
  const isAgentWorking = isCodexActive && !isWaitingForApproval;
  const canUseComposer = Boolean(
    sendMessage &&
      !sending &&
      !isWaitingForApproval &&
      (transcript?.sendState.canSend || (isCodexActive && !isHardSendBlock))
  );
  const canSend = Boolean(canUseComposer && trimmedDraft);
  const effectiveModelName = modelName || thread.model;
  const latestPlanMessage = useMemo(
    () =>
      [...(transcript?.messages ?? [])]
        .reverse()
        .find((message) => message.kind === 'plan' && message.text.trim()),
    [transcript?.messages]
  );
  const canOfferPlanImplementation = Boolean(
    latestPlanMessage &&
      sendMessage &&
      !hasPendingRequest &&
      !hasPlanRequest &&
      !isCodexActive &&
      transcript?.sendState.canSend
  );

  // Status bar text logic:
  // - When sending: "Sending to Codex..."
  // - When sendState blocks sending: show the explicit reason (e.g. "Approve on Mac to continue")
  //   only for hard blocks that really require the user to wait or use the Mac.
  // - Else when app-server says the thread is active: "Codex is working"
  // - Otherwise: sendState.label (which may be "Ready", "Mobile sending is off on the Mac.", etc.)
  // - If loading and no transcript yet: "Loading conversation..."
  const sendBlockedLabel =
    transcript && !transcript.sendState.canSend && isHardSendBlock
      ? transcript.sendState.label
      : null;
  const statusText = sending
    ? 'Sending to Codex...'
    : waitingApprovalStatus
      ? waitingApprovalStatus
      : isCompacting
        ? (transcript?.sendState.reason === 'compacting_context'
            ? transcript.sendState.label
            : 'Automatically compacting context')
      : sendBlockedLabel
        ? sendBlockedLabel
        : isAgentWorking
          ? 'Codex is working'
          : transcript?.sendState.label === 'Codex is working'
            ? 'Ready'
            : transcript?.sendState.label ?? (loading ? 'Loading conversation...' : '');

  const renderable = useMemo(() => {
    const tail = transcript?.messages ?? [];
    // De-dupe the older bucket against the current tail by id so a poll/live update that
    // happens to overlap with our last paged-in window doesn't render the same message
    // twice.
    const tailIds = new Set(tail.map((m) => m.id));
    const olderUnique = olderMessages.filter((m) => !tailIds.has(m.id));
    const merged = [...olderUnique, ...tail].filter(
      (message) => message.role !== 'activity' || message.text.trim().length > 0
    );
    // Drop pending entries whose text already shows up in the real transcript, then append
    // any remaining ones at the end so the user sees their just-sent message immediately.
    const stillPending = pendingMessages.filter((message) => !pendingMessageIsConfirmed(message, merged));
    const combined = [...merged, ...stillPending];
    if (stillPending.length > 0) {
      const latestPending = stillPending[stillPending.length - 1]!;
      const baselineMessageIds = new Set(latestPending.baselineMessageIds);
      const freshServerMessages = merged.filter((message) => !baselineMessageIds.has(message.id));
      return buildRenderableEntries([...stillPending, ...freshServerMessages]);
    }
    return buildRenderableEntries(combined);
  }, [transcript?.messages, olderMessages, pendingMessages]);
  // Identify the most recent work group so we can auto-expand it while the agent is
  // working. Only the latest one — older work groups stay collapsed even when a new
  // turn fires.
  const latestWorkGroupId = useMemo(() => {
    for (let i = renderable.length - 1; i >= 0; i -= 1) {
      const entry = renderable[i]!;
      if (entry.type === 'work') {
        return entry.id;
      }
    }
    return undefined;
  }, [renderable]);
  const transcriptMessageIds = useMemo(
    () => transcript?.messages.map((message) => message.id).join('|') ?? '',
    [transcript?.messages]
  );
  // Total visible text length. Used as a dep for the autoscroll effect so it
  // fires on every streaming delta — without this, the viewport only updates
  // when a new message id appears, and the assistant's reply streams in below
  // the visible window until the user scrolls down manually.
  const transcriptContentLength = useMemo(() => {
    let total = 0;
    for (const message of transcript?.messages ?? []) {
      total += message.text.length;
    }
    return total;
  }, [transcript?.messages]);
  const previousLastMessageIdRef = useRef<string | undefined>();

  // Mirror pendingMessages into a ref so applyTranscriptWindow can read the current
  // pending state without being recreated on every push/confirm.
  useEffect(() => {
    pendingMessagesRef.current = pendingMessages;
  }, [pendingMessages]);

  // Reconcile pendingMessages whenever the transcript changes — once the server confirms a
  // pending message, drop it from local state so duplicates don't pile up.
  useEffect(() => {
    if (pendingMessages.length === 0) return;
    setPendingMessages((current) => {
      const next = current.filter((message) => !pendingMessageIsConfirmed(message, transcript?.messages ?? []));
      return next.length === current.length ? current : next;
    });
  }, [transcript?.messages, pendingMessages.length]);

  // Clear pending state when switching threads — they're per-thread.
  useEffect(() => {
    setPendingMessages([]);
    setOlderMessages([]);
    setHasMoreOlder(true);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    olderWheelPullRef.current = 0;
    olderTouchStartYRef.current = null;
    setOlderError('');
    pinnedToBottomRef.current = true;
    hasPositionedInitialRef.current = false;
    // Reset the per-session user-message baseline. It will be seeded by the first
    // transcript paint below.
    sessionUserBaselineRef.current = new Set();
    sessionBaselineSeededRef.current = false;
  }, [thread.threadId]);


  // Initial-paint positioning + auto-scroll on new messages.
  //
  // First paint for a thread: scroll the latest user message to the top of the viewport
  // so the user sees their question, the agent work group, and the final response in
  // reading order without having to scroll up. Without this, the previous behavior
  // jumped to the bottom and pushed the user message off-screen on long turns (e.g. a
  // turn with 179 activity updates).
  //
  // After that initial positioning, only auto-scroll to the bottom when the user is
  // already pinned there — so a streamed token doesn't yank them back down while they
  // read history.
  useEffect(() => {
    const node = messagesRef.current;
    if (!node) {
      return;
    }
    if (loading) {
      return;
    }

    if (!hasPositionedInitialRef.current) {
      // Find the last user message in the rendered DOM and align it to the top of the
      // scroll container. Fall back to scrolling to the bottom if there's no user
      // message yet (empty thread).
      const userNodes = node.querySelectorAll<HTMLElement>('[data-role="user-message"]');
      const lastUser = userNodes.length > 0 ? userNodes[userNodes.length - 1]! : null;
      if (lastUser) {
        const containerTop = node.getBoundingClientRect().top;
        const messageTop = lastUser.getBoundingClientRect().top;
        node.scrollTop = node.scrollTop + (messageTop - containerTop);
        // The user is reading from the top of their question — they aren't pinned to
        // the bottom, so live streams shouldn't drag them down.
        pinnedToBottomRef.current = false;
      } else {
        node.scrollTop = node.scrollHeight;
      }
      hasPositionedInitialRef.current = true;
      previousLastMessageIdRef.current = transcript?.messages.at(-1)?.id;
      return;
    }

    // When a brand-new message lands at the end of the transcript, treat it as
    // "user just sent / agent just started a new turn" and re-pin to the bottom
    // so the streaming reply follows the viewport. The scroll handler will flip
    // pinnedToBottomRef back to false the moment the user scrolls away, so this
    // doesn't yank them around while they're reading history.
    const latestId = transcript?.messages.at(-1)?.id;
    if (latestId && latestId !== previousLastMessageIdRef.current) {
      pinnedToBottomRef.current = true;
      previousLastMessageIdRef.current = latestId;
    }

    if (pinnedToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [
    transcriptMessageIds,
    transcriptContentLength,
    transcript?.activeTurnId,
    loading,
    pendingMessages.length
  ]);

  // Apply live transcript updates immediately (WebSocket path)
  useEffect(() => {
    if (liveTranscript) {
      applyTranscriptWindow(liveTranscript);
    }
  }, [liveTranscript]);

  // Initial transcript fetch
  useEffect(() => {
    let cancelled = false;
    setError('');

    setTranscript((current) => {
      if (liveTranscript?.threadId === thread.threadId) {
        return splitTranscriptForScrollback(liveTranscript).visible;
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
          applyTranscriptWindow(nextTranscript);
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
        // Soft-swallow timeouts when something is already on screen — the helper has its
        // own cache fallback, and surfacing a red banner over a working conversation just
        // confuses the user. Only show the timeout error on a true cold load (no live
        // transcript and no prior state for this thread).
        if (
          loadError instanceof TranscriptFetchTimeoutError &&
          transcript?.threadId === thread.threadId
        ) {
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
    const baselineMessageIds = new Set(
      [...olderMessages, ...(transcript?.messages ?? [])].map((message) => message.id)
    );
    // Optimistic UI: clear the textarea and append the user's bubble to the chat right away.
    // The full transcript round-trip can take several seconds while Codex is streaming a
    // reply, so we don't want the message to appear "stuck" in the input.
    const optimistic: PendingChatMessage = {
      id: `pending-${Date.now()}`,
      role: 'user',
      kind: 'message',
      text: textToSend,
      createdAt: new Date().toISOString(),
      baselineMessageIds: [...baselineMessageIds]
    };
    setPendingMessages((current) => [...current, optimistic]);
    setDraft('');
    setSending(true);
    setError('');
    // The user just sent a new message — re-pin to the bottom so their new bubble and
    // Codex's streaming reply are visible without them having to scroll down.
    pinnedToBottomRef.current = true;
    try {
      const result =
        collaborationMode === 'plan'
          ? await sendMessage(thread.threadId, textToSend, { collaborationMode })
          : await sendMessage(thread.threadId, textToSend);
      if (transcriptContainsNewUserText(result.transcript, textToSend, baselineMessageIds)) {
        applyTranscriptWindow(result.transcript);
      }
    } catch (sendError) {
      // Roll back the optimistic bubble and restore the draft so the user can retry.
      setPendingMessages((current) => current.filter((m) => m.id !== optimistic.id));
      setDraft(textToSend);
      setError(sendError instanceof Error ? sendError.message : 'Could not send this message.');
    } finally {
      setSending(false);
    }
  };

  // Determine the oldest message id we currently have rendered. The "before" cursor for
  // the next older-page fetch is whichever id appears first when olderMessages and the
  // transcript tail are stitched together — `olderMessages[0]` if we've paged any in,
  // otherwise the first message of the live transcript.
  const oldestMessageId =
    olderMessages.length > 0
      ? olderMessages[0]!.id
      : transcript?.messages.length
        ? transcript.messages[0]!.id
        : undefined;

  const loadOlderMessages = async () => {
    if (!fetchOlderMessages || loadingOlderRef.current || !hasMoreOlder || !oldestMessageId) {
      return;
    }
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderError('');

    const node = messagesRef.current;
    // Anchor the user's scroll position by remembering how far they were from the bottom.
    // After the prepend we restore that distance so the content they were reading stays
    // put visually.
    const distanceFromBottom = node ? node.scrollHeight - node.scrollTop : 0;

    try {
      const response = await fetchOlderMessages(oldestMessageId, OLDER_MESSAGES_PAGE_SIZE);
      if (response.messages.length > 0) {
        setOlderMessages((current) => {
          const seen = new Set(current.map((m) => m.id));
          const additions = response.messages.filter((m) => !seen.has(m.id));
          return [...additions, ...current];
        });
      }
      setHasMoreOlder(response.hasMore);

      // Restore scroll position after the DOM grows. requestAnimationFrame fires after
      // React commits but before the browser paints, which is when the new scrollHeight
      // is observable.
      requestAnimationFrame(() => {
        const current = messagesRef.current;
        if (current) {
          current.scrollTop = current.scrollHeight - distanceFromBottom;
        }
      });
    } catch (loadError) {
      setOlderError(
        loadError instanceof Error ? loadError.message : 'Could not load older messages.'
      );
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  const canLoadOlderAfterPull = (node: HTMLDivElement): boolean => {
    const scrollablePastLatest = node.scrollHeight - node.clientHeight > NEAR_BOTTOM_PX;
    return Boolean(
      scrollablePastLatest &&
      node.scrollTop <= OLDER_MESSAGES_PULL_TOP_PX &&
      hasMoreOlder &&
      !loadingOlderRef.current &&
      fetchOlderMessages
    );
  };

  const triggerOlderLoadAfterPull = (node: HTMLDivElement) => {
    if (!canLoadOlderAfterPull(node)) {
      return;
    }
    olderWheelPullRef.current = 0;
    olderTouchStartYRef.current = null;
    void loadOlderMessages();
  };

  const handleMessagesScroll = (event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    // Track whether the user is near the bottom so the auto-scroll-on-new-message effect
    // knows whether to re-pin or stay put.
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const scrollablePastLatest = node.scrollHeight - node.clientHeight > NEAR_BOTTOM_PX;
    pinnedToBottomRef.current = !scrollablePastLatest || distanceFromBottom <= NEAR_BOTTOM_PX;

    if (node.scrollTop > OLDER_MESSAGES_PULL_TOP_PX) {
      olderWheelPullRef.current = 0;
      olderTouchStartYRef.current = null;
    }
  };

  const handleMessagesWheel = (event: WheelEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    if (event.deltaY >= 0 || !canLoadOlderAfterPull(node)) {
      olderWheelPullRef.current = 0;
      return;
    }

    olderWheelPullRef.current += Math.abs(event.deltaY);
    if (olderWheelPullRef.current >= OLDER_MESSAGES_WHEEL_PULL_DELTA) {
      triggerOlderLoadAfterPull(node);
    }
  };

  const handleMessagesTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    olderTouchStartYRef.current = event.touches[0]?.clientY ?? null;
  };

  const handleMessagesTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    const startY = olderTouchStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined || !canLoadOlderAfterPull(node)) {
      return;
    }

    if (currentY - startY >= OLDER_MESSAGES_TOUCH_PULL_DELTA) {
      triggerOlderLoadAfterPull(node);
    }
  };

  const handleMessagesTouchEnd = () => {
    olderTouchStartYRef.current = null;
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

  const handleStopWork = async () => {
    if (!stopWork || !isAgentWorking || stopping) {
      return;
    }

    setStopping(true);
    setError('');
    try {
      await stopWork(thread.threadId);
      setTranscript((current) =>
        current
          ? {
              ...current,
              activeTurnId: null,
              sendState:
                current.sendState.reason === 'mobile_send_disabled'
                  ? current.sendState
                  : {
                      canSend: true,
                      reason: 'ready',
                      label: 'Ready'
                    }
            }
          : current
      );
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : 'Could not stop Codex.');
    } finally {
      setStopping(false);
    }
  };

  const handleImplementPlan = async () => {
    if (!sendMessage || !latestPlanMessage || !canOfferPlanImplementation) {
      return;
    }
    setImplementingPlan(true);
    setError('');
    pinnedToBottomRef.current = true;
    try {
      const result = await sendMessage(thread.threadId, 'Please implement this plan.');
      applyTranscriptWindow(result.transcript);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Could not start the plan.');
    } finally {
      setImplementingPlan(false);
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
        {waitingApprovalStatus ? (
          <span
            className="codex-thread-working-badge is-attention"
            role="status"
            aria-live="polite"
            aria-label="Codex needs approval"
          >
            <span>{hasPendingPermissionRequest ? 'Permission' : 'Approval'}</span>
          </span>
        ) : isCompacting ? (
          <span
            className="codex-thread-working-badge is-compacting"
            role="status"
            aria-live="polite"
            aria-label="Codex is compacting context"
          >
            <span className="codex-thread-working-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>Compacting</span>
          </span>
        ) : isAgentWorking ? (
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
      </div>

      <div
        className="codex-thread-messages"
        ref={messagesRef}
        onScroll={handleMessagesScroll}
        onWheel={handleMessagesWheel}
        onTouchStart={handleMessagesTouchStart}
        onTouchMove={handleMessagesTouchMove}
        onTouchEnd={handleMessagesTouchEnd}
        onTouchCancel={handleMessagesTouchEnd}
      >
        {loadingOlder ? (
          <div className="codex-thread-loading-older">
            <Spinner size={14} label="Loading older messages" />
            <span>Loading older messages…</span>
          </div>
        ) : null}
        {olderError ? <p className="codex-thread-older-error">{olderError}</p> : null}
        {!loadingOlder && !hasMoreOlder && olderMessages.length > 0 ? (
          <p className="codex-thread-older-status">Beginning of conversation.</p>
        ) : null}
        {loading ? (
          <p className="codex-thread-placeholder">
            <Spinner size={14} label="Loading conversation" /> Loading conversation…
          </p>
        ) : null}
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
                isLatest={entry.id === latestWorkGroupId}
                isAgentWorking={isAgentWorking}
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
              <div
                key={message.id}
                className="codex-message codex-message--user"
                data-role="user-message"
                data-message-id={message.id}
              >
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
      ) : threadSaysWaitingApproval ? (
        <div className="codex-pending-requests" role="region" aria-label="Codex needs approval">
          <article className="codex-pending-request">
            <header className="codex-pending-request-title">Codex is waiting for approval</header>
            <p className="codex-pending-request-hint">
              Waiting for the live approval details. Open Codex on your Mac if the buttons do not
              appear.
            </p>
          </article>
        </div>
      ) : null}
      {canOfferPlanImplementation ? (
        <div className="codex-pending-requests" role="region" aria-label="Plan actions">
          <article className="codex-pending-request">
            <header className="codex-pending-request-title">Plan is ready</header>
            <div className="codex-pending-request-actions">
              <button
                type="button"
                className="codex-pending-request-action is-primary"
                onClick={() => void handleImplementPlan()}
                disabled={implementingPlan}
              >
                {implementingPlan ? (
                  <>
                    <Spinner size={14} /> Starting...
                  </>
                ) : (
                  'Implement plan'
                )}
              </button>
            </div>
          </article>
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
            disabled={!canUseComposer}
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
              <button
                type="button"
                className={`codex-composer-mode ${collaborationMode === 'plan' ? 'is-active' : ''}`}
                aria-pressed={collaborationMode === 'plan'}
                title={
                  collaborationMode === 'plan'
                    ? 'Plan mode is on for the next message'
                    : 'Ask Codex to make a plan first'
                }
                onClick={() =>
                  setCollaborationMode((current) => (current === 'plan' ? 'default' : 'plan'))
                }
                disabled={!sendMessage}
              >
                <ListChecks size={14} />
                <span>Plan</span>
              </button>
            </div>
            <div className="codex-composer-actions">
              {stopWork && isCodexActive ? (
                <button
                  className="codex-composer-stop"
                  type="button"
                  onClick={() => void handleStopWork()}
                  disabled={stopping}
                  aria-label="Stop Codex"
                >
                  <Square size={13} />
                  <span>{stopping ? 'Stopping' : 'Stop'}</span>
                </button>
              ) : null}
              <button
                className="codex-composer-send"
                type="submit"
                disabled={!canSend}
                aria-label={sending ? 'Sending' : 'Send message'}
              >
                {sending ? <Spinner size={16} /> : <ArrowUp size={16} />}
              </button>
            </div>
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

const APPROVAL_METHODS_FOR_UI = new Set<ApprovalMethodForUi>([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
  'item/tool/requestUserInput',
  'item/plan/requestImplementation',
  'mcpServer/elicitation/request'
]);

function isApprovalMethodForUi(method: string): method is ApprovalMethodForUi {
  return APPROVAL_METHODS_FOR_UI.has(method as ApprovalMethodForUi);
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
    request.kind === 'permissionsApproval' ||
    request.kind === 'mcpElicitationApproval';
  const isPlanRequest = request.kind === 'plan';
  const isQuestionRequest = request.kind === 'question';
  const canAnswerRequest = isApproval || isPlanRequest || isQuestionRequest;

  const submit = async (label: string, decision: string | Record<string, unknown>) => {
    if (!onApprovalDecision || !canAnswerRequest) return;
    const fallbackMethod =
      request.kind === 'plan'
        ? 'item/plan/requestImplementation'
        : request.kind === 'commandApproval'
        ? 'item/commandExecution/requestApproval'
        : request.kind === 'fileApproval'
          ? 'item/fileChange/requestApproval'
          : request.kind === 'mcpElicitationApproval'
            ? 'mcpServer/elicitation/request'
            : 'item/permissions/requestApproval';
    const method = isApprovalMethodForUi(request.method) ? request.method : fallbackMethod;
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

  const submitPermissions = async (label: string, scope: 'turn' | 'session') => {
    await submit(label, {
      permissions: request.permissions ?? {},
      scope
    });
  };

  const denyPermissions = async () => {
    await submit('deny', {
      permissions: {},
      scope: 'turn'
    });
  };

  const submitMcpElicitation = async (label: string, persist?: 'always') => {
    await submit(label, {
      action: 'accept',
      content: {},
      _meta: persist ? { persist } : null
    });
  };

  const denyMcpElicitation = async () => {
    await submit('decline', {
      action: 'decline',
      content: null,
      _meta: null
    });
  };

  // Build the response shape Codex expects for item/tool/requestUserInput.
  // Each question in params.questions[] has a `name` we map to one answer.
  const submitQuestionAnswer = async (label: string, answersByName: Record<string, string>) => {
    await submit(label, { answers: answersByName });
  };

  const denyQuestion = async () => {
    // Codex treats an empty answers payload as "skipped" — the turn aborts
    // gracefully. This also unblocks the thread so the stop button works
    // again on the next idle.
    await submit('skip', { answers: {} });
  };

  const commandPrefix = request.proposedExecpolicyAmendment?.join(' ');
  const commandPrefixDecision =
    request.method === 'item/commandExecution/requestApproval' && request.proposedExecpolicyAmendment?.length
      ? {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: request.proposedExecpolicyAmendment
          }
        }
      : undefined;
  const hasSessionApproval =
    request.kind === 'mcpElicitationApproval' ||
    request.kind === 'permissionsApproval' ||
    request.method === 'execCommandApproval' ||
    request.method === 'applyPatchApproval' ||
    Boolean(commandPrefixDecision);
  const negativeApprovalDecision = request.availableDecisions?.includes('cancel') ? 'cancel' : 'decline';
  const primaryApprovalLabel =
    request.kind === 'mcpElicitationApproval'
      ? 'Allow'
      : request.kind === 'permissionsApproval'
        ? 'Allow once'
        : 'Approve';
  const primarySubmittingLabel =
    request.kind === 'permissionsApproval' || request.kind === 'mcpElicitationApproval'
      ? 'Allowing...'
      : 'Approving...';
  const sessionApprovalLabel =
    request.kind === 'mcpElicitationApproval'
      ? 'Always allow'
      : request.kind === 'permissionsApproval'
        ? 'Allow for session'
        : commandPrefix
          ? `Always allow ${truncate(commandPrefix, 28)}`
          : 'Approve for session';
  const sessionSubmittingLabel =
    request.kind === 'permissionsApproval' || request.kind === 'mcpElicitationApproval'
      ? 'Allowing...'
      : 'Approving...';
  const denyLabel =
    request.kind === 'mcpElicitationApproval'
      ? 'Cancel'
      : request.kind === 'permissionsApproval'
        ? 'Deny'
        : negativeApprovalDecision === 'cancel'
          ? 'Cancel'
          : 'Decline';
  const denySubmittingLabel =
    request.kind === 'mcpElicitationApproval'
      ? 'Cancelling...'
      : request.kind === 'permissionsApproval'
        ? 'Denying...'
        : negativeApprovalDecision === 'cancel'
          ? 'Cancelling...'
          : 'Declining...';

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
      {isPlanRequest && onApprovalDecision ? (
        <div className="codex-pending-request-actions">
          <button
            type="button"
            className="codex-pending-request-action is-primary"
            onClick={() => void submit('implement', 'accept')}
            disabled={Boolean(submitting)}
          >
            {submitting === 'implement' ? (
              <>
                <Spinner size={14} /> Starting...
              </>
            ) : (
              'Implement'
            )}
          </button>
          <button
            type="button"
            className="codex-pending-request-action is-danger"
            onClick={() => void submit('cancel', 'decline')}
            disabled={Boolean(submitting)}
          >
            {submitting === 'cancel' ? (
              <>
                <Spinner size={14} /> Cancelling...
              </>
            ) : (
              'Cancel'
            )}
          </button>
        </div>
      ) : isQuestionRequest && onApprovalDecision ? (
        <QuestionAnswerForm
          request={request}
          submitting={submitting}
          onSubmit={(label, answers) => void submitQuestionAnswer(label, answers)}
          onSkip={() => void denyQuestion()}
        />
      ) : isApproval && onApprovalDecision ? (
        <div className="codex-pending-request-actions">
          <button
            type="button"
            className="codex-pending-request-action is-primary"
            onClick={() =>
              void (request.kind === 'mcpElicitationApproval'
                ? submitMcpElicitation('accept')
                : request.kind === 'permissionsApproval'
                  ? submitPermissions('accept', 'turn')
                  : submit('accept', 'accept'))
            }
            disabled={Boolean(submitting)}
          >
            {submitting === 'accept' ? (
              <>
                <Spinner size={14} /> {primarySubmittingLabel}
              </>
            ) : (
              primaryApprovalLabel
            )}
          </button>
          {hasSessionApproval ? (
            <button
              type="button"
              className="codex-pending-request-action"
              onClick={() =>
                void (request.kind === 'mcpElicitationApproval'
                  ? submitMcpElicitation('acceptForSession', 'always')
                  : request.kind === 'permissionsApproval'
                    ? submitPermissions('acceptForSession', 'session')
                    : commandPrefixDecision
                      ? submit('acceptForSession', commandPrefixDecision)
                      : submit('acceptForSession', 'acceptForSession'))
              }
              disabled={Boolean(submitting)}
            >
              {submitting === 'acceptForSession' ? (
                <>
                  <Spinner size={14} /> {sessionSubmittingLabel}
                </>
              ) : (
                sessionApprovalLabel
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="codex-pending-request-action is-danger"
            onClick={() =>
              void (request.kind === 'mcpElicitationApproval'
                ? denyMcpElicitation()
                : request.kind === 'permissionsApproval'
                  ? denyPermissions()
                  : submit(negativeApprovalDecision, negativeApprovalDecision))
            }
            disabled={Boolean(submitting)}
          >
            {submitting === negativeApprovalDecision || submitting === 'deny' ? (
              <>
                <Spinner size={14} /> {denySubmittingLabel}
              </>
            ) : (
              denyLabel
            )}
          </button>
        </div>
      ) : (
        <p className="codex-pending-request-hint">Open Codex on your Mac to answer.</p>
      )}
      {error ? <p className="codex-pending-request-error">{error}</p> : null}
    </article>
  );
}

// Renders a Codex requestUserInput question with its suggestion buttons and a
// freeform fallback. Codex sends `params.questions[]`, each with a `name`, a
// human-readable `header`/`question`, optional `suggestions: [{ value, label }]`,
// and an `answerType` ('string' | 'enum' | etc.). For each question we render
// either the suggestion buttons (if present) or a single-line text input. The
// answers are collected into `{ <questionName>: <answer> }` and submitted as
// `{ answers: {...} }` to match what the helper's app-server bridge expects.
function QuestionAnswerForm({
  request,
  submitting,
  onSubmit,
  onSkip
}: {
  request: ThreadPendingRequest;
  submitting: string | undefined;
  onSubmit: (label: string, answers: Record<string, string>) => void;
  onSkip: () => void;
}) {
  const questions = useMemo<RawQuestion[]>(() => {
    const raw = (request.params ?? {}) as { questions?: unknown };
    if (!Array.isArray(raw.questions)) {
      return [];
    }
    return raw.questions.flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object') return [];
      const questionEntry = entry as Record<string, unknown>;
      const name =
        typeof questionEntry.name === 'string' && questionEntry.name.trim()
          ? questionEntry.name.trim()
          : `q_${index}`;
      const header =
        typeof questionEntry.header === 'string' ? questionEntry.header : undefined;
      const text =
        typeof questionEntry.question === 'string' ? questionEntry.question : undefined;
      const suggestions: RawSuggestion[] = Array.isArray(questionEntry.suggestions)
        ? questionEntry.suggestions
            .map((suggestion) => normalizeSuggestion(suggestion))
            .filter((suggestion): suggestion is RawSuggestion => suggestion !== null)
        : [];
      return [{ name, header, text, suggestions }];
    });
  }, [request.params]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const allAnswered = questions.every(
    (question) => (answers[question.name] ?? '').trim().length > 0
  );
  const submitDisabled = Boolean(submitting) || !allAnswered;

  if (questions.length === 0) {
    return <p className="codex-pending-request-hint">Open Codex on your Mac to answer.</p>;
  }

  return (
    <div className="codex-pending-request-question">
      {questions.map((question) => {
        const value = answers[question.name] ?? '';
        return (
          <div key={question.name} className="codex-pending-request-question-block">
            {question.text ? (
              <p className="codex-pending-request-question-text">{question.text}</p>
            ) : null}
            {question.suggestions.length > 0 ? (
              <div className="codex-pending-request-question-suggestions">
                {question.suggestions.map((suggestion) => {
                  const active = value === suggestion.value;
                  return (
                    <button
                      key={`${question.name}:${suggestion.value}`}
                      type="button"
                      className={`codex-pending-request-suggestion${
                        active ? ' is-active' : ''
                      }`}
                      title={suggestion.tooltip}
                      onClick={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.name]: suggestion.value
                        }))
                      }
                      disabled={Boolean(submitting)}
                    >
                      <span className="codex-pending-request-suggestion-label">
                        {suggestion.label ?? suggestion.value}
                      </span>
                      {suggestion.tooltip ? (
                        <span className="codex-pending-request-suggestion-hint">
                          {suggestion.tooltip}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <input
              type="text"
              className="codex-pending-request-question-input"
              placeholder="Type your answer..."
              value={value}
              onChange={(event) =>
                setAnswers((current) => ({
                  ...current,
                  [question.name]: event.target.value
                }))
              }
              disabled={Boolean(submitting)}
            />
          </div>
        );
      })}
      <div className="codex-pending-request-actions">
        <button
          type="button"
          className="codex-pending-request-action is-primary"
          disabled={submitDisabled}
          onClick={() => onSubmit('answer', answers)}
        >
          {submitting === 'answer' ? (
            <>
              <Spinner size={14} /> Sending...
            </>
          ) : (
            'Send answer'
          )}
        </button>
        <button
          type="button"
          className="codex-pending-request-action is-danger"
          disabled={Boolean(submitting)}
          onClick={onSkip}
        >
          {submitting === 'skip' ? (
            <>
              <Spinner size={14} /> Cancelling...
            </>
          ) : (
            'Skip'
          )}
        </button>
      </div>
    </div>
  );
}

type RawSuggestion = { value: string; label?: string; tooltip?: string };
type RawQuestion = {
  name: string;
  header?: string;
  text?: string;
  suggestions: RawSuggestion[];
};

function normalizeSuggestion(raw: unknown): RawSuggestion | null {
  if (typeof raw === 'string') {
    return { value: raw };
  }
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const value =
    typeof record.value === 'string'
      ? record.value
      : typeof record.label === 'string'
        ? record.label
        : null;
  if (!value) {
    return null;
  }
  const label = typeof record.label === 'string' ? record.label : undefined;
  // Codex suggestions can carry an explanatory hint under several names depending
  // on the question type — accept any of them so the user sees what each option
  // does without having to commit to one. Shown as a native title tooltip on
  // hover (desktop) and below the label on tablet (small muted text).
  const tooltip =
    typeof record.tooltip === 'string'
      ? record.tooltip
      : typeof record.hint === 'string'
        ? record.hint
        : typeof record.description === 'string'
          ? record.description
          : undefined;
  return {
    value,
    ...(label ? { label } : {}),
    ...(tooltip ? { tooltip } : {})
  };
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
