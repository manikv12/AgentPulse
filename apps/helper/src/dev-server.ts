import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminAuth } from './auth/admin';
import { KeychainDeviceStore } from './auth/keychain-store';
import { CodexAppServerChat } from './codex/app-server-chat';
import { CodexAppServerClient } from './codex/app-server-client';
import { CatalogReader } from './codex/catalog';
import { createCodexMirror } from './codex/codex-mirror';
import { createIpcClient } from './codex/ipc-client';
import { DeviceRegistry, PairingManager } from './auth/pairing';
import { CodexThreadReader, readUsageFromRollout } from './codex/thread-reader';
import { createRolloutLookup } from './codex/rollout-lookup';
import { createThreadOpener } from './codex/thread-opener';
import { debugLog } from './debug';
import { startAgentPulseServer, type RunningAgentPulseServer } from './server/agent-pulse-server';
import { CloudflareTunnelSupervisor } from './server/cloudflare-tunnel';
import { BonjourAdvertiser } from './server/mdns';
import { HelperSettingsStore } from './server/settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsStore = new HelperSettingsStore();
const registry = new DeviceRegistry(new KeychainDeviceStore());
const pairing = new PairingManager(registry);
const adminAuth = new AdminAuth({
  onPasscodeGenerated: (passcode) => {
    console.log('');
    console.log('========================================');
    console.log('Agent Pulse admin passcode (save this):');
    console.log(`  ${passcode}`);
    console.log('========================================');
    console.log('');
  }
});
await adminAuth.ensureInitialized();
const threadReader = new CodexThreadReader();
const opener = createThreadOpener();
const rolloutLookup = createRolloutLookup();
const usageProvider = async (threadId: string) => {
  const rolloutPath = await rolloutLookup.findRolloutPath(threadId).catch(() => null);
  if (!rolloutPath) {
    return undefined;
  }
  return readUsageFromRollout(rolloutPath);
};
const catalog = new CatalogReader();
catalog.start();
const advertiser = new BonjourAdvertiser();
const appServer = new CodexAppServerChat(new CodexAppServerClient({ version: '0.1.0' }));
const ipc = createIpcClient({
  clientType: 'agent-pulse',
  logger: {
    debug: (msg, extra) => debugLog(`[ipc] ${msg}`, extra ?? ''),
    info: (msg, extra) => debugLog(`[ipc] ${msg}`, extra ?? ''),
    warn: (msg, extra) => console.warn(`[ipc] ${msg}`, extra ?? '')
  }
});
let runningServerRef: RunningAgentPulseServer | undefined;
const mirror = createCodexMirror({
  ipc,
  reader: appServer,
  onBroadcast: (broadcast) => {
    runningServerRef?.hub.broadcast({
      type: 'codex/broadcast',
      payload: {
        method: broadcast.method,
        sourceClientId: broadcast.sourceClientId,
        params: broadcast.params
      }
    });
  },
  onStreamingChange: ({ threadId, isStreaming }) => {
    runningServerRef?.hub.broadcast({
      type: 'thread/streaming-changed',
      payload: { threadId, isStreaming }
    });
  }
});
ipc.connect();

const settings = await settingsStore.load();
const remoteSupervisor = new CloudflareTunnelSupervisor({
  settings,
  settingsStore,
  helperPort: settings.port
});
const tabletDistDir = path.resolve(__dirname, '../../tablet/dist');
const tabletDevUrl = process.env.AGENT_PULSE_TABLET_DEV_URL?.trim() || undefined;
const server = await startAgentPulseServer({
  settings,
  settingsStore,
  registry,
  pairing,
  adminAuth,
  threadProvider: threadReader,
  opener,
  appServer,
  mirror,
  catalog,
  usageProvider,
  version: '0.1.0',
  tabletDistDir,
  tabletDevUrl,
  remoteAccess: remoteSupervisor,
  onLanModeChange: async (enabled) => {
    if (enabled) {
      await advertiser.start(settings.port);
    } else {
      await advertiser.stop();
    }
  }
});

runningServerRef = server;

if (settings.lanEnabled) {
  await advertiser.start(settings.port);
}

if (settings.remoteAccess.enabled && process.env.AGENT_PULSE_SKIP_MANAGED_TUNNEL !== '1') {
  void remoteSupervisor.setEnabled(true);
}

console.log(`Agent Pulse helper running at ${server.url}`);
console.log(`Open settings at ${server.url}/#/settings`);

process.on('uncaughtException', (error) => {
  console.error('[helper] uncaughtException', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[helper] unhandledRejection', reason);
});

process.on('SIGINT', async () => {
  await server.stop();
  await remoteSupervisor.stop();
  await advertiser.stop();
  opener.dispose();
  mirror.dispose();
  ipc.dispose();
  catalog.dispose();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.stop();
  await remoteSupervisor.stop();
  await advertiser.stop();
  opener.dispose();
  mirror.dispose();
  ipc.dispose();
  catalog.dispose();
  process.exit(0);
});
