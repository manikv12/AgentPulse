import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function helperTarget(): string {
  const envPort = Number(process.env.AGENT_PULSE_HELPER_PORT);
  if (Number.isInteger(envPort) && envPort > 0) {
    return `http://127.0.0.1:${envPort}`;
  }

  try {
    const settingsPath = agentPulseSettingsPath();
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { port?: unknown };
    if (typeof settings.port === 'number' && Number.isInteger(settings.port) && settings.port > 0) {
      return `http://127.0.0.1:${settings.port}`;
    }
  } catch {
    // The helper creates this settings file on first launch. Use the current dev default as a fallback.
  }

  return 'http://127.0.0.1:61482';
}

function remoteAllowedHosts(): string[] {
  const hosts = new Set<string>();

  for (const host of (process.env.AGENT_PULSE_ALLOWED_HOSTS ?? '').split(',')) {
    const trimmed = host.trim();
    if (trimmed) {
      hosts.add(trimmed);
    }
  }

  try {
    const settingsPath = agentPulseSettingsPath();
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      remoteAccess?: { hostname?: unknown; publicUrl?: unknown };
    };
    const hostname = settings.remoteAccess?.hostname;
    if (typeof hostname === 'string' && hostname.trim()) {
      hosts.add(hostname.trim());
    }
    const publicUrl = settings.remoteAccess?.publicUrl;
    if (typeof publicUrl === 'string' && publicUrl.trim()) {
      hosts.add(new URL(publicUrl).hostname);
    }
  } catch {
    // Remote access may not be configured yet.
  }

  return [...hosts];
}

function agentPulseSettingsPath(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'Agent Pulse', 'settings.json');
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA?.trim() || path.join(homedir(), 'AppData', 'Roaming'),
      'Agent Pulse',
      'settings.json'
    );
  }
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config'), 'agent-pulse', 'settings.json');
}

function remoteHmrConfig():
  | { host: string; protocol: 'ws' | 'wss'; clientPort?: number }
  | undefined {
  const host = process.env.AGENT_PULSE_HMR_HOST?.trim();
  if (!host) {
    return undefined;
  }

  const protocol = process.env.AGENT_PULSE_HMR_PROTOCOL === 'ws' ? 'ws' : 'wss';
  const clientPort = Number(process.env.AGENT_PULSE_HMR_CLIENT_PORT);
  return {
    host,
    protocol,
    ...(Number.isInteger(clientPort) && clientPort > 0 ? { clientPort } : {})
  };
}

const helperApiTarget = helperTarget();
const allowedHosts = remoteAllowedHosts();
const hmr = remoteHmrConfig();
const helperProxy = {
  target: helperApiTarget,
  changeOrigin: true
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      selfDestroying: true,
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Agent Pulse',
        short_name: 'Agent Pulse',
        description: 'Dashboard for local AI coding agents',
        theme_color: '#10131f',
        background_color: '#10131f',
        display: 'standalone',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ],
  server: {
    allowedHosts,
    hmr,
    proxy: {
      '/admin': helperProxy,
      '/catalog': helperProxy,
      '/device': helperProxy,
      '/events': {
        ...helperProxy,
        ws: true
      },
      '/health': helperProxy,
      '/projects': helperProxy,
      '/settings': helperProxy,
      '/thread': helperProxy,
      '/threads': helperProxy,
      '/assets/codex-template.png': helperProxy
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
