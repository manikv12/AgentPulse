import { describe, expect, it } from 'vitest';
import {
  DeviceRegistry,
  MemoryDeviceStore,
  PairingManager,
  RateLimiter
} from './pairing';

describe('pairing and device auth', () => {
  it('keeps generated pairing PINs valid for 5 minutes by default', () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry, {
      now: () => new Date('2026-04-25T16:00:00Z')
    });

    expect(pairing.createPin().expiresAt).toBe('2026-04-25T16:05:00.000Z');
  });

  it('exchanges a valid PIN for a device-specific token', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry, {
      now: () => new Date('2026-04-25T16:00:00Z'),
      randomId: () => 'fixed-id'
    });

    const pin = pairing.createPin().pin;
    const result = await pairing.exchangePin({
      pin,
      deviceName: 'Desk iPad',
      fingerprint: 'tablet-fingerprint',
      ip: '192.168.1.20'
    });

    expect(result.device.deviceName).toBe('Desk iPad');
    expect(result.device.token).not.toContain(pin);
    await expect(
      registry.validate(result.device.token, result.device.deviceId, 'tablet-fingerprint')
    ).resolves.toMatchObject({ ok: true });
  });

  it('rejects revoked devices immediately', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const device = await registry.createDevice('Kitchen tablet', 'fingerprint-a');

    await registry.revokeDevice(device.deviceId);

    await expect(
      registry.validate(device.token, device.deviceId, 'fingerprint-a')
    ).resolves.toEqual({ ok: false, reason: 'revoked' });
  });

  it('reconnects a saved device without creating a duplicate record', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry, {
      now: () => new Date('2026-04-25T16:00:00Z')
    });
    const original = await registry.createDevice('Desk tablet', 'fingerprint-a');

    const genericPin = pairing.createPin();
    const reconnectPin = pairing.createPin({ deviceId: original.deviceId });

    expect(pairing.listPins()).toEqual([
      {
        pin: genericPin.pin,
        expiresAt: '2026-04-25T16:05:00.000Z'
      },
      {
        pin: reconnectPin.pin,
        expiresAt: '2026-04-25T16:05:00.000Z',
        deviceId: original.deviceId
      }
    ]);

    const result = await pairing.exchangePin({
      pin: reconnectPin.pin,
      fingerprint: 'fingerprint-b',
      ip: '192.168.1.20'
    });

    expect(result.device.deviceId).toBe(original.deviceId);
    expect(result.device.deviceName).toBe('Desk tablet');
    expect(result.device.token).not.toBe(original.token);

    await expect(
      registry.validate(result.device.token, result.device.deviceId, 'fingerprint-b')
    ).resolves.toMatchObject({ ok: true });

    expect(pairing.listPins()).toEqual([
      {
        pin: genericPin.pin,
        expiresAt: '2026-04-25T16:05:00.000Z'
      }
    ]);
  });

  it('rate limits repeated bad pairing attempts by IP', () => {
    const limiter = new RateLimiter({
      maxAttempts: 5,
      windowMs: 10 * 60 * 1000,
      blockMs: 60 * 60 * 1000,
      nowMs: () => 1000
    });

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.recordFailure('192.168.1.40')).toBe(true);
    }

    expect(limiter.recordFailure('192.168.1.40')).toBe(false);
  });

  it('locks pairing globally after repeated failures from different IPs', async () => {
    const registry = new DeviceRegistry(new MemoryDeviceStore());
    const pairing = new PairingManager(registry, {
      now: () => new Date('2026-04-25T16:00:00Z')
    });
    const pin = pairing.createPin().pin;

    for (let index = 0; index < 10; index += 1) {
      await expect(
        pairing.exchangePin({
          pin: '000000',
          deviceName: 'Desk iPad',
          fingerprint: 'tablet-fingerprint',
          ip: `203.0.113.${index}`
        })
      ).rejects.toThrow('Pairing PIN is invalid or expired.');
    }

    await expect(
      pairing.exchangePin({
        pin,
        deviceName: 'Desk iPad',
        fingerprint: 'tablet-fingerprint',
        ip: '203.0.113.99'
      })
    ).rejects.toThrow('Too many pairing attempts. Try again later.');
  });
});
