import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RolloutLookupOptions = {
  codexHome?: string;
  exec?: (command: string, args: string[]) => Promise<{ stdout: string }>;
};

export type RolloutLookup = {
  findRolloutPath(threadId: string): Promise<string | null>;
};

export function createRolloutLookup(options: RolloutLookupOptions = {}): RolloutLookup {
  const codexHome = options.codexHome ?? path.join(homedir(), '.codex');
  const exec = options.exec ?? defaultExec;

  return {
    async findRolloutPath(threadId: string): Promise<string | null> {
      if (!threadId) {
        return null;
      }

      const dbPath = path.join(codexHome, 'state_5.sqlite');
      const safeId = threadId.replace(/'/g, "''");
      const query = `select rollout_path from threads where id = '${safeId}' limit 1;`;

      try {
        const { stdout } = await exec('sqlite3', ['-json', dbPath, query]);
        const parsed = JSON.parse(stdout || '[]') as Array<{ rollout_path?: string }>;
        const rolloutPath = parsed[0]?.rollout_path?.trim();
        return rolloutPath ? rolloutPath : null;
      } catch {
        return null;
      }
    }
  };
}

async function defaultExec(command: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 4 * 1024 * 1024 });
  return { stdout };
}
