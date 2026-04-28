import { describe, expect, it } from 'vitest';
import {
  ChatMessageSchema,
  HelperHealthSchema,
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
    expect(() => ThreadMessageRequestSchema.parse({ text: '' })).toThrow();
    expect(() => ThreadMessageRequestSchema.parse({ text: 'x'.repeat(4001) })).toThrow();
  });

  it('allows a new thread request from a saved project or a folder path', () => {
    expect(ThreadCreateRequestSchema.parse({ projectId: 'project-codexpulse' })).toEqual({
      projectId: 'project-codexpulse'
    });
    expect(ThreadCreateRequestSchema.parse({ cwd: '  /Users/me/projects/CodexPulse  ' })).toEqual({
      cwd: '/Users/me/projects/CodexPulse'
    });
    expect(() => ThreadCreateRequestSchema.parse({})).toThrow();
    expect(() =>
      ThreadCreateRequestSchema.parse({
        projectId: 'project-codexpulse',
        cwd: '/Users/me/projects/CodexPulse'
      })
    ).toThrow();
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
