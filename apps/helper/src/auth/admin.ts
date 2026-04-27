import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SCRYPT_KEY_LEN = 32;
const MIN_ADMIN_PASSCODE_LENGTH = 12;
const PASSCODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PASSCODE_LENGTH = 12;

type StoredAdminCredential = {
  salt: string;
  passcodeHash: string;
};

export type AdminAuthOptions = {
  credentialsPath?: string;
  tokenTtlMs?: number;
  now?: () => Date;
  onPasscodeGenerated?: (plaintext: string) => void;
};

export class AdminAuth {
  private credentials?: StoredAdminCredential;
  private readonly tokens = new Map<string, number>();
  private readonly credentialsPath: string;
  private readonly tokenTtlMs: number;
  private readonly now: () => Date;
  private readonly onPasscodeGenerated?: (plaintext: string) => void;

  constructor(options: AdminAuthOptions = {}) {
    this.credentialsPath =
      options.credentialsPath ??
      path.join(homedir(), 'Library', 'Application Support', 'Agent Pulse', 'admin.json');
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.onPasscodeGenerated = options.onPasscodeGenerated;
  }

  async ensureInitialized(): Promise<void> {
    if (this.credentials) {
      return;
    }

    try {
      const raw = await readFile(this.credentialsPath, 'utf8');
      this.credentials = JSON.parse(raw) as StoredAdminCredential;
      return;
    } catch {
      // fall through to generation
    }

    const passcode = generatePasscode();
    const salt = randomBytes(16).toString('hex');
    const passcodeHash = hashPasscode(passcode, salt);
    this.credentials = { salt, passcodeHash };
    await mkdir(path.dirname(this.credentialsPath), { recursive: true });
    await writeFile(
      this.credentialsPath,
      `${JSON.stringify(this.credentials, null, 2)}\n`,
      'utf8'
    );
    this.onPasscodeGenerated?.(passcode);
  }

  async verifyPasscode(passcode: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.credentials) {
      return false;
    }
    const candidate = hashPasscode(passcode, this.credentials.salt);
    const expected = Buffer.from(this.credentials.passcodeHash, 'hex');
    const actual = Buffer.from(candidate, 'hex');
    if (expected.length !== actual.length) {
      return false;
    }
    return timingSafeEqual(expected, actual);
  }

  issueToken(): { token: string; expiresAt: string } {
    const token = `ap-admin-${randomBytes(24).toString('base64url')}`;
    const expiresAtMs = this.now().getTime() + this.tokenTtlMs;
    this.tokens.set(token, expiresAtMs);
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  verifyToken(token: string | undefined): boolean {
    if (!token) {
      return false;
    }
    const expiresAtMs = this.tokens.get(token);
    if (!expiresAtMs) {
      return false;
    }
    if (expiresAtMs <= this.now().getTime()) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  async changePasscode(currentPasscode: string, nextPasscode: string, keepToken?: string): Promise<void> {
    if (!(await this.verifyPasscode(currentPasscode))) {
      throw new Error('Current passcode is incorrect.');
    }
    const trimmed = nextPasscode.trim();
    if (trimmed.length < MIN_ADMIN_PASSCODE_LENGTH) {
      throw new Error(`New passcode must be at least ${MIN_ADMIN_PASSCODE_LENGTH} characters.`);
    }

    const salt = randomBytes(16).toString('hex');
    const passcodeHash = hashPasscode(trimmed, salt);
    this.credentials = { salt, passcodeHash };
    await mkdir(path.dirname(this.credentialsPath), { recursive: true });
    await writeFile(
      this.credentialsPath,
      `${JSON.stringify(this.credentials, null, 2)}\n`,
      'utf8'
    );

    for (const existing of [...this.tokens.keys()]) {
      if (existing !== keepToken) {
        this.tokens.delete(existing);
      }
    }
  }
}

function generatePasscode(): string {
  const bytes = randomBytes(PASSCODE_LENGTH);
  let result = '';
  for (let i = 0; i < PASSCODE_LENGTH; i += 1) {
    result += PASSCODE_ALPHABET[bytes[i]! % PASSCODE_ALPHABET.length];
  }
  return result;
}

function hashPasscode(passcode: string, salt: string): string {
  return scryptSync(passcode, salt, SCRYPT_KEY_LEN).toString('hex');
}
