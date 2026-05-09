import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileDeviceStore } from './file-device-store';

describe('FileDeviceStore', () => {
  it('saves, lists, and deletes paired devices from a local file', async () => {
    const storePath = await tempStorePath();
    const store = new FileDeviceStore(storePath);

    await store.save({
      deviceId: 'device-1',
      deviceName: 'Windows tablet',
      fingerprint: 'fingerprint-1',
      token: 'token-1',
      createdAt: '2026-05-09T12:00:00.000Z'
    });

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ deviceId: 'device-1', deviceName: 'Windows tablet' })
    ]);

    const stored = JSON.parse(await readFile(storePath, 'utf8')) as { devices?: unknown[] };
    expect(stored.devices).toHaveLength(1);

    await store.delete('device-1');
    await expect(store.list()).resolves.toEqual([]);
  });

  it('serializes concurrent saves so devices are not lost', async () => {
    const store = new FileDeviceStore(await tempStorePath());

    await Promise.all([
      store.save({
        deviceId: 'device-1',
        deviceName: 'Phone',
        fingerprint: 'fp-1',
        token: 'token-1',
        createdAt: '2026-05-09T12:00:00.000Z'
      }),
      store.save({
        deviceId: 'device-2',
        deviceName: 'Tablet',
        fingerprint: 'fp-2',
        token: 'token-2',
        createdAt: '2026-05-09T12:01:00.000Z'
      })
    ]);

    await expect(store.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: 'device-1' }),
        expect.objectContaining({ deviceId: 'device-2' })
      ])
    );
  });

  it('loads the legacy array layout', async () => {
    const storePath = await tempStorePath();
    await writeFile(
      storePath,
      `${JSON.stringify([
        {
          deviceId: 'legacy-device',
          deviceName: 'Old tablet',
          fingerprint: 'fp',
          token: 'token',
          createdAt: '2026-05-09T12:00:00.000Z'
        }
      ])}\n`,
      'utf8'
    );

    const store = new FileDeviceStore(storePath);

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ deviceId: 'legacy-device' })
    ]);
  });
});

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-pulse-devices-'));
  return path.join(dir, 'devices.json');
}
