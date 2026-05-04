import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { KeychainDeviceStore } from './keychain-store';

// Helper that emulates the macOS `security` command-line behaviour for a
// generic-password keychain. Stores values keyed by account name. Tracks the
// raw call list so tests can assert the exact sequence of subcommands.
function buildKeychainEmulator(initial: Record<string, string> = {}) {
  const entries = new Map<string, string>(Object.entries(initial));
  const calls: Array<{ command: string; args: string[] }> = [];

  const execFile = vi.fn(
    (command: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      calls.push({ command, args });
      const subcommand = args[0];
      const account = args[args.indexOf('-a') + 1];

      if (subcommand === 'find-generic-password') {
        const value = entries.get(account);
        if (value === undefined) {
          callback(new Error('The specified item could not be found in the keychain.'), '', '');
          return;
        }
        callback(null, `${value}\n`, '');
        return;
      }

      if (subcommand === 'delete-generic-password') {
        if (!entries.has(account)) {
          callback(
            new Error('The specified item could not be found in the keychain.'),
            '',
            'security: The specified item could not be found in the keychain.'
          );
          return;
        }
        entries.delete(account);
        callback(null, '', '');
        return;
      }

      if (subcommand === 'add-generic-password') {
        if (entries.has(account)) {
          callback(
            new Error('The specified item already exists in the keychain.'),
            '',
            'security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.'
          );
          return;
        }
        const value = args[args.indexOf('-w') + 1];
        entries.set(account, value);
        callback(null, '', '');
        return;
      }

      callback(null, '', '');
    }
  );

  return { execFile, entries, calls };
}

describe('KeychainDeviceStore', () => {
  it('serializes concurrent saves so device updates are not lost', async () => {
    const { execFile, entries } = buildKeychainEmulator();
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    await Promise.all([
      store.save({
        deviceId: 'device-1',
        deviceName: 'Desk iPad',
        fingerprint: 'fingerprint-1',
        token: 'token-1',
        createdAt: '2026-04-26T15:00:00.000Z'
      }),
      store.save({
        deviceId: 'device-2',
        deviceName: 'Desk tablet',
        fingerprint: 'fingerprint-2',
        token: 'token-2',
        createdAt: '2026-04-26T15:01:00.000Z'
      })
    ]);

    const indexed = JSON.parse(entries.get('devices-index') ?? '[]');
    expect(indexed).toEqual(expect.arrayContaining(['device-1', 'device-2']));
    expect(JSON.parse(entries.get('device:device-1') ?? '{}')).toMatchObject({
      deviceId: 'device-1',
      deviceName: 'Desk iPad'
    });
    expect(JSON.parse(entries.get('device:device-2') ?? '{}')).toMatchObject({
      deviceId: 'device-2',
      deviceName: 'Desk tablet'
    });
  });

  it('writes a per-device entry plus the index without using the -U update flag', async () => {
    const { execFile, calls } = buildKeychainEmulator();
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    await store.save({
      deviceId: 'device-1',
      deviceName: 'Desk iPad',
      fingerprint: 'fingerprint-1',
      token: 'token-1',
      createdAt: '2026-04-26T15:00:00.000Z'
    });

    // First read fetches the index, second read happens because the index is
    // missing and the legacy blob is checked for migration.
    const subcommands = calls.map((call) => call.args[0]);
    expect(subcommands.filter((name) => name === 'add-generic-password').length).toBe(2);
    for (const call of calls) {
      expect(call.args).not.toContain('-U');
    }

    // The device entry is keyed under "device:<id>" and the index lists the IDs.
    const addAccounts = calls
      .filter((call) => call.args[0] === 'add-generic-password')
      .map((call) => call.args[call.args.indexOf('-a') + 1]);
    expect(addAccounts).toEqual(expect.arrayContaining(['device:device-1', 'devices-index']));
  });

  it('targets the user login keychain instead of relying on security default lookup', async () => {
    const { execFile, calls } = buildKeychainEmulator();
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    await store.save({
      deviceId: 'device-1',
      deviceName: 'Desk iPad',
      fingerprint: 'fingerprint-1',
      token: 'token-1',
      createdAt: '2026-04-26T15:00:00.000Z'
    });

    const expectedKeychain = `${homedir()}/Library/Keychains/login.keychain-db`;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args.at(-1)).toBe(expectedKeychain);
    }
  });

  it('redacts device tokens from security command failures', async () => {
    const execFile = vi.fn(
      (command: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
        if (args[0] === 'find-generic-password') {
          callback(new Error('The specified item could not be found in the keychain.'), '', '');
          return;
        }

        const error = new Error(
          'Command failed: security add-generic-password -s com.agentpulse.test -a device:device-1 -w {"deviceName":"Desk tablet","token":"secret-token"} /Users/test/Library/Keychains/login.keychain-db'
        );
        Object.assign(error, {
          cmd: 'security add-generic-password -s com.agentpulse.test -a device:device-1 -w {"deviceName":"Desk tablet","token":"secret-token"} /Users/test/Library/Keychains/login.keychain-db'
        });
        callback(
          error,
          '',
          'security add-generic-password -s com.agentpulse.test -a device:device-1 -w {"deviceName":"Desk tablet","token":"secret-token"} /Users/test/Library/Keychains/login.keychain-db\nsecurity: SecKeychainItemCreateFromContent (<default>): The specified item could not be found in the keychain.'
        );
      }
    );
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    let caught: unknown;
    try {
      await store.save({
        deviceId: 'device-1',
        deviceName: 'Desk iPad',
        fingerprint: 'fingerprint-1',
        token: 'secret-token',
        createdAt: '2026-04-26T15:00:00.000Z'
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('[redacted]');
    expect((caught as Error).message).not.toContain('Desk tablet');
    expect((caught as Error).message).not.toContain('secret-token');
    expect((caught as { stderr?: string }).stderr).toContain('[redacted]');
    expect((caught as { stderr?: string }).stderr).not.toContain('Desk tablet');
    expect((caught as { stderr?: string }).stderr).not.toContain('secret-token');
    expect((caught as { cmd?: string }).cmd).toContain('[redacted]');
    expect((caught as { cmd?: string }).cmd).not.toContain('Desk tablet');
    expect((caught as { cmd?: string }).cmd).not.toContain('secret-token');
  });

  it('falls back to delete+add when add reports the item already exists', async () => {
    // Pre-populate the device entry so the first add-generic-password fails
    // with "already exists" — the writeAccount fallback must then delete and
    // re-add, leaving the new value in place.
    const { execFile, calls, entries } = buildKeychainEmulator({
      'devices-index': JSON.stringify(['device-1']),
      'device:device-1': JSON.stringify({ deviceId: 'device-1', deviceName: 'old' })
    });
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    await store.save({
      deviceId: 'device-1',
      deviceName: 'updated name',
      fingerprint: 'fingerprint-1',
      token: 'token-1',
      createdAt: '2026-04-26T15:00:00.000Z'
    });

    // For the device account during the save: add (fails: duplicate) → delete →
    // add (succeeds). The id was already in the index, so the index is not
    // rewritten. The leading find-generic-password is the cache load, which
    // happens once before the save.
    const deviceCalls = calls.filter(
      (call) => call.args[call.args.indexOf('-a') + 1] === 'device:device-1'
    );
    expect(deviceCalls.map((call) => call.args[0])).toEqual([
      'find-generic-password',
      'add-generic-password',
      'delete-generic-password',
      'add-generic-password'
    ]);
    expect(JSON.parse(entries.get('device:device-1') ?? '{}')).toMatchObject({
      deviceName: 'updated name'
    });
  });

  it('falls back to delete+add when add reports the item is stale', async () => {
    // Some keychain states make add-generic-password fail with "could not be
    // found" — writeAccount should still recover with delete+add.
    const calls: Array<{ command: string; args: string[] }> = [];
    let firstAdd = true;
    const execFile = vi.fn(
      (command: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
        calls.push({ command, args });
        if (args[0] === 'find-generic-password') {
          callback(new Error('The specified item could not be found in the keychain.'), '', '');
          return;
        }
        if (args[0] === 'add-generic-password' && firstAdd) {
          firstAdd = false;
          callback(
            new Error('The specified item could not be found in the keychain.'),
            '',
            'security: SecKeychainItemCreateFromContent: The specified item could not be found in the keychain.'
          );
          return;
        }
        callback(null, '', '');
      }
    );
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    await store.save({
      deviceId: 'device-1',
      deviceName: 'Desk iPad',
      fingerprint: 'fingerprint-1',
      token: 'token-1',
      createdAt: '2026-04-26T15:00:00.000Z'
    });

    // The device account hits the recovery path: add → delete → add.
    const deviceSubcommands = calls
      .filter((call) => call.args[call.args.indexOf('-a') + 1] === 'device:device-1')
      .map((call) => call.args[0]);
    expect(deviceSubcommands).toEqual([
      'add-generic-password',
      'delete-generic-password',
      'add-generic-password'
    ]);
  });

  it('migrates the legacy single-blob layout into per-device entries on first read', async () => {
    const legacyDevices = [
      {
        deviceId: 'legacy-1',
        deviceName: 'Old tablet',
        fingerprint: 'fp-legacy-1',
        token: 'tok-legacy-1',
        createdAt: '2026-04-25T15:00:00.000Z'
      },
      {
        deviceId: 'legacy-2',
        deviceName: 'Watch',
        fingerprint: 'fp-legacy-2',
        token: 'tok-legacy-2',
        createdAt: '2026-04-25T15:01:00.000Z'
      }
    ];
    const { execFile, entries } = buildKeychainEmulator({
      devices: JSON.stringify(legacyDevices)
    });
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    const listed = await store.list();

    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: 'legacy-1', deviceName: 'Old tablet' }),
        expect.objectContaining({ deviceId: 'legacy-2', deviceName: 'Watch' })
      ])
    );
    // Per-device entries now exist.
    expect(entries.has('device:legacy-1')).toBe(true);
    expect(entries.has('device:legacy-2')).toBe(true);
    // Index lists both ids.
    expect(JSON.parse(entries.get('devices-index') ?? '[]')).toEqual(
      expect.arrayContaining(['legacy-1', 'legacy-2'])
    );
    // Legacy blob is removed after a successful migration so it is not
    // re-read on subsequent loads.
    expect(entries.has('devices')).toBe(false);
  });

  it('skips devices listed in the index whose entries are missing instead of failing', async () => {
    // Simulates a half-completed write: the index references a device whose
    // entry never made it (or was clobbered by a failed second add). list()
    // must still return the surviving entries.
    const { execFile } = buildKeychainEmulator({
      'devices-index': JSON.stringify(['device-present', 'device-missing']),
      'device:device-present': JSON.stringify({
        deviceId: 'device-present',
        deviceName: 'iPad',
        fingerprint: 'fp',
        token: 'tok',
        createdAt: '2026-04-25T15:00:00.000Z'
      })
    });
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    const listed = await store.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ deviceId: 'device-present' });
  });

  it('removes a device entry and updates the index on delete', async () => {
    const { execFile, entries } = buildKeychainEmulator({
      'devices-index': JSON.stringify(['device-1', 'device-2']),
      'device:device-1': JSON.stringify({ deviceId: 'device-1' }),
      'device:device-2': JSON.stringify({ deviceId: 'device-2' })
    });
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    // Force a load so the in-memory cache is populated from the seeded data.
    await store.list();
    await store.delete('device-1');

    expect(JSON.parse(entries.get('devices-index') ?? '[]')).toEqual(['device-2']);
    expect(entries.has('device:device-1')).toBe(false);
    expect(entries.has('device:device-2')).toBe(true);
  });
});
