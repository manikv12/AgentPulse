import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminAuth } from './auth/admin';
import { DeviceRegistry, PairingManager } from './auth/pairing';
import { KeychainDeviceStore } from './auth/keychain-store';
import { ClaudeCodeProvider } from './claude/claude-code';
import { CopilotProvider } from './copilot/copilot';
import { CodexAppServerChat } from './codex/app-server-chat';
import { CodexAppServerClient } from './codex/app-server-client';
import { CatalogReader } from './codex/catalog';
import { createCodexMirror } from './codex/codex-mirror';
import { createIpcClient } from './codex/ipc-client';
import { CodexThreadReader, readUsageFromRollout } from './codex/thread-reader';
import { createRolloutLookup } from './codex/rollout-lookup';
import { createThreadOpener } from './codex/thread-opener';
import { debugLog } from './debug';
import { startAgentPulseServer, type RunningAgentPulseServer } from './server/agent-pulse-server';
import { CloudflareTunnelSupervisor } from './server/cloudflare-tunnel';
import { BonjourAdvertiser } from './server/mdns';
import { SeenThreadStore } from './server/seen-thread-store';
import { HelperSettingsStore } from './server/settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let runningServer: RunningAgentPulseServer | undefined;
let remoteSupervisor: CloudflareTunnelSupervisor | undefined;
const advertiser = new BonjourAdvertiser();
const settingsStore = new HelperSettingsStore();
const registry = new DeviceRegistry(new KeychainDeviceStore());
const pairing = new PairingManager(registry);
const adminAuth = new AdminAuth({
  onPasscodeGenerated: (passcode) => {
    console.log('');
    console.log('========================================');
    console.log('Agent Pulse admin passcode (save this):');
    console.log(`  ${passcode}`);
    console.log('You can also re-read it from ~/Library/Application Support/Agent Pulse/admin.json (hashed only).');
    console.log('========================================');
    console.log('');
  }
});
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
const appServer = new CodexAppServerChat(new CodexAppServerClient({ version: app.getVersion() }));
const claudeCode = new ClaudeCodeProvider();
const copilot = new CopilotProvider();

// IPC mirror to a running Codex desktop window. See dev-server.ts for the
// rationale on why we don't wire onStreamingChange / onPendingApprovalsChange
// here (app-server-chat.ts already emits those events from notifications).
const ipc = createIpcClient({
  clientType: 'agent-pulse',
  logger: {
    debug: (msg, extra) => debugLog(`[ipc] ${msg}`, extra ?? ''),
    info: (msg, extra) => debugLog(`[ipc] ${msg}`, extra ?? ''),
    warn: (msg, extra) => console.warn(`[ipc] ${msg}`, extra ?? '')
  }
});
const mirror = createCodexMirror({ ipc, reader: appServer });
ipc.connect();

const seenThreadStore = new SeenThreadStore();

async function startOrRestartServer(): Promise<RunningAgentPulseServer> {
  await seenThreadStore.load().catch(() => undefined);
  if (runningServer) {
    await runningServer.stop();
    await advertiser.stop();
    await remoteSupervisor?.stop();
  }

  const settings = await settingsStore.load();
  remoteSupervisor = new CloudflareTunnelSupervisor({
    settings,
    settingsStore,
    helperPort: settings.port
  });
  const tabletDistDir = path.resolve(__dirname, '../../tablet/dist');
  await adminAuth.ensureInitialized();
  runningServer = await startAgentPulseServer({
    settings,
    settingsStore,
    registry,
    pairing,
    adminAuth,
    threadProvider: threadReader,
    opener,
    appServer,
    mirror,
    claudeCode,
    copilot,
    catalog,
    seenThreadStore,
    usageProvider,
    version: app.getVersion(),
    tabletDistDir,
    remoteAccess: remoteSupervisor,
    onLanModeChange: async () => {
      await startOrRestartServer();
      if (mainWindow && runningServer) {
        await mainWindow.loadURL(`${runningServer.url}/#/settings`);
      }
    }
  });

  if (settings.lanEnabled) {
    await advertiser.start(settings.port);
  }

  if (settings.remoteAccess.enabled) {
    void remoteSupervisor.setEnabled(true);
  }

  return runningServer;
}

async function createWindow(): Promise<void> {
  const server = await startOrRestartServer();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    title: 'Agent Pulse',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await mainWindow.loadURL(`${server.url}/#/settings`);
}

function createTray(): void {
  const icon = nativeImage.createFromPath('/Applications/Codex.app/Contents/Resources/codexTemplate.png');
  tray = new Tray(icon);
  tray.setToolTip('Agent Pulse');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Agent Pulse',
        click: () => {
          void createWindow();
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit()
      }
    ])
  );
}

app.whenReady().then(async () => {
  createTray();
  await createWindow();
});

app.on('window-all-closed', () => {
  mainWindow = undefined;
});

app.on('before-quit', async () => {
  await runningServer?.stop();
  await remoteSupervisor?.stop();
  await advertiser.stop();
  opener.dispose();
  claudeCode.dispose();
  catalog.dispose();
});
