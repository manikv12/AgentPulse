import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  ApprovalDecisionRequestSchema,
  ApprovalDecisionResponseSchema,
  CatalogCommandsResponseSchema,
  CatalogModelSchema,
  CatalogModelsResponseSchema,
  CatalogPluginsResponseSchema,
  CatalogSkillsResponseSchema,
  ChatMessageSchema,
  DeviceSessionRecoveryRequestSchema,
  DeviceRevokeRequestSchema,
  HelperHealthSchema,
  LiveEventSchema,
  PairRequestSchema,
  PairingDeviceListResponseSchema,
  PairResponseSchema,
  ProjectFilesResponseSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  RemoteActivityLogEntrySchema,
  RemoteAccessProtocolSchema,
  RemoteAccessSettingsSchema,
  ThreadCreateRequestSchema,
  ThreadCreateResponseSchema,
  ThreadDeleteResponseSchema,
  ThreadMessageRequestSchema,
  ThreadMessageResponseSchema,
  ThreadListResponseSchema,
  ThreadModelUpdateRequestSchema,
  ThreadModelUpdateResponseSchema,
  ThreadOpenRequestSchema,
  ThreadSchema,
  ThreadStopResponseSchema,
  ThreadTranscriptSchema,
  OlderThreadMessagesResponseSchema,
  SeenThreadActivityImportRequestSchema,
  SeenThreadActivityMarkRequestSchema,
  SeenThreadActivityResponseSchema,
  resolveThreadStatus,
  type CollaborationModeKind,
  type AgentProvider,
  type ChatAttachment,
  type CatalogModel,
  type HelperHealth,
  type LiveEvent,
  type PendingApprovalRequest,
  type Project,
  type RemoteActivityLogEntry,
  type RemoteAccessSettings,
  type RemoteAccessMode,
  type RemoteAccessProtocol,
  type Thread,
  type ThreadMessageResponse,
  type ThreadTranscript
} from '@agent-pulse/shared';
import { Hono, type Context } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AdminAuth } from '../auth/admin';
import { RateLimiter, type DeviceRegistry, type PairingManager } from '../auth/pairing';
import { isClaudeThreadId } from '../claude/claude-code';
import { SendBlockedError } from '../codex/app-server-chat';
import type { CatalogReader } from '../codex/catalog';
import type { createThreadOpener } from '../codex/thread-opener';
import { debugLog } from '../debug';
import type { SeenThreadStore } from './seen-thread-store';
import { normalizeEnabledProviders, type HelperSettings, type HelperSettingsStore } from './settings';
import { createTabletDevProxy, type TabletDevProxy } from './tablet-dev-proxy';

type ThreadOpener = ReturnType<typeof createThreadOpener>;

type LocalAttachment = {
  sourcePath: string;
  contentType: string;
  expiresAt: number;
};

const GLOBAL_ADMIN_LOGIN_LIMIT_KEY = '__global_admin_login_failures__';
const DESKTOP_INTEREST_TTL_MS = 30 * 60_000;
const MANUAL_OPEN_COOLDOWN_MS = 2_500;
const AUTO_DESKTOP_REFRESH_SETTLE_MS = 800;
const AUTO_DESKTOP_REFRESH_COOLDOWN_MS = 10_000;

type DesktopRefreshCandidate = {
  threadId: string;
  turnId: string;
};

export type AppServerChatBridge = {
  isConnected(): boolean;
  readTranscript(threadId: string): Promise<ThreadTranscript>;
  readFullTranscript?(threadId: string): Promise<ThreadTranscript>;
  subscribeThread?(threadId: string): Promise<void>;
  listLoadedThreadIds?(): Promise<Set<string>>;
  listLoadedThreadStatuses?(): Promise<Map<string, Thread['status']>>;
  applyLiveState?(transcript: ThreadTranscript, threadId: string): ThreadTranscript;
  sendMessage(
    threadId: string,
    text: string,
    options?: { model?: string; effort?: string; collaborationMode?: CollaborationModeKind }
  ): Promise<ThreadMessageResponse>;
  startThread?(
    cwd: string,
    options?: { model?: string; reasoningEffort?: string }
  ): Promise<Thread>;
  interruptTurn?(threadId: string): Promise<void>;
  compactThread?(threadId: string): Promise<void>;
  archiveThread?(threadId: string): Promise<void>;
  startReview?(threadId: string): Promise<void>;
  respondToApproval?(
    threadId: string,
    requestId: string,
    method: string,
    response: unknown
  ): Promise<void>;
  getPendingApprovalRequests?(threadId: string): PendingApprovalRequest[];
  isThreadStreaming?(threadId: string): boolean;
  isThreadCompacting?(threadId: string): boolean;
  isThreadWaitingForApproval?(threadId: string): boolean;
  onLiveEvent?(listener: (event: LiveEvent) => void): () => void;
  onLiveStateChange?(listener: (threadId: string) => void): () => void;
  onTurnCompleted?(listener: (event: { threadId: string; turnId: string }) => void): () => void;
  onConnectionChange?(listener: (connected: boolean) => void): () => void;
  ensureConnected?(): Promise<void>;
  listModels?(): Promise<CatalogModel[]>;
};

// IPC mirror to a running Codex desktop window. Used as the preferred transport
// for sending messages and changing the model so the desktop window mirrors
// what the tablet does — same diff view, same model picker animation. Falls
// back to the spawned app-server subprocess when the mirror isn't available.
export type CodexMirrorBridge = {
  isConnected(): boolean;
  sendMessage(
    threadId: string,
    text: string,
    options?: {
      collaborationMode?: CollaborationModeKind;
      model?: string;
      effort?: string;
    }
  ): Promise<ThreadMessageResponse>;
  setModelAndReasoning?(
    threadId: string,
    modelSlug: string,
    reasoningEffort?: string
  ): Promise<void>;
  respondToApproval?(
    threadId: string,
    requestId: string,
    method: string,
    response: unknown
  ): Promise<void>;
  getPendingApprovalRequests?(threadId: string): PendingApprovalRequest[];
  isThreadWaitingForApproval?(threadId: string): boolean;
  onPendingApprovalsChange?(
    listener: (event: { threadId: string; requests: PendingApprovalRequest[] }) => void
  ): () => void;
  isThreadOwned?(threadId: string): boolean;
  waitForOwnership?(threadId: string, timeoutMs: number): Promise<boolean>;
};

export type ClaudeCodeBridge = {
  listThreads(): Promise<Thread[]>;
  listProjects(): Promise<Project[]>;
  readTranscript(threadId: string): Promise<ThreadTranscript>;
  readFullTranscript?(threadId: string): Promise<ThreadTranscript>;
  sendMessage(
    threadId: string,
    text: string,
    options?: { model?: string; effort?: string; collaborationMode?: CollaborationModeKind }
  ): Promise<ThreadMessageResponse>;
  startThread?(cwd: string, options?: { model?: string; reasoningEffort?: string }): Promise<Thread>;
  interruptTurn?(threadId: string): Promise<void>;
  respondToApproval?(
    threadId: string,
    requestId: string,
    method: string,
    response: unknown
  ): Promise<void>;
  getPendingApprovalRequests?(threadId: string): PendingApprovalRequest[];
  isThreadStreaming?(threadId: string): boolean;
  isThreadWaitingForApproval?(threadId: string): boolean;
  onLiveEvent?(listener: (event: LiveEvent) => void): () => void;
  onLiveStateChange?(listener: (threadId: string) => void): () => void;
  listModels?(): Promise<CatalogModel[]>;
  setModel?(threadId: string, modelSlug: string, reasoningEffort?: string): Promise<void>;
};

export type AgentPulseServerOptions = {
  settings: HelperSettings;
  settingsStore: HelperSettingsStore;
  registry: DeviceRegistry;
  pairing: PairingManager;
  adminAuth: AdminAuth;
  threadProvider: { listThreads(): Promise<Thread[]>; listProjects?(): Promise<Project[]> };
  opener: ThreadOpener;
  appServer?: AppServerChatBridge;
  mirror?: CodexMirrorBridge;
  claudeCode?: ClaudeCodeBridge;
  catalog?: CatalogReader;
  seenThreadStore?: SeenThreadStore;
  usageProvider?: (threadId: string) => Promise<import('@agent-pulse/shared').ThreadUsage | undefined>;
  version: string;
  tabletDistDir?: string;
  tabletDevUrl?: string;
  onLanModeChange?: (enabled: boolean) => Promise<void>;
  remoteAccess?: RemoteAccessController;
};

export type RemoteAccessController = {
  getStatus(): RemoteAccessSettings;
  check(): Promise<RemoteAccessSettings>;
  configure(input: { enabled?: boolean; mode?: RemoteAccessMode; tunnelProtocol?: RemoteAccessProtocol; hostname?: string; tunnelName?: string }): Promise<RemoteAccessSettings>;
  setEnabled(enabled: boolean): Promise<RemoteAccessSettings>;
  login(): Promise<RemoteAccessSettings>;
};

export type RunningAgentPulseServer = {
  url: string;
  server: Server;
  hub: LiveEventHub;
  stop(): Promise<void>;
};

export async function startAgentPulseServer(
  options: AgentPulseServerOptions
): Promise<RunningAgentPulseServer> {
  const hub = new LiveEventHub();
  const tabletDevProxy = options.tabletDevUrl ? createTabletDevProxy(options.tabletDevUrl) : undefined;
  const { app, transformTranscript, dispose } = createApp(options, hub, tabletDevProxy);

  const hostname = options.settings.lanEnabled ? '0.0.0.0' : '127.0.0.1';
  const server = await new Promise<Server>((resolve, reject) => {
    const nodeServer = serve(
      {
        fetch: app.fetch,
        port: options.settings.port,
        hostname
      },
      () => resolve(nodeServer as unknown as Server)
    ) as unknown as Server;
    nodeServer.once('error', reject);
  });
  attachWebSocketEvents(
    server,
    hub,
    options.registry,
    () => ({
      ...options.settings,
      remoteAccess: options.remoteAccess?.getStatus() ?? options.settings.remoteAccess
    }),
    tabletDevProxy
  );

  const poller = startThreadPolling(
    options.threadProvider,
    hub,
    options.appServer,
    options.mirror,
    transformTranscript,
    options.seenThreadStore
  );
  const detachCatalog = options.catalog?.onChange((kind) => {
    hub.broadcast({ type: 'catalog/changed', payload: { kind } });
  });
  const urlHost = options.settings.lanEnabled ? 'localhost' : '127.0.0.1';
  const url = `http://${urlHost}:${options.settings.port}`;

  return {
    url,
    server,
    hub,
    async stop() {
      clearInterval(poller);
      dispose();
      detachCatalog?.();
      hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

type CreatedApp = {
  app: Hono;
  transformTranscript: (transcript: ThreadTranscript, threadId: string) => ThreadTranscript;
  dispose: () => void;
};

function createApp(
  options: AgentPulseServerOptions,
  hub: LiveEventHub,
  tabletDevProxy?: TabletDevProxy
): CreatedApp {
  const app = new Hono();
  const startedAt = Date.now();
  const localAttachments = new Map<string, LocalAttachment>();
  // Pending model/effort overrides applied on the next turn/start for that thread.
  // Used by /threads/:id/model when no Codex window owns the thread. The override
  // is consumed when the user sends the next
  // message — at that point we pass it directly to turn/start, no ownership needed.
  const pendingModelOverrides = new Map<string, { model: string; effort?: string }>();
  // Last-known-good transcript per thread, updated whenever any path successfully reads
  // one (HTTP fetch, poller broadcast). Used as a fallback when `appServer.readTranscript`
  // is slow or upstream Codex is degraded — we'd rather return slightly stale data fast
  // than block long enough for the cloudflared tunnel to cancel the request.
  const transcriptCache = new Map<string, ThreadTranscript>();
  const liveSubscribedThreadIds = new Set<string>();
  // Codex's desktop "New chat" is a draft until the first user message. `thread/start`
  // returns an id immediately, but the thread may not appear in the normal session list
  // and transcript reads can say "not materialized yet" until that first turn exists.
  const draftThreads = new Map<string, Thread>();
  const desktopInterestUntilByThread = new Map<string, number>();
  const manualOpenInFlight = new Map<string, Promise<{ ok: boolean; error?: string }>>();
  const lastManualOpenAtByThread = new Map<string, number>();
  const agentPulseOwnedTurnKeys = new Set<string>();
  const completedDesktopRefreshTurnKeys = new Set<string>();
  const completedTranscriptTurnKeys = new Set<string>();
  const lastAutoRefreshAtByThread = new Map<string, number>();
  let pendingAutoDesktopRefresh: DesktopRefreshCandidate | undefined;
  let autoDesktopRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let autoDesktopRefreshInFlight = false;
  let currentSettings = options.settings;
  const isProviderEnabled = (provider: AgentProvider): boolean =>
    normalizeEnabledProviders(currentSettings.enabledProviders).includes(provider);
  const providerForThreadId = (threadId: string): AgentProvider =>
    isClaudeThreadId(threadId) ? 'claude-code' : 'codex';
  const disabledProviderResponse = (context: Context, provider: AgentProvider) =>
    context.json(
      { error: `${provider === 'claude-code' ? 'Claude' : 'Codex'} is turned off in Agent Pulse settings.` },
      403
    );
  const remoteActivity: RemoteActivityLogEntry[] = [];
  const recordRemoteActivity = (
    input: Omit<RemoteActivityLogEntry, 'id' | 'createdAt'>
  ): void => {
    const entry = RemoteActivityLogEntrySchema.parse({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    });
    remoteActivity.unshift(entry);
    remoteActivity.splice(100);
  };
  const requestIp = (context: Context): string =>
    clientIp(context.req.raw, getConnInfo(context).remote.address, currentSettings);
  const authenticate = async (context: Context) => {
    const auth = await requireAuth(context.req.raw, options.registry);
    if (!auth.ok && isPublicRemoteRequest(context.req.raw, currentSettings)) {
      recordRemoteActivity({
        type: 'auth_failure',
        sourceIp: requestIp(context),
        reason: auth.reason
      });
    }
    return auth;
  };
  const adminLoginLimiter = new RateLimiter({
    maxAttempts: 5,
    windowMs: 10 * 60 * 1000,
    blockMs: 60 * 60 * 1000
  });
  const adminLoginGlobalLimiter = new RateLimiter({
    maxAttempts: 12,
    windowMs: 10 * 60 * 1000,
    blockMs: 60 * 60 * 1000
  });
  const unauthenticatedRemoteLimiter = new RateLimiter({
    maxAttempts: 60,
    windowMs: 1000,
    blockMs: 10 * 1000
  });
  const authenticatedRemoteLimiter = new RateLimiter({
    maxAttempts: 120,
    windowMs: 1000,
    blockMs: 10 * 1000
  });
  const ensureAppServerLiveSubscription = async (threadId: string): Promise<void> => {
    if (!options.appServer?.subscribeThread || liveSubscribedThreadIds.has(threadId)) {
      return;
    }
    liveSubscribedThreadIds.add(threadId);
    try {
      await options.appServer.subscribeThread(threadId);
    } catch (error) {
      liveSubscribedThreadIds.delete(threadId);
      debugLog('[server] app-server live subscribe failed', {
        threadId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
  const completedTurnKey = (threadId: string, turnId: string): string => `${threadId}:${turnId}`;
  const markDesktopInterest = (threadId: string): void => {
    desktopInterestUntilByThread.set(threadId, Date.now() + DESKTOP_INTEREST_TTL_MS);
  };
  const hasDesktopInterest = (threadId: string): boolean => {
    const expiresAt = desktopInterestUntilByThread.get(threadId);
    if (!expiresAt) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      desktopInterestUntilByThread.delete(threadId);
      return false;
    }
    return true;
  };
  const openThreadWithMiniRefresh = async (threadId: string): Promise<{ ok: boolean; error?: string }> => {
    const now = Date.now();
    const lastManualOpenAt = lastManualOpenAtByThread.get(threadId) ?? 0;
    if (hasDesktopInterest(threadId) && now - lastManualOpenAt < MANUAL_OPEN_COOLDOWN_MS) {
      return { ok: true };
    }

    const existing = manualOpenInFlight.get(threadId);
    if (existing) {
      return existing;
    }

    const opening = options.opener
      .openThread(threadId, { refreshMode: 'mini-window' })
      .then((result) => {
        if (result.ok) {
          markDesktopInterest(threadId);
          lastManualOpenAtByThread.set(threadId, Date.now());
        }
        return result;
      })
      .finally(() => {
        manualOpenInFlight.delete(threadId);
      });
    manualOpenInFlight.set(threadId, opening);
    return opening;
  };
  const rememberAgentPulseTurn = (threadId: string, turnId: string, mode: ThreadMessageResponse['mode']): void => {
    if (mode === 'start') {
      agentPulseOwnedTurnKeys.add(completedTurnKey(threadId, turnId));
    }
  };
  const isEligibleForAutoDesktopRefresh = (candidate: DesktopRefreshCandidate): boolean => {
    if (!hasDesktopInterest(candidate.threadId)) {
      return false;
    }
    const lastRefreshAt = lastAutoRefreshAtByThread.get(candidate.threadId) ?? 0;
    return Date.now() - lastRefreshAt >= AUTO_DESKTOP_REFRESH_COOLDOWN_MS;
  };
  const drainAutoDesktopRefreshQueue = async (): Promise<void> => {
    if (autoDesktopRefreshInFlight) {
      return;
    }
    autoDesktopRefreshInFlight = true;
    try {
      while (pendingAutoDesktopRefresh) {
        const candidate = pendingAutoDesktopRefresh;
        pendingAutoDesktopRefresh = undefined;
        if (!isEligibleForAutoDesktopRefresh(candidate)) {
          continue;
        }
        const codexFrontmost = await options.opener.isCodexFrontmost?.().catch(() => false);
        if (codexFrontmost) {
          continue;
        }
        const result = await options.opener.openThread(candidate.threadId, { refreshMode: 'mini-window' });
        if (result.ok) {
          lastAutoRefreshAtByThread.set(candidate.threadId, Date.now());
        }
      }
    } finally {
      autoDesktopRefreshInFlight = false;
      if (pendingAutoDesktopRefresh) {
        void drainAutoDesktopRefreshQueue();
      }
    }
  };
  const scheduleAutoDesktopRefresh = (candidate: DesktopRefreshCandidate): void => {
    pendingAutoDesktopRefresh = candidate;
    if (autoDesktopRefreshTimer) {
      clearTimeout(autoDesktopRefreshTimer);
    }
    autoDesktopRefreshTimer = setTimeout(() => {
      autoDesktopRefreshTimer = undefined;
      void drainAutoDesktopRefreshQueue();
    }, AUTO_DESKTOP_REFRESH_SETTLE_MS);
  };
  const handleAppServerTurnCompleted = (candidate: DesktopRefreshCandidate): void => {
    const key = completedTurnKey(candidate.threadId, candidate.turnId);
    if (!completedTranscriptTurnKeys.has(key)) {
      completedTranscriptTurnKeys.add(key);
      void broadcastFreshTranscript(candidate.threadId);
    }
    if (!agentPulseOwnedTurnKeys.delete(key)) {
      return;
    }
    if (completedDesktopRefreshTurnKeys.has(key)) {
      return;
    }
    if (!hasDesktopInterest(candidate.threadId)) {
      return;
    }
    completedDesktopRefreshTurnKeys.add(key);
    scheduleAutoDesktopRefresh(candidate);
  };
  const forgetThread = (threadId: string): void => {
    transcriptCache.delete(threadId);
    liveSubscribedThreadIds.delete(threadId);
    draftThreads.delete(threadId);
    desktopInterestUntilByThread.delete(threadId);
    lastManualOpenAtByThread.delete(threadId);
    lastAutoRefreshAtByThread.delete(threadId);
    pendingModelOverrides.delete(threadId);
    for (const key of [...agentPulseOwnedTurnKeys]) {
      if (key.startsWith(`${threadId}:`)) {
        agentPulseOwnedTurnKeys.delete(key);
      }
    }
    for (const key of [...completedDesktopRefreshTurnKeys]) {
      if (key.startsWith(`${threadId}:`)) {
        completedDesktopRefreshTurnKeys.delete(key);
      }
    }
    for (const key of [...completedTranscriptTurnKeys]) {
      if (key.startsWith(`${threadId}:`)) {
        completedTranscriptTurnKeys.delete(key);
      }
    }
    if (pendingAutoDesktopRefresh?.threadId === threadId) {
      pendingAutoDesktopRefresh = undefined;
    }
  };
  const listCodexThreads = async (): Promise<Thread[]> =>
    mergeDraftThreads(
      await reconcileThreadStatuses(
        await options.threadProvider.listThreads(),
        options.appServer,
        options.mirror,
        transformTranscript
      ),
      draftThreads
    );
  const listAllThreads = async (): Promise<Thread[]> => {
    const [codexThreads, claudeThreads] = await Promise.all([
      isProviderEnabled('codex') ? listCodexThreads() : Promise.resolve([]),
      isProviderEnabled('claude-code') ? options.claudeCode?.listThreads?.() ?? Promise.resolve([]) : Promise.resolve([])
    ]);
    return [...codexThreads, ...claudeThreads];
  };
  const listAllProjects = async (): Promise<Project[]> => {
    const [codexProjects, claudeProjects] = await Promise.all([
      isProviderEnabled('codex') ? listProjects(options.threadProvider) : Promise.resolve([]),
      isProviderEnabled('claude-code') ? options.claudeCode?.listProjects?.() ?? Promise.resolve([]) : Promise.resolve([])
    ]);
    return mergeProjectsByPath([...codexProjects, ...claudeProjects]);
  };
  const broadcastFreshTranscript = async (threadId: string): Promise<void> => {
    if (!options.appServer?.readTranscript) {
      return;
    }
    const transcript = await Promise.resolve(options.appServer.readTranscript(threadId)).catch(
      () => undefined
    );
    if (!transcript) {
      return;
    }
    const visibleTranscript = transformTranscript(transcript, threadId);
    hub.broadcast({ type: 'thread/transcript/changed', payload: visibleTranscript });
  };

  app.use('*', async (context, next) => {
    const ip = requestIp(context);
    if (!isAllowedOrigin(context.req.raw, currentSettings)) {
      recordRemoteActivity({
        type: 'origin_reject',
        sourceIp: ip,
        reason: context.req.raw.headers.get('origin') ?? 'missing origin'
      });
      return context.json({ error: 'Origin is not allowed.' }, 403);
    }
    if (isPublicRemoteRequest(context.req.raw, currentSettings)) {
      const token = bearerToken(context.req.raw);
      const limiter = token ? authenticatedRemoteLimiter : unauthenticatedRemoteLimiter;
      const key = token ? `token:${token}` : `ip:${ip}`;
      if (limiter.isBlocked(key) || !limiter.recordFailure(key)) {
        recordRemoteActivity({
          type: 'rate_limit',
          sourceIp: ip,
          reason: token ? 'authenticated token limit' : 'unauthenticated IP limit'
        });
        return context.json({ error: 'Too many requests. Try again later.' }, 429);
      }
    }
    await next();
  });

  app.get('/health/get', (context) => {
    return context.json(healthPayload(options, startedAt));
  });
  app.get('/health', (context) => {
    return context.json(healthPayload(options, startedAt));
  });

  app.get('/device/options', async (context) => {
    if (isPublicRemoteRequest(context.req.raw, currentSettings)) {
      return context.json(PairingDeviceListResponseSchema.parse({ devices: [] }));
    }

    const devices = await options.registry.listActivePublicDevices();
    return context.json(
      PairingDeviceListResponseSchema.parse({
        devices: devices.map(({ deviceId, deviceName, lastSeenAt }) => ({
          deviceId,
          deviceName,
          ...(lastSeenAt ? { lastSeenAt } : {})
        }))
      })
    );
  });

  app.get('/assets/codex-template.png', async (context) => {
    try {
      const icon = await readFile('/Applications/Codex.app/Contents/Resources/codexTemplate@2x.png');
      return new Response(icon, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=3600'
        }
      });
    } catch {
      return context.notFound();
    }
  });

  app.get('/assets/codex-icon.png', async (context) => {
    try {
      const icon = await loadCodexAppIcon();
      return new Response(new Uint8Array(icon), {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400'
        }
      });
    } catch {
      return context.notFound();
    }
  });

  app.get('/attachments/:token', async (context) => {
    const attachment = localAttachments.get(context.req.param('token'));
    if (!attachment || attachment.expiresAt < Date.now()) {
      return context.notFound();
    }

    try {
      const image = await readFile(attachment.sourcePath);
      return new Response(image, {
        headers: {
          'content-type': attachment.contentType,
          'cache-control': 'private, max-age=300'
        }
      });
    } catch {
      return context.notFound();
    }
  });

  app.post('/device/pair', async (context) => {
    const ip = requestIp(context);
    const parsed = PairRequestSchema.parse(await context.req.json());
    const paired = await options.pairing
      .exchangePin({
        ...parsed,
        ip
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Pairing failed.';
        const status = message.startsWith('Too many') ? 429 : 400;
        return context.json({ error: message }, status);
      });

    if (paired instanceof Response) {
      return paired;
    }

    const { device } = paired;
    recordRemoteActivity({
      type: parsed.existingDeviceId ? 'reconnect' : 'pairing',
      deviceId: device.deviceId,
      sourceIp: ip,
      reason: parsed.existingDeviceId ? 'device reconnected' : 'device paired'
    });

    return context.json(
      PairResponseSchema.parse({
        token: device.token,
        deviceId: device.deviceId,
        deviceName: device.deviceName
      })
    );
  });

  app.post('/device/session/recover', async (context) => {
    const parsed = DeviceSessionRecoveryRequestSchema.parse(await context.req.json());
    const device = await options.registry.recoverDeviceSession(parsed.deviceId, parsed.fingerprint);

    if (!device) {
      recordRemoteActivity({
        type: 'auth_failure',
        deviceId: parsed.deviceId,
        sourceIp: requestIp(context),
        reason: 'session recovery failed'
      });
      return context.json({ error: 'invalid' }, 401);
    }

    recordRemoteActivity({
      type: 'reconnect',
      deviceId: device.deviceId,
      sourceIp: requestIp(context),
      reason: 'device session recovered'
    });

    return context.json(
      PairResponseSchema.parse({
        token: device.token,
        deviceId: device.deviceId,
        deviceName: device.deviceName
      })
    );
  });

  app.post('/admin/login', async (context) => {
    const ip = requestIp(context);
    if (
      adminLoginLimiter.isBlocked(ip) ||
      adminLoginGlobalLimiter.isBlocked(GLOBAL_ADMIN_LOGIN_LIMIT_KEY)
    ) {
      return context.json({ error: 'Too many admin login attempts. Try again later.' }, 429);
    }

    const body = (await context.req.json().catch(() => ({}))) as { passcode?: string };
    const passcode = typeof body.passcode === 'string' ? body.passcode.trim() : '';
    if (!passcode) {
      adminLoginLimiter.recordFailure(ip);
      adminLoginGlobalLimiter.recordFailure(GLOBAL_ADMIN_LOGIN_LIMIT_KEY);
      return context.json({ error: 'Admin passcode is required.' }, 400);
    }

    const ok = await options.adminAuth.verifyPasscode(passcode);
    if (!ok) {
      adminLoginLimiter.recordFailure(ip);
      adminLoginGlobalLimiter.recordFailure(GLOBAL_ADMIN_LOGIN_LIMIT_KEY);
      return context.json({ error: 'Admin passcode is invalid.' }, 401);
    }

    adminLoginLimiter.clear(ip);
    adminLoginGlobalLimiter.clear(GLOBAL_ADMIN_LOGIN_LIMIT_KEY);
    return context.json(options.adminAuth.issueToken());
  });

  app.post('/admin/logout', async (context) => {
    const token = readAdminToken(context.req.raw);
    if (token) {
      options.adminAuth.revokeToken(token);
    }
    return context.json({ ok: true });
  });

  app.post('/admin/passcode', async (context) => {
    if (!isAdminRequest(context.req.raw, options.adminAuth)) {
      return adminForbidden(context);
    }

    const body = (await context.req.json().catch(() => ({}))) as {
      currentPasscode?: string;
      nextPasscode?: string;
    };
    const currentPasscode = typeof body.currentPasscode === 'string' ? body.currentPasscode : '';
    const nextPasscode = typeof body.nextPasscode === 'string' ? body.nextPasscode : '';

    try {
      await options.adminAuth.changePasscode(
        currentPasscode,
        nextPasscode,
        readAdminToken(context.req.raw)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not change passcode.';
      return context.json({ error: message }, 400);
    }
    return context.json({ ok: true });
  });

  app.get('/settings/get', async (context) => {
    if (!isAdminRequest(context.req.raw, options.adminAuth)) {
      return adminForbidden(context);
    }

    const remoteAccess = options.remoteAccess?.getStatus() ?? currentSettings.remoteAccess;
    currentSettings = {
      ...currentSettings,
      remoteAccess
    };

    return context.json({
      settings: currentSettings,
      devices: await options.registry.listPublicDevices(),
      pairingPins: options.pairing.listPins(),
      remoteActivity
    });
  });

  app.post('/settings/remote-access/check', async (context) => {
    if (!isAdminRequest(context.req.raw, options.adminAuth)) {
      return adminForbidden(context);
    }

    const remoteAccess = await (options.remoteAccess?.check() ??
      Promise.resolve(currentSettings.remoteAccess));
    currentSettings = { ...currentSettings, remoteAccess };
    return context.json({ ok: true, remoteAccess: RemoteAccessSettingsSchema.parse(remoteAccess) });
  });

  app.post('/settings/remote-access', async (context) => {
    if (!isAdminRequest(context.req.raw, options.adminAuth)) {
      return adminForbidden(context);
    }

    const body = (await context.req.json().catch(() => ({}))) as {
      enabled?: boolean;
      mode?: RemoteAccessMode;
      tunnelProtocol?: unknown;
      hostname?: string;
      tunnelName?: string;
    };
    const tunnelProtocol = RemoteAccessProtocolSchema.catch('auto').parse(body.tunnelProtocol);
    let remoteAccess = currentSettings.remoteAccess;
    if (body.mode !== undefined || body.tunnelProtocol !== undefined || body.hostname !== undefined || body.tunnelName !== undefined) {
      remoteAccess = await (options.remoteAccess?.configure({ ...body, tunnelProtocol }) ??
        Promise.resolve({
          ...remoteAccess,
          ...(body.mode !== undefined ? { mode: body.mode === 'named' ? 'named' : 'quick' } : {}),
          ...(body.tunnelProtocol !== undefined ? { tunnelProtocol } : {}),
          ...(body.mode === 'quick' ? { hostname: '', publicUrl: '' } : {}),
          ...(body.hostname !== undefined
            ? { hostname: normalizeHostname(body.hostname), publicUrl: publicUrlForHostname(body.hostname) }
            : {}),
          ...(body.tunnelName !== undefined ? { tunnelName: body.tunnelName.trim() || 'agent-pulse' } : {})
        }));
    }
    if (typeof body.enabled === 'boolean') {
      remoteAccess = await (options.remoteAccess?.setEnabled(body.enabled) ??
        Promise.resolve({
          ...remoteAccess,
          enabled: body.enabled,
          status: body.enabled ? 'disconnected' : 'off'
        }));
    }
    currentSettings = { ...currentSettings, remoteAccess };
    return context.json({ ok: true, remoteAccess: RemoteAccessSettingsSchema.parse(remoteAccess) });
  });

  app.post('/settings/remote-access/cloudflare/login', async (context) => {
    if (!isAdminRequest(context.req.raw, options.adminAuth)) {
      return adminForbidden(context);
    }

    const remoteAccess = await (options.remoteAccess?.login() ??
      Promise.resolve(currentSettings.remoteAccess));
    currentSettings = { ...currentSettings, remoteAccess };
    return context.json({ ok: true, remoteAccess: RemoteAccessSettingsSchema.parse(remoteAccess) });
  });

  app.post('/settings/remote-access/cloudflare/configure', async (context) => {
    if (!isAdminRequest(context.req.raw, options.adminAuth)) {
      return adminForbidden(context);
    }

    const body = (await context.req.json().catch(() => ({}))) as {
      enabled?: boolean;
      mode?: RemoteAccessMode;
      tunnelProtocol?: unknown;
      hostname?: string;
      tunnelName?: string;
    };
    const remoteAccess = await (options.remoteAccess?.configure({
      ...body,
      tunnelProtocol: RemoteAccessProtocolSchema.catch('auto').parse(body.tunnelProtocol)
    }) ??
      Promise.resolve(currentSettings.remoteAccess));
    currentSettings = { ...currentSettings, remoteAccess };
    return context.json({ ok: true, remoteAccess: RemoteAccessSettingsSchema.parse(remoteAccess) });
  });

  app.post('/settings/pairing-pin', async (context) => {
    if (!isAdminRequest(context.req.raw, options.adminAuth)) {
      return adminForbidden(context);
    }

    const body = (await context.req.json().catch(() => ({}))) as { deviceId?: string };
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : undefined;

    return context.json(options.pairing.createPin({ deviceId }));
  });

  app.post('/settings/lan', async (context) => {
    if (!isAdminRequest(context.req.raw, options.adminAuth)) {
      return adminForbidden(context);
    }

    const body = (await context.req.json()) as { enabled?: boolean };
    const nextSettings: HelperSettings = {
      ...currentSettings,
      lanEnabled: Boolean(body.enabled)
    };
    currentSettings = nextSettings;
    await options.settingsStore.save(nextSettings);
    await options.onLanModeChange?.(nextSettings.lanEnabled);
    return context.json({ ok: true, settings: nextSettings });
  });

  app.post('/settings/mobile-send', async (context) => {
    if (!isAdminRequest(context.req.raw, options.adminAuth)) {
      return adminForbidden(context);
    }

    const body = (await context.req.json()) as { enabled?: boolean };
    const nextSettings: HelperSettings = {
      ...currentSettings,
      mobileSendEnabled: Boolean(body.enabled)
    };
    currentSettings = nextSettings;
    await options.settingsStore.save(nextSettings);
    return context.json({ ok: true, settings: nextSettings });
  });

  app.post('/settings/providers', async (context) => {
    if (!isAdminRequest(context.req.raw, options.adminAuth)) {
      return adminForbidden(context);
    }

    const body = (await context.req.json().catch(() => ({}))) as { enabledProviders?: unknown };
    const enabledProviders = normalizeEnabledProviders(body.enabledProviders);
    const nextSettings: HelperSettings = {
      ...currentSettings,
      enabledProviders
    };
    currentSettings = nextSettings;
    await options.settingsStore.save(nextSettings);
    return context.json({ ok: true, settings: nextSettings });
  });

  app.post('/settings/device/revoke', async (context) => {
    if (!isAdminRequest(context.req.raw, options.adminAuth)) {
      return adminForbidden(context);
    }

    const parsed = DeviceRevokeRequestSchema.parse(await context.req.json());
    await options.registry.revokeDevice(parsed.deviceId);
    hub.closeDevice(parsed.deviceId);
    recordRemoteActivity({
      type: 'revoke',
      deviceId: parsed.deviceId,
      sourceIp: requestIp(context),
      reason: 'admin revoked device'
    });
    return context.json({ ok: true });
  });

  app.get('/threads/list', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    const threads = await listAllThreads();
    return context.json(ThreadListResponseSchema.parse({ threads }));
  });

  app.get('/projects/list', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    return context.json(ProjectListResponseSchema.parse({
      projects: await listAllProjects()
    }));
  });

  // Per-thread "user has reviewed this" timestamps. The helper is the source of
  // truth so every paired device sees the same state. Entries auto-expire after
  // 14 days inside SeenThreadStore.
  app.get('/threads/seen-activity', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    const entries = options.seenThreadStore?.getAll() ?? {};
    return context.json(SeenThreadActivityResponseSchema.parse({ entries }));
  });

  app.post('/threads/seen-activity/import', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    if (!options.seenThreadStore) {
      return context.json({ error: 'Seen-activity store unavailable.' }, 503);
    }
    const parsed = SeenThreadActivityImportRequestSchema.parse(await context.req.json());
    await options.seenThreadStore.importIfMissing(parsed.entries);
    return context.json(
      SeenThreadActivityResponseSchema.parse({ entries: options.seenThreadStore.getAll() })
    );
  });

  app.post('/threads/:threadId/seen', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    if (!options.seenThreadStore) {
      return context.json({ error: 'Seen-activity store unavailable.' }, 503);
    }
    const threadId = context.req.param('threadId');
    const parsed = SeenThreadActivityMarkRequestSchema.parse(await context.req.json());
    const effectiveSeenAt = await options.seenThreadStore.markSeen(threadId, parsed.seenAt);
    if (effectiveSeenAt !== null) {
      hub.broadcast({
        type: 'thread/seen-activity/changed',
        payload: { threadId, seenAt: effectiveSeenAt }
      });
    }
    return context.json({ ok: true });
  });

  app.post('/threads/new', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    const parsed = ThreadCreateRequestSchema.parse(await context.req.json());
    if (!isProviderEnabled(parsed.provider)) {
      return disabledProviderResponse(context, parsed.provider);
    }
    if (parsed.provider === 'codex' && !options.appServer?.startThread) {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }
    if (parsed.provider === 'claude-code' && !options.claudeCode?.startThread) {
      return context.json({ error: 'Claude Code connection unavailable.' }, 503);
    }

    let cwd: string;
    if (parsed.projectId) {
      const projects = await listAllProjects();
      const project = projects.find((candidate) => candidate.projectId === parsed.projectId);
      if (!project) {
        return context.json({ error: 'Project is not available.' }, 404);
      }
      cwd = project.path;
    } else {
      cwd = normalizeRequestedCwd(parsed.cwd ?? '');
      if (!path.isAbsolute(cwd)) {
        return context.json({ error: 'Folder path must be absolute.' }, 400);
      }
    }

    try {
      const stats = await stat(cwd);
      if (!stats.isDirectory()) {
        return context.json({ error: `Folder is not a directory: ${cwd}` }, 400);
      }
    } catch (statError) {
      const message = statError instanceof Error ? statError.message : String(statError);
      return context.json(
        { error: `Cannot open folder ${cwd}: ${message}` },
        400
      );
    }

    try {
      const starter = parsed.provider === 'claude-code' ? options.claudeCode! : options.appServer!;
      const thread = await starter.startThread!(cwd, {
        ...(parsed.modelSlug ? { model: parsed.modelSlug } : {}),
        ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {})
      });
      if (parsed.provider === 'codex') {
        draftThreads.set(thread.threadId, thread);
      }
      hub.broadcast({ type: 'thread/upsert', payload: thread });
      hub.broadcast({ type: 'health/changed', payload: healthPayload(options, startedAt) });

      return context.json(ThreadCreateResponseSchema.parse({ thread }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[agent-pulse] startThread failed', { provider: parsed.provider, cwd, error: detail });
      return context.json(
        { error: `${parsed.provider === 'claude-code' ? 'Claude Code' : 'Codex'} could not start a new thread in ${cwd}: ${detail}` },
        503
      );
    }
  });

  app.get('/threads/:threadId/transcript', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    const threadId = context.req.param('threadId');
    const messageLimit = parseTranscriptMessageLimit(context.req.query('limit'));
    if (!isProviderEnabled(providerForThreadId(threadId))) {
      return disabledProviderResponse(context, providerForThreadId(threadId));
    }
    if (isClaudeThreadId(threadId)) {
      if (!options.claudeCode) {
        return context.json({ error: 'Claude Code connection unavailable.' }, 503);
      }
      try {
        const transcript = await options.claudeCode.readTranscript(threadId);
        return context.json(
          ThreadTranscriptSchema.parse(limitTranscriptMessages(transcript, messageLimit))
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return context.json({ error: `Claude Code transcript unavailable: ${detail}` }, 503);
      }
    }

    if (!options.appServer) {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }

    await settleWithin(ensureAppServerLiveSubscription(threadId), 750);

    // Race the live transcript read against a short timeout. When Codex's app-server is
    // healthy this resolves in milliseconds; when it's degraded (mcp transport flapping,
    // chatgpt.com 503ing) it can hang for tens of seconds. Rather than block long enough
    // for cloudflared to cancel the stream, fall back to the last-known-good transcript
    // cached either by an earlier successful fetch or the background poller.
    const TRANSCRIPT_READ_TIMEOUT_MS = 5_000;
    const liveResult = await settleWithin(
      options.appServer.readTranscript(threadId).catch(() => undefined),
      TRANSCRIPT_READ_TIMEOUT_MS
    );

    let transcript: ThreadTranscript | undefined;
    let stale = false;
    if (liveResult.ok && liveResult.value) {
      transcript = liveResult.value;
    } else {
      transcript = transcriptCache.get(threadId);
      stale = true;
    }

    if (!transcript) {
      transcript = draftThreads.has(threadId) ? emptyDraftTranscript(threadId) : undefined;
    }

    if (!transcript) {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }

    try {
      const usage = options.usageProvider
        ? await options.usageProvider(threadId).catch(() => undefined)
        : undefined;
      hub.broadcast({ type: 'health/changed', payload: healthPayload(options, startedAt) });
      if (stale) {
        // Hint to the client that the body is from cache. Headers stay out of the zod
        // schema so we don't have to thread a flag through every transcript shape.
        context.header('X-Transcript-Stale', '1');
      }
      const visibleTranscript = transformTranscript(
        limitTranscriptMessages(transcript, messageLimit),
        threadId
      );
      return context.json(
        ThreadTranscriptSchema.parse({
          ...visibleTranscript,
          ...(usage ? { usage } : {})
        })
      );
    } catch {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }
  });

  // Lazy-loading older history. The main GET /transcript endpoint always returns the tail
  // of the conversation (last `limit` messages). When the user scrolls up past what's
  // already on screen, the tablet hits this endpoint with the id of its current oldest
  // message; we return up to `limit` messages strictly before that one, plus a `hasMore`
  // flag so the client knows whether to keep offering more.
  app.get('/threads/:threadId/transcript/older', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    const before = context.req.query('before');
    if (!before) {
      return context.json({ error: 'Missing required `before` query param.' }, 400);
    }

    try {
      const threadId = context.req.param('threadId');
      if (!isProviderEnabled(providerForThreadId(threadId))) {
        return disabledProviderResponse(context, providerForThreadId(threadId));
      }
      const limit = parseTranscriptMessageLimit(context.req.query('limit')) ?? 40;
      if (isClaudeThreadId(threadId)) {
        if (!options.claudeCode) {
          return context.json({ error: 'Claude Code connection unavailable.' }, 503);
        }
        const transcript = await (options.claudeCode.readFullTranscript?.(threadId) ??
          options.claudeCode.readTranscript(threadId));
        const beforeIndex = transcript.messages.findIndex((message) => message.id === before);
        if (beforeIndex <= 0) {
          return context.json(
            OlderThreadMessagesResponseSchema.parse({ threadId, messages: [], hasMore: false })
          );
        }
        const sliceStart = Math.max(0, beforeIndex - limit);
        return context.json(
          OlderThreadMessagesResponseSchema.parse({
            threadId,
            messages: transcript.messages.slice(sliceStart, beforeIndex),
            hasMore: sliceStart > 0
          })
        );
      }

      if (!options.appServer) {
        return context.json({ error: 'Codex connection unavailable.' }, 503);
      }

      // Same fallback strategy as the main transcript route — race the live read against
      // a short timeout, fall back to cache. Older history rarely changes, so a cached
      // transcript almost always serves the right window.
      const TRANSCRIPT_READ_TIMEOUT_MS = 5_000;
      const readOlderTranscript =
        options.appServer.readFullTranscript?.bind(options.appServer) ??
        options.appServer.readTranscript.bind(options.appServer);
      const liveResult = await settleWithin(
        readOlderTranscript(threadId).catch((error) => {
          debugLog('server', 'failed to read older transcript', {
            threadId,
            error: error instanceof Error ? error.message : String(error)
          });
          return undefined;
        }),
        TRANSCRIPT_READ_TIMEOUT_MS
      );

      let transcript: ThreadTranscript | undefined;
      if (liveResult.ok && liveResult.value) {
        transcript = liveResult.value;
        transcriptCache.set(threadId, transcript);
      } else {
        transcript = transcriptCache.get(threadId);
      }

      if (!transcript) {
        transcript = draftThreads.has(threadId) ? emptyDraftTranscript(threadId) : undefined;
      }

      if (!transcript) {
        return context.json({ error: 'Codex connection unavailable.' }, 503);
      }

      const beforeIndex = transcript.messages.findIndex((message) => message.id === before);
      if (beforeIndex <= 0) {
        // Either the cursor message wasn't found (already fell out of the buffer, or never
        // existed) or it's already the oldest message — either way, no older history.
        return context.json(
          OlderThreadMessagesResponseSchema.parse({
            threadId,
            messages: [],
            hasMore: false
          })
        );
      }

      const sliceStart = Math.max(0, beforeIndex - limit);
      const olderSlice = transcript.messages.slice(sliceStart, beforeIndex);
      const exposed = exposeLocalAttachments(
        ThreadTranscriptSchema.parse({ ...transcript, messages: olderSlice }),
        threadId,
        localAttachments
      );

      return context.json(
        OlderThreadMessagesResponseSchema.parse({
          threadId,
          messages: exposed.messages,
          hasMore: sliceStart > 0
        })
      );
    } catch {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }
  });

  app.post('/threads/:threadId/messages', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    if (!currentSettings.mobileSendEnabled) {
      return context.json({ error: 'Mobile sending is off on the Mac.' }, 403);
    }

    const parsed = ThreadMessageRequestSchema.parse(await context.req.json());

    try {
      const threadId = context.req.param('threadId');
      if (!isProviderEnabled(providerForThreadId(threadId))) {
        return disabledProviderResponse(context, providerForThreadId(threadId));
      }
      if (isClaudeThreadId(threadId)) {
        if (!options.claudeCode) {
          return context.json({ error: 'Claude Code connection unavailable.' }, 503);
        }
        const override = pendingModelOverrides.get(threadId);
        const result = ThreadMessageResponseSchema.parse(
          await options.claudeCode.sendMessage(threadId, parsed.text, {
            ...(override ? { model: override.model } : {}),
            ...(override?.effort ? { effort: override.effort } : {}),
            ...(parsed.collaborationMode ? { collaborationMode: parsed.collaborationMode } : {})
          })
        );
        if (override) {
          pendingModelOverrides.delete(threadId);
        }
        hub.broadcast({ type: 'thread/transcript/changed', payload: result.transcript });
        hub.broadcast({ type: 'health/changed', payload: healthPayload(options, startedAt) });
        return context.json(result);
      }

      await options.appServer?.ensureConnected?.().catch(() => undefined);
      const mirrorReady = options.mirror?.isConnected() === true;
      if (!mirrorReady) {
        return context.json(
          { error: 'Codex desktop is not connected. Open Codex on this Mac to send.' },
          503
        );
      }

      // Slash commands the Codex desktop intercepts client-side. Sending the
      // raw text "/compact" as a turn would just be a literal user message;
      // instead we route to the matching v2 RPC so the actual command runs.
      const slashCommand = matchBareSlashCommand(parsed.text);
      if (slashCommand) {
        const handled = await handleSlashCommand(
          slashCommand,
          parsed.text,
          threadId,
          options.appServer,
          hub
        );
        if (handled) {
          return context.json(handled);
        }
      }

      // Single source of truth for sends: the IPC mirror to the running
      // Codex desktop window. The desktop forwards turn/start to its own
      // app-server, so the message appears live in the desktop UI (same
      // diff view, same model picker animation). We pass collaborationMode
      // and any queued model/effort override through so plan mode and
      // model selection apply on the desktop window.
      const override = pendingModelOverrides.get(threadId);
      const mirrorSendOptions =
        override || parsed.collaborationMode
          ? {
              ...(override ? { model: override.model } : {}),
              ...(override?.effort ? { effort: override.effort } : {}),
              ...(parsed.collaborationMode ? { collaborationMode: parsed.collaborationMode } : {})
            }
          : undefined;
      const result = ThreadMessageResponseSchema.parse(
        await runWithFollowerOwnership(
          () => options.mirror!.sendMessage(threadId, parsed.text, mirrorSendOptions),
          options.opener,
          threadId,
          options.mirror
        )
      );

      rememberAgentPulseTurn(threadId, result.turnId, result.mode);

      // Once the message is on the wire, the override has effectively been delivered.
      if (override) {
        pendingModelOverrides.delete(threadId);
      }
      const visibleTranscript = transformTranscript(result.transcript, threadId);
      const response = {
        ...result,
        transcript: visibleTranscript
      };
      const parsedResponse = ThreadMessageResponseSchema.parse(response);
      transcriptCache.set(threadId, parsedResponse.transcript);
      const draftThread = draftThreads.get(threadId);
      if (draftThread) {
        const nextDraftThread = updateDraftThreadFromTranscript(draftThread, parsedResponse.transcript);
        draftThreads.set(threadId, nextDraftThread);
        hub.broadcast({ type: 'thread/upsert', payload: nextDraftThread });
      }
      hub.broadcast({
        type: 'thread/transcript/changed',
        payload: parsedResponse.transcript
      });
      hub.broadcast({ type: 'health/changed', payload: healthPayload(options, startedAt) });
      return context.json(parsedResponse);
    } catch (error) {
      if (error instanceof SendBlockedError) {
        return context.json({ error: error.message, reason: error.reason }, 409);
      }
      // Log the underlying failure — without this, the tablet only sees the
      // generic 503 below and we lose the codex stderr / params that explain
      // *why* the send failed.
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[send] threadId=%s failed:', context.req.param('threadId'), detail);
      return context.json({ error: `Codex send failed: ${detail}` }, 503);
    }
  });

  app.post('/threads/:threadId/stop', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    const threadId = context.req.param('threadId');
    if (!isProviderEnabled(providerForThreadId(threadId))) {
      return disabledProviderResponse(context, providerForThreadId(threadId));
    }
    if (isClaudeThreadId(threadId)) {
      if (!options.claudeCode?.interruptTurn) {
        return context.json({ error: 'Claude Code connection unavailable.' }, 503);
      }
      await options.claudeCode.interruptTurn(threadId);
      hub.broadcast({ type: 'thread/streaming-changed', payload: { threadId, isStreaming: false } });
      hub.broadcast({ type: 'thread/status/changed', payload: { threadId, status: 'idle' } });
      return context.json(ThreadStopResponseSchema.parse({ ok: true }));
    }

    await options.appServer?.ensureConnected?.().catch(() => undefined);
    if (!options.appServer?.isConnected() || !options.appServer.interruptTurn) {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }

    // If Codex is currently waiting on a user-input or approval request, the
    // turn is "active but blocked" — turn/interrupt would either no-op or get
    // queued behind the response. Decline the pending requests first so Codex
    // unblocks itself; this is enough to put a `requestUserInput` thread back
    // into idle. Best-effort: failures here don't prevent the interrupt.
    if (options.mirror?.getPendingApprovalRequests && options.mirror.respondToApproval) {
      const pending = options.mirror.getPendingApprovalRequests(threadId);
      for (const request of pending) {
        // Empty answers map / cancel / decline — these all tell Codex "the user
        // is opting out", which lets it abort the turn cleanly.
        const declineResponse: unknown =
          request.method === 'item/tool/requestUserInput'
            ? { answers: {} }
            : request.method === 'mcpServer/elicitation/request'
              ? { action: 'cancel', content: null, _meta: null }
              : 'decline';
        try {
          // Wrap in runWithFollowerOwnership so the helper opens / waits for
          // desktop ownership of the thread before sending the decline. Without
          // this, follower IPC fails with `thread_unavailable` for unowned
          // threads, the pre-decline is skipped, and turn/interrupt then queues
          // behind the unresolved approval — leaving Stop ineffective.
          await runWithFollowerOwnership(
            () =>
              options.mirror!.respondToApproval!(
                threadId,
                request.id,
                request.method,
                declineResponse
              ),
            options.opener,
            threadId,
            options.mirror
          );
        } catch (declineError) {
          debugLog('[stop] failed to decline pending request before interrupting', {
            threadId,
            requestId: request.id,
            method: request.method,
            error: declineError instanceof Error ? declineError.message : String(declineError)
          });
        }
      }
    }

    try {
      await options.appServer.interruptTurn(threadId);
      hub.broadcast({
        type: 'thread/streaming-changed',
        payload: { threadId, isStreaming: false }
      });
      return context.json(ThreadStopResponseSchema.parse({ ok: true }));
    } catch (error) {
      if (error instanceof SendBlockedError) {
        if (error.reason === 'missing_active_turn') {
          // Codex says no turn is running — that's fine, the pending decline
          // above already unblocked the thread. Surface success so the tablet
          // clears the spinner and the stop button.
          hub.broadcast({
            type: 'thread/streaming-changed',
            payload: { threadId, isStreaming: false }
          });
          hub.broadcast({
            type: 'thread/status/changed',
            payload: { threadId, status: 'idle' }
          });
          return context.json(ThreadStopResponseSchema.parse({ ok: true }));
        }
        return context.json({ error: error.message, reason: error.reason }, 409);
      }
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }
  });

  app.delete('/threads/:threadId', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    const threadId = context.req.param('threadId');
    if (!isProviderEnabled(providerForThreadId(threadId))) {
      return disabledProviderResponse(context, providerForThreadId(threadId));
    }
    if (isClaudeThreadId(threadId)) {
      return context.json({ error: 'Deleting Claude Code history is not supported yet.' }, 405);
    }

    await options.appServer?.ensureConnected?.().catch(() => undefined);
    if (!options.appServer?.isConnected() || !options.appServer.archiveThread) {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }

    try {
      // archiveThread emits a `thread/remove` live event; the appServer
      // onLiveEvent listener (set up below) re-broadcasts that to clients,
      // so we don't broadcast it explicitly here to avoid duplicate events.
      await options.appServer.archiveThread(threadId);
      forgetThread(threadId);
      return context.json(ThreadDeleteResponseSchema.parse({ ok: true }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return context.json({ error: `Codex could not delete this thread: ${detail}` }, 503);
    }
  });

  app.post('/thread/open', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ ok: false, error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    const parsed = ThreadOpenRequestSchema.parse(await context.req.json());
    if (!isProviderEnabled(providerForThreadId(parsed.threadId))) {
      return context.json({ ok: false, error: `${providerForThreadId(parsed.threadId) === 'claude-code' ? 'Claude' : 'Codex'} is turned off in Agent Pulse settings.` }, 403);
    }
    if (isClaudeThreadId(parsed.threadId)) {
      return context.json({ ok: false, error: 'Claude Code chats are controlled directly in Agent Pulse.' }, 405);
    }
    const result = await openThreadWithMiniRefresh(parsed.threadId);
    if (!result.ok) {
      return context.json(result, 503);
    }
    return context.json(result);
  });

  app.post('/device/revoke', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ ok: false }, auth.reason === 'revoked' ? 403 : 401);
    }

    const parsed = DeviceRevokeRequestSchema.parse(await context.req.json());
    await options.registry.revokeDevice(parsed.deviceId);
    hub.closeDevice(parsed.deviceId);
    recordRemoteActivity({
      type: 'revoke',
      deviceId: parsed.deviceId,
      sourceIp: requestIp(context),
      reason: 'device requested revoke'
    });
    return context.json({ ok: true });
  });

  app.get('/catalog/plugins', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    const plugins = options.catalog ? await options.catalog.listPlugins() : [];
    return context.json(CatalogPluginsResponseSchema.parse({ plugins }));
  });

  app.get('/catalog/plugins/:slug/icon', async (context) => {
    if (!options.catalog) {
      return context.notFound();
    }
    const slug = decodeURIComponent(context.req.param('slug'));
    const iconPath = options.catalog.resolvePluginIconPath(slug);
    if (!iconPath) {
      return context.notFound();
    }
    try {
      const buffer = await readFile(iconPath);
      return new Response(new Uint8Array(buffer), {
        headers: {
          'content-type': imageContentType(iconPath),
          'cache-control': 'public, max-age=86400'
        }
      });
    } catch {
      return context.notFound();
    }
  });

  app.get('/catalog/skills/:slug/icon', async (context) => {
    if (!options.catalog) {
      return context.notFound();
    }
    const slug = decodeURIComponent(context.req.param('slug'));
    const iconPath = options.catalog.resolveSkillIconPath(slug);
    if (!iconPath) {
      return context.notFound();
    }
    try {
      const buffer = await readFile(iconPath);
      return new Response(new Uint8Array(buffer), {
        headers: {
          'content-type': imageContentType(iconPath),
          'cache-control': 'public, max-age=86400'
        }
      });
    } catch {
      return context.notFound();
    }
  });

  app.get('/catalog/skills', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    const skills = options.catalog ? await options.catalog.listSkills() : [];
    return context.json(CatalogSkillsResponseSchema.parse({ skills }));
  });

  app.get('/catalog/commands', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    const commands = options.catalog ? await options.catalog.listCommands() : [];
    return context.json(CatalogCommandsResponseSchema.parse({ commands }));
  });

  app.get('/catalog/models', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    const catalogModels = options.catalog ? await options.catalog.listModels().catch(() => []) : [];
    const appServerModels = options.appServer?.listModels
      ? await options.appServer.listModels().catch(() => [])
      : [];
    const models =
      appServerModels.length > 0
        ? mergeModelCatalogMetadata(appServerModels, catalogModels)
        : catalogModels;
    const claudeModels = options.claudeCode?.listModels
      ? await options.claudeCode.listModels().catch(() => [])
      : [];
    return context.json(
      CatalogModelsResponseSchema.parse({
        models: [
          ...(isProviderEnabled('codex') ? models : []),
          ...(isProviderEnabled('claude-code') ? claudeModels : [])
        ]
      })
    );
  });

  app.get('/projects/:projectId/files', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    if (!options.catalog) {
      return context.json(ProjectFilesResponseSchema.parse({ files: [], truncated: false }));
    }
    const projects = await listAllProjects();
    const project = projects.find(
      (candidate) => candidate.projectId === context.req.param('projectId')
    );
    if (!project) {
      return context.json({ error: 'Project is not available.' }, 404);
    }
    const query = context.req.query('q') ?? '';
    const limitRaw = Number(context.req.query('limit') ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;
    try {
      const result = await options.catalog.listProjectFiles(project.path, query, limit);
      return context.json(ProjectFilesResponseSchema.parse(result));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return context.json({ error: `Could not list files: ${detail}` }, 500);
    }
  });

  // GET the current set of approval requests the Codex desktop IPC mirror sees.
  // This is the same source that renders the approval card in the actual Codex chat.
  app.get('/threads/:threadId/pending-approvals', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    const threadId = context.req.param('threadId');
    if (!isProviderEnabled(providerForThreadId(threadId))) {
      return disabledProviderResponse(context, providerForThreadId(threadId));
    }
    const requests = isClaudeThreadId(threadId)
      ? options.claudeCode?.getPendingApprovalRequests?.(threadId) ?? []
      : options.mirror?.getPendingApprovalRequests?.(threadId) ?? [];
    return context.json({ threadId, requests });
  });

  app.post('/threads/:threadId/approvals/:requestId', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    const parsed = ApprovalDecisionRequestSchema.parse(await context.req.json());
    const threadId = context.req.param('threadId');
    const requestId = context.req.param('requestId');
    if (!isProviderEnabled(providerForThreadId(threadId))) {
      return disabledProviderResponse(context, providerForThreadId(threadId));
    }
    if (isClaudeThreadId(threadId)) {
      if (!options.claudeCode?.respondToApproval) {
        return context.json({ error: 'Claude Code is not available to respond to approvals.' }, 503);
      }
      try {
        await options.claudeCode.respondToApproval(threadId, requestId, parsed.method, parsed.decision);
        return context.json(ApprovalDecisionResponseSchema.parse({ ok: true }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return context.json({ error: `Could not record Claude approval: ${detail}` }, 503);
      }
    }
    if (!options.mirror?.respondToApproval || !options.mirror.isConnected()) {
      return context.json(
        { error: 'Codex desktop IPC is not available to respond to approvals.' },
        503
      );
    }
    try {
      await runWithFollowerOwnership(
        () =>
          options.mirror!.respondToApproval!(
            threadId,
            requestId,
            parsed.method,
            parsed.decision
          ),
        options.opener,
        threadId,
        options.mirror
      );
      return context.json(ApprovalDecisionResponseSchema.parse({ ok: true }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = error instanceof SendBlockedError ? 409 : 503;
      return context.json({ error: `Could not record approval: ${detail}` }, status);
    }
  });

  app.post('/threads/:threadId/model', async (context) => {
    const threadId = context.req.param('threadId');
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    const parsed = ThreadModelUpdateRequestSchema.parse(await context.req.json());
    if (!isProviderEnabled(providerForThreadId(threadId))) {
      return disabledProviderResponse(context, providerForThreadId(threadId));
    }
    if (isClaudeThreadId(threadId)) {
      try {
        if (options.claudeCode?.setModel) {
          await options.claudeCode.setModel(threadId, parsed.modelSlug, parsed.reasoningEffort);
          pendingModelOverrides.delete(threadId);
        } else {
          pendingModelOverrides.set(threadId, {
            model: parsed.modelSlug,
            ...(parsed.reasoningEffort ? { effort: parsed.reasoningEffort } : {})
          });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return context.json({ error: detail }, detail.includes('still working') ? 409 : 503);
      }
      return context.json(
        ThreadModelUpdateResponseSchema.parse({
          ok: true,
          modelSlug: parsed.modelSlug,
          ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {})
        })
      );
    }

    // Single source of truth: drive the change through the IPC follower so
    // the desktop window shows the same "GPT-5.5 -> {selected}" model picker
    // animation as Shift+Tab in the local Codex window.
    // runWithFollowerOwnership opens the thread on the Mac if Codex desktop
    // doesn't already own it, then waits for the ownership broadcast before
    // sending. Errors propagate as 503 so the tablet's model chip rolls back.
    if (!options.mirror?.setModelAndReasoning || !options.mirror.isConnected()) {
      return context.json(
        { error: 'Codex desktop is not connected. Open Codex on this Mac to change the model.' },
        503
      );
    }
    try {
      await runWithFollowerOwnership(
        () =>
          options.mirror!.setModelAndReasoning!(
            threadId,
            parsed.modelSlug,
            parsed.reasoningEffort
          ),
        options.opener,
        threadId,
        options.mirror
      );
      pendingModelOverrides.delete(threadId);
      debugLog('[model-change] applied live via IPC', {
        threadId,
        modelSlug: parsed.modelSlug,
        reasoningEffort: parsed.reasoningEffort
      });
    } catch (error) {
      console.error('[model-change] live IPC path failed', {
        threadId,
        error: error instanceof Error ? error.message : String(error)
      });
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Could not change model on Codex desktop.'
        },
        503
      );
    }

    return context.json(
      ThreadModelUpdateResponseSchema.parse({
        ok: true,
        modelSlug: parsed.modelSlug,
        ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {})
      })
    );
  });

  if (tabletDevProxy) {
    const killSwitchSW = [
      "self.addEventListener('install', () => self.skipWaiting());",
      "self.addEventListener('activate', (event) => {",
      "  event.waitUntil((async () => {",
      "    const keys = await caches.keys();",
      "    await Promise.all(keys.map((key) => caches.delete(key)));",
      "    await self.registration.unregister();",
      "    const clientList = await self.clients.matchAll();",
      "    clientList.forEach((client) => client.navigate(client.url));",
      "  })());",
      "});"
    ].join('\n');
    const swPaths = ['/sw.js', '/registerSW.js', '/dev-sw.js'];
    for (const swPath of swPaths) {
      app.get(swPath, (context) => {
        context.header('Content-Type', 'application/javascript; charset=utf-8');
        context.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        context.header('Service-Worker-Allowed', '/');
        return context.body(killSwitchSW);
      });
    }
    app.all('*', (context) => tabletDevProxy.fetch(context.req.raw));
  } else if (options.tabletDistDir) {
    app.use(
      '/*',
      serveStatic({
        root: options.tabletDistDir
      })
    );
    app.get('*', async (context) => {
      const index = await readFile(path.join(options.tabletDistDir ?? '', 'index.html'), 'utf8');
      context.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      context.header('Pragma', 'no-cache');
      context.header('Expires', '0');
      return context.html(index);
    });
  }

  const transformTranscript = (transcript: ThreadTranscript, threadId: string): ThreadTranscript => {
    // The poller hands us a fresh transcript on every successful reconcile — cache it so
    // the HTTP fallback path always has a recent copy to serve when a live read times out.
    const appServerTranscript =
      options.appServer?.applyLiveState?.(transcript, threadId) ?? transcript;
    const realtimeTranscript = applyMirrorApprovalState(
      appServerTranscript,
      threadId,
      options.mirror
    );
    transcriptCache.set(threadId, realtimeTranscript);
    return exposeLocalAttachments(
      applyMobileSendState(realtimeTranscript, currentSettings),
      threadId,
      localAttachments
    );
  };

  const detachAppServerLiveEvent = options.appServer?.onLiveEvent?.((event) => {
    if (!isProviderEnabled('codex')) {
      return;
    }
    hub.broadcast(event);
  });
  const detachClaudeLiveEvent = options.claudeCode?.onLiveEvent?.((event) => {
    if (!isProviderEnabled('claude-code')) {
      return;
    }
    hub.broadcast(event);
  });
  const detachAppServerLiveState = options.appServer?.onLiveStateChange?.((threadId) => {
    if (!isProviderEnabled('codex')) {
      return;
    }
    const cached = transcriptCache.get(threadId) ?? emptyDraftTranscript(threadId);
    const visible = transformTranscript(cached, threadId);
    hub.broadcast({ type: 'thread/transcript/changed', payload: visible });
  });
  const detachClaudeLiveState = options.claudeCode?.onLiveStateChange?.((threadId) => {
    if (!isProviderEnabled('claude-code')) {
      return;
    }
    void options.claudeCode?.readTranscript(threadId)
      .then((transcript) => {
        const visible = transformTranscript(transcript, threadId);
        hub.broadcast({ type: 'thread/transcript/changed', payload: visible });
      })
      .catch(() => undefined);
  });
  const detachAppServerTurnCompleted = options.appServer?.onTurnCompleted?.((event) => {
    handleAppServerTurnCompleted(event);
  });
  const detachAppServerConnection = options.appServer?.onConnectionChange?.(() => {
    liveSubscribedThreadIds.clear();
    hub.broadcast({ type: 'health/changed', payload: healthPayload(options, startedAt) });
  });
  const detachMirrorPendingApprovals = options.mirror?.onPendingApprovalsChange?.((event) => {
    hub.broadcast({ type: 'thread/pending-approvals/changed', payload: event });
    // Always emit a status update — when approvals clear we have to actively
    // move the thread out of `waiting_approval`, otherwise the tablet keeps
    // showing the badge until the next poll. Use the same in-memory live
    // signals that applyAppServerLiveThreadStatus uses on reconcile.
    const status: Thread['status'] =
      event.requests.length > 0
        ? 'waiting_approval'
        : options.appServer?.isThreadCompacting?.(event.threadId)
          ? 'compacting'
          : options.appServer?.isThreadStreaming?.(event.threadId)
            ? 'running'
            : 'idle';
    hub.broadcast({
      type: 'thread/status/changed',
      payload: { threadId: event.threadId, status }
    });
  });
  void options.appServer?.ensureConnected?.()
    .catch(() => undefined)
    .finally(() => {
      hub.broadcast({ type: 'health/changed', payload: healthPayload(options, startedAt) });
    });

  return {
    app,
    transformTranscript,
    dispose: () => {
      if (autoDesktopRefreshTimer) {
        clearTimeout(autoDesktopRefreshTimer);
        autoDesktopRefreshTimer = undefined;
      }
      detachAppServerLiveEvent?.();
      detachClaudeLiveEvent?.();
      detachAppServerLiveState?.();
      detachClaudeLiveState?.();
      detachAppServerTurnCompleted?.();
      detachAppServerConnection?.();
      detachMirrorPendingApprovals?.();
    }
  };
}

async function listProjects(
  threadProvider: AgentPulseServerOptions['threadProvider']
): Promise<Project[]> {
  return threadProvider.listProjects ? threadProvider.listProjects() : [];
}

function mergeProjectsByPath(projects: Project[]): Project[] {
  const byPath = new Map<string, Project>();
  for (const project of projects) {
    const key = path.normalize(project.path);
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, ProjectSchema.parse(project));
      continue;
    }
    byPath.set(key, ProjectSchema.parse({
      ...existing,
      providers: [...new Set([...(existing.providers ?? ['codex']), ...(project.providers ?? ['codex'])])]
    }));
  }
  return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeRequestedCwd(value: string): string {
  return path.normalize(value.trim().replace(/^~(?=$|\/)/, homedir()));
}

// Codex's IPC follower discovery requires `getThreadRole === 'owner'`. If the
// desktop window doesn't currently own the thread, the follower call returns
// `client-cannot-handle-request` and surfaces here as a SendBlockedError with
// reason 'thread_unavailable'. Wrap the apply call in this helper to:
//   1. Open the thread on the Mac if it isn't owned, so the desktop window
//      becomes the owner.
//   2. Wait up to ownershipTimeoutMs for the matching `thread-stream-state-changed`
//      broadcast confirming ownership.
//   3. Send the request. If it still fails with `thread_unavailable`, retry
//      once after a short delay (the snapshot can race the discovery probe on
//      first open).
async function runWithFollowerOwnership<T>(
  apply: () => Promise<T>,
  opener: ThreadOpener,
  threadId: string,
  mirror: CodexMirrorBridge | undefined,
  options: { ownershipTimeoutMs?: number; retryDelayMs?: number } = {}
): Promise<T> {
  const ownershipTimeoutMs = options.ownershipTimeoutMs ?? 4_000;
  const retryDelayMs = options.retryDelayMs ?? 800;

  const owned = mirror?.isThreadOwned?.(threadId);
  debugLog('[ownership] enter', { threadId, owned });

  if (mirror?.isThreadOwned && !owned) {
    debugLog('[ownership] not owned — opening thread on Mac', { threadId });
    try {
      await opener.openThread(threadId);
    } catch (openError) {
      console.warn('[ownership] opener failed', { threadId, error: String(openError) });
    }
    if (mirror.waitForOwnership) {
      const before = Date.now();
      const acquired = await mirror.waitForOwnership(threadId, ownershipTimeoutMs);
      debugLog('[ownership] waitForOwnership returned', {
        threadId,
        acquired,
        elapsedMs: Date.now() - before
      });
    }
  }

  try {
    debugLog('[ownership] applying request', { threadId });
    const result = await apply();
    debugLog('[ownership] apply succeeded on first try', { threadId });
    return result;
  } catch (error) {
    if (
      !(error instanceof SendBlockedError) ||
      error.reason !== 'thread_unavailable'
    ) {
      debugLog('[ownership] apply failed (non-retryable)', {
        threadId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    debugLog('[ownership] apply failed with thread_unavailable — waiting and retrying', {
      threadId
    });
    if (mirror?.waitForOwnership) {
      const before = Date.now();
      const acquired = await mirror.waitForOwnership(threadId, retryDelayMs);
      debugLog('[ownership] retry waitForOwnership returned', {
        threadId,
        acquired,
        elapsedMs: Date.now() - before
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    const result = await apply();
    debugLog('[ownership] retry succeeded', { threadId });
    return result;
  }
}

function mergeModelCatalogMetadata(
  appServerModels: CatalogModel[],
  catalogModels: CatalogModel[]
): CatalogModel[] {
  if (catalogModels.length === 0) {
    return appServerModels;
  }
  const catalogBySlug = new Map(catalogModels.map((model) => [model.slug, model]));
  return appServerModels.map((model) => {
    const catalogModel = catalogBySlug.get(model.slug);
    if (!catalogModel) {
      return model;
    }

    const supportedReasoningLevels =
      model.supportedReasoningLevels && model.supportedReasoningLevels.length > 0
        ? model.supportedReasoningLevels
        : catalogModel.supportedReasoningLevels;

    return CatalogModelSchema.parse({
      ...catalogModel,
      ...model,
      description: model.description ?? catalogModel.description,
      defaultReasoningLevel: model.defaultReasoningLevel ?? catalogModel.defaultReasoningLevel,
      supportedReasoningLevels,
      priority: model.priority ?? catalogModel.priority
    });
  });
}

function healthPayload(options: AgentPulseServerOptions, startedAt: number): HelperHealth {
  return HelperHealthSchema.parse({
    status: 'ok',
    codexAppServer: options.appServer?.isConnected() ? 'connected' : 'disconnected',
    version: options.version,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    ...(options.remoteAccess?.getStatus()
      ? { remoteAccess: remoteHealthPayload(options.remoteAccess.getStatus()) }
      : {})
  });
}

function remoteHealthPayload(remoteAccess: RemoteAccessSettings) {
  return {
    enabled: remoteAccess.enabled,
    provider: remoteAccess.provider,
    mode: remoteAccess.mode,
    status: remoteAccess.status,
    publicUrl: remoteAccess.publicUrl,
    hostname: remoteAccess.hostname,
    checklist: remoteAccess.checklist,
    ...(remoteAccess.lastError ? { lastError: remoteAccess.lastError } : {})
  };
}

function applyMobileSendState(transcript: ThreadTranscript, settings: HelperSettings): ThreadTranscript {
  if (settings.mobileSendEnabled) {
    return transcript;
  }

  return ThreadTranscriptSchema.parse({
    ...transcript,
    sendState: {
      canSend: false,
      reason: 'mobile_send_disabled',
      label: 'Mobile sending is off on the Mac.'
    }
  });
}

// Race a promise against a timeout. Resolves to `{ ok: true, value }` if the promise
// settles in time, `{ ok: false }` on timeout. We don't reject on timeout so callers can
// fall through to a cached value without unwinding through try/catch.
async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
  });
  try {
    const winner = await Promise.race([
      promise.then((value) => ({ ok: true as const, value })),
      timeout
    ]);
    return winner;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function parseTranscriptMessageLimit(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

// Minimum number of user messages we try to keep in the tail window. Slicing by raw
// index breaks down when a long agent turn (reasoning + tool calls + file events) fills
// the last `limit` entries — the user's prompt that started it all gets cut off and
// the dashboard renders nothing but agent activity. Anchoring on user messages instead
// of plain count guarantees the conversation still reads as a conversation.
const MIN_TAIL_USER_MESSAGES = 2;
// Safety ceiling: even if there are fewer than MIN_TAIL_USER_MESSAGES user messages in
// recent history, never expand the tail window past this many entries. Stops the
// "agent thought for 30 minutes with no user input" case from shipping the entire
// transcript on every poll.
const MAX_TAIL_EXPANSION = 200;

function limitTranscriptMessages(
  transcript: ThreadTranscript,
  limit: number | undefined
): ThreadTranscript {
  if (!limit || transcript.messages.length <= limit) {
    return transcript;
  }

  // Start from the plain tail of `limit` messages, then walk backwards until we've
  // included at least MIN_TAIL_USER_MESSAGES user messages (or hit the start, or the
  // hard ceiling). The result is always >= `limit` entries, never less.
  const messages = transcript.messages;
  let sliceStart = messages.length - limit;
  let userCount = 0;
  for (let i = messages.length - 1; i >= sliceStart; i -= 1) {
    if (messages[i]!.role === 'user') {
      userCount += 1;
    }
  }
  while (
    userCount < MIN_TAIL_USER_MESSAGES &&
    sliceStart > 0 &&
    messages.length - sliceStart < MAX_TAIL_EXPANSION
  ) {
    sliceStart -= 1;
    if (messages[sliceStart]!.role === 'user') {
      userCount += 1;
    }
  }

  return ThreadTranscriptSchema.parse({
    ...transcript,
    messages: messages.slice(sliceStart)
  });
}

function exposeLocalAttachments(
  transcript: ThreadTranscript,
  threadId: string,
  localAttachments: Map<string, LocalAttachment>
): ThreadTranscript {
  return ThreadTranscriptSchema.parse({
    ...transcript,
    messages: transcript.messages.map((message) => ({
      ...message,
      ...(message.attachments
        ? {
            attachments: message.attachments.map((attachment) =>
              exposeLocalAttachment(attachment, threadId, localAttachments)
            )
          }
        : {})
    }))
  });
}

function exposeLocalAttachment(
  attachment: ChatAttachment,
  threadId: string,
  localAttachments: Map<string, LocalAttachment>
): ChatAttachment {
  const { sourcePath, ...publicAttachment } = attachment;
  if (!sourcePath) {
    return publicAttachment;
  }

  const token = createHash('sha256')
    .update(`${threadId}:${attachment.id}:${sourcePath}`)
    .digest('hex')
    .slice(0, 32);
  localAttachments.set(token, {
    sourcePath,
    contentType: imageContentType(sourcePath),
    expiresAt: Date.now() + 2 * 60 * 60 * 1000
  });
  return {
    ...publicAttachment,
    url: `/attachments/${token}`
  };
}

function imageContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.png':
    default:
      return 'image/png';
  }
}

async function requireAuth(request: Request, registry: DeviceRegistry) {
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
  return registry.validate(
    token,
    request.headers.get('x-agent-pulse-device-id') ?? undefined,
    request.headers.get('x-agent-pulse-fingerprint') ?? undefined
  );
}

function attachWebSocketEvents(
  server: Server,
  hub: LiveEventHub,
  registry: DeviceRegistry,
  currentSettings: () => HelperSettings,
  tabletDevProxy?: TabletDevProxy
): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    // Wrap the async work so that any thrown error is logged and the socket is
    // closed cleanly. Without this, a rejection from registry.validate (e.g. the
    // macOS Keychain command failing) becomes an unhandled rejection — fatal on
    // Node 22+ — and the helper exits, after which cloudflared sees
    // "connection refused" on every retry until the helper is restarted.
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const remoteAddress = request.socket.remoteAddress ?? 'unknown';
      const origin = request.headers.origin ?? '(none)';

      try {
        if (url.pathname !== '/events') {
          if (tabletDevProxy) {
            tabletDevProxy.proxyUpgrade(request, socket, head);
            return;
          }
          console.warn('[ws-upgrade] rejected: unknown path', {
            path: url.pathname,
            remoteAddress,
            origin
          });
          socket.destroy();
          return;
        }

        if (!isAllowedOriginHeaders(nodeHeaderGetter(request), currentSettings())) {
          console.warn('[ws-upgrade] rejected: origin not allowed', {
            origin,
            host: request.headers.host ?? '(none)',
            remoteAddress
          });
          socket.destroy();
          return;
        }

        const deviceId = url.searchParams.get('deviceId') ?? undefined;
        const auth = await registry.validate(
          url.searchParams.get('token') ?? undefined,
          deviceId,
          url.searchParams.get('fingerprint') ?? undefined
        );

        if (!auth.ok) {
          console.warn('[ws-upgrade] rejected: auth failed', {
            reason: auth.reason,
            deviceId: deviceId ?? '(none)',
            hasToken: url.searchParams.has('token'),
            hasFingerprint: url.searchParams.has('fingerprint'),
            remoteAddress,
            origin
          });
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (websocket) => {
          hub.add(websocket, auth.device.deviceId);
        });
      } catch (error) {
        console.error('[ws-upgrade] handler threw', {
          path: url.pathname,
          remoteAddress,
          origin,
          error: error instanceof Error ? error.message : String(error)
        });
        try {
          socket.destroy();
        } catch {
          // socket may already be closed
        }
      }
    })();
  });
}

export class LiveEventHub {
  private readonly clients = new Map<WebSocket, { deviceId: string }>();

  add(client: WebSocket, deviceId: string): void {
    this.clients.set(client, { deviceId });
    client.on('close', () => this.clients.delete(client));
  }

  broadcast(event: LiveEvent): void {
    const parsed = LiveEventSchema.parse(event);
    const body = JSON.stringify(parsed);
    for (const client of this.clients.keys()) {
      client.send(body);
    }
  }

  closeDevice(deviceId: string): void {
    for (const [client, metadata] of this.clients.entries()) {
      if (metadata.deviceId === deviceId) {
        client.close();
        this.clients.delete(client);
      }
    }
  }

  close(): void {
    for (const client of this.clients.keys()) {
      client.close();
    }
    this.clients.clear();
  }
}

// 6s polling cadence: app-server notifications are the source of truth for live
// working/ready state. This loop is only a slow backstop for thread/message list freshness.
const POLL_INTERVAL_MS = 6_000;
const ACTIVE_RECENCY_MS = 10 * 60_000;
// Was 15 ticks at 2s = 30s between full sweeps. Keep that real-world cadence at the new rate.
const FULL_SWEEP_EVERY_N_TICKS = 5;

function startThreadPolling(
  threadProvider: { listThreads(): Promise<Thread[]> },
  hub: LiveEventHub,
  appServer: AppServerChatBridge | undefined,
  mirror: CodexMirrorBridge | undefined,
  transformTranscript?: (transcript: ThreadTranscript, threadId: string) => ThreadTranscript,
  seenThreadStore?: SeenThreadStore
) {
  let previous = new Map<string, string>();
  let inFlight = false;
  let tickCount = 0;

  const tick = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      tickCount += 1;
      const fullSweep = tickCount % FULL_SWEEP_EVERY_N_TICKS === 1;
      // Prefer the new combined endpoint that returns ids + statuses in one round
      // trip (openai/codex#11786). Fall back to listLoadedThreadIds for older
      // Codex builds that only expose ids.
      const loadedStatuses = await appServer?.listLoadedThreadStatuses?.()
        .catch(() => undefined);
      const loadedThreadIds =
        loadedStatuses ?? (await appServer?.listLoadedThreadIds?.().catch(() => undefined));
      const liveStatuses = loadedStatuses instanceof Map ? loadedStatuses : undefined;
      const loadedIdsSet =
        loadedThreadIds instanceof Map
          ? new Set(loadedThreadIds.keys())
          : loadedThreadIds;
      const threads = (await threadProvider.listThreads()).map((thread) =>
        applyAppServerLiveThreadStatus(thread, appServer, mirror, liveStatuses)
      );
      const toReconcile = threads.filter((thread) =>
        shouldReconcileThread(thread, fullSweep, loadedIdsSet)
      );
      const reconciledActive = await reconcileThreads(toReconcile, appServer, transformTranscript);

      const reconciledById = new Map(
        reconciledActive.map((entry) => [entry.thread.threadId, entry])
      );
      const reconciled: ReconciledThread[] = threads.map(
        (thread) => reconciledById.get(thread.threadId) ?? { thread }
      );

      const next = new Map(
        reconciled.map(({ thread }) => [thread.threadId, JSON.stringify(thread)])
      );

      for (const { thread, transcript } of reconciled) {
        if (previous.get(thread.threadId) !== next.get(thread.threadId)) {
          hub.broadcast({ type: 'thread/upsert', payload: thread });
        }
        // Push transcripts for any thread we successfully reconciled. This keeps the tablet's
        // last-known-good messages fresh without using app-server status as the live state.
        if (transcript) {
          hub.broadcast({ type: 'thread/transcript/changed', payload: transcript });
        }
      }

      for (const threadId of previous.keys()) {
        if (!next.has(threadId)) {
          hub.broadcast({ type: 'thread/remove', payload: { threadId } });
        }
      }

      previous = next;

      // Drop seen-thread entries for threads that no longer exist, but only on
      // a full sweep — partial polls only pull recently-active threads, so the
      // 'next' map there isn't an authoritative list of what exists.
      if (fullSweep && seenThreadStore) {
        await seenThreadStore.pruneOrphans(new Set(next.keys())).catch(() => undefined);
      }
    } finally {
      inFlight = false;
    }
  };

  void tick();
  return setInterval(() => void tick(), POLL_INTERVAL_MS);
}

type ReconciledThread = { thread: Thread; transcript?: ThreadTranscript };

async function reconcileThreads(
  threads: Thread[],
  appServer: AppServerChatBridge | undefined,
  transformTranscript?: (transcript: ThreadTranscript, threadId: string) => ThreadTranscript
): Promise<ReconciledThread[]> {
  if (!appServer) {
    return threads.map((thread) => ({ thread }));
  }

  return Promise.all(
    threads.map(async (thread): Promise<ReconciledThread> => {
      try {
        const rawTranscript = await appServer.readTranscript(thread.threadId);
        const transcript = transformTranscript
          ? transformTranscript(rawTranscript, thread.threadId)
          : rawTranscript;
        return {
          thread: ThreadSchema.parse({
            ...thread,
            status: reconciledThreadStatus(thread, transcript)
          }),
          transcript
        };
      } catch {
        return { thread };
      }
    })
  );
}

function reconciledThreadStatus(thread: Thread, transcript: ThreadTranscript): Thread['status'] {
  const transcriptStatus = statusFromTranscript(transcript);
  if (transcriptStatus !== 'idle') {
    return resolveThreadStatus([thread.status, transcriptStatus]);
  }

  const lastActivityMs = Date.parse(thread.lastActivityAt);
  const isRecent =
    Number.isFinite(lastActivityMs) && Date.now() - lastActivityMs < ACTIVE_RECENCY_MS;
  return isRecent ? resolveThreadStatus([thread.status, transcriptStatus]) : transcriptStatus;
}

async function reconcileThreadStatuses(
  threads: Thread[],
  appServer: AppServerChatBridge | undefined,
  mirror: CodexMirrorBridge | undefined,
  transformTranscript?: (transcript: ThreadTranscript, threadId: string) => ThreadTranscript
): Promise<Thread[]> {
  const liveStatuses = await appServer?.listLoadedThreadStatuses?.().catch(() => undefined);
  const liveThreads = threads.map((thread) =>
    applyAppServerLiveThreadStatus(thread, appServer, mirror, liveStatuses)
  );
  const loadedThreadIds =
    liveStatuses ?? (await appServer?.listLoadedThreadIds?.().catch(() => undefined));
  const loadedIdsSet =
    loadedThreadIds instanceof Map ? new Set(loadedThreadIds.keys()) : loadedThreadIds;
  const toReconcile = liveThreads.filter((thread) =>
    shouldReconcileThread(thread, false, loadedIdsSet)
  );
  const reconciled = await reconcileThreads(toReconcile, appServer, transformTranscript);
  const byId = new Map(reconciled.map(({ thread }) => [thread.threadId, thread]));
  return liveThreads.map((thread) => byId.get(thread.threadId) ?? thread);
}

function applyAppServerLiveThreadStatus(
  thread: Thread,
  appServer: AppServerChatBridge | undefined,
  mirror: CodexMirrorBridge | undefined,
  liveStatuses?: Map<string, Thread['status']>
): Thread {
  // Live notification-derived state from in-memory flags (notifications are
  // pushed in real time and beat the snapshot returned by thread/loaded/list).
  const inMemoryStatus = mirror?.isThreadWaitingForApproval?.(thread.threadId)
    ? 'waiting_approval'
    : appServer?.isThreadCompacting?.(thread.threadId)
      ? 'compacting'
      : appServer?.isThreadStreaming?.(thread.threadId)
        ? 'running'
        : undefined;
  if (inMemoryStatus) {
    return ThreadSchema.parse({ ...thread, status: inMemoryStatus });
  }

  // Backstop: if the app-server's thread/loaded/list reports the thread as
  // active but our in-memory state didn't catch it (e.g. we missed a
  // notification while disconnected), trust the remote status. This keeps the
  // tablet's working badge correct even after a brief helper reconnect.
  const remote = liveStatuses?.get(thread.threadId);
  if (remote && remote !== 'idle' && remote !== 'unknown') {
    return ThreadSchema.parse({ ...thread, status: remote });
  }

  return thread;
}

function shouldReconcileThread(
  thread: Thread,
  fullSweep: boolean,
  loadedThreadIds?: Set<string>
): boolean {
  if (loadedThreadIds?.has(thread.threadId)) {
    return true;
  }
  if (thread.status !== 'idle' && thread.status !== 'unknown') {
    return true;
  }
  const lastActivityMs = Date.parse(thread.lastActivityAt);
  if (!Number.isFinite(lastActivityMs)) {
    return false;
  }
  const isRecent = Date.now() - lastActivityMs < ACTIVE_RECENCY_MS;
  return isRecent || (fullSweep && thread.status === 'unknown');
}

function mergeDraftThreads(threads: Thread[], drafts: Map<string, Thread>): Thread[] {
  const materializedIds = new Set(threads.map((thread) => thread.threadId));
  for (const threadId of materializedIds) {
    drafts.delete(threadId);
  }

  const visibleDrafts = [...drafts.values()].sort(
    (left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)
  );
  return [...visibleDrafts, ...threads];
}

function emptyDraftTranscript(threadId: string): ThreadTranscript {
  return ThreadTranscriptSchema.parse({
    threadId,
    activeTurnId: null,
    sendState: {
      canSend: true,
      reason: 'ready',
      label: 'Ready'
    },
    messages: []
  });
}

function updateDraftThreadFromTranscript(draftThread: Thread, transcript: ThreadTranscript): Thread {
  const latestMessage = transcript.messages.at(-1);
  return ThreadSchema.parse({
    ...draftThread,
    status: statusFromTranscript(transcript),
    lastActivityAt: latestMessage?.createdAt ?? new Date().toISOString(),
    lastTurnSummary: latestMessage?.text ?? draftThread.lastTurnSummary
  });
}

// Recognized bare slash commands. Only fires when the user message is
// exactly the slash + name (with optional trailing whitespace) — once a user
// adds text after the command name we treat it as a normal message so anything
// like "/compact please" still falls through as plain text.
const BARE_SLASH_PATTERN = /^\s*\/([a-zA-Z][a-zA-Z0-9_-]*)\s*$/;

function matchBareSlashCommand(text: string): string | null {
  const match = BARE_SLASH_PATTERN.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

// Returns a ThreadMessageResponse if the slash command was handled here, or
// null if it should fall through to the normal send path. Hub broadcasts let
// the tablet drop the optimistic pending bubble even though no real user-text
// turn was created.
async function handleSlashCommand(
  command: string,
  originalText: string,
  threadId: string,
  appServer: AppServerChatBridge | undefined,
  hub: LiveEventHub
): Promise<ThreadMessageResponse | null> {
  if (command === 'compact') {
    if (!appServer?.compactThread) {
      throw new SendBlockedError(
        'thread_unavailable',
        'Compact requires Codex 0.96 or newer.'
      );
    }
    await appServer.compactThread(threadId);
    hub.broadcast({
      type: 'thread/status/changed',
      payload: { threadId, status: 'compacting' }
    });
    return slashCommandAckResponse(threadId, command, originalText);
  }

  if (command === 'review') {
    if (!appServer?.startReview) {
      throw new SendBlockedError(
        'thread_unavailable',
        'Review requires the Codex app-server.'
      );
    }
    await appServer.startReview(threadId);
    return slashCommandAckResponse(threadId, command, originalText);
  }

  // Commands we recognize but don't have a dedicated RPC path for — better to
  // tell the user than to silently send the literal text as a message.
  if (command === 'clear' || command === 'new' || command === 'help' || command === 'feedback' || command === 'model') {
    throw new SendBlockedError(
      'thread_unavailable',
      `/${command} isn't supported on the tablet yet — run it from the Codex desktop app.`
    );
  }

  return null;
}

function slashCommandAckResponse(threadId: string, command: string, originalText: string): ThreadMessageResponse {
  // Codex doesn't return a transcript for fire-and-forget commands. We include
  // a synthetic user message matching the slash text so the tablet's pending
  // bubble is confirmed (pendingMessageIsConfirmed checks for a user message
  // with matching text). Without it, the optimistic bubble stays "unconfirmed"
  // indefinitely and the visible tail gets blanked.
  const syntheticMessage = ChatMessageSchema.parse({
    id: `slash:${command}:${threadId}`,
    role: 'user',
    kind: 'message',
    text: originalText,
    createdAt: new Date().toISOString()
  });
  return ThreadMessageResponseSchema.parse({
    ok: true,
    mode: 'start',
    turnId: `slash:${command}:${threadId}`,
    transcript: {
      threadId,
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Ready' },
      messages: [syntheticMessage]
    }
  });
}

function applyMirrorApprovalState(
  transcript: ThreadTranscript,
  threadId: string,
  mirror: CodexMirrorBridge | undefined
): ThreadTranscript {
  // Only trust mirror approval state when the IPC mirror is currently
  // connected. The mirror's in-memory map only clears on dispose, so after a
  // desktop disconnect a stale entry could otherwise pin the transcript to
  // `waiting_on_approval` even though Codex has long since moved on.
  if (!mirror?.isConnected() || !mirror.isThreadWaitingForApproval?.(threadId)) {
    return transcript;
  }
  return ThreadTranscriptSchema.parse({
    ...transcript,
    activeTurnId: transcript.activeTurnId ?? `mirror-approval:${threadId}`,
    sendState: {
      canSend: false,
      reason: 'waiting_on_approval',
      label: 'Codex is waiting for approval'
    }
  });
}

function statusFromTranscript(transcript: ThreadTranscript): Thread['status'] {
  switch (transcript.sendState.reason) {
    case 'waiting_on_approval':
      return 'waiting_approval';
    case 'compacting_context':
      return 'compacting';
    case 'thread_unavailable':
      return 'error';
    case 'app_server_disconnected':
      return 'connection';
    default:
      break;
  }

  if (transcript.activeTurnId) {
    return 'running';
  }

  return 'idle';
}

function clientIp(request: Request, peerAddress: string | undefined, settings: HelperSettings): string {
  const directAddress = normalizeIp(peerAddress);
  if (shouldTrustProxyHeaders(request, peerAddress, settings)) {
    return (
      normalizeIp(request.headers.get('cf-connecting-ip')) ||
      normalizeIp(request.headers.get('x-forwarded-for')?.split(',')[0]) ||
      directAddress ||
      'local'
    );
  }

  return directAddress || 'local';
}

function isAllowedOrigin(request: Request, settings: HelperSettings): boolean {
  return isAllowedOriginHeaders((name) => request.headers.get(name), settings);
}

function isAllowedOriginHeaders(
  getHeader: (name: string) => string | null,
  settings: HelperSettings
): boolean {
  const origin = getHeader('origin');
  if (!origin) {
    return true;
  }

  if (isLocalOrigin(origin)) {
    return true;
  }

  const requestHost = getHeader('host') ?? '';
  try {
    if (new URL(origin).host === requestHost) {
      return true;
    }
  } catch {
    return false;
  }

  const publicUrl = settings.remoteAccess?.publicUrl;
  if (settings.remoteAccess?.enabled && publicUrl && stripTrailingSlash(origin) === stripTrailingSlash(publicUrl)) {
    return true;
  }

  return false;
}

function nodeHeaderGetter(request: IncomingMessage): (name: string) => string | null {
  return (name) => {
    const value = request.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }
    return value ?? null;
  };
}

function isPublicRemoteRequest(request: Request, settings: HelperSettings): boolean {
  if (!settings.remoteAccess?.enabled || !settings.remoteAccess.publicUrl) {
    return false;
  }

  const origin = request.headers.get('origin');
  if (origin && stripTrailingSlash(origin) === stripTrailingSlash(settings.remoteAccess.publicUrl)) {
    return true;
  }

  const host = request.headers.get('host')?.split(':')[0]?.toLowerCase();
  const remoteHost = publicHost(settings.remoteAccess);
  return Boolean(host && remoteHost && host === remoteHost);
}

function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeHostname(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function publicUrlForHostname(value: string | undefined): string {
  const hostname = normalizeHostname(value);
  return hostname ? `https://${hostname}` : '';
}

function publicHost(remoteAccess: RemoteAccessSettings): string {
  if (remoteAccess.hostname.trim()) {
    return remoteAccess.hostname.trim().toLowerCase();
  }

  try {
    return new URL(remoteAccess.publicUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function shouldTrustProxyHeaders(
  request: Request,
  peerAddress: string | undefined,
  settings: HelperSettings
): boolean {
  return isPublicRemoteRequest(request, settings) && isLoopbackAddress(peerAddress);
}

function isLoopbackAddress(value: string | undefined): boolean {
  const normalized = normalizeIp(value);
  return normalized === '127.0.0.1' || normalized === '::1';
}

function normalizeIp(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length);
  }

  return trimmed;
}

function readAdminToken(request: Request): string | undefined {
  return bearerToken(request);
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(' ', 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return undefined;
  }
  return token.trim();
}

function isAdminRequest(request: Request, adminAuth: AdminAuth): boolean {
  return adminAuth.verifyToken(readAdminToken(request));
}

function adminForbidden(context: {
  json: (body: unknown, status?: number) => Response;
}): Response {
  return context.json({ error: 'Admin mode required.' }, 401);
}

const CODEX_ICNS_PATH = '/Applications/Codex.app/Contents/Resources/electron.icns';
let codexAppIconCache: Promise<Buffer> | undefined;

function loadCodexAppIcon(): Promise<Buffer> {
  if (!codexAppIconCache) {
    codexAppIconCache = extractCodexAppIcon().catch((error) => {
      codexAppIconCache = undefined;
      throw error;
    });
  }
  return codexAppIconCache;
}

async function extractCodexAppIcon(): Promise<Buffer> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'agent-pulse-icon-'));
  const iconsetDir = path.join(workDir, 'codex.iconset');
  try {
    await runCommand('iconutil', ['-c', 'iconset', CODEX_ICNS_PATH, '-o', iconsetDir]);
    return await readFile(path.join(iconsetDir, 'icon_512x512@2x.png'));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
