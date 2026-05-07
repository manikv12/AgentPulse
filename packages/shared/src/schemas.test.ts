import { describe, expect, it } from 'vitest';
import {
  ChatMessageSchema,
  AppearanceSettingsUpdateRequestSchema,
  HelperHealthSchema,
  ImportedCodexThemeSchema,
  LiveEventSchema,
  PairRequestSchema,
  PairResponseSchema,
  PairingDeviceListResponseSchema,
  RemoteAccessSettingsSchema,
  ThreadCreateRequestSchema,
  ThreadMessageRequestSchema,
  ThreadTranscriptSchema,
  ThreadSchema,
  maskToken
} from './index';

describe('shared schemas', () => {
  it('accepts the v1 thread payload shape', () => {
    const parsed = ThreadSchema.parse({
      threadId: '019dc68a-aedf-70f0-901e-825a65116744',
      title: 'Plan modern UI implementation',
      workspace: 'Agent Pulse',
      status: 'waiting_approval',
      lastActivityAt: '2026-04-25T16:14:00Z',
      lastTurnSummary: ''
    });

    expect(parsed.workspace).toBe('Agent Pulse');
  });

  it('rejects raw rollout fields that must not be sent to the tablet', () => {
    expect(() =>
      ThreadSchema.strict().parse({
        threadId: 't1',
        title: 'Private rollout',
        workspace: 'SecretProject',
        status: 'idle',
        lastActivityAt: '2026-04-25T16:14:00Z',
        lastTurnSummary: '',
        rolloutPath: '/Users/me/.codex/sessions/private.jsonl'
      })
    ).toThrow();
  });

  it('validates health and live event payloads', () => {
    const health = HelperHealthSchema.parse({
      status: 'ok',
      codexAppServer: 'connected',
      version: '0.1.0',
      uptimeSec: 12,
      remoteAccess: {
        enabled: true,
        provider: 'cloudflare',
        mode: 'quick',
        status: 'healthy',
        publicUrl: 'https://pulse.example.com',
        hostname: 'pulse.example.com',
        checklist: {
          dependencyInstalled: true,
          authenticated: true,
          configured: true,
          tunnelRunning: true,
          hostnameAssigned: true
        }
      }
    });

    expect(
      LiveEventSchema.parse({
        type: 'health/changed',
        payload: health
      }).payload
    ).toEqual(health);
  });

  it('validates per-token assistant streaming events', () => {
    const delta = LiveEventSchema.parse({
      type: 'thread/assistant/text-delta',
      payload: {
        threadId: 'claude-code:session-1',
        messageId: 'claude-assistant:turn-1',
        delta: 'Hel'
      }
    });
    expect(delta.type).toBe('thread/assistant/text-delta');

    const end = LiveEventSchema.parse({
      type: 'thread/assistant/text-end',
      payload: {
        threadId: 'claude-code:session-1',
        messageId: 'claude-assistant:turn-1'
      }
    });
    expect(end.type).toBe('thread/assistant/text-end');

    expect(() =>
      LiveEventSchema.parse({
        type: 'thread/assistant/text-delta',
        payload: { threadId: '', messageId: 'm', delta: 'x' }
      })
    ).toThrow();
  });

  it('validates remote access settings for the admin settings payload', () => {
    const settings = RemoteAccessSettingsSchema.parse({
      enabled: false,
      provider: 'cloudflare',
      mode: 'quick',
      tunnelProtocol: 'http2',
      hostname: '',
      publicUrl: '',
      tunnelName: 'agent-pulse',
      tunnelId: '',
      configPath: '/Users/me/Library/Application Support/Agent Pulse/cloudflared/config.yml',
      metricsUrl: 'http://127.0.0.1:60123/metrics',
      status: 'off',
      lastError: '',
      lastStartedAt: null,
      lastStoppedAt: '2026-04-26T10:00:00Z',
      lastCheckedAt: '2026-04-26T10:00:00Z',
      checklist: {
        dependencyInstalled: false,
        authenticated: false,
        configured: false,
        tunnelRunning: false,
        hostnameAssigned: false
      }
    });

    expect(settings.status).toBe('off');
    expect(settings.tunnelProtocol).toBe('http2');
    expect(settings.checklist.dependencyInstalled).toBe(false);
  });

  it('validates imported Codex themes for appearance settings', () => {
    const importedTheme = ImportedCodexThemeSchema.parse({
      codeThemeId: 'notion',
      theme: {
        accent: '#3183D8',
        contrast: 45,
        fonts: { code: null, ui: null },
        ink: '#37352F',
        opaqueWindows: true,
        semanticColors: {
          diffAdded: '#008000',
          diffRemoved: '#a31515',
          skill: '#0000ff'
        },
        surface: '#ffffff'
      },
      variant: 'light'
    });

    expect(importedTheme.theme.accent).toBe('#3183d8');
    expect(importedTheme.variant).toBe('light');
    expect(
      AppearanceSettingsUpdateRequestSchema.parse({
        codexTheme: importedTheme,
        themePreference: 'light'
      }).themePreference
    ).toBe('light');
  });

  it('masks tokens without printing the full secret', () => {
    expect(maskToken('tok_1234567890abcdef')).toBe('tok_...cdef');
  });

  it('validates mobile chat transcript and message payloads', () => {
    const message = ChatMessageSchema.parse({
      id: 'message-1',
      role: 'assistant',
      kind: 'message',
      text: 'I can work on that.',
      attachments: [
        {
          id: 'message-1-image-1',
          kind: 'image',
          url: 'data:image/png;base64,iVBORw0KGgo=',
          alt: 'Screenshot'
        }
      ],
      createdAt: '2026-04-25T16:14:00Z'
    });

    const transcript = ThreadTranscriptSchema.parse({
      threadId: 'thread-1',
      activeTurnId: null,
      sendState: {
        canSend: true,
        reason: 'ready',
        label: 'Ready'
      },
      messages: [message]
    });

    expect(transcript.messages[0]?.text).toBe('I can work on that.');
    expect(transcript.messages[0]?.attachments?.[0]?.url).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(ThreadMessageRequestSchema.parse({ text: '  continue  ' }).text).toBe('continue');
    expect(
      ThreadMessageRequestSchema.parse({
        attachments: [
          {
            id: 'pasted-image-1',
            kind: 'image',
            url: 'data:image/png;base64,iVBORw0KGgo=',
            mimeType: 'image/png'
          }
        ]
      }).attachments?.[0]?.mimeType
    ).toBe('image/png');
    expect(() => ThreadMessageRequestSchema.parse({ text: '' })).toThrow();
    expect(() => ThreadMessageRequestSchema.parse({ text: 'x'.repeat(4001) })).toThrow();
  });

  it('allows a new thread request from shared chats, a saved project, or a folder path', () => {
    expect(ThreadCreateRequestSchema.parse({ location: 'chat' })).toEqual({
      provider: 'codex',
      location: 'chat'
    });
    expect(ThreadCreateRequestSchema.parse({ projectId: 'project-codexpulse' })).toEqual({
      provider: 'codex',
      projectId: 'project-codexpulse'
    });
    expect(ThreadCreateRequestSchema.parse({ cwd: '  /Users/me/projects/CodexPulse  ' })).toEqual({
      provider: 'codex',
      cwd: '/Users/me/projects/CodexPulse'
    });
    expect(
      ThreadCreateRequestSchema.parse({
        provider: 'claude-code',
        projectId: 'project-codexpulse'
      })
    ).toEqual({
      provider: 'claude-code',
      projectId: 'project-codexpulse'
    });
    expect(
      ThreadCreateRequestSchema.parse({
        provider: 'copilot',
        projectId: 'project-codexpulse',
        modelSlug: 'gpt-5.2',
        reasoningEffort: 'high'
      })
    ).toEqual({
      provider: 'copilot',
      projectId: 'project-codexpulse',
      modelSlug: 'gpt-5.2',
      reasoningEffort: 'high'
    });
    expect(
      ThreadCreateRequestSchema.parse({
        location: 'chat',
        permissionMode: 'autoReview'
      })
    ).toEqual({
      provider: 'codex',
      location: 'chat',
      permissionMode: 'autoReview'
    });
    expect(() => ThreadCreateRequestSchema.parse({})).toThrow();
    expect(() =>
      ThreadCreateRequestSchema.parse({
        location: 'chat',
        permissionMode: 'sandbox'
      })
    ).toThrow();
    expect(() =>
      ThreadCreateRequestSchema.parse({
        location: 'chat',
        permissionMode: 'auto'
      })
    ).toThrow();
    expect(() =>
      ThreadCreateRequestSchema.parse({
        location: 'chat',
        projectId: 'project-codexpulse'
      })
    ).toThrow();
    expect(() =>
      ThreadCreateRequestSchema.parse({
        projectId: 'project-codexpulse',
        cwd: '/Users/me/projects/CodexPulse'
      })
    ).toThrow();
  });

  it('accepts Copilot transcripts with named rate-limit windows', () => {
    const transcript = ThreadTranscriptSchema.parse({
      threadId: 'copilot:session-1',
      provider: 'copilot',
      providerThreadId: 'session-1',
      activeTurnId: null,
      sendState: { canSend: true, reason: 'ready', label: 'Send' },
      messages: [],
      usage: {
        primaryWindow: { label: 'Premium', usedPercent: 25 },
        secondaryWindow: { label: 'Chat', usedPercent: 10 }
      }
    });

    expect(transcript.provider).toBe('copilot');
    expect(transcript.usage?.primaryWindow?.label).toBe('Premium');
  });

  it('validates pairing for a new device or a saved device', () => {
    expect(
      PairRequestSchema.parse({
        pin: '123456',
        deviceName: 'Desk tablet',
        fingerprint: 'browser-fingerprint'
      })
    ).toEqual({
      pin: '123456',
      deviceName: 'Desk tablet',
      fingerprint: 'browser-fingerprint'
    });

    expect(
      PairRequestSchema.parse({
        pin: '123456',
        existingDeviceId: 'device-1',
        fingerprint: 'browser-fingerprint'
      })
    ).toEqual({
      pin: '123456',
      existingDeviceId: 'device-1',
      fingerprint: 'browser-fingerprint'
    });

    expect(() =>
      PairRequestSchema.parse({
        pin: '123456',
        deviceName: 'Desk tablet',
        existingDeviceId: 'device-1',
        fingerprint: 'browser-fingerprint'
      })
    ).toThrow();

    expect(() =>
      PairRequestSchema.parse({
        pin: '123456',
        fingerprint: 'browser-fingerprint'
      })
    ).toThrow();

    expect(
      PairResponseSchema.parse({
        token: 'token-1234567890',
        deviceId: 'device-1',
        deviceName: 'Desk tablet'
      }).deviceName
    ).toBe('Desk tablet');

    expect(
      PairingDeviceListResponseSchema.parse({
        devices: [
          {
            deviceId: 'device-1',
            deviceName: 'Desk tablet',
            lastSeenAt: '2026-04-26T10:00:00Z'
          }
        ]
      }).devices[0]?.deviceName
    ).toBe('Desk tablet');
  });
});
