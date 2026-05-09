import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agentPulseDataPath } from '../platform/paths';
import type { DeviceRecord, DeviceStore } from './pairing';

const FILE_VERSION = 1;

type DeviceStoreFile = {
  version: number;
  devices: DeviceRecord[];
};

function emptyFile(): DeviceStoreFile {
  return { version: FILE_VERSION, devices: [] };
}

export class FileDeviceStore implements DeviceStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private cache: Map<string, DeviceRecord> | undefined;
  private cacheLoad: Promise<Map<string, DeviceRecord>> | undefined;

  constructor(private readonly storePath = agentPulseDataPath('devices.json')) {}

  async list(): Promise<DeviceRecord[]> {
    const cache = await this.ensureCache();
    return [...cache.values()].map((device) => ({ ...device }));
  }

  async save(device: DeviceRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const cache = await this.ensureCache();
      cache.set(device.deviceId, { ...device });
      await this.persist(cache);
    });
  }

  async delete(deviceId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const cache = await this.ensureCache();
      if (!cache.delete(deviceId)) {
        return;
      }
      await this.persist(cache);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.storePath, 'utf8'));
    } catch {
      return cache;
    }

    const devices = parseDeviceList(parsed);
    for (const device of devices) {
      cache.set(device.deviceId, device);
    }
    return cache;
  }

  private async persist(cache: Map<string, DeviceRecord>): Promise<void> {
    const file: DeviceStoreFile = {
      version: FILE_VERSION,
      devices: [...cache.values()]
    };
    const serialized = `${JSON.stringify(file, null, 2)}\n`;
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, this.storePath);
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const nextWrite = this.writeQueue.then(operation, operation);
    this.writeQueue = nextWrite.catch(() => undefined);
    return nextWrite;
  }
}

function parseDeviceList(value: unknown): DeviceRecord[] {
  if (Array.isArray(value)) {
    return value.filter(isDeviceRecord);
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const devices = (value as Partial<DeviceStoreFile>).devices;
  return Array.isArray(devices) ? devices.filter(isDeviceRecord) : [];
}

function isDeviceRecord(value: unknown): value is DeviceRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DeviceRecord>;
  return (
    typeof candidate.deviceId === 'string' &&
    candidate.deviceId.length > 0 &&
    typeof candidate.deviceName === 'string' &&
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.token === 'string' &&
    typeof candidate.createdAt === 'string'
  );
}
