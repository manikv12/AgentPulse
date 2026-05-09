import { describe, expect, it } from 'vitest';
import { FileDeviceStore } from './file-device-store';
import { KeychainDeviceStore } from './keychain-store';
import { createDefaultDeviceStore } from './device-store';

describe('createDefaultDeviceStore', () => {
  it('uses macOS Keychain on macOS', () => {
    expect(createDefaultDeviceStore('darwin')).toBeInstanceOf(KeychainDeviceStore);
  });

  it('uses a file store on Windows', () => {
    expect(createDefaultDeviceStore('win32')).toBeInstanceOf(FileDeviceStore);
  });
});
