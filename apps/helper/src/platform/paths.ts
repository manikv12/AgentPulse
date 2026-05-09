import { homedir } from 'node:os';
import path from 'node:path';

export type PlatformPathOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export function agentPulseDataDir(options: PlatformPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Agent Pulse');
  }

  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Agent Pulse');
  }

  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  return path.join(configHome, 'agent-pulse');
}

export function agentPulseDataPath(...parts: string[]): string {
  return path.join(agentPulseDataDir(), ...parts);
}

export function displayPath(filePath: string): string {
  const home = homedir();
  if (home && filePath === home) {
    return '~';
  }
  if (home && filePath.startsWith(`${home}${path.sep}`)) {
    return `~${path.sep}${path.relative(home, filePath)}`;
  }
  return filePath;
}
