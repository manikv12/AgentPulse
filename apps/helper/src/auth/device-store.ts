import type { DeviceStore } from './pairing';
import { FileDeviceStore } from './file-device-store';
import { KeychainDeviceStore } from './keychain-store';

export function createDefaultDeviceStore(platform: NodeJS.Platform = process.platform): DeviceStore {
  return platform === 'darwin' ? new KeychainDeviceStore() : new FileDeviceStore();
}

export { FileDeviceStore };
