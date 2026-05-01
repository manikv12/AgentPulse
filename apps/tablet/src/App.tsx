import {
  LiveEventSchema,
  ThreadSchema,
  ThreadTranscriptSchema,
  type CatalogCommand,
  type CatalogModel,
  type CatalogPlugin,
  type CatalogSkill,
  type CollaborationModeKind,
  type HelperHealth,
  type LiveEvent,
  type PairingDeviceOption,
  type PendingApprovalRequest,
  type Project,
  type RemoteAccessSettings,
  type Thread,
  type ThreadTranscript
} from '@agent-pulse/shared';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Copy,
  HelpCircle,
  KeyRound,
  LockKeyhole,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  ShieldCheck,
  Sun,
  Tablet,
  Trash2
} from 'lucide-react';
import QRCode from 'qrcode';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  adminChangePasscode,
  adminFetch,
  adminLogin,
  adminLogout,
  clearAdminToken,
  clearSession,
  checkRemoteAccess,
  fetchCatalogCommands,
  fetchCatalogModels,
  fetchCatalogPlugins,
  fetchCatalogSkills,
  fetchPairingDevices,
  fetchHealth,
  fetchProjectFiles,
  fetchProjects,
  fetchOlderThreadMessages,
  fetchPendingApprovals,
  fetchSeenThreadActivity,
  fetchThreadTranscript,
  fetchThreads,
  importSeenThreadActivity,
  markThreadSeenOnHelper,
  deleteThread,
  getFingerprint,
  liveEventsUrl,
  loadAdminToken,
  loadSession,
  openThreadInCodex,
  pairDevice,
  recoverDeviceSession,
  respondToApproval,
  saveAdminToken,
  saveSession,
  sendThreadMessage,
  startThread,
  stopThreadWork,
  updateRemoteAccess,
  updateThreadModel,
  AgentPulseApiError,
  type AgentPulseSession
} from './api';
import { CodexMark } from './CodexMark';
import { Dashboard, type NewThreadTarget } from './Dashboard';
import { useThemePreference, type ThemePreference } from './theme';

type AppScreen =
  | 'chooser'
  | 'pairing'
  | 'admin-login'
  | 'dashboard'
  | 'offline'
  | 'revoked'
  | 'settings';

const emptyHealth: HelperHealth = {
  status: 'down',
  codexAppServer: 'disconnected',
  version: '0.1.0',
  uptimeSec: 0
};

const ACTIVE_THREAD_KEY = 'agent-pulse:active-thread';
const THREADS_CACHE_KEY_PREFIX = 'agent-pulse:threads-cache:';
const TRANSCRIPTS_CACHE_KEY_PREFIX = 'agent-pulse:transcripts-cache:';
const CACHED_TRANSCRIPT_MESSAGE_LIMIT = 40;
const TRANSCRIPT_REFRESH_DEBOUNCE_MS = 250;
const SETTLED_TRANSCRIPT_REFRESH_DELAYS_MS = [750, 1_500];
const MIRROR_STREAMING_TURN_PREFIX = 'mirror-streaming:';

const ADMIN_FLEX_SCREENS = new Set<AppScreen>(['settings', 'admin-login', 'chooser']);
const BACKGROUND_STABLE_SCREENS = new Set<AppScreen>(['settings', 'admin-login']);

type AdminDevice = {
  deviceId: string;
  deviceName: string;
  createdAt?: string;
  lastSeenAt?: string;
  revokedAt?: string;
};

type PairingSubmission = {
  pin: string;
  deviceName?: string;
  existingDeviceId?: string;
};

type AdminPairingPin = {
  pin: string;
  expiresAt?: string;
  deviceId?: string;
};

function sameSession(
  left: AgentPulseSession | undefined,
  right: AgentPulseSession | undefined
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.token === right.token &&
    left.deviceId === right.deviceId &&
    left.fingerprint === right.fingerprint
  );
}

function parseSeenLocalStorage(raw: string | null): Record<string, number> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )
    );
  } catch {
    return {};
  }
}

function transcriptShowsLiveActive(transcript: ThreadTranscript): boolean {
  if (transcript.sendState.reason === 'waiting_on_approval') {
    return true;
  }
  if (transcript.sendState.reason === 'compacting_context') {
    return true;
  }
  if (
    transcript.activeTurnId?.startsWith(MIRROR_STREAMING_TURN_PREFIX) ||
    (transcript.sendState.reason === 'thread_changed' &&
      transcript.sendState.label === 'Codex is working')
  ) {
    return true;
  }
  return false;
}

function transcriptAfterStop(transcript: ThreadTranscript): ThreadTranscript {
  return ThreadTranscriptSchema.parse({
    ...transcript,
    activeTurnId: null,
    sendState:
      transcript.sendState.reason === 'mobile_send_disabled'
        ? transcript.sendState
        : {
            canSend: true,
            reason: 'ready',
            label: 'Ready'
          }
  });
}

export type PendingRequestSummary = {
  id: string;
  method: string;
  title: string;
  body?: string;
  itemId?: string;
  turnId?: string;
  permissions?: Record<string, unknown>;
  availableDecisions?: unknown[];
  proposedExecpolicyAmendment?: string[];
  // For requestUserInput we pass the raw `{ questions: [...] }` params through
  // so the renderer can show suggestion buttons / a freeform input. Other
  // request kinds don't need this and leave it undefined.
  params?: Record<string, unknown>;
  kind?:
    | 'question'
    | 'plan'
    | 'commandApproval'
    | 'fileApproval'
    | 'permissionsApproval'
    | 'mcpElicitationApproval';
};

export function extractPendingRequests(
  params: unknown,
  previous: PendingRequestSummary[] = []
): PendingRequestSummary[] {
  return extractPendingRequestsFromParams(params, previous) ?? [];
}

// Converts the helper's `PendingApprovalRequest[]` (raw `{id, method, params}`
// shape, same as Codex's IPC) into the tablet's `PendingRequestSummary[]`
// (with `kind`, `title`, `body`, etc.). Used by both the live
// `thread/pending-approvals/changed` event and the on-demand
// `/threads/:id/pending-approvals` fetch.
export function summarizePendingApprovalsFromHelper(
  requests: PendingApprovalRequest[]
): PendingRequestSummary[] {
  return summarizePendingRequests(requests);
}

function extractPendingRequestsFromParams(
  params: unknown,
  previous: PendingRequestSummary[] = []
): PendingRequestSummary[] | null {
  if (!params || typeof params !== 'object') {
    return null;
  }
  const change = (params as { change?: unknown }).change;
  if (!change || typeof change !== 'object') {
    return null;
  }

  const stateRequests = summarizePendingRequestsFromState(change);
  if (stateRequests) {
    return stateRequests;
  }

  if (stringField(change, 'type') === 'patches') {
    return applyPendingRequestPatches(previous, arrayField(change, 'patches'));
  }

  return null;
}

function summarizePendingRequestsFromState(change: object): PendingRequestSummary[] | undefined {
  const summaries = new Map<string, PendingRequestSummary>();
  let foundRequestState = false;

  for (const source of requestStateSources(change)) {
    const requests = getArrayField(source, 'requests');
    if (requests) {
      foundRequestState = true;
      for (const summary of summarizePendingRequests(requests)) {
        summaries.set(summary.id, summary);
      }
    }

    const turns = getArrayField(source, 'turns');
    if (turns) {
      const permissionItems = summarizePermissionRequestItemsFromTurns(turns);
      if (permissionItems.length > 0) {
        foundRequestState = true;
        for (const summary of permissionItems) {
          summaries.set(summary.id, summary);
        }
      }
    }
  }

  return foundRequestState ? [...summaries.values()] : undefined;
}

function requestStateSources(change: object): object[] {
  const sources = [change];
  const conversationState = objectField(change, 'conversationState');
  if (conversationState) {
    sources.unshift(conversationState);
  }
  const snapshot = objectField(change, 'snapshot');
  const snapshotConversationState = objectField(snapshot, 'conversationState');
  if (snapshotConversationState) {
    sources.unshift(snapshotConversationState);
  }
  const state = objectField(change, 'state');
  const stateConversationState = objectField(state, 'conversationState');
  if (stateConversationState) {
    sources.unshift(stateConversationState);
  }
  return sources;
}

function summarizePendingRequests(requests: unknown[]): PendingRequestSummary[] {
  const summaries: PendingRequestSummary[] = [];
  for (const raw of requests) {
    const summary = summarizePendingRequest(raw);
    if (summary) {
      summaries.push(summary);
    }
  }
  return summaries;
}

function summarizePermissionRequestItemsFromTurns(turns: unknown[]): PendingRequestSummary[] {
  const summaries: PendingRequestSummary[] = [];
  for (const rawTurn of turns) {
    for (const item of arrayField(rawTurn, 'items')) {
      const summary = summarizePermissionRequestItem(item);
      if (summary) {
        summaries.push(summary);
      }
    }
  }
  return summaries;
}

function summarizePermissionRequestItem(raw: unknown): PendingRequestSummary | null {
  const item = objectFromUnknown(raw);
  if (!item) {
    return null;
  }
  const type = stringField(item, 'type') ?? stringField(item, 'action');
  if (type !== 'permissionRequest' && type !== 'permission-request') {
    return null;
  }
  if ((item as { completed?: unknown }).completed === true) {
    return null;
  }
  const id = stringField(item, 'requestId') ?? stringField(item, 'id');
  if (!id) {
    return null;
  }
  const permissions = recordFromUnknown((item as { permissions?: unknown }).permissions);
  const reason = stringField(item, 'reason');
  return {
    id,
    method: 'item/permissions/requestApproval',
    kind: 'permissionsApproval',
    title: reason ?? 'Approve permissions?',
    body: describePermissions(permissions),
    permissions,
    turnId: stringField(item, 'turnId')
  };
}

function summarizePendingRequest(raw: unknown): PendingRequestSummary | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const req = raw as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
    isCompleted?: unknown;
    completed?: unknown;
  };
  if (req.isCompleted || req.completed) {
    return null;
  }
  const method = typeof req.method === 'string' ? req.method : '';
  const id = typeof req.id === 'string' ? req.id : '';
  if (!method || !id) {
    return null;
  }
  if (method === 'item/tool/requestUserInput') {
    const params = (req.params ?? {}) as { questions?: unknown; turnId?: unknown };
    const questions = Array.isArray(params.questions) ? params.questions : [];
    // Codex's RequestUserInputQuestion has fields { id, header, question,
    // isOther, isSecret, options? }. Pull header/question off the first one
    // for the card's title/body — the QuestionAnswerForm renders the full
    // questions list itself from `params`.
    const first = questions[0] as
      | { header?: string; question?: string; id?: string }
      | undefined;
    return {
      id,
      method,
      kind: 'question',
      title: first?.header ?? 'Codex needs more information',
      body: first?.question,
      turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
      // Pass the raw params through so the renderer can show answer options
      // (options + freeform fallback) — without this the tablet just shows
      // "Open Codex on your Mac to answer." with no way to respond.
      params: req.params as Record<string, unknown> | undefined
    };
  }
  if (method === 'item/plan/requestImplementation') {
    const params = (req.params ?? {}) as { planContent?: unknown; turnId?: unknown };
    const planContent = typeof params.planContent === 'string' ? params.planContent : undefined;
    return {
      id,
      method,
      kind: 'plan',
      title: 'Implement this plan?',
      body: planContent,
      turnId: typeof params.turnId === 'string' ? params.turnId : undefined
    };
  }
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval'
  ) {
    const rawParams = recordFromUnknown(req.params) ?? {};
    const params = (req.params ?? {}) as {
      itemId?: unknown;
      turnId?: unknown;
      reason?: unknown;
      permissions?: unknown;
    };
    const permissions = recordFromUnknown(params.permissions);
    const isPermissionsApproval = method === 'item/permissions/requestApproval';
    return {
      id,
      method,
      kind:
        method === 'item/commandExecution/requestApproval'
          ? 'commandApproval'
          : method === 'item/fileChange/requestApproval'
            ? 'fileApproval'
            : 'permissionsApproval',
      title:
        method === 'item/commandExecution/requestApproval'
          ? 'Approve command?'
          : method === 'item/fileChange/requestApproval'
            ? 'Approve file changes?'
            : typeof params.reason === 'string' && params.reason.trim().length > 0
              ? params.reason.trim()
              : 'Approve permissions?',
      body:
        method === 'item/commandExecution/requestApproval'
          ? describeExecCommandApproval(rawParams)
          : isPermissionsApproval
            ? describePermissions(permissions)
            : undefined,
      permissions,
      availableDecisions: optionalArrayField(rawParams, 'availableDecisions'),
      proposedExecpolicyAmendment: stringArrayField(rawParams, 'proposedExecpolicyAmendment'),
      itemId: typeof params.itemId === 'string' ? params.itemId : undefined,
      turnId: typeof params.turnId === 'string' ? params.turnId : undefined
    };
  }
  if (method === 'execCommandApproval') {
    const params = recordFromUnknown(req.params) ?? {};
    return {
      id,
      method,
      kind: 'commandApproval',
      title: 'Approve command?',
      body: describeExecCommandApproval(params),
      availableDecisions: optionalArrayField(params, 'availableDecisions'),
      proposedExecpolicyAmendment: stringArrayField(params, 'proposedExecpolicyAmendment'),
      itemId: stringField(params, 'callId'),
      turnId: stringField(params, 'turnId')
    };
  }
  if (method === 'applyPatchApproval') {
    const params = recordFromUnknown(req.params) ?? {};
    return {
      id,
      method,
      kind: 'fileApproval',
      title: 'Approve file changes?',
      body: describeApplyPatchApproval(params),
      availableDecisions: optionalArrayField(params, 'availableDecisions'),
      itemId: stringField(params, 'callId'),
      turnId: stringField(params, 'turnId')
    };
  }
  if (method === 'mcpServer/elicitation/request') {
    const params = recordFromUnknown(req.params) ?? {};
    const title = stringField(params, 'message')?.trim() || 'Codex needs approval';
    return {
      id,
      method,
      kind: 'mcpElicitationApproval',
      title,
      body: describeMcpElicitation(params),
      turnId: stringField(params, 'turnId')
    };
  }
  return null;
}

function optionalArrayField(params: Record<string, unknown>, key: string): unknown[] | undefined {
  const values = arrayField(params, key);
  return values.length > 0 ? values : undefined;
}

function stringArrayField(params: Record<string, unknown>, key: string): string[] | undefined {
  const values = arrayField(params, key).filter((value): value is string => typeof value === 'string');
  return values.length > 0 ? values : undefined;
}

function describeExecCommandApproval(params: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  const command = arrayField(params, 'command').filter(
    (part): part is string => typeof part === 'string'
  );
  if (command.length > 0) {
    lines.push(`Command: ${command.join(' ')}`);
  } else {
    const commandText = stringField(params, 'command');
    if (commandText) {
      lines.push(`Command: ${commandText}`);
    }
  }
  const cwd = stringField(params, 'cwd');
  if (cwd) {
    lines.push(`Folder: ${cwd}`);
  }
  const reason = stringField(params, 'reason');
  if (reason) {
    lines.push(`Reason: ${reason}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function describeApplyPatchApproval(params: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  const fileChanges = recordFromUnknown(params.fileChanges);
  const files = fileChanges ? Object.keys(fileChanges) : [];
  if (files.length > 0) {
    const visibleFiles = files.slice(0, 8);
    lines.push(`Files: ${visibleFiles.join(', ')}${files.length > visibleFiles.length ? ', ...' : ''}`);
  }
  const grantRoot = stringField(params, 'grantRoot');
  if (grantRoot) {
    lines.push(`Folder access: ${grantRoot}`);
  }
  const reason = stringField(params, 'reason');
  if (reason) {
    lines.push(`Reason: ${reason}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function describeMcpElicitation(params: Record<string, unknown>): string | undefined {
  const metadata = recordFromUnknown(params._meta);
  const toolParams = recordFromUnknown(metadata?.tool_params);
  const connectorName =
    stringField(metadata, 'connector_name') ?? humanizeIdentifier(stringField(params, 'serverName'));
  const targetName =
    stringField(toolParams, 'app') ??
    stringField(toolParams, 'application') ??
    stringField(toolParams, 'appName') ??
    stringField(toolParams, 'name');
  if (connectorName && targetName) {
    return `${connectorName} wants to use ${targetName}.`;
  }
  if (connectorName) {
    return `${connectorName} is asking for approval.`;
  }
  if (targetName) {
    return `Codex wants to use ${targetName}.`;
  }
  return undefined;
}

function humanizeIdentifier(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/^connector[_-]/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function applyPendingRequestPatches(
  previous: PendingRequestSummary[],
  patches: unknown[]
): PendingRequestSummary[] | null {
  let next = previous;
  let touched = false;

  for (const rawPatch of patches) {
    const patch = objectFromUnknown(rawPatch);
    if (!patch) {
      continue;
    }
    const rawPath = normalizedPatchPath((patch as { path?: unknown }).path);
    const path = conversationStatePatchPath(rawPath);
    const value = (patch as { value?: unknown }).value;

    if (path.length === 0) {
      const stateRequests = objectFromUnknown(value)
        ? summarizePendingRequestsFromState(value as object)
        : undefined;
      if (stateRequests) {
        next = stateRequests;
        touched = true;
      }
      continue;
    }

    if (path[0] !== 'requests') {
      const itemSummary = summarizePermissionRequestItem(value);
      if (
        itemSummary &&
        path[0] === 'turns' &&
        path.includes('items') &&
        stringField(patch, 'op') !== 'remove'
      ) {
        if (!touched) {
          next = [...previous];
          touched = true;
        }
        next = upsertPatchedRequest(next, itemSummary, null, stringField(patch, 'op'));
      }
      continue;
    }

    if (!touched) {
      next = [...previous];
      touched = true;
    }

    const op = stringField(patch, 'op');

    if (path.length === 1) {
      if (Array.isArray(value)) {
        next = summarizePendingRequests(value);
      } else if (op === 'remove') {
        next = [];
      }
      continue;
    }

    const index = numericPathPart(path[1]);
    if (path.length === 2) {
      if (op === 'remove') {
        if (index != null) {
          next.splice(index, 1);
        }
        continue;
      }
      const summary = summarizePendingRequest(value);
      if (summary) {
        next = upsertPatchedRequest(next, summary, index, op);
      } else if (index != null) {
        next.splice(index, 1);
      }
      continue;
    }

    if (index == null || !next[index]) {
      continue;
    }

    if ((path[2] === 'isCompleted' || path[2] === 'completed') && value === true) {
      next.splice(index, 1);
      continue;
    }

    const current = next[index];
    if (path[2] === 'params' && path[3] === 'reason' && typeof value === 'string') {
      next[index] = { ...current, title: value.trim() || current.title };
      continue;
    }

    if (path[2] === 'params' && path[3] === 'permissions') {
      const permissions = recordFromUnknown(value);
      next[index] = {
        ...current,
        permissions,
        body: current.kind === 'permissionsApproval' ? describePermissions(permissions) : current.body
      };
    }
  }

  return touched ? next : null;
}

function upsertPatchedRequest(
  requests: PendingRequestSummary[],
  summary: PendingRequestSummary,
  index: number | null,
  op: string | undefined
): PendingRequestSummary[] {
  const existingIndex = requests.findIndex((request) => request.id === summary.id);
  if (existingIndex >= 0) {
    const next = [...requests];
    next[existingIndex] = summary;
    return next;
  }
  const next = [...requests];
  if (index == null || index >= next.length) {
    next.push(summary);
  } else if (op === 'add') {
    next.splice(index, 0, summary);
  } else {
    next[index] = summary;
  }
  return next;
}

function normalizedPatchPath(rawPath: unknown): unknown[] {
  if (Array.isArray(rawPath)) {
    return rawPath;
  }
  if (typeof rawPath !== 'string') {
    return [];
  }
  return rawPath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function conversationStatePatchPath(path: unknown[]): unknown[] {
  if (path[0] === 'conversationState') {
    return path.slice(1);
  }
  if (path[0] === 'snapshot' && path[1] === 'conversationState') {
    return path.slice(2);
  }
  if (path[0] === 'state' && path[1] === 'conversationState') {
    return path.slice(2);
  }
  return path;
}

function numericPathPart(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function describePermissions(permissions: Record<string, unknown> | undefined): string | undefined {
  if (!permissions) {
    return undefined;
  }
  const labels: string[] = [];
  if (permissions.network) {
    labels.push('network access');
  }
  if (permissions.fileSystem) {
    labels.push('file access');
  }
  const otherKeys = Object.keys(permissions).filter(
    (key) => key !== 'network' && key !== 'fileSystem'
  );
  labels.push(...otherKeys.map((key) => key.replace(/([A-Z])/g, ' $1').toLowerCase()));
  return labels.length > 0 ? `Requested: ${labels.join(', ')}.` : undefined;
}

export function extractLatestModel(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') {
    return undefined;
  }
  const change = (params as { change?: unknown }).change;
  if (!change || typeof change !== 'object') {
    return undefined;
  }
  for (const source of modelStateSources(change)) {
    const model = stringField(source, 'latestModel') ?? stringField(source, 'model');
    if (model) {
      return model;
    }
    const collab = objectField(source, 'latestCollaborationMode') ?? objectField(source, 'collaborationMode');
    const collabModel = stringField(objectField(collab, 'settings'), 'model');
    if (collabModel) {
      return collabModel;
    }
    const settingsModel = stringField(objectField(source, 'settings'), 'model');
    if (settingsModel) {
      return settingsModel;
    }
  }
  return undefined;
}

export function extractLatestReasoningEffort(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') {
    return undefined;
  }
  const change = (params as { change?: unknown }).change;
  if (!change || typeof change !== 'object') {
    return undefined;
  }
  for (const source of modelStateSources(change)) {
    const effort =
      stringField(source, 'latestReasoningEffort') ??
      stringField(source, 'reasoningEffort') ??
      stringField(source, 'reasoning_effort') ??
      stringField(source, 'effort');
    if (effort) {
      return effort;
    }
    const collab = objectField(source, 'latestCollaborationMode') ?? objectField(source, 'collaborationMode');
    const collabSettings = objectField(collab, 'settings');
    const collabEffort =
      stringField(collabSettings, 'reasoning_effort') ?? stringField(collabSettings, 'reasoningEffort');
    if (collabEffort) {
      return collabEffort;
    }
    const settings = objectField(source, 'settings');
    const settingsEffort =
      stringField(settings, 'reasoning_effort') ?? stringField(settings, 'reasoningEffort');
    if (settingsEffort) {
      return settingsEffort;
    }
  }
  return undefined;
}

function modelStateSources(change: object): object[] {
  const sources = [change];
  const conversationState = objectField(change, 'conversationState');
  if (conversationState) {
    sources.unshift(conversationState);
  }
  const snapshot = objectField(change, 'snapshot');
  const snapshotConversationState = objectField(snapshot, 'conversationState');
  if (snapshotConversationState) {
    sources.unshift(snapshotConversationState);
  }
  const state = objectField(change, 'state');
  const stateConversationState = objectField(state, 'conversationState');
  if (stateConversationState) {
    sources.unshift(stateConversationState);
  }
  return sources;
}

function objectField(source: unknown, key: string): object | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === 'object' ? value : undefined;
}

function arrayField(source: unknown, key: string): unknown[] {
  return getArrayField(source, key) ?? [];
}

function getArrayField(source: unknown, key: string): unknown[] | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : undefined;
}

function objectFromUnknown(source: unknown): object | undefined {
  return source && typeof source === 'object' && !Array.isArray(source) ? source : undefined;
}

function stringField(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function screenFromLocation(): AppScreen {
  if (window.location.hash === '#/settings') {
    return loadAdminToken() ? 'settings' : 'admin-login';
  }

  if (window.location.hash === '#/admin-login') {
    return 'admin-login';
  }

  return loadSession() ? 'dashboard' : 'chooser';
}

function activeThreadFromLocation(): string | undefined {
  const match = window.location.hash.match(/^#\/threads\/([^/?#]+)/);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    const decoded = decodeURIComponent(match[1]).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function hashForScreen(screen: AppScreen, activeThreadId?: string): string {
  if (screen === 'settings') {
    return '#/settings';
  }

  if (screen === 'admin-login') {
    return '#/admin-login';
  }

  if (screen === 'dashboard' && activeThreadId?.trim()) {
    return `#/threads/${encodeURIComponent(activeThreadId.trim())}`;
  }

  return '';
}

function readPersistedActiveThreadId(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const stored = window.sessionStorage.getItem(ACTIVE_THREAD_KEY);
  if (!stored) {
    return undefined;
  }

  const trimmed = stored.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function threadsCacheKey(session: AgentPulseSession): string {
  return `${THREADS_CACHE_KEY_PREFIX}${session.deviceId}`;
}

function transcriptsCacheKey(session: AgentPulseSession): string {
  return `${TRANSCRIPTS_CACHE_KEY_PREFIX}${session.deviceId}`;
}

function cacheableTranscript(transcript: ThreadTranscript): ThreadTranscript {
  if (transcript.messages.length <= CACHED_TRANSCRIPT_MESSAGE_LIMIT) {
    return transcript;
  }

  return ThreadTranscriptSchema.parse({
    ...transcript,
    messages: transcript.messages.slice(-CACHED_TRANSCRIPT_MESSAGE_LIMIT)
  });
}

function readCachedThreads(session: AgentPulseSession | undefined): Thread[] {
  if (typeof window === 'undefined' || !session) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(threadsCacheKey(session));
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item) => {
      const result = ThreadSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

function readCachedTranscripts(
  session: AgentPulseSession | undefined
): Record<string, ThreadTranscript> {
  if (typeof window === 'undefined' || !session) {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(transcriptsCacheKey(session));
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.values(parsed)
        .flatMap((value) => {
          const result = ThreadTranscriptSchema.safeParse(value);
          return result.success ? [[result.data.threadId, cacheableTranscript(result.data)] as const] : [];
        })
    );
  } catch {
    return {};
  }
}

function writeCachedThreads(session: AgentPulseSession | undefined, threads: Thread[]): void {
  if (typeof window === 'undefined' || !session) {
    return;
  }

  try {
    window.localStorage.setItem(threadsCacheKey(session), JSON.stringify(threads));
  } catch {
    // Ignore storage quota or serialization failures.
  }
}

function writeCachedTranscripts(
  session: AgentPulseSession | undefined,
  transcripts: Record<string, ThreadTranscript>
): void {
  if (typeof window === 'undefined' || !session) {
    return;
  }

  try {
    const cacheEntry = Object.fromEntries(
      Object.entries(transcripts).map(([threadId, transcript]) => [threadId, cacheableTranscript(transcript)])
    );
    window.localStorage.setItem(transcriptsCacheKey(session), JSON.stringify(cacheEntry));
  } catch {
    // Ignore storage quota or serialization failures.
  }
}

function upsertTranscriptCache(
  current: Record<string, ThreadTranscript>,
  transcript: ThreadTranscript
): Record<string, ThreadTranscript> {
  const previous = current[transcript.threadId];
  const stableTranscript =
    !transcript.usage && previous?.usage
      ? { ...transcript, usage: previous.usage }
      : transcript;

  if (previous && transcriptLooksOlder(stableTranscript, previous)) {
    return current;
  }

  return {
    ...current,
    [transcript.threadId]: cacheableTranscript(stableTranscript)
  };
}

function transcriptLooksOlder(candidate: ThreadTranscript, previous: ThreadTranscript): boolean {
  const previousLatest = latestTranscriptMessage(previous);
  if (!previousLatest) {
    return false;
  }

  if (candidate.messages.some((message) => message.id === previousLatest.id)) {
    return false;
  }

  const candidateLatest = latestTranscriptMessage(candidate);
  if (!candidateLatest) {
    return true;
  }

  return candidateLatest.createdAt < previousLatest.createdAt;
}

function latestTranscriptMessage(
  transcript: ThreadTranscript
): { id: string; createdAt: number } | undefined {
  return transcript.messages.reduce<{ id: string; createdAt: number } | undefined>(
    (latest, message) => {
      const createdAt = Date.parse(message.createdAt);
      if (!Number.isFinite(createdAt)) {
        return latest;
      }
      if (!latest || createdAt >= latest.createdAt) {
        return { id: message.id, createdAt };
      }
      return latest;
    },
    undefined
  );
}

function removeTranscriptCache(
  current: Record<string, ThreadTranscript>,
  threadId: string
): Record<string, ThreadTranscript> {
  if (!(threadId in current)) {
    return current;
  }

  const next = { ...current };
  delete next[threadId];
  return next;
}

function threadStatusLooksWorking(status: Thread['status']): boolean {
  return status === 'running' || status === 'waiting_approval' || status === 'compacting';
}

export function App() {
  const [session, setSession] = useState<AgentPulseSession | undefined>(() => loadSession());
  const [adminToken, setAdminToken] = useState<string | undefined>(() => loadAdminToken());
  const [screen, setScreen] = useState<AppScreen>(() => screenFromLocation());
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(() =>
    activeThreadFromLocation() ?? (loadSession() ? readPersistedActiveThreadId() : undefined)
  );
  const [health, setHealth] = useState<HelperHealth>(emptyHealth);
  const [threads, setThreads] = useState<Thread[]>(() => readCachedThreads(loadSession()));
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [transcripts, setTranscripts] = useState<Record<string, ThreadTranscript>>(() =>
    readCachedTranscripts(loadSession())
  );
  const [threadModels, setThreadModels] = useState<Record<string, string>>({});
  const [threadReasoningEfforts, setThreadReasoningEfforts] = useState<Record<string, string>>({});
  // Tracks user-initiated picks per thread (model + effort + timestamp). Codex's persisted thread
  // snapshot can lag until a turn starts with the new model, so we hold the user's pick briefly
  // instead of letting transcript polls visibly flip the chip back.
  const userModelPicksRef = useRef<
    Map<string, { modelSlug: string; reasoningEffort?: string; pickedAt: number }>
  >(new Map());
  const USER_MODEL_PICK_TTL_MS = 30_000;

  // Coalesce transcript refetches per thread. Live app-server events can arrive in bursts,
  // and every redundant HTTP fetch can race through Cloudflare with older data. Keep one
  // in-flight request per thread, with a debounced trailing fetch when more events arrive.
  const transcriptFetchStateRef = useRef<
    Map<string, { inFlight: boolean; pending: boolean; trailingTimer: number | undefined }>
  >(new Map());
  const settledTranscriptRefreshTimersRef = useRef<Map<string, number[]>>(new Map());

  // Apply a transcript-derived model/effort, but only when:
  //   - the user has not just made a different pick in the last TTL window, OR
  //   - the transcript values match the pick (desktop caught up — drop override).
  const applyTranscriptModel = useCallback(
    (threadId: string, modelSlug: string | undefined, reasoningEffort: string | undefined) => {
      if (!modelSlug) {
        return;
      }
      const pick = userModelPicksRef.current.get(threadId);
      let allow = true;
      if (pick) {
        const expired = Date.now() - pick.pickedAt > USER_MODEL_PICK_TTL_MS;
        const slugMatches = pick.modelSlug === modelSlug;
        const effortMatches =
          (pick.reasoningEffort ?? undefined) === (reasoningEffort ?? undefined);
        if (expired || (slugMatches && effortMatches)) {
          userModelPicksRef.current.delete(threadId);
        } else {
          allow = false; // user pick is fresher and different — keep the chip on it
        }
      }
      if (!allow) return;
      setThreadModels((current) =>
        current[threadId] === modelSlug ? current : { ...current, [threadId]: modelSlug }
      );
      if (reasoningEffort) {
        setThreadReasoningEfforts((current) =>
          current[threadId] === reasoningEffort
            ? current
            : { ...current, [threadId]: reasoningEffort }
        );
      } else {
        setThreadReasoningEfforts((current) => {
          if (!(threadId in current)) return current;
          const next = { ...current };
          delete next[threadId];
          return next;
        });
      }
    },
    []
  );

  const [streamingThreadIds, setStreamingThreadIds] = useState<Set<string>>(() => new Set());
  // Helper-synced "user has reviewed this thread at" map. Populated from
  // /threads/seen-activity on session connect, then kept fresh by the
  // thread/seen-activity/changed live event. Dashboard merges this with its
  // local optimistic state so taps register instantly even before the broadcast
  // round-trips.
  const [seenThreadActivity, setSeenThreadActivity] = useState<Record<string, number>>({});

  const markThreadWorking = useCallback((threadId: string) => {
    setStreamingThreadIds((current) => {
      if (current.has(threadId)) {
        return current;
      }
      const next = new Set(current);
      next.add(threadId);
      return next;
    });
  }, []);

  const markThreadReady = useCallback((threadId: string) => {
    setStreamingThreadIds((current) => {
      if (!current.has(threadId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
  }, []);

  const applyTranscriptActivityState = useCallback(
    (transcript: ThreadTranscript) => {
      if (transcriptShowsLiveActive(transcript)) {
        markThreadWorking(transcript.threadId);
        return;
      }

      markThreadReady(transcript.threadId);
      setThreads((current) =>
        current.map((thread) =>
          thread.threadId === transcript.threadId && threadStatusLooksWorking(thread.status)
            ? { ...thread, status: 'idle' as const }
            : thread
        )
      );
    },
    [markThreadReady, markThreadWorking]
  );

  const syncWorkingStateFromThreads = useCallback((nextThreads: Thread[]) => {
    setStreamingThreadIds((current) => {
      let next = current;
      for (const thread of nextThreads) {
        const shouldWork = threadStatusLooksWorking(thread.status);
        if (shouldWork && !next.has(thread.threadId)) {
          next = new Set(next);
          next.add(thread.threadId);
        } else if (!shouldWork && next.has(thread.threadId)) {
          next = new Set(next);
          next.delete(thread.threadId);
        }
      }
      return next;
    });
  }, []);

  // Coalesced + debounced transcript refetch. App-server notifications are the source of truth
  // for working/ready state; this fetch fills in message text after live patches arrive.
  const requestTranscriptRefresh = useCallback(
    (threadId: string) => {
      const currentSession = session;
      if (!currentSession) return;
      const states = transcriptFetchStateRef.current;
      const state =
        states.get(threadId) ?? { inFlight: false, pending: false, trailingTimer: undefined };
      if (state.inFlight) {
        state.pending = true;
        states.set(threadId, state);
        return;
      }
      // If a trailing-debounce timer is already armed, just keep it — another broadcast just
      // arrived but we don't need to start a new fetch yet.
      if (state.trailingTimer !== undefined) {
        return;
      }
      state.inFlight = true;
      state.pending = false;
      states.set(threadId, state);
      void (async () => {
        try {
          const transcript = await fetchThreadTranscript(currentSession, threadId);
          setTranscripts((current) => upsertTranscriptCache(current, transcript));
          applyTranscriptActivityState(transcript);
          applyTranscriptModel(threadId, transcript.model, transcript.reasoningEffort);
        } catch {
          // Ignore transient refresh failures; the next live broadcast can retry.
        } finally {
          const next = states.get(threadId);
          if (!next) return;
          next.inFlight = false;
          const trailing = next.pending;
          next.pending = false;
          states.set(threadId, next);
          if (trailing) {
            // Debounce: wait for the broadcast storm to quiet down before fetching once more.
            const timer = window.setTimeout(() => {
              const after = states.get(threadId);
              if (after) {
                after.trailingTimer = undefined;
                states.set(threadId, after);
              }
              requestTranscriptRefresh(threadId);
            }, TRANSCRIPT_REFRESH_DEBOUNCE_MS);
            next.trailingTimer = timer;
            states.set(threadId, next);
          }
        }
      })();
    },
    [session, applyTranscriptActivityState, applyTranscriptModel]
  );

  const requestSettledTranscriptRefresh = useCallback(
    (threadId: string) => {
      requestTranscriptRefresh(threadId);
      const timersByThread = settledTranscriptRefreshTimersRef.current;
      for (const timer of timersByThread.get(threadId) ?? []) {
        window.clearTimeout(timer);
      }

      const timers = SETTLED_TRANSCRIPT_REFRESH_DELAYS_MS.map((delay) => {
        const timer = window.setTimeout(() => {
          const currentTimers = timersByThread.get(threadId) ?? [];
          const remainingTimers = currentTimers.filter((currentTimer) => currentTimer !== timer);
          if (remainingTimers.length > 0) {
            timersByThread.set(threadId, remainingTimers);
          } else {
            timersByThread.delete(threadId);
          }
          requestTranscriptRefresh(threadId);
        }, delay);
        return timer;
      });
      timersByThread.set(threadId, timers);
    },
    [requestTranscriptRefresh]
  );

  useEffect(
    () => () => {
      for (const timers of settledTranscriptRefreshTimersRef.current.values()) {
        for (const timer of timers) {
          window.clearTimeout(timer);
        }
      }
      settledTranscriptRefreshTimersRef.current.clear();
    },
    []
  );
  const [plugins, setPlugins] = useState<CatalogPlugin[]>([]);
  const [skills, setSkills] = useState<CatalogSkill[]>([]);
  const [commands, setCommands] = useState<CatalogCommand[]>([]);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [threadPendingRequests, setThreadPendingRequests] = useState<
    Record<string, PendingRequestSummary[]>
  >({});
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => setMessage(''), 2500);
    return () => window.clearTimeout(id);
  }, [message]);

  // Reconnect-time fallback for pending approvals.
  //
  // The live `thread/pending-approvals/changed` event keeps `threadPendingRequests`
  // up to date while the websocket is connected. But on a fresh page load or
  // a mid-broadcast reconnect the tablet may have missed the push, so the
  // active thread shows `waiting_approval` with no approval rows. In that case
  // we ask the helper directly via /threads/:id/pending-approvals.
  useEffect(() => {
    if (!session || !activeThreadId) return;
    const activeThread = threads.find((thread) => thread.threadId === activeThreadId);
    if (!activeThread || activeThread.status !== 'waiting_approval') return;
    if ((threadPendingRequests[activeThreadId] ?? []).length > 0) return;

    let cancelled = false;
    void fetchPendingApprovals(session, activeThreadId)
      .then((requests) => {
        if (cancelled || requests.length === 0) return;
        const summaries = summarizePendingApprovalsFromHelper(requests);
        setThreadPendingRequests((current) => ({
          ...current,
          [activeThreadId]: summaries
        }));
      })
      .catch(() => {
        // Quiet — the helper might briefly be unreachable during reconnect.
      });

    return () => {
      cancelled = true;
    };
  }, [session, activeThreadId, threads, threadPendingRequests]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (activeThreadId) {
      window.sessionStorage.setItem(ACTIVE_THREAD_KEY, activeThreadId);
      return;
    }

    window.sessionStorage.removeItem(ACTIVE_THREAD_KEY);
  }, [activeThreadId]);

  useEffect(() => {
    writeCachedThreads(session, threads);
  }, [session, threads]);

  useEffect(() => {
    writeCachedTranscripts(session, transcripts);
  }, [session, transcripts]);

  useEffect(() => {
    const nextHash = hashForScreen(screen, activeThreadId);
    if (window.location.hash === nextHash) {
      return;
    }
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
  }, [activeThreadId, screen]);

  useEffect(() => {
    const syncScreenFromHash = () => {
      const nextScreen = screenFromLocation();
      setScreen(nextScreen);
      if (nextScreen === 'dashboard') {
        setActiveThreadId(activeThreadFromLocation() ?? readPersistedActiveThreadId());
      } else if (nextScreen === 'chooser') {
        setActiveThreadId(undefined);
      }
    };
    window.addEventListener('hashchange', syncScreenFromHash);
    return () => window.removeEventListener('hashchange', syncScreenFromHash);
  }, []);

  useEffect(() => {
    if (!session) {
      setThreads([]);
      setTranscripts({});
      setThreadsLoaded(false);
      setActiveThreadId(undefined);
      return;
    }

    setThreads(readCachedThreads(session));
    setTranscripts(readCachedTranscripts(session));
    setActiveThreadId((current) => current ?? activeThreadFromLocation() ?? readPersistedActiveThreadId());
  }, [session?.deviceId]);

  const refresh = useCallback(async () => {
    const requestSession = session;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);

    try {
      const nextHealth = await fetchHealth(controller.signal);
      setHealth(nextHealth);
      window.clearTimeout(timeout);

      // Pair/reconnect rotates credentials. If an older request finishes after that,
      // ignore it instead of letting the stale result clear the new session.
      if (!sameSession(loadSession(), requestSession)) {
        return;
      }

      if (!requestSession) {
        setThreads([]);
        setTranscripts({});
        setThreadsLoaded(false);
        setActiveThreadId(undefined);
        setScreen((current) => {
          if (ADMIN_FLEX_SCREENS.has(current) || current === 'pairing') {
            return current;
          }
          return 'chooser';
        });
        return;
      }

      setThreadsLoaded(false);
      const nextThreads = await fetchThreads(requestSession);
      if (!sameSession(loadSession(), requestSession)) {
        return;
      }
      setThreads(nextThreads);
      syncWorkingStateFromThreads(nextThreads);
      setThreadsLoaded(true);
      fetchProjects(requestSession)
        .then((nextProjects) => {
          if (sameSession(loadSession(), requestSession)) {
            setProjects(nextProjects);
          }
        })
        .catch(() => {
          if (sameSession(loadSession(), requestSession)) {
            setProjects([]);
          }
        });

      // Pull the helper's authoritative seen-thread map. If the local tablet
      // had a localStorage map from before the helper started tracking this,
      // import it once so users don't lose their existing review state on the
      // first connect after the upgrade. A migration-done flag prevents the
      // import from firing on every page load — Dashboard continues writing
      // to the same localStorage key, so the key will always have entries
      // once any thread has been marked seen.
      void (async () => {
        try {
          const MIGRATION_FLAG_KEY = 'agent-pulse:seen-migration-v1';
          const migrationDone = window.localStorage.getItem(MIGRATION_FLAG_KEY) === '1';
          const localRaw = window.localStorage.getItem('agent-pulse:seen-thread-activity');
          const localMap = parseSeenLocalStorage(localRaw);
          let entries: Record<string, number>;
          if (!migrationDone && Object.keys(localMap).length > 0) {
            entries = await importSeenThreadActivity(requestSession, localMap);
            window.localStorage.setItem(MIGRATION_FLAG_KEY, '1');
          } else {
            entries = await fetchSeenThreadActivity(requestSession);
          }
          if (sameSession(loadSession(), requestSession)) {
            setSeenThreadActivity(entries);
          }
        } catch {
          // Soft-fail — Dashboard falls back to its localStorage copy when the
          // override is empty.
        }
      })();
      fetchCatalogPlugins(requestSession)
        .then((nextPlugins) => {
          if (sameSession(loadSession(), requestSession)) {
            setPlugins(nextPlugins);
          }
        })
        .catch(() => {
          if (sameSession(loadSession(), requestSession)) {
            setPlugins([]);
          }
        });
      fetchCatalogSkills(requestSession)
        .then((nextSkills) => {
          if (sameSession(loadSession(), requestSession)) {
            setSkills(nextSkills);
          }
        })
        .catch(() => {
          if (sameSession(loadSession(), requestSession)) {
            setSkills([]);
          }
        });
      fetchCatalogCommands(requestSession)
        .then((nextCommands) => {
          if (sameSession(loadSession(), requestSession)) {
            setCommands(nextCommands);
          }
        })
        .catch(() => {
          if (sameSession(loadSession(), requestSession)) {
            setCommands([]);
          }
        });
      fetchCatalogModels(requestSession)
        .then((nextModels) => {
          if (sameSession(loadSession(), requestSession)) {
            setModels(nextModels);
          }
        })
        .catch(() => {
          if (sameSession(loadSession(), requestSession)) {
            setModels([]);
          }
        });
      setScreen((current) => (ADMIN_FLEX_SCREENS.has(current) ? current : 'dashboard'));
    } catch (error) {
      window.clearTimeout(timeout);
      if (!sameSession(loadSession(), requestSession)) {
        return;
      }
      if (error instanceof Response && error.status === 403) {
        setScreen('revoked');
        return;
      }
      if (error instanceof Response && error.status === 401) {
        if (requestSession) {
          try {
            const recovered = await recoverDeviceSession(requestSession);
            const nextSession = {
              ...requestSession,
              token: recovered.token,
              deviceId: recovered.deviceId,
              deviceName: recovered.deviceName
            };
            saveSession(nextSession);
            setSession(nextSession);
            setScreen((current) => (ADMIN_FLEX_SCREENS.has(current) ? current : 'dashboard'));
            return;
          } catch {
            // Fall through to the old reset behavior when the helper confirms this
            // browser is not the saved device anymore.
          }
        }
        clearSession();
        setSession(undefined);
        setThreads([]);
        setTranscripts({});
        setThreadsLoaded(false);
        setActiveThreadId(undefined);
        setScreen('chooser');
        return;
      }
      setThreadsLoaded(false);
      setScreen((current) => (BACKGROUND_STABLE_SCREENS.has(current) ? current : 'offline'));
    }
  }, [session, syncWorkingStateFromThreads]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!session) {
      return;
    }

    let closingFromCleanup = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | undefined;

    const connect = () => {
      socket = new WebSocket(liveEventsUrl(session));
      socket.onopen = () => {
        reconnectAttempt = 0;
      };
      socket.onmessage = (event) => {
        const parsed = LiveEventSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success) {
          return;
        }

        const liveEvent = parsed.data as LiveEvent;

        if (liveEvent.type === 'health/changed') {
          setHealth(liveEvent.payload);
        }

        if (liveEvent.type === 'thread/upsert') {
          setThreads((current) => [
            liveEvent.payload,
            ...current.filter((thread) => thread.threadId !== liveEvent.payload.threadId)
          ]);
          if (threadStatusLooksWorking(liveEvent.payload.status)) {
            markThreadWorking(liveEvent.payload.threadId);
          } else {
            markThreadReady(liveEvent.payload.threadId);
          }
        }

        if (liveEvent.type === 'thread/remove') {
          setThreads((current) =>
            current.filter((thread) => thread.threadId !== liveEvent.payload.threadId)
          );
          setTranscripts((current) => removeTranscriptCache(current, liveEvent.payload.threadId));
        }

        if (liveEvent.type === 'thread/transcript/changed') {
          setTranscripts((current) => upsertTranscriptCache(current, liveEvent.payload));
          if (!liveEvent.payload.usage) {
            requestTranscriptRefresh(liveEvent.payload.threadId);
          }
          applyTranscriptActivityState(liveEvent.payload);
          applyTranscriptModel(
            liveEvent.payload.threadId,
            liveEvent.payload.model,
            liveEvent.payload.reasoningEffort
          );
        }

        if (liveEvent.type === 'thread/status/changed') {
          const { threadId, status } = liveEvent.payload;
          setThreads((current) =>
            current.map((thread) =>
              thread.threadId === threadId ? { ...thread, status } : thread
            )
          );
          if (status === 'running' || status === 'waiting_approval' || status === 'compacting') {
            markThreadWorking(threadId);
          } else {
            markThreadReady(threadId);
          }
        }

        if (liveEvent.type === 'thread/streaming-changed') {
          const { threadId, isStreaming } = liveEvent.payload;
          if (isStreaming) {
            markThreadWorking(threadId);
          } else {
            // Don't flip thread.status to idle from streaming-changed alone — Codex briefly
            // pauses streaming between items inside one turn, and that would make the
            // working badge flicker. Let thread/status/changed (active→idle) be the only
            // thing that idles the thread; meanwhile we drop the spinner immediately and
            // refresh the transcript so the latest reply text lands.
            markThreadReady(threadId);
            requestSettledTranscriptRefresh(threadId);
          }
        }

        if (liveEvent.type === 'thread/pending-approvals/changed') {
          // Helper-driven push of the current pending approval requests for a thread.
          const { threadId, requests } = liveEvent.payload;
          const summaries = summarizePendingApprovalsFromHelper(requests);
          setThreadPendingRequests((current) => ({
            ...current,
            [threadId]: summaries
          }));
        }

        if (liveEvent.type === 'thread/seen-activity/changed') {
          // Another paired device reviewed this thread (or this device echoed
          // back). Keep our local map in sync so the Review chip drops in
          // realtime everywhere.
          const { threadId, seenAt } = liveEvent.payload;
          setSeenThreadActivity((current) => {
            const previous = current[threadId] ?? 0;
            if (previous >= seenAt) {
              return current;
            }
            return { ...current, [threadId]: seenAt };
          });
        }

        if (liveEvent.type === 'catalog/changed') {
          const kind = liveEvent.payload.kind;
          if (kind === 'plugins') {
            fetchCatalogPlugins(session).then(setPlugins).catch(() => undefined);
          } else if (kind === 'skills') {
            fetchCatalogSkills(session).then(setSkills).catch(() => undefined);
          } else if (kind === 'commands') {
            fetchCatalogCommands(session).then(setCommands).catch(() => undefined);
          } else if (kind === 'models') {
            fetchCatalogModels(session).then(setModels).catch(() => undefined);
          }
          return;
        }

      };
      socket.onclose = () => {
        if (closingFromCleanup || !loadSession()) {
          return;
        }
        setMessage('Reconnecting to helper...');
        const delay = Math.min(1000 * 2 ** reconnectAttempt, 15_000);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closingFromCleanup = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [
    session,
    applyTranscriptActivityState,
    applyTranscriptModel,
    markThreadReady,
    markThreadWorking,
    requestTranscriptRefresh,
    requestSettledTranscriptRefresh,
    syncWorkingStateFromThreads
  ]);

  const handlePair = async (input: PairingSubmission) => {
    const fingerprint = getFingerprint();
    const result = await pairDevice({ ...input, fingerprint });
    const nextSession = {
      token: result.token,
      deviceId: result.deviceId,
      fingerprint,
      deviceName: result.deviceName
    };
    saveSession(nextSession);
    setSession(nextSession);
    setActiveThreadId(undefined);
    setScreen('dashboard');
  };

  const handleAdminLogin = async (passcode: string) => {
    const token = await adminLogin(passcode);
    saveAdminToken(token);
    setAdminToken(token);
    setScreen('settings');
  };

  const handleAdminExpired = useCallback(() => {
    clearAdminToken();
    setAdminToken(undefined);
    setScreen('admin-login');
  }, []);

  const handleAdminLogout = useCallback(async () => {
    if (adminToken) {
      void adminLogout(adminToken).catch(() => undefined);
    }
    clearAdminToken();
    setAdminToken(undefined);
    setScreen(session ? 'dashboard' : 'chooser');
  }, [adminToken, session]);

  const handleOpenAdmin = () => {
    if (adminToken) {
      setScreen('settings');
      return;
    }
    setScreen('admin-login');
  };

  const handleNewThread = async (target: NewThreadTarget): Promise<Thread> => {
    if (!session) {
      throw new Error('Not connected.');
    }

    try {
      const result = await startThread(session, target);
      setThreads((current) => [
        result.thread,
        ...current.filter((thread) => thread.threadId !== result.thread.threadId)
      ]);
      setMessage('New thread created in Agent Pulse.');
      return result.thread;
    } catch (error) {
      if (error instanceof Response && error.status === 403) {
        setScreen('revoked');
      }
      throw error;
    }
  };

  const handleFetchTranscript = useCallback(
    async (threadId: string, options?: { messageLimit?: number }) => {
      if (!session) {
        return Promise.reject(new Error('Not connected.'));
      }

      const transcript = await fetchThreadTranscript(session, threadId, options);
      setTranscripts((current) => upsertTranscriptCache(current, transcript));
      applyTranscriptModel(threadId, transcript.model, transcript.reasoningEffort);
      return transcript;
    },
    [session, applyTranscriptModel]
  );

  const handleFetchOlderMessages = useCallback(
    async (threadId: string, beforeMessageId: string, limit?: number) => {
      if (!session) {
        return Promise.reject(new Error('Not connected.'));
      }
      return fetchOlderThreadMessages(session, threadId, beforeMessageId, limit);
    },
    [session]
  );

  const handleMarkThreadSeen = useCallback(
    (threadId: string, seenAt: number) => {
      // Optimistic update so the Review chip drops without waiting for the
      // helper round-trip. The live broadcast will reconcile any drift.
      setSeenThreadActivity((current) => {
        const previous = current[threadId] ?? 0;
        if (previous >= seenAt) {
          return current;
        }
        return { ...current, [threadId]: seenAt };
      });
      if (!session) {
        return;
      }
      void markThreadSeenOnHelper(session, threadId, seenAt).catch(() => {
        // Soft-fail; the next session-connect re-syncs from the helper.
      });
    },
    [session]
  );

  const handleSendMessage = useCallback(
    async (
      threadId: string,
      text: string,
      options?: { collaborationMode?: CollaborationModeKind }
    ) => {
      if (!session) {
        return Promise.reject(new Error('Not connected.'));
      }

      // Snapshot existing message ids so we can tell whether the send-response transcript
      // already includes the new user message or is just an echo of the previous turn.
      // The Codex app server can return `thread/read` results that haven't ingested the
      // just-started turn yet, and committing that to the cache would make ThreadView
      // re-show the previous turn's assistant reply under the optimistic bubble.
      const trimmedSendText = text.trim();
      const previousTranscript = transcripts[threadId];
      const baselineMessageIds = new Set(
        previousTranscript?.messages.map((message) => message.id) ?? []
      );
      const result = await sendThreadMessage(session, threadId, text, options);
      const responseHasNewUserMessage = result.transcript.messages.some(
        (message) =>
          message.role === 'user' &&
          message.text.trim() === trimmedSendText &&
          !baselineMessageIds.has(message.id)
      );
      if (responseHasNewUserMessage) {
        setTranscripts((current) => upsertTranscriptCache(current, result.transcript));
      }
      applyTranscriptActivityState(result.transcript);
      applyTranscriptModel(threadId, result.transcript.model, result.transcript.reasoningEffort);
      return result;
    },
    [session, transcripts, applyTranscriptActivityState, applyTranscriptModel]
  );

  const markThreadStopped = useCallback((threadId: string) => {
    markThreadReady(threadId);
    setThreads((current) =>
      current.map((thread) =>
        thread.threadId === threadId ? { ...thread, status: 'idle' as const } : thread
      )
    );
    setTranscripts((current) => {
      const transcript = current[threadId];
      if (!transcript) {
        return current;
      }
      return upsertTranscriptCache(current, transcriptAfterStop(transcript));
    });
  }, [markThreadReady]);

  const handleStopWork = useCallback(
    async (threadId: string) => {
      if (!session) {
        return Promise.reject(new Error('Not connected.'));
      }

      try {
        await stopThreadWork(session, threadId);
        markThreadStopped(threadId);
        requestTranscriptRefresh(threadId);
      } catch (error) {
        if (error instanceof AgentPulseApiError && error.reason === 'missing_active_turn') {
          markThreadStopped(threadId);
          requestTranscriptRefresh(threadId);
        }
        throw error;
      }
    },
    [session, markThreadStopped, requestTranscriptRefresh]
  );

  const handleOpenThreadInCodex = useCallback(
    (threadId: string) => {
      if (!session) {
        return Promise.reject(new Error('Not connected.'));
      }
      return openThreadInCodex(session, threadId);
    },
    [session]
  );

  const handleDeleteThread = useCallback(
    async (threadId: string) => {
      if (!session) {
        return Promise.reject(new Error('Not connected.'));
      }
      await deleteThread(session, threadId);
      setThreads((current) => current.filter((thread) => thread.threadId !== threadId));
      setTranscripts((current) => removeTranscriptCache(current, threadId));
      setThreadPendingRequests((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setThreadModels((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setThreadReasoningEfforts((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setActiveThreadId((current) => (current === threadId ? undefined : current));
      setMessage('Thread deleted from Codex.');
    },
    [session]
  );

  const visibleScreen = useMemo(() => {
    if (screen === 'settings') {
      if (!adminToken) {
        return (
          <AdminLoginScreen
            onSubmit={handleAdminLogin}
            onBack={() => setScreen(session ? 'dashboard' : 'chooser')}
          />
        );
      }
      return (
        <SettingsScreen
          adminToken={adminToken}
          onBack={() => setScreen(session ? 'dashboard' : 'chooser')}
          onSignOut={handleAdminLogout}
          onAdminExpired={handleAdminExpired}
          onPair={handlePair}
          helperVersion={health.version}
        />
      );
    }

    if (screen === 'admin-login') {
      return (
        <AdminLoginScreen
          onSubmit={handleAdminLogin}
          onBack={() => setScreen(session ? 'dashboard' : 'chooser')}
        />
      );
    }

    if (screen === 'offline') {
      return <OfflineScreen onRetry={() => void refresh()} />;
    }

    if (screen === 'revoked') {
      return (
        <RevokedScreen
          onReset={() => {
            clearSession();
            setSession(undefined);
            setScreen('chooser');
          }}
        />
      );
    }

    if (screen === 'pairing') {
      return (
        <PairingScreen
          onPair={handlePair}
          onBack={() => setScreen('chooser')}
        />
      );
    }

    if (!session || screen === 'chooser') {
      return (
        <ChooserScreen
          onConnect={() => setScreen('pairing')}
          onAdmin={handleOpenAdmin}
        />
      );
    }

    return (
      <>
        <Dashboard
          health={health}
          threads={threads}
          threadsLoaded={threadsLoaded}
          activeThreadId={activeThreadId ?? null}
          onActiveThreadIdChange={setActiveThreadId}
          projects={projects}
          onNewThread={handleNewThread}
          onOpenThreadInCodex={handleOpenThreadInCodex}
          onDeleteThread={handleDeleteThread}
          onOpenSettings={handleOpenAdmin}
          fetchTranscript={handleFetchTranscript}
          sendMessage={handleSendMessage}
          stopWork={handleStopWork}
          fetchOlderMessages={handleFetchOlderMessages}
          transcriptUpdates={transcripts}
          threadModels={threadModels}
          threadReasoningEfforts={threadReasoningEfforts}
          threadPendingRequests={threadPendingRequests}
          streamingThreadIds={streamingThreadIds}
          plugins={plugins}
          skills={skills}
          commands={commands}
          models={models}
          fetchProjectFiles={
            session
              ? async (projectId: string, query: string) => {
                  if (!projectId) {
                    return [];
                  }
                  try {
                    const response = await fetchProjectFiles(session, projectId, query);
                    return response.files;
                  } catch {
                    return [];
                  }
                }
              : undefined
          }
          onChangeThreadModel={
            session
              ? async (threadId: string, modelSlug: string, reasoningEffort?: string) => {
                  // Record the pick BEFORE the network call so any transcript broadcast that
                  // races back doesn't briefly flip the chip back to the old selection.
                  userModelPicksRef.current.set(threadId, {
                    modelSlug,
                    reasoningEffort,
                    pickedAt: Date.now()
                  });
                  setThreadModels((current) => ({ ...current, [threadId]: modelSlug }));
                  if (reasoningEffort) {
                    setThreadReasoningEfforts((current) => ({
                      ...current,
                      [threadId]: reasoningEffort
                    }));
                  } else {
                    setThreadReasoningEfforts((current) => {
                      if (!(threadId in current)) return current;
                      const next = { ...current };
                      delete next[threadId];
                      return next;
                    });
                  }
                  await updateThreadModel(session, threadId, modelSlug, reasoningEffort);
                }
              : undefined
          }
          onApprovalDecision={
            session
              ? async (threadId, requestId, method, decision) => {
                  await respondToApproval(session, threadId, requestId, method, decision);
                  setThreadPendingRequests((current) => {
                    const list = current[threadId] ?? [];
                    return {
                      ...current,
                      [threadId]: list.filter((entry) => entry.id !== requestId)
                    };
                  });
                }
              : undefined
          }
          seenThreadActivityOverride={seenThreadActivity}
          onMarkThreadSeen={handleMarkThreadSeen}
        />
        {message ? <div className="toast">{message}</div> : null}
      </>
    );
  }, [
    adminToken,
    activeThreadId,
    commands,
    handleFetchTranscript,
    handleAdminExpired,
    handleAdminLogin,
    handleAdminLogout,
    handleNewThread,
    handleOpenAdmin,
    handlePair,
    handleSendMessage,
    handleStopWork,
    handleOpenThreadInCodex,
    handleDeleteThread,
    health,
    message,
    models,
    plugins,
    projects,
    refresh,
    screen,
    session,
    skills,
    streamingThreadIds,
    threadModels,
    threadPendingRequests,
    threadReasoningEfforts,
    threads,
    threadsLoaded,
    transcripts,
    seenThreadActivity,
    handleMarkThreadSeen
  ]);

  return visibleScreen;
}

function ChooserScreen({
  onConnect,
  onAdmin
}: {
  onConnect: () => void;
  onAdmin: () => void;
}) {
  return (
    <main className="shell centered-shell">
      <div className="surface-panel chooser-panel">
        <CodexMark size="lg" />
        <p className="eyebrow">Agent Pulse</p>
        <h1>How will you use this?</h1>
        <p className="simple-copy">
          Pick a mode. You can switch later by reopening this page.
        </p>
        <div className="chooser-grid">
          <button className="chooser-tile" type="button" onClick={onConnect}>
            <span className="chooser-tile-icon">
              <Tablet size={28} />
            </span>
            <span className="chooser-tile-title">Connect a device</span>
            <span className="chooser-tile-copy">
              Pair this tablet with the Mac helper using a 6-digit PIN.
            </span>
          </button>
          <button className="chooser-tile" type="button" onClick={onAdmin}>
            <span className="chooser-tile-icon">
              <KeyRound size={28} />
            </span>
            <span className="chooser-tile-title">Admin mode</span>
            <span className="chooser-tile-copy">
              Generate PINs, revoke devices, and change helper settings.
            </span>
          </button>
        </div>
      </div>
    </main>
  );
}

function PairingScreen({
  onPair,
  onBack
}: {
  onPair: (input: PairingSubmission) => Promise<void>;
  onBack: () => void;
}) {
  const [pin, setPin] = useState('');
  const [deviceName, setDeviceName] = useState('Desk tablet');
  const [availableDevices, setAvailableDevices] = useState<PairingDeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [deviceLoadMessage, setDeviceLoadMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoadingDevices(true);
    fetchPairingDevices()
      .then((devices) => {
        if (cancelled) {
          return;
        }

        setAvailableDevices(devices);
        setDeviceLoadMessage('');
        setSelectedDeviceId((current) =>
          devices.some((device) => device.deviceId === current) ? current : ''
        );
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setAvailableDevices([]);
        setSelectedDeviceId('');
        setDeviceLoadMessage('Could not load saved devices. You can still create a new one.');
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDevices(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedDevice = availableDevices.find((device) => device.deviceId === selectedDeviceId);

  return (
    <main className="shell centered-shell">
      <div className="surface-panel pairing-panel">
        <CodexMark size="lg" />
        <p className="eyebrow">Connect a device</p>
        <h1>Pair this display</h1>
        <p className="simple-copy">Enter the PIN shown in admin mode on your Mac.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            const nextPin = pin.trim();
            const nextDeviceName = deviceName.trim();

            if (!nextPin) {
              setError('Enter the pairing PIN shown in admin mode.');
              return;
            }

            if (!selectedDevice && !nextDeviceName) {
              setError('Enter a device name or choose a saved device.');
              return;
            }

            onPair(
              selectedDevice
                ? { pin: nextPin, existingDeviceId: selectedDevice.deviceId }
                : { pin: nextPin, deviceName: nextDeviceName }
            ).catch((error: unknown) =>
              setError(error instanceof Error ? error.message : 'Pairing failed. Check the PIN.')
            );
          }}
        >
          {availableDevices.length > 0 ? (
            <label>
              Saved device
              <select
                className="pairing-select"
                value={selectedDeviceId}
                onChange={(event) => setSelectedDeviceId(event.target.value)}
              >
                <option value="">Create a new device</option>
                {availableDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.deviceName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {loadingDevices ? <p className="simple-copy">Loading saved devices...</p> : null}
          {deviceLoadMessage ? <p className="simple-copy">{deviceLoadMessage}</p> : null}
          {selectedDevice ? (
            <p className="simple-copy">
              Using the saved name "{selectedDevice.deviceName}". Choose "Create a new device" to
              enter a different name.
            </p>
          ) : (
            <label>
              Device name
              <input
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
              />
            </label>
          )}
          <label>
            Pairing PIN
            <input
              autoCapitalize="off"
              autoCorrect="off"
              inputMode="numeric"
              spellCheck={false}
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              placeholder="000000"
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary-action full-width" type="submit">
            Pair device
          </button>
        </form>
        <button className="text-button" type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </main>
  );
}

function AdminLoginScreen({
  onSubmit,
  onBack
}: {
  onSubmit: (passcode: string) => Promise<void>;
  onBack: () => void;
}) {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  return (
    <main className="shell centered-shell">
      <div className="surface-panel pairing-panel">
        <CodexMark size="lg" />
        <p className="eyebrow">Admin mode</p>
        <h1>Enter passcode</h1>
        <p className="simple-copy">
          The passcode is printed in the Mac helper console the first time you launch it.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            setSubmitting(true);
            onSubmit(passcode.trim())
              .catch((error: unknown) =>
                setError(error instanceof Error ? error.message : 'Could not unlock admin mode.')
              )
              .finally(() => setSubmitting(false));
          }}
        >
          <label>
            Admin passcode
            <input
              type="password"
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              placeholder="ABCD2345"
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button
            className="primary-action full-width"
            type="submit"
            disabled={submitting || !passcode.trim()}
          >
            Unlock admin mode
          </button>
        </form>
        <button className="text-button" type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </main>
  );
}

function OfflineScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="shell centered-shell">
      <div className="surface-panel state-panel">
        <AlertTriangle size={42} />
        <h1>Helper offline</h1>
        <p className="simple-copy">The Mac helper is not reachable right now.</p>
        <button className="primary-action full-width" type="button" onClick={onRetry}>
          <RefreshCw size={20} />
          Try again
        </button>
      </div>
    </main>
  );
}

function RevokedScreen({ onReset }: { onReset: () => void }) {
  return (
    <main className="shell centered-shell">
      <div className="surface-panel state-panel">
        <LockKeyhole size={42} />
        <h1>Device revoked</h1>
        <p className="simple-copy">This tablet no longer has access to Agent Pulse.</p>
        <button className="primary-action full-width" type="button" onClick={onReset}>
          Pair again
        </button>
      </div>
    </main>
  );
}

function SettingsScreen({
  adminToken,
  onBack,
  onSignOut,
  onAdminExpired,
  onPair,
  helperVersion
}: {
  adminToken: string;
  onBack: () => void;
  onSignOut: () => void;
  onAdminExpired: () => void;
  onPair: (input: PairingSubmission) => Promise<void>;
  helperVersion: string;
}) {
  const [pin, setPin] = useState('');
  const [pinExpiresAt, setPinExpiresAt] = useState<string | undefined>();
  const [lanEnabled, setLanEnabled] = useState(false);
  const [mobileSendEnabled, setMobileSendEnabled] = useState(false);
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccessSettings>(() => defaultRemoteAccess());
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [selectedPairDeviceId, setSelectedPairDeviceId] = useState('');
  const [devicePins, setDevicePins] = useState<Record<string, AdminPairingPin>>({});
  const { theme, setTheme } = useThemePreference();
  const remoteTone = remoteAccess.status === 'healthy' ? 'green' : remoteAccess.enabled ? 'blue' : 'gray';

  useEffect(() => {
    adminFetch('/settings/get', adminToken)
      .then(async (response) => {
        if (!response.ok) {
          throw response;
        }
        return response.json();
      })
      .then((payload) => {
        setLanEnabled(Boolean(payload.settings?.lanEnabled));
        setMobileSendEnabled(Boolean(payload.settings?.mobileSendEnabled));
        const nextRemote = payload.settings?.remoteAccess ?? defaultRemoteAccess();
        setRemoteAccess(nextRemote);
        const activeDevices = activeAdminDevices(payload.devices ?? []);
        setDevices(activeDevices);
        setSelectedPairDeviceId((current) =>
          activeDevices.some((device) => device.deviceId === current) ? current : ''
        );
        const pins = splitPairingPins(payload.pairingPins ?? []);
        setPin(pins.newDevicePin?.pin ?? '');
        setPinExpiresAt(pins.newDevicePin?.expiresAt);
        setDevicePins(pins.devicePins);
      })
      .catch((error: unknown) => {
        if (error instanceof Response && error.status === 401) {
          onAdminExpired();
        }
      });
  }, [adminToken, onAdminExpired]);

  const createPin = async (deviceId?: string) => {
    const response = await adminFetch('/settings/pairing-pin', adminToken, {
      method: 'POST',
      ...(deviceId ? { body: JSON.stringify({ deviceId }) } : {})
    });
    if (!response.ok) {
      if (response.status === 401) {
        onAdminExpired();
      }
      return null;
    }
    const payload = (await response.json()) as AdminPairingPin;
    if (payload.deviceId) {
      setDevicePins((current) => ({
        ...current,
        [payload.deviceId!]: payload
      }));
      return payload.pin;
    }

    setPin(payload.pin);
    setPinExpiresAt(payload.expiresAt);
    return payload.pin;
  };

  const toggleLan = async () => {
    const next = !lanEnabled;
    setLanEnabled(next);
    await adminFetch('/settings/lan', adminToken, {
      method: 'POST',
      body: JSON.stringify({ enabled: next })
    });
  };

  const toggleMobileSend = async () => {
    const next = !mobileSendEnabled;
    setMobileSendEnabled(next);
    await adminFetch('/settings/mobile-send', adminToken, {
      method: 'POST',
      body: JSON.stringify({ enabled: next })
    });
  };

  const refreshRemoteAccess = async () => {
    const next = await checkRemoteAccess(adminToken);
    setRemoteAccess(next);
  };

  const toggleRemoteAccess = async () => {
    const next = await updateRemoteAccess(adminToken, { enabled: !remoteAccess.enabled, mode: 'quick' });
    setRemoteAccess(next);
  };

  const updateTunnelProtocol = async (tunnelProtocol: RemoteAccessSettings['tunnelProtocol']) => {
    const next = await updateRemoteAccess(adminToken, {
      tunnelProtocol,
      ...(remoteAccess.enabled ? { enabled: true } : {})
    });
    setRemoteAccess(next);
  };

  const selectedPairDevice = devices.find((device) => device.deviceId === selectedPairDeviceId);
  const selectedPairPin = selectedPairDevice
    ? devicePins[selectedPairDevice.deviceId]
    : pin
      ? { pin, expiresAt: pinExpiresAt }
      : undefined;
  const selectedPairPinValue = selectedPairPin?.pin ?? '';
  const selectedPairPinExpiresAt = selectedPairPin?.expiresAt;
  const createSelectedPairPin = () => createPin(selectedPairDevice?.deviceId);
  const connectSelectedPairDevice = () => {
    if (!selectedPairPinValue) {
      return;
    }

    void onPair(
      selectedPairDevice
        ? { pin: selectedPairPinValue, existingDeviceId: selectedPairDevice.deviceId }
        : { pin: selectedPairPinValue, deviceName: 'Admin tablet' }
    );
  };

  return (
    <main className="shell settings-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <CodexMark size="md" />
          <div>
            <p className="eyebrow">Admin mode</p>
            <h1>Agent Pulse settings</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="secondary-action" type="button" onClick={onSignOut}>
            <LogOut size={16} />
            Sign out
          </button>
          <button className="secondary-action" type="button" onClick={onBack}>
            Back
          </button>
        </div>
      </header>

      <section className="settings-overview" aria-label="Admin status">
        <div>
          <p className="eyebrow">Local helper · v{helperVersion}</p>
          <h2>Control what paired displays can do.</h2>
          <p>Use this page to pair tablets, manage LAN access, and control mobile chat.</p>
        </div>
        <div className="settings-status-grid">
          <SettingsStat label="LAN access" value={lanEnabled ? 'On' : 'Off'} tone={lanEnabled ? 'green' : 'gray'} />
          <SettingsStat label="Mobile chat" value={mobileSendEnabled ? 'On' : 'Off'} tone={mobileSendEnabled ? 'blue' : 'gray'} />
          <SettingsStat label="Remote" value={remoteStatusLabel(remoteAccess)} tone={remoteTone} />
          <SettingsStat label="Devices" value={String(devices.length)} tone="neutral" />
        </div>
      </section>

      <section className="settings-grid">
        <section className="settings-panel settings-panel-primary">
          <PanelHeading
            icon={<ShieldCheck size={22} />}
            title="Access controls"
            description="Keep LAN and message sending limited to trusted devices."
          />
          <SettingRow
            title="LAN access"
            description="Allow paired tablets and phones on your local network to reach Agent Pulse."
            status={lanEnabled ? 'Enabled' : 'Off'}
            tone={lanEnabled ? 'green' : 'gray'}
            action={
              <button className="secondary-action" type="button" onClick={toggleLan}>
                {lanEnabled ? 'Turn off' : 'Turn on'}
              </button>
            }
          />
          <SettingRow
            title="Mobile chat"
            description="Let paired devices send text into existing Codex threads."
            status={mobileSendEnabled ? 'Enabled' : 'Off'}
            tone={mobileSendEnabled ? 'blue' : 'gray'}
            action={
              <button className="secondary-action" type="button" onClick={toggleMobileSend}>
                {mobileSendEnabled ? 'Turn off' : 'Turn on'}
              </button>
            }
          />
          <SettingRow
            title="Remote access"
            description="Open Agent Pulse from outside the local network using Cloudflare Tunnel."
            status={remoteStatusLabel(remoteAccess)}
            tone={remoteTone}
            action={
              <button className="secondary-action" type="button" onClick={() => void toggleRemoteAccess()}>
                {remoteAccess.enabled ? 'Turn off remote access' : 'Turn on remote access'}
              </button>
            }
          />
        </section>

        <RemoteAccessPanel
          remoteAccess={remoteAccess}
          onCheck={() => void refreshRemoteAccess()}
          onProtocolChange={(protocol) => void updateTunnelProtocol(protocol)}
        />

        <section className="settings-panel pair-panel">
          <PanelHeading
            icon={<Monitor size={22} />}
            title="Pair a display"
            description="Choose a saved device to reconnect it, or create a brand-new device."
          />
          {devices.length > 0 ? (
            <label>
              Saved device
              <select
                className="pairing-select"
                value={selectedPairDeviceId}
                onChange={(event) => setSelectedPairDeviceId(event.target.value)}
              >
                <option value="">Create a new device</option>
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.deviceName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {selectedPairPinValue ? (
            <div className="pin-stack">
              <div className="pin-display">{selectedPairPinValue}</div>
              {selectedPairPinExpiresAt ? (
                <p className="simple-copy">Expires {new Date(selectedPairPinExpiresAt).toLocaleString()}.</p>
              ) : null}
            </div>
          ) : (
            <div className="pin-empty">No active PIN</div>
          )}
          <div className="pin-actions">
            <button 
              className="icon-button" 
              type="button" 
              title={
                selectedPairDevice
                  ? selectedPairPinValue
                    ? 'Generate new reconnect PIN'
                    : 'Generate reconnect PIN'
                  : selectedPairPinValue
                    ? 'Generate new PIN'
                    : 'Generate PIN'
              }
              onClick={() => void createSelectedPairPin()}
            >
              <RefreshCw size={16} />
            </button>
            {selectedPairPinValue ? (
              <button 
                className="icon-button" 
                type="button" 
                title="Connect this device"
                onClick={connectSelectedPairDevice}
              >
                <LogIn size={16} />
              </button>
            ) : null}
          </div>
        </section>

        <section className="settings-panel">
          <PanelHeading
            icon={<Palette size={22} />}
            title="Appearance"
            description="Choose the display mode for this device."
          />
          <ThemeSegmentedControl theme={theme} onChange={setTheme} />
        </section>

        <ChangePasscodeCard adminToken={adminToken} />

        <section className="settings-panel settings-panel-wide">
          <div className="settings-panel-title-row">
            <PanelHeading
              icon={<Tablet size={22} />}
              title="Paired devices"
              description="Only active devices are shown here."
            />
            <span className="device-count">{devices.length} active</span>
          </div>
          {devices.length === 0 ? (
            <p className="empty-inline">No active tablets or phones are paired.</p>
          ) : (
            <ul className="device-list">
              {devices.map((device) => (
                <li key={device.deviceId}>
                  <div className="device-copy">
                    <span>{device.deviceName}</span>
                    <small>{formatDeviceSeen(device.lastSeenAt)}</small>
                    <small>{formatDevicePin(devicePins[device.deviceId])}</small>
                  </div>
                  <div className="device-actions">
                    <button
                      className="icon-button"
                      type="button"
                      title={devicePins[device.deviceId] ? 'Refresh PIN' : 'Generate PIN'}
                      onClick={() => {
                        void createPin(device.deviceId);
                      }}
                    >
                      <RefreshCw size={16} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title="Connect"
                      onClick={async () => {
                        const activePin = devicePins[device.deviceId]?.pin || (await createPin(device.deviceId));
                        if (activePin) {
                          void onPair({ pin: activePin, existingDeviceId: device.deviceId });
                        }
                      }}
                    >
                      <LogIn size={16} />
                    </button>
                    <button
                      className="icon-button danger-icon-button"
                      type="button"
                      title="Revoke"
                      onClick={async () => {
                        await adminFetch('/settings/device/revoke', adminToken, {
                          method: 'POST',
                          body: JSON.stringify({ deviceId: device.deviceId })
                        });
                        setDevices((current) =>
                          current.filter((candidate) => candidate.deviceId !== device.deviceId)
                        );
                        setDevicePins((current) => {
                          const next = { ...current };
                          delete next[device.deviceId];
                          return next;
                        });
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </section>
    </main>
  );
}

function RemoteAccessPanel({
  remoteAccess,
  onCheck,
  onProtocolChange
}: {
  remoteAccess: RemoteAccessSettings;
  onCheck: () => void;
  onProtocolChange: (protocol: RemoteAccessSettings['tunnelProtocol']) => void;
}) {
  const [qrCode, setQrCode] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!remoteAccess.publicUrl) {
      setQrCode('');
      return;
    }

    QRCode.toDataURL(remoteAccess.publicUrl, {
      margin: 1,
      width: 180
    })
      .then((url) => {
        if (!cancelled) {
          setQrCode(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrCode('');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [remoteAccess.publicUrl]);

  return (
    <section className="settings-panel settings-panel-wide remote-panel">
      <PanelHeading
        icon={<Cloud size={22} />}
        title="Remote access"
        description="No domain needed. Agent Pulse will ask Cloudflare for a temporary public URL."
      />

      <div className="remote-status-row">
        <span className={`status-chip tone-${remoteAccess.status === 'healthy' ? 'green' : remoteAccess.enabled ? 'blue' : 'gray'}`}>
          {remoteStatusLabel(remoteAccess)}
        </span>
        {remoteAccess.lastError ? <p className="remote-error">{remoteAccess.lastError}</p> : null}
      </div>

      <div className="remote-actions">
        <button className="secondary-action" type="button" onClick={onCheck}>
          <RefreshCw size={16} />
          Check setup
        </button>
      </div>

      <label className="remote-protocol-control">
        <span>
          Tunnel protocol
          <span
            className="inline-help"
            title="Auto lets Cloudflare choose. Try HTTP/2 if the tunnel feels slow or unstable. Try QUIC when UDP works well on your network."
          >
            <HelpCircle size={14} />
          </span>
        </span>
        <select
          value={remoteAccess.tunnelProtocol}
          onChange={(event) =>
            onProtocolChange(event.currentTarget.value as RemoteAccessSettings['tunnelProtocol'])
          }
        >
          <option value="auto">Auto</option>
          <option value="http2">HTTP/2</option>
          <option value="quic">QUIC</option>
        </select>
      </label>

      <div className="remote-checklist" aria-label="Remote access checklist">
        <ChecklistItem label="cloudflared installed" done={remoteAccess.checklist.dependencyInstalled} />
        <ChecklistItem label="No domain needed" done={remoteAccess.checklist.authenticated} />
        <ChecklistItem label="Quick tunnel ready" done={remoteAccess.checklist.configured} />
        <ChecklistItem label="Random URL ready" done={remoteAccess.checklist.hostnameAssigned} />
        <ChecklistItem label="Tunnel running" done={remoteAccess.checklist.tunnelRunning} />
      </div>

      {remoteAccess.publicUrl ? (
        <div className="remote-url-box">
          {qrCode ? <img src={qrCode} alt="Remote access QR code" /> : null}
          <div>
            <p className="eyebrow">Public URL</p>
            <strong>{remoteAccess.publicUrl}</strong>
            <button
              className="secondary-action"
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(remoteAccess.publicUrl);
              }}
            >
              <Copy size={16} />
              Copy URL
            </button>
          </div>
        </div>
      ) : (
        <div className="remote-empty">
          Turn on remote access to create a temporary Cloudflare URL and QR code.
        </div>
      )}
    </section>
  );
}

function ChecklistItem({ label, done }: { label: string; done: boolean }) {
  return (
    <span className={`checklist-item ${done ? 'is-done' : ''}`}>
      <CheckCircle2 size={15} />
      {label}
    </span>
  );
}

function ChangePasscodeCard({ adminToken }: { adminToken: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSuccess(false);
    if (next !== confirm) {
      setError('New passcodes do not match.');
      return;
    }
    if (next.trim().length < 12) {
      setError('New passcode must be at least 12 characters.');
      return;
    }
    setSubmitting(true);
    try {
      await adminChangePasscode(adminToken, current, next.trim());
      setCurrent('');
      setNext('');
      setConfirm('');
      setSuccess(true);
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : 'Could not change passcode.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="settings-panel settings-panel-wide">
      <PanelHeading
        icon={<KeyRound size={22} />}
        title="Admin passcode"
        description="Change the passcode used to enter admin mode."
      />
      <form className="passcode-form" onSubmit={handleSubmit}>
        <label>
          Current passcode
          <input
            type="password"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="current-password"
            spellCheck={false}
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </label>
        <label>
          New passcode
          <input
            type="password"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="new-password"
            spellCheck={false}
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </label>
        <label>
          Confirm new passcode
          <input
            type="password"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="new-password"
            spellCheck={false}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        {success ? <p className="simple-copy">Passcode updated. Other admin sessions were signed out.</p> : null}
        <button
          className="primary-action full-width"
          type="submit"
          disabled={submitting || !current || !next}
        >
          Update passcode
        </button>
      </form>
    </section>
  );
}

function PanelHeading({
  icon,
  title,
  description
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <header className="settings-panel-heading">
      <span className="settings-panel-icon">{icon}</span>
      <span>
        <h2>{title}</h2>
        <p>{description}</p>
      </span>
    </header>
  );
}

function SettingRow({
  title,
  description,
  status,
  tone,
  action
}: {
  title: string;
  description: string;
  status: string;
  tone: 'green' | 'blue' | 'gray';
  action: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-row-title">
          <h3>{title}</h3>
          <span className={`status-chip tone-${tone}`}>{status}</span>
        </div>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function SettingsStat({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone: 'green' | 'blue' | 'gray' | 'neutral';
}) {
  return (
    <div className={`settings-stat tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function activeAdminDevices(devices: AdminDevice[]): AdminDevice[] {
  return devices.filter((device) => !device.revokedAt);
}

function formatDeviceSeen(lastSeenAt: string | undefined): string {
  if (!lastSeenAt) {
    return 'Not seen yet';
  }

  return `Last seen ${new Date(lastSeenAt).toLocaleString()}`;
}

function formatDevicePin(pin: AdminPairingPin | undefined): string {
  if (!pin) {
    return 'No reconnect PIN generated yet';
  }

  if (!pin.expiresAt) {
    return `Reconnect PIN ${pin.pin}`;
  }

  return `Reconnect PIN ${pin.pin}. Expires ${new Date(pin.expiresAt).toLocaleString()}.`;
}

function remoteStatusLabel(remoteAccess: RemoteAccessSettings): string {
  switch (remoteAccess.status) {
    case 'healthy':
      return 'Healthy';
    case 'starting':
      return 'Starting';
    case 'degraded':
      return 'Degraded';
    case 'disconnected':
      return 'Disconnected';
    case 'off':
    default:
      return 'Off';
  }
}

function defaultRemoteAccess(): RemoteAccessSettings {
  return {
    enabled: false,
    provider: 'cloudflare',
    mode: 'quick',
    tunnelProtocol: 'auto',
    hostname: '',
    publicUrl: '',
    tunnelName: 'agent-pulse',
    tunnelId: '',
    configPath: '',
    metricsUrl: 'http://127.0.0.1:60123/metrics',
    status: 'off',
    lastError: '',
    lastStartedAt: null,
    lastStoppedAt: null,
    lastCheckedAt: null,
    checklist: {
      dependencyInstalled: false,
      authenticated: false,
      configured: false,
      tunnelRunning: false,
      hostnameAssigned: false
    }
  };
}

function splitPairingPins(pins: AdminPairingPin[]): {
  newDevicePin?: AdminPairingPin;
  devicePins: Record<string, AdminPairingPin>;
} {
  const devicePins: Record<string, AdminPairingPin> = {};
  let newDevicePin: AdminPairingPin | undefined;

  for (const pin of pins) {
    if (pin.deviceId) {
      devicePins[pin.deviceId] = pin;
      continue;
    }

    newDevicePin = pin;
  }

  return { newDevicePin, devicePins };
}

function ThemeSegmentedControl({
  theme,
  onChange
}: {
  theme: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  const options: Array<{ value: ThemePreference; label: string; Icon: typeof Sun }> = [
    { value: 'system', label: 'System', Icon: Monitor },
    { value: 'light', label: 'Light', Icon: Sun },
    { value: 'dark', label: 'Dark', Icon: Moon }
  ];

  return (
    <div className="theme-segmented" role="radiogroup" aria-label="Theme preference">
      {options.map(({ value, label, Icon }) => {
        const selected = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`theme-segment ${selected ? 'is-selected' : ''}`}
            onClick={() => onChange(value)}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
