import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { maskToken } from '@agent-pulse/shared';

const DEFAULT_PIN_TTL_MS = 5 * 60 * 1000;
const GLOBAL_PAIRING_LIMIT_KEY = '__global_pairing_failures__';

export type DeviceRecord = {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  token: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
};

export type PublicDeviceRecord = Omit<DeviceRecord, 'token'> & {
  tokenPreview: string;
};

export interface DeviceStore {
  list(): Promise<DeviceRecord[]>;
  save(device: DeviceRecord): Promise<void>;
  delete(deviceId: string): Promise<void>;
}

export class MemoryDeviceStore implements DeviceStore {
  private readonly devices = new Map<string, DeviceRecord>();

  async list(): Promise<DeviceRecord[]> {
    return [...this.devices.values()].map((device) => ({ ...device }));
  }

  async save(device: DeviceRecord): Promise<void> {
    this.devices.set(device.deviceId, { ...device });
  }

  async delete(deviceId: string): Promise<void> {
    this.devices.delete(deviceId);
  }
}

export type ValidationResult =
  | { ok: true; device: DeviceRecord }
  | { ok: false; reason: 'missing' | 'invalid' | 'revoked' };

export class DeviceRegistry {
  constructor(
    private readonly store: DeviceStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async createDevice(deviceName: string, fingerprint: string): Promise<DeviceRecord> {
    const device: DeviceRecord = {
      deviceId: randomUUID(),
      deviceName,
      fingerprint,
      token: createDeviceToken(),
      createdAt: this.now().toISOString()
    };

    await this.store.save(device);
    return device;
  }

  async reconnectDevice(deviceId: string, fingerprint: string): Promise<DeviceRecord | undefined> {
    const devices = await this.store.list();
    const device = devices.find((candidate) => candidate.deviceId === deviceId && !candidate.revokedAt);

    if (!device) {
      return undefined;
    }

    const nextDevice: DeviceRecord = {
      ...device,
      fingerprint,
      token: createDeviceToken(),
      lastSeenAt: this.now().toISOString()
    };

    await this.store.save(nextDevice);
    return nextDevice;
  }

  async listPublicDevices(): Promise<PublicDeviceRecord[]> {
    const devices = await this.store.list();
    return devices.map(({ token, ...device }) => ({
      ...device,
      tokenPreview: maskToken(token)
    }));
  }

  async listActivePublicDevices(): Promise<PublicDeviceRecord[]> {
    const devices = await this.listPublicDevices();
    return devices.filter((device) => !device.revokedAt);
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const devices = await this.store.list();
    const device = devices.find((candidate) => candidate.deviceId === deviceId);

    if (!device) {
      return;
    }

    await this.store.save({
      ...device,
      revokedAt: this.now().toISOString()
    });
  }

  async validate(
    token: string | undefined,
    deviceId: string | undefined,
    fingerprint: string | undefined
  ): Promise<ValidationResult> {
    if (!token || !deviceId || !fingerprint) {
      return { ok: false, reason: 'missing' };
    }

    const devices = await this.store.list();
    const device = devices.find((candidate) => candidate.deviceId === deviceId);

    if (!device) {
      return { ok: false, reason: 'missing' };
    }

    if (device.revokedAt) {
      return { ok: false, reason: 'revoked' };
    }

    if (!safeEqual(device.token, token) || device.fingerprint !== fingerprint) {
      return { ok: false, reason: 'invalid' };
    }

    await this.store.save({ ...device, lastSeenAt: this.now().toISOString() });
    return { ok: true, device };
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

type PinRecord = {
  pin: string;
  expiresAt: Date;
  deviceId?: string;
};

const NEW_DEVICE_PIN_SCOPE = '__new-device__';

export type PairingManagerOptions = {
  now?: () => Date;
  randomId?: () => string;
  pinTtlMs?: number;
};

export class PairingManager {
  private readonly activePins = new Map<string, PinRecord>();
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly pinTtlMs: number;
  private readonly limiter: RateLimiter;
  private readonly globalLimiter: RateLimiter;

  constructor(
    private readonly registry: DeviceRegistry,
    options: PairingManagerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomBytes(3).toString('hex'));
    this.pinTtlMs = options.pinTtlMs ?? DEFAULT_PIN_TTL_MS;
    this.limiter = new RateLimiter({
      maxAttempts: 5,
      windowMs: 10 * 60 * 1000,
      blockMs: 60 * 60 * 1000
    });
    this.globalLimiter = new RateLimiter({
      maxAttempts: 9,
      windowMs: 5 * 60 * 1000,
      blockMs: 60 * 60 * 1000
    });
  }

  createPin(options: { deviceId?: string } = {}): {
    pin: string;
    expiresAt: string;
    deviceId?: string;
  } {
    this.purgeExpiredPins();
    const raw = Number.parseInt(randomBytes(4).toString('hex'), 16);
    const pin = String(raw % 1_000_000).padStart(6, '0');
    const expiresAt = new Date(this.now().getTime() + this.pinTtlMs);
    const deviceId = options.deviceId?.trim() || undefined;

    this.activePins.set(pinScopeKey(deviceId), { pin, expiresAt, deviceId });
    return {
      pin,
      expiresAt: expiresAt.toISOString(),
      ...(deviceId ? { deviceId } : {})
    };
  }

  listPins(): Array<{ pin: string; expiresAt: string; deviceId?: string }> {
    this.purgeExpiredPins();
    return [...this.activePins.values()].map((record) => ({
      pin: record.pin,
      expiresAt: record.expiresAt.toISOString(),
      ...(record.deviceId ? { deviceId: record.deviceId } : {})
    }));
  }

  async exchangePin(input: {
    pin: string;
    deviceName?: string;
    existingDeviceId?: string;
    fingerprint: string;
    ip: string;
  }): Promise<{ device: DeviceRecord }> {
    if (this.limiter.isBlocked(input.ip) || this.globalLimiter.isBlocked(GLOBAL_PAIRING_LIMIT_KEY)) {
      throw new Error('Too many pairing attempts. Try again later.');
    }

    this.purgeExpiredPins();
    const activePin = [...this.activePins.values()].find((candidate) => candidate.pin === input.pin);
    if (!activePin) {
      this.limiter.recordFailure(input.ip);
      this.globalLimiter.recordFailure(GLOBAL_PAIRING_LIMIT_KEY);
      throw new Error('Pairing PIN is invalid or expired.');
    }

    this.activePins.delete(pinScopeKey(activePin.deviceId));
    this.limiter.clear(input.ip);
    this.globalLimiter.clear(GLOBAL_PAIRING_LIMIT_KEY);

    const existingDeviceId = activePin.deviceId ?? input.existingDeviceId?.trim();
    if (existingDeviceId) {
      if (activePin.deviceId && input.existingDeviceId?.trim() && input.existingDeviceId.trim() !== activePin.deviceId) {
        throw new Error('Pairing PIN does not match the selected saved device.');
      }

      const device = await this.registry.reconnectDevice(existingDeviceId, input.fingerprint);
      if (!device) {
        throw new Error('Selected device is not available anymore.');
      }

      return { device };
    }

    const suffix = this.randomId();
    const device = await this.registry.createDevice(
      input.deviceName?.trim() || `Tablet ${suffix}`,
      input.fingerprint
    );

    return { device };
  }

  private purgeExpiredPins(): void {
    const nowMs = this.now().getTime();
    for (const [scope, record] of this.activePins.entries()) {
      if (record.expiresAt.getTime() <= nowMs) {
        this.activePins.delete(scope);
      }
    }
  }
}

function createDeviceToken(): string {
  return `ap_${randomBytes(32).toString('base64url')}`;
}

function pinScopeKey(deviceId: string | undefined): string {
  return deviceId ?? NEW_DEVICE_PIN_SCOPE;
}

export type RateLimiterOptions = {
  maxAttempts: number;
  windowMs: number;
  blockMs: number;
  nowMs?: () => number;
};

type RateEntry = {
  attempts: number[];
  blockedUntil?: number;
};

export class RateLimiter {
  private readonly entries = new Map<string, RateEntry>();
  private readonly nowMs: () => number;

  constructor(private readonly options: RateLimiterOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  isBlocked(key: string): boolean {
    const entry = this.entries.get(key);
    const now = this.nowMs();
    return Boolean(entry?.blockedUntil && entry.blockedUntil > now);
  }

  recordFailure(key: string): boolean {
    const now = this.nowMs();
    const entry = this.entries.get(key) ?? { attempts: [] };
    entry.attempts = entry.attempts.filter((attempt) => now - attempt <= this.options.windowMs);
    entry.attempts.push(now);

    if (entry.attempts.length > this.options.maxAttempts) {
      entry.blockedUntil = now + this.options.blockMs;
      this.entries.set(key, entry);
      return false;
    }

    this.entries.set(key, entry);
    return true;
  }

  clear(key: string): void {
    this.entries.delete(key);
  }
}
