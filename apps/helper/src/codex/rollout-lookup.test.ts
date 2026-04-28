import { describe, expect, it, vi } from 'vitest';
import { createRolloutLookup } from './rollout-lookup';

describe('rollout lookup', () => {
  it('queries SQLite for the rollout_path of the given thread', async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify([{ rollout_path: '/Users/me/.codex/sessions/2026/04/26/rollout-abc.jsonl' }])
    }));
    const lookup = createRolloutLookup({ codexHome: '/Users/me/.codex', exec });

    const result = await lookup.findRolloutPath('019dc68a-aedf-70f0-901e-825a65116744');

    expect(result).toBe('/Users/me/.codex/sessions/2026/04/26/rollout-abc.jsonl');
    expect(exec).toHaveBeenCalledWith('sqlite3', [
      '-json',
      '/Users/me/.codex/state_5.sqlite',
      "select rollout_path from threads where id = '019dc68a-aedf-70f0-901e-825a65116744' limit 1;"
    ]);
  });

  it('returns null when the thread is not found', async () => {
    const exec = vi.fn(async () => ({ stdout: '[]' }));
    const lookup = createRolloutLookup({ codexHome: '/Users/me/.codex', exec });

    await expect(lookup.findRolloutPath('missing')).resolves.toBeNull();
  });

  it('returns null when sqlite3 errors out', async () => {
    const exec = vi.fn(async () => {
      throw new Error('sqlite3 missing');
    });
    const lookup = createRolloutLookup({ codexHome: '/Users/me/.codex', exec });

    await expect(lookup.findRolloutPath('thread-id')).resolves.toBeNull();
  });

  it('returns null for empty thread id', async () => {
    const exec = vi.fn();
    const lookup = createRolloutLookup({ codexHome: '/Users/me/.codex', exec });

    await expect(lookup.findRolloutPath('')).resolves.toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it('escapes single quotes in thread ids', async () => {
    const exec = vi.fn(async (_command: string, _args: string[]) => ({ stdout: '[]' }));
    const lookup = createRolloutLookup({ codexHome: '/Users/me/.codex', exec });

    await lookup.findRolloutPath("evil'id");

    expect(exec).toHaveBeenCalledTimes(1);
    const args = exec.mock.calls[0][1];
    expect(args[2]).toContain("id = 'evil''id'");
  });
});
