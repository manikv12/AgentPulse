import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { KeychainDeviceStore } from './keychain-store';

describe('KeychainDeviceStore', () => {
  it('serializes concurrent saves so device updates are not lost', async () => {
    let storedValue: string | undefined;
    const pendingFinds: Array<(value: string | undefined) => void> = [];
    const flushFinds = () => {
      if (pendingFinds.length === 0) {
        return;
      }

      const snapshot = storedValue;
      for (const pendingFind of pendingFinds.splice(0)) {
        pendingFind(snapshot);
      }
    };
    const execFile = vi.fn((command: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (args[0] === 'find-generic-password') {
        pendingFinds.push((value) => {
          if (!value) {
            callback(new Error('The specified item could not be found in the keychain.'), '', '');
            return;
          }
          callback(null, `${value}\n`, '');
        });
        if (pendingFinds.length === 2) {
          flushFinds();
        } else {
          setTimeout(flushFinds, 0);
        }
        return;
      }

      if (args[0] === 'delete-generic-password') {
        storedValue = undefined;
        callback(null, '', '');
        return;
      }

      if (args[0] === 'add-generic-password') {
        if (storedValue) {
          callback(
            new Error('The specified item already exists in the keychain.'),
            '',
            'security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.'
          );
          return;
        }

        storedValue = args[args.indexOf('-w') + 1];
        callback(null, '', '');
        return;
      }

      callback(null, '', '');
    });
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

    expect(JSON.parse(storedValue ?? '[]')).toEqual([
      expect.objectContaining({ deviceId: 'device-1' }),
      expect.objectContaining({ deviceId: 'device-2' })
    ]);
  });

  it('creates the devices item without the fragile Keychain update flag', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const execFile = vi.fn((command: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      calls.push({ command, args });
      if (args[0] === 'find-generic-password') {
        callback(null, '[]\n', '');
        return;
      }
      callback(null, '', '');
    });
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    await store.save({
      deviceId: 'device-1',
      deviceName: 'Desk iPad',
      fingerprint: 'fingerprint-1',
      token: 'token-1',
      createdAt: '2026-04-26T15:00:00.000Z'
    });

    expect(calls.map((call) => call.args[0])).toEqual([
      'find-generic-password',
      'add-generic-password'
    ]);
    expect(calls.at(-1)?.args).not.toContain('-U');
  });

  it('targets the user login keychain instead of relying on security default lookup', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const execFile = vi.fn((command: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      calls.push({ command, args });
      if (args[0] === 'find-generic-password') {
        callback(null, '[]\n', '');
        return;
      }
      callback(null, '', '');
    });
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    await store.save({
      deviceId: 'device-1',
      deviceName: 'Desk iPad',
      fingerprint: 'fingerprint-1',
      token: 'token-1',
      createdAt: '2026-04-26T15:00:00.000Z'
    });

    const expectedKeychain = `${homedir()}/Library/Keychains/login.keychain-db`;
    expect(calls.map((call) => call.args.at(-1))).toEqual([expectedKeychain, expectedKeychain]);
  });

  it('redacts device tokens from security command failures', async () => {
    const execFile = vi.fn((command: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (args[0] === 'find-generic-password') {
        callback(null, '[]\n', '');
        return;
      }

      const error = new Error(
        'Command failed: security add-generic-password -s com.agentpulse.test -a devices -w [{"deviceName":"Desk tablet","token":"secret-token"}] /Users/test/Library/Keychains/login.keychain-db'
      );
      Object.assign(error, {
        cmd: 'security add-generic-password -s com.agentpulse.test -a devices -w [{"deviceName":"Desk tablet","token":"secret-token"}] /Users/test/Library/Keychains/login.keychain-db'
      });
      callback(
        error,
        '',
        'security add-generic-password -s com.agentpulse.test -a devices -w [{"deviceName":"Desk tablet","token":"secret-token"}] /Users/test/Library/Keychains/login.keychain-db\nsecurity: SecKeychainItemCreateFromContent (<default>): The specified item could not be found in the keychain.'
      );
    });
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
    expect(
      store.save({
        deviceId: 'device-1',
        deviceName: 'Desk iPad',
        fingerprint: 'fingerprint-1',
        token: 'secret-token',
        createdAt: '2026-04-26T15:00:00.000Z'
      })
    ).rejects.toThrow('[redacted]');
  });

  it('recreates a stale devices item when Keychain create reports not found', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const execFile = vi.fn((command: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      calls.push({ command, args });
      if (args[0] === 'find-generic-password') {
        const error = new Error('The specified item could not be found in the keychain.');
        callback(error, '', '');
        return;
      }
      if (args[0] === 'add-generic-password' && !calls.some((call) => call.args[0] === 'delete-generic-password')) {
        const error = new Error('The specified item could not be found in the keychain.');
        callback(
          error,
          '',
          'security: SecKeychainItemCreateFromContent (/Users/test/Library/Keychains/login.keychain-db): The specified item could not be found in the keychain.'
        );
        return;
      }
      callback(null, '', '');
    });
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    await store.save({
      deviceId: 'device-1',
      deviceName: 'Desk iPad',
      fingerprint: 'fingerprint-1',
      token: 'token-1',
      createdAt: '2026-04-26T15:00:00.000Z'
    });

    expect(calls.map((call) => call.args[0])).toEqual([
      'find-generic-password',
      'add-generic-password',
      'delete-generic-password',
      'add-generic-password'
    ]);
  });

  it('replaces the devices item when Keychain reports a duplicate on create', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const execFile = vi.fn((command: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      calls.push({ command, args });
      if (args[0] === 'find-generic-password') {
        callback(null, '[]\n', '');
        return;
      }
      if (args[0] === 'add-generic-password' && !args.includes('-U') && !calls.some((call) => call.args[0] === 'delete-generic-password')) {
        const error = new Error('The specified item already exists in the keychain.');
        Object.assign(error, {
          stderr: 'security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.'
        });
        callback(error);
        return;
      }
      callback(null, '', '');
    });
    const store = new KeychainDeviceStore('com.agentpulse.test', execFile);

    await store.save({
      deviceId: 'device-1',
      deviceName: 'Desk iPad',
      fingerprint: 'fingerprint-1',
      token: 'token-1',
      createdAt: '2026-04-26T15:00:00.000Z'
    });

    expect(calls.map((call) => call.args[0])).toEqual([
      'find-generic-password',
      'add-generic-password',
      'delete-generic-password',
      'add-generic-password'
    ]);
    expect(calls.at(-1)?.args).not.toContain('-U');
  });
});
