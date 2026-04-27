import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import type { DeviceRecord, DeviceStore } from './pairing';

type ExecFileCommand = (
  command: string,
  args: string[],
  callback: (error: Error | null, stdout?: string, stderr?: string) => void
) => void;

export class KeychainDeviceStore implements DeviceStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly service = 'com.agentpulse.helper',
    private readonly execFileCommand: ExecFileCommand = execFile,
    private readonly keychainPath: string | undefined = defaultLoginKeychainPath()
  ) {}

  async list(): Promise<DeviceRecord[]> {
    const raw = await this.readAccount('devices');
    if (!raw) {
      return [];
    }

    try {
      return JSON.parse(raw) as DeviceRecord[];
    } catch {
      return [];
    }
  }

  async save(device: DeviceRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const devices = await this.list();
      const next = devices.filter((candidate) => candidate.deviceId !== device.deviceId);
      next.push(device);
      await this.writeAccount('devices', JSON.stringify(next));
    });
  }

  async delete(deviceId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const devices = await this.list();
      await this.writeAccount(
        'devices',
        JSON.stringify(devices.filter((device) => device.deviceId !== deviceId))
      );
    });
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
