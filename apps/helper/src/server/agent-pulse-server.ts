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
  CatalogModelsResponseSchema,
  CatalogPluginsResponseSchema,
  CatalogSkillsResponseSchema,
  DeviceRevokeRequestSchema,
  HelperHealthSchema,
  LiveEventSchema,
  PairRequestSchema,
  PairingDeviceListResponseSchema,
  PairResponseSchema,
  ProjectFilesResponseSchema,
  ProjectListResponseSchema,
  RemoteActivityLogEntrySchema,
  RemoteAccessProtocolSchema,
  RemoteAccessSettingsSchema,
  ThreadCreateRequestSchema,
  ThreadCreateResponseSchema,
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
  type ChatAttachment,
  type HelperHealth,
  type LiveEvent,
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
import { SendBlockedError } from '../codex/app-server-chat';
import type { CatalogReader } from '../codex/catalog';
import type { createThreadOpener } from '../codex/thread-opener';
import { debugLog } from '../debug';
import type { HelperSettings, HelperSettingsStore } from './settings';
import { createTabletDevProxy, type TabletDevProxy } from './tablet-dev-proxy';

type ThreadOpener = ReturnType<typeof createThreadOpener>;

type LocalAttachment = {
  sourcePath: string;
  contentType: string;
  expiresAt: number;
};

const GLOBAL_ADMIN_LOGIN_LIMIT_KEY = '__global_admin_login_failures__';

export type AppServerChatBridge = {
  isConnected(): boolean;
  readTranscript(threadId: string): Promise<ThreadTranscript>;
  readFullTranscript?(threadId: string): Promise<ThreadTranscript>;
  sendMessage(
    threadId: string,
    text: string,
    options?: { model?: string; effort?: string }
  ): Promise<ThreadMessageResponse>;
  startThread?(cwd: string): Promise<Thread>;
};

export type CodexMirrorBridge = {
  isConnected(): boolean;
  sendMessage(threadId: string, text: string): Promise<ThreadMessageResponse>;
  interruptTurn?(threadId: string): Promise<void>;
  setModelAndReasoning?(
    threadId: string,
    modelSlug: string,
    reasoningEffort?: string
  ): Promise<void>;
  respondToApproval?(
    threadId: string,
    requestId: string,
    method:
      | 'item/commandExecution/requestApproval'
      | 'item/fileChange/requestApproval'
      | 'item/permissions/requestApproval',
    response: unknown
  ): Promise<void>;
  isThreadStreaming?(threadId: string): boolean;
  isThreadCompacting?(threadId: string): boolean;
  isThreadWaitingForApproval?(threadId: string): boolean;
  isThreadOwned?(threadId: string): boolean;
  waitForOwnership?(threadId: string, timeoutMs: number): Promise<boolean>;
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
  catalog?: CatalogReader;
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
  const { app, transformTranscript } = createApp(options, hub, tabletDevProxy);

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
    transformTranscript
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
      detachCatalog?.();
      hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

type CreatedApp = {
  app: Hono;
  transformTranscript: (transcript: ThreadTranscript, threadId: string) => ThreadTranscript;
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
  // Used by /threads/:id/model when no Codex window owns the thread (the IPC follower
  // path requires ownership). The override is consumed when the user sends the next
  // message — at that point we pass it directly to turn/start, no ownership needed.
  const pendingModelOverrides = new Map<string, { model: string; effort?: string }>();
  // Last-known-good transcript per thread, updated whenever any path successfully reads
  // one (HTTP fetch, poller broadcast). Used as a fallback when `appServer.readTranscript`
  // is slow or upstream Codex is degraded — we'd rather return slightly stale data fast
  // than block long enough for the cloudflared tunnel to cancel the request.
  const transcriptCache = new Map<string, ThreadTranscript>();
  // Codex's desktop "New chat" is a draft until the first user message. `thread/start`
  // returns an id immediately, but the thread may not appear in the normal session list
  // and transcript reads can say "not materialized yet" until that first turn exists.
  const draftThreads = new Map<string, Thread>();
  let currentSettings = options.settings;
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

    const threads = mergeDraftThreads(
      await reconcileThreadStatuses(
        await options.threadProvider.listThreads(),
        options.appServer,
        transformTranscript
      ),
      draftThreads
    );
    return context.json(ThreadListResponseSchema.parse({ threads }));
  });

  app.get('/projects/list', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    return context.json(ProjectListResponseSchema.parse({
      projects: await listProjects(options.threadProvider)
    }));
  });

  app.post('/threads/new', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    if (!options.appServer?.startThread) {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }

    const parsed = ThreadCreateRequestSchema.parse(await context.req.json());
    let cwd: string;
    if (parsed.projectId) {
      const projects = await listProjects(options.threadProvider);
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
      const thread = await options.appServer.startThread(cwd);
      draftThreads.set(thread.threadId, thread);
      hub.broadcast({ type: 'thread/upsert', payload: thread });
      hub.broadcast({ type: 'health/changed', payload: healthPayload(options, startedAt) });
      return context.json(ThreadCreateResponseSchema.parse({ thread }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[agent-pulse] app-server startThread failed', { cwd, error: detail });
      return context.json(
        { error: `Codex could not start a new thread in ${cwd}: ${detail}` },
        503
      );
    }
  });

  app.get('/threads/:threadId/transcript', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    if (!options.appServer) {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }

    const threadId = context.req.param('threadId');
    const messageLimit = parseTranscriptMessageLimit(context.req.query('limit'));

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

    if (!options.appServer) {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }

    const before = context.req.query('before');
    if (!before) {
      return context.json({ error: 'Missing required `before` query param.' }, 400);
    }

    try {
      const threadId = context.req.param('threadId');
      const limit = parseTranscriptMessageLimit(context.req.query('limit')) ?? 40;

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

    if (!options.appServer && !options.mirror) {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }

    const parsed = ThreadMessageRequestSchema.parse(await context.req.json());

    try {
      const threadId = context.req.param('threadId');
      const override = pendingModelOverrides.get(threadId);
      // Send routing:
      //   1. Always prefer the IPC mirror when it's connected. That path goes through
      //      `thread-follower-start-turn`, so the message appears live in the Codex desktop
      //      window — exactly like a message sent from the VS Code extension. We pair it with
      //      `runWithFollowerOwnership`, which auto-opens the thread on the Mac and waits for
      //      the ownership broadcast before sending. (Codex follower discovery requires
      //      `getThreadRole === 'owner'`; without that the IPC returns
      //      `client-cannot-handle-request`.)
      //   2. Only fall back to the spawned app-server subprocess when (a) the mirror isn't
      //      connected at all, or (b) the IPC path fails with `thread_unavailable` (Codex
      //      isn't running, or the user dismissed the focus prompt). The fallback is what
      //      delivers any queued model override, which app-server's `turn/start` accepts via
      //      `{model, effort}` directly.
      const mirrorReady = options.mirror?.isConnected() === true;
      const appServerReady = options.appServer?.isConnected() === true;
      if (!mirrorReady && !appServerReady) {
        return context.json({ error: 'Codex connection unavailable.' }, 503);
      }

      const sendViaAppServer = async () => {
        if (!options.appServer) {
          throw new SendBlockedError('thread_unavailable', 'Codex app-server is not running.');
        }
        const sendOptions = override
          ? { model: override.model, ...(override.effort ? { effort: override.effort } : {}) }
          : undefined;
        return options.appServer.sendMessage(threadId, parsed.text, sendOptions);
      };

      let result: ThreadMessageResponse;
      if (mirrorReady && options.mirror) {
        try {
          result = ThreadMessageResponseSchema.parse(
            await runWithFollowerOwnership(
              () => options.mirror!.sendMessage(threadId, parsed.text),
              options.opener,
              threadId,
              options.mirror
            )
          );
        } catch (error) {
          // The mirror couldn't deliver — fall back to the spawned app-server subprocess so
          // the user's send doesn't fail outright.
          if (
            error instanceof SendBlockedError &&
            error.reason === 'thread_unavailable' &&
            appServerReady
          ) {
            console.warn('[send] mirror failed; falling back to app-server', {
              threadId,
              error: error.message
            });
            result = ThreadMessageResponseSchema.parse(await sendViaAppServer());
          } else {
            throw error;
          }
        }
      } else if (appServerReady) {
        result = ThreadMessageResponseSchema.parse(await sendViaAppServer());
      } else {
        // Should be unreachable due to the early-return above, but guard for type narrowing.
        return context.json({ error: 'Codex connection unavailable.' }, 503);
      }

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
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }
  });

  app.post('/threads/:threadId/stop', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    if (!options.mirror?.isConnected() || !options.mirror.interruptTurn) {
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }

    const threadId = context.req.param('threadId');
    try {
      await runWithFollowerOwnership(
        () => options.mirror!.interruptTurn!(threadId),
        options.opener,
        threadId,
        options.mirror
      );
      hub.broadcast({
        type: 'thread/streaming-changed',
        payload: { threadId, isStreaming: false }
      });
      return context.json(ThreadStopResponseSchema.parse({ ok: true }));
    } catch (error) {
      if (error instanceof SendBlockedError) {
        return context.json({ error: error.message, reason: error.reason }, 409);
      }
      return context.json({ error: 'Codex connection unavailable.' }, 503);
    }
  });

  app.post('/thread/open', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ ok: false, error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }

    const parsed = ThreadOpenRequestSchema.parse(await context.req.json());
    const result = await options.opener.openThread(parsed.threadId);
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
    const models = options.catalog ? await options.catalog.listModels() : [];
    return context.json(CatalogModelsResponseSchema.parse({ models }));
  });

  app.get('/projects/:projectId/files', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    if (!options.catalog) {
      return context.json(ProjectFilesResponseSchema.parse({ files: [], truncated: false }));
    }
    const projects = await listProjects(options.threadProvider);
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

  app.post('/threads/:threadId/approvals/:requestId', async (context) => {
    const auth = await authenticate(context);
    if (!auth.ok) {
      return context.json({ error: auth.reason }, auth.reason === 'revoked' ? 403 : 401);
    }
    if (!options.mirror?.respondToApproval || !options.mirror.isConnected()) {
      return context.json(
        { error: 'Open Codex on this Mac to respond to approvals.' },
        503
      );
    }
    const parsed = ApprovalDecisionRequestSchema.parse(await context.req.json());
    const threadId = context.req.param('threadId');
    const requestId = context.req.param('requestId');
    const apply = () =>
      options.mirror!.respondToApproval!(
        threadId,
        requestId,
        parsed.method,
        parsed.decision
      );
    try {
      await runWithFollowerOwnership(apply, options.opener, threadId, options.mirror);
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

    // Strategy:
    //   1. Try to push the change live via the IPC follower path — runWithFollowerOwnership
    //      will open the thread on the Mac if it isn't already owned, and wait for the
    //      ownership broadcast before sending. This is the path that worked previously and
    //      gives the user the same "GPT-5.5 -> {selected model}" desktop transition.
    //   2. If the IPC path fails (no Codex window will accept the request — e.g. Codex isn't
    //      running, or the user dismissed the focus prompt), queue the override locally so the
    //      next message we send via the app-server subprocess passes `model`/`effort` directly
    //      to turn/start. The override is durable until consumed.
    // Either way the response is "ok" so the tablet UI updates its model chip optimistically.
    let mode: 'live' | 'queued' = 'queued';
    if (options.mirror?.setModelAndReasoning && options.mirror.isConnected()) {
      const apply = () =>
        options.mirror!.setModelAndReasoning!(
          threadId,
          parsed.modelSlug,
          parsed.reasoningEffort
        );
      try {
        await runWithFollowerOwnership(apply, options.opener, threadId, options.mirror);
        mode = 'live';
        pendingModelOverrides.delete(threadId);
        debugLog('[model-change] applied live via IPC', {
          threadId,
          modelSlug: parsed.modelSlug,
          reasoningEffort: parsed.reasoningEffort
        });
      } catch (error) {
        console.warn('[model-change] live IPC path failed; queueing instead', {
          threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (mode === 'queued') {
      pendingModelOverrides.set(threadId, {
        model: parsed.modelSlug,
        ...(parsed.reasoningEffort ? { effort: parsed.reasoningEffort } : {})
      });
      debugLog('[model-change] queued for next turn', {
        threadId,
        modelSlug: parsed.modelSlug,
        reasoningEffort: parsed.reasoningEffort
      });
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
    const realtimeTranscript = applyMirrorStreamingState(transcript, threadId, options.mirror);
    transcriptCache.set(threadId, realtimeTranscript);
    return exposeLocalAttachments(
      applyMobileSendState(realtimeTranscript, currentSettings),
      threadId,
      localAttachments
    );
  };

  return { app, transformTranscript };
}

async function listProjects(
  threadProvider: AgentPulseServerOptions['threadProvider']
): Promise<Project[]> {
  return threadProvider.listProjects ? threadProvider.listProjects() : [];
}

/**
 * Wraps an IPC follower call (set-model, approval-decision, etc.) so that if Codex
 * doesn't currently own/host the conversation in any open window, we ask the desktop
 * to open the thread first, then retry. The desktop's discovery callback only accepts
 * follower requests when the receiving webview reports `getThreadRole === 'owner'`,
 * so we have to make sure a window is showing the thread before sending.
 */
/**
 * Wraps an IPC follower call so it succeeds even when the user hasn't actively focused the
 * conversation in a Codex window. The desktop's discovery callback for follower methods
 * (`set-model-and-reasoning`, approval decisions, `start-turn`, etc.) requires
 * `getThreadRole(conversationId) === 'owner'` — that role is only established after the
 * desktop's `maybe-resume-conversation` flow finishes, which doesn't happen automatically
 * just because Codex is running.
 *
 * Strategy:
 *   1. If the mirror already saw an `streamRole.role === 'owner'` broadcast for this thread,
 *      send the request immediately.
 *   2. Otherwise, fire `codex://threads/{id}` to open/focus the thread, then wait up to
 *      `ownershipTimeoutMs` for the matching `thread-stream-state-changed` broadcast.
 *   3. Send the request. If it still fails with `thread_unavailable`, retry once after a
 *      short delay (the snapshot can race the discovery probe on first open).
 */
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

function normalizeRequestedCwd(value: string): string {
  return path.normalize(value.trim().replace(/^~(?=$|\/)/, homedir()));
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

const MIRROR_STREAMING_TURN_PREFIX = 'mirror-streaming:';

function mirrorStreamingTurnId(threadId: string): string {
  return `${MIRROR_STREAMING_TURN_PREFIX}${threadId}`;
}

function applyMirrorStreamingState(
  transcript: ThreadTranscript,
  threadId: string,
  mirror: CodexMirrorBridge | undefined
): ThreadTranscript {
  const syntheticTurnId = mirrorStreamingTurnId(threadId);
  const mirrorSaysWaitingApproval = mirror?.isThreadWaitingForApproval?.(threadId) === true;
  const mirrorSaysCompacting = mirror?.isThreadCompacting?.(threadId) === true;
  const mirrorSaysStreaming = mirror?.isThreadStreaming?.(threadId) === true;

  if (mirrorSaysWaitingApproval) {
    return ThreadTranscriptSchema.parse({
      ...transcript,
      activeTurnId: transcript.activeTurnId ?? syntheticTurnId,
      sendState: {
        canSend: false,
        reason: 'waiting_on_approval',
        label: 'Codex is waiting for approval'
      }
    });
  }

  if (mirrorSaysCompacting) {
    return ThreadTranscriptSchema.parse({
      ...transcript,
      activeTurnId: transcript.activeTurnId ?? syntheticTurnId,
      sendState: {
        canSend: false,
        reason: 'compacting_context',
        label: 'Automatically compacting context'
      }
    });
  }

  if (mirrorSaysStreaming) {
    if (transcript.activeTurnId) {
      return transcript;
    }

    return ThreadTranscriptSchema.parse({
      ...transcript,
      activeTurnId: syntheticTurnId,
      sendState: {
        canSend: false,
        reason: 'thread_changed',
        label: 'Codex is working'
      }
    });
  }

  if (transcript.activeTurnId !== syntheticTurnId) {
    return transcript;
  }

  return ThreadTranscriptSchema.parse({
    ...transcript,
    activeTurnId: null,
    sendState:
      transcript.sendState.reason === 'thread_changed' ||
      transcript.sendState.reason === 'missing_active_turn' ||
      transcript.sendState.reason === 'waiting_on_approval' ||
      transcript.sendState.reason === 'compacting_context'
        ? {
            canSend: true,
            reason: 'ready',
            label: 'Ready'
          }
        : transcript.sendState
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

// 6s polling cadence: Codex desktop IPC is the source of truth for live working/ready state.
// This polling loop is only a slow backstop for thread/message list freshness, so it must not
// turn old app-server `running` status into a live working signal.
const POLL_INTERVAL_MS = 6_000;
const ACTIVE_RECENCY_MS = 10 * 60_000;
// Was 15 ticks at 2s = 30s between full sweeps. Keep that real-world cadence at the new rate.
const FULL_SWEEP_EVERY_N_TICKS = 5;

function startThreadPolling(
  threadProvider: { listThreads(): Promise<Thread[]> },
  hub: LiveEventHub,
  appServer: AppServerChatBridge | undefined,
  transformTranscript?: (transcript: ThreadTranscript, threadId: string) => ThreadTranscript
) {
  let previous = new Map<string, string>();
  let inFlight = false;
  let tickCount = 0;

  const isActiveForReconcile = (thread: Thread, fullSweep: boolean): boolean => {
    if (fullSweep) {
      return true;
    }
    if (thread.status === 'waiting_approval') {
      return true;
    }
    const lastActivityMs = Date.parse(thread.lastActivityAt);
    if (!Number.isFinite(lastActivityMs)) {
      return false;
    }
    return Date.now() - lastActivityMs < ACTIVE_RECENCY_MS;
  };

  const tick = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      tickCount += 1;
      const fullSweep = tickCount % FULL_SWEEP_EVERY_N_TICKS === 1;
      const threads = await threadProvider.listThreads();
      const toReconcile = threads.filter((thread) => isActiveForReconcile(thread, fullSweep));
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
            status: statusFromTranscript(transcript)
          }),
          transcript
        };
      } catch {
        return { thread };
      }
    })
  );
}

async function reconcileThreadStatuses(
  threads: Thread[],
  appServer: AppServerChatBridge | undefined,
  transformTranscript?: (transcript: ThreadTranscript, threadId: string) => ThreadTranscript
): Promise<Thread[]> {
  const reconciled = await reconcileThreads(threads, appServer, transformTranscript);
  return reconciled.map(({ thread }) => thread);
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
