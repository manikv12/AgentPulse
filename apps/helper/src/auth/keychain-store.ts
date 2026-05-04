import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import type { DeviceRecord, DeviceStore } from './pairing';

type ExecFileCommand = (
  command: string,
  args: string[],
  callback: (error: Error | null, stdout?: string, stderr?: string) => void
) => void;

// One Keychain item per device, plus a small index listing the device IDs.
//
// Background: the helper used to keep every paired device inside a single
// generic-password item under account "devices". A save() rewrote that blob
// using delete-generic-password followed by add-generic-password — which
// meant a transient failure of the second add (helper killed mid-write,
// keychain locked, etc.) wiped every device at once. That's why users had to
// re-pair the watch on every restart.
//
// New layout:
//   account "device:<id>"   — one DeviceRecord, JSON
//   account "devices-index" — JSON array of device IDs that should exist
//   account "devices"       — legacy blob, read once on first boot for migration
//
// A failed write now affects at most one device, not the entire pairing set.
// list() also tolerates missing-but-indexed entries (drops them silently) so a
// half-completed write doesn't lock callers out.
const INDEX_ACCOUNT = 'devices-index';
const LEGACY_ACCOUNT = 'devices';
const DEVICE_ACCOUNT_PREFIX = 'device:';

export class KeychainDeviceStore implements DeviceStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private cache: Map<string, DeviceRecord> | undefined;
  private cacheLoad: Promise<Map<string, DeviceRecord>> | undefined;

  constructor(
    private readonly service = 'com.agentpulse.helper',
    private readonly execFileCommand: ExecFileCommand = execFile,
    private readonly keychainPath: string | undefined = defaultLoginKeychainPath()
  ) {}

  async list(): Promise<DeviceRecord[]> {
    const cache = await this.ensureCache();
    return [...cache.values()].map((device) => ({ ...device }));
  }

  async save(device: DeviceRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const cache = await this.ensureCache();
      await this.writeAccount(deviceAccount(device.deviceId), JSON.stringify(device));
      const isNew = !cache.has(device.deviceId);
      cache.set(device.deviceId, { ...device });
      if (isNew) {
        await this.writeIndex([...cache.keys()]);
      }
    });
  }

  async delete(deviceId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const cache = await this.ensureCache();
      if (!cache.has(deviceId)) {
        return;
      }
      cache.delete(deviceId);
      await this.writeIndex([...cache.keys()]);
      await this.exec('security', [
        'delete-generic-password',
        '-s',
        this.service,
        '-a',
        deviceAccount(deviceId)
      ]).catch(() => undefined);
    });
  }

  private async ensureCache(): Promise<Map<string, DeviceRecord>> {
    if (this.cache) {
      return this.cache;
    }
    if (!this.cacheLoad) {
      this.cacheLoad = this.loadCache().then((loaded) => {
        this.cache = loaded;
        this.cacheLoad = undefined;
        return loaded;
      });
    }
    return this.cacheLoad;
  }

  private async loadCache(): Promise<Map<string, DeviceRecord>> {
    const cache = new Map<string, DeviceRecord>();
    const indexRaw = await this.readAccount(INDEX_ACCOUNT);
    let indexIds = parseStringArray(indexRaw);

    if (!indexIds) {
      // No index yet — try migrating from the legacy single-blob layout. This
      // runs at most once: after a successful migration the new entries are in
      // place and the legacy blob is deleted.
      const migrated = await this.migrateLegacy();
      for (const device of migrated) {
        cache.set(device.deviceId, device);
      }
      return cache;
    }

    for (const deviceId of indexIds) {
      const raw = await this.readAccount(deviceAccount(deviceId));
      if (!raw) {
        // Index referenced a device whose entry is missing — most likely a
        // half-completed write or a manual keychain edit. Skip it; the next
        // write will rewrite the index without this id.
        continue;
      }
      const parsed = parseDeviceRecord(raw);
      if (parsed) {
        cache.set(parsed.deviceId, parsed);
      }
    }

    return cache;
  }

  private async migrateLegacy(): Promise<DeviceRecord[]> {
    const legacyRaw = await this.readAccount(LEGACY_ACCOUNT);
    if (!legacyRaw) {
      return [];
    }
    let parsed: DeviceRecord[];
    try {
      const value: unknown = JSON.parse(legacyRaw);
      if (!Array.isArray(value)) {
        return [];
      }
      parsed = value.filter((entry): entry is DeviceRecord =>
        Boolean(entry) && typeof entry === 'object' && typeof (entry as DeviceRecord).deviceId === 'string'
      );
    } catch {
      return [];
    }

    if (parsed.length === 0) {
      // Empty legacy blob — clean it up so we don't keep re-reading it.
      await this.exec('security', [
        'delete-generic-password',
        '-s',
        this.service,
        '-a',
        LEGACY_ACCOUNT
      ]).catch(() => undefined);
      return [];
    }

    // Write per-device entries first, then the index. If we crash partway,
    // the next start re-runs migration (legacy blob is still there) and tops
    // up whichever entries are missing.
    for (const device of parsed) {
      await this.writeAccount(deviceAccount(device.deviceId), JSON.stringify(device));
    }
    await this.writeIndex(parsed.map((device) => device.deviceId));

    // Migration complete — drop the legacy blob so subsequent loads go
    // straight through the new path.
    await this.exec('security', [
      'delete-generic-password',
      '-s',
      this.service,
      '-a',
      LEGACY_ACCOUNT
    ]).catch(() => undefined);

    return parsed;
  }

  private async writeIndex(ids: string[]): Promise<void> {
    await this.writeAccount(INDEX_ACCOUNT, JSON.stringify(ids));
  }

  private async readAccount(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.exec('security', [
        'find-generic-password',
        '-s',
        this.service,
        '-a',
        account,
        '-w'
      ]);
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  private async writeAccount(account: string, value: string): Promise<void> {
    try {
      await this.exec('security', ['add-generic-password', '-s', this.service, '-a', account, '-w', value]);
      return;
    } catch (error) {
      if (!isDuplicateKeychainItem(error) && !isStaleKeychainItem(error)) {
        throw error;
      }
    }

    await this.exec('security', ['delete-generic-password', '-s', this.service, '-a', account]).catch(
      () => undefined
    );
    await this.exec('security', ['add-generic-password', '-s', this.service, '-a', account, '-w', value]);
  }

  private exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const commandArgs = this.withKeychainPath(command, args);
      this.execFileCommand(command, commandArgs, (error, stdout = '', stderr = '') => {
        if (error) {
          const redactedStderr = redactPasswordArgument(stderr, commandArgs);
          Object.assign(error, {
            stdout,
            stderr: redactedStderr
          });
          error.message = redactPasswordArgument(error.message, commandArgs);
          if ('cmd' in error && typeof (error as { cmd?: unknown }).cmd === 'string') {
            (error as { cmd: string }).cmd = redactPasswordArgument((error as { cmd: string }).cmd, commandArgs);
          }
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  private withKeychainPath(command: string, args: string[]): string[] {
    if (command !== 'security' || !this.keychainPath) {
      return args;
    }

    return [...args, this.keychainPath];
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const nextWrite = this.writeQueue.then(operation, operation);
    this.writeQueue = nextWrite.catch(() => undefined);
    return nextWrite;
  }
}

function deviceAccount(deviceId: string): string {
  return `${DEVICE_ACCOUNT_PREFIX}${deviceId}`;
}

function parseStringArray(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) {
      return undefined;
    }
    return value.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return undefined;
  }
}

function parseDeviceRecord(raw: string): DeviceRecord | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const candidate = value as DeviceRecord;
    if (typeof candidate.deviceId !== 'string' || candidate.deviceId.length === 0) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

function defaultLoginKeychainPath(): string | undefined {
  const home = homedir();
  return home ? `${home}/Library/Keychains/login.keychain-db` : undefined;
}

function redactPasswordArgument(value: string, args: string[]): string {
  let redacted = value;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '-w') {
      continue;
    }

    const password = args[index + 1];
    if (password) {
      redacted = redacted.split(password).join('[redacted]');
    }
  }

  return redacted
    .replace(/(-w\s+)[\s\S]*?(\s+\/[^\s\n]*Library\/Keychains\/login\.keychain-db)/g, '$1[redacted]$2')
    .replace(/(-w\s+)(?:"[^"]*"|'[^']*'|\S+)/g, '$1[redacted]');
}

function isDuplicateKeychainItem(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const stderr =
    'stderr' in error && typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr
      : '';
  return `${error.message}\n${stderr}`.includes('already exists');
}

function isStaleKeychainItem(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const stderr =
    'stderr' in error && typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr
      : '';
  return `${error.message}\n${stderr}`.includes('could not be found in the keychain');
}
