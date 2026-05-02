import type { ChatMessage } from '@agent-pulse/shared';

export type WorkSummaryKind =
  | 'browser'
  | 'command'
  | 'file'
  | 'message'
  | 'plan'
  | 'reasoning'
  | 'search'
  | 'status'
  | 'subagent'
  | 'tool';

export type ActivityStatus = 'completed' | 'failed' | 'running';

export type ActivityDetailSection = {
  id: string;
  title: string;
  body: string;
  code?: boolean;
};

export type ActivityGroupItem = {
  id: string;
  message: ChatMessage;
  kind: WorkSummaryKind;
  title: string;
  detail?: string;
  status: ActivityStatus;
  statusLabel?: string;
  createdAt: string;
  detailSections: ActivityDetailSection[];
};

export type ActivityGroup = {
  id: string;
  messages: ChatMessage[];
  items: ActivityGroupItem[];
  status: Extract<ActivityStatus, 'completed' | 'running'>;
  title: string;
  durationLabel?: string;
  startedAt?: string;
  endedAt?: string;
  imageCount: number;
  hasFinalResponse: boolean;
};

export type RenderableEntry =
  | { type: 'message'; message: ChatMessage }
  | { type: 'activityGroup'; group: ActivityGroup };

export function buildRenderableEntries(
  messages: ChatMessage[],
  options: { isLive?: boolean } = {}
): RenderableEntry[] {
  const result: RenderableEntry[] = [];
  let turnBuffer: ChatMessage[] = [];
  let leadingBuffer: ChatMessage[] = [];
  let hasVisibleUserTurn = false;
  const orderedMessages = sortMessagesByCreatedAt(messages);

  const flushTurn = () => {
    if (turnBuffer.length === 0) {
      return;
    }

    const finalIndex = findFinalResponseIndex(turnBuffer, options);
    const finalMessage = finalIndex >= 0 ? turnBuffer[finalIndex]! : null;
    const activityMessages = finalMessage
      ? turnBuffer.filter((_, index) => index !== finalIndex)
      : turnBuffer.slice();

    if (activityMessages.length > 0) {
      result.push({
        type: 'activityGroup',
        group: buildActivityGroup(activityMessages, finalMessage)
      });
    }

    if (finalMessage) {
      result.push({ type: 'message', message: finalMessage });
    }

    turnBuffer = [];
  };

  for (const message of orderedMessages) {
    if (message.role === 'user') {
      if (hasVisibleUserTurn) {
        flushTurn();
      }
      result.push({ type: 'message', message });
      hasVisibleUserTurn = true;
      if (leadingBuffer.length > 0) {
        turnBuffer.push(...leadingBuffer);
        leadingBuffer = [];
      }
      continue;
    }

    if (!hasVisibleUserTurn) {
      leadingBuffer.push(message);
    } else {
      turnBuffer.push(message);
    }
  }

  if (hasVisibleUserTurn) {
    flushTurn();
  } else {
    turnBuffer = leadingBuffer;
    leadingBuffer = [];
    flushTurn();
  }
  return result;
}

export function findFinalResponseIndex(
  messages: ChatMessage[],
  options: { isLive?: boolean } = {}
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === 'assistant' &&
      message.kind === 'message' &&
      message.phase === 'final_answer' &&
      message.text.trim()
    ) {
      return index;
    }
  }

  if (options.isLive) {
    return -1;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === 'assistant' &&
      message.kind === 'message' &&
      message.phase !== 'commentary' &&
      message.text.trim()
    ) {
      return index;
    }
  }

  return -1;
}

function sortMessagesByCreatedAt(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const aTime = Date.parse(a.message.createdAt);
      const bTime = Date.parse(b.message.createdAt);
      const safeA = Number.isFinite(aTime) ? aTime : 0;
      const safeB = Number.isFinite(bTime) ? bTime : 0;
      return safeA === safeB ? a.index - b.index : safeA - safeB;
    })
    .map((entry) => entry.message);
}

export function formatWorkLabel(
  messages: ChatMessage[],
  startedAt?: string,
  endedAt?: string
): string {
  const counts = messages.reduce<Record<WorkSummaryKind, number>>(
    (acc, message) => {
      const kind = classifyWorkMessage(message);
      acc[kind] += 1;
      return acc;
    },
    {
      browser: 0,
      command: 0,
      file: 0,
      message: 0,
      plan: 0,
      reasoning: 0,
      search: 0,
      status: 0,
      subagent: 0,
      tool: 0
    }
  );

  const fragments: string[] = [];
  if (counts.command > 0) {
    fragments.push('explored the workspace');
  }
  if (counts.file > 0) {
    fragments.push(`edited ${counts.file} file${counts.file === 1 ? '' : 's'}`);
  }
  if (counts.search > 0) {
    fragments.push(`ran ${counts.search} search${counts.search === 1 ? '' : 'es'}`);
  }
  if (counts.browser > 0) {
    fragments.push(`used the browser${counts.browser > 1 ? ` ${counts.browser} times` : ''}`);
  }
  if (counts.subagent > 0) {
    fragments.push(`used ${counts.subagent} subagent step${counts.subagent === 1 ? '' : 's'}`);
  }
  if (counts.tool > 0) {
    fragments.push(`used ${counts.tool} tool${counts.tool === 1 ? '' : 's'}`);
  }

  if (fragments.length > 0) {
    const joined = fragments.slice(0, 3).join(', ');
    return joined.charAt(0).toUpperCase() + joined.slice(1);
  }

  if (counts.reasoning > 0) {
    return 'Thought through the task';
  }
  if (counts.plan > 0) {
    return 'Planned the work';
  }
  if (counts.message > 0) {
    return 'Shared progress';
  }

  return formatActivityDuration(messages, startedAt, endedAt) ?? `Activity`;
}

export function formatActivityDuration(
  messages: ChatMessage[],
  startedAt?: string,
  endedAt?: string
): string | undefined {
  const first = Date.parse(startedAt ?? messages[0]?.createdAt ?? '');
  const last = Date.parse(endedAt ?? messages[messages.length - 1]?.createdAt ?? '');
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) {
    return undefined;
  }

  const seconds = Math.round((last - first) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `Worked for ${minutes}m ${remainingSeconds}s`;
  }
  return `Worked for ${seconds}s`;
}

export function classifyWorkMessage(message: ChatMessage): WorkSummaryKind {
  switch (message.kind) {
    case 'command':
      return 'command';
    case 'file':
      return 'file';
    case 'reasoning':
      return 'reasoning';
    case 'plan':
      return 'plan';
    case 'status':
      return 'status';
    case 'message':
      return message.phase === 'commentary' ? 'reasoning' : 'message';
    case 'tool': {
      const text = message.text.toLowerCase();
      if (
        text.includes('web_search') ||
        text.includes('web.search') ||
        text.includes('web search') ||
        text.includes('search_query') ||
        text.includes('image_query')
      ) {
        return 'search';
      }
      if (
        text.includes('browser') ||
        text.includes('playwright') ||
        text.includes('screenshot') ||
        text.includes('computer_use') ||
        text.includes('computer use')
      ) {
        return 'browser';
      }
      if (text.includes('spawn_agent') || text.includes('subagent')) {
        return 'subagent';
      }
      return 'tool';
    }
    default:
      return 'status';
  }
}

function buildActivityGroup(
  messages: ChatMessage[],
  finalMessage: ChatMessage | null
): ActivityGroup {
  const startedAt = messages[0]?.createdAt;
  const endedAt = finalMessage?.createdAt ?? messages[messages.length - 1]?.createdAt;
  const hasFinalResponse = Boolean(finalMessage);
  const status = hasFinalResponse ? 'completed' : 'running';
  const latestIndex = messages.length - 1;
  const items = messages.map((message, index) =>
    buildActivityGroupItem(
      message,
      status === 'completed' || index !== latestIndex ? 'completed' : 'running'
    )
  );

  return {
    id: `activity-${messages[0]?.id ?? 'group'}`,
    messages,
    items,
    status,
    title: formatWorkLabel(messages, startedAt, endedAt),
    durationLabel: formatActivityDuration(messages, startedAt, endedAt),
    startedAt,
    endedAt,
    imageCount: messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0),
    hasFinalResponse
  };
}

function buildActivityGroupItem(
  message: ChatMessage,
  status: ActivityStatus
): ActivityGroupItem {
  const kind = classifyWorkMessage(message);
  const detail = summarizeActivityDetail(message, kind);
  return {
    id: message.id,
    message,
    kind,
    title: activityTitleForKind(kind, message),
    detail,
    status,
    statusLabel: status === 'running' ? 'Running' : undefined,
    createdAt: message.createdAt,
    detailSections: buildActivityDetailSections(message, kind)
  };
}

function activityTitleForKind(kind: WorkSummaryKind, message: ChatMessage): string {
  switch (kind) {
    case 'browser':
      return 'Used browser';
    case 'command':
      return 'Explored workspace';
    case 'file':
      return 'Edited file';
    case 'message':
      return 'Progress update';
    case 'plan':
      return 'Updated plan';
    case 'reasoning':
      return message.phase === 'commentary' ? 'Thinking' : 'Reasoning';
    case 'search':
      return 'Searched';
    case 'status':
      return 'Status';
    case 'subagent':
      return 'Used subagent';
    case 'tool':
      return 'Used tool';
    default:
      return 'Activity';
  }
}

function summarizeActivityDetail(message: ChatMessage, kind: WorkSummaryKind): string | undefined {
  const trimmed = normalizeWhitespace(message.text);
  if (!trimmed) {
    return undefined;
  }

  if (kind === 'command') {
    return formatCommandSummary(trimmed);
  }

  const firstLine = message.text.split('\n').find((line) => line.trim().length > 0)?.trim();
  return truncate(firstLine ?? trimmed, kind === 'reasoning' ? 120 : 100);
}

function buildActivityDetailSections(
  message: ChatMessage,
  kind: WorkSummaryKind
): ActivityDetailSection[] {
  const body = message.text.trim();
  if (!body) {
    return [];
  }

  const title =
    kind === 'command'
      ? 'Command'
      : kind === 'file'
        ? 'File change'
        : kind === 'plan'
          ? 'Plan'
          : kind === 'reasoning'
            ? 'Reasoning'
            : kind === 'search'
              ? 'Search'
              : kind === 'browser'
                ? 'Browser'
                : kind === 'message'
                  ? 'Message'
                  : 'Details';

  return [
    {
      id: `${message.id}-raw`,
      title,
      body,
      code: message.kind !== 'message'
    }
  ];
}

function formatCommandSummary(text: string): string {
  const stripped = text
    .replace(/^\/bin\/(?:ba|z)?sh\s+-l?c\s+/, '')
    .replace(/^["']|["']$/g, '');
  return truncate(stripped, 90);
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function truncate(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max - 1).trimEnd()}…` : input;
}
