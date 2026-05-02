import { z } from 'zod';

export const THREAD_STATUSES = [
  'idle',
  'running',
  'compacting',
  'waiting_approval',
  'error',
  'connection',
  'unknown'
] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const AGENT_PROVIDERS = ['codex', 'claude-code', 'copilot'] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const THREAD_STATUS_PRIORITY = [
  'error',
  'connection',
  'waiting_approval',
  'compacting',
  'running',
  'idle',
  'unknown'
] as const satisfies readonly ThreadStatus[];

const isoUtcTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, {
    message: 'Timestamp must be ISO-8601 UTC with trailing Z'
  });

export const ThreadStatusSchema = z.enum(THREAD_STATUSES);
export const AgentProviderSchema = z.enum(AGENT_PROVIDERS);

export const ThreadSchema = z.object({
  threadId: z.string().min(1),
  provider: AgentProviderSchema.default('codex'),
  providerThreadId: z.string().min(1).optional(),
  title: z.string().min(1),
  workspace: z.string().min(1),
  workspacePath: z.string().min(1).optional(),
  workspaceKind: z.enum(['project', 'chat']).optional(),
  status: ThreadStatusSchema,
  lastActivityAt: isoUtcTimestamp,
  lastTurnSummary: z.string(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional()
});

export type Thread = z.input<typeof ThreadSchema>;

export const ProjectSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  providers: z.array(AgentProviderSchema).default(['codex'])
});

export type Project = z.input<typeof ProjectSchema>;

export const HelperHealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  codexAppServer: z.enum(['connected', 'disconnected']),
  version: z.string().min(1),
  uptimeSec: z.number().int().nonnegative(),
  remoteAccess: z
    .object({
      enabled: z.boolean(),
      provider: z.literal('cloudflare'),
      mode: z.enum(['quick', 'named']).default('quick'),
      status: z.enum(['off', 'starting', 'healthy', 'degraded', 'disconnected']),
      publicUrl: z.string(),
      hostname: z.string(),
      checklist: z.object({
        dependencyInstalled: z.boolean(),
        authenticated: z.boolean(),
        configured: z.boolean(),
        tunnelRunning: z.boolean(),
        hostnameAssigned: z.boolean()
      }),
      lastError: z.string().optional()
    })
    .optional()
});

export type HelperHealth = z.infer<typeof HelperHealthSchema>;

export const RemoteAccessChecklistSchema = z.object({
  dependencyInstalled: z.boolean(),
  authenticated: z.boolean(),
  configured: z.boolean(),
  tunnelRunning: z.boolean(),
  hostnameAssigned: z.boolean()
});

export type RemoteAccessChecklist = z.infer<typeof RemoteAccessChecklistSchema>;

export const RemoteAccessStatusSchema = z.enum([
  'off',
  'starting',
  'healthy',
  'degraded',
  'disconnected'
]);

export type RemoteAccessStatus = z.infer<typeof RemoteAccessStatusSchema>;

export const RemoteAccessModeSchema = z.enum(['quick', 'named']);

export type RemoteAccessMode = z.infer<typeof RemoteAccessModeSchema>;

export const RemoteAccessProtocolSchema = z.enum(['auto', 'quic', 'http2']);

export type RemoteAccessProtocol = z.infer<typeof RemoteAccessProtocolSchema>;

export const RemoteAccessSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.literal('cloudflare'),
  mode: RemoteAccessModeSchema.default('quick'),
  tunnelProtocol: RemoteAccessProtocolSchema.default('auto'),
  hostname: z.string(),
  publicUrl: z.string(),
  tunnelName: z.string().min(1),
  tunnelId: z.string(),
  configPath: z.string().min(1),
  metricsUrl: z.string().min(1),
  status: RemoteAccessStatusSchema,
  lastError: z.string(),
  lastStartedAt: isoUtcTimestamp.nullable(),
  lastStoppedAt: isoUtcTimestamp.nullable(),
  lastCheckedAt: isoUtcTimestamp.nullable(),
  checklist: RemoteAccessChecklistSchema
});

export type RemoteAccessSettings = z.infer<typeof RemoteAccessSettingsSchema>;

export const RemoteActivityLogEntrySchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'connect',
    'disconnect',
    'pairing',
    'reconnect',
    'revoke',
    'auth_failure',
    'origin_reject',
    'rate_limit'
  ]),
  createdAt: isoUtcTimestamp,
  deviceId: z.string().min(1).optional(),
  sourceIp: z.string().min(1).optional(),
  reason: z.string().min(1)
});

export type RemoteActivityLogEntry = z.infer<typeof RemoteActivityLogEntrySchema>;

export const PairRequestSchema = z.object({
  pin: z.string().min(4).max(12),
  deviceName: z.string().trim().min(1).max(80).optional(),
  existingDeviceId: z.string().trim().min(1).optional(),
  fingerprint: z.string().min(8).max(240)
}).superRefine((value, context) => {
  const hasDeviceName = Boolean(value.deviceName?.trim());
  const hasExistingDeviceId = Boolean(value.existingDeviceId?.trim());

  if (hasDeviceName === hasExistingDeviceId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Choose a saved device or enter a new device name.',
      path: ['deviceName']
    });
  }
});

export const PairingDeviceOptionSchema = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string().min(1).max(80),
  lastSeenAt: isoUtcTimestamp.optional()
});

export type PairingDeviceOption = z.infer<typeof PairingDeviceOptionSchema>;

export const PairingDeviceListResponseSchema = z.object({
  devices: z.array(PairingDeviceOptionSchema)
});

export const PairResponseSchema = z.object({
  token: z.string().min(16),
  deviceId: z.string().min(1),
  deviceName: z.string().min(1).max(80)
});

export const DeviceSessionRecoveryRequestSchema = z.object({
  deviceId: z.string().trim().min(1),
  fingerprint: z.string().min(8).max(240)
});

export const ThreadOpenRequestSchema = z.object({
  threadId: z.string().min(1),
  mode: z.enum(['open', 'sync']).optional()
});

export const ThreadCreateRequestSchema = z
  .object({
    provider: AgentProviderSchema.default('codex'),
    location: z.enum(['chat']).optional(),
    projectId: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
    modelSlug: z.string().trim().min(1).optional(),
    reasoningEffort: z.string().trim().min(1).optional()
  })
  .refine((value) => {
    const targetCount = [value.location === 'chat', Boolean(value.projectId), Boolean(value.cwd)]
      .filter(Boolean).length;
    return targetCount === 1;
  }, {
    message: 'Choose a chat, project, or folder path.'
  });

export const CHAT_MESSAGE_ROLES = ['user', 'assistant', 'activity', 'system'] as const;
export const CHAT_MESSAGE_KINDS = [
  'message',
  'plan',
  'reasoning',
  'command',
  'file',
  'tool',
  'status'
] as const;

export const ChatAttachmentSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('image'),
  url: z.string().min(1),
  alt: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  sourcePath: z.string().min(1).optional()
});

export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const THREAD_SEND_REASONS = [
  'ready',
  'mobile_send_disabled',
  'app_server_disconnected',
  'waiting_on_approval',
  'waiting_on_user_input',
  'compacting_context',
  'missing_active_turn',
  'thread_unavailable',
  'thread_changed'
] as const;

export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(CHAT_MESSAGE_ROLES),
  kind: z.enum(CHAT_MESSAGE_KINDS),
  text: z.string(),
  attachments: z.array(ChatAttachmentSchema).optional(),
  phase: z.string().min(1).optional(),
  createdAt: isoUtcTimestamp
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ThreadSendStateSchema = z.object({
  canSend: z.boolean(),
  reason: z.enum(THREAD_SEND_REASONS),
  label: z.string().min(1)
});

export type ThreadSendState = z.infer<typeof ThreadSendStateSchema>;

export const ThreadRateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  label: z.string().min(1).optional(),
  windowMinutes: z.number().optional(),
  resetsAt: z.number().optional()
});

export const ThreadUsageSchema = z.object({
  contextTokens: z.number().optional(),
  contextWindow: z.number().optional(),
  contextUsedPercent: z.number().optional(),
  primaryWindow: ThreadRateLimitWindowSchema.optional(),
  secondaryWindow: ThreadRateLimitWindowSchema.optional(),
  planType: z.string().optional()
});

export type ThreadUsage = z.infer<typeof ThreadUsageSchema>;

export const ThreadTranscriptSchema = z.object({
  threadId: z.string().min(1),
  provider: AgentProviderSchema.default('codex'),
  providerThreadId: z.string().min(1).optional(),
  activeTurnId: z.string().min(1).nullable(),
  sendState: ThreadSendStateSchema,
  messages: z.array(ChatMessageSchema),
  usage: ThreadUsageSchema.optional(),
  // Current model + reasoning effort recorded for this conversation. Sourced from the
  // thread/resume response so the tablet stays in sync with whatever the desktop changed
  // without us needing to listen for the snapshot broadcast.
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional()
});

export type ThreadTranscript = z.input<typeof ThreadTranscriptSchema>;

// Response shape for the "load older messages" endpoint. Distinct from a full
// transcript fetch because it only carries a window of messages and a flag
// telling the client whether more history is available.
export const OlderThreadMessagesResponseSchema = z.object({
  threadId: z.string().min(1),
  messages: z.array(ChatMessageSchema),
  hasMore: z.boolean()
});

export type OlderThreadMessagesResponse = z.infer<typeof OlderThreadMessagesResponseSchema>;

export const COLLABORATION_MODES = ['default', 'plan'] as const;

export type CollaborationModeKind = (typeof COLLABORATION_MODES)[number];

export const ThreadMessageRequestSchema = z
  .object({
    text: z.string().trim().max(4000).optional().default(''),
    collaborationMode: z.enum(COLLABORATION_MODES).optional(),
    attachments: z.array(ChatAttachmentSchema).max(6).optional()
  })
  .superRefine((payload, context) => {
    if (payload.text || (payload.attachments?.length ?? 0) > 0) {
      return;
    }
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['text'],
      message: 'Message text or an image attachment is required.'
    });
  });

export const ThreadMessageResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(['start', 'steer']),
  turnId: z.string().min(1),
  transcript: ThreadTranscriptSchema
});

export type ThreadMessageResponse = z.input<typeof ThreadMessageResponseSchema>;

export const ThreadStopResponseSchema = z.object({
  ok: z.literal(true)
});

export type ThreadStopResponse = z.infer<typeof ThreadStopResponseSchema>;

export const ThreadDeleteResponseSchema = z.object({
  ok: z.literal(true)
});

export type ThreadDeleteResponse = z.infer<typeof ThreadDeleteResponseSchema>;

export const DeviceRevokeRequestSchema = z.object({
  deviceId: z.string().min(1)
});

export const ThreadListResponseSchema = z.object({
  threads: z.array(ThreadSchema)
});

export const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectSchema)
});

export const ThreadCreateResponseSchema = z.object({
  thread: ThreadSchema
});

export const CatalogPluginSchema = z.object({
  slug: z.string().min(1),
  marketplace: z.string().min(1),
  qualifiedSlug: z.string().min(1),
  displayName: z.string().min(1),
  shortDescription: z.string().optional(),
  longDescription: z.string().optional(),
  category: z.string().optional(),
  developerName: z.string().optional(),
  websiteUrl: z.string().optional(),
  enabled: z.boolean(),
  iconUrl: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).optional()
});

export type CatalogPlugin = z.infer<typeof CatalogPluginSchema>;

export const CatalogSkillSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  argumentHint: z.string().optional(),
  source: z.enum(['user', 'project']),
  scopePath: z.string().optional(),
  iconUrl: z.string().min(1).optional()
});

export type CatalogSkill = z.infer<typeof CatalogSkillSchema>;

export const CatalogCommandSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  builtIn: z.boolean()
});

export type CatalogCommand = z.infer<typeof CatalogCommandSchema>;

export const CatalogReasoningEffortSchema = z.object({
  effort: z.string().min(1),
  description: z.string().optional()
});

export const CatalogModelSchema = z.object({
  slug: z.string().min(1),
  displayName: z.string().min(1),
  provider: AgentProviderSchema.optional(),
  description: z.string().optional(),
  defaultReasoningLevel: z.string().optional(),
  supportedReasoningLevels: z.array(CatalogReasoningEffortSchema).optional(),
  visibility: z.string().optional(),
  priority: z.number().optional()
});

export type CatalogModel = z.infer<typeof CatalogModelSchema>;

export const CatalogPluginsResponseSchema = z.object({
  plugins: z.array(CatalogPluginSchema)
});

export const CatalogSkillsResponseSchema = z.object({
  skills: z.array(CatalogSkillSchema)
});

export const CatalogCommandsResponseSchema = z.object({
  commands: z.array(CatalogCommandSchema)
});

export const CatalogModelsResponseSchema = z.object({
  models: z.array(CatalogModelSchema)
});

export const ProjectFilesResponseSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      relativePath: z.string().min(1)
    })
  ),
  truncated: z.boolean()
});

export type ProjectFilesResponse = z.infer<typeof ProjectFilesResponseSchema>;

export const ThreadModelUpdateRequestSchema = z.object({
  modelSlug: z.string().min(1),
  reasoningEffort: z.string().min(1).optional()
});

export const APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
  'item/tool/requestUserInput',
  'item/plan/requestImplementation',
  'mcpServer/elicitation/request',
  'claudeCode/canUseTool',
  'claudeCode/elicitation'
] as const;

export const ApprovalDecisionRequestSchema = z.object({
  method: z.enum(APPROVAL_METHODS),
  decision: z.union([z.string().min(1), z.record(z.string(), z.unknown())])
});

export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export const ApprovalDecisionResponseSchema = z.object({
  ok: z.literal(true)
});

// Approval request payload surfaced by the helper from Codex live state.
export const PendingApprovalRequestSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  // Free-form params blob from Codex (reason, permissions, turnId, itemId, ...).
  // Kept opaque so future Codex builds can add fields without breaking the wire
  // format — the tablet's existing `summarizePendingRequest` parses it.
  params: z.record(z.string(), z.unknown()).optional(),
  // Set when the approval was surfaced as a turn item (permissionRequest)
  // rather than a top-level conversation `requests` entry.
  itemId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional()
});

export type PendingApprovalRequest = z.infer<typeof PendingApprovalRequestSchema>;

export const ThreadModelUpdateResponseSchema = z.object({
  ok: z.literal(true),
  modelSlug: z.string().min(1),
  reasoningEffort: z.string().min(1).optional()
});

// Map of threadId -> "user last reviewed this at" epoch ms. The helper is the
// source of truth so the seen state is shared across every device paired with
// the same Mac.
export const SeenThreadActivityMapSchema = z.record(
  z.string().min(1),
  z.number().int().nonnegative()
);
export type SeenThreadActivityMap = z.infer<typeof SeenThreadActivityMapSchema>;

export const SeenThreadActivityResponseSchema = z.object({
  entries: SeenThreadActivityMapSchema
});
export type SeenThreadActivityResponse = z.infer<typeof SeenThreadActivityResponseSchema>;

export const SeenThreadActivityMarkRequestSchema = z.object({
  seenAt: z.number().int().nonnegative()
});
export type SeenThreadActivityMarkRequest = z.infer<typeof SeenThreadActivityMarkRequestSchema>;

export const SeenThreadActivityImportRequestSchema = z.object({
  entries: SeenThreadActivityMapSchema
});
export type SeenThreadActivityImportRequest = z.infer<typeof SeenThreadActivityImportRequestSchema>;

export const LiveEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('thread/upsert'),
    payload: ThreadSchema
  }),
  z.object({
    type: z.literal('thread/remove'),
    payload: z.object({ threadId: z.string().min(1) })
  }),
  z.object({
    type: z.literal('health/changed'),
    payload: HelperHealthSchema
  }),
  z.object({
    type: z.literal('thread/transcript/changed'),
    payload: ThreadTranscriptSchema
  }),
  z.object({
    type: z.literal('thread/status/changed'),
    payload: z.object({
      threadId: z.string().min(1),
      status: ThreadStatusSchema
    })
  }),
  z.object({
    type: z.literal('catalog/changed'),
    payload: z.object({
      kind: z.enum(['plugins', 'skills', 'commands', 'models'])
    })
  }),
  z.object({
    type: z.literal('thread/streaming-changed'),
    payload: z.object({
      threadId: z.string().min(1),
      isStreaming: z.boolean()
    })
  }),
  z.object({
    type: z.literal('thread/pending-approvals/changed'),
    payload: z.object({
      threadId: z.string().min(1),
      requests: z.array(PendingApprovalRequestSchema)
    })
  }),
  z.object({
    type: z.literal('thread/seen-activity/changed'),
    payload: z.object({
      threadId: z.string().min(1),
      seenAt: z.number().int().nonnegative()
    })
  }),
  // Per-token assistant streaming. Emitted by providers that can deliver text
  // word-by-word (currently Claude Code via stream_event). The tablet keeps a
  // partial-text overlay keyed on messageId until the matching `text-end`
  // arrives or the next full transcript snapshot supersedes it. Optional —
  // providers without per-token streaming simply do not emit these events and
  // the existing transcript snapshot path keeps working.
  z.object({
    type: z.literal('thread/assistant/text-delta'),
    payload: z.object({
      threadId: z.string().min(1),
      messageId: z.string().min(1),
      delta: z.string()
    })
  }),
  z.object({
    type: z.literal('thread/assistant/text-end'),
    payload: z.object({
      threadId: z.string().min(1),
      messageId: z.string().min(1)
    })
  })
]);

export type LiveEvent = z.input<typeof LiveEventSchema>;

export function resolveThreadStatus(signals: Iterable<ThreadStatus>): ThreadStatus {
  const signalSet = new Set(signals);

  for (const status of THREAD_STATUS_PRIORITY) {
    if (signalSet.has(status)) {
      return status;
    }
  }

  return 'unknown';
}

export function maskToken(token: string): string {
  if (token.length <= 8) {
    return '****';
  }

  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
