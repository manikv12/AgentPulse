export type CodexTranscriptionAuthContext = {
  authMode: 'chatgpt' | 'openai';
  token: string;
};

export class CodexTranscriptionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexTranscriptionAuthError';
  }
}

export function parseCodexTranscriptionAuthContext(
  raw: unknown
): CodexTranscriptionAuthContext {
  const dictionaries = transcriptionAuthCandidateDictionaries(raw);
  if (dictionaries.length === 0) {
    throw new CodexTranscriptionAuthError('Codex returned an empty transcription auth response.');
  }

  const errorMessage = dictionaries
    .map((dictionary) =>
      firstNonEmptyString(
        stringField(dictionary, 'error'),
        stringField(dictionary, 'message'),
        stringField(recordField(dictionary, 'detail') ?? {}, 'message'),
        stringField(recordField(dictionary, 'details') ?? {}, 'message')
      )
    )
    .find(Boolean);
  if (errorMessage) {
    throw new CodexTranscriptionAuthError(errorMessage);
  }

  const authMode = resolvedTranscriptionAuthMode(dictionaries);
  const token = transcriptionTokenForMode(dictionaries, authMode);
  if (!token) {
    throw new CodexTranscriptionAuthError('Codex did not return a reusable transcription token.');
  }

  return {
    authMode,
    token
  };
}

function transcriptionAuthCandidateDictionaries(raw: unknown): Record<string, unknown>[] {
  const root = recordFromUnknown(raw);
  if (!root) {
    return [];
  }

  const dictionaries: Record<string, unknown>[] = [root];
  const nestedKeys = ['result', 'status', 'auth', 'data', 'credentials', 'tokens', 'account'];
  for (let index = 0; index < dictionaries.length; index += 1) {
    const dictionary = dictionaries[index]!;
    for (const key of nestedKeys) {
      const nested = recordField(dictionary, key);
      if (nested && !dictionaries.includes(nested)) {
        dictionaries.push(nested);
      }
    }
  }
  return dictionaries;
}

function resolvedTranscriptionAuthMode(
  dictionaries: Record<string, unknown>[]
): CodexTranscriptionAuthContext['authMode'] {
  if (dictionaries.some((dictionary) => dictionary.requiresOpenaiAuth === true)) {
    return 'openai';
  }
  for (const dictionary of dictionaries) {
    const explicit = firstNonEmptyString(
      stringField(dictionary, 'authMode'),
      stringField(dictionary, 'authMethod'),
      stringField(dictionary, 'method'),
      stringField(dictionary, 'type'),
      stringField(dictionary, 'provider')
    );
    const normalized = explicit?.toLowerCase() ?? '';
    if (normalized.includes('chatgpt') || normalized.includes('chat_gpt') || normalized.includes('session')) {
      return 'chatgpt';
    }
    if (normalized.includes('openai') || normalized.includes('api')) {
      return 'openai';
    }
  }
  const token = transcriptionTokenForMode(dictionaries, undefined);
  return token.trim().startsWith('sk-') ? 'openai' : 'chatgpt';
}

function transcriptionTokenForMode(
  dictionaries: Record<string, unknown>[],
  authMode: CodexTranscriptionAuthContext['authMode'] | undefined
): string {
  const fields =
    authMode === 'chatgpt'
      ? ['authToken', 'token', 'accessToken', 'access_token']
      : authMode === 'openai'
        ? ['apiKey', 'api_key', 'token', 'accessToken', 'access_token', 'authToken']
        : ['authToken', 'token', 'accessToken', 'access_token', 'apiKey', 'api_key'];
  for (const dictionary of dictionaries) {
    for (const field of fields) {
      const value = stringField(dictionary, field);
      if (value) {
        return value;
      }
    }
  }
  return '';
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordField(
  record: Record<string, unknown>,
  field: string
): Record<string, unknown> | undefined {
  return recordFromUnknown(record[field]);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
