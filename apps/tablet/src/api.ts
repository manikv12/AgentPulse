import {
  ApprovalDecisionResponseSchema,
  ApprovalInboxResponseSchema,
  AppearanceSettingsSchema,
  CatalogCommandsResponseSchema,
  CatalogModelsResponseSchema,
  CatalogPluginsResponseSchema,
  CatalogSkillsResponseSchema,
  HelperHealthSchema,
  HandoffDeleteResponseSchema,
  HandoffListResponseSchema,
  HandoffPackageResponseSchema,
  HandoffSummaryDraftResponseSchema,
  PairingDeviceListResponseSchema,
  PairResponseSchema,
  PendingApprovalRequestSchema,
  ProjectFilesResponseSchema,
  ProjectListResponseSchema,
  RemoteAccessSettingsSchema,
  SeenThreadActivityResponseSchema,
  type SeenThreadActivityMap,
  ThreadCreateResponseSchema,
  ThreadDeleteResponseSchema,
  ThreadFileChangeActionResponseSchema,
  ThreadGoalClearResponseSchema,
  ThreadGoalResponseSchema,
  ThreadGoalUpdateRequestSchema,
  ThreadMessageResponseSchema,
  ThreadModelUpdateResponseSchema,
  ThreadStopResponseSchema,
  TouchCommandSheetResponseSchema,
  TranscriptCommentDraftResponseSchema,
  ThreadTranscriptSchema,
  VoiceTranscriptionResponseSchema,
  OlderThreadMessagesResponseSchema,
  ThreadListResponseSchema,
  type CollaborationModeKind,
  type SelectableCodexPermissionModeId,
  type ApprovalDecisionRequest,
  type AgentProvider,
  type AppearanceSettings,
  type AppearanceSettingsUpdateRequest,
  type CatalogCommand,
  type CatalogModel,
  type CatalogPlugin,
  type CatalogSkill,
  type ChatAttachment,
  type HelperHealth,
  type ApprovalInboxItem,
  type HandoffPackage,
  type HandoffSummaryDraft,
  type PairingDeviceOption,
  type PendingApprovalRequest,
  type Project,
  type ProjectFilesResponse,
  type RemoteAccessSettings,
  type Thread,
  type ThreadGoal,
  type ThreadGoalUpdateRequest,
  type ThreadFileChangeActionRequest,
  type ThreadFileChangeSummary,
  type ThreadListGroup,
  type ThreadMessageResponse,
  type ThreadDeleteResponse,
  type ThreadStopResponse,
  type TouchCommand,
  type TranscriptCommentDraft,
  type ThreadTranscript,
  type VoiceTranscriptionResponse,
  type OlderThreadMessagesResponse
} from '@agent-pulse/shared';
import { z } from 'zod';

export type AgentPulseSession = {
  token: string;
  deviceId: string;
  fingerprint: string;
  deviceName: string;
};

export type FetchThreadTranscriptOptions = {
  messageLimit?: number;
};

export type FetchThreadListOptions = {
  groupLimits?: Record<string, number>;
};

export type FetchThreadListResult = {
  threads: Thread[];
  groups: ThreadListGroup[];
};

export type HelperSettingsSnapshot = {
  port?: number;
  lanEnabled?: boolean;
  mobileSendEnabled?: boolean;
  enabledProviders?: AgentProvider[];
  appearance?: AppearanceSettings;
  remoteAccess?: RemoteAccessSettings;
};

// Thrown when a transcript fetch is aborted by our local timeout. Callers that already
// have a transcript on screen (initial load done, polling refresh) can swallow this —
// the helper has its own cache fallback, so a timeout here usually just means the
// network or upstream Codex was briefly slow, not that the conversation is gone.
export class TranscriptFetchTimeoutError extends Error {
  constructor(message = 'Conversation is taking too long to load. Try again.') {
    super(message);
    this.name = 'TranscriptFetchTimeoutError';
  }
}

export class AgentPulseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string
  ) {
    super(message);
    this.name = 'AgentPulseApiError';
    Object.setPrototypeOf(this, AgentPulseApiError.prototype);
  }
}

const sessionKey = 'agent-pulse-session';
const fingerprintKey = 'agent-pulse-fingerprint';
const adminTokenKey = 'agent-pulse-admin-token';

export function loadAdminToken(): string | undefined {
  return sessionStorage.getItem(adminTokenKey) ?? undefined;
}

export function saveAdminToken(token: string): void {
  sessionStorage.setItem(adminTokenKey, token);
}

export function clearAdminToken(): void {
  sessionStorage.removeItem(adminTokenKey);
}

export async function adminLogin(passcode: string): Promise<string> {
  const response = await fetch('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode })
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Admin passcode is invalid.'));
  }

  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string') {
    throw new Error('Admin login returned an unexpected response.');
  }
  return body.token;
}

export async function adminLogout(token: string): Promise<void> {
  await fetch('/admin/logout', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  });
}

export async function adminChangePasscode(
  token: string,
  currentPasscode: string,
  nextPasscode: string
): Promise<void> {
  const response = await adminFetch('/admin/passcode', token, {
    method: 'POST',
    body: JSON.stringify({ currentPasscode, nextPasscode })
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not change passcode.'));
  }
}

export async function checkRemoteAccess(token: string): Promise<RemoteAccessSettings> {
  return remoteAccessPost('/settings/remote-access/check', token);
}

export async function updateRemoteAccess(
  token: string,
  input: { enabled?: boolean; mode?: RemoteAccessSettings['mode']; tunnelProtocol?: RemoteAccessSettings['tunnelProtocol']; hostname?: string; tunnelName?: string }
): Promise<RemoteAccessSettings> {
  return remoteAccessPost('/settings/remote-access', token, input);
}

export async function updateEnabledProviders(
  token: string,
  enabledProviders: AgentProvider[]
): Promise<HelperSettingsSnapshot> {
  const response = await adminFetch('/settings/providers', token, {
    method: 'POST',
    body: JSON.stringify({ enabledProviders })
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not update enabled agents.'));
  }

  const payload = (await response.json()) as { settings?: HelperSettingsSnapshot };
  return payload.settings ?? {};
}

export async function updateAppearanceSettings(
  token: string,
  input: AppearanceSettingsUpdateRequest
): Promise<AppearanceSettings> {
  const response = await adminFetch('/settings/appearance', token, {
    method: 'POST',
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not update appearance.'));
  }

  const payload = (await response.json()) as { appearance?: unknown };
  return AppearanceSettingsSchema.parse(payload.appearance);
}

export async function configureCloudflareRemoteAccess(
  token: string,
  input: { mode?: RemoteAccessSettings['mode']; tunnelProtocol?: RemoteAccessSettings['tunnelProtocol']; hostname?: string; tunnelName?: string }
): Promise<RemoteAccessSettings> {
  return remoteAccessPost('/settings/remote-access/cloudflare/configure', token, input);
}

export async function loginCloudflareRemoteAccess(token: string): Promise<RemoteAccessSettings> {
  return remoteAccessPost('/settings/remote-access/cloudflare/login', token);
}

async function remoteAccessPost(
  url: string,
  token: string,
  body?: { enabled?: boolean; mode?: RemoteAccessSettings['mode']; tunnelProtocol?: RemoteAccessSettings['tunnelProtocol']; hostname?: string; tunnelName?: string }
): Promise<RemoteAccessSettings> {
  const response = await adminFetch(url, token, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not update remote access.'));
  }

  const payload = (await response.json()) as { remoteAccess?: unknown };
  return RemoteAccessSettingsSchema.parse(payload.remoteAccess);
}

export function adminFetch(url: string, token: string | undefined, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
  }
  if (init.body && !isFormDataBody(init.body)) {
    headers.set('content-type', 'application/json');
  }
  return fetch(url, { ...init, headers });
}

export function loadSession(): AgentPulseSession | undefined {
  const raw = localStorage.getItem(sessionKey);
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as AgentPulseSession;
  } catch {
    localStorage.removeItem(sessionKey);
    return undefined;
  }
}

export function saveSession(session: AgentPulseSession): void {
  localStorage.setItem(sessionKey, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(sessionKey);
}

export function getFingerprint(): string {
  const existing = localStorage.getItem(fingerprintKey);
  if (existing) {
    return existing;
  }

  const generated = `web-${createBrowserId()}-${navigator.userAgent.slice(0, 80)}`;
  localStorage.setItem(fingerprintKey, generated);
  return generated;
}

function createBrowserId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HelperHealth> {
  const response = await fetch('/health/get', { signal });
  return HelperHealthSchema.parse(await response.json());
}

export async function fetchPairingDevices(): Promise<PairingDeviceOption[]> {
  const response = await fetch('/device/options');
  if (!response.ok) {
    throw new Error('Could not load saved devices.');
  }

  return PairingDeviceListResponseSchema.parse(await response.json()).devices;
}

export async function pairDevice(input: {
  pin: string;
  deviceName?: string;
  existingDeviceId?: string;
  fingerprint: string;
}): Promise<{ token: string; deviceId: string; deviceName: string }> {
  const response = await fetch('/device/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Pairing failed. Check the PIN.'));
  }

  return PairResponseSchema.parse(await response.json());
}

export async function recoverDeviceSession(
  session: AgentPulseSession
): Promise<{ token: string; deviceId: string; deviceName: string }> {
  const response = await fetch('/device/session/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: session.deviceId,
      fingerprint: session.fingerprint
    })
  });

  if (!response.ok) {
    throw response;
  }

  return PairResponseSchema.parse(await response.json());
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const contentType = response.headers?.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const message = await readJsonErrorMessage(response);
      return message ?? fallback;
    }

    const jsonResponse = typeof response.clone === 'function' ? response.clone() : response;
    const jsonMessage = await readJsonErrorMessage(jsonResponse);
    if (jsonMessage) {
      return jsonMessage;
    }

    if (typeof response.text === 'function') {
      const body = await response.text();
      const trimmed = body.replace(/\s+/g, ' ').trim();
      if (trimmed) {
        return `${fallback} ${response.status}: ${trimmed.slice(0, 220)}`;
      }
    }
  } catch {
    return fallback;
  }

  return fallback;
}

async function readJsonErrorMessage(response: Response): Promise<string | undefined> {
  if (typeof response.json !== 'function') {
    return undefined;
  }

  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error.trim() ? body.error : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchThreadList(
  session: AgentPulseSession,
  options: FetchThreadListOptions = {}
): Promise<FetchThreadListResult> {
  const response = await authedFetch(threadListUrl(options), session);
  if (!response.ok) {
    throw response;
  }

  const parsed = ThreadListResponseSchema.parse(await response.json());
  return {
    threads: parsed.threads,
    groups: parsed.groups ?? []
  };
}

export async function fetchThreads(session: AgentPulseSession): Promise<Thread[]> {
  return (await fetchThreadList(session)).threads;
}

function threadListUrl(options: FetchThreadListOptions): string {
  const params = new URLSearchParams();
  for (const [groupKey, limit] of Object.entries(options.groupLimits ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!groupKey || !Number.isFinite(limit) || limit <= 0) {
      continue;
    }
    params.append('groupLimit', JSON.stringify({ groupKey, limit: Math.floor(limit) }));
  }
  const query = params.toString();
  return query ? `/threads/list?${query}` : '/threads/list';
}

export async function fetchSeenThreadActivity(
  session: AgentPulseSession
): Promise<SeenThreadActivityMap> {
  const response = await authedFetch('/threads/seen-activity', session);
  if (!response.ok) {
    throw response;
  }
  return SeenThreadActivityResponseSchema.parse(await response.json()).entries;
}

export async function markThreadSeenOnHelper(
  session: AgentPulseSession,
  threadId: string,
  seenAt: number
): Promise<void> {
  const response = await authedFetch(`/threads/${encodeURIComponent(threadId)}/seen`, session, {
    method: 'POST',
    body: JSON.stringify({ seenAt })
  });
  if (!response.ok) {
    throw response;
  }
}

export async function importSeenThreadActivity(
  session: AgentPulseSession,
  entries: SeenThreadActivityMap
): Promise<SeenThreadActivityMap> {
  const response = await authedFetch('/threads/seen-activity/import', session, {
    method: 'POST',
    body: JSON.stringify({ entries })
  });
  if (!response.ok) {
    throw response;
  }
  return SeenThreadActivityResponseSchema.parse(await response.json()).entries;
}

export async function fetchProjects(session: AgentPulseSession): Promise<Project[]> {
  const response = await authedFetch('/projects/list', session);
  if (!response.ok) {
    throw response;
  }

  const parsed = ProjectListResponseSchema.parse(await response.json());
  return parsed.projects;
}

export async function fetchApprovalInbox(
  session: AgentPulseSession
): Promise<ApprovalInboxItem[]> {
  const response = await authedFetch('/approvals/inbox', session);
  if (!response.ok) {
    throw response;
  }
  return ApprovalInboxResponseSchema.parse(await response.json()).items;
}

export async function fetchTouchCommands(
  session: AgentPulseSession,
  threadId?: string
): Promise<TouchCommand[]> {
  const path = threadId
    ? `/commands/touch-sheet?threadId=${encodeURIComponent(threadId)}`
    : '/commands/touch-sheet';
  const response = await authedFetch(path, session);
  if (!response.ok) {
    throw response;
  }
  return TouchCommandSheetResponseSchema.parse(await response.json()).commands;
}

export async function createTranscriptCommentDraft(
  session: AgentPulseSession,
  threadId: string,
  input: { messageId: string; selectedText: string; userInstruction?: string }
): Promise<TranscriptCommentDraft> {
  const response = await authedFetch(`/threads/${encodeURIComponent(threadId)}/comment-draft`, session, {
    method: 'POST',
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not prepare a comment reply.'));
  }
  return TranscriptCommentDraftResponseSchema.parse(await response.json()).draft;
}

export type StartThreadTarget =
  | string
  | { location: 'chat'; provider?: AgentProvider; modelSlug?: string; reasoningEffort?: string; permissionMode?: SelectableCodexPermissionModeId }
  | { projectId: string; provider?: AgentProvider; modelSlug?: string; reasoningEffort?: string; permissionMode?: SelectableCodexPermissionModeId }
  | { cwd: string; provider?: AgentProvider; modelSlug?: string; reasoningEffort?: string; permissionMode?: SelectableCodexPermissionModeId };

export async function startThread(
  session: AgentPulseSession,
  target: StartThreadTarget
): Promise<{ thread: Thread }> {
  const body = typeof target === 'string' ? { projectId: target } : target;
  const response = await authedFetch('/threads/new', session, {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not create a new chat.'));
  }

  return ThreadCreateResponseSchema.parse(await response.json());
}

export async function fetchHandoffs(session: AgentPulseSession): Promise<HandoffPackage[]> {
  const response = await authedFetch('/handoffs', session);
  if (!response.ok) {
    throw response;
  }
  return HandoffListResponseSchema.parse(await response.json()).handoffs;
}

export async function createHandoffSummaryDraft(
  session: AgentPulseSession,
  input: {
    sourceThreadId: string;
    targetProvider: AgentProvider;
    userInstruction: string;
  }
): Promise<HandoffSummaryDraft> {
  const response = await authedFetch('/handoffs/summary-draft', session, {
    method: 'POST',
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not create a handoff summary.'));
  }
  return HandoffSummaryDraftResponseSchema.parse(await response.json()).draft;
}

export async function sendHandoff(
  session: AgentPulseSession,
  input: {
    sourceThreadId: string;
    targetProvider: AgentProvider;
    userInstruction: string;
    summary: string;
    prompt: string;
    target?: Exclude<StartThreadTarget, string>;
  }
): Promise<HandoffPackage> {
  const response = await authedFetch('/handoffs/send', session, {
    method: 'POST',
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not hand off this task.'));
  }
  return HandoffPackageResponseSchema.parse(await response.json()).handoff;
}

export async function returnHandoff(
  session: AgentPulseSession,
  handoffId: string,
  input: { summary: string; prompt: string }
): Promise<void> {
  const response = await authedFetch(`/handoffs/${encodeURIComponent(handoffId)}/return`, session, {
    method: 'POST',
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not return this handoff.'));
  }
  HandoffDeleteResponseSchema.parse(await response.json());
}

export async function deleteHandoff(session: AgentPulseSession, handoffId: string): Promise<void> {
  const response = await authedFetch(`/handoffs/${encodeURIComponent(handoffId)}`, session, {
    method: 'DELETE'
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not dismiss this handoff.'));
  }
  HandoffDeleteResponseSchema.parse(await response.json());
}

export async function openThreadInCodex(
  session: AgentPulseSession,
  threadId: string
): Promise<void> {
  const response = await authedFetch('/thread/open', session, {
    method: 'POST',
    body: JSON.stringify({ threadId, mode: 'open' })
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not open this thread in Codex.'));
  }

  const body = (await response.json()) as { ok?: unknown; error?: unknown };
  if (body.ok !== true) {
    throw new Error(
      typeof body.error === 'string' && body.error.trim()
        ? body.error
        : 'Could not open this thread in Codex.'
    );
  }
}

export async function fetchThreadTranscript(
  session: AgentPulseSession,
  threadId: string,
  options: FetchThreadTranscriptOptions = {}
): Promise<ThreadTranscript> {
  const controller = new AbortController();
  // Generous timeout: the helper itself races the upstream Codex read against a 5s
  // timeout and falls back to a cached transcript on miss, so anything slower than ~30s
  // here genuinely indicates the helper or tunnel is wedged, not just a slow turn.
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  const params = new URLSearchParams();
  if (typeof options.messageLimit === 'number' && Number.isFinite(options.messageLimit)) {
    params.set('limit', `${Math.max(1, Math.trunc(options.messageLimit))}`);
  }
  const path = params.size > 0
    ? `/threads/${encodeURIComponent(threadId)}/transcript?${params.toString()}`
    : `/threads/${encodeURIComponent(threadId)}/transcript`;

  try {
    const response = await authedFetch(path, session, {
      signal: controller.signal
    });
    if (!response.ok) {
      throw response;
    }

    return ThreadTranscriptSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TranscriptFetchTimeoutError();
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchOlderThreadMessages(
  session: AgentPulseSession,
  threadId: string,
  beforeMessageId: string,
  limit = 40
): Promise<OlderThreadMessagesResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  const params = new URLSearchParams({
    before: beforeMessageId,
    limit: `${Math.max(1, Math.trunc(limit))}`
  });
  const path = `/threads/${encodeURIComponent(threadId)}/transcript/older?${params.toString()}`;

  try {
    const response = await authedFetch(path, session, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, 'Could not load older messages.'));
    }
    return OlderThreadMessagesResponseSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Loading older messages timed out. Try again.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function sendThreadMessage(
  session: AgentPulseSession,
  threadId: string,
  text: string,
  options: {
    collaborationMode?: CollaborationModeKind;
    permissionMode?: SelectableCodexPermissionModeId;
    attachments?: ChatAttachment[];
  } = {}
): Promise<ThreadMessageResponse> {
  const response = await authedFetch(`/threads/${encodeURIComponent(threadId)}/messages`, session, {
    method: 'POST',
    body: JSON.stringify({
      text,
      ...(options.collaborationMode ? { collaborationMode: options.collaborationMode } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options.attachments?.length ? { attachments: options.attachments } : {})
    })
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not send this message.'));
  }

  return ThreadMessageResponseSchema.parse(await response.json());
}

export async function fetchThreadGoal(
  session: AgentPulseSession,
  threadId: string
): Promise<ThreadGoal | null> {
  const response = await authedFetch(`/threads/${encodeURIComponent(threadId)}/goal`, session);
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not load Codex goal.'));
  }
  return ThreadGoalResponseSchema.parse(await response.json()).goal;
}

export async function updateThreadGoal(
  session: AgentPulseSession,
  threadId: string,
  input: ThreadGoalUpdateRequest
): Promise<ThreadGoal> {
  const payload = ThreadGoalUpdateRequestSchema.parse(input);
  const response = await authedFetch(`/threads/${encodeURIComponent(threadId)}/goal`, session, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not update Codex goal.'));
  }
  const goal = ThreadGoalResponseSchema.parse(await response.json()).goal;
  if (!goal) {
    throw new Error('Codex did not return the updated goal.');
  }
  return goal;
}

export async function clearThreadGoal(
  session: AgentPulseSession,
  threadId: string
): Promise<boolean> {
  const response = await authedFetch(`/threads/${encodeURIComponent(threadId)}/goal`, session, {
    method: 'DELETE'
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not clear Codex goal.'));
  }
  return ThreadGoalClearResponseSchema.parse(await response.json()).cleared;
}

export async function transcribeVoiceAudio(
  session: AgentPulseSession,
  audio: Blob
): Promise<VoiceTranscriptionResponse> {
  const form = new FormData();
  const extension = audio.type.includes('mp4')
    ? 'm4a'
    : audio.type.includes('ogg')
      ? 'ogg'
      : audio.type.includes('wav')
        ? 'wav'
        : 'webm';
  form.set('audio', audio, `voice.${extension}`);
  const response = await authedFetch('/voice/transcriptions', session, {
    method: 'POST',
    body: form
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not transcribe audio.'));
  }
  return VoiceTranscriptionResponseSchema.parse(await response.json());
}

export async function stopThreadWork(
  session: AgentPulseSession,
  threadId: string
): Promise<ThreadStopResponse> {
  const response = await authedFetch(`/threads/${encodeURIComponent(threadId)}/stop`, session, {
    method: 'POST'
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | { error?: unknown; reason?: unknown }
      | undefined;
    // Generic fallback — the same /stop endpoint handles Codex, Claude Code,
    // and Copilot threads, so the provider-specific message belongs in the
    // helper's response body when relevant. Hardcoding "Codex" here surfaced
    // the wrong provider name for Copilot/Claude threads.
    const message =
      typeof body?.error === 'string' && body.error.trim() ? body.error : 'Could not stop the agent.';
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason : undefined;
    throw new AgentPulseApiError(message, response.status, reason);
  }

  return ThreadStopResponseSchema.parse(await response.json());
}

export async function deleteThread(
  session: AgentPulseSession,
  threadId: string
): Promise<ThreadDeleteResponse> {
  const response = await authedFetch(`/threads/${encodeURIComponent(threadId)}`, session, {
    method: 'DELETE'
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not delete this thread.'));
  }

  return ThreadDeleteResponseSchema.parse(await response.json());
}

export async function fetchCatalogPlugins(session: AgentPulseSession): Promise<CatalogPlugin[]> {
  const response = await authedFetch('/catalog/plugins', session);
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not load plugins.'));
  }
  return CatalogPluginsResponseSchema.parse(await response.json()).plugins;
}

export async function fetchCatalogSkills(session: AgentPulseSession): Promise<CatalogSkill[]> {
  const response = await authedFetch('/catalog/skills', session);
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not load skills.'));
  }
  return CatalogSkillsResponseSchema.parse(await response.json()).skills;
}

export async function fetchCatalogCommands(session: AgentPulseSession): Promise<CatalogCommand[]> {
  const response = await authedFetch('/catalog/commands', session);
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not load commands.'));
  }
  return CatalogCommandsResponseSchema.parse(await response.json()).commands;
}

export async function fetchCatalogModels(session: AgentPulseSession): Promise<CatalogModel[]> {
  const response = await authedFetch('/catalog/models', session);
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not load models.'));
  }
  return CatalogModelsResponseSchema.parse(await response.json()).models;
}

export async function fetchProjectFiles(
  session: AgentPulseSession,
  projectId: string,
  query: string,
  limit = 50
): Promise<ProjectFilesResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const response = await authedFetch(
    `/projects/${encodeURIComponent(projectId)}/files?${params.toString()}`,
    session
  );
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not list files.'));
  }
  return ProjectFilesResponseSchema.parse(await response.json());
}

const PendingApprovalsResponseSchema = z.object({
  threadId: z.string().min(1),
  requests: z.array(PendingApprovalRequestSchema)
});

// Fetches the current set of approval requests Codex is waiting on for a
// thread. Used as a reconnect-time fallback: the live websocket sends pending
// approvals via push events, but if the tablet missed the broadcast (e.g. it
// reconnected after Codex emitted the patch) the only way to recover the
// approval card is to ask the helper directly.
export async function fetchPendingApprovals(
  session: AgentPulseSession,
  threadId: string
): Promise<PendingApprovalRequest[]> {
  const response = await authedFetch(
    `/threads/${encodeURIComponent(threadId)}/pending-approvals`,
    session
  );
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not load pending approvals.'));
  }
  return PendingApprovalsResponseSchema.parse(await response.json()).requests;
}

export async function respondToApproval(
  session: AgentPulseSession,
  threadId: string,
  requestId: string,
  method: ApprovalDecisionRequest['method'],
  decision: string | Record<string, unknown>
): Promise<void> {
  const response = await authedFetch(
    `/threads/${encodeURIComponent(threadId)}/approvals/${encodeURIComponent(requestId)}`,
    session,
    {
      method: 'POST',
      body: JSON.stringify({ method, decision })
    }
  );
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not record approval.'));
  }
  ApprovalDecisionResponseSchema.parse(await response.json());
}

export async function applyThreadFileChangeAction(
  session: AgentPulseSession,
  threadId: string,
  changeId: string,
  action: ThreadFileChangeActionRequest['action']
): Promise<ThreadFileChangeSummary | undefined> {
  const response = await authedFetch(
    `/threads/${encodeURIComponent(threadId)}/file-changes/${encodeURIComponent(changeId)}`,
    session,
    {
      method: 'POST',
      body: JSON.stringify({ action })
    }
  );
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not apply Codex file change.'));
  }
  return ThreadFileChangeActionResponseSchema.parse(await response.json()).summary;
}

export async function updateThreadModel(
  session: AgentPulseSession,
  threadId: string,
  modelSlug: string,
  reasoningEffort?: string
): Promise<{ modelSlug: string; reasoningEffort?: string }> {
  const response = await authedFetch(
    `/threads/${encodeURIComponent(threadId)}/model`,
    session,
    {
      method: 'POST',
      body: JSON.stringify({ modelSlug, ...(reasoningEffort ? { reasoningEffort } : {}) })
    }
  );
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Could not update the model.'));
  }
  const parsed = ThreadModelUpdateResponseSchema.parse(await response.json());
  return {
    modelSlug: parsed.modelSlug,
    ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {})
  };
}

export function liveEventsUrl(session: AgentPulseSession): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({
    token: session.token,
    deviceId: session.deviceId,
    fingerprint: session.fingerprint
  });
  return `${protocol}//${window.location.host}/events?${params.toString()}`;
}

async function authedFetch(
  url: string,
  session: AgentPulseSession,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${session.token}`);
  headers.set('x-agent-pulse-device-id', session.deviceId);
  headers.set('x-agent-pulse-fingerprint', session.fingerprint);
  if (init.body && !isFormDataBody(init.body)) {
    headers.set('content-type', 'application/json');
  }

  return fetch(url, {
    ...init,
    headers
  });
}

function isFormDataBody(body: BodyInit): boolean {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}
