import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentPulseDataDir, displayPath } from './paths';

describe('platform paths', () => {
  it('keeps the existing macOS app data directory', () => {
    expect(agentPulseDataDir({ platform: 'darwin', homeDir: '/Users/me', env: {} })).toBe(
      path.join('/Users/me', 'Library', 'Application Support', 'Agent Pulse')
    );
  });

  it('uses APPDATA for Windows app data', () => {
    expect(
      agentPulseDataDir({
        platform: 'win32',
        homeDir: 'C:\\Users\\me',
        env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }
      })
    ).toBe(path.join('C:\\Users\\me\\AppData\\Roaming', 'Agent Pulse'));
  });

  it('falls back to AppData Roaming on Windows when APPDATA is missing', () => {
    expect(agentPulseDataDir({ platform: 'win32', homeDir: 'C:\\Users\\me', env: {} })).toBe(
      path.join('C:\\Users\\me', 'AppData', 'Roaming', 'Agent Pulse')
    );
  });

  it('shortens home paths for user-facing messages', () => {
    const home = homedir();
    if (!home) {
      return;
    }

    expect(displayPath(path.join(home, 'Agent Pulse', 'settings.json'))).toBe(
      `~${path.sep}${path.join('Agent Pulse', 'settings.json')}`
    );
  });
});
