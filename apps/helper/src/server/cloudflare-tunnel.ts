import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RemoteAccessMode, RemoteAccessProtocol, RemoteAccessSettings } from '@agent-pulse/shared';
import type { HelperSettings, HelperSettingsStore } from './settings';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileLike = (file: string, args: string[], callback: ExecFileCallback) => void;
type SpawnLike = (
  file: string,
  args: string[],
  options: { stdio: Array<'ignore' | 'pipe'>; detached?: boolean }
) => TunnelChildProcess;

type EventTargetLike = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};

type TunnelChildProcess = EventTargetLike & {
  kill(signal?: string): unknown;
  killed: boolean;
  stdout?: EventTargetLike | null;
  stderr?: EventTargetLike | null;
  unref?: () => void;
};

export type RemoteAccessConfigureInput = {
  enabled?: boolean;
  mode?: RemoteAccessMode;
  tunnelProtocol?: RemoteAccessProtocol;
  hostname?: string;
  tunnelName?: string;
};

export type CloudflareTunnelSupervisorOptions = {
  settings: HelperSettings;
  settingsStore: HelperSettingsStore;
  helperPort: number;
  execFile?: ExecFileLike;
  spawn?: SpawnLike;
  certPath?: string;
  now?: () => Date;
  fetchText?: (url: string) => Promise<string>;
  quickUrlTimeoutMs?: number;
};

export class CloudflareTunnelSupervisor {
  private settings: HelperSettings;
  private child?: TunnelChildProcess;
  private readonly execFile: ExecFileLike;
  private readonly spawn: SpawnLike;
  private readonly certPath: string;
  private readonly now: () => Date;
  private readonly fetchText: (url: string) => Promise<string>;
  private readonly quickUrlTimeoutMs: number;

  constructor(private readonly options: CloudflareTunnelSupervisorOptions) {
    this.settings = options.settings;
    this.execFile = options.execFile ?? nodeExecFile;
    this.spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
    this.certPath = options.certPath ?? path.join(homedir(), '.cloudflared', 'cert.pem');
    this.now = options.now ?? (() => new Date());
    this.fetchText = options.fetchText ?? (async (url) => {
      const response = await fetch(url);
      return response.text();
    });
    this.quickUrlTimeoutMs = options.quickUrlTimeoutMs ?? 15000;
  }

  getStatus(): RemoteAccessSettings {
    return this.settings.remoteAccess;
  }

  async check(): Promise<RemoteAccessSettings> {
    const mode = this.remoteMode();
    const dependencyInstalled = await this.isCloudflaredInstalled();
    const authenticated = mode === 'quick' ? dependencyInstalled : await this.isAuthenticated();
    const configured = dependencyInstalled && this.isConfigured();
    const tunnelRunning = Boolean(this.child && !this.child.killed);
    if (mode === 'quick' && tunnelRunning && !this.settings.remoteAccess.publicUrl) {
      const publicUrl = await this.readQuickTunnelPublicUrl();
      if (publicUrl) {
        return this.applyQuickTunnelUrl(publicUrl);
      }
    }

    const hostnameAssigned = Boolean(this.settings.remoteAccess.hostname.trim() || this.settings.remoteAccess.publicUrl.trim());
    const status = this.settings.remoteAccess.enabled
      ? tunnelRunning
        ? 'healthy'
        : 'disconnected'
      : 'off';

    return this.updateRemoteAccess({
      status,
      lastCheckedAt: this.isoNow(),
      checklist: {
        dependencyInstalled,
        authenticated,
        configured,
        tunnelRunning,
        hostnameAssigned
      },
      lastError: dependencyInstalled ? this.settings.remoteAccess.lastError : 'Install cloudflared first.'
    });
  }

  async login(): Promise<RemoteAccessSettings> {
    if (this.remoteMode() === 'quick') {
      return this.updateRemoteAccess({
        lastError: 'Cloudflare login is not needed for a temporary Cloudflare URL.',
        lastCheckedAt: this.isoNow()
      });
    }

    if (!(await this.isCloudflaredInstalled())) {
      return this.updateRemoteAccess({
        status: this.settings.remoteAccess.enabled ? 'disconnected' : 'off',
        lastError: 'Install cloudflared first.'
      });
    }

    const child = this.spawn('cloudflared', ['tunnel', 'login'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true
    });
    child.unref?.();
    return this.updateRemoteAccess({
      lastError: 'Cloudflare login opened in your browser. Come back here after login finishes.',
      lastCheckedAt: this.isoNow()
    });
  }

  async configure(input: RemoteAccessConfigureInput): Promise<RemoteAccessSettings> {
    const mode = normalizeRemoteMode(input.mode ?? this.remoteMode());
    const tunnelProtocol = normalizeTunnelProtocol(
      input.tunnelProtocol ?? this.settings.remoteAccess.tunnelProtocol
    );
    if (mode === 'quick') {
      await this.updateRemoteAccess({
        mode,
        tunnelProtocol,
        hostname: '',
        publicUrl: '',
        lastCheckedAt: this.isoNow(),
        lastError: '',
        checklist: {
          ...this.settings.remoteAccess.checklist,
          hostnameAssigned: false
        }
      });
      return this.check();
    }

    const hostname = normalizeHostname(input.hostname ?? this.settings.remoteAccess.hostname);
    const tunnelName = normalizeTunnelName(input.tunnelName ?? this.settings.remoteAccess.tunnelName);
    const publicUrl = hostname ? `https://${hostname}` : '';
    let nextRemote: RemoteAccessSettings = {
      ...this.settings.remoteAccess,
      mode,
      tunnelProtocol,
      ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
      hostname,
      publicUrl,
      tunnelName,
      lastCheckedAt: this.isoNow(),
      lastError: ''
    };

    this.settings = {
      ...this.settings,
      remoteAccess: nextRemote
    };

    const dependencyInstalled = await this.isCloudflaredInstalled();
    const authenticated = await this.isAuthenticated();
    if (dependencyInstalled && authenticated && !nextRemote.tunnelId) {
      try {
        const created = await this.exec('cloudflared', ['tunnel', 'create', tunnelName]);
        const tunnelId = parseTunnelId(`${created.stdout}\n${created.stderr}`);
        nextRemote = {
          ...nextRemote,
          tunnelId,
          lastError: tunnelId ? '' : 'Tunnel was created, but Agent Pulse could not read the tunnel id.'
        };
        this.settings = { ...this.settings, remoteAccess: nextRemote };
      } catch (error) {
        nextRemote = {
          ...nextRemote,
          lastError: errorMessage(error, 'Could not create the Cloudflare tunnel.')
        };
        this.settings = { ...this.settings, remoteAccess: nextRemote };
      }
    }

    if (dependencyInstalled && authenticated && hostname) {
      await this.writeConfig().catch(() => undefined);
      await this.exec('cloudflared', ['tunnel', 'route', 'dns', tunnelName, hostname]).catch(() => undefined);
    }

    return this.check();
  }

  async writeConfig(): Promise<void> {
    const remote = this.settings.remoteAccess;
    if (this.remoteMode() === 'quick') {
      return;
    }

    const tunnelRef = remote.tunnelId || remote.tunnelName;
    const credentialsFile = remote.tunnelId
      ? path.join(homedir(), '.cloudflared', `${remote.tunnelId}.json`)
      : path.join(homedir(), '.cloudflared', `${remote.tunnelName}.json`);
    const body = [
      `tunnel: ${tunnelRef}`,
      `credentials-file: ${credentialsFile}`,
      '',
      'ingress:',
      `  - hostname: ${remote.hostname}`,
      `    service: http://127.0.0.1:${this.options.helperPort}`,
      '  - service: http_status:404',
      ''
    ].join('\n');

    await mkdir(path.dirname(remote.configPath), { recursive: true });
    await writeFile(remote.configPath, body, 'utf8');
  }

  async setEnabled(enabled: boolean): Promise<RemoteAccessSettings> {
    if (!enabled) {
      this.stopChild();
      const patch: Partial<RemoteAccessSettings> = {
        enabled: false,
        status: 'off',
        lastError: '',
        lastStoppedAt: this.isoNow(),
        checklist: {
          ...this.settings.remoteAccess.checklist,
          tunnelRunning: false,
          ...(this.remoteMode() === 'quick' ? { hostnameAssigned: false } : {})
        }
      };
      if (this.remoteMode() === 'quick') {
        patch.hostname = '';
        patch.publicUrl = '';
      }
      return this.updateRemoteAccess(patch);
    }

    const dependencyInstalled = await this.isCloudflaredInstalled();
    if (!dependencyInstalled) {
      return this.updateRemoteAccess({
        enabled: true,
        status: 'disconnected',
        lastError: 'Install cloudflared first.',
        lastCheckedAt: this.isoNow(),
        checklist: {
          ...this.settings.remoteAccess.checklist,
          dependencyInstalled: false,
          tunnelRunning: false
        }
      });
    }

    if (this.remoteMode() === 'quick') {
      return this.startQuickTunnel();
    }

    if (!this.isConfigured()) {
      return this.updateRemoteAccess({
        enabled: true,
        status: 'disconnected',
        lastError: 'Add a Cloudflare hostname and tunnel id before enabling remote access.',
        lastCheckedAt: this.isoNow()
      });
    }

    this.stopChild();
    await this.writeConfig();
    const metricsAddress = metricsAddressFromUrl(this.settings.remoteAccess.metricsUrl);
    const args = [
      'tunnel',
      '--protocol',
      this.settings.remoteAccess.tunnelProtocol,
      '--config',
      this.settings.remoteAccess.configPath,
      '--metrics',
      metricsAddress,
      'run',
      this.settings.remoteAccess.tunnelName
    ];
    this.child = this.spawn('cloudflared', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message && /error|failed|unable/i.test(message) && !isBenignStreamError(message)) {
        void this.updateRemoteAccess({ status: 'degraded', lastError: redactSecrets(message) });
      }
    });
    this.child.on('exit', () => {
      this.child = undefined;
      if (this.settings.remoteAccess.enabled) {
        void this.updateRemoteAccess({
          status: 'disconnected',
          lastError: 'Cloudflare tunnel stopped.',
          checklist: {
            ...this.settings.remoteAccess.checklist,
            tunnelRunning: false
          }
        });
      }
    });

    return this.updateRemoteAccess({
      enabled: true,
      status: 'healthy',
      lastError: '',
      lastStartedAt: this.isoNow(),
      checklist: {
        dependencyInstalled: true,
        authenticated: await this.isAuthenticated(),
        configured: true,
        tunnelRunning: true,
        hostnameAssigned: true
      }
    });
  }

  private async startQuickTunnel(): Promise<RemoteAccessSettings> {
    this.stopChild();
    const originUrl = `http://127.0.0.1:${this.options.helperPort}`;
    const metricsAddress = metricsAddressFromUrl(this.settings.remoteAccess.metricsUrl);
    this.child = this.spawn('cloudflared', ['tunnel', '--protocol', this.settings.remoteAccess.tunnelProtocol, '--metrics', metricsAddress, '--url', originUrl], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const waitForUrl = new Promise<RemoteAccessSettings | undefined>((resolve) => {
      const settle = (remoteAccess?: RemoteAccessSettings) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(remoteAccess);
      };

      const handleOutput = (chunk: unknown) => {
        const message = String(chunk).trim();
        const publicUrl = parseTryCloudflareUrl(message);
        if (publicUrl) {
          void this.applyQuickTunnelUrl(publicUrl).then(settle);
          return;
        }

        if (/error|failed|unable/i.test(message) && !isBenignStreamError(message)) {
          void this.updateRemoteAccess({ status: 'degraded', lastError: redactSecrets(message) });
        }
      };

      this.child?.stdout?.on('data', handleOutput);
      this.child?.stderr?.on('data', handleOutput);
      timeout = setTimeout(() => {
        void this.readQuickTunnelPublicUrl()
          .then((publicUrl) => (publicUrl ? this.applyQuickTunnelUrl(publicUrl) : undefined))
          .then(settle);
      }, this.quickUrlTimeoutMs);
      timeout.unref?.();
    });

    this.child.on('exit', () => {
      this.child = undefined;
      if (this.settings.remoteAccess.enabled) {
        void this.updateRemoteAccess({
          status: 'disconnected',
          lastError: 'Cloudflare tunnel stopped.',
          checklist: {
            ...this.settings.remoteAccess.checklist,
            tunnelRunning: false
          }
        });
      }
    });

    await this.updateRemoteAccess({
      enabled: true,
      mode: 'quick',
      status: 'starting',
      hostname: '',
      publicUrl: '',
      lastError: 'Waiting for Cloudflare to assign a public URL.',
      lastStartedAt: this.isoNow(),
      checklist: {
        dependencyInstalled: true,
        authenticated: true,
        configured: true,
        tunnelRunning: true,
        hostnameAssigned: false
      }
    });

    const assigned = await waitForUrl;
    return assigned ?? this.settings.remoteAccess;
  }

  private async applyQuickTunnelUrl(publicUrl: string): Promise<RemoteAccessSettings> {
    return this.updateRemoteAccess({
      enabled: true,
      mode: 'quick',
      status: 'healthy',
      publicUrl,
      hostname: hostnameFromUrl(publicUrl),
      lastError: '',
      lastCheckedAt: this.isoNow(),
      checklist: {
        dependencyInstalled: true,
        authenticated: true,
        configured: true,
        tunnelRunning: true,
        hostnameAssigned: true
      }
    });
  }

  private async readQuickTunnelPublicUrl(): Promise<string> {
    try {
      const metrics = await this.fetchText(this.settings.remoteAccess.metricsUrl);
      return parseTryCloudflareUrl(metrics);
    } catch {
      return '';
    }
  }

  async stop(): Promise<void> {
    this.stopChild();
    await this.updateRemoteAccess({
      status: this.settings.remoteAccess.enabled ? 'disconnected' : 'off',
      lastStoppedAt: this.isoNow(),
      checklist: {
        ...this.settings.remoteAccess.checklist,
        tunnelRunning: false
      }
    });
  }

  private async updateRemoteAccess(
    patch: Partial<RemoteAccessSettings>
  ): Promise<RemoteAccessSettings> {
    const remoteAccess = {
      ...this.settings.remoteAccess,
      ...patch,
      checklist: {
        ...this.settings.remoteAccess.checklist,
        ...(patch.checklist ?? {})
      }
    };
    this.settings = {
      ...this.settings,
      remoteAccess
    };
    await this.options.settingsStore.save(this.settings);
    return remoteAccess;
  }

  private async isCloudflaredInstalled(): Promise<boolean> {
    try {
      await this.exec('cloudflared', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  private async isAuthenticated(): Promise<boolean> {
    try {
      await access(this.certPath);
      return true;
    } catch {
      return false;
    }
  }

  private isConfigured(): boolean {
    const remote = this.settings.remoteAccess;
    if (this.remoteMode() === 'quick') {
      return true;
    }
    return Boolean(remote.hostname.trim() && remote.publicUrl.trim() && remote.tunnelName.trim());
  }

  private exec(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      this.execFile(file, args, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  private stopChild(): void {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = undefined;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }

  private remoteMode(): RemoteAccessMode {
    return this.settings.remoteAccess.mode === 'named' ? 'named' : 'quick';
  }
}

function normalizeHostname(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function normalizeTunnelName(value: string): string {
  const trimmed = value.trim();
  return trimmed || 'agent-pulse';
}

function normalizeRemoteMode(value: RemoteAccessMode | string | undefined): RemoteAccessMode {
  return value === 'named' ? 'named' : 'quick';
}

function normalizeTunnelProtocol(value: RemoteAccessProtocol | string | undefined): RemoteAccessProtocol {
  return value === 'quic' || value === 'http2' ? value : 'auto';
}

function metricsAddressFromUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}:${parsed.port}`;
  } catch {
    return '127.0.0.1:60123';
  }
}

function parseTunnelId(value: string): string {
  return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? '';
}

function parseTryCloudflareUrl(value: string): string {
  return value.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0] ?? '';
}

function hostnameFromUrl(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Stream cancellations with error code 0 (NO_ERROR) are clean client-initiated
 *  aborts (e.g. the browser navigated away before the response finished).
 *  These are normal and should not mark the tunnel as degraded. */
function isBenignStreamError(message: string): boolean {
  return /canceled by remote with error code 0/i.test(message);
}

function redactSecrets(value: string): string {
  return value.replace(/(token|pin|code)=([^\s&]+)/gi, '$1=[redacted]');
}
