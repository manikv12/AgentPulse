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
  ImagePlus,
  Info,
  ListChecks,
  Menu,
  Plus,
  Square,
  Terminal,
  Trash2,
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
import { MentionPicker, type MentionItem, type MentionTrigger } from './MentionPicker';
import { ProviderMark } from './ProviderMark';
import {
  groupModelsForPicker,
  normalizeProviderModelSlug,
  providerForModel,
  providerForThread,
  providerLabel,
  providerTone,
  type ProviderTone
} from './providers';
import { Spinner } from './Spinner';
import {
  buildRenderableEntries,
  type ActivityDetailSection as ActivityDetailSectionModel,
  type ActivityGroup,
  type ActivityGroupItem
} from './threadRendering';

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
  | 'claudeCode/canUseTool'
  | 'claudeCode/elicitation'
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
  deleteThread?: (threadId: string) => Promise<void>;
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

function captureScrollAnchor(node: HTMLDivElement): { element: HTMLElement; top: number } | null {
  const containerTop = node.getBoundingClientRect().top;
  const anchors = node.querySelectorAll<HTMLElement>('[data-scroll-anchor="true"]');
  let closestBelowTop: { element: HTMLElement; top: number } | null = null;

  for (const element of anchors) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom < containerTop) {
      continue;
    }
    if (rect.top >= containerTop) {
      return { element, top: rect.top };
    }
    closestBelowTop = { element, top: rect.top };
  }

  return closestBelowTop;
}

function restoreScrollAnchor(
  node: HTMLDivElement,
  anchor: { element: HTMLElement; top: number } | null,
  fallbackScrollHeightMinusTop: number
) {
  if (anchor && node.contains(anchor.element)) {
    const nextTop = anchor.element.getBoundingClientRect().top;
    node.scrollTop += nextTop - anchor.top;
    return;
  }

  node.scrollTop = node.scrollHeight - fallbackScrollHeightMinusTop;
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

function ActivityDetailSections({ sections }: { sections: ActivityDetailSectionModel[] }) {
  if (sections.length === 0) {
    return null;
  }

  return (
    <div className="codex-activity-detail-sections">
      {sections.map((section) => (
        <section key={section.id} className="codex-activity-detail-section">
          <h4>{section.title}</h4>
          {section.code ? (
            <pre className="codex-activity-detail-code">{section.body}</pre>
          ) : (
            <MessageMarkdown text={section.body} />
          )}
        </section>
      ))}
    </div>
  );
}

function ActivityRow({
  item,
  plugins = [],
  isLatestRunningActivity = false
}: {
  item: ActivityGroupItem;
  plugins?: CatalogPlugin[];
  isLatestRunningActivity?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const message = item.message;
  const Icon = ACTIVITY_ICONS[message.kind] ?? Info;
  const matchedPlugin = useMemo(() => {
    if (message.kind !== 'tool') {
      return undefined;
    }
    return matchPluginFromToolText(message.text, plugins);
  }, [message.kind, message.text, plugins]);
  const hasAttachments = Boolean(message.attachments?.length);
  const canExpand = item.detailSections.length > 0 || hasAttachments;
  const isRunning = item.status === 'running' && isLatestRunningActivity;

  const rowContent = (
    <>
      <span className={`codex-activity-icon kind-${item.kind}`} aria-hidden="true">
        {matchedPlugin?.iconUrl ? (
          <img className="codex-activity-plugin-icon" src={matchedPlugin.iconUrl} alt="" />
        ) : (
          <Icon size={14} />
        )}
      </span>
      <span className="codex-activity-copy">
        <span className="codex-activity-title-line">
          <span className="codex-activity-title">{matchedPlugin?.displayName ?? item.title}</span>
          {matchedPlugin?.displayName && item.title !== 'Used tool' ? (
            <span className="codex-activity-target-pill">{item.title}</span>
          ) : null}
        </span>
        {item.detail ? <span className="codex-activity-detail">{item.detail}</span> : null}
      </span>
      {item.statusLabel ? (
        <span className={`codex-activity-status is-${item.status}`}>{item.statusLabel}</span>
      ) : null}
      {canExpand ? (
        <ChevronDown
          size={13}
          className={`codex-activity-row-chevron ${expanded ? 'is-open' : ''}`}
          aria-hidden="true"
        />
      ) : null}
    </>
  );

  return (
    <div className={`codex-activity-row-wrap ${expanded ? 'is-expanded' : ''}`}>
      {canExpand ? (
        <button
          type="button"
          className={`codex-activity-row ${isRunning ? 'is-running' : ''}`}
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          {rowContent}
        </button>
      ) : (
        <div className={`codex-activity-row ${isRunning ? 'is-running' : ''}`}>{rowContent}</div>
      )}
      {expanded ? (
        <div className="codex-activity-row-details">
          <ActivityDetailSections sections={item.detailSections} />
          <MessageAttachments attachments={message.attachments} compact />
        </div>
      ) : null}
    </div>
  );
}

function ActivitySummaryRow({
  group,
  expanded,
  isLive,
  onToggle
}: {
  group: ActivityGroup;
  expanded: boolean;
  isLive: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`codex-activity-summary-toggle ${isLive ? 'is-live' : ''}`}
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <ChevronDown
        size={14}
        className={`codex-activity-summary-chevron ${expanded ? 'is-open' : ''}`}
        aria-hidden="true"
      />
      <span className="codex-activity-summary-text">{group.title}</span>
      {group.durationLabel && group.durationLabel !== group.title ? (
        <span className="codex-activity-summary-meta">{group.durationLabel}</span>
      ) : null}
      {group.imageCount > 0 ? (
        <span className="codex-activity-summary-meta">
          {group.imageCount} screenshot{group.imageCount === 1 ? '' : 's'}
        </span>
      ) : null}
    </button>
  );
}

function ActivityGroupRow({
  group,
  plugins = [],
  providerToneName = 'codex',
  isLatest = false
}: {
  group: ActivityGroup;
  plugins?: CatalogPlugin[];
  providerToneName?: ProviderTone;
  isLatest?: boolean;
}) {
  const isLive = group.status === 'running' && isLatest;
  const [expanded, setExpanded] = useState(isLive);
  const userToggledRef = useRef(false);
  const lastStatusRef = useRef(group.status);

  useEffect(() => {
    if (lastStatusRef.current !== group.status) {
      userToggledRef.current = false;
      lastStatusRef.current = group.status;
    }

    if (isLive) {
      setExpanded(true);
      return;
    }

    if (!userToggledRef.current) {
      setExpanded(false);
    }
  }, [group.id, group.status, isLive]);

  const handleToggle = () => {
    if (!isLive) {
      userToggledRef.current = true;
    }
    setExpanded((previous) => !previous);
  };

  const latestRunningItemId = useMemo(() => {
    for (let index = group.items.length - 1; index >= 0; index -= 1) {
      const item = group.items[index]!;
      if (item.status === 'running') {
        return item.id;
      }
    }
    return undefined;
  }, [group.items]);

  return (
    <section
      className={`codex-activity-group provider-${providerToneName} ${expanded ? 'is-expanded' : ''} ${isLive ? 'is-live' : ''}`}
      data-activity-status={group.status}
      data-scroll-anchor="true"
    >
      <ActivitySummaryRow
        group={group}
        expanded={expanded}
        isLive={isLive}
        onToggle={handleToggle}
      />
      {expanded ? (
        <div className="codex-activity-group-items">
          {group.items.map((item) => (
            <ActivityRow
              key={item.id}
              item={item}
              plugins={plugins}
              isLatestRunningActivity={isLive && item.id === latestRunningItemId}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function ThreadView({
  thread,
  onClose,
  onOpenSidebar,
  fetchTranscript,
  sendMessage,
  stopWork,
  deleteThread,
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
  const [deletingThread, setDeletingThread] = useState(false);
  const [error, setError] = useState('');
  const [mention, setMention] = useState<{ trigger: MentionTrigger; query: string; start: number; end: number } | undefined>();
  const [files, setFiles] = useState<{ path: string; relativePath: string }[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelUpdating, setModelUpdating] = useState(false);
  const [collaborationMode, setCollaborationMode] =
    useState<CollaborationModeKind>('default');
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
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
  // After the first transcript paint for a thread, we pin to the bottom like OpenAssist.
  // Later stream updates only follow when the user is still near the bottom.
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
  const provider = providerForThread(thread.provider);
  const providerName = providerLabel(provider);
  const composerPlugins = provider === 'codex' ? plugins : [];
  const composerSkills = provider === 'codex' ? skills : [];
  const composerCommands = provider === 'codex' ? commands : [];
  const effectiveModelName = modelName || thread.model;
  const providerModels = useMemo(
    () => models.filter((model) => providerForModel(model) === provider && model.visibility !== 'hidden'),
    [models, provider]
  );
  const normalizedSelectedModelSlug = normalizeProviderModelSlug(
    provider,
    selectedModelSlug ?? effectiveModelName
  );
  const canChangeModel = providerModels.length > 0;

  useEffect(() => {
    if (!canChangeModel && modelPickerOpen) {
      setModelPickerOpen(false);
    }
  }, [canChangeModel, modelPickerOpen]);

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
  const showContextBar = Boolean(transcript?.usage || provider);
  const threadSaysWaitingApproval =
    thread.status === 'waiting_approval' || sendBlockReason === 'waiting_on_approval';
  const isCompacting =
    thread.status === 'compacting' || sendBlockReason === 'compacting_context';
  const isWaitingForApproval = hasPendingRequest || threadSaysWaitingApproval;
  const pendingRequestStatus = hasPendingRequest
    ? hasPendingPermissionRequest
      ? `${providerName} needs permission`
      : pendingRequests.some((request) => request.kind === 'question')
        ? `${providerName} needs an answer`
        : `${providerName} needs approval`
    : null;
  const transcriptSaysMirrorWorking = Boolean(
    transcript &&
      !isHardSendBlock &&
      (transcript.activeTurnId?.startsWith(MIRROR_STREAMING_TURN_PREFIX) ||
        (transcript.sendState.reason === 'thread_changed' &&
          transcript.sendState.label.endsWith(' is working')))
  );
  const waitingApprovalStatus = pendingRequestStatus
    ? pendingRequestStatus
    : threadSaysWaitingApproval
      ? `${providerName} is waiting for approval`
      : null;
  const isCodexActive =
    forceWorking || transcriptSaysMirrorWorking || threadSaysWaitingApproval || isCompacting;
  const isAgentWorking = isCodexActive && !isWaitingForApproval;
  const showStopComposerAction = Boolean(stopWork && isAgentWorking);
  const canUseComposer = Boolean(
    sendMessage &&
      !sending &&
      !isWaitingForApproval &&
      (transcript?.sendState.canSend || (isCodexActive && !isHardSendBlock))
  );
  const canSend = Boolean(canUseComposer && trimmedDraft);
  const displayedModelName = effectiveModelName ? formatModelName(effectiveModelName) : providerName;
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
  // - When sending: "Sending to {provider}..."
  // - When sendState blocks sending: show the explicit reason (e.g. "Approve on Mac to continue")
  //   only for hard blocks that really require the user to wait or use the Mac.
  // - Else when the provider says the thread is active: "{provider} is working"
  // - Otherwise: sendState.label (which may be "Ready", "Mobile sending is off on the Mac.", etc.)
  // - If loading and no transcript yet: "Loading conversation..."
  const sendBlockedLabel =
    transcript && !transcript.sendState.canSend && isHardSendBlock
      ? transcript.sendState.label
      : null;
  const statusText = sending
    ? `Sending to ${providerName}...`
    : waitingApprovalStatus
      ? waitingApprovalStatus
      : isCompacting
        ? (transcript?.sendState.reason === 'compacting_context'
            ? transcript.sendState.label
            : 'Automatically compacting context')
      : sendBlockedLabel
        ? sendBlockedLabel
        : isAgentWorking
          ? ''
          : transcript?.sendState.label.endsWith(' is working')
            ? 'Ready'
            : transcript?.sendState.label ?? (loading ? 'Loading conversation...' : '');
  const showStatusText = statusText.trim().length > 0;

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
  // Identify the latest activity group so live work can stay expanded while older work
  // stays as a compact OpenAssist-style summary.
  const latestActivityGroupId = useMemo(() => {
    for (let i = renderable.length - 1; i >= 0; i -= 1) {
      const entry = renderable[i]!;
      if (entry.type === 'activityGroup') {
        return entry.group.id;
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


  // Initial-paint positioning + pinned-bottom live scrolling.
  //
  // OpenAssist behavior:
  // - first paint starts at the bottom;
  // - live updates keep following only while the user is already near the bottom;
  // - if the user scrolls up, streamed progress and final collapse do not yank them.
  useEffect(() => {
    const node = messagesRef.current;
    if (!node) {
      return;
    }
    if (loading) {
      return;
    }

    if (!hasPositionedInitialRef.current) {
      node.scrollTop = node.scrollHeight;
      pinnedToBottomRef.current = true;
      hasPositionedInitialRef.current = true;
      return;
    }

    if (pinnedToBottomRef.current) {
      requestAnimationFrame(() => {
        const current = messagesRef.current;
        if (current && pinnedToBottomRef.current) {
          current.scrollTop = current.scrollHeight;
        }
      });
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
    if (detected?.trigger === '/' && provider !== 'codex') {
      setMention(undefined);
      return;
    }
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
    setComposerMenuOpen(false);
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
    // Anchor the visible row itself. This is smoother than scroll-height math because
    // loading spinners and collapsed activity rows can change height during the same
    // render pass.
    const anchor = node ? captureScrollAnchor(node) : null;
    const scrollHeightMinusTop = node ? node.scrollHeight - node.scrollTop : 0;
    let shouldRestoreAnchor = false;

    try {
      const response = await fetchOlderMessages(oldestMessageId, OLDER_MESSAGES_PAGE_SIZE);
      if (response.messages.length > 0) {
        shouldRestoreAnchor = true;
        setOlderMessages((current) => {
          const seen = new Set(current.map((m) => m.id));
          const additions = response.messages.filter((m) => !seen.has(m.id));
          return [...additions, ...current];
        });
      }
      setHasMoreOlder(response.hasMore);
    } catch (loadError) {
      setOlderError(
        loadError instanceof Error ? loadError.message : 'Could not load older messages.'
      );
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      if (shouldRestoreAnchor) {
        requestAnimationFrame(() => {
          const current = messagesRef.current;
          if (current) {
            restoreScrollAnchor(current, anchor, scrollHeightMinusTop);
            pinnedToBottomRef.current = false;
          }
        });
      }
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
    if (provider !== 'codex') {
      setError(`${providerName} chats are controlled directly in Agent Pulse.`);
      return;
    }

    setOpeningCodex(true);
    setError('');
    try {
      await openThreadInCodex(thread.threadId);
    } catch (openError) {
      setError(
        openError instanceof Error ? openError.message : `Could not open this thread in ${providerName}.`
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
      setError(stopError instanceof Error ? stopError.message : `Could not stop ${providerName}.`);
    } finally {
      setStopping(false);
    }
  };

  const handleDeleteThread = async () => {
    if (!deleteThread || deletingThread) {
      return;
    }
    const confirmed = window.confirm(
      provider === 'codex'
        ? 'Delete this thread from Codex history? You cannot undo this from Agent Pulse.'
        : `Delete this thread from local ${providerName} history? You cannot undo this from Agent Pulse.`
    );
    if (!confirmed) {
      return;
    }

    setDeletingThread(true);
    setError('');
    try {
      await deleteThread(thread.threadId);
      onClose?.();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete this thread.');
    } finally {
      setDeletingThread(false);
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
            aria-label={`${providerName} needs approval`}
          >
            <span>{hasPendingPermissionRequest ? 'Permission' : 'Approval'}</span>
          </span>
        ) : isCompacting ? (
          <span
            className="codex-thread-working-badge is-compacting"
            role="status"
            aria-live="polite"
            aria-label={`${providerName} is compacting context`}
          >
            <span className="codex-thread-working-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>Compacting</span>
          </span>
        ) : null}

        <div className="codex-thread-actions">
          {openThreadInCodex && provider === 'codex' ? (
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
          {deleteThread ? (
            <button
              className="codex-thread-delete"
              type="button"
              onClick={() => void handleDeleteThread()}
              disabled={deletingThread}
              aria-label={deletingThread ? 'Deleting thread' : 'Delete thread'}
              title={deletingThread ? 'Deleting thread' : 'Delete thread'}
            >
              <Trash2 size={14} />
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

      {showStatusText ? (
        <div className="codex-thread-status">
          <span>{statusText}</span>
        </div>
      ) : null}

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
          if (entry.type === 'activityGroup') {
            return (
              <ActivityGroupRow
                key={entry.group.id}
                group={entry.group}
                plugins={plugins}
                providerToneName={providerTone(provider)}
                isLatest={entry.group.id === latestActivityGroupId}
              />
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
                data-scroll-anchor="true"
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
            <div
              key={message.id}
              className="codex-message codex-message--assistant"
              data-message-id={message.id}
              data-scroll-anchor="true"
            >
              <div className={`codex-message-avatar provider-${providerTone(provider)}`} aria-hidden="true">
                <ProviderMark provider={provider} size="sm" />
              </div>
              <div className="codex-message-body">
                <MessageAttachments attachments={message.attachments} />
                <article className="codex-prose">
                  {message.text.trim() ? <MessageMarkdown text={message.text} /> : null}
                </article>
              </div>
            </div>
          );
        })}
      </div>

      <div className="codex-thread-bottom-panel">
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
              plugins={composerPlugins}
              skills={composerSkills}
              commands={composerCommands}
              files={files}
              filesLoading={filesLoading}
              onSelect={insertMention}
              onClose={() => setMention(undefined)}
            />
          ) : null}
          <label className="sr-only" htmlFor={`message-${thread.threadId}`}>
            Message {providerName}
          </label>
          <textarea
            id={`message-${thread.threadId}`}
            ref={textareaRef}
            className="codex-composer-input"
            placeholder={`Ask ${providerName} anything`}
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
                if (showStopComposerAction) {
                  return;
                }
                void handleSend();
              }
            }}
            disabled={!canUseComposer}
          />
          <div className="codex-composer-row">
            <div className="codex-composer-row-left">
              <div className={`codex-composer-add-menu ${composerMenuOpen ? 'is-open' : ''}`}>
                <button
                  className="codex-composer-add"
                  type="button"
                  aria-label="Open composer options"
                  aria-expanded={composerMenuOpen}
                  onClick={() => setComposerMenuOpen((open) => !open)}
                  disabled={!sendMessage}
                >
                  <Plus size={16} />
                </button>
                {composerMenuOpen ? (
                  <div className="codex-composer-menu" role="menu">
                    <button
                      type="button"
                      className={`codex-composer-menu-item ${collaborationMode === 'plan' ? 'is-active' : ''}`}
                      role="menuitemcheckbox"
                      aria-checked={collaborationMode === 'plan'}
                      onClick={() => {
                        setCollaborationMode((current) => (current === 'plan' ? 'default' : 'plan'));
                        setComposerMenuOpen(false);
                      }}
                    >
                      <ListChecks size={14} aria-hidden="true" />
                      <span>Plan mode</span>
                      <span className="codex-composer-menu-meta">
                        {collaborationMode === 'plan' ? 'On' : 'Off'}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="codex-composer-menu-item"
                      role="menuitem"
                      disabled
                      title={`Image sending is not wired for ${providerName} yet`}
                    >
                      <ImagePlus size={14} aria-hidden="true" />
                      <span>Add image</span>
                      <span className="codex-composer-menu-meta">Soon</span>
                    </button>
                  </div>
                ) : null}
              </div>
              <ModelChip
                providerName={providerName}
                provider={provider}
                models={canChangeModel ? providerModels : []}
                selectedModelSlug={normalizedSelectedModelSlug}
                selectedReasoningEffort={selectedReasoningEffort}
                fallbackLabel={displayedModelName}
                isOpen={modelPickerOpen}
                onOpen={() => setModelPickerOpen(true)}
                onClose={() => setModelPickerOpen(false)}
                onChangeModel={canChangeModel ? onChangeModel : undefined}
                onError={(message) => setError(message)}
                disabled={modelUpdating || !onChangeModel || !canChangeModel}
                setUpdating={setModelUpdating}
              />
              {collaborationMode === 'plan' ? (
                <span className="codex-composer-mode-indicator">
                  <ListChecks size={13} aria-hidden="true" />
                  Plan
                </span>
              ) : null}
            </div>
            <div className="codex-composer-actions">
              <button
                className={`codex-composer-send ${showStopComposerAction ? 'is-stop' : ''}`}
                type={showStopComposerAction ? 'button' : 'submit'}
                onClick={showStopComposerAction ? () => void handleStopWork() : undefined}
                disabled={showStopComposerAction ? stopping : !canSend}
                aria-label={
                  showStopComposerAction
                    ? stopping
                      ? `Stopping ${providerName}`
                      : `Stop ${providerName}`
                    : sending
                      ? 'Sending'
                      : 'Send message'
                }
                title={
                  showStopComposerAction
                    ? stopping
                      ? `Stopping ${providerName}`
                      : `Stop ${providerName}`
                    : 'Send message'
                }
              >
                {showStopComposerAction ? (
                  <Square size={11} fill="currentColor" />
                ) : sending ? (
                  <Spinner size={16} />
                ) : (
                  <ArrowUp size={16} />
                )}
              </button>
            </div>
          </div>
          {showContextBar ? (
            <div className="codex-composer-context-bar">
              <span
                className={`codex-thread-usage-provider provider-${providerTone(provider)}`}
                aria-label={`Provider: ${providerName}`}
              >
                <span className="provider-inline-dot" aria-hidden="true" />
                <span className="provider-inline-text">{providerName}</span>
              </span>
              {transcript?.usage ? <UsageBadges usage={transcript.usage} /> : null}
            </div>
          ) : null}
        </div>
      </form>
      </div>

    </section>
  );
}

function ModelChip({
  providerName,
  provider,
  models,
  selectedModelSlug,
  selectedReasoningEffort,
  fallbackLabel,
  isOpen,
  onOpen,
  onClose,
  onChangeModel,
  onError,
  disabled,
  setUpdating
}: {
  providerName: string;
  provider: Thread['provider'];
  models: CatalogModel[];
  selectedModelSlug?: string;
  selectedReasoningEffort?: string;
  fallbackLabel: string;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChangeModel?: (modelSlug: string, reasoningEffort?: string) => Promise<void>;
  onError?: (message: string) => void;
  disabled: boolean;
  setUpdating: (value: boolean) => void;
}) {
  const selected = models.find((model) => model.slug === selectedModelSlug);
  const modelGroups = useMemo(() => groupModelsForPicker(provider, models), [provider, models]);
  const [expandedGroupIds, setExpandedGroupIds] = useState<string[]>([]);
  const label = selected?.displayName ?? fallbackLabel;
  const reasoningLabel = selectedReasoningEffort
    ? capitalize(selectedReasoningEffort)
    : selected?.defaultReasoningLevel
      ? capitalize(selected.defaultReasoningLevel)
      : undefined;

  useEffect(() => {
    if (!isOpen && expandedGroupIds.length > 0) {
      setExpandedGroupIds([]);
    }
  }, [expandedGroupIds.length, isOpen]);

  if (!onChangeModel || models.length === 0) {
    return (
      <span className="codex-composer-model" aria-label={`Current ${providerName} model`}>
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
          {modelGroups.map((group) => {
            const expanded = expandedGroupIds.includes(group.id);
            const rows = group.models.map((model) => (
              <ModelMenuRow
                key={model.slug}
                model={model}
                selectedReasoningEffort={
                  model.slug === selectedModelSlug
                    ? selectedReasoningEffort ?? model.defaultReasoningLevel
                    : undefined
                }
                isSelected={model.slug === selectedModelSlug}
                onPick={async (effort) => {
                  onClose();
                  onError?.('');
                  if (!onChangeModel) {
                    return;
                  }
                  setUpdating(true);
                  try {
                    await onChangeModel(model.slug, effort);
                  } catch (error) {
                    onError?.(
                      error instanceof Error
                        ? error.message
                        : `Could not update the ${providerName} model.`
                    );
                  } finally {
                    setUpdating(false);
                  }
                }}
              />
            ));

            if (!group.collapsible) {
              return rows;
            }

            return (
              <section
                key={group.id}
                className={`codex-composer-model-group ${expanded ? 'is-open' : ''}`}
              >
                <button
                  type="button"
                  className="codex-composer-model-group-toggle"
                  onClick={() =>
                    setExpandedGroupIds((current) =>
                      current.includes(group.id)
                        ? current.filter((candidate) => candidate !== group.id)
                        : [...current, group.id]
                    )
                  }
                  aria-expanded={expanded}
                >
                  <span className="codex-composer-model-group-label">{group.label}</span>
                  <span className="codex-composer-model-group-meta">{group.models.length}</span>
                  {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
                {expanded ? <div className="codex-composer-model-group-body">{rows}</div> : null}
              </section>
            );
          })}
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
          {isSelected ? 'Selected' : 'Use model'}
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
  'claudeCode/canUseTool',
  'claudeCode/elicitation',
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
  // Codex's RequestUserInputResponse is `{ answers: HashMap<questionId,
  // RequestUserInputAnswer> }` where RequestUserInputAnswer is
  // `{ answers: Vec<String> }` (so multi-select is supported even though our UI
  // is single-select for now). We wrap each per-question string into the
  // single-element vector form Codex expects.
  const submitQuestionAnswer = async (label: string, answersById: Record<string, string>) => {
    const wrapped: Record<string, { answers: string[] }> = {};
    for (const [questionId, answer] of Object.entries(answersById)) {
      wrapped[questionId] = { answers: [answer] };
    }
    await submit(label, { answers: wrapped });
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
      // Codex's RequestUserInputQuestion uses `id` to key answers in the
      // response. Fall back to `name` (older builds) and finally a synthetic
      // index so the form still renders if Codex changes the field name.
      const id =
        typeof questionEntry.id === 'string' && questionEntry.id.trim()
          ? questionEntry.id.trim()
          : typeof questionEntry.name === 'string' && questionEntry.name.trim()
            ? questionEntry.name.trim()
            : `q_${index}`;
      const header =
        typeof questionEntry.header === 'string' ? questionEntry.header : undefined;
      const text =
        typeof questionEntry.question === 'string' ? questionEntry.question : undefined;
      const isSecret = questionEntry.isSecret === true;
      // Real Codex builds send `options: [{ label, description }]`. Older
      // ones may use `suggestions: [{ value, label, tooltip }]`. Accept both.
      const rawOptions = Array.isArray(questionEntry.options)
        ? (questionEntry.options as unknown[])
        : Array.isArray(questionEntry.suggestions)
          ? (questionEntry.suggestions as unknown[])
          : [];
      const suggestions: RawSuggestion[] = rawOptions
        .map((option) => normalizeSuggestion(option))
        .filter((option): option is RawSuggestion => option !== null);
      return [{ id, header, text, suggestions, isSecret }];
    });
  }, [request.params]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const allAnswered = questions.every(
    (question) => (answers[question.id] ?? '').trim().length > 0
  );
  const submitDisabled = Boolean(submitting) || !allAnswered;

  if (questions.length === 0) {
    return <p className="codex-pending-request-hint">Open Codex on your Mac to answer.</p>;
  }

  return (
    <div className="codex-pending-request-question">
      {questions.map((question) => {
        const value = answers[question.id] ?? '';
        return (
          <div key={question.id} className="codex-pending-request-question-block">
            {question.text ? (
              <p className="codex-pending-request-question-text">{question.text}</p>
            ) : null}
            {question.suggestions.length > 0 ? (
              <div className="codex-pending-request-question-suggestions">
                {question.suggestions.map((suggestion) => {
                  const active = value === suggestion.value;
                  return (
                    <button
                      key={`${question.id}:${suggestion.value}`}
                      type="button"
                      className={`codex-pending-request-suggestion${
                        active ? ' is-active' : ''
                      }`}
                      title={suggestion.tooltip}
                      onClick={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: suggestion.value
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
              type={question.isSecret ? 'password' : 'text'}
              className="codex-pending-request-question-input"
              placeholder={
                question.suggestions.length > 0
                  ? 'Or type your own answer...'
                  : 'Type your answer...'
              }
              value={value}
              onChange={(event) =>
                setAnswers((current) => ({
                  ...current,
                  [question.id]: event.target.value
                }))
              }
              autoComplete={question.isSecret ? 'new-password' : 'off'}
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
  id: string;
  header?: string;
  text?: string;
  suggestions: RawSuggestion[];
  isSecret?: boolean;
};

function normalizeSuggestion(raw: unknown): RawSuggestion | null {
  if (typeof raw === 'string') {
    return { value: raw };
  }
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  // Codex's RequestUserInputQuestionOption is { label: string, description: string }.
  // We send `label` back as the answer string. For older/alternate shapes we
  // fall back to `value` then to `label` as the answer key. The `description`
  // is the per-option hint Codex shows in its desktop UI ("what does this
  // option do") — we display it under the label on the tablet, and we also
  // accept the older `tooltip`/`hint` field names just in case.
  const label = typeof record.label === 'string' ? record.label : undefined;
  const value =
    typeof record.value === 'string'
      ? record.value
      : label ?? null;
  if (!value) {
    return null;
  }
  const tooltip =
    typeof record.description === 'string'
      ? record.description
      : typeof record.tooltip === 'string'
        ? record.tooltip
        : typeof record.hint === 'string'
          ? record.hint
          : undefined;
  return {
    value,
    ...(label ? { label } : {}),
    ...(tooltip ? { tooltip } : {})
  };
}

function UsageBadges({ usage }: { usage: ThreadUsage }) {
  const windowItems: { label: string; value: string; resetsAt?: number; minutes: number }[] = [];
  if (usage.primaryWindow) {
    const minutes = usage.primaryWindow.windowMinutes ?? 300;
    windowItems.push({
      label: usage.primaryWindow.label ?? formatWindowLabel(minutes),
      value: `${Math.round(usage.primaryWindow.usedPercent)}%`,
      resetsAt: usage.primaryWindow.resetsAt,
      minutes
    });
  }
  if (usage.secondaryWindow) {
    const minutes = usage.secondaryWindow.windowMinutes ?? 10080;
    windowItems.push({
      label: usage.secondaryWindow.label ?? formatWindowLabel(minutes),
      value: `${Math.round(usage.secondaryWindow.usedPercent)}%`,
      resetsAt: usage.secondaryWindow.resetsAt,
      minutes
    });
  }
  const hasContext = typeof usage.contextUsedPercent === 'number';
  if (!hasContext && windowItems.length === 0) {
    return null;
  }
  return (
    <div className="codex-thread-usage" role="status" aria-label="Agent usage">
      {windowItems.map((item) => {
        const resetText = formatUsageResetText(item.resetsAt, item.minutes);
        const tooltip = resetText
          ? `${item.label} ${item.value} · ${resetText}`
          : `${item.label} ${item.value}`;
        return (
          <button
            key={item.label}
            type="button"
            className="codex-thread-usage-item tone-window"
            aria-label={tooltip}
            title={tooltip}
          >
            <span className="codex-thread-usage-label">{item.label}</span>
            <span className="codex-thread-usage-value">{item.value}</span>
            <span className="codex-thread-usage-ring-tooltip">
              {resetText ?? `${item.label} ${item.value}`}
            </span>
          </button>
        );
      })}
      {hasContext ? (
        <UsageRing label="Context" percent={usage.contextUsedPercent as number} tone="context" />
      ) : null}
    </div>
  );
}

function formatUsageResetText(resetsAt: number | undefined, minutes: number): string | undefined {
  if (!resetsAt) {
    return undefined;
  }
  const date = new Date(resetsAt * 1000);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const longWindow = minutes >= 24 * 60;
  const formatter = new Intl.DateTimeFormat(undefined, longWindow
    ? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { hour: 'numeric', minute: '2-digit' }
  );
  return `Resets ${formatter.format(date)}`;
}

function UsageRing({
  label,
  percent,
  tone
}: {
  label: string;
  percent: number;
  tone: 'context' | 'window';
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const rounded = Math.round(clamped);
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const tooltip = `${label} ${rounded}%`;
  return (
    <button
      type="button"
      className={`codex-thread-usage-ring tone-${tone}`}
      aria-label={tooltip}
      title={tooltip}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.2"
        />
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="codex-thread-usage-ring-tooltip">{tooltip}</span>
    </button>
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
