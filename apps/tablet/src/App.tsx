import {
  LiveEventSchema,
  ThreadSchema,
  ThreadTranscriptSchema,
  type CatalogCommand,
  type CatalogModel,
  type CatalogPlugin,
  type CatalogSkill,
  type HelperHealth,
  type LiveEvent,
  type PairingDeviceOption,
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
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
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
  fetchThreadTranscript,
  fetchThreads,
  getFingerprint,
  liveEventsUrl,
  loadAdminToken,
  loadSession,
  openThreadInCodex,
  pairDevice,
  respondToApproval,
  saveAdminToken,
  saveSession,
  sendThreadMessage,
  startThread,
  updateRemoteAccess,
  updateThreadModel,
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

function extractConversationId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') {
    return undefined;
  }
  const value = (params as { conversationId?: unknown }).conversationId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export type PendingRequestSummary = {
  id: string;
  method: string;
  title: string;
  body?: string;
  itemId?: string;
  turnId?: string;
  kind?: 'question' | 'plan' | 'commandApproval' | 'fileApproval' | 'permissionsApproval';
};

function extractPendingRequests(params: unknown): PendingRequestSummary[] {
  if (!params || typeof params !== 'object') {
    return [];
  }
  const change = (params as { change?: unknown }).change;
  if (!change || typeof change !== 'object') {
    return [];
  }
  const conversationState = (change as { conversationState?: unknown }).conversationState;
  if (!conversationState || typeof conversationState !== 'object') {
    return [];
  }
  const requests = (conversationState as { requests?: unknown }).requests;
  if (!Array.isArray(requests)) {
    return [];
  }
  const summaries: PendingRequestSummary[] = [];
  for (const raw of requests) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const req = raw as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      isCompleted?: unknown;
    };
    if (req.isCompleted) {
      continue;
    }
    const method = typeof req.method === 'string' ? req.method : '';
    const id = typeof req.id === 'string' ? req.id : '';
    if (!method || !id) {
      continue;
    }
    if (method === 'item/tool/requestUserInput') {
      const params = (req.params ?? {}) as { questions?: unknown; turnId?: unknown };
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const first = questions[0] as { header?: string; question?: string } | undefined;
      summaries.push({
        id,
        method,
        kind: 'question',
        title: first?.header ?? 'Codex needs more information',
        body: first?.question,
        turnId: typeof params.turnId === 'string' ? params.turnId : undefined
      });
    } else if (method === 'item/plan/requestImplementation') {
      const params = (req.params ?? {}) as { planContent?: unknown; turnId?: unknown };
      const planContent = typeof params.planContent === 'string' ? params.planContent : undefined;
      summaries.push({
        id,
        method,
        kind: 'plan',
        title: 'Implement this plan?',
        body: planContent,
        turnId: typeof params.turnId === 'string' ? params.turnId : undefined
      });
    } else if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval'
    ) {
      const params = (req.params ?? {}) as { itemId?: unknown; turnId?: unknown };
      summaries.push({
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
              : 'Approve permissions?',
        itemId: typeof params.itemId === 'string' ? params.itemId : undefined,
        turnId: typeof params.turnId === 'string' ? params.turnId : undefined
      });
    }
  }
  return summaries;
}

function extractLatestModel(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') {
    return undefined;
  }
  const change = (params as { change?: unknown }).change;
  if (!change || typeof change !== 'object') {
    return undefined;
  }
  const snapshotState = (change as { conversationState?: unknown }).conversationState;
  if (snapshotState && typeof snapshotState === 'object') {
    const direct = (snapshotState as { latestModel?: unknown }).latestModel;
    if (typeof direct === 'string' && direct.trim().length > 0) {
      return direct.trim();
    }
    const collab = (snapshotState as { latestCollaborationMode?: { settings?: { model?: unknown } } })
      .latestCollaborationMode;
    const collabModel = collab?.settings?.model;
    if (typeof collabModel === 'string' && collabModel.trim().length > 0) {
      return collabModel.trim();
    }
  }
  return undefined;
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
  return {
    ...current,
    [transcript.threadId]: cacheableTranscript(transcript)
  };
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
  const [streamingThreadIds, setStreamingThreadIds] = useState<Set<string>>(() => new Set());
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
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);

    try {
      const nextHealth = await fetchHealth(controller.signal);
      setHealth(nextHealth);
      window.clearTimeout(timeout);

      if (!session) {
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
      const nextThreads = await fetchThreads(session);
      setThreads(nextThreads);
      setThreadsLoaded(true);
      fetchProjects(session).then(setProjects).catch(() => setProjects([]));
      fetchCatalogPlugins(session).then(setPlugins).catch(() => setPlugins([]));
      fetchCatalogSkills(session).then(setSkills).catch(() => setSkills([]));
      fetchCatalogCommands(session).then(setCommands).catch(() => setCommands([]));
      fetchCatalogModels(session).then(setModels).catch(() => setModels([]));
      setScreen((current) => (ADMIN_FLEX_SCREENS.has(current) ? current : 'dashboard'));
    } catch (error) {
      window.clearTimeout(timeout);
      if (error instanceof Response && error.status === 403) {
        setScreen('revoked');
        return;
      }
      if (error instanceof Response && error.status === 401) {
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
  }, [session]);

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
        }

        if (liveEvent.type === 'thread/remove') {
          setThreads((current) =>
            current.filter((thread) => thread.threadId !== liveEvent.payload.threadId)
          );
          setTranscripts((current) => removeTranscriptCache(current, liveEvent.payload.threadId));
        }

        if (liveEvent.type === 'thread/transcript/changed') {
          setTranscripts((current) => upsertTranscriptCache(current, liveEvent.payload));
          // Also hydrate the model state from the transcript — Codex doesn't always emit a
          // standalone model-changed event, so this keeps the chip in sync regardless.
          if (liveEvent.payload.model) {
            const transcriptModel = liveEvent.payload.model;
            const transcriptThreadId = liveEvent.payload.threadId;
            setThreadModels((current) =>
              current[transcriptThreadId] === transcriptModel
                ? current
                : { ...current, [transcriptThreadId]: transcriptModel }
            );
          }
        }

        if (liveEvent.type === 'thread/streaming-changed') {
          const { threadId, isStreaming } = liveEvent.payload;
          setStreamingThreadIds((current) => {
            const next = new Set(current);
            if (isStreaming) {
              next.add(threadId);
            } else {
              next.delete(threadId);
            }
            return next;
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

        if (liveEvent.type === 'codex/broadcast') {
          const { method, params } = liveEvent.payload;
          const conversationId = extractConversationId(params);
          if (!conversationId) {
            return;
          }

          const liveModel = extractLatestModel(params);
          if (liveModel) {
            setThreadModels((current) =>
              current[conversationId] === liveModel
                ? current
                : { ...current, [conversationId]: liveModel }
            );
          }

          const pending = extractPendingRequests(params);
          if (method === 'thread-stream-state-changed') {
            setThreadPendingRequests((current) => ({
              ...current,
              [conversationId]: pending
            }));
          }

          if (
            method === 'thread-stream-state-changed' ||
            method === 'thread-queued-followups-changed' ||
            method === 'thread-archived' ||
            method === 'thread-unarchived' ||
            method === 'query-cache-invalidate'
          ) {
            void (async () => {
              try {
                const transcript = await fetchThreadTranscript(session, conversationId);
                setTranscripts((current) => upsertTranscriptCache(current, transcript));
                if (transcript.model) {
                  const refetchedModel = transcript.model;
                  setThreadModels((current) =>
                    current[conversationId] === refetchedModel
                      ? current
                      : { ...current, [conversationId]: refetchedModel }
                  );
                }
              } catch {
                // ignore — the next polling refresh or broadcast will retry
              }
            })();
          }
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
  }, [session]);

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
      if (transcript.model) {
        const fetchedModel = transcript.model;
        setThreadModels((current) =>
          current[threadId] === fetchedModel
            ? current
            : { ...current, [threadId]: fetchedModel }
        );
      }
      return transcript;
    },
    [session]
  );

  const handleSendMessage = useCallback(
    async (threadId: string, text: string) => {
      if (!session) {
        return Promise.reject(new Error('Not connected.'));
      }

      const result = await sendThreadMessage(session, threadId, text);
      setTranscripts((current) => upsertTranscriptCache(current, result.transcript));
      if (result.transcript.model) {
        const sentModel = result.transcript.model;
        setThreadModels((current) =>
          current[threadId] === sentModel ? current : { ...current, [threadId]: sentModel }
        );
      }
      return result;
    },
    [session]
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
          onOpenSettings={handleOpenAdmin}
          fetchTranscript={handleFetchTranscript}
          sendMessage={handleSendMessage}
          transcriptUpdates={transcripts}
          threadModels={threadModels}
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
                  await updateThreadModel(session, threadId, modelSlug, reasoningEffort);
                  setThreadModels((current) => ({
                    ...current,
                    [threadId]: modelSlug
                  }));
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
    handleOpenThreadInCodex,
    health,
    message,
    models,
    plugins,
    projects,
    refresh,
    screen,
    session,
    skills,
    threadModels,
    threadPendingRequests,
    threads,
    threadsLoaded,
    transcripts
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
  onPair
}: {
  adminToken: string;
  onBack: () => void;
  onSignOut: () => void;
  onAdminExpired: () => void;
  onPair: (input: PairingSubmission) => Promise<void>;
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
          <p className="eyebrow">Local helper</p>
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
