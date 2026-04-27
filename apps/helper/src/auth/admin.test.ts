import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdminAuth } from './admin';

describe('AdminAuth', () => {
  it('generates a 12-character passcode and stores only its hash', async () => {
    let generatedPasscode = '';
    const credentialsPath = path.join(
      mkdtempSync(path.join(tmpdir(), 'agent-pulse-admin-')),
      'admin.json'
    );
    const auth = new AdminAuth({
      credentialsPath,
      onPasscodeGenerated: (passcode) => {
        generatedPasscode = passcode;
      }
    });

    await auth.ensureInitialized();

    expect(generatedPasscode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
    expect(await auth.verifyPasscode(generatedPasscode)).toBe(true);

    const stored = JSON.parse(readFileSync(credentialsPath, 'utf8')) as {
      salt: string;
      passcodeHash: string;
    };
    expect(stored.salt).toMatch(/^[a-f0-9]{32}$/);
    expect(stored.passcodeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.passcodeHash).not.toContain(generatedPasscode);
  });

  it('rejects passcode changes shorter than 12 characters', async () => {
    let generatedPasscode = '';
    const auth = new AdminAuth({
      credentialsPath: path.join(
        mkdtempSync(path.join(tmpdir(), 'agent-pulse-admin-')),
        'admin.json'
      ),
      onPasscodeGenerated: (passcode) => {
        generatedPasscode = passcode;
      }
    });

    await auth.ensureInitialized();

    await expect(
      auth.changePasscode(generatedPasscode, 'short-pass')
    ).rejects.toThrow('New passcode must be at least 12 characters.');
  });
});