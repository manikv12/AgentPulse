import { z } from 'zod';

export const THREAD_STATUSES = [
  'idle',
  'running',
  'waiting_approval',
  'error',
  'connection',
  'unknown'
] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const THREAD_STATUS_PRIORITY = [
  'error',
  'connection',
  'waiting_approval',
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

export const ThreadSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1),
  workspace: z.string().min(1),
  status: ThreadStatusSchema,
  lastActivityAt: isoUtcTimestamp,
  lastTurnSummary: z.string(),
  model: z.string().optional()
});

export type Thread = z.infer<typeof ThreadSchema>;

export const ProjectSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1)
});

export type Project = z.infer<typeof ProjectSchema>;

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

export const ThreadOpenRequestSchema = z.object({
  threadId: z.string().min(1),
  mode: z.enum(['open', 'sync']).optional()
});

export const ThreadCreateRequestSchema = z
  .object({
    projectId: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional()
  })
  .refine((value) => Boolean(value.projectId) !== Boolean(value.cwd), {
    message: 'Choose a project or folder path.'
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
  sourcePath: z.string().min(1).optional()
});

export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const THREAD_SEND_REASONS = [
  'ready',
  'mobile_send_disabled',
  'app_server_disconnected',
  'waiting_on_approval',
  'waiting_on_user_input',
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
  activeTurnId: z.string().min(1).nullable(),
  sendState: ThreadSendStateSchema,
  messages: z.array(ChatMessageSchema),
  usage: ThreadUsageSchema.optional()
});

export type ThreadTranscript = z.infer<typeof ThreadTranscriptSchema>;

export const ThreadMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(4000)
});

export const ThreadMessageResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(['start', 'steer']),
  turnId: z.string().min(1),
  transcript: ThreadTranscriptSchema
});

export type ThreadMessageResponse = z.infer<typeof ThreadMessageResponseSchema>;

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
  scopePath: z.string().optional()
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
  'item/permissions/requestApproval'
] as const;

export const ApprovalDecisionRequestSchema = z.object({
  method: z.enum(APPROVAL_METHODS),
  decision: z.union([z.string().min(1), z.record(z.string(), z.unknown())])
});

export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export const ApprovalDecisionResponseSchema = z.object({
  ok: z.literal(true)
});

export const ThreadModelUpdateResponseSchema = z.object({
  ok: z.literal(true),
  modelSlug: z.string().min(1),
  reasoningEffort: z.string().min(1).optional()
});

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
    type: z.literal('codex/broadcast'),
    payload: z.object({
      method: z.string().min(1),
      sourceClientId: z.string().min(1),
      params: z.unknown()
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
  })
]);

export type LiveEvent = z.infer<typeof LiveEventSchema>;

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
